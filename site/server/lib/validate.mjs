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
// Типы турниров по ТЗ п. 4.3: командные встречи, первенства, иные турниры.
export const TOURNAMENT_KINDS = ['team', 'championship', 'other'];
export const TOURNAMENT_KIND_RU = { team: 'Командная встреча', championship: 'Первенство', other: 'Турнир' };
// Возраст турнира — свободная подпись («до 12», «взрослые», «45+»); фильтр по точному значению.
export const TOURNAMENT_STATUSES = ['upcoming', 'ongoing', 'finished'];
export const TOURNAMENT_STATUS_RU = { upcoming: 'Предстоящий', ongoing: 'Идёт', finished: 'Завершён' };

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

/**
 * СОВЕРШЕННОЛЕТИЕ. Порог вынесен константой: он встречается в валидации формы,
 * в провижининге аккаунта и в фоновой проверке перехода, и разъехавшиеся числа
 * означали бы, что где-то ребёнок остаётся без представителя, а где-то взрослый
 * не может распорядиться своими данными.
 */
export const ADULT_AGE = 18;

/** Сегодняшняя дата по UTC в формате ГГГГ-ММ-ДД. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * ПОЛНЫХ ЛЕТ на дату. Считается по календарю, а не делением дней на 365.25:
 * в день восемнадцатилетия человек уже совершеннолетний, а 29 февраля не должно
 * давать «плюс год» раньше срока.
 */
export function ageOn(birthDateIso, onDateIso = today()) {
  const [by, bm, bd] = String(birthDateIso).split('-').map(Number);
  const [ny, nm, nd] = String(onDateIso).split('-').map(Number);
  let age = ny - by;
  if (nm < bm || (nm === bm && nd < bd)) age -= 1;
  return age;
}

export const isMinor = (birthDateIso, onDateIso = today()) => ageOn(birthDateIso, onDateIso) < ADULT_AGE;

/**
 * ДАТА РОЖДЕНИЯ. Кроме формата проверяются две границы здравого смысла: дата
 * не в будущем и не старше 120 лет. Обе — не придирка: на будущей дате возраст
 * получится отрицательным, и «несовершеннолетним» окажется кто угодно.
 */
export function birthDate(value, field = 'Дата рождения') {
  const v = isoDate(value, field);
  const now = today();
  if (v > now) throw new ValidationError(`${field}: дата в будущем`);
  if (ageOn(v, now) > 120) throw new ValidationError(`${field}: проверьте год — получается больше 120 лет`);
  return v;
}

/**
 * ЗАКОННЫЙ ПРЕДСТАВИТЕЛЬ. Состав минимален и весь нужен по делу: ФИО и родство —
 * чтобы понимать, КТО и НА КАКОМ ОСНОВАНИИ даёт согласие за ребёнка, e-mail —
 * единственный канал связи и логин кабинета, пока действует гейт.
 */
/**
 * ФИО из ТРЁХ полей: фамилия и имя обязательны, отчество — нет (у иностранцев его
 * может не быть). В базе по-прежнему одна строка full_name «Фамилия Имя Отчество»:
 * витрина, поиск дублей и сортировка по фамилии не меняются. Старое одно поле
 * full_name принимается для совместимости (API, тесты).
 */
export function personName(body, { prefix = '', field = 'ФИО' } = {}) {
  const key = (s) => (prefix ? `${prefix}_${s}` : s);
  if (body[key('last_name')] !== undefined || body[key('first_name')] !== undefined) {
    const last = str(body[key('last_name')], `${field}: фамилия`, { max: 60 });
    const first = str(body[key('first_name')], `${field}: имя`, { max: 60 });
    const middle = str(body[key('middle_name')], `${field}: отчество`, { max: 60, required: false });
    return [last, first, middle].filter(Boolean).join(' ');
  }
  return str(body[key('full_name')], field, { max: 120 });
}

/** Обратно: «Фамилия Имя Отчество» → { last, first, middle } для полей формы. */
export function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return { last: parts[0] || '', first: parts[1] || '', middle: parts.slice(2).join(' ') };
}

export function guardianInput(body) {
  return {
    full_name: personName(body, { prefix: 'guardian', field: 'ФИО законного представителя' }),
    relation: str(body.guardian_relation, 'Степень родства (кем приходится)', { min: 3, max: 60 }),
    email: email(body.guardian_email, 'E-mail законного представителя'),
  };
}

export function playerInput(body) {
  return {
    full_name: personName(body),
    city: str(body.city, 'Город', { max: 80 }),
    sex: oneOf(body.sex, 'Пол', SEXES),
    // Возрастная группа не вводится нигде: считается от даты рождения (решение 23.08).
    // Дата рождения правится ТОЛЬКО секретарём и ТОЛЬКО в админке. Пустое поле
    // означает «не менять», а не «стереть»: у несовершеннолетнего по ней
    // считается снятие гейта, и случайно очищенная дата тихо выключила бы
    // переход в 18. Стирается она в одном месте — при обезличивании по ст. 21.
    birth_date: body.birth_date ? birthDate(body.birth_date) : null,
    // РНИ — регистрационный номер игрока в РТТ, публичный идентификатор (как в
    // рейтингах тура). Необязателен; пустое поле = «РНИ нет» (в отличие от даты
    // рождения, стирать безопасно — на нём не висит ни гейт, ни согласие).
    rni: rniNumber(body.rni),
  };
}

/** РНИ: до 32 знаков, только цифры, латиница и дефис; пусто → null. */
export function rniNumber(value, field = 'РНИ') {
  const v = str(value, field, { max: 32, required: false });
  if (!v) return null;
  if (!/^[0-9A-Za-z-]+$/.test(v)) throw new ValidationError(`${field}: только цифры, латинские буквы и дефис`);
  return v;
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

/**
 * E-mail. Проверка НАРОЧНО нестрогая: полный разбор RFC 5322 регуляркой — это
 * известная ловушка, а живые адреса он всё равно режет. Смысл проверки — не
 * пропустить очевидный мусор; настоящая проверка адреса — доставленное письмо.
 */
export function email(value, field = 'E-mail', { required = true } = {}) {
  const v = str(value, field, { min: required ? 5 : 0, max: 160, required });
  if (!v) return v;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) {
    throw new ValidationError(`${field}: адрес выглядит неверно`);
  }
  return v.toLowerCase();
}

/**
 * Поля публичной заявки. МИНИМИЗАЦИЯ (ч. 5 ст. 5): обязательны только ФИО,
 * город, пол, дата рождения и почта — то, без чего заявку не рассмотреть,
 * не ответить и не понять, кто вправе дать согласие. Возрастная группа
 * необязательна (её уточнит секретарь), телефона в форме нет вовсе.
 *
 * ДАТА РОЖДЕНИЯ появилась не ради статистики: за лицо младше 18 согласие даёт
 * законный представитель (ч. 1 ст. 9 152-ФЗ), и без даты неизвестно, чьё
 * согласие вообще является основанием обработки. В публичный вывод она не идёт.
 *
 * ПОЧТА НЕСОВЕРШЕННОЛЕТНЕГО НЕ СОБИРАЕТСЯ ВОВСЕ: пока действует гейт, контакт
 * и логин кабинета — почта представителя. Свой адрес человек указывает при
 * переходе в 18. Заполненное поле почты у минора — не «лишние данные, которые
 * можно тихо выбросить», а расхождение с тем, что человек ожидает: поэтому
 * отвечаем понятной ошибкой, а не молчаливым игнорированием ввода.
 */
export function registrationInput(body) {
  const base = {
    full_name: personName(body),
    city: str(body.city, 'Город', { max: 80 }),
    sex: oneOf(body.sex, 'Пол', SEXES),
    // Возрастная группа НЕ вводится: считается от даты рождения (решение федерации 23.08).
    age_group: null,
    birth_date: birthDate(body.birth_date),
  };
  if (!isMinor(base.birth_date)) {
    return { ...base, email: email(body.email), guardian: null };
  }
  if (str(body.email, 'E-mail', { required: false, max: 160 })) {
    throw new ValidationError(
      'До 18 лет контактом и логином кабинета служит почта законного представителя — ' +
        'поле «Электронная почта участника» оставьте пустым.',
    );
  }
  const guardian = guardianInput(body);
  // registrations.email — адрес, по которому уходит решение по заявке и ссылка
  // установки пароля. Для минора это адрес представителя, и другого адреса на
  // заявке нет: иначе половина писем ушла бы «в никуда».
  return { ...base, email: guardian.email, guardian };
}

/**
 * Поля публичной заявки «провести турнир». МИНИМИЗАЦИЯ: организатор, почта,
 * название, город, дата и категория — то, без чего заявку не рассмотреть.
 * Телефон и комментарий необязательны.
 */
export function tournamentRequestInput(body) {
  return {
    name: str(body.name, 'Название турнира', { max: 160 }),
    city: str(body.city, 'Город', { max: 80 }),
    end_date: isoDate(body.end_date, 'Дата завершения'),
    category: oneOf(body.category, 'Категория', CATEGORIES),
    organizer: str(body.organizer, 'Организатор', { max: 160 }),
    email: email(body.email),
    phone: str(body.phone, 'Телефон', { max: 40, required: false }),
    comment: str(body.comment, 'Комментарий', { max: 1000, required: false }),
  };
}

export function tournamentInput(body) {
  const end_date = isoDate(body.end_date, 'Дата завершения');
  const start_date = body.start_date ? isoDate(body.start_date, 'Дата начала') : null;
  if (start_date && start_date > end_date) throw new ValidationError('Дата начала позже даты завершения');
  return {
    name: str(body.name, 'Название', { max: 160 }),
    end_date,
    category: oneOf(body.category, 'Категория', CATEGORIES),
    city: str(body.city, 'Город', { max: 80, required: false }) || null,
    start_date,
    kind: body.kind ? oneOf(body.kind, 'Тип турнира', TOURNAMENT_KINDS) : 'other',
    age_group: str(body.age_group, 'Возраст', { max: 40, required: false }) || null,
  };
}
