// ЗАЯВКИ «ПРОВЕСТИ ТУРНИР»: подача с документами, решение модератора.
//
// Как и регистрация игрока: публичная форма пишет ТОЛЬКО в свою таблицу.
// В tournaments турнир попадает решением человека — иначе любой прохожий
// добавил бы соревнование в календарь Федерации.
//
// РЕЗУЛЬТАТЫ для рейтинга здесь не принимаются НИ В КАКОМ виде: они вводятся
// структурно через готовый CRUD админки. Файл-сетка — это документ для людей,
// движок рейтинга из файлов не считает и считать не должен.
import { randomBytes } from 'node:crypto';
import { storeUpload, deleteUpload } from './uploads.mjs';
import { recordConsent } from './consent-journal.mjs';

export function byToken(db, token) {
  return db.prepare('SELECT * FROM tournament_requests WHERE status_token = ?').get(String(token || ''));
}

export function byId(db, id) {
  return db.prepare('SELECT * FROM tournament_requests WHERE id = ?').get(id);
}

export function pendingRequests(db) {
  return db.prepare("SELECT * FROM tournament_requests WHERE status = 'pending' ORDER BY id").all();
}

export function decidedRequests(db, limit = 20) {
  return db
    .prepare("SELECT * FROM tournament_requests WHERE status <> 'pending' ORDER BY decided_at DESC, id DESC LIMIT ?")
    .all(limit);
}

/** Файлы заявки — для карточки модератора и для отдачи по ссылке. */
export function requestFiles(db, requestId) {
  return db
    .prepare(
      `SELECT u.* FROM tournament_request_files f
         JOIN uploads u ON u.id = f.upload_id
        WHERE f.request_id = ? ORDER BY u.id`,
    )
    .all(requestId);
}

/**
 * Создание заявки. Файлы УЖЕ проверены слоем загрузки — здесь они только
 * записываются и привязываются. Всё одной транзакцией: заявка без документов,
 * которые организатор приложил, вводит модератора в заблуждение.
 *
 * Файлы кладутся на диск ДО транзакции (запись в ФС в транзакцию не входит),
 * поэтому при откате их нужно убрать — этим занимается вызывающий маршрут.
 */
export function createRequest(db, { fields, uploads, ip }) {
  const token = randomBytes(24).toString('base64url');
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO tournament_requests
           (name, city, end_date, category, organizer, email, phone, comment, status_token, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.name,
        fields.city,
        fields.end_date,
        fields.category,
        fields.organizer,
        fields.email,
        fields.phone,
        fields.comment,
        token,
        ip || null,
      );
    const id = Number(info.lastInsertRowid);
    const link = db.prepare('INSERT INTO tournament_request_files (request_id, upload_id) VALUES (?, ?)');
    for (const u of uploads) link.run(id, u.id);
    // Контакты организатора — тоже персональные данные, и у их обработки должно
    // быть основание. Согласия на РАСПРОСТРАНЕНИЕ здесь нет и не требуется:
    // телефон и почта организатора на сайте не публикуются.
    recordConsent(db, {
      kind: 'processing',
      event: 'granted',
      source: 'web',
      ip,
      subjectRef: `${fields.organizer} <${fields.email}> (заявка на турнир)`,
    });
    return { id, token };
  });
  return tx();
}

/**
 * ОДОБРЕНИЕ создаёт турнир в календаре. Город заявки в tournaments не уезжает:
 * там его колонки нет, а расширять схему движка ради справочного поля нельзя —
 * город остаётся в заявке и виден модератору.
 */
export function approveRequest(db, requestId, { userId = null } = {}) {
  const tx = db.transaction(() => {
    const req = byId(db, requestId);
    if (!req) throw new Error('Заявка не найдена');
    if (req.status !== 'pending') throw new Error('Заявка уже рассмотрена');
    const tournamentId = Number(
      db
        .prepare('INSERT INTO tournaments (name, end_date, category, city) VALUES (?, ?, ?, ?)')
        .run(req.name, req.end_date, req.category, req.city).lastInsertRowid,
    );
    db.prepare(
      "UPDATE tournament_requests SET status = 'approved', tournament_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(tournamentId, userId, requestId);
    return { request: byId(db, requestId), tournamentId };
  });
  return tx();
}

export function rejectRequest(db, requestId, { reason = null, userId = null } = {}) {
  const tx = db.transaction(() => {
    const req = byId(db, requestId);
    if (!req) throw new Error('Заявка не найдена');
    if (req.status !== 'pending') throw new Error('Заявка уже рассмотрена');
    db.prepare(
      "UPDATE tournament_requests SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?",
    ).run(reason, userId, requestId);
    return byId(db, requestId);
  });
  return tx();
}

/**
 * RETENTION. Отклонённые и брошенные заявки чистятся вместе с ФАЙЛАМИ: удалить
 * строку и оставить документы на диске значит хранить чужие ПДн без основания
 * и без срока. Одобренные живут — они объясняют, откуда турнир в календаре.
 */
export function purgeRequests(db, retentionDays, dir) {
  const cutoff = `-${Number(retentionDays)} days`;
  const stale = db
    .prepare(
      `SELECT id FROM tournament_requests
        WHERE status IN ('rejected','pending')
          AND COALESCE(decided_at, created_at) <= datetime('now', ?)`,
    )
    .all(cutoff);
  let removed = 0;
  for (const row of stale) {
    for (const file of requestFiles(db, row.id)) deleteUpload(db, file.id, dir);
    db.prepare('DELETE FROM tournament_requests WHERE id = ?').run(row.id);
    removed += 1;
  }
  return removed;
}

export { storeUpload };
