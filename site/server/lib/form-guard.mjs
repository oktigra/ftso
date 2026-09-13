// ЗАЩИТА ПУБЛИЧНЫХ ФОРМ ОТ МАССОВОГО СПАМА.
//
// Картинок и внешних сервисов нет намеренно: облачная капча — это передача
// данных посетителя третьему лицу, то есть ещё одно поручение обработки и
// правка Политики. Здесь всё своё и без ПДн.
//
// Устроено как номерок из гардероба. Показали страницу — положили в сессию
// билет: время выдачи и два числа для простого вопроса. Отправили форму —
// смотрим на билет:
//   нет билета            → страницу не открывали (или сессия протухла);
//   моложе minSeconds     → человек столько не пишет;
//   старше maxMinutes     → вкладка висела полдня, билет протух;
//   ответ не сошёлся      → вопрос под формой не прочитали.
// После успешной отправки билет гасится: один билет — одна заявка.
//
// Приманка `website` (honeypot) остаётся в формах и работает раньше этой
// проверки — она ловит ботов, которые заполняют всё подряд.
import { ValidationError } from './validate.mjs';

// ВОПРОСЫ РАЗНОГО ВИДА (14.09.2026, по слову владельца: один и тот же «сколько
// будет a + b» скрипт распознаёт по шаблону). Ответ всегда число — поле остаётся
// цифровым. Вид выбирается случайно при выдаче билета; текст и ответ живут в
// билете, шаблон получает только текст.
const rnd = (n) => 1 + Math.floor(Math.random() * n);
const WORDS = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TENNIS = [['мяч', 3], ['корт', 4], ['сетка', 5], ['гейм', 4], ['подача', 6], ['ракетка', 7], ['сет', 3], ['турнир', 6]];

const KINDS = [
  () => { const a = rnd(8); const b = rnd(8); return { q: `сколько будет ${a} + ${b}?`, answer: a + b }; },
  () => { const b = rnd(7); const a = b + rnd(9 - b); return { q: `сколько будет ${a} − ${b}?`, answer: a - b }; },
  () => { const a = rnd(8); const b = rnd(8); return { q: `сколько будет ${WORDS[a]} плюс ${WORDS[b]}?`, answer: a + b }; },
  () => { const a = rnd(9); let b = rnd(9); if (b === a) b = a === 9 ? 1 : a + 1; return { q: `какое из чисел больше: ${a} или ${b}?`, answer: Math.max(a, b) }; },
  () => { const a = rnd(8); return { q: `какое число идёт сразу после ${a}?`, answer: a + 1 }; },
  () => { const n = 2 + rnd(4); return { q: `сколько мячей в строке: ${'🎾'.repeat(n)}?`, answer: n }; },
  () => { const [w, n] = TENNIS[Math.floor(Math.random() * TENNIS.length)]; return { q: `сколько букв в слове «${w}»?`, answer: n }; },
];

/** Свежий билет: время выдачи, текст вопроса и ответ. */
function newTicket() {
  const { q, answer } = KINDS[Math.floor(Math.random() * KINDS.length)]();
  return { at: Date.now(), q, answer };
}

/**
 * РЕШАТЕЛЬ ДЛЯ ПРИЁМКИ: по тексту вопроса даёт ответ. Живёт на сервере и
 * наружу не отдаётся — тесты им играют роль человека, читающего вопрос.
 */
export function solveQuestion(text) {
  const s = String(text || '');
  let m;
  if ((m = /(\d+) \+ (\d+)\?/.exec(s))) return Number(m[1]) + Number(m[2]);
  if ((m = /(\d+) − (\d+)\?/.exec(s))) return Number(m[1]) - Number(m[2]);
  if ((m = /будет (\S+) плюс (\S+)\?/.exec(s))) return WORDS.indexOf(m[1]) + WORDS.indexOf(m[2]);
  if ((m = /больше: (\d+) или (\d+)\?/.exec(s))) return Math.max(Number(m[1]), Number(m[2]));
  if ((m = /сразу после (\d+)\?/.exec(s))) return Number(m[1]) + 1;
  if ((m = /мячей в строке: (\S+)\?/.exec(s))) return [...m[1]].length;
  if ((m = /в слове «([^»]+)»\?/.exec(s))) return (TENNIS.find(([w]) => w === m[1]) || [null, NaN])[1];
  return NaN;
}

/**
 * Выдача билета на просмотр страницы. Уже выданный и не протухший НЕ
 * перевыдаётся: иначе форма, открытая во второй вкладке, гасила бы вопрос в
 * первой. Возвращает то, что нужно шаблону.
 */
export function issueTicket(req, config) {
  if (!req.session) return { question: '', on: false };
  const max = config.form.maxMinutes * 60 * 1000;
  const t = req.session.formTicket;
  if (!t || typeof t.at !== 'number' || Date.now() - t.at > max) {
    req.session.formTicket = newTicket();
  }
  const cur = req.session.formTicket;
  return { question: cur.q, on: config.form.question };
}

/**
 * Проверка при отправке. Бросает ValidationError — форма покажет её своим
 * обычным путём, вместе с остальными ошибками ввода.
 */
export function checkTicket(req, config, body = req.body) {
  const t = req.session && req.session.formTicket;
  if (!t || typeof t.at !== 'number' || typeof t.answer !== 'number') {
    // Нет билета или он старого образца (без ответа) — страницу надо показать заново.
    delete req.session.formTicket;
    throw new ValidationError('Форма устарела. Обновите страницу и отправьте ещё раз.');
  }
  const age = Date.now() - t.at;
  if (age > config.form.maxMinutes * 60 * 1000) {
    delete req.session.formTicket;
    throw new ValidationError('Форма устарела. Обновите страницу и отправьте ещё раз.');
  }
  if (age < config.form.minSeconds * 1000) {
    throw new ValidationError(
      'Форма отправлена слишком быстро — так заполняют роботы. Проверьте поля и отправьте ещё раз.',
    );
  }
  if (config.form.question) {
    const sent = String((body && body.form_answer) || '').trim();
    if (!/^-?\d{1,3}$/.test(sent) || Number(sent) !== t.answer) {
      throw new ValidationError(
        `Не подтверждено, что вы не робот: ответьте на вопрос под формой — ${t.q}`,
      );
    }
  }
}

/** Билет израсходован: следующая отправка потребует нового просмотра страницы. */
export function consumeTicket(req) {
  if (req.session) delete req.session.formTicket;
}
