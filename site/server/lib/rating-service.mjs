// Вертикаль рейтинга. Движок из /rating/ ВЫЗЫВАЕТСЯ как модуль и НЕ переписывается:
// сервис только собирает вход из SQLite, кладёт итог в rating_cache и считает
// «Изменение» на УРОВНЕ САЙТА (движок остаётся снимком, дельту не считает).
import { computeStandings, DEFAULT_CONFIG } from '../../../rating/rating.mjs';
import { ageOn, sliceAge, ageLabel, slicesFor } from './age.mjs';

export { DEFAULT_CONFIG as RATING_CONFIG };

// Разряды. Рейтинги считаются РАЗДЕЛЬНО (как у РТТ): одиночный по results с
// discipline='single' и матчам kind='single', парный — по 'double'. Движок при
// этом один и тот же и не переписывается.
export const DISCIPLINES = ['single', 'double'];
export const DISCIPLINE_RU = { single: 'одиночный', double: 'парный' };

/** Вход движка ровно в его формате: {tournaments, results, matches} — для одного разряда. */
export function collectEngineInput(db, discipline = 'single') {
  const tournaments = db
    .prepare('SELECT id, name, end_date AS endDate, category FROM tournaments WHERE is_published = 1 ORDER BY id')
    .all();
  // Имя и город берутся из players — имя одно на игрока, движок не ругается.
  const results = db
    .prepare(
      `SELECT r.player_id AS playerId, p.full_name AS playerName,
              r.tournament_id AS tournamentId, r.place AS place
         FROM results r JOIN players p ON p.id = r.player_id
         JOIN tournaments t ON t.id = r.tournament_id
        WHERE r.discipline = ? AND t.is_published = 1
        ORDER BY r.id`,
    )
    .all(discipline);
  const matches = db
    .prepare(
      `SELECT m.tournament_id AS tournamentId, m.winner_player_id AS winnerPlayerId,
              m.loser_player_id AS loserPlayerId
         FROM matches m JOIN tournaments t ON t.id = m.tournament_id
        WHERE m.kind = ? AND t.is_published = 1 ORDER BY m.id`,
    )
    .all(discipline);
  return { tournaments, results, matches };
}

/** Город/пол/группа — для показа и фильтров §4.4; движку они не нужны. */
function playerMeta(db) {
  const rows = db.prepare('SELECT id, full_name, city, sex, age_group FROM players').all();
  return new Map(rows.map((r) => [r.id, r]));
}

function rowsWithMeta(standings, meta) {
  return standings.players.map((p) => {
    const m = meta.get(p.playerId) || {};
    return {
      rank: p.rank,
      playerId: p.playerId,
      playerName: p.playerName,
      city: m.city || '',
      sex: m.sex || '',
      ageGroup: m.age_group || null,
      ratingPoints: p.ratingPoints,
      counted: p.counted,
      totalInWindow: p.totalInWindow,
    };
  });
}

/**
 * Снимок = вывод движка + метаданные игроков, чтобы витрина не зависела от JOIN.
 * players — одиночный разряд, doubles — парный (пустой список, пока парных
 * результатов нет: схема готова, интерфейс включится с данными).
 * ДАТА РОЖДЕНИЯ В СНИМОК НЕ КЛАДЁТСЯ: возраст считается на выдаче, живьём.
 */
export function buildSnapshot(db, { asOf } = {}) {
  const single = collectEngineInput(db, 'single');
  const double = collectEngineInput(db, 'double');
  const standings = computeStandings(asOf ? { ...single, asOf } : single);
  const doubles = computeStandings(asOf ? { ...double, asOf } : double);
  const meta = playerMeta(db);
  return {
    ratingStatus: standings.ratingStatus,
    asOf: standings.asOf,
    warnings: [...standings.warnings, ...doubles.warnings.map((w) => `парный: ${w}`)],
    players: rowsWithMeta(standings, meta),
    doubles: rowsWithMeta(doubles, meta),
  };
}

// --- лок пересчёта --------------------------------------------------------

/**
 * Атомарный захват лока одним UPDATE с охраной в WHERE: двойное нажатие или
 * параллельный вызов второй раз не пройдёт. ПРОТУХШИЙ ЛОК (пересчёт упал на
 * середине) старше staleLockMinutes считается недействительным и перехватывается —
 * иначе кнопка «Пересчитать» залипнет навсегда.
 */
export function acquireLock(db, staleLockMinutes) {
  const res = db
    .prepare(
      "UPDATE compute_lock SET is_computing = 1, started_at = datetime('now') " +
        'WHERE id = 1 AND (is_computing = 0 OR started_at IS NULL ' +
        "OR started_at <= datetime('now', ?))",
    )
    .run(`-${staleLockMinutes} minutes`);
  return res.changes === 1;
}

export function releaseLock(db) {
  db.prepare('UPDATE compute_lock SET is_computing = 0, started_at = NULL WHERE id = 1').run();
}

export function lockState(db) {
  return db.prepare('SELECT is_computing, started_at FROM compute_lock WHERE id = 1').get();
}

// --- снимки ---------------------------------------------------------------

export function saveSnapshot(db, snapshot, keep) {
  const info = db
    .prepare('INSERT INTO rating_cache (status, standings_json) VALUES (?, ?)')
    .run(snapshot.ratingStatus, JSON.stringify(snapshot));
  // RETENTION: держим последние N снимков (для «Изменения» нужны 2), старее чистим.
  db.prepare(
    'DELETE FROM rating_cache WHERE id NOT IN ' +
      '(SELECT id FROM rating_cache ORDER BY id DESC LIMIT ?)',
  ).run(keep);
  return info.lastInsertRowid;
}

/** Два последних снимка: [последний, предыдущий]. Пусто -> []. */
export function lastSnapshots(db, n = 2) {
  return db
    .prepare('SELECT id, computed_at, status, standings_json FROM rating_cache ORDER BY id DESC LIMIT ?')
    .all(n)
    .map((row) => ({
      id: row.id,
      computedAt: row.computed_at,
      status: row.status,
      data: JSON.parse(row.standings_json),
    }));
}

/**
 * «Изменение» (▲/▼/—) на уровне сайта: разница рангов двух последних снимков.
 *  - прошлого снимка нет вовсе (первая публикация, первый сезон) -> «—»
 *  - игрок есть в новом, но отсутствует в предыдущем -> «нов.»
 */
export function withChange(current, previous) {
  const prevRank = previous
    ? new Map(previous.players.map((p) => [p.playerId, p.rank]))
    : null;
  return current.players.map((p) => {
    if (!prevRank) return { ...p, change: { kind: 'none', delta: 0, label: '—' } };
    if (!prevRank.has(p.playerId)) return { ...p, change: { kind: 'new', delta: 0, label: 'нов.' } };
    const delta = prevRank.get(p.playerId) - p.rank; // выше в таблице = ранг меньше
    if (delta > 0) return { ...p, change: { kind: 'up', delta, label: `▲ +${delta}` } };
    if (delta < 0) return { ...p, change: { kind: 'down', delta, label: `▼ −${Math.abs(delta)}` } };
    return { ...p, change: { kind: 'flat', delta: 0, label: '— 0' } };
  });
}

// --- обезличивание на отрисовке -------------------------------------------

export const ERASED_LABEL = 'Игрок удалён';

/**
 * ОДИН слой обезличивания на ДВА случая:
 *  - игрок ОБЕЗЛИЧЕН по ст. 21 (anonymized_at заполнен)          -> «Игрок удалён»;
 *  - игрока больше нет в БД (снесён из админки, снимок старый)    -> «Игрок удалён».
 *
 * СОГЛАСИЕ НА ВИТРИНУ БОЛЬШЕ НЕ ВЛИЯЕТ (ТЗ ред. 6, модель РТТ): результаты
 * соревнований публикуются на основании участия в них (п. 5 ч. 1 ст. 6 152-ФЗ,
 * 329-ФЗ), а не согласия, и отзыв согласия строку в рейтинге не меняет.
 * Прежнего «Скрыто по заявлению» нет.
 *
 * МЕСТО И ОЧКИ СОХРАНЯЮТСЯ и у обезличенного. Выкинуть строку нельзя: места
 * соперников уедут вверх и опубликованная таблица перестанет биться с расчётом
 * движка. Движок и снимки работают с РЕАЛЬНЫМИ данными — прячем только на выдаче.
 *
 * Здесь же — ВОЗРАСТ ЖИВЬЁМ: полные годы на сегодня от birth_date (в снимке даты
 * нет), срезы и признак фотографии. Обезличенному ничего из этого не даётся.
 */
export function anonymizeForPublic(db, players, { on } = {}) {
  const state = new Map(
    db
      .prepare('SELECT id, anonymized_at, birth_date, photo_upload_id FROM players')
      .all()
      .map((r) => [r.id, r]),
  );
  return players.map((p) => {
    const row = state.get(p.playerId);
    if (row && !row.anonymized_at) {
      const age = ageOn(row.birth_date, on); // на витрину — полные годы
      const forSlice = sliceAge(row.birth_date, on); // в срезы — по году рождения (РТТ)
      return {
        ...p,
        age,
        ageLabel: ageLabel(age),
        slices: slicesFor(forSlice),
        hasPhoto: Boolean(row.photo_upload_id),
      };
    }
    return {
      ...p,
      playerName: ERASED_LABEL,
      city: '',
      sex: '',
      ageGroup: null,
      age: null,
      ageLabel: '—',
      slices: [],
      hasPhoto: false,
      anonymized: 'erased',
    };
  });
}

/**
 * То, что нужно витрине: игроки со стрелками, статус, дата актуальности.
 * ЕДИНСТВЕННАЯ дверь публичной выдачи рейтинга (/rating, /rating.csv, ТОП-5
 * на главной, профиль) — поэтому обезличивание стоит здесь, а не в каждом шаблоне.
 * Админка ходит мимо, через lastSnapshots: у неё законный доступ к данным.
 */
export function currentStandings(db) {
  const snaps = lastSnapshots(db, 2);
  if (snaps.length === 0) return null;
  const [current, previous] = snaps;
  const prev = previous ? previous.data : null;
  const prevDoubles = prev && Array.isArray(prev.doubles) ? { players: prev.doubles } : null;
  return {
    snapshotId: current.id,
    computedAt: current.computedAt,
    status: current.status,
    asOf: current.data.asOf,
    hasPrevious: Boolean(previous),
    players: anonymizeForPublic(db, withChange(current.data, prev)),
    // Снимки, снятые до появления парного разряда, поля doubles не имеют.
    doubles: anonymizeForPublic(
      db,
      withChange({ players: Array.isArray(current.data.doubles) ? current.data.doubles : [] }, prevDoubles),
    ),
  };
}

// --- публичный профиль -------------------------------------------------------

/**
 * Всё для /player/:id одним вызовом. null — игрока нет либо он обезличен по
 * ст. 21 (профиля у анонимной вершины графа матчей быть не может -> 404).
 *
 * Состав — ровно перечень ТЗ §5: ФИО, город, пол, возраст в полных годах,
 * группа и срезы, очки и место (одиночный и парный), число турниров, результаты
 * по турнирам, матчи с соперниками/партнёрами, счётом, датой и турниром.
 * Даты рождения, почты, телефона здесь НЕТ и быть не должно (см. приёмку).
 */
export function playerProfile(db, playerId) {
  const row = db
    .prepare(
      `SELECT id, full_name, city, sex, age_group, birth_date, rni, photo_upload_id, anonymized_at
         FROM players WHERE id = ?`,
    )
    .get(playerId);
  if (!row || row.anonymized_at) return null;

  const standings = currentStandings(db);
  const inTable = (list) => (list || []).find((p) => p.playerId === row.id) || null;
  const age = ageOn(row.birth_date);

  const results = db
    .prepare(
      `SELECT r.place, r.discipline, t.id AS tournament_id, t.name AS tournament_name,
              t.end_date, t.category
         FROM results r JOIN tournaments t ON t.id = r.tournament_id
        WHERE r.player_id = ?
        ORDER BY t.end_date DESC, t.id DESC, r.discipline`,
    )
    .all(row.id);

  // Матч выводится «от лица» игрока: соперник(и), выигран/проигран, партнёр.
  // Обезличенный соперник — «Игрок удалён» без ссылки.
  const matches = db
    .prepare(
      `SELECT m.id, m.kind, m.score, COALESCE(m.played_on, t.end_date) AS played_on,
              t.id AS tournament_id, t.name AS tournament_name,
              m.winner_player_id, m.loser_player_id, m.winner_partner_id, m.loser_partner_id
         FROM matches m JOIN tournaments t ON t.id = m.tournament_id
        WHERE ? IN (m.winner_player_id, m.loser_player_id, m.winner_partner_id, m.loser_partner_id)
        ORDER BY played_on DESC, m.id DESC`,
    )
    .all(row.id);
  const ids = new Set();
  for (const m of matches) {
    for (const k of ['winner_player_id', 'loser_player_id', 'winner_partner_id', 'loser_partner_id']) {
      if (m[k]) ids.add(m[k]);
    }
  }
  const names = new Map();
  if (ids.size) {
    const list = [...ids];
    db.prepare(`SELECT id, full_name, anonymized_at FROM players WHERE id IN (${list.map(() => '?').join(',')})`)
      .all(...list)
      .forEach((p) => names.set(p.id, p));
  }
  const ref = (id) => {
    if (!id) return null;
    const p = names.get(id);
    if (!p || p.anonymized_at) return { id: null, name: ERASED_LABEL };
    return { id: p.id, name: p.full_name };
  };
  const matchRows = matches.map((m) => {
    const won = m.winner_player_id === row.id || m.winner_partner_id === row.id;
    const ownSide = won ? ['winner_player_id', 'winner_partner_id'] : ['loser_player_id', 'loser_partner_id'];
    const otherSide = won ? ['loser_player_id', 'loser_partner_id'] : ['winner_player_id', 'winner_partner_id'];
    const partnerId = ownSide.map((k) => m[k]).find((id) => id && id !== row.id) || null;
    return {
      id: m.id,
      kind: m.kind,
      won,
      score: m.score || '',
      playedOn: m.played_on,
      tournament: { id: m.tournament_id, name: m.tournament_name },
      opponents: otherSide.map((k) => ref(m[k])).filter(Boolean),
      partner: ref(partnerId),
    };
  });

  return {
    id: row.id,
    fullName: row.full_name,
    city: row.city,
    sex: row.sex,
    ageGroup: row.age_group || null,
    rni: row.rni || null,
    age,
    ageLabel: ageLabel(age),
    slices: slicesFor(sliceAge(row.birth_date)), // срезы — по году рождения, как в рейтинге
    hasPhoto: Boolean(row.photo_upload_id),
    rating: standings
      ? {
          asOf: standings.asOf,
          computedAt: standings.computedAt,
          status: standings.status,
          single: inTable(standings.players),
          double: inTable(standings.doubles),
        }
      : null,
    tournamentsPlayed: new Set(results.map((r) => r.tournament_id)).size,
    results,
    matches: matchRows,
  };
}

export const STATUS_RU = {
  preliminary: 'Предварительный · первый сезон',
  final: 'Основной',
};

/**
 * ИСТОРИЯ РЕЙТИНГА ИГРОКА (идея ФТР/TennisNET, 06.09.2026): по сохранённым снимкам —
 * место и очки помесячно (последний снимок месяца) и наивысшее место за всю историю
 * снимков. Снимков хранится keepSnapshots (24), этого хватает на два года помесячно.
 */
export function playerRatingHistory(db, playerId, discipline = 'single') {
  const snaps = lastSnapshots(db, 240).reverse(); // от старых к новым
  const byMonth = new Map();
  let best = null;
  for (const s of snaps) {
    const list = discipline === 'double' ? (s.data.doubles || []) : (s.data.players || []);
    const p = list.find((x) => x.playerId === playerId);
    if (!p) continue;
    const month = String(s.data.asOf || s.computedAt).slice(0, 7);
    byMonth.set(month, { month, asOf: s.data.asOf, rank: p.rank, points: p.ratingPoints });
    if (best === null || p.rank < best.rank) best = { rank: p.rank, asOf: s.data.asOf };
  }
  return { points: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)), best };
}

export function statusLabel(status) {
  return STATUS_RU[status] || status;
}

/** Возраст последнего снимка в секундах; null, если снимков ещё нет. */
export function secondsSinceLastSnapshot(db) {
  const row = db
    .prepare(
      "SELECT CAST((julianday('now') - julianday(computed_at)) * 86400 AS INTEGER) AS age " +
        'FROM rating_cache ORDER BY id DESC LIMIT 1',
    )
    .get();
  return row ? row.age : null;
}

/**
 * Полный пересчёт по кнопке (не cron). Лок держится ВОКРУГ всего расчёта и
 * снимается в finally — упавший пересчёт не оставляет лок висеть.
 *
 * Одного лока против двойного нажатия НЕ хватает: better-sqlite3 синхронный и
 * процесс один, поэтому два запроса обрабатываются ПОСЛЕДОВАТЕЛЬНО — первый
 * успевает снять лок до начала второго. Поэтому вторая защита, как и требует ТЗ:
 * не чаще раза в minIntervalSeconds. Иначе два почти одинаковых снимка подряд
 * обнулят колонку «Изменение» (все станут «— 0»).
 */
export function recompute(
  db,
  { staleLockMinutes, keepSnapshots, asOf, minIntervalSeconds = 0 } = {},
) {
  if (minIntervalSeconds > 0) {
    const age = secondsSinceLastSnapshot(db);
    if (age !== null && age < minIntervalSeconds) {
      return { ok: false, reason: 'too-soon', retryAfter: minIntervalSeconds - age };
    }
  }
  if (!acquireLock(db, staleLockMinutes)) {
    return { ok: false, reason: 'busy' };
  }
  try {
    const snapshot = buildSnapshot(db, { asOf });
    const id = saveSnapshot(db, snapshot, keepSnapshots);
    return { ok: true, snapshotId: id, players: snapshot.players.length, warnings: snapshot.warnings };
  } finally {
    releaseLock(db);
  }
}
