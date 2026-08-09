// ЗАКОННЫЕ ПРЕДСТАВИТЕЛИ НЕСОВЕРШЕННОЛЕТНИХ УЧАСТНИКОВ.
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ, от которого зависит всё остальное: кабинет один и тот
// же у всех. Ребёнок ВЛАДЕЕТ кабинетом, представитель — ГЕЙТ поверх него:
// отдельная входная сущность со своим логином, а не второй профиль ребёнка и не
// владелец. В 18 гейт снимается, аккаунт «взрослеет» — передачи владения не
// происходит, потому что владелец не менялся. Отдельного «родительского
// кабинета» с копией профиля нет намеренно: он породил бы два профиля на одного
// человека и вопрос «чей же это профиль» в каждой следующей задаче.
//
// ОДНА ЗАПИСЬ НА РЕАЛЬНОГО ЧЕЛОВЕКА. У матери двоих юниоров один логин, дети —
// в списке подопечных: она входит своей почтой и выбирает, чей кабинет открыть.
// Привязка «представитель — ребёнок» живёт в guardian_wards, потому что степень
// родства принадлежит паре, а не человеку.
//
// Представитель — САМОСТОЯТЕЛЬНЫЙ СУБЪЕКТ персональных данных: его ФИО, родство
// и e-mail обрабатываются на основании ЕГО СОБСТВЕННОГО согласия (отдельная
// отметка в форме), и у него есть свои права по ст. 14 и 21 152-ФЗ.
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.mjs';
import { GUARDIAN_KIND, recordConsent, revokeCovered, withConsentErasure } from './consent-journal.mjs';
import { adoptPassword } from './identity.mjs';

/** Как представитель записан в журнале согласий — он же субъект этих записей. */
export const guardianSubjectRef = (g) => `${g.full_name} <${g.email}> (законный представитель)`;

export function guardianById(db, id) {
  return db.prepare('SELECT * FROM guardians WHERE id = ?').get(id);
}

export function guardianByEmail(db, email) {
  return db.prepare('SELECT * FROM guardians WHERE email = ?').get(String(email || '').toLowerCase());
}

/** ДЕЙСТВУЮЩИЙ представитель ребёнка вместе со степенью родства. Он всегда один. */
export function activeGuardianFor(db, playerId) {
  return db
    .prepare(
      `SELECT g.*, w.relation, w.id AS ward_id
         FROM guardian_wards w JOIN guardians g ON g.id = w.guardian_id
        WHERE w.player_id = ? AND w.revoked_at IS NULL`,
    )
    .get(playerId);
}

/**
 * ПОДОПЕЧНЫЕ представителя — то, что он видит после входа. Обезличенные по
 * ст. 21 не показываются: их данных больше нет, показывать нечего.
 */
export function wardsOf(db, guardianId) {
  return db
    .prepare(
      `SELECT w.id AS ward_id, w.relation, p.id AS player_id, p.full_name, p.city, p.birth_date,
              a.consent_basis, a.frozen_at
         FROM guardian_wards w
         JOIN players p ON p.id = w.player_id
         LEFT JOIN player_accounts a ON a.player_id = p.id
        WHERE w.guardian_id = ? AND w.revoked_at IS NULL AND p.anonymized_at IS NULL
        ORDER BY p.full_name`,
    )
    .all(guardianId);
}

/** История представителей ребёнка — для карточки в админке (новые сверху). */
export function guardianHistoryFor(db, playerId) {
  return db
    .prepare(
      `SELECT w.id AS ward_id, w.relation, w.created_at, w.revoked_at,
              g.id, g.full_name, g.email
         FROM guardian_wards w JOIN guardians g ON g.id = w.guardian_id
        WHERE w.player_id = ? ORDER BY w.id DESC`,
    )
    .all(playerId);
}

/**
 * ПРИВЯЗКА представителя к ребёнку. Вызывается ВНУТРИ транзакции провижининга:
 * аккаунт несовершеннолетнего без действующего представителя — это обработка
 * данных ребёнка без основания, и половинчатого состояния между ними быть не
 * должно.
 *
 * Представитель ищется ПО ПОЧТЕ: второй ребёнок той же матери не заводит второй
 * логин, а добавляется к существующему. ФИО при этом не перезаписывается —
 * расхождение написания («Иванова А.П.» против «Иванова Анна Петровна») решает
 * человек в админке, а не автоподстановка.
 *
 * Второй ДЕЙСТВУЮЩИЙ представитель у ребёнка не появится: частичный уникальный
 * индекс guardian_wards(player_id) WHERE revoked_at IS NULL отобьёт вставку на
 * уровне СУБД.
 */
export function attachGuardian(db, playerId, { full_name, relation, email }) {
  const address = String(email).toLowerCase();
  let guardian = guardianByEmail(db, address);
  let created = false;
  if (guardian) {
    // Представитель вернулся со вторым ребёнком после снятия — снова действующий.
    if (guardian.revoked_at) {
      db.prepare('UPDATE guardians SET revoked_at = NULL WHERE id = ?').run(guardian.id);
      guardian = guardianById(db, guardian.id);
    }
  } else {
    const info = db
      .prepare('INSERT INTO guardians (full_name, email) VALUES (?, ?)')
      .run(full_name, address);
    guardian = guardianById(db, Number(info.lastInsertRowid));
    created = true;
  }
  db.prepare('INSERT INTO guardian_wards (guardian_id, player_id, relation) VALUES (?, ?, ?)')
    .run(guardian.id, playerId, relation);
  // РОДИТЕЛЬ, КОТОРЫЙ САМ ИГРАЕТ. Если под этим адресом уже есть кабинет
  // участника с паролем — второй пароль человеку не нужен: вход у него один.
  adoptPassword(db, address);
  return { guardian: guardianById(db, guardian.id), created };
}

/**
 * СНЯТИЕ ГЕЙТА с ребёнка: достижение 18 либо замена представителя (развод,
 * лишение прав, смерть, отзыв им согласия на свои данные). Связь гасится, а не
 * удаляется — она объясняет, на каком основании данные ребёнка обрабатывались.
 *
 * Сам представитель снимается ТОЛЬКО когда у него не осталось действующих
 * подопечных: пока он отвечает за второго ребёнка, его данные — по-прежнему
 * основание обработки, и удалять их нечем. В этот же момент гасится отзывом его
 * собственное согласие и начинается отсчёт срока хранения его данных.
 */
export function revokeWard(db, playerId, { source = 'web', ip = null } = {}) {
  const current = activeGuardianFor(db, playerId);
  if (!current) return null;
  db.prepare("UPDATE guardian_wards SET revoked_at = datetime('now') WHERE id = ?").run(current.ward_id);

  const stillActive = db
    .prepare('SELECT COUNT(*) AS n FROM guardian_wards WHERE guardian_id = ? AND revoked_at IS NULL')
    .get(current.id).n;
  if (stillActive === 0) {
    revokeCovered(db, {
      guardianId: current.id,
      kind: GUARDIAN_KIND,
      subjectRef: guardianSubjectRef(current),
      source,
      ip,
    });
    db.prepare("UPDATE guardians SET revoked_at = datetime('now') WHERE id = ?").run(current.id);
  }
  return { guardianId: current.id, guardianRevoked: stillActive === 0 };
}

/** Собственное согласие представителя на обработку ЕГО данных — отдельной записью. */
export function recordGuardianConsent(db, guardian, { source = 'web', ip = null, basis = null, documentDate = null } = {}) {
  return recordConsent(db, {
    guardianId: guardian.id,
    subjectRef: guardianSubjectRef(guardian),
    kind: GUARDIAN_KIND,
    event: 'granted',
    source,
    ip,
    basis,
    documentDate,
  });
}

// --- вход представителя ---------------------------------------------------
//
// Механика та же, что у игроков (см. lib/player-accounts.mjs): пароль хранится
// scrypt-хэшем, в БД лежит ХЭШ токена сброса, ссылка одноразовая и с истечением.
// Второго способа хранить пароли в проекте не появляется.

export function issueGuardianResetToken(db, guardianId, { hours = 24 } = {}) {
  const token = randomBytes(32).toString('base64url');
  const hashed = createHash('sha256').update(token).digest('hex');
  db.prepare(
    "UPDATE guardians SET reset_token = ?, reset_expires_at = datetime('now', ?) WHERE id = ?",
  ).run(hashed, `+${Number(hours)} hours`, guardianId);
  return token;
}

export function guardianByResetToken(db, token) {
  const hashed = createHash('sha256').update(String(token || '')).digest('hex');
  return db
    .prepare("SELECT * FROM guardians WHERE reset_token = ? AND reset_expires_at > datetime('now')")
    .get(hashed);
}

export function setGuardianPassword(db, guardianId, password) {
  db.prepare(
    `UPDATE guardians
        SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL,
            password_changed_at = datetime('now')
      WHERE id = ?`,
  ).run(hashPassword(password), guardianId);
}

/**
 * Проверка входа представителя. Снятый представитель (revoked_at) внутрь не
 * попадает: подопечных у него нет, а логин без единого подопечного — это дверь
 * в пустоту, которую незачем держать открытой.
 */
export function checkGuardianLogin(db, email, password) {
  const g = guardianByEmail(db, email);
  if (!g || !g.password_hash || g.revoked_at) return null;
  return verifyPassword(password, g.password_hash) ? g : null;
}

/**
 * СРОК ХРАНЕНИЯ ДАННЫХ ПРЕДСТАВИТЕЛЯ. В 18 они НЕ удаляются: это доказательство
 * того, что обработка данных ребёнка была правомерной, и уничтожить его в день
 * совершеннолетия значит остаться без основания за весь прошлый период.
 * Отсчёт идёт ОТ СНЯТИЯ (revoked_at) и по сроку GUARDIAN_RETENTION_DAYS —
 * подтверждено заказчиком: 3 года, общий срок исковой давности.
 *
 * Удаляется всё вместе: запись представителя, его связи с детьми и записи ЕГО
 * согласий. Согласия РЕБЁНКА не трогаются — их субъект другой, у них свой срок.
 */
export function purgeGuardians(db, retentionDays) {
  const cutoff = `-${Number(retentionDays)} days`;
  return withConsentErasure(db, () => {
    const stale = db
      .prepare("SELECT id FROM guardians WHERE revoked_at IS NOT NULL AND revoked_at <= datetime('now', ?)")
      .all(cutoff);
    const delConsents = db.prepare('DELETE FROM consents WHERE guardian_id = ?');
    const delGuardian = db.prepare('DELETE FROM guardians WHERE id = ?');
    let removed = 0;
    for (const row of stale) {
      delConsents.run(row.id);
      removed += delGuardian.run(row.id).changes;
    }
    return removed;
  });
}

/**
 * УДАЛЕНИЕ ДАННЫХ ПРЕДСТАВИТЕЛЯ ВМЕСТЕ С РЕБЁНКОМ (ст. 21). Связь уходит всегда.
 * Сам представитель — только если этот ребёнок был у него последним: пока он
 * отвечает за второго, его данные остаются основанием обработки ТОГО ребёнка,
 * и удалить их значило бы оставить второго без основания.
 */
export function eraseGuardianLinks(db, playerId) {
  return withConsentErasure(db, () => {
    const links = db.prepare('SELECT guardian_id FROM guardian_wards WHERE player_id = ?').all(playerId);
    db.prepare('DELETE FROM guardian_wards WHERE player_id = ?').run(playerId);
    const delConsents = db.prepare('DELETE FROM consents WHERE guardian_id = ?');
    const delGuardian = db.prepare('DELETE FROM guardians WHERE id = ?');
    let removed = 0;
    for (const { guardian_id: gid } of links) {
      const left = db.prepare('SELECT COUNT(*) AS n FROM guardian_wards WHERE guardian_id = ?').get(gid).n;
      if (left) continue;
      delConsents.run(gid);
      removed += delGuardian.run(gid).changes;
    }
    return removed;
  });
}
