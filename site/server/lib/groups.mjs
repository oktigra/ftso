// КРУГОВЫЕ ГРУППЫ ТУРНИРА (ускорение ввода п. 3, слой 1). Группа — список игроков;
// клетка (строка i, столбец j) — счёт матча с точки зрения ИГРОКА СТРОКИ.
// Победитель — по выигранным сетам («6:3 3:6 10:8» → строка выиграла 2:1).
// Матчи пишутся в общую таблицу matches: рейтинг и профили видят их как обычно.
// Места в группе: победы → личная встреча (двое) → разница сетов → разница геймов.
import { ValidationError } from './validate.mjs';

/** Разбор счёта: возвращает { rowWon, sets:[a,b], games:[a,b] } либо бросает. «wo» — строка выиграла без игры, «-wo» — проиграла. */
export function parseScore(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^wo$/i.test(s) || /^w\/o$/i.test(s)) return { rowWon: true, sets: [1, 0], games: [0, 0], score: 'w/o' };
  if (/^-wo$/i.test(s) || /^-w\/o$/i.test(s)) return { rowWon: false, sets: [0, 1], games: [0, 0], score: 'w/o' };
  const parts = s.split(' ');
  let a = 0; let b = 0; let ga = 0; let gb = 0;
  for (const p of parts) {
    const m = /^(\d{1,2})[:\-](\d{1,2})(?:\(\d+\))?$/.exec(p);
    if (!m) throw new ValidationError(`Счёт «${raw}» не разобран: пишите по сетам, например «6:3 3:6 10:8»`);
    const x = Number(m[1]); const y = Number(m[2]);
    if (x === y) throw new ValidationError(`Сет «${p}» без победителя`);
    if (x > y) a++; else b++;
    ga += x; gb += y;
  }
  if (a === b) throw new ValidationError(`Счёт «${raw}»: сеты поровну — победитель не определён`);
  return { rowWon: a > b, sets: [a, b], games: [ga, gb], score: parts.join(' ') };
}

export function listGroups(db, tournamentId) {
  const groups = db.prepare('SELECT id, name, kind FROM tournament_groups WHERE tournament_id = ? ORDER BY name, id').all(tournamentId);
  return groups.map((g) => ({ ...g, members: groupMembers(db, g.id), ...groupTable(db, tournamentId, g) }));
}

export function groupMembers(db, groupId) {
  return db
    .prepare(
      `SELECT m.player_id AS id, p.full_name, p.city, p.anonymized_at FROM tournament_group_members m
         JOIN players p ON p.id = m.player_id WHERE m.group_id = ? ORDER BY m.seed, m.player_id`,
    )
    .all(groupId);
}

/** Матрица клеток и таблица мест группы. */
export function groupTable(db, tournamentId, group) {
  const members = groupMembers(db, group.id);
  const ids = members.map((m) => m.id);
  const matches = ids.length
    ? db.prepare(
      `SELECT winner_player_id AS w, loser_player_id AS l, score FROM matches
        WHERE tournament_id = ? AND stage = ? AND winner_player_id IN (${ids.map(() => '?').join(',')}) AND loser_player_id IN (${ids.map(() => '?').join(',')})`,
    ).all(tournamentId, `g:${group.id}`, ...ids, ...ids)
    : [];
  const cell = new Map(); // "a:b" → { won, score, sets, games } с точки зрения a
  for (const m of matches) {
    let parsed = null;
    try { parsed = parseScore(m.score); } catch { parsed = null; }
    const sets = parsed ? parsed.sets : [1, 0];
    const games = parsed ? parsed.games : [0, 0];
    cell.set(`${m.w}:${m.l}`, { won: true, score: m.score || '', sets, games });
    cell.set(`${m.l}:${m.w}`, { won: false, score: m.score || '', sets: [sets[1], sets[0]], games: [games[1], games[0]] });
  }
  const stats = members.map((p) => {
    let wins = 0; let played = 0; let setsFor = 0; let setsAgainst = 0; let gamesFor = 0; let gamesAgainst = 0;
    for (const q of members) {
      if (q.id === p.id) continue;
      const c = cell.get(`${p.id}:${q.id}`);
      if (!c) continue;
      played++; if (c.won) wins++;
      setsFor += c.sets[0]; setsAgainst += c.sets[1]; gamesFor += c.games[0]; gamesAgainst += c.games[1];
    }
    return { id: p.id, wins, played, setsDiff: setsFor - setsAgainst, gamesDiff: gamesFor - gamesAgainst };
  });
  const byId = new Map(stats.map((s) => [s.id, s]));
  const sorted = [...stats].sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    const h2h = cell.get(`${x.id}:${y.id}`);
    if (h2h) return h2h.won ? -1 : 1;
    if (y.setsDiff !== x.setsDiff) return y.setsDiff - x.setsDiff;
    return y.gamesDiff - x.gamesDiff;
  });
  const place = new Map(sorted.map((s, i) => [s.id, i + 1]));
  const total = members.length ? (members.length * (members.length - 1)) / 2 : 0;
  return {
    cells: Object.fromEntries(cell),
    stats: Object.fromEntries(stats.map((s) => [s.id, { ...s, place: place.get(s.id) }])),
    order: sorted.map((s) => s.id),
    playedTotal: matches.length,
    total,
    complete: members.length > 1 && matches.length === total,
    _byId: byId,
  };
}

/** Записать/заменить/удалить матч клетки (row против col) по счёту с точки зрения row. */
export function setCell(db, tournamentId, group, rowId, colId, rawScore) {
  if (rowId === colId) throw new ValidationError('Игрок не играет сам с собой');
  const del = db.prepare('DELETE FROM matches WHERE tournament_id = ? AND stage = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))');
  const parsed = parseScore(rawScore);
  return db.transaction(() => {
    del.run(tournamentId, `g:${group.id}`, rowId, colId, colId, rowId);
    if (!parsed) return { cleared: true };
    const w = parsed.rowWon ? rowId : colId; const l = parsed.rowWon ? colId : rowId;
    // Счёт хранится с точки зрения ПОБЕДИТЕЛЯ — так он читается в профилях и протоколе.
    // Переворот сета «6:7(5)» → «7:6(5)»: тай-брейк в скобках остаётся при сете.
    const flip = (set) => { const m = /^(\d{1,2})[:\-](\d{1,2})(\(\d+\))?$/.exec(set); return `${m[2]}:${m[1]}${m[3] || ''}`; };
    const score = parsed.score === 'w/o' ? 'w/o' : (parsed.rowWon ? parsed.score.replace(/-/g, ':') : parsed.score.split(' ').map(flip).join(' '));
    db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage) VALUES (?, ?, ?, ?, ?, ?)').run(tournamentId, w, l, score, group.kind, `g:${group.id}`);
    return { winner: w, loser: l, score };
  })();
}

/** Места группы → results (только если группа сыграна полностью). Существующие результаты этих игроков заменяются. */
export function writeGroupPlaces(db, tournamentId, group) {
  const t = groupTable(db, tournamentId, group);
  if (!t.complete) throw new ValidationError('Группа сыграна не полностью — места ещё не определены');
  db.transaction(() => {
    const del = db.prepare('DELETE FROM results WHERE tournament_id = ? AND player_id = ?');
    const ins = db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, ?)');
    t.order.forEach((id, i) => { del.run(tournamentId, id); ins.run(tournamentId, id, i + 1); });
  })();
  return t.order.length;
}
