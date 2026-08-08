// Вертикаль рейтинга. Движок из /rating/ ВЫЗЫВАЕТСЯ как модуль и НЕ переписывается:
// сервис только собирает вход из SQLite, кладёт итог в rating_cache и считает
// «Изменение» на УРОВНЕ САЙТА (движок остаётся снимком, дельту не считает).
import { computeStandings, DEFAULT_CONFIG } from '../../../rating/rating.mjs';

export { DEFAULT_CONFIG as RATING_CONFIG };

/** Вход движка ровно в его формате: {tournaments, results, matches}. */
export function collectEngineInput(db) {
  const tournaments = db
    .prepare('SELECT id, name, end_date AS endDate, category FROM tournaments ORDER BY id')
    .all();
  // Имя и город берутся из players — имя одно на игрока, движок не ругается.
  const results = db
    .prepare(
      `SELECT r.player_id AS playerId, p.full_name AS playerName,
              r.tournament_id AS tournamentId, r.place AS place
         FROM results r JOIN players p ON p.id = r.player_id
        ORDER BY r.id`,
    )
    .all();
  const matches = db
    .prepare(
      `SELECT tournament_id AS tournamentId, winner_player_id AS winnerPlayerId,
              loser_player_id AS loserPlayerId
         FROM matches ORDER BY id`,
    )
    .all();
  return { tournaments, results, matches };
}

/** Город/пол/группа — для показа и фильтров §4.4; движку они не нужны. */
function playerMeta(db) {
  const rows = db.prepare('SELECT id, full_name, city, sex, age_group FROM players').all();
  return new Map(rows.map((r) => [r.id, r]));
}

/** Снимок = вывод движка + метаданные игроков, чтобы витрина не зависела от JOIN. */
export function buildSnapshot(db, { asOf } = {}) {
  const input = collectEngineInput(db);
  const standings = computeStandings(asOf ? { ...input, asOf } : input);
  const meta = playerMeta(db);
  return {
    ratingStatus: standings.ratingStatus,
    asOf: standings.asOf,
    warnings: standings.warnings,
    players: standings.players.map((p) => {
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
    }),
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

export const HIDDEN_LABEL = 'Скрыто по заявлению';
export const ERASED_LABEL = 'Игрок удалён';

/**
 * ОДИН слой обезличивания на ТРИ случая:
 *  - нет действующего согласия на распространение (is_public = 0) -> «Скрыто по заявлению»;
 *  - игрок ОБЕЗЛИЧЕН по ст. 21 (anonymized_at заполнен)          -> «Игрок удалён»;
 *  - игрока больше нет в БД (снесён из админки, снимок старый)    -> «Игрок удалён».
 *
 * Разница между вторым и третьим случаем только в способе: в обоих личных
 * данных на витрине нет. Но различать «нет согласия» и «удалён» ОБЯЗАТЕЛЬНО:
 * первое обратимо согласием субъекта, второе — нет.
 *
 * МЕСТО И ОЧКИ СОХРАНЯЮТСЯ. Выкинуть строку нельзя: места соперников уедут
 * вверх и опубликованная таблица перестанет биться с расчётом движка.
 * Движок и снимки работают с РЕАЛЬНЫМИ данными — прячем только на выдаче.
 *
 * Город, пол и группу тоже гасим: по согласию (ст. 10.1) они разрешены к
 * публикации вместе с именем, а не отдельно. Побочный эффект намеренный —
 * поиск по фамилии и фильтры по такой строке не сработают, значит через
 * фильтр скрытого игрока не опознать.
 */
export function anonymizeForPublic(db, players) {
  const state = new Map(
    db
      .prepare('SELECT id, is_public, anonymized_at FROM players')
      .all()
      .map((r) => [r.id, r]),
  );
  return players.map((p) => {
    const row = state.get(p.playerId);
    if (row && row.is_public && !row.anonymized_at) return p;
    const erased = !row || Boolean(row.anonymized_at);
    return {
      ...p,
      playerName: erased ? ERASED_LABEL : HIDDEN_LABEL,
      city: '',
      sex: '',
      ageGroup: null,
      anonymized: erased ? 'erased' : 'hidden',
    };
  });
}

/**
 * То, что нужно витрине: игроки со стрелками, статус, дата актуальности.
 * ЕДИНСТВЕННАЯ дверь публичной выдачи рейтинга (/rating, /rating.csv, ТОП-5
 * на главной) — поэтому обезличивание стоит здесь, а не в каждом шаблоне.
 * Админка ходит мимо, через lastSnapshots: у неё законный доступ к данным.
 */
export function currentStandings(db) {
  const snaps = lastSnapshots(db, 2);
  if (snaps.length === 0) return null;
  const [current, previous] = snaps;
  return {
    snapshotId: current.id,
    computedAt: current.computedAt,
    status: current.status,
    asOf: current.data.asOf,
    hasPrevious: Boolean(previous),
    players: anonymizeForPublic(db, withChange(current.data, previous ? previous.data : null)),
  };
}

export const STATUS_RU = {
  preliminary: 'Предварительный · первый сезон',
  final: 'Основной',
};

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
