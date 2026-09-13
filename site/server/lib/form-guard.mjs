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

/** Свежий билет: время выдачи и слагаемые вопроса. */
function newTicket() {
  return {
    at: Date.now(),
    a: 1 + Math.floor(Math.random() * 8),
    b: 1 + Math.floor(Math.random() * 8),
  };
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
  return { question: `${cur.a} + ${cur.b}`, on: config.form.question };
}

/**
 * Проверка при отправке. Бросает ValidationError — форма покажет её своим
 * обычным путём, вместе с остальными ошибками ввода.
 */
export function checkTicket(req, config, body = req.body) {
  const t = req.session && req.session.formTicket;
  if (!t || typeof t.at !== 'number') {
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
    if (!/^-?\d{1,3}$/.test(sent) || Number(sent) !== t.a + t.b) {
      throw new ValidationError(
        `Не подтверждено, что вы не робот: ответьте на вопрос под формой — сколько будет ${t.a} + ${t.b}.`,
      );
    }
  }
}

/** Билет израсходован: следующая отправка потребует нового просмотра страницы. */
export function consumeTicket(req) {
  if (req.session) delete req.session.formTicket;
}
