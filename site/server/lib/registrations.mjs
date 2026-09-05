// ЗАЯВКИ НА РЕГИСТРАЦИЮ: подача, поиск возможных совпадений, решение модератора.
//
// Публичная форма НИКОГДА не пишет в players напрямую — только сюда. Игрок
// появляется решением модератора, потому что попадание в players означает
// публикацию ФИО в открытом рейтинге.
import { randomBytes } from 'node:crypto';
import {
  recordRegistrationConsents,
  syncPlayerPublicFlag,
  withConsentErasure,
  GUARDIAN_KIND,
} from './consent-journal.mjs';
import { attachGuardian, guardianSubjectRef } from './guardians.mjs';
import { isMinor } from './validate.mjs';

// Правовое основание обработки данных ребёнка. Пишется в САМУ запись согласия:
// через год «кто это разрешил» должно читаться из журнала, а не выводиться из
// того, что у игрока когда-то был представитель.
export const REPRESENTATIVE_BASIS = 'согласие законного представителя (ч. 1 ст. 9 152-ФЗ)';

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
 *
 * С 05.09.2026 (решение владельца): тёзка с ДРУГОЙ датой рождения — не
 * совпадение, подсказка не показывается. Совпадением остаётся тёзка с той
 * же датой либо без даты у одной из сторон.
 */
export function findNameMatches(db, fullName, birthDate = null) {
  const target = normalizeName(fullName);
  if (!target) return [];
  return db
    .prepare('SELECT id, full_name, city, sex, age_group, birth_date FROM players WHERE anonymized_at IS NULL')
    .all()
    .filter((p) => normalizeName(p.full_name) === target)
    .filter((p) => !birthDate || !p.birth_date || p.birth_date === birthDate);
}

/**
 * ДУБЛИ ИГРОКОВ — правила владельца 05.09.2026, стоп до секретаря:
 *  · e-mail взрослого заявителя уже у кабинета игрока или у ждущей заявки —
 *    дубль (адрес представителя не считается: родитель сам может играть, а
 *    у двух детей один родитель);
 *  · ФИО + дата рождения совпали с игроком или ждущей заявкой — дубль;
 *  · полный тёзка с другой датой — НЕ дубль, регистрируется без предупреждений.
 * Возвращает текст причины либо null. Чужих данных в тексте нет.
 */
export function findDuplicate(db, { full_name, birth_date = null, email = null, guardian = null, exceptRegistrationId = null }) {
  const support = 'Если у вас есть вопросы — напишите обращение в поддержку через страницу «Контакты».';
  if (email && !guardian) {
    const e = String(email).trim().toLowerCase();
    const acc = db.prepare('SELECT 1 AS ok FROM player_accounts WHERE lower(email) = ?').get(e);
    const pend = db.prepare(
      "SELECT 1 AS ok FROM registrations WHERE status = 'pending' AND guardian_email IS NULL AND lower(email) = ? AND id IS NOT ?",
    ).get(e, exceptRegistrationId);
    if (acc || pend) return `Такой адрес электронной почты уже зарегистрирован. ${support}`;
  }
  if (full_name && birth_date) {
    const target = normalizeName(full_name);
    const samePlayer = db
      .prepare('SELECT id, full_name FROM players WHERE birth_date = ? AND anonymized_at IS NULL')
      .all(birth_date)
      .find((p) => normalizeName(p.full_name) === target);
    const sameReg = db
      .prepare("SELECT id, full_name FROM registrations WHERE status = 'pending' AND birth_date = ? AND id IS NOT ?")
      .all(birth_date, exceptRegistrationId)
      .find((r) => normalizeName(r.full_name) === target);
    if (samePlayer || sameReg) return `Участник с такими ФИО и датой рождения уже зарегистрирован. ${support}`;
  }
  return null;
}

export function createRegistration(db, {
  full_name, city, sex, age_group, email, birth_date, guardian = null, ip,
}) {
  const token = randomBytes(24).toString('base64url');
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO registrations
           (full_name, city, sex, age_group, email, birth_date, status_token, ip,
            guardian_full_name, guardian_relation, guardian_email)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full_name, city, sex, age_group, email, birth_date, token, ip || null,
        guardian ? guardian.full_name : null,
        guardian ? guardian.relation : null,
        guardian ? guardian.email : null,
      );
    const id = Number(info.lastInsertRowid);
    // Согласия пишутся В ТОТ ЖЕ МОМЕНТ и той же транзакцией: заявка без
    // зафиксированного согласия — это обработка ПДн без основания.
    //
    // Для несовершеннолетнего записей ДВЕ, и это не формальность:
    //  · обработка данных РЕБЁНКА — субъект ребёнок, основание названо в basis;
    //  · обработка данных ПРЕДСТАВИТЕЛЯ — субъект ОН САМ, отдельной отметкой.
    // Согласия на распространение здесь нет: результаты публикуются по факту
    // участия (п. 5 ч. 1 ст. 6), а фото — отдельным действием в кабинете.
    // ФИО и почта представителя в записи ребёнка НЕ дублируются: у данных
    // представителя свой срок хранения, и размазав их по чужим записям, удалить
    // их в срок было бы невозможно (журнал неизменяем).
    recordRegistrationConsents(db, {
      registrationId: id,
      // СУБЪЕКТ записи — сам участник. У минора почта в заявке принадлежит
      // ПРЕДСТАВИТЕЛЮ, и вписать её сюда значило бы размазать его данные по
      // чужим записям: журнал неизменяем, и удалить их в свой срок стало бы
      // невозможно. Представитель опознаётся своей записью и basis.
      subjectRef: guardian ? `${full_name} (несовершеннолетний участник)` : `${full_name} <${email}>`,
      source: 'web',
      ip,
      basis: guardian ? REPRESENTATIVE_BASIS : null,
      guardianSubjectRef: guardian ? guardianSubjectRef(guardian) : null,
    });
    return { id, token };
  });
  return tx();
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
    // «Новым игроком» при живом двойнике (ФИО + дата) заводить нельзя — только привязка.
    if (id === null) {
      const twin = findNameMatches(db, reg.full_name, reg.birth_date).find((p) => p.birth_date && p.birth_date === reg.birth_date);
      if (twin) throw new Error(`Игрок с такими ФИО и датой рождения уже есть (#${twin.id}) — одобрите с привязкой к нему`);
    }
    if (id === null) {
      id = Number(
        db
          .prepare('INSERT INTO players (full_name, city, sex, age_group, birth_date) VALUES (?, ?, ?, ?, ?)')
          .run(reg.full_name, reg.city, reg.sex, reg.age_group, reg.birth_date).lastInsertRowid,
      );
    } else if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(id)) {
      throw new Error('Игрок для привязки не найден');
    } else {
      // ПРИВЯЗКА К СУЩЕСТВУЮЩЕМУ. Дату рождения переносим ЯВНО и только в
      // пустое поле: без переноса фоновая проверка совершеннолетия молча
      // пропустит игрока (ей не по чему считать возраст), а затирать уже
      // выверенную секретарём дату данными из формы нельзя.
      db.prepare('UPDATE players SET birth_date = COALESCE(birth_date, ?) WHERE id = ?')
        .run(reg.birth_date, id);
    }

    // Доливка player_id к согласиям, данным в момент подачи. Единственная
    // правка, которую журнал допускает (NULL -> значение, см. триггеры схемы);
    // записи ПРЕДСТАВИТЕЛЯ она не касается — у неё другой субъект.
    db.prepare(
      `UPDATE consents SET player_id = ? WHERE registration_id = ? AND player_id IS NULL AND kind <> ?`,
    ).run(id, registrationId, GUARDIAN_KIND);
    syncPlayerPublicFlag(db, id);

    // ПРЕДСТАВИТЕЛЬ переезжает с заявки на игрока ТОЙ ЖЕ транзакцией: аккаунт
    // несовершеннолетнего без действующего представителя — обработка данных
    // ребёнка без основания.
    let guardian = null;
    let guardianCreated = false;
    if (reg.guardian_email && reg.birth_date && isMinor(reg.birth_date)) {
      const attached = attachGuardian(db, id, {
        full_name: reg.guardian_full_name,
        relation: reg.guardian_relation,
        email: reg.guardian_email,
      });
      guardian = attached.guardian;
      guardianCreated = attached.created;
      db.prepare(
        'UPDATE consents SET guardian_id = ? WHERE registration_id = ? AND kind = ? AND guardian_id IS NULL',
      ).run(guardian.id, registrationId, GUARDIAN_KIND);
    }

    db.prepare(
      "UPDATE registrations SET status = 'approved', player_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(id, userId, registrationId);
    return {
      registration: byId(db, registrationId),
      playerId: id,
      created: playerId === null,
      guardian,
      guardianCreated,
    };
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
  // Каскад унесёт и согласия, данные при подаче, а журнал согласий закрыт на
  // удаление триггером СУБД. Срок хранения — законное основание удалить, и
  // проходит оно через те же ворота, что и право на забвение.
  return withConsentErasure(db, () =>
    db
      .prepare(
        `DELETE FROM registrations
          WHERE status IN ('rejected','pending')
            AND COALESCE(decided_at, created_at) <= datetime('now', ?)`,
      )
      .run(cutoff).changes);
}
