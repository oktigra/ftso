// ВИД ПОЛЕЙ ВВОДА — НАБОР ЭФФЕКТОВ.
//
// Вид собирается не из трёх готовых картинок, а из отдельных эффектов: фон,
// рамка, тени, радиус, кольцо фокуса. Набор — строка слов («inset border-strong
// round»), она уезжает в атрибут data-fx на <html>, а в site.css каждое слово
// правит свои переменные (селектор ~= читает атрибут как список).
//
// Где живёт: FIELD_STYLE в .env (заготовка) или строка набора там же. Параметр
// ?fx= в адресе показывает любой набор, ничего не сохраняя, — им и выбираем вид.

/** Что вообще разрешено — всё остальное молча отбрасывается. */
export const EFFECTS = [
  { id: 'fill-deep', group: 'Фон', title: 'Утопленный фон', hint: 'В тёмной теме поле темнее карточки, в светлых — чистый белый.' },
  { id: 'fill-soft', group: 'Фон', title: 'Мягкая заливка', hint: 'Поле отличается от карточки цветом: в тёмной чуть светлее, в тёплой — молочное.' },
  { id: 'ghost', group: 'Фон', title: 'Без фона', hint: 'Поле прозрачное, держится только рамкой.' },
  { id: 'border-soft', group: 'Рамка', title: 'Тонкая рамка', hint: 'Один пиксель и тише по цвету.' },
  { id: 'border-strong', group: 'Рамка', title: 'Толстая рамка', hint: 'Два пикселя и контрастнее — поле видно издалека.' },
  { id: 'inset', group: 'Тени', title: 'Тень внутрь', hint: 'Поле выглядит вдавленным.' },
  { id: 'flat-shadow', group: 'Тени', title: 'Без внутренней тени', hint: 'Гасит тень внутрь, если она пришла из темы.' },
  { id: 'lift', group: 'Тени', title: 'Тень наружу', hint: 'Поле слегка приподнято над карточкой.' },
  { id: 'round', group: 'Форма', title: 'Крупное скругление', hint: 'Радиус 1.1rem вместо 0.7rem.' },
  { id: 'square', group: 'Форма', title: 'Мелкое скругление', hint: 'Радиус 0.3rem — почти прямые углы.' },
  { id: 'ring-wide', group: 'Фокус', title: 'Широкое кольцо фокуса', hint: 'Толще подсветка поля, на котором стоит курсор.' },
];

const ALLOWED = new Set(EFFECTS.map((e) => e.id));
const ORDER = EFFECTS.map((e) => e.id);

/** Ярлыки трёх видов из первой редакции — остались как быстрые заготовки. */
export const PRESETS = {
  inset: 'inset',
  flat: 'fill-soft border-strong flat-shadow',
  outline: 'ghost border-strong flat-shadow lift',
};

export const DEFAULT_FX = PRESETS.inset;

/**
 * Приводит любую строку к безопасному набору: только известные слова, без
 * повторов, в постоянном порядке. Мусор молча отбрасывается — атрибут собирается
 * из наших же id, поэтому в разметку ничего чужого не попадает.
 */
export function parseFx(input) {
  const words = String(input || '').toLowerCase().split(/[\s,+]+/).filter(Boolean);
  const picked = ORDER.filter((id) => words.includes(id) && ALLOWED.has(id));
  return picked.join(' ');
}

/** Набор из адреса: ?fx=список слов или ?fields=имя заготовки. Ничего не сохраняет. */
export function fxFromQuery(query) {
  if (query && typeof query.fx === 'string') return parseFx(query.fx);
  if (query && typeof query.fields === 'string' && PRESETS[query.fields]) return PRESETS[query.fields];
  return null;
}

/** Сохранённый набор: сначала админка (БД), потом FIELD_STYLE из .env, потом умолчание. */
export function savedFx(db, config) {
  return PRESETS[config.fieldStyle] || parseFx(config.fieldStyle) || DEFAULT_FX;
}
