// ЖУРНАЛ СОГЛАСИЙ (152-ФЗ).
//
// Три вещи, которые он держит вместе:
//  1) согласие на ОБРАБОТКУ (ст. 9) — запись при регистрации; у минора рядом
//     запись представителя о ЕГО данных — с ОДНОЙ редакцией текста;
//  2) согласие на РАСПРОСТРАНЕНИЕ (ст. 10.1) — МОДЕЛЬ РТТ с 05.09.2026: только
//     ФОТОГРАФИЯ публичного профиля. Загрузка фото в кабинете = granted,
//     удаление = revoked. Спортивные результаты публикуются по факту участия
//     (п. 5 ч. 1 ст. 6) и в журнал не пишутся. players.is_public остаётся
//     производным от последнего события kind='distribution' — как история и
//     зеркало «есть ли согласие на фото»; на витрину он НЕ влияет;
//  3) ОТЗЫВ как событие с датой, а не как удаление строки: удалив запись о
//     выдаче, невозможно доказать, что согласие когда-то действовало.
//
// Запись журнала сама является ПДн, поэтому у неё есть срок хранения и
// автоочистка (purgeExpired) — см. CONSENT_RETENTION_DAYS.
import { LEGAL_VERSION } from './legal.mjs';

// 'representative_processing' — согласие ЗАКОННОГО ПРЕДСТАВИТЕЛЯ на обработку
// ЕГО СОБСТВЕННЫХ данных (ФИО, родство, e-mail). Это согласие ДРУГОГО субъекта,
// не ребёнка: у представителя свои права на доступ и удаление, и слепить его
// согласие с согласием за ребёнка значило бы лишить его этих прав.
export const GUARDIAN_KIND = 'representative_processing';
export const CONSENT_KINDS = ['processing', 'distribution', GUARDIAN_KIND];
export const CONSENT_EVENTS = ['granted', 'revoked'];

/**
 * ВОРОТА УДАЛЕНИЯ. Журнал согласий неизменяем на уровне СУБД (триггеры в
 * schema.sql): UPDATE запрещён совсем, DELETE — пока ворота закрыты. Закон,
 * однако, требует удалять: право на забвение (ст. 21) и срок хранения самих
 * записей. Обе операции законны, обе идут ЧЕРЕЗ ЭТУ ФУНКЦИЮ и только через неё.
 *
 * Ворота открыты ровно на время транзакции: упало внутри — транзакция
 * откатилась, ворота закрыты вместе с ней. Один процесс и синхронный
 * better-sqlite3 (см. db/connect.mjs) гарантируют, что «на время транзакции»
 * не означает «на время, пока рядом кто-то ещё пишет».
 */
export function withConsentErasure(db, fn) {
  const open = db.prepare('UPDATE consents_gate SET erasure_open = 1 WHERE id = 1');
  const close = db.prepare('UPDATE consents_gate SET erasure_open = 0 WHERE id = 1');
  return db.transaction(() => {
    open.run();
    try {
      return fn();
    } finally {
      close.run();
    }
  })();
}

/**
 * Событие журнала. Редакцию НЕ принимаем параметром: она всегда текущая из
 * legal.mjs, иначе в журнал можно записать согласие на текст, которого не было.
 *
 * ЕДИНСТВЕННОЕ исключение — coveredVersion при ОТЗЫВЕ: отзыв гасит конкретное
 * ранее данное согласие и обязан назвать ту редакцию, которую оно покрывало.
 * Записать отзыв текущей редакцией значило бы утверждать, что человек принимал
 * текст, которого в момент выдачи не существовало. Для 'granted' параметр
 * игнорируется — придумать себе редакцию выдача не может.
 */
export function recordConsent(db, {
  playerId = null,
  registrationId = null,
  guardianId = null,
  subjectRef = null,
  kind,
  event,
  source = 'web',
  ip = null,
  basis = null,
  documentDate = null,
  coveredVersion = null,
}) {
  if (!CONSENT_KINDS.includes(kind)) throw new Error(`неизвестный вид согласия: ${kind}`);
  if (!CONSENT_EVENTS.includes(event)) throw new Error(`неизвестное событие согласия: ${event}`);
  const version = event === 'revoked' && coveredVersion ? coveredVersion : LEGAL_VERSION;
  // Для бумажного согласия IP бессмысленен — не пишем мусор в ПДн-запись.
  const storedIp = source === 'offline' ? null : ip;
  const info = db
    .prepare(
      `INSERT INTO consents (player_id, registration_id, guardian_id, subject_ref, kind, event, legal_version, source, ip, basis, document_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(playerId, registrationId, guardianId, subjectRef, kind, event, version, source, storedIp, basis, documentDate);
  return Number(info.lastInsertRowid);
}

/** Последняя ДЕЙСТВУЮЩАЯ (granted) запись по субъекту и виду — вместе с её редакцией. */
export function lastGranted(db, { playerId = null, guardianId = null, kind }) {
  const sql = guardianId
    ? 'SELECT * FROM consents WHERE guardian_id = ? AND kind = ? ORDER BY id DESC LIMIT 1'
    : 'SELECT * FROM consents WHERE player_id = ? AND kind = ? ORDER BY id DESC LIMIT 1';
  const row = db.prepare(sql).get(guardianId || playerId, kind);
  return row && row.event === 'granted' ? row : null;
}

/**
 * ОТЗЫВ ранее данного согласия НОВОЙ строкой, несущей редакцию отзываемого
 * текста. Если действующего согласия нет — отзывать нечего, и пустая запись
 * «отозвано то, чего не было» в журнал не попадает.
 */
export function revokeCovered(db, {
  playerId = null, guardianId = null, kind, subjectRef = null, source = 'web', ip = null, basis = null,
}) {
  const granted = lastGranted(db, { playerId, guardianId, kind });
  if (!granted) return null;
  return recordConsent(db, {
    playerId,
    guardianId,
    subjectRef: subjectRef || granted.subject_ref,
    kind,
    event: 'revoked',
    source,
    ip,
    // У отзыва ПО ВОЛЕ СУБЪЕКТА основания нет — есть воля. Но согласие может
    // прекратиться и само: представительское перестаёт действовать в день
    // совершеннолетия. Такой отзыв обязан назвать причину, иначе через год
    // запись читается как «человек передумал», а он ничего не делал.
    basis,
    coveredVersion: granted.legal_version,
  });
}

/**
 * Согласия формы регистрации — ОДНИМ вызовом, одной транзакцией, с общей
 * редакцией: обработка данных участника и (у минора) обработка данных
 * представителя. Согласие на распространение здесь НЕ пишется: оно только
 * про фото и даётся в кабинете (setDistributionConsent).
 */
export function recordRegistrationConsents(db, {
  playerId = null,
  registrationId = null,
  subjectRef = null,
  source = 'web',
  ip = null,
  basis = null,
  documentDate = null,
  // Согласие представителя на ЕГО СОБСТВЕННЫЕ данные — ТРЕТЬЯ, отдельная запись
  // с ДРУГИМ субъектом. Пишется той же транзакцией: обработка данных ребёнка и
  // хранение данных представителя начинаются одновременно, и основание у
  // каждой должно быть зафиксировано в тот же момент.
  guardianSubjectRef = null,
}) {
  const base = { playerId, registrationId, subjectRef, source, ip, basis, documentDate };
  const tx = db.transaction(() => {
    const ids = {
      processing: recordConsent(db, { ...base, kind: 'processing', event: 'granted' }),
      guardian: null,
    };
    if (guardianSubjectRef) {
      ids.guardian = recordConsent(db, {
        ...base,
        // player_id НЕ проставляется: субъект этой записи — представитель, а не
        // ребёнок. Привязка к записи представителя доливается при одобрении
        // заявки, когда guardians уже заведён.
        playerId: null,
        subjectRef: guardianSubjectRef,
        kind: GUARDIAN_KIND,
        event: 'granted',
      });
    }
    if (playerId !== null) syncPlayerPublicFlag(db, playerId);
    return ids;
  });
  return tx();
}

/** Последнее событие по виду согласия: 'granted' | 'revoked' | null (не давалось). */
export function latestEvent(db, playerId, kind) {
  const row = db
    .prepare('SELECT event FROM consents WHERE player_id = ? AND kind = ? ORDER BY id DESC LIMIT 1')
    .get(playerId, kind);
  return row ? row.event : null;
}

/** Состояние обоих согласий игрока — для карточки в админке и для проверок. */
export function consentState(db, playerId) {
  return {
    processing: latestEvent(db, playerId, 'processing'),
    distribution: latestEvent(db, playerId, 'distribution'),
  };
}

/**
 * Приводит players.is_public в соответствие журналу. ЕДИНСТВЕННОЕ место, где
 * этот флаг пишется. С 05.09.2026 флаг — история и зеркало согласия на ФОТО,
 * витрина по нему ничего не скрывает.
 */
export function syncPlayerPublicFlag(db, playerId) {
  const isPublic = latestEvent(db, playerId, 'distribution') === 'granted' ? 1 : 0;
  db.prepare('UPDATE players SET is_public = ? WHERE id = ?').run(isPublic, playerId);
  return isPublic;
}

/**
 * Выдача или отзыв согласия на распространение ФОТОГРАФИИ + синхронизация
 * флага одной транзакцией. Зовётся из кабинета (загрузка/удаление фото) и из
 * админки (удаление фото секретарём). Отзыв (ч. 12-13 ст. 10.1) обязан снять
 * публикацию немедленно: фото убирается тем же действием, что и запись.
 */
export function setDistributionConsent(db, playerId, granted, { source = 'web', ip = null, basis = null, documentDate = null } = {}) {
  const tx = db.transaction(() => {
    recordConsent(db, {
      playerId,
      kind: 'distribution',
      event: granted ? 'granted' : 'revoked',
      source,
      ip,
      // Основание нужно ВЫДАЧЕ. У отзыва основания нет — есть воля субъекта.
      basis: granted ? basis : null,
      documentDate: granted ? documentDate : null,
    });
    return syncPlayerPublicFlag(db, playerId);
  });
  return tx();
}

/** История согласий игрока — для карточки в админке (новые сверху). */
export function consentHistory(db, playerId, limit = 50) {
  return db
    .prepare(
      `SELECT id, kind, event, legal_version, source, ip, basis, document_date, at
         FROM consents WHERE player_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(playerId, limit);
}

/**
 * ПРАВО НА ЗАБВЕНИЕ (ст. 21): записи согласий физически удаляются вместе с
 * данными субъекта. Вызывается явно, потому что удаление игрока в личном
 * кабинете — это ОБЕЗЛИЧИВАНИЕ строки, а не DELETE, и каскад там не сработает.
 */
export function eraseConsents(db, playerId) {
  return withConsentErasure(db, () =>
    db.prepare('DELETE FROM consents WHERE player_id = ?').run(playerId).changes);
}

/**
 * АВТООЧИСТКА. Чистится только то, что перестало быть нужным:
 *  - пары «выдано + отозвано», где ОТЗЫВ старше срока хранения: доказывать
 *    больше нечего, а запись остаётся персональными данными;
 *  - записи без привязки к игроку (заявка не дошла до модерации) старше срока.
 * ДЕЙСТВУЮЩИЕ согласия не трогаются никогда — они и есть основание обработки.
 */
export function purgeExpired(db, retentionDays) {
  const cutoff = `-${Number(retentionDays)} days`;
  return withConsentErasure(db, () => {
    // Виды согласий, где последнее событие — отзыв, и он старше срока.
    const stale = db
      .prepare(
        `SELECT player_id, kind FROM consents c1
          WHERE player_id IS NOT NULL
            AND id = (SELECT MAX(id) FROM consents c2
                       WHERE c2.player_id = c1.player_id AND c2.kind = c1.kind)
            AND event = 'revoked'
            AND at <= datetime('now', ?)`,
      )
      .all(cutoff);
    const delByPair = db.prepare('DELETE FROM consents WHERE player_id = ? AND kind = ?');
    let removed = 0;
    for (const row of stale) removed += delByPair.run(row.player_id, row.kind).changes;
    // Записи, не привязанные ни к кому: заявка не дошла до модерации.
    // Согласия ПРЕДСТАВИТЕЛЯ (guardian_id) сюда не попадают, хотя player_id у
    // них тоже пуст: у них свой срок и свой отсчёт — от снятия представителя,
    // а не от даты записи (см. purgeGuardians в lib/guardians.mjs).
    removed += db
      .prepare(
        "DELETE FROM consents WHERE player_id IS NULL AND guardian_id IS NULL AND at <= datetime('now', ?)",
      )
      .run(cutoff).changes;
    return removed;
  });
}

// Планировщик автоочистки — общий для всех сроков хранения, см. lib/retention.mjs.
