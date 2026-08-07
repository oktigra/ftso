// Рейтинговый движок Федерации тенниса Смоленской области.
// Чистый JavaScript, ES-модуль, без зависимостей. Чистые функции над данными в памяти.
//
// Спорные бизнес-числа живут в КОНФИГЕ (данные), не в коде.

export const DEFAULT_CONFIG = {
  pointsByPlace: [
    // отсортирован по maxPlace ПО ВОЗРАСТАНИЮ
    { maxPlace: 1, points: 100 },
    { maxPlace: 2, points: 70 },
    { maxPlace: 4, points: 45 }, // 3-е и 4-е -> 45 (одно на группу)
    { maxPlace: 8, points: 25 }, // 5-8 -> 25
    { maxPlace: 16, points: 10 }, // 9-16 -> 10
  ],
  pointsBeyondTable: 0, // место больше последнего maxPlace
  categoryCoef: { A: 2, B: 1 },
  countBest: 6, // сколько лучших турниров в зачёт
  windowDays: 364, // 52 недели
  ratingStatus: 'preliminary', // вручную: "preliminary" первый год, потом "final"
};

const MS_PER_DAY = 86400000;

function fail(message) {
  throw new Error(`[rating] ${message}`);
}

// ---------------------------------------------------------------------------
// Даты. Разбор явный: Date.UTC принимает ЧИСЛА, а не строку.
// ---------------------------------------------------------------------------

/** Полночь UTC для даты "YYYY-MM-DD". Никакого локального времени. */
export function dayUTC(s, where = 'дата') {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    fail(`${where}: ожидалась строка "YYYY-MM-DD", получено ${JSON.stringify(s)}`);
  }
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    fail(`${where}: несуществующая дата ${s}`);
  }
  return t;
}

/** Сегодняшняя дата по UTC — "YYYY-MM-DD". НЕ локальная. */
export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/** Целое число дней между датами (asOf − endDate). */
export function diffDays(endDate, asOf) {
  return (dayUTC(asOf, 'asOf') - dayUTC(endDate, 'endDate')) / MS_PER_DAY;
}

/** В окне, если 0 <= diffDays < windowDays. Будущая дата -> diff < 0 -> не в окне. */
export function isInWindow(endDate, asOf, windowDays) {
  const d = diffDays(endDate, asOf);
  return d >= 0 && d < windowDays;
}

// ---------------------------------------------------------------------------
// Очки
// ---------------------------------------------------------------------------

/**
 * Очки первой записи, у которой maxPlace >= place.
 * Нет такой записи -> pointsBeyondTable. Покрывает и «дырявые» интервалы.
 */
export function pointsForPlace(place, config) {
  for (const row of config.pointsByPlace) {
    if (row.maxPlace >= place) return row.points;
  }
  return config.pointsBeyondTable;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v >= 1;
}

function validateConfig(config) {
  if (!Array.isArray(config.pointsByPlace) || config.pointsByPlace.length === 0) {
    fail('config.pointsByPlace: ожидался непустой массив');
  }
  let prev = 0;
  for (const row of config.pointsByPlace) {
    if (!row || !isPositiveInt(row.maxPlace) || typeof row.points !== 'number') {
      fail(`config.pointsByPlace: битая запись ${JSON.stringify(row)} (нужны целое maxPlace >= 1 и число points)`);
    }
    if (row.maxPlace <= prev) {
      fail(`config.pointsByPlace должен быть отсортирован по maxPlace по возрастанию; ${row.maxPlace} идёт после ${prev}`);
    }
    prev = row.maxPlace;
  }
  if (typeof config.pointsBeyondTable !== 'number') fail('config.pointsBeyondTable: ожидалось число');
  if (!config.categoryCoef || typeof config.categoryCoef !== 'object') fail('config.categoryCoef: ожидался объект');
  if (!isPositiveInt(config.countBest)) fail('config.countBest: ожидалось целое >= 1');
  if (!isPositiveInt(config.windowDays)) fail('config.windowDays: ожидалось целое >= 1');
  if (typeof config.ratingStatus !== 'string') fail('config.ratingStatus: ожидалась строка');
}

// ---------------------------------------------------------------------------
// Тай-брейк: каскад ступеней на ГРУППЕ равных по очкам.
// Каждая ступень — отдельная запись в списке TIEBREAK_STAGES; докрутить или
// переставить — правка списка.
// ---------------------------------------------------------------------------

/** Разбить блок компаратором на подблоки равных. */
function splitByComparator(block, cmp) {
  const sorted = [...block].sort(cmp);
  const out = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (cmp(sorted[i - 1], sorted[i]) === 0) cur.push(sorted[i]);
    else {
      out.push(cur);
      cur = [sorted[i]];
    }
  }
  out.push(cur);
  return out;
}

/**
 * Ступень 1 — личные встречи, рекурсивно.
 * Победы считаются ТОЛЬКО среди членов текущей подгруппы и в подгруппе
 * ПЕРЕСЧИТЫВАЮТСЯ с нуля (не наследуются из исходной группы).
 */
function splitHeadToHead(block, matchesInWindow) {
  const ids = new Set(block.map((p) => p.playerId));
  const wins = new Map(block.map((p) => [p.playerId, 0]));
  for (const m of matchesInWindow) {
    if (ids.has(m.winnerPlayerId) && ids.has(m.loserPlayerId)) {
      wins.set(m.winnerPlayerId, wins.get(m.winnerPlayerId) + 1);
    }
  }
  const levels = [...new Set(wins.values())].sort((a, b) => b - a);
  if (levels.length <= 1) return [block]; // не делит: настоящий цикл или матчей нет
  const out = [];
  for (const w of levels) {
    const bucket = block.filter((p) => wins.get(p.playerId) === w);
    if (bucket.length === 1) out.push(bucket);
    else out.push(...splitHeadToHead(bucket, matchesInWindow)); // рекурсия-пересчёт
  }
  return out;
}

/**
 * Ступень 2 — места на турнирах: только по ЗАЧЁТНЫМ (counted), позиция за
 * позицией по ОЧКАМ за турнир (не по сырому месту). Недостающая позиция = 0.
 */
function compareCountedPoints(a, b) {
  const n = Math.max(a.counted.length, b.counted.length);
  for (let i = 0; i < n; i++) {
    const pa = a.counted[i] ? a.counted[i].points : 0;
    const pb = b.counted[i] ? b.counted[i].points : 0;
    if (pa !== pb) return pb - pa;
  }
  return 0;
}

/** Ступень 3 — количество сыгранных турниров в окне. */
function compareTotalInWindow(a, b) {
  return b.totalInWindow - a.totalInWindow;
}

export const TIEBREAK_STAGES = [
  {
    name: 'ст.1 личные встречи',
    split: (block, ctx) =>
      ctx.matchesInWindow.length === 0 ? [block] : splitHeadToHead(block, ctx.matchesInWindow),
  },
  {
    name: 'ст.2 места на турнирах',
    split: (block) => splitByComparator(block, compareCountedPoints),
  },
  {
    name: 'ст.3 сыграно турниров',
    split: (block) => splitByComparator(block, compareTotalInWindow),
  },
  // ст.4 — всё, что осталось блоком, делит место (shared rank)
];

function resolveGroup(group, ctx) {
  let blocks = [group];
  for (const stage of TIEBREAK_STAGES) {
    const next = [];
    for (const block of blocks) {
      if (block.length > 1) next.push(...stage.split(block, ctx));
      else next.push(block);
    }
    blocks = next;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Основной расчёт
// ---------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {Array}  input.tournaments [{ id, name, endDate, category }]
 * @param {Array}  input.results     [{ playerId, playerName, tournamentId, place }]
 * @param {Array}  [input.matches]   [{ tournamentId, winnerPlayerId, loserPlayerId }]
 * @param {string} [input.asOf]      "YYYY-MM-DD", по умолчанию сегодня по UTC
 * @param {object} [input.config]
 * @returns {{ ratingStatus: string, asOf: string, players: Array, warnings: string[] }}
 */
export function computeStandings(input = {}) {
  const {
    tournaments = [],
    results = [],
    matches = [],
    asOf = todayUTC(),
    config: configIn,
  } = input;

  const config = { ...DEFAULT_CONFIG, ...(configIn || {}) };
  validateConfig(config);
  if (!Array.isArray(tournaments)) fail('tournaments: ожидался массив');
  if (!Array.isArray(results)) fail('results: ожидался массив');
  if (!Array.isArray(matches)) fail('matches: ожидался массив');
  dayUTC(asOf, 'asOf');

  const warnings = [];

  // --- турниры ------------------------------------------------------------
  const tournamentById = new Map();
  for (const t of tournaments) {
    if (!t || t.id === undefined || t.id === null) fail(`турнир без id: ${JSON.stringify(t)}`);
    if (tournamentById.has(t.id)) fail(`турнир ${t.id} встречается в tournaments дважды`);
    if (!Object.prototype.hasOwnProperty.call(config.categoryCoef, t.category)) {
      fail(
        `турнир ${t.id}: неизвестная категория ${JSON.stringify(t.category)}; ` +
          `в config.categoryCoef есть только ${Object.keys(config.categoryCoef).join(', ')}`,
      );
    }
    dayUTC(t.endDate, `турнир ${t.id}, endDate`);
    tournamentById.set(t.id, t);
  }

  const inWindow = new Map(); // tournamentId -> boolean
  for (const [id, t] of tournamentById) {
    inWindow.set(id, isInWindow(t.endDate, asOf, config.windowDays));
  }

  // --- результаты ---------------------------------------------------------
  const seenPair = new Set();
  const nameByPlayer = new Map();
  const entriesByPlayer = new Map(); // playerId -> [ {tournamentId, name, category, place, points} ]

  for (const r of results) {
    if (!r || r.playerId === undefined || r.playerId === null) {
      fail(`результат без playerId: ${JSON.stringify(r)}`);
    }
    const t = tournamentById.get(r.tournamentId);
    if (!t) {
      fail(
        `висячая ссылка в results: турнира ${JSON.stringify(r.tournamentId)} нет в tournaments ` +
          `(игрок ${r.playerId})`,
      );
    }
    if (!isPositiveInt(r.place)) {
      fail(
        `результат игрока ${r.playerId} в турнире ${r.tournamentId}: place должно быть целым >= 1, ` +
          `получено ${JSON.stringify(r.place)}`,
      );
    }
    const pairKey = `${r.playerId} ${r.tournamentId}`;
    if (seenPair.has(pairKey)) {
      fail(`дубль результата: игрок ${r.playerId} встречается в турнире ${r.tournamentId} дважды`);
    }
    seenPair.add(pairKey);

    if (!nameByPlayer.has(r.playerId)) {
      nameByPlayer.set(r.playerId, r.playerName === undefined ? String(r.playerId) : r.playerName);
    } else if (r.playerName !== undefined && nameByPlayer.get(r.playerId) !== r.playerName) {
      const w =
        `ПРЕДУПРЕЖДЕНИЕ: у playerId ${r.playerId} разные имена ` +
        `("${nameByPlayer.get(r.playerId)}" и "${r.playerName}"); взято первое встреченное`;
      if (!warnings.includes(w)) {
        warnings.push(w);
        console.warn(w);
      }
    }

    if (!inWindow.get(r.tournamentId)) continue; // вне окна — в зачёт не идёт

    const points = pointsForPlace(r.place, config) * config.categoryCoef[t.category];
    if (!entriesByPlayer.has(r.playerId)) entriesByPlayer.set(r.playerId, []);
    entriesByPlayer.get(r.playerId).push({
      tournamentId: t.id,
      name: t.name,
      category: t.category,
      place: r.place,
      points,
    });
  }

  // --- матчи --------------------------------------------------------------
  for (const m of matches) {
    if (!m) fail(`пустая запись в matches`);
    if (!tournamentById.has(m.tournamentId)) {
      fail(`висячая ссылка в matches: турнира ${JSON.stringify(m.tournamentId)} нет в tournaments`);
    }
    if (m.winnerPlayerId === undefined || m.loserPlayerId === undefined) {
      fail(`матч в турнире ${m.tournamentId}: нужны winnerPlayerId и loserPlayerId`);
    }
    if (m.winnerPlayerId === m.loserPlayerId) {
      fail(`матч в турнире ${m.tournamentId}: winnerPlayerId и loserPlayerId совпадают`);
    }
  }
  // Матч учитывается, если endDate его турнира в окне — и ВСЁ.
  const matchesInWindow = matches.filter((m) => inWindow.get(m.tournamentId));

  // --- игроки -------------------------------------------------------------
  const players = [];
  for (const [playerId, entries] of entriesByPlayer) {
    // очки по убыванию; дальше — стабильно и детерминированно
    entries.sort(
      (a, b) =>
        b.points - a.points ||
        a.place - b.place ||
        String(a.tournamentId).localeCompare(String(b.tournamentId)),
    );
    const counted = entries.slice(0, config.countBest);
    players.push({
      playerId,
      playerName: nameByPlayer.get(playerId),
      ratingPoints: counted.reduce((s, e) => s + e.points, 0),
      counted,
      totalInWindow: entries.length,
    });
  }

  // --- ранжирование -------------------------------------------------------
  const ctx = { matchesInWindow };
  const byPoints = new Map();
  for (const p of players) {
    if (!byPoints.has(p.ratingPoints)) byPoints.set(p.ratingPoints, []);
    byPoints.get(p.ratingPoints).push(p);
  }
  const ordered = [];
  for (const points of [...byPoints.keys()].sort((a, b) => b - a)) {
    const group = byPoints.get(points);
    const blocks = group.length > 1 ? resolveGroup(group, ctx) : [group];
    for (const block of blocks) ordered.push(block);
  }

  const out = [];
  let rank = 1;
  for (const block of ordered) {
    for (const p of block) {
      out.push({
        rank,
        playerId: p.playerId,
        playerName: p.playerName,
        ratingPoints: p.ratingPoints,
        counted: p.counted,
        totalInWindow: p.totalInWindow,
      });
    }
    rank += block.length; // делящие место получают один ранг, следующий блок его перешагивает
  }

  return { ratingStatus: config.ratingStatus, asOf, players: out, warnings };
}

/**
 * Тот же расчёт внутри каждой возрастной группы.
 * @param {Array} input.players [{ playerId, ageGroup }]
 * @returns {{ ratingStatus, asOf, groups: [{ ageGroup, players }], warnings }}
 */
export function computeStandingsByAgeGroup(input = {}) {
  const roster = input.players || [];
  if (!Array.isArray(roster)) fail('players: ожидался массив');
  const groupOf = new Map();
  for (const p of roster) {
    if (!p || p.playerId === undefined || p.playerId === null) {
      fail(`запись players без playerId: ${JSON.stringify(p)}`);
    }
    if (groupOf.has(p.playerId)) fail(`игрок ${p.playerId} встречается в players дважды`);
    groupOf.set(p.playerId, p.ageGroup === undefined ? null : p.ageGroup);
  }

  const keys = [];
  for (const r of input.results || []) {
    const g = groupOf.has(r.playerId) ? groupOf.get(r.playerId) : null;
    if (!keys.includes(g)) keys.push(g);
  }
  keys.sort((a, b) => String(a).localeCompare(String(b)));

  const warnings = [];
  const groups = [];
  let ratingStatus = null;
  let asOf = null;
  for (const key of keys) {
    const results = (input.results || []).filter(
      (r) => (groupOf.has(r.playerId) ? groupOf.get(r.playerId) : null) === key,
    );
    const st = computeStandings({ ...input, results });
    ratingStatus = st.ratingStatus;
    asOf = st.asOf;
    for (const w of st.warnings) if (!warnings.includes(w)) warnings.push(w);
    groups.push({ ageGroup: key, players: st.players });
  }
  return { ratingStatus, asOf, groups, warnings };
}
