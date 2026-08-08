// КОНТЕНТ ВИТРИНЫ: новости, документы турниров и Федерации, галерея.
//
// Общая идея доступа к файлам: файл виден публично ТОЛЬКО если он привязан к
// опубликованной сущности. Проверка одна (publicUploadIds) — иначе «а вот тут
// ещё один маршрут» рано или поздно отдаст наружу документ с модерации.
import { str, isoDate, oneOf, ValidationError } from './validate.mjs';

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
 * УЧАСТНИКИ карточки турнира. Ссылок на профили НЕТ — публичной карточки
 * игрока в проекте нет, и заводить её здесь нельзя.
 *
 * Имена проходят ТУ ЖЕ логику обезличивания, что и рейтинг: нет согласия на
 * публикацию — «Скрыто по заявлению», обезличен по ст. 21 — «Игрок удалён».
 * Иначе протокол турнира стал бы обходным путём вокруг согласия.
 */
export function tournamentParticipants(db, tournamentId, { hiddenLabel, erasedLabel }) {
  return db
    .prepare(
      `SELECT r.place, p.id AS player_id, p.full_name, p.city, p.is_public, p.anonymized_at
         FROM results r JOIN players p ON p.id = r.player_id
        WHERE r.tournament_id = ? ORDER BY r.place`,
    )
    .all(tournamentId)
    .map((row) => {
      const erased = Boolean(row.anonymized_at);
      const visible = row.is_public && !erased;
      return {
        place: row.place,
        name: visible ? row.full_name : erased ? erasedLabel : hiddenLabel,
        city: visible ? row.city : '',
        anonymized: visible ? null : erased ? 'erased' : 'hidden',
      };
    });
}

/** Сетка: сыгранные матчи турнира, имена по тем же правилам. */
export function tournamentMatches(db, tournamentId, { hiddenLabel, erasedLabel }) {
  const label = (name, isPublic, anonymizedAt) => {
    const erased = Boolean(anonymizedAt);
    if (isPublic && !erased) return name;
    return erased ? erasedLabel : hiddenLabel;
  };
  return db
    .prepare(
      `SELECT wi.full_name AS winner, wi.is_public AS winner_public, wi.anonymized_at AS winner_erased,
              lo.full_name AS loser,  lo.is_public AS loser_public,  lo.anonymized_at AS loser_erased
         FROM matches m
         JOIN players wi ON wi.id = m.winner_player_id
         JOIN players lo ON lo.id = m.loser_player_id
        WHERE m.tournament_id = ? ORDER BY m.id`,
    )
    .all(tournamentId)
    .map((m) => ({
      winner: label(m.winner, m.winner_public, m.winner_erased),
      loser: label(m.loser, m.loser_public, m.loser_erased),
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
      `SELECT g.id, g.title, u.id AS upload_id, u.original_name, u.mime
         FROM gallery_items g JOIN uploads u ON u.id = g.upload_id
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
  return { title: str(body.title, 'Подпись', { max: 200 }) };
}

export { ValidationError };
