// ЖУРНАЛ СОГЛАСИЙ (152-ФЗ).
//
// Три вещи, которые он держит вместе:
//  1) ДВЕ РАЗДЕЛЬНЫЕ записи на одну регистрацию — согласие на обработку (ст. 9)
//     и согласие на распространение (ст. 10.1) — с ОДНОЙ редакцией текста;
//  2) ФЛАГ ПУБЛИКУЕМОСТИ players.is_public, производный от журнала: он не
//     «выставился и застыл», а всегда равен состоянию последнего события
//     kind='distribution';
//  3) ОТЗЫВ как событие с датой, а не как удаление строки: удалив запись о
//     выдаче, невозможно доказать, что согласие когда-то действовало.
//
// Запись журнала сама является ПДн, поэтому у неё есть срок хранения и
// автоочистка (purgeExpired) — см. CONSENT_RETENTION_DAYS.
import { LEGAL_VERSION } from './legal.mjs';

export const CONSENT_KINDS = ['processing', 'distribution'];
export const CONSENT_EVENTS = ['granted', 'revoked'];

/**
 * Событие журнала. Редакцию НЕ принимаем параметром: она всегда текущая из
 * legal.mjs, иначе в журнал можно записать согласие на текст, которого не было.
 */
export function recordConsent(db, { playerId = null, subjectRef = null, kind, event, source = 'web', ip = null }) {
  if (!CONSENT_KINDS.includes(kind)) throw new Error(`неизвестный вид согласия: ${kind}`);
  if (!CONSENT_EVENTS.includes(event)) throw new Error(`неизвестное событие согласия: ${event}`);
  // Для бумажного согласия IP бессмысленен — не пишем мусор в ПДн-запись.
  const storedIp = source === 'offline' ? null : ip;
  const info = db
    .prepare(
      `INSERT INTO consents (player_id, subject_ref, kind, event, legal_version, source, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(playerId, subjectRef, kind, event, LEGAL_VERSION, source, storedIp);
  return Number(info.lastInsertRowid);
}

/**
 * Обе отметки формы регистрации — ОДНИМ вызовом, но ДВУМЯ записями с общей
 * редакцией. Согласие на распространение необязательно: отказ от публикации
 * не мешает обработке и участию в соревнованиях.
 */
export function recordRegistrationConsents(db, { playerId = null, subjectRef = null, distribution, source = 'web', ip = null }) {
  const tx = db.transaction(() => {
    const ids = {
      processing: recordConsent(db, { playerId, subjectRef, kind: 'processing', event: 'granted', source, ip }),
      distribution: null,
    };
    if (distribution) {
      ids.distribution = recordConsent(db, { playerId, subjectRef, kind: 'distribution', event: 'granted', source, ip });
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
 * этот флаг пишется: любая другая запись рассинхронизирует витрину с согласием.
 */
export function syncPlayerPublicFlag(db, playerId) {
  const isPublic = latestEvent(db, playerId, 'distribution') === 'granted' ? 1 : 0;
  db.prepare('UPDATE players SET is_public = ? WHERE id = ?').run(isPublic, playerId);
  return isPublic;
}

/**
 * Выдача или отзыв согласия на распространение + синхронизация флага одной
 * транзакцией. Отзыв (ч. 12-13 ст. 10.1) обязан снять публикацию немедленно:
 * закон даёт на прекращение 3 рабочих дня, а здесь это происходит сразу.
 */
export function setDistributionConsent(db, playerId, granted, { source = 'web', ip = null } = {}) {
  const tx = db.transaction(() => {
    recordConsent(db, {
      playerId,
      kind: 'distribution',
      event: granted ? 'granted' : 'revoked',
      source,
      ip,
    });
    return syncPlayerPublicFlag(db, playerId);
  });
  return tx();
}

/** История согласий игрока — для карточки в админке (новые сверху). */
export function consentHistory(db, playerId, limit = 50) {
  return db
    .prepare(
      `SELECT id, kind, event, legal_version, source, ip, at
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
  return db.prepare('DELETE FROM consents WHERE player_id = ?').run(playerId).changes;
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
  const tx = db.transaction(() => {
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
    removed += db
      .prepare("DELETE FROM consents WHERE player_id IS NULL AND at <= datetime('now', ?)")
      .run(cutoff).changes;
    return removed;
  });
  return tx();
}

/**
 * Автоочистка при старте и раз в сутки. unref() — таймер не держит процесс
 * живым и не мешает тестам; чистка идёт в том же процессе, потому что
 * better-sqlite3 синхронный и второй писатель дал бы «database is locked».
 */
export function scheduleConsentPurge(db, retentionDays, { intervalMs = 24 * 60 * 60 * 1000 } = {}) {
  const run = () => {
    try {
      const removed = purgeExpired(db, retentionDays);
      if (removed) console.log(`[журнал согласий] автоочистка: удалено записей — ${removed}`);
    } catch (err) {
      console.error('[журнал согласий] автоочистка не удалась', err);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return timer;
}
