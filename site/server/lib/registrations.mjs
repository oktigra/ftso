// ЗАЯВКИ НА РЕГИСТРАЦИЮ: подача, поиск возможных совпадений, решение модератора.
//
// Публичная форма НИКОГДА не пишет в players напрямую — только сюда. Игрок
// появляется решением модератора, потому что попадание в players означает
// публикацию ФИО в открытом рейтинге.
import { randomBytes } from 'node:crypto';
import { recordRegistrationConsents, syncPlayerPublicFlag } from './consent-journal.mjs';

/**
 * Нормализация ФИО для поиска ДУБЛИКАТОВ. Не для хранения — в БД имя лежит
 * как его написал человек. «Ёлкин» и «Елкин», двойные пробелы и разный регистр
 * должны считаться одним человеком, иначе секретарь заведёт второго.
 */
export function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ВОЗМОЖНЫЕ СОВПАДЕНИЯ, а не автослияние: одинаковое ФИО — это подсказка
 * модератору, а не факт. Полных тёзок в областном теннисе достаточно, и
 * склеивать двух людей в одного нельзя — это исказит рейтинг обоим.
 */
export function findNameMatches(db, fullName) {
  const target = normalizeName(fullName);
  if (!target) return [];
  return db
    .prepare('SELECT id, full_name, city, sex, age_group, is_public FROM players')
    .all()
    .filter((p) => normalizeName(p.full_name) === target);
}

export function createRegistration(db, { full_name, city, sex, age_group, email, distribution, ip }) {
  const token = randomBytes(24).toString('base64url');
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO registrations (full_name, city, sex, age_group, email, status_token, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(full_name, city, sex, age_group, email, token, ip || null);
    const id = Number(info.lastInsertRowid);
    // Согласия пишутся В ТОТ ЖЕ МОМЕНТ и той же транзакцией: заявка без
    // зафиксированного согласия — это обработка ПДн без основания.
    recordRegistrationConsents(db, {
      registrationId: id,
      subjectRef: `${full_name} <${email}>`,
      distribution,
      source: 'web',
      ip,
    });
    return { id, token };
  });
  return tx();
}

/** Дал ли заявитель ОТДЕЛЬНОЕ согласие на публикацию (ст. 10.1). */
export function registrationAllowsPublication(db, registrationId) {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM consents WHERE registration_id = ? AND kind = 'distribution' AND event = 'granted' LIMIT 1",
    )
    .get(registrationId);
  return Boolean(row);
}

export function byToken(db, token) {
  return db.prepare('SELECT * FROM registrations WHERE status_token = ?').get(String(token || ''));
}

export function byId(db, id) {
  return db.prepare('SELECT * FROM registrations WHERE id = ?').get(id);
}

export function pendingRegistrations(db) {
  return db.prepare("SELECT * FROM registrations WHERE status = 'pending' ORDER BY id").all();
}

export function decidedRegistrations(db, limit = 20) {
  return db
    .prepare("SELECT * FROM registrations WHERE status <> 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?")
    .all(limit);
}

/**
 * ОДОБРЕНИЕ. Два пути:
 *  - playerId не задан -> заводим нового игрока;
 *  - playerId задан    -> привязываем заявку к УЖЕ существующему (секретарь
 *    ввёл человека раньше). Второй записи о том же человеке не появляется.
 *
 * Согласия заявки доливаются player_id и только после этого решают судьбу
 * флага публикуемости: до одобрения публиковать некого.
 */
export function approveRegistration(db, registrationId, { playerId = null, userId = null } = {}) {
  const tx = db.transaction(() => {
    const reg = byId(db, registrationId);
    if (!reg) throw new Error('Заявка не найдена');
    if (reg.status !== 'pending') throw new Error('Заявка уже рассмотрена');

    let id = playerId;
    if (id === null) {
      id = Number(
        db
          .prepare('INSERT INTO players (full_name, city, sex, age_group) VALUES (?, ?, ?, ?)')
          .run(reg.full_name, reg.city, reg.sex, reg.age_group).lastInsertRowid,
      );
    } else if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(id)) {
      throw new Error('Игрок для привязки не найден');
    }

    db.prepare('UPDATE consents SET player_id = ? WHERE registration_id = ?').run(id, registrationId);
    syncPlayerPublicFlag(db, id);
    db.prepare(
      "UPDATE registrations SET status = 'approved', player_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(id, userId, registrationId);
    return { registration: byId(db, registrationId), playerId: id, created: playerId === null };
  });
  return tx();
}

/**
 * ОТКЛОНЕНИЕ. Данные заявки остаются до истечения срока хранения: отказ тоже
 * нужно уметь объяснить, если человек с ним не согласен. Согласия при этом
 * теряют смысл — обработка прекращается, и записи гасятся отзывом.
 */
export function rejectRegistration(db, registrationId, { reason = null, userId = null } = {}) {
  const tx = db.transaction(() => {
    const reg = byId(db, registrationId);
    if (!reg) throw new Error('Заявка не найдена');
    if (reg.status !== 'pending') throw new Error('Заявка уже рассмотрена');
    db.prepare(
      "UPDATE registrations SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(reason, userId, registrationId);
    return byId(db, registrationId);
  });
  return tx();
}

/**
 * RETENTION заявок. Одобренная заявка живёт вместе с игроком (каскад по
 * player_id) — она объясняет, на каком основании человек в рейтинге.
 * Отклонённые и брошенные на модерации чистятся: держать ФИО и почту того,
 * кого не приняли, дольше нужного — избыточная обработка.
 */
export function purgeRegistrations(db, retentionDays) {
  const cutoff = `-${Number(retentionDays)} days`;
  return db
    .prepare(
      `DELETE FROM registrations
        WHERE status IN ('rejected','pending')
          AND COALESCE(decided_at, created_at) <= datetime('now', ?)`,
    )
    .run(cutoff).changes;
}
