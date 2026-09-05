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
    // ТЗ 4.2 — автор материала; пусто = Федерация.
    author: str(body.author, 'Автор', { max: 120, required: false }) || null,
  };
}

/** Вложения новости (ТЗ 4.2): файлы и ссылки, в порядке добавления. */
export function newsAttachments(db, newsId) {
  return db
    .prepare(
      `SELECT a.id, a.title, a.url, a.upload_id, u.kind, u.original_name, u.size_bytes
         FROM news_attachments a LEFT JOIN uploads u ON u.id = a.upload_id
        WHERE a.news_id = ? ORDER BY a.id`,
    )
    .all(newsId);
}

export function publishedNews(db, limit = 50, q = '') {
  const rows = db
    .prepare(
      `SELECT * FROM news WHERE is_published = 1
        ORDER BY COALESCE(published_at, date(created_at)) DESC, id DESC ${q ? '' : 'LIMIT ?'}`,
    )
    .all(...(q ? [] : [limit]));
  if (!q) return rows;
  // Поиск (ТЗ 4.2) — в JS, а не LIKE: SQLite не знает регистра кириллицы
  // («ракетки» и «РАКЕТКИ» для LIKE — разные строки). Новостей — сотни, не миллионы.
  const needle = q.toLowerCase();
  return rows
    .filter((n) => [n.title, n.summary, n.body].some((v) => String(v || '').toLowerCase().includes(needle)))
    .slice(0, limit);
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
export function tournamentStatus(t, today = new Date().toISOString().slice(0, 10)) {
  if (t.end_date < today) return 'finished';
  if (t.start_date && t.start_date <= today) return 'ongoing';
  if (!t.start_date && t.end_date === today) return 'ongoing';
  return 'upcoming';
}

/**
 * Календарь турниров с фильтрами ТЗ п. 4.3: дата (год-месяц), город, категория,
 * возраст, статус (вычисляется от дат), тип. Фильтры — в SQL, где это дёшево,
 * статус — в JS (зависит от «сегодня»). Значения для селектов берутся из базы:
 * города и возраста — только те, что реально есть.
 */
export function tournamentList(db, filters = {}) {
  const where = [];
  const args = [];
  if (filters.month) { where.push("substr(t.end_date, 1, 7) = ?"); args.push(filters.month); }
  if (filters.city) { where.push('t.city = ?'); args.push(filters.city); }
  if (filters.category) { where.push('t.category = ?'); args.push(filters.category); }
  if (filters.age) { where.push('t.age_group = ?'); args.push(filters.age); }
  if (filters.kind) { where.push('t.kind = ?'); args.push(filters.kind); }
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.end_date, t.start_date, t.category, t.city, t.kind, t.age_group,
              (SELECT COUNT(*) FROM results r WHERE r.tournament_id = t.id) AS participants
         FROM tournaments t ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY t.end_date DESC, t.id DESC`,
    )
    .all(...args)
    .map((t) => ({ ...t, status: tournamentStatus(t) }));
  return filters.status ? rows.filter((t) => t.status === filters.status) : rows;
}

/**
 * ЖИВЫЕ ЦИФРЫ ГЛАВНОЙ (05.09.2026): вместо «318 игроков» из макета — счёт по базе.
 * Турниров за 12 месяцев, игроков в текущем снимке рейтинга, городов (игроки + турниры).
 */
export function homeStats(db, standings) {
  const year = db.prepare("SELECT COUNT(*) AS n FROM tournaments WHERE end_date >= date('now', '-12 months')").get().n;
  const cities = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT city FROM players WHERE anonymized_at IS NULL AND city IS NOT NULL AND city <> ''
       UNION SELECT city FROM tournaments WHERE city IS NOT NULL AND city <> '')`,
  ).get().n;
  return [
    { value: String(year), label: 'турниров за год' },
    { value: String(standings ? standings.players.length : 0), label: 'игроков в рейтинге' },
    { value: String(cities), label: cities === 1 ? 'город области' : 'городов области' },
  ];
}

const RU_MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
/** Ближайший турнир (не завершённый) — для карточки на главной; null, если нет. */
export function homeNextEvent(db) {
  const today = new Date().toISOString().slice(0, 10);
  const t = db.prepare('SELECT id, name, start_date, end_date FROM tournaments WHERE end_date >= ? ORDER BY COALESCE(start_date, end_date), id LIMIT 1').get(today);
  if (!t) return null;
  const d = t.start_date || t.end_date;
  const status = tournamentStatus(t, today);
  return {
    id: t.id, name: t.name,
    date: `${Number(d.slice(8, 10))} ${RU_MONTHS[Number(d.slice(5, 7)) - 1]}`,
    status: status === 'ongoing' ? 'Идёт' : 'Предстоящий',
    statusClass: status === 'ongoing' ? 'status--live' : 'status--open',
  };
}

export function tournamentFilterOptions(db) {
  return {
    cities: db.prepare("SELECT DISTINCT city FROM tournaments WHERE city IS NOT NULL AND city <> '' ORDER BY city").all().map((r) => r.city),
    ages: db.prepare("SELECT DISTINCT age_group FROM tournaments WHERE age_group IS NOT NULL AND age_group <> '' ORDER BY age_group").all().map((r) => r.age_group),
    months: db.prepare("SELECT DISTINCT substr(end_date, 1, 7) AS m FROM tournaments ORDER BY m DESC").all().map((r) => r.m),
  };
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

/** Снимки галереи; с { tournamentId } — только привязанные к этому соревнованию (карточка турнира). */
export function galleryItems(db, { tournamentId = null } = {}) {
  return db
    .prepare(
      `SELECT g.id, g.title, u.id AS upload_id, u.original_name, u.mime,
              g.tournament_id, t.name AS tournament_name, t.end_date AS tournament_date
         FROM gallery_items g JOIN uploads u ON u.id = g.upload_id
         LEFT JOIN tournaments t ON t.id = g.tournament_id
        WHERE (? IS NULL OR g.tournament_id = ?)
        ORDER BY g.id DESC`,
    )
    .all(tournamentId, tournamentId);
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
         UNION ALL SELECT a.upload_id FROM news_attachments a JOIN news n ON n.id = a.news_id WHERE n.is_published = 1
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

/** Категории закрытых документов — фиксированный список, чтобы папка не расползалась. */
export const INTERNAL_DOC_CATEGORIES = ['152-ФЗ', 'РКН', 'Приказы', 'Договоры', 'Хостинг и домен', 'Прочее'];

export function internalDocuments(db) {
  return db
    .prepare(
      `SELECT d.id, d.title, d.category, d.note, d.created_at,
              u.id AS upload_id, u.original_name, u.mime, u.size_bytes
         FROM internal_documents d JOIN uploads u ON u.id = d.upload_id
        ORDER BY d.category, d.id DESC`,
    )
    .all();
}

export function internalDocInput(body) {
  const category = str(body.category, 'Категория', { max: 80 });
  if (!INTERNAL_DOC_CATEGORIES.includes(category)) throw new ValidationError('Категория: выберите из списка');
  return {
    title: str(body.title, 'Название', { max: 200 }),
    category,
    note: str(body.note, 'Примечание', { max: 500, required: false }) || null,
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
