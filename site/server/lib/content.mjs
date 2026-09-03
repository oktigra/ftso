// КОНТЕНТ ВИТРИНЫ: новости, документы турниров и Федерации, галерея.
//
// Общая идея доступа к файлам: файл виден публично ТОЛЬКО если он привязан к
// опубликованной сущности. Проверка одна (publicUploadIds) — иначе «а вот тут
// ещё один маршрут» рано или поздно отдаст наружу документ с модерации.
import { str, isoDate, oneOf, intAtLeast, ValidationError } from './validate.mjs';

// --- новости ---------------------------------------------------------------

export function newsInput(body) {
  return {
    title: str(body.title, 'Заголовок', { max: 200 }),
    summary: str(body.summary, 'Короткое описание', { max: 500, required: false }),
    body: str(body.body, 'Текст', { max: 20000 }),
    is_published: oneOf(String(body.is_published ?? '0'), 'Публикация', ['0', '1']) === '1' ? 1 : 0,
    published_at: body.published_at ? isoDate(body.published_at, 'Дата публикации') : null,
  };
}

export function publishedNews(db, limit = 50) {
  return db
    .prepare(
      `SELECT * FROM news WHERE is_published = 1
        ORDER BY COALESCE(published_at, date(created_at)) DESC, id DESC LIMIT ?`,
    )
    .all(limit);
}

export function newsById(db, id, { publishedOnly = false } = {}) {
  const row = db.prepare('SELECT * FROM news WHERE id = ?').get(id);
  if (!row) return null;
  if (publishedOnly && !row.is_published) return null;
  return row;
}

export function allNews(db) {
  return db.prepare('SELECT * FROM news ORDER BY id DESC').all();
}

// --- турниры ---------------------------------------------------------------

/** Публичный список турниров: свежие сверху, как в календаре. */
export function tournamentList(db) {
  return db
    .prepare(
      `SELECT t.id, t.name, t.end_date, t.category,
              (SELECT COUNT(*) FROM results r WHERE r.tournament_id = t.id) AS participants
         FROM tournaments t ORDER BY t.end_date DESC, t.id DESC`,
    )
    .all();
}

/**
 * Участники турнира по местам. Ссылки ведут на публичный профиль /player/:id
 * (ТЗ ред. 6, модель РТТ): результаты соревнований публикуются на основании
 * участия, согласие на витрину не влияет. Обезличенный по ст. 21 — «Игрок
 * удалён» без ссылки и без города. discipline: одиночный / парный разряд.
 */
export function tournamentParticipants(db, tournamentId, { erasedLabel }) {
  return db
    .prepare(
      `SELECT r.place, r.discipline, p.id AS player_id, p.full_name, p.city, p.anonymized_at
         FROM results r JOIN players p ON p.id = r.player_id
        WHERE r.tournament_id = ? ORDER BY r.discipline, r.place`,
    )
    .all(tournamentId)
    .map((row) => {
      const erased = Boolean(row.anonymized_at);
      return {
        place: row.place,
        discipline: row.discipline,
        playerId: erased ? null : row.player_id,
        name: erased ? erasedLabel : row.full_name,
        city: erased ? '' : row.city,
        anonymized: erased ? 'erased' : null,
      };
    });
}

/** Сетка: сыгранные матчи турнира — стороны со ссылками, счёт, дата, разряд. */
export function tournamentMatches(db, tournamentId, { erasedLabel }) {
  const rows = db
    .prepare(
      `SELECT m.id, m.kind, m.score, COALESCE(m.played_on, t.end_date) AS played_on,
              m.winner_player_id, m.loser_player_id, m.winner_partner_id, m.loser_partner_id
         FROM matches m JOIN tournaments t ON t.id = m.tournament_id
        WHERE m.tournament_id = ? ORDER BY played_on, m.id`,
    )
    .all(tournamentId);
  const ids = [...new Set(rows.flatMap((m) => [m.winner_player_id, m.loser_player_id, m.winner_partner_id, m.loser_partner_id]).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    db.prepare(`SELECT id, full_name, anonymized_at FROM players WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids)
      .forEach((p) => names.set(p.id, p));
  }
  const ref = (id) => {
    if (!id) return null;
    const p = names.get(id);
    if (!p || p.anonymized_at) return { id: null, name: erasedLabel };
    return { id: p.id, name: p.full_name };
  };
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    score: m.score || '',
    playedOn: m.played_on,
    winners: [ref(m.winner_player_id), ref(m.winner_partner_id)].filter(Boolean),
    losers: [ref(m.loser_player_id), ref(m.loser_partner_id)].filter(Boolean),
    // Совместимость со старой витриной/тестами: имена сторон строкой.
    winner: [ref(m.winner_player_id), ref(m.winner_partner_id)].filter(Boolean).map((r) => r.name).join(' / '),
    loser: [ref(m.loser_player_id), ref(m.loser_partner_id)].filter(Boolean).map((r) => r.name).join(' / '),
  }));
}

export function tournamentFiles(db, tournamentId) {
  return db
    .prepare(
      `SELECT u.*, f.title AS doc_title FROM tournament_files f
         JOIN uploads u ON u.id = f.upload_id
        WHERE f.tournament_id = ? ORDER BY f.id`,
    )
    .all(tournamentId);
}

/** Перевешивает файлы согласованной заявки на сам турнир. */
export function attachRequestFiles(db, requestId, tournamentId) {
  const files = db
    .prepare('SELECT upload_id FROM tournament_request_files WHERE request_id = ?')
    .all(requestId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO tournament_files (tournament_id, upload_id) VALUES (?, ?)',
  );
  for (const f of files) ins.run(tournamentId, f.upload_id);
  return files.length;
}

// --- документы Федерации и галерея ----------------------------------------

export function federationDocuments(db) {
  return db
    .prepare(
      `SELECT d.id, d.title, d.category, u.id AS upload_id, u.original_name, u.mime, u.size_bytes
         FROM federation_documents d JOIN uploads u ON u.id = d.upload_id
        ORDER BY d.category, d.id DESC`,
    )
    .all();
}

export function galleryItems(db) {
  return db
    .prepare(
      `SELECT g.id, g.title, u.id AS upload_id, u.original_name, u.mime,
              g.tournament_id, t.name AS tournament_name, t.end_date AS tournament_date
         FROM gallery_items g JOIN uploads u ON u.id = g.upload_id
         LEFT JOIN tournaments t ON t.id = g.tournament_id
        ORDER BY g.id DESC`,
    )
    .all();
}

/**
 * ЕДИНСТВЕННАЯ проверка публичной доступности файла: он публичен, если привязан
 * к опубликованной сущности. Документы заявки, ждущей модерации, сюда не
 * попадают — их по-прежнему видит только модератор через /admin/files.
 */
export function isPubliclyVisibleUpload(db, uploadId) {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM (
         SELECT upload_id FROM tournament_files
         UNION ALL SELECT upload_id FROM federation_documents
         UNION ALL SELECT upload_id FROM gallery_items
         UNION ALL SELECT cover_upload_id AS upload_id FROM news WHERE is_published = 1
       ) WHERE upload_id = ? LIMIT 1`,
    )
    .get(uploadId);
  return Boolean(row);
}

export function documentInput(body) {
  return {
    title: str(body.title, 'Заголовок', { max: 200 }),
    category: str(body.category, 'Категория', { max: 80 }),
  };
}

export function galleryInput(body) {
  return {
    title: str(body.title, 'Подпись', { max: 200 }),
    // Соревнование необязательно: общие снимки федерации тоже бывают.
    tournament_id: body.tournament_id ? intAtLeast(body.tournament_id, 'Турнир') : null,
  };
}

export { ValidationError };
