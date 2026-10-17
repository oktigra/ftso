// МЕТОДИКА РЕЙТИНГА ФТСО (утверждена федерацией 17.10.2026, полностью заменяет прежнюю
// «100/70/45/25/10 × коэффициент категории»). Единственное место, где живут числа методики:
// витрина, админка, страница «Как считается рейтинг» и расчёт берут их отсюда.
//
//  1. Категория — по РАЗМЕРУ СЕТКИ из протокола (регламентный, а не число заявившихся):
//     32 → A, 24 → B, 16 → C, 8 → D. У каждой сетки турнира своя категория.
//  2. Очки за победу — по категории и РЕЙТИНГОВОЙ ГРУППЕ сетки (взрослые / до 17 / до 13);
//     ветераны 45+ считаются взрослыми.
//  3. За место — процент от очков за победу: 1 — 100 %, 2 — 60 %, 3 — 40 %, 4 — 30 %
//     (если матч за 3 место не играли, оба полуфиналиста — 3-е, по 40 %), 5–8 — 20 %,
//     9–16 — 10 %, 17–32 — 5 %. Округление до целого: 0,5 и больше — вверх.
//  4. Пары (парный разряд и микст): очки за место ДЕЛЯТСЯ ПОПОЛАМ между партнёрами,
//     дробное — вверх. Микст отдельного рейтинга не имеет — идёт в ПАРНЫЙ; если игрок
//     сыграл на турнире и в парном, и в миксте, в зачёт идут оба результата.
//  5. Рейтинг — шесть списков: взрослые / до 17 / до 13, в каждом одиночный и парный.
//     Список выбирается по группе СЕТКИ, а не по возрасту игрока.
//  6. В зачёт — 10 лучших результатов за 52 недели.

export const RATING_GROUPS = ['adult', 'u17', 'u13'];
export const RATING_GROUP_RU = { adult: 'Взрослые', u17: 'До 17 лет', u13: 'До 13 лет' };

export const LIST_DISCIPLINES = ['single', 'pair'];
export const LIST_DISCIPLINE_RU = { single: 'Одиночный', pair: 'Парный' };

/** Регламентные размеры сеток и их категории. */
export const DRAW_SIZES = [32, 24, 16, 8];
export const CATEGORY_BY_SIZE = { 32: 'A', 24: 'B', 16: 'C', 8: 'D' };

/** Очки за победу: группа → категория. */
export const WIN_POINTS = {
  adult: { A: 1000, B: 800, C: 500, D: 250 },
  u17: { A: 800, B: 600, C: 300, D: 150 },
  u13: { A: 500, B: 350, C: 150, D: 80 },
};

/** Процент от очков за победу; места 5–8, 9–16, 17–32 — по верхней границе. */
export const PLACE_PERCENT = [
  { maxPlace: 1, percent: 100, label: '1' },
  { maxPlace: 2, percent: 60, label: '2' },
  { maxPlace: 3, percent: 40, label: '3' },
  { maxPlace: 4, percent: 30, label: '4' },
  { maxPlace: 8, percent: 20, label: '5–8' },
  { maxPlace: 16, percent: 10, label: '9–16' },
  { maxPlace: 32, percent: 5, label: '17–32' },
];

export const COUNT_BEST = 10;
export const WINDOW_DAYS = 364;

export function categoryForSize(size) {
  return CATEGORY_BY_SIZE[Number(size)] || null;
}

export function percentForPlace(place) {
  const p = Number(place);
  if (!Number.isInteger(p) || p < 1) return 0;
  const row = PLACE_PERCENT.find((r) => p <= r.maxPlace);
  return row ? row.percent : 0;
}

/**
 * Очки за место одному игроку.
 * @param {{ group: 'adult'|'u17'|'u13', drawSize: 32|24|16|8, place: number, pair?: boolean }} a
 * @returns {number|null} null — посчитать нельзя (не задан размер сетки или группа).
 */
export function pointsFor({ group, drawSize, place, pair = false }) {
  const cat = categoryForSize(drawSize);
  const base = WIN_POINTS[group] && cat ? WIN_POINTS[group][cat] : null;
  if (!base) return null;
  // Целочисленно, без плавающей точки: base × percent / 100, половина и больше — вверх.
  const placePoints = Math.floor((base * percentForPlace(place) + 50) / 100);
  return pair ? Math.ceil(placePoints / 2) : placePoints;
}

/** Таблица «место → очки» для страницы методики: group → category → [очки по PLACE_PERCENT]. */
export function pointsTable({ pair = false } = {}) {
  const out = {};
  for (const g of RATING_GROUPS) {
    out[g] = {};
    for (const size of DRAW_SIZES) {
      const cat = CATEGORY_BY_SIZE[size];
      out[g][cat] = PLACE_PERCENT.map((r) => pointsFor({ group: g, drawSize: size, place: r.maxPlace, pair }));
    }
  }
  return out;
}

/**
 * Рейтинговая группа турнира по умолчанию — из возрастного ограничения:
 * до 13 лет (верхняя граница ≤ 12) → u13, до 17 (≤ 16) → u17, иначе взрослые
 * (в том числе ветераны и турниры без ограничения).
 */
export function defaultRatingGroup(ageMin, ageMax) {
  if (Number.isInteger(ageMax) && ageMax <= 12) return 'u13';
  if (Number.isInteger(ageMax) && ageMax <= 16) return 'u17';
  return 'adult';
}

export function listKey(group, discipline) {
  return `${group}.${discipline}`;
}

export const LIST_KEYS = RATING_GROUPS.flatMap((g) => LIST_DISCIPLINES.map((d) => listKey(g, d)));

/** Разряд результата → дисциплина списка: микст и парный — в парный. */
export function listDisciplineOf(resultDiscipline) {
  return resultDiscipline === 'single' ? 'single' : 'pair';
}
