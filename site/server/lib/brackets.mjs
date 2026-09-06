// ОЛИМПИЙКА (сетка, слой 2): 4/8/16/32. Раунд 0 — посев (size слотов), раунд r —
// size/2^r слотов; победитель пары (r, 2k) vs (r, 2k+1) занимает (r+1, k). Матч пишется
// в общую matches (счёт с точки зрения ВЕРХНЕГО игрока пары, победитель — по сетам).
// Места: победитель 1, финалист 2, проигравшие полуфинала 3, четвертьфинала 5, далее 9, 17.
import { ValidationError } from './validate.mjs';
import { parseScore, scoreFor } from './groups.mjs';

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
  const scoreOf = (w, l) => db.prepare('SELECT score FROM matches WHERE tournament_id = ? AND stage = ? AND winner_player_id = ? AND loser_player_id = ?').get(tournamentId, `b:${b.id}`, w, l)?.score ?? null;
  const rounds = [];
  const R = roundsOf(b.size);
  for (let r = 0; r < R; r++) {
    const pairs = [];
    const n = b.size / 2 ** r;
    for (let k = 0; k < n / 2; k++) {
      const a = at.get(`${r}:${2 * k}`) || null; const c = at.get(`${r}:${2 * k + 1}`) || null;
      const next = at.get(`${r + 1}:${k}`) || null;
      let score = null; let scoreRaw = null;
      if (next && a && c) { scoreRaw = scoreOf(next, next === a ? c : a); score = scoreFor(scoreRaw, true); }
      pairs.push({ k, a: a && names.get(a), b: c && names.get(c), aId: a, bId: c, winner: next, score, scoreRaw, bye: Boolean(next && (!a || !c)) });
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
    if (!parsed) throw new ValidationError('Введите счёт с точки зрения верхнего игрока («6:3 6:4», «неявка 2», «6:3 2:1 отказ 2») или «bye»');
    const w = parsed.rowWon ? a : c; const l = parsed.rowWon ? c : a;
    const score = parsed.score; // уже от победителя: «6:4 6:4», «неявка», «6:3 2:1 отк.»
    db.prepare('DELETE FROM matches WHERE tournament_id = ? AND stage = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))').run(tournamentId, `b:${b.id}`, a, c, c, a);
    db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage) VALUES (?, ?, ?, ?, ?, ?)').run(tournamentId, w, l, score, b.kind, `b:${b.id}`);
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
      if (opp) db.prepare('DELETE FROM matches WHERE tournament_id = ? AND stage = ? AND winner_player_id = ? AND loser_player_id = ?').run(tournamentId, `b:${b.id}`, w, opp);
    }
    db.prepare('DELETE FROM bracket_slots WHERE bracket_id = ? AND player_id = ? AND round > ?').run(b.id, w, r);
    if (a && c) db.prepare('DELETE FROM matches WHERE tournament_id = ? AND stage = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))').run(tournamentId, `b:${b.id}`, a, c, c, a);
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

// ---------------------------------------------------------------------------
// СЛОЙ 3: «группы + плей-офф». Посев сетки из мест в круговых группах.
import { listGroups } from './groups.mjs';

/** Стандартный порядок посева: seeds[i] = позиция (0-based) для сеяного №i+1. 1 и 2 — в разных половинах и т. д. */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    const next = [];
    for (const s of order) next.push(s, n + 1 - s);
    order = next;
  }
  // order[pos] = номер сеяного на позиции pos → инвертируем в pos по сеяному
  const pos = new Array(size);
  order.forEach((seedNo, p) => { pos[seedNo - 1] = p; });
  return pos;
}

/**
 * Посев из групп: по perGroup лучших из каждой сыгранной группы того же разряда.
 * Сеяные: все первые места (в порядке групп), затем все вторые — стандартный
 * посев сводит первого одной группы со вторым другой.
 */
export function seedFromGroups(db, tournamentId, bid, perGroup) {
  const b = bracketOf(db, tournamentId, bid);
  if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ?').get(b.id)) throw new ValidationError('Сетка уже посеяна — сначала удалите её слоты (или создайте новую сетку)');
  const groups = listGroups(db, tournamentId).filter((g) => g.kind === b.kind);
  if (!groups.length) throw new ValidationError('Нет круговых групп этого разряда');
  const notDone = groups.filter((g) => !g.complete);
  if (notDone.length) throw new ValidationError(`Не сыграны до конца группы: ${notDone.map((g) => g.name).join(', ')}`);
  if (!(perGroup >= 1)) throw new ValidationError('Сколько лучших из группы — от 1');
  const entrants = [];
  // Порядок групп одинаков для каждого места: со стандартным посевом (1 против
  // последнего сеяного и т. д.) это даёт пары «первый группы X — второй группы Y».
  for (let place = 0; place < perGroup; place++) {
    for (const g of groups) if (g.order[place]) entrants.push(g.order[place]);
  }
  if (entrants.length > b.size) throw new ValidationError(`Выходят ${entrants.length} игроков, а сетка на ${b.size}`);
  if (entrants.length < 2) throw new ValidationError('Слишком мало игроков для сетки');
  const pos = seedOrder(b.size);
  db.transaction(() => {
    entrants.forEach((pid, i) => db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, 0, ?, ?)').run(b.id, pos[i], pid));
  })();
  return { seeded: entrants.length, groups: groups.length };
}

/**
 * Места «группы + плей-офф»: игроки сетки — по сетке; не вышедшие из групп —
 * место size+1 (корзина следующая за сеткой, у 8 — 9-е), их результаты дописываются.
 */
export function placesWithGroups(db, tournamentId, bid) {
  const b = bracketOf(db, tournamentId, bid);
  const n = bracketPlaces(db, tournamentId, bid);
  const inBracket = new Set(db.prepare('SELECT DISTINCT player_id FROM bracket_slots WHERE bracket_id = ?').all(b.id).map((r) => r.player_id));
  const rest = [];
  for (const g of listGroups(db, tournamentId).filter((x) => x.kind === b.kind)) for (const pid of g.order) if (!inBracket.has(pid)) rest.push(pid);
  db.transaction(() => {
    const del = db.prepare('DELETE FROM results WHERE tournament_id = ? AND player_id = ?');
    const ins = db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, ?)');
    for (const pid of rest) { del.run(tournamentId, pid); ins.run(tournamentId, pid, b.size + 1); }
  })();
  return { bracket: n, rest: rest.length };
}

// ---------------------------------------------------------------------------
// ПОСЕВ ПО РЕЙТИНГУ (решение владельца 05.09.2026): участники — списком, порядок
// сеяных — по текущему снимку рейтинга того же разряда (место в таблице), без
// рейтинга — после, по фамилии. Дальше секретарь правит вручную: «×» у слота,
// «Посеять» на свободную позицию, «Поменять местами» две позиции.
import { currentStandings } from './rating-service.mjs';
import { resolvePlayer } from './registrations.mjs';

export function seedByRating(db, tournamentId, bid, rawList) {
  const b = bracketOf(db, tournamentId, bid);
  if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ?').get(b.id)) throw new ValidationError('Сетка уже посеяна — очистите слоты или создайте новую сетку');
  const items = String(rawList || '').split(/[\n;,]+/).map((s) => s.trim()).filter(Boolean);
  if (items.length < 2) throw new ValidationError('Нужно минимум два участника (по одному в строке)');
  if (items.length > b.size) throw new ValidationError(`Участников ${items.length}, а сетка на ${b.size}`);
  const ids = []; const missing = [];
  for (const it of items) {
    const id = resolvePlayer(db, it, { ValidationError });
    if (!id) missing.push(it); else if (!ids.includes(id)) ids.push(id);
  }
  if (missing.length) throw new ValidationError(`Не найдены в базе: ${missing.join('; ')} — заведите их или уточните «#номер»`);
  const standings = currentStandings(db);
  const table = standings ? (b.kind === 'double' ? standings.doubles : standings.players) : [];
  const rank = new Map(table.map((p) => [p.playerId, p.rank]));
  const names = new Map(db.prepare(`SELECT id, full_name FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((p) => [p.id, p.full_name]));
  const ordered = [...ids].sort((x, y) => {
    const rx = rank.get(x); const ry = rank.get(y);
    if (rx && ry) return rx - ry;
    if (rx) return -1;
    if (ry) return 1;
    return String(names.get(x)).localeCompare(String(names.get(y)), 'ru');
  });
  const pos = seedOrder(b.size);
  db.transaction(() => {
    ordered.forEach((pid, i) => db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, 0, ?, ?)').run(b.id, pos[i], pid));
  })();
  return { seeded: ordered.length, rated: ordered.filter((id) => rank.has(id)).length, unrated: ordered.filter((id) => !rank.has(id)).length };
}

/** Поменять местами две позиции посева (1..size); только пока ни один итог пары не записан. */
export function swapSeeds(db, tournamentId, bid, p1, p2) {
  const b = bracketOf(db, tournamentId, bid);
  if (!(p1 >= 1 && p1 <= b.size && p2 >= 1 && p2 <= b.size) || p1 === p2) throw new ValidationError('Укажите две разные позиции от 1 до ' + b.size);
  if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ? AND round > 0').get(b.id)) throw new ValidationError('Итоги пар уже записаны — сначала отмените их');
  const get = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = 0 AND position = ?');
  const a = get.get(b.id, p1 - 1)?.player_id || null; const c = get.get(b.id, p2 - 1)?.player_id || null;
  if (!a && !c) throw new ValidationError('Обе позиции пусты');
  db.transaction(() => {
    db.prepare('DELETE FROM bracket_slots WHERE bracket_id = ? AND round = 0 AND position IN (?, ?)').run(b.id, p1 - 1, p2 - 1);
    if (c) db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, 0, ?, ?)').run(b.id, p1 - 1, c);
    if (a) db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, 0, ?, ?)').run(b.id, p2 - 1, a);
  })();
}
