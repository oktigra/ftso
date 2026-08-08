// СЕРВЕРНАЯ валидация форм админки: на браузер не полагаемся. Кривой ввод ->
// отклоняется сообщением, сервер НЕ роняется (движок часть ловит падением,
// но админка не должна доводить до падения).

export class ValidationError extends Error {
  constructor(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    super(list.join('; '));
    this.name = 'ValidationError';
    this.messages = list;
  }
}

// Контролируемый список возрастных групп. Набор задаёт Федерация — правится
// здесь, жёсткого CHECK в схеме нет.
export const AGE_GROUPS = ['до 19', '19-34', '35-44', '45-54', '55+'];
export const SEXES = ['M', 'F'];
export const CATEGORIES = ['A', 'B'];

export function str(value, field, { min = 1, max = 200, required = true } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) {
    if (required) throw new ValidationError(`${field}: обязательное поле`);
    return null;
  }
  if (v.length < min) throw new ValidationError(`${field}: минимум ${min} символ(ов)`);
  if (v.length > max) throw new ValidationError(`${field}: максимум ${max} символов`);
  return v;
}

export function oneOf(value, field, allowed, { required = true } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) {
    if (required) throw new ValidationError(`${field}: обязательное поле`);
    return null;
  }
  if (!allowed.includes(v)) {
    throw new ValidationError(`${field}: допустимо только ${allowed.join(', ')} (получено «${v}»)`);
  }
  return v;
}

/** Целое >= min. "abc", "1.5", "0", "-1" -> отказ. */
export function intAtLeast(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw === '' || raw === null || raw === undefined) {
    throw new ValidationError(`${field}: обязательное поле`);
  }
  if (!/^-?\d+$/.test(String(raw))) {
    throw new ValidationError(`${field}: ожидалось целое число, получено «${raw}»`);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new ValidationError(`${field}: ожидалось целое не меньше ${min}, получено «${raw}»`);
  }
  if (n > max) throw new ValidationError(`${field}: ожидалось целое не больше ${max}`);
  return n;
}

/** Строго YYYY-MM-DD И реальная дата: 2026-13-40 и 2026-02-30 отвергаются. */
export function isoDate(value, field) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new ValidationError(`${field}: ожидался формат ГГГГ-ММ-ДД, получено «${v}»`);
  }
  const [y, m, d] = v.split('-').map(Number);
  const back = new Date(Date.UTC(y, m - 1, d));
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    throw new ValidationError(`${field}: несуществующая дата «${v}»`);
  }
  return v;
}

export function playerInput(body) {
  return {
    full_name: str(body.full_name, 'ФИО', { max: 120 }),
    city: str(body.city, 'Город', { max: 80 }),
    sex: oneOf(body.sex, 'Пол', SEXES),
    age_group: oneOf(body.age_group, 'Возрастная группа', AGE_GROUPS, { required: false }),
  };
}

/**
 * Отметка «есть согласие на публикацию»: true, false или NULL — «поле не пришло».
 *
 * Поле приходит СПИСКОМ, а не чекбоксом: невыбранный чекбокс браузер не
 * отправляет вовсе. Но одного списка мало — запрос мог прийти и не из этой
 * формы. Поэтому отсутствие поля означает «НЕ ТРОГАТЬ согласие», а не «отозвать»:
 * отзыв согласия — юридически значимое действие субъекта, и получиться сам собой
 * из-за недостающего поля в POST он не имеет права.
 */
export function publicFlag(body) {
  if (body.is_public === undefined || body.is_public === null || body.is_public === '') return null;
  return oneOf(String(body.is_public), 'Публикация', ['0', '1']) === '1';
}

export function tournamentInput(body) {
  return {
    name: str(body.name, 'Название', { max: 160 }),
    end_date: isoDate(body.end_date, 'Дата завершения'),
    category: oneOf(body.category, 'Категория', CATEGORIES),
  };
}
