// SMTP-транспорт для очереди писем (Яндекс).
//
// Почему nodemailer, а не свой клиент: в ручной реализации SMTP ломаются тихо
// именно ретраи и TLS — и тогда письмо о статусе заявки не уходит, а человек
// думает, что его проигнорировали. Свой код протокола пришлось бы сопровождать
// вечно ради экономии одной зависимости.
//
// Транспорт ничего не знает про очередь: он умеет отправить одно письмо и
// БРОСИТЬ при неудаче. Всё остальное (очередь, попытки, видимость в админке)
// — забота lib/mailer.mjs.
import nodemailer from 'nodemailer';
import { OPERATOR } from './legal.mjs';

/** Настроен ли SMTP. Без логина и пароля отправлять нечем — и это не ошибка, а состояние. */
export function smtpConfigured(smtp) {
  return Boolean(smtp && smtp.user && smtp.pass);
}

/**
 * Отправитель для очереди: async ({to, subject, body}) => void.
 * Бросает — письмо остаётся в очереди с записанной причиной.
 */
export function createSmtpTransport(smtp) {
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    // 465 — TLS сразу, 587 — STARTTLS. Для Яндекса штатный вариант — 465.
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  // Яндекс требует, чтобы From совпадал с ящиком, под которым авторизовались,
  // иначе письмо отлетает. Поэтому адрес по умолчанию — сам SMTP_USER.
  const from = smtp.from || `${OPERATOR.name} <${smtp.user}>`;

  return async ({ to, subject, body }) => {
    await transporter.sendMail({ from, to, subject, text: body });
  };
}
