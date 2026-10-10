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
import { ageRangeLabel } from './age.mjs';
import { recordConsent } from './consent-journal.mjs';
import { entryOpens } from './content.mjs';
import { queueMail, mailTournamentDocsOpen } from './mailer.mjs';

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
           (name, city, start_date, end_date, category, organizer, email, phone, comment, age_min, age_max, status_token, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.name,
        fields.city,
        fields.start_date,
        fields.end_date,
        fields.category,
        fields.organizer,
        fields.email,
        fields.phone,
        fields.comment,
        fields.age_min ?? null,
        fields.age_max ?? null,
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
        // Организатор и контакт из заявки — в карточку турнира (ТЗ 4.3 «контакт организатора»).
        // Возрастное ограничение заявки переезжает в турнир вместе с подписью: с этого
        // момента оно не пожелание организатора, а проверка при вводе участников.
        .prepare('INSERT INTO tournaments (name, start_date, end_date, category, city, organizer, organizer_contact, age_min, age_max, age_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(req.name, req.start_date ?? null, req.end_date, req.category, req.city, req.organizer, [req.email, req.phone].filter(Boolean).join(', '), req.age_min ?? null, req.age_max ?? null, ageRangeLabel(req.age_min, req.age_max)).lastInsertRowid,
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

// --- документы турнира от организатора ---------------------------------------
//
// ДОКУМЕНТЫ — С ОТКРЫТИЯ ПРИЁМА ЗАЯВОК (10.10.2026, правило владельца). В форме
// заявки файлов больше нет: положение, сетку и регламент организатор загружает
// по ссылке на статус заявки — после согласования турнира и не раньше открытия
// приёма (категория A — за месяц до начала, B и C — за две недели, entryOpens).
// В день открытия организатору приходит письмо со ссылкой (runDocsOpenNotices).

const todayIso = () => new Date().toISOString().slice(0, 10);
const ru = (iso) => iso.split('-').reverse().join('.');

/** Можно ли загружать документы по заявке: { open, opens, reason, tournament }. */
export function docsGate(db, request, now = todayIso()) {
  const opens = entryOpens(request);
  if (request.status !== 'approved' || !request.tournament_id) {
    return { open: false, opens, reason: `Документы загружаются после согласования турнира — с ${ru(opens)} (начало приёма заявок).` };
  }
  const t = db.prepare('SELECT id, name, category, start_date, end_date, is_published FROM tournaments WHERE id = ?').get(request.tournament_id);
  if (!t) return { open: false, opens, reason: 'Турнир не найден в календаре — напишите секретарю Федерации.' };
  const tOpens = entryOpens(t);
  if (now < tOpens) return { open: false, opens: tOpens, tournament: t, reason: `Загрузка документов откроется ${ru(tOpens)} — с началом приёма заявок.` };
  if (t.end_date < now) return { open: false, opens: tOpens, tournament: t, reason: 'Турнир завершён — документы больше не принимаются.' };
  return { open: true, opens: tOpens, tournament: t, reason: '' };
}

export function runDocsOpenNotices(db, { baseUrl, now = todayIso() } = {}) {
  const rows = db
    .prepare(`SELECT r.id, r.name, r.organizer, r.email, r.status_token, t.category, t.start_date, t.end_date
                FROM tournament_requests r JOIN tournaments t ON t.id = r.tournament_id
               WHERE r.status = 'approved' AND r.docs_notice_sent_at IS NULL AND t.is_published = 1`)
    .all();
  let sent = 0;
  for (const r of rows) {
    const start = r.start_date || r.end_date;
    if (now < entryOpens(r) || now >= start) continue;
    db.transaction(() => {
      queueMail(db, { to: r.email, kind: 'tournament.docs.open', ...mailTournamentDocsOpen({ organizer: r.organizer, name: r.name, statusUrl: `${String(baseUrl || '').replace(/\/$/, '')}/tournament-request/status/${r.status_token}` }) });
      db.prepare("UPDATE tournament_requests SET docs_notice_sent_at = datetime('now') WHERE id = ?").run(r.id);
    })();
    sent += 1;
  }
  return sent;
}
