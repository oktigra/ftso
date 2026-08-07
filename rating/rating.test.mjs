// Тестовый харнесс рейтингового движка ФТСО.
// Выдуманные данные + посчитанный вручную ожидаемый результат.
// Запуск: node rating/rating.test.mjs

import {
  computeStandings,
  computeStandingsByAgeGroup,
  dayUTC,
  diffDays,
  isInWindow,
  pointsForPlace,
  DEFAULT_CONFIG,
} from './rating.mjs';
import { printStandings } from './export.mjs';

// ---------------------------------------------------------------------------
// Микро-фреймворк проверок
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures.push({ label, message: e.message });
    console.log(`  ❌ ${label}\n     ${e.message}`);
  }
}

function eq(actual, expected, what = 'значение') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: ожидалось ${b}, получено ${a}`);
}

function throwsWith(fn, substr) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`ожидалось падение с "${substr}", но движок не упал`);
  if (!String(err.message).includes(substr)) {
    throw new Error(`ожидалось падение с "${substr}", получено: ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Данные-заготовки
// ---------------------------------------------------------------------------
const ASOF = '2026-01-01';
const DAY = 86400000;

/** Дата на n дней раньше ASOF (n<0 — будущее). */
function back(n) {
  return new Date(dayUTC(ASOF) - n * DAY).toISOString().slice(0, 10);
}

// место, дающее нужные очки в категории B при конфиге по умолчанию
const PLACE_BY_POINTS = new Map([
  [100, 1],
  [70, 2],
  [45, 3],
  [25, 5],
  [10, 9],
  [0, 20], // место больше последнего maxPlace -> pointsBeyondTable (0)
]);

/** Игрок с заданным профилем очков: по турниру на каждое значение. */
function profile(playerId, pointsList) {
  const tournaments = [];
  const results = [];
  pointsList.forEach((pts, i) => {
    const id = `${playerId}-t${i + 1}`;
    tournaments.push({ id, name: `Турнир ${id}`, endDate: back(10 + i), category: 'B' });
    results.push({
      playerId,
      playerName: `Игрок ${playerId}`,
      tournamentId: id,
      place: PLACE_BY_POINTS.get(pts),
    });
  });
  return { tournaments, results };
}

function merge(...parts) {
  return {
    tournaments: parts.flatMap((p) => p.tournaments || []),
    results: parts.flatMap((p) => p.results || []),
  };
}

/** Турнир-площадка для матчей: сам по себе очков никому не даёт. */
function arena(id, daysAgo = 5) {
  return {
    tournaments: [{ id, name: `Площадка ${id}`, endDate: back(daysAgo), category: 'B' }],
    results: [],
  };
}

const order = (st) => st.players.map((p) => p.playerId);
const ranks = (st) => st.players.map((p) => p.rank);

// ===========================================================================
section('Очки, окно, конфиг');
// ===========================================================================

check('игрок с 7 турнирами: в зачёт только 6 лучших', () => {
  const data = profile('P1', [100, 100, 70, 70, 45, 25, 10]);
  const st = computeStandings({ ...data, asOf: ASOF });
  const p = st.players[0];
  eq(p.ratingPoints, 410, 'сумма 100+100+70+70+45+25'); // 10 отброшено
  eq(p.counted.length, 6, 'длина counted');
  eq(p.totalInWindow, 7, 'totalInWindow');
  eq(
    p.counted.map((c) => c.points),
    [100, 100, 70, 70, 45, 25],
    'зачётные очки',
  );
});

check('разбор даты: dayUTC даёт целые дни, не NaN', () => {
  const d = dayUTC('2025-01-15');
  if (!Number.isFinite(d)) throw new Error(`dayUTC вернул ${d}`);
  eq(d % DAY, 0, 'полночь UTC');
  eq(diffDays('2025-01-15', '2025-01-16'), 1, 'разница в днях');
  eq(diffDays('2025-01-15', '2026-01-15'), 365, 'год = 365 дней');
  throwsWith(() => dayUTC('15.01.2025'), 'YYYY-MM-DD');
});

check('окно: endDate == asOf -> в окне', () => {
  eq(isInWindow(ASOF, ASOF, 364), true);
});

check('окно: ровно windowDays назад -> НЕ в окне, на день позже -> в окне', () => {
  eq(diffDays(back(364), ASOF), 364, 'сдвиг');
  eq(isInWindow(back(364), ASOF, 364), false, '364 дня назад');
  eq(isInWindow(back(363), ASOF, 364), true, '363 дня назад');
});

check('окно: будущая дата -> не в окне', () => {
  eq(isInWindow(back(-1), ASOF, 364), false);
});

check('окно: турнир 364 дня назад выпадает из расчёта', () => {
  const t = [{ id: 'old', name: 'Старый', endDate: back(364), category: 'B' }];
  const r = [{ playerId: 'P1', playerName: 'П', tournamentId: 'old', place: 1 }];
  const st = computeStandings({ tournaments: t, results: r, asOf: ASOF });
  eq(st.players.length, 0, 'игроков в рейтинге');
});

check('windowDays из конфига: 365 -> турнир 364 дня назад В окне', () => {
  const t = [{ id: 'old', name: 'Старый', endDate: back(364), category: 'B' }];
  const r = [{ playerId: 'P1', playerName: 'П', tournamentId: 'old', place: 1 }];
  const st = computeStandings({
    tournaments: t,
    results: r,
    asOf: ASOF,
    config: { ...DEFAULT_CONFIG, windowDays: 365 },
  });
  eq(st.players.length, 1, 'игроков в рейтинге');
  eq(st.players[0].ratingPoints, 100, 'очки');
});

check('ratingStatus прокидывается: "preliminary" по умолчанию, "final" из конфига', () => {
  const data = profile('P1', [100]);
  eq(computeStandings({ ...data, asOf: ASOF }).ratingStatus, 'preliminary');
  const st = computeStandings({
    ...data,
    asOf: ASOF,
    config: { ...DEFAULT_CONFIG, ratingStatus: 'final' },
  });
  eq(st.ratingStatus, 'final');
});

check('«дырявый» конфиг (maxPlace 3 и 8): место 4 берёт запись maxPlace 8', () => {
  const cfg = {
    ...DEFAULT_CONFIG,
    pointsByPlace: [
      { maxPlace: 3, points: 50 },
      { maxPlace: 8, points: 20 },
    ],
  };
  eq(pointsForPlace(3, cfg), 50, 'место 3');
  eq(pointsForPlace(4, cfg), 20, 'место 4');
  eq(pointsForPlace(9, cfg), 0, 'место 9 -> pointsBeyondTable');
  const t = [{ id: 't1', name: 'Т', endDate: back(5), category: 'B' }];
  const r = [{ playerId: 'P1', playerName: 'П', tournamentId: 't1', place: 4 }];
  eq(computeStandings({ tournaments: t, results: r, asOf: ASOF, config: cfg }).players[0].ratingPoints, 20);
});

check('place не целое или < 1 -> движок ПАДАЕТ', () => {
  const t = [{ id: 't1', name: 'Т', endDate: back(5), category: 'B' }];
  const mk = (place) => () =>
    computeStandings({
      tournaments: t,
      results: [{ playerId: 'P1', playerName: 'П', tournamentId: 't1', place }],
      asOf: ASOF,
    });
  throwsWith(mk(1.5), 'place должно быть целым >= 1');
  throwsWith(mk(0), 'place должно быть целым >= 1');
  throwsWith(mk(-3), 'place должно быть целым >= 1');
  throwsWith(mk('1'), 'place должно быть целым >= 1');
});

check('place больше последнего maxPlace -> pointsBeyondTable, не падение', () => {
  const t = [{ id: 't1', name: 'Т', endDate: back(5), category: 'B' }];
  const r = [{ playerId: 'P1', playerName: 'П', tournamentId: 't1', place: 33 }];
  eq(computeStandings({ tournaments: t, results: r, asOf: ASOF }).players[0].ratingPoints, 0, 'по умолчанию 0');
  const st = computeStandings({
    tournaments: t,
    results: r,
    asOf: ASOF,
    config: { ...DEFAULT_CONFIG, pointsBeyondTable: 5 },
  });
  eq(st.players[0].ratingPoints, 5, 'pointsBeyondTable = 5');
});

check('висячая ссылка в results -> движок ПАДАЕТ', () => {
  throwsWith(
    () =>
      computeStandings({
        tournaments: [{ id: 't1', name: 'Т', endDate: back(5), category: 'B' }],
        results: [{ playerId: 'P1', playerName: 'П', tournamentId: 'НЕТ', place: 1 }],
        asOf: ASOF,
      }),
    'висячая ссылка в results',
  );
});

check('висячая ссылка в matches -> движок ПАДАЕТ', () => {
  throwsWith(
    () =>
      computeStandings({
        tournaments: [{ id: 't1', name: 'Т', endDate: back(5), category: 'B' }],
        results: [{ playerId: 'P1', playerName: 'П', tournamentId: 't1', place: 1 }],
        matches: [{ tournamentId: 'НЕТ', winnerPlayerId: 'P1', loserPlayerId: 'P2' }],
        asOf: ASOF,
      }),
    'висячая ссылка в matches',
  );
});

check('дубль результата (игрок + турнир) -> движок ПАДАЕТ', () => {
  throwsWith(
    () =>
      computeStandings({
        tournaments: [{ id: 't1', name: 'Т', endDate: back(5), category: 'B' }],
        results: [
          { playerId: 'P1', playerName: 'П', tournamentId: 't1', place: 1 },
          { playerId: 'P1', playerName: 'П', tournamentId: 't1', place: 3 },
        ],
        asOf: ASOF,
      }),
    'дубль результата',
  );
});

check('категория A даёт вдвое больше B; 3-е и 4-е дают одинаково', () => {
  const tournaments = [
    { id: 'a1', name: 'Чемпионат области', endDate: back(5), category: 'A' },
    { id: 'b1', name: 'Кубок клуба', endDate: back(6), category: 'B' },
  ];
  const results = [
    { playerId: 'PA', playerName: 'А', tournamentId: 'a1', place: 1 },
    { playerId: 'PB', playerName: 'Б', tournamentId: 'b1', place: 1 },
    { playerId: 'P3', playerName: 'Третий', tournamentId: 'b1', place: 3 },
    { playerId: 'P4', playerName: 'Четвёртый', tournamentId: 'b1', place: 4 },
  ];
  const st = computeStandings({ tournaments, results, asOf: ASOF });
  const pts = Object.fromEntries(st.players.map((p) => [p.playerId, p.ratingPoints]));
  eq(pts.PA, 200, 'категория A, место 1');
  eq(pts.PB, 100, 'категория B, место 1');
  eq(pts.P3, 45, 'место 3');
  eq(pts.P4, 45, 'место 4');
});

check('разные имена у одного playerId -> ПРЕДУПРЕЖДЕНИЕ, берём первое', () => {
  const tournaments = [
    { id: 't1', name: 'Т1', endDate: back(5), category: 'B' },
    { id: 't2', name: 'Т2', endDate: back(6), category: 'B' },
  ];
  const results = [
    { playerId: 'P1', playerName: 'Иванов И.', tournamentId: 't1', place: 1 },
    { playerId: 'P1', playerName: 'Иванов Иван', tournamentId: 't2', place: 2 },
  ];
  const st = computeStandings({ tournaments, results, asOf: ASOF });
  eq(st.players[0].playerName, 'Иванов И.', 'имя');
  eq(st.players[0].ratingPoints, 170, 'очки посчитаны, падения нет');
  eq(st.warnings.length, 1, 'одно предупреждение');
});

// ===========================================================================
section('Тай-брейк, ступень 1 — личные встречи');
// ===========================================================================

check('A обыграл B -> A выше', () => {
  const data = merge(profile('A', [100]), profile('B', [100]), arena('arena'));
  const st = computeStandings({
    ...data,
    matches: [{ tournamentId: 'arena', winnerPlayerId: 'A', loserPlayerId: 'B' }],
    asOf: ASOF,
  });
  eq(order(st), ['A', 'B']);
  eq(ranks(st), [1, 2]);
});

check('пара с несколькими матчами: A>B дважды, B>A раз -> A выше (2 vs 1)', () => {
  const data = merge(profile('A', [100]), profile('B', [100]), arena('arena'));
  const st = computeStandings({
    ...data,
    matches: [
      { tournamentId: 'arena', winnerPlayerId: 'B', loserPlayerId: 'A' },
      { tournamentId: 'arena', winnerPlayerId: 'A', loserPlayerId: 'B' },
      { tournamentId: 'arena', winnerPlayerId: 'A', loserPlayerId: 'B' },
    ],
    asOf: ASOF,
  });
  eq(order(st), ['A', 'B']);
});

check('пара 1-1 -> ступень 1 не решает, дальше по каскаду (тут — делят место)', () => {
  const data = merge(profile('A', [100]), profile('B', [100]), arena('arena'));
  const st = computeStandings({
    ...data,
    matches: [
      { tournamentId: 'arena', winnerPlayerId: 'A', loserPlayerId: 'B' },
      { tournamentId: 'arena', winnerPlayerId: 'B', loserPlayerId: 'A' },
    ],
    asOf: ASOF,
  });
  eq(ranks(st), [1, 1], 'делят место');
});

check('матч турнира ВНЕ окна не учитывается', () => {
  const data = merge(profile('A', [100]), profile('B', [100]), arena('old', 400));
  const st = computeStandings({
    ...data,
    matches: [{ tournamentId: 'old', winnerPlayerId: 'A', loserPlayerId: 'B' }],
    asOf: ASOF,
  });
  eq(ranks(st), [1, 1], 'матч не засчитан -> делят место');
});

check('матч в турнире, не вошедшем в зачётные 6, — УЧИТЫВАЕТСЯ', () => {
  // у обоих одинаковые 7 турниров: 100,100,70,70,45,25,10 -> 410, седьмой вне зачёта
  const places = [1, 1, 2, 2, 3, 5, 9];
  const tournaments = places.map((_, i) => ({
    id: `m${i + 1}`,
    name: `Турнир m${i + 1}`,
    endDate: back(10 + i),
    category: 'B',
  }));
  const results = [];
  for (const playerId of ['A', 'B']) {
    places.forEach((place, i) =>
      results.push({ playerId, playerName: playerId, tournamentId: `m${i + 1}`, place }),
    );
  }
  const base = computeStandings({ tournaments, results, asOf: ASOF });
  eq(base.players.map((p) => p.ratingPoints), [410, 410], 'равные очки');
  eq(base.players[0].counted.map((c) => c.tournamentId).includes('m7'), false, 'm7 вне зачёта');
  eq(ranks(base), [1, 1], 'без матчей делят место');

  const st = computeStandings({
    tournaments,
    results,
    matches: [{ tournamentId: 'm7', winnerPlayerId: 'B', loserPlayerId: 'A' }],
    asOf: ASOF,
  });
  eq(order(st), ['B', 'A'], 'матч из незачётного турнира решил');
});

check('матч, где у проигравшего нет результата в турнире (снялся), — УЧИТЫВАЕТСЯ', () => {
  // A: 100 + 0 (место 20) -> 100, сыграл 2; B: 100 -> 100, сыграл 1.
  // Ступень 2 равна (0 == недостающая позиция), ступень 3 дала бы A выше (2 > 1).
  // Матч B>A на площадке, где у A результата нет, решает раньше: B выше.
  const tournaments = [
    { id: 'a1', name: 'A1', endDate: back(10), category: 'B' },
    { id: 'a2', name: 'A2', endDate: back(11), category: 'B' },
    { id: 'b1', name: 'B1', endDate: back(12), category: 'B' },
    { id: 'arena', name: 'Площадка', endDate: back(3), category: 'B' },
  ];
  const results = [
    { playerId: 'A', playerName: 'A', tournamentId: 'a1', place: 1 },
    { playerId: 'A', playerName: 'A', tournamentId: 'a2', place: 20 },
    { playerId: 'B', playerName: 'B', tournamentId: 'b1', place: 1 },
  ];
  const noMatches = computeStandings({ tournaments, results, asOf: ASOF });
  eq(noMatches.players.map((p) => p.ratingPoints), [100, 100], 'равные очки');
  eq(order(noMatches), ['A', 'B'], 'без матчей решает ступень 3 (A сыграл больше)');

  const st = computeStandings({
    tournaments,
    results,
    matches: [{ tournamentId: 'arena', winnerPlayerId: 'B', loserPlayerId: 'A' }],
    asOf: ASOF,
  });
  eq(order(st), ['B', 'A'], 'матч без результата у проигравшего засчитан');
});

check('рекурсия-пересчёт: порядок по подгруппе, а не по исходной группе', () => {
  // Победы в исходной группе: A=2 (C,D), B=2 (A,C), C=1 (D), D=1 (B).
  // Делим на {A,B} и {C,D}; пересчёт внутри {A,B} даёт B>A (B обыграл A), внутри {C,D} — C>D.
  const data = merge(
    profile('A', [100]),
    profile('B', [100]),
    profile('C', [100]),
    profile('D', [100]),
    arena('arena'),
  );
  const m = (w, l) => ({ tournamentId: 'arena', winnerPlayerId: w, loserPlayerId: l });
  const st = computeStandings({
    ...data,
    matches: [m('B', 'A'), m('A', 'C'), m('A', 'D'), m('B', 'C'), m('C', 'D'), m('D', 'B')],
    asOf: ASOF,
  });
  eq(order(st), ['B', 'A', 'C', 'D'], 'пересчёт в подгруппе {A,B} перевернул порядок');
  eq(ranks(st), [1, 2, 3, 4]);
});

check('тройка с круговой личкой (A>B, B>C, C>A) -> решает ступень 2', () => {
  // Очки у всех 165. Профили: P1 [100,45,10,10], P2 [70,70,25], P3 [70,45,25,25].
  // Ступень 2: 100 > 70 -> P1 первый; P2 vs P3: 70=70, 70>45 -> P2 выше.
  const data = merge(
    profile('P1', [100, 45, 10, 10]),
    profile('P2', [70, 70, 25]),
    profile('P3', [70, 45, 25, 25]),
    arena('arena'),
  );
  const m = (w, l) => ({ tournamentId: 'arena', winnerPlayerId: w, loserPlayerId: l });
  const st = computeStandings({
    ...data,
    matches: [m('P1', 'P2'), m('P2', 'P3'), m('P3', 'P1')],
    asOf: ASOF,
  });
  eq(st.players.map((p) => p.ratingPoints), [165, 165, 165], 'очки равны');
  eq(order(st), ['P1', 'P2', 'P3']);
});

check('четвёрка «двое-и-двое» (2/2/1/1; A>B, C>D) -> A>B>C>D, ступень 2 не задействована', () => {
  // Профили подобраны так, что ступень 2 дала бы B, D, A, C — а получиться должно A, B, C, D.
  const data = merge(
    profile('A', [70, 70, 25]),
    profile('B', [100, 45, 10, 10]),
    profile('C', [70, 70, 25]),
    profile('D', [100, 45, 10, 10]),
    arena('arena'),
  );
  const m = (w, l) => ({ tournamentId: 'arena', winnerPlayerId: w, loserPlayerId: l });
  const st = computeStandings({
    ...data,
    matches: [m('A', 'B'), m('A', 'C'), m('B', 'C'), m('B', 'D'), m('C', 'D'), m('D', 'A')],
    asOf: ASOF,
  });
  eq(st.players.map((p) => p.ratingPoints), [165, 165, 165, 165], 'очки равны');
  eq(order(st), ['A', 'B', 'C', 'D']);

  const noMatches = computeStandings({ ...data, asOf: ASOF });
  eq(order(noMatches), ['B', 'D', 'A', 'C'], 'ступень 2 в одиночку дала бы другой порядок');
});

check('нет matches вовсе -> ступень 1 пропускается', () => {
  const data = merge(profile('A', [100]), profile('B', [100]));
  const st = computeStandings({ ...data, asOf: ASOF });
  eq(ranks(st), [1, 1]);
});

// ===========================================================================
section('Тай-брейк, ступени 2–4');
// ===========================================================================

check('ст.2 «первый различающийся»: равны на позиции 1, различаются на позиции 2', () => {
  // X [100,70,25] = 195, Y [100,45,25,25] = 195. Позиция 2: 70 > 45 -> X выше.
  // (ступень 3 дала бы Y выше — 4 турнира против 3, значит решила именно ст.2)
  const data = merge(profile('X', [100, 70, 25]), profile('Y', [100, 45, 25, 25]));
  const st = computeStandings({ ...data, asOf: ASOF });
  eq(st.players.map((p) => p.ratingPoints), [195, 195], 'очки равны');
  eq(order(st), ['X', 'Y']);
});

check('ст.2 нейтральна к объёму: разводит ступень 3', () => {
  // A [100,70] = 170 (2 турнира); B [100,70,0,0] = 170 (4 турнира).
  // На ступени 2 всё равно (0 == недостающая позиция), ступень 3: B выше.
  const data = merge(profile('A', [100, 70]), profile('B', [100, 70, 0, 0]));
  const st = computeStandings({ ...data, asOf: ASOF });
  eq(st.players.map((p) => p.ratingPoints), [170, 170], 'очки равны');
  eq(st.players.map((p) => p.totalInWindow).sort(), [2, 4], 'объём разный');
  eq(order(st), ['B', 'A']);
});

check('ст.4: всё совпало -> делят место, следующий получает ранг с пропуском', () => {
  const data = merge(profile('A', [100, 70]), profile('B', [100, 70]), profile('C', [45]));
  const st = computeStandings({ ...data, asOf: ASOF });
  eq(ranks(st), [1, 1, 3]);
  eq(st.players[2].playerId, 'C');
});

// ===========================================================================
section('Возрастные группы');
// ===========================================================================

check('группировка по ageGroup: тот же расчёт внутри каждой группы', () => {
  const data = merge(profile('U1', [100]), profile('U2', [70]), profile('S1', [45]));
  const st = computeStandingsByAgeGroup({
    ...data,
    players: [
      { playerId: 'U1', ageGroup: 'до 15' },
      { playerId: 'U2', ageGroup: 'до 15' },
      { playerId: 'S1', ageGroup: 'взрослые' },
    ],
    asOf: ASOF,
  });
  eq(st.groups.length, 2, 'групп');
  const u = st.groups.find((g) => g.ageGroup === 'до 15');
  const s = st.groups.find((g) => g.ageGroup === 'взрослые');
  eq(u.players.map((p) => [p.rank, p.playerId]), [[1, 'U1'], [2, 'U2']], 'до 15');
  eq(s.players.map((p) => [p.rank, p.playerId]), [[1, 'S1']], 'взрослые');
});

// ===========================================================================
// Итог + печать standings
// ===========================================================================
console.log('\n' + '='.repeat(70));
if (failures.length) {
  console.log(`НЕ СОШЛОСЬ: ${failures.length}, зелёных: ${passed}`);
  for (const f of failures) console.log(`  ❌ ${f.label}\n     ${f.message}`);
  process.exit(1);
}
console.log(`ВСЕ ПРОВЕРКИ ЗЕЛЁНЫЕ: ${passed}`);
console.log('='.repeat(70) + '\n');

const demo = merge(
  profile('P1', [100, 100, 70, 70, 45, 25, 10]),
  profile('P2', [100, 70, 45]),
  profile('P3', [100, 70, 45]),
);
printStandings(computeStandings({ ...demo, asOf: ASOF }));
