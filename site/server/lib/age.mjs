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
// ПРАВИЛО ВОЗРАСТА ДЛЯ СРЕЗА — решение федерации 04.09.2026: по году рождения,
// как в календаре РТТ (возраст на 31 декабря года расчёта): игрок весь
// календарный год стоит в одной группе, день рождения группу не меняет.
// Это sliceAge. На витрине профиля показывается возраст в ПОЛНЫХ ГОДАХ — ageOn;
// это два разных числа для родившихся после даты расчёта.

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

/** Возраст для среза: год даты `on` минус год рождения (календарь РТТ). null — если даты нет. */
export function sliceAge(birthDate, on = new Date().toISOString().slice(0, 10)) {
  if (!birthDate || !DATE_RE.test(birthDate) || !DATE_RE.test(on)) return null;
  const age = Number(on.slice(0, 4)) - Number(birthDate.slice(0, 4));
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

// ---------------------------------------------------------------------------
// ВОЗРАСТНОЕ ОГРАНИЧЕНИЕ ТУРНИРА (17.09.2026). Раньше у турнира была только
// ПОДПИСЬ («до 13 лет») — она ничего не проверяла, и в детскую сетку можно было
// посеять взрослого. Теперь рядом живут ГРАНИЦЫ: age_min / age_max в полных
// годах ПО КАЛЕНДАРЮ РТТ (sliceAge — год турнира минус год рождения), включительно.
// «До 13 лет» — это age_max = 12: те, кому в год турнира исполняется 12 и меньше.
// Пусто с обеих сторон — ограничения нет.

/** Готовые варианты для формы: подпись → границы. */
export const AGE_LIMIT_PRESETS = [
  { id: 'u13', label: 'до 13 лет', min: null, max: 12 },
  { id: 'u15', label: 'до 15 лет', min: null, max: 14 },
  { id: 'u17', label: 'до 17 лет', min: null, max: 16 },
  { id: 'u19', label: 'до 19 лет', min: null, max: 18 },
  { id: 'adult', label: '19 и старше', min: 19, max: null },
  { id: 'v35', label: '35 и старше', min: 35, max: null },
  { id: 'v45', label: '45 и старше', min: 45, max: null },
  { id: 'v55', label: '55 и старше', min: 55, max: null },
];

/** Подпись диапазона: (null,12) → «до 13 лет», (45,null) → «45 и старше», (19,34) → «19–34 года». */
export function ageRangeLabel(min, max) {
  const lo = Number.isInteger(min) ? min : null;
  const hi = Number.isInteger(max) ? max : null;
  if (lo === null && hi === null) return null;
  if (lo === null) return `до ${hi + 1} лет`;
  if (hi === null) return `${lo} и старше`;
  return `${lo}–${hi} ${ageLabel(hi).split(' ')[1]}`;
}

/**
 * Подходит ли игрок турниру. Возраст берётся по календарю РТТ на дату окончания
 * турнира. Нет даты рождения — НЕ отказ: у части игроков её ещё нет, а стопорить
 * ввод протокола из-за незаполненной карточки нельзя; возвращаем {known:false}.
 */
export function fitsAgeLimit(birthDate, tournamentDate, min, max) {
  const lo = Number.isInteger(min) ? min : null;
  const hi = Number.isInteger(max) ? max : null;
  if (lo === null && hi === null) return { ok: true, known: true, age: null };
  const age = sliceAge(birthDate, tournamentDate || undefined);
  if (age === null) return { ok: true, known: false, age: null };
  return { ok: (lo === null || age >= lo) && (hi === null || age <= hi), known: true, age };
}

/**
 * СТОРОЖ ВОЗРАСТА. Зовётся из всех точек, где игрок попадает в турнир: посев в
 * сетку, состав группы, массовый ввод мест, импорт протокола. Бросает
 * ValidationError с внятным текстом; игрока без даты рождения пропускает.
 * Функция ошибки передаётся снаружи, чтобы модуль возраста не тянул validate.mjs.
 */
export function assertAgeAllowed(db, tournamentId, playerIds, { ValidationError }) {
  const ids = [...new Set((Array.isArray(playerIds) ? playerIds : [playerIds]).filter(Boolean))];
  if (!ids.length) return;
  const t = db.prepare('SELECT name, end_date, start_date, age_min, age_max, age_group FROM tournaments WHERE id = ?').get(tournamentId);
  if (!t || (!Number.isInteger(t.age_min) && !Number.isInteger(t.age_max))) return;
  const on = t.end_date || t.start_date || null;
  const rows = db.prepare(`SELECT id, full_name, birth_date FROM players WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const bad = [];
  for (const p of rows) {
    const r = fitsAgeLimit(p.birth_date, on, t.age_min, t.age_max);
    if (r.known && !r.ok) bad.push(`${p.full_name} — ${ageLabel(r.age)} в год турнира`);
  }
  if (bad.length) {
    throw new ValidationError(
      `Турнир «${t.name}»: ограничение ${t.age_group || ageRangeLabel(t.age_min, t.age_max)}. Не подходят: ${bad.join('; ')}. `
      + 'Если игрок допущен решением Федерации — снимите ограничение в карточке турнира; если возраст неверен — поправьте дату рождения в «Игроках».',
    );
  }
}
