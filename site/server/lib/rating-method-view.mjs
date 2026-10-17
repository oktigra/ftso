// Данные для страницы «Как считается рейтинг» — всё берётся из rating-method.mjs,
// чтобы текст на сайте никогда не расходился с расчётом.
import {
  RATING_GROUPS, RATING_GROUP_RU, DRAW_SIZES, CATEGORY_BY_SIZE, WIN_POINTS, PLACE_PERCENT,
  COUNT_BEST, pointsTable, pointsFor,
} from './rating-method.mjs';

export function methodView() {
  return {
    groups: RATING_GROUPS.map((g) => ({ id: g, label: RATING_GROUP_RU[g] })),
    categories: DRAW_SIZES.map((size) => ({ size, cat: CATEGORY_BY_SIZE[size] })),
    winPoints: WIN_POINTS,
    places: PLACE_PERCENT.map((r) => ({ label: r.label, percent: r.percent })),
    single: pointsTable({ pair: false }),
    pair: pointsTable({ pair: true }),
    countBest: COUNT_BEST,
    examples: [
      { text: 'Победа в одиночном разряде, сетка до 13 лет на 24 участника (категория B)', points: pointsFor({ group: 'u13', drawSize: 24, place: 1 }) },
      { text: 'Финал в одиночном разряде, взрослые, сетка на 32 (категория A)', points: pointsFor({ group: 'adult', drawSize: 32, place: 2 }) },
      { text: 'Победа пары, сетка до 17 лет на 16 (категория C): 300 очков на пару — каждому', points: pointsFor({ group: 'u17', drawSize: 16, place: 1, pair: true }) },
      { text: '4 место пары, сетка до 13 лет на 16 (категория C): 45 очков на пару, 22,5 → каждому', points: pointsFor({ group: 'u13', drawSize: 16, place: 4, pair: true }) },
    ],
  };
}
