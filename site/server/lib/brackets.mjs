// ОЛИМПИЙКА (сетка, слой 2): 4/8/16/32. Раунд 0 — посев (size слотов), раунд r —
// size/2^r слотов; победитель пары (r, 2k) vs (r, 2k+1) занимает (r+1, k). Матч пишется
// в общую matches (счёт с точки зрения ВЕРХНЕГО игрока пары, победитель — по сетам).
// Места: победитель 1, финалист 2, проигравшие полуфинала 3, четвертьфинала 5, далее 9, 17.
import { ValidationError } from './validate.mjs';
import { parseScore } from './groups.mjs';

export const BRACKET_SIZES = [4, 8, 16, 32];
export const roundsOf = (size) => Math.log2(size);
export function roundName(size, r) {
  const left = size / 2 ** r; // участников в раунде
  if (left === 2) return 'Финал';
  if (left === 4) return '1/2 финала';
  if (left === 8) return '1/4 финала';
  return `1/${left / 2} финала`;
}

export function listBrackets(db, tournamentId) {
  return db.prepare('SELECT id, name, kind, size FROM tournament_brackets WHERE tournament_id = ? ORDER BY id').all(tournamentId)
    .map((b) => ({ ...b, ...bracketView(db, tournamentId, b) }));
}

export function bracketView(db, tournamentId, b) {
  const slots = db.prepare('SELECT round, position, player_id FROM bracket_slots WHERE bracket_id = ?').all(b.id);
  const at = new Map(slots.map((s) => [`${s.round}:${s.position}`, s.player_id]));
  const ids = [...new Set(slots.map((s) => s.player_id))];
  const names = new Map(ids.length ? db.prepare(`SELECT id, full_name, city FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((p) => [p.id, p]) : []);
  const scoreOf = (w, l) => db.prepare('SELECT score FROM matches WHERE tournament_id = ? AND kind = ? AND winner_player_id = ? AND loser_player_id = ?').get(tournamentId, b.kind, w, l)?.score ?? null;
  const rounds = [];
  const R = roundsOf(b.size);
  for (let r = 0; r < R; r++) {
    const pairs = [];
    const n = b.size / 2 ** r;
    for (let k = 0; k < n / 2; k++) {
      const a = at.get(`${r}:${2 * k}`) || null; const c = at.get(`${r}:${2 * k + 1}`) || null;
      const next = at.get(`${r + 1}:${k}`) || null;
      let score = null;
      if (next && a && c) score = scoreOf(next, next === a ? c : a);
      pairs.push({ k, a: a && names.get(a), b: c && names.get(c), aId: a, bId: c, winner: next, score, bye: Boolean(next && (!a || !c)) });
    }
    rounds.push({ r, name: roundName(b.size, r), pairs });
  }
  const champion = at.get(`${R}:0`) || null;
  return { rounds, champion: champion ? names.get(champion) : null, championId: champion, filled: slots.filter((s) => s.round === 0).length };
}

const bracketOf = (db, tournamentId, bid) => {
  const b = db.prepare('SELECT id, name, kind, size FROM tournament_brackets WHERE id = ? AND tournament_id = ?').get(bid, tournamentId);
  if (!b) throw new ValidationError('Сетка не найдена');
  return b;
};

/** Посев: игрок в слот раунда 0 (позиция 1..size). Занятый слот — ошибка; тот же игрок дважды — ошибка. */
export function seed(db, tournamentId, bid, position, playerId) {
  const b = bracketOf(db, tournamentId, bid);
  if (!(position >= 1 && position <= b.size)) throw new ValidationError(`Позиция должна быть от 1 до ${b.size}`);
  if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ? AND player_id = ?').get(b.id, playerId)) throw new ValidationError('Этот игрок уже в сетке');
  if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ? AND round = 0 AND position = ?').get(b.id, position - 1)) throw new ValidationError(`Позиция ${position} уже занята`);
  db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, 0, ?, ?)').run(b.id, position - 1, playerId);
  return b;
}

export function unseed(db, tournamentId, bid, position) {
  const b = bracketOf(db, tournamentId, bid);
  const pid = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = 0 AND position = ?').get(b.id, position - 1)?.player_id;
  if (!pid) throw new ValidationError('Слот пуст');
  if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ? AND round > 0 AND player_id = ?').get(b.id, pid)) throw new ValidationError('Игрок уже прошёл дальше — сначала очистите его матчи');
  db.prepare('DELETE FROM bracket_slots WHERE bracket_id = ? AND round = 0 AND position = ?').run(b.id, position - 1);
  return b;
}

/** Итог пары (round r, pair k): счёт с точки зрения верхнего игрока; «bye» — единственный игрок пары проходит. */
export function decide(db, tournamentId, bid, r, k, rawScore) {
  const b = bracketOf(db, tournamentId, bid);
  const R = roundsOf(b.size);
  if (!(r >= 0 && r < R)) throw new ValidationError('Неверный раунд');
  const a = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(b.id, r, 2 * k)?.player_id || null;
  const c = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(b.id, r, 2 * k + 1)?.player_id || null;
  if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(b.id, r + 1, k)) throw new ValidationError('Итог этой пары уже записан — сначала отмените его');
  const s = String(rawScore || '').trim();
  return db.transaction(() => {
    if (/^bye$/i.test(s)) {
      if (a && c) throw new ValidationError('В паре двое — нужен счёт');
      const who = a || c;
      if (!who) throw new ValidationError('Пара пуста');
      db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, ?, ?, ?)').run(b.id, r + 1, k, who);
      return { winner: who, bye: true };
    }
    if (!a || !c) throw new ValidationError('В паре не хватает игрока: посейте второго или отметьте «bye»');
    const parsed = parseScore(s);
    if (!parsed) throw new ValidationError('Введите счёт с точки зрения верхнего игрока («6:3 6:4», «wo», «-wo») или «bye»');
    const w = parsed.rowWon ? a : c; const l = parsed.rowWon ? c : a;
    const flip = (set) => { const m = /^(\d{1,2})[:\-](\d{1,2})(\(\d+\))?$/.exec(set); return `${m[2]}:${m[1]}${m[3] || ''}`; };
    const score = parsed.score === 'w/o' ? 'w/o' : (parsed.rowWon ? parsed.score.replace(/-/g, ':') : parsed.score.split(' ').map(flip).join(' '));
    db.prepare('DELETE FROM matches WHERE tournament_id = ? AND kind = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))').run(tournamentId, b.kind, a, c, c, a);
    db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind) VALUES (?, ?, ?, ?, ?)').run(tournamentId, w, l, score, b.kind);
    db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, ?, ?, ?)').run(b.id, r + 1, k, w);
    return { winner: w, loser: l, score };
  })();
}

/** Отмена итога пары: убирает победителя из следующего слота (и всё, куда он прошёл дальше) и его матч этой пары. */
export function undo(db, tournamentId, bid, r, k) {
  const b = bracketOf(db, tournamentId, bid);
  const w = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(b.id, r + 1, k)?.player_id;
  if (!w) throw new ValidationError('Итог пары не записан');
  const a = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(b.id, r, 2 * k)?.player_id;
  const c = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(b.id, r, 2 * k + 1)?.player_id;
  db.transaction(() => {
    // Все продвижения победителя дальше этого раунда — снимаются вместе с матчами тех пар.
    const later = db.prepare('SELECT round, position FROM bracket_slots WHERE bracket_id = ? AND player_id = ? AND round > ?').all(b.id, w, r);
    for (const s of later) {
      const prevRound = s.round - 1; const pk = s.position;
      const opp = [2 * pk, 2 * pk + 1].map((pos) => db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(b.id, prevRound, pos)?.player_id).find((p) => p && p !== w);
      if (opp) db.prepare('DELETE FROM matches WHERE tournament_id = ? AND kind = ? AND winner_player_id = ? AND loser_player_id = ?').run(tournamentId, b.kind, w, opp);
    }
    db.prepare('DELETE FROM bracket_slots WHERE bracket_id = ? AND player_id = ? AND round > ?').run(b.id, w, r);
    if (a && c) db.prepare('DELETE FROM matches WHERE tournament_id = ? AND kind = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))').run(tournamentId, b.kind, a, c, c, a);
  })();
}

/** Места по сетке: 1 — чемпион, 2 — финалист, 3 — проигравшие 1/2, 5 — 1/4, 9 — 1/8, 17 — 1/16. Только при сыгранном финале. */
export function bracketPlaces(db, tournamentId, bid) {
  const b = bracketOf(db, tournamentId, bid);
  const R = roundsOf(b.size);
  const champion = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = 0').get(b.id, R)?.player_id;
  if (!champion) throw new ValidationError('Финал ещё не сыгран');
  const rows = db.prepare('SELECT round, player_id FROM bracket_slots WHERE bracket_id = ?').all(b.id);
  const maxRound = new Map();
  for (const s of rows) maxRound.set(s.player_id, Math.max(maxRound.get(s.player_id) ?? -1, s.round));
  const places = [];
  for (const [pid, mr] of maxRound) {
    if (pid === champion) { places.push([pid, 1]); continue; }
    // выбыл в раунде mr: mr = R-1 → финалист (2); R-2 → 3; R-3 → 5; …
    const lost = R - 1 - mr; // 0 — финал
    places.push([pid, lost === 0 ? 2 : 2 ** lost + 1]);
  }
  db.transaction(() => {
    const del = db.prepare('DELETE FROM results WHERE tournament_id = ? AND player_id = ?');
    const ins = db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, ?)');
    for (const [pid, place] of places) { del.run(tournamentId, pid); ins.run(tournamentId, pid, place); }
  })();
  return places.length;
}
