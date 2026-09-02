// ВОЗРАСТ И ВОЗРАСТНЫЕ СРЕЗЫ — одно место для всего сайта (ТЗ ред. 6, модель РТТ).
//
// Наружу выводится ВОЗРАСТ В ПОЛНЫХ ГОДАХ, а не дата и не год рождения. Возраст
// считается на дату показа (или на дату актуальности рейтинга), от birth_date,
// который остаётся внутренним полем. Нет даты рождения — нет возраста («—»),
// игрок виден только в общей таблице и не попадает ни в один срез.
//
// СРЕЗЫ — как у РТТ: отдельные по годам 9…18 плюс сводные «до 13», «до 15»,
// «до 17», «до 19» и «19+». Один игрок попадает в несколько срезов сразу
// (например, 14 лет -> «14 лет», «до 15», «до 17», «до 19»). Набор задаётся
// здесь и только здесь: региональный масштаб может потребовать меньшего числа
// групп — тогда правится этот список, а не витрина.
//
// ПРАВИЛО ВОЗРАСТА ДЛЯ СРЕЗА: полные годы на дату актуальности. Если федерация
// решит считать по году рождения (возраст на 31 декабря, как в календаре РТТ),
// меняется ОДНА функция — ageOn.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Полных лет на дату `on` (YYYY-MM-DD, по умолчанию сегодня). null — если даты нет. */
export function ageOn(birthDate, on = new Date().toISOString().slice(0, 10)) {
  if (!birthDate || !DATE_RE.test(birthDate) || !DATE_RE.test(on)) return null;
  const [by, bm, bd] = birthDate.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age < 0 ? null : age;
}

/** «15 лет», «21 год», «22 года». */
export function ageLabel(age) {
  if (age === null || age === undefined) return '—';
  const n = age % 100;
  const d = age % 10;
  if (n >= 11 && n <= 14) return `${age} лет`;
  if (d === 1) return `${age} год`;
  if (d >= 2 && d <= 4) return `${age} года`;
  return `${age} лет`;
}

// id — значение параметра ?slice= на /rating; label — подпись; test — членство.
export const AGE_SLICES = [
  ...[9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((y) => ({
    id: `y${y}`,
    label: `${y} лет`,
    group: 'year',
    test: (age) => age === y,
  })),
  { id: 'u13', label: 'до 13 лет', group: 'summary', test: (age) => age <= 12 },
  { id: 'u15', label: 'до 15 лет', group: 'summary', test: (age) => age <= 14 },
  { id: 'u17', label: 'до 17 лет', group: 'summary', test: (age) => age <= 16 },
  { id: 'u19', label: 'до 19 лет', group: 'summary', test: (age) => age <= 18 },
  { id: 'adult', label: '19 и старше', group: 'summary', test: (age) => age >= 19 },
];

const BY_ID = new Map(AGE_SLICES.map((s) => [s.id, s]));

export function sliceById(id) {
  return BY_ID.get(String(id || '')) || null;
}

/** Идентификаторы всех срезов, куда попадает возраст. Без возраста — пусто. */
export function slicesFor(age) {
  if (age === null || age === undefined) return [];
  return AGE_SLICES.filter((s) => s.test(age)).map((s) => s.id);
}
