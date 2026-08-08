// ПОЧТА С FALLBACK.
//
// Правило бэклога: «email-уведомления с FALLBACK при сбое отправки (не молча)».
// Поэтому письмо не отправляется напрямую из обработчика формы, а сперва
// ЛОЖИТСЯ В ОЧЕРЕДЬ (mail_outbox) и только потом уходит. Что это даёт:
//  - падение SMTP не роняет подачу заявки и не откатывает её;
//  - неотправленное видно в админке и в action_log, а не пропадает молча;
//  - повторная попытка возможна кнопкой, без переподачи заявки человеком.
//
// ТРАНСПОРТ подключается снаружи (setTransport): пока SMTP Яндекса не заведён,
// очередь копится со статусом queued и последней ошибкой «транспорт не настроен».
// Это честное состояние: письма не потеряны и видно, что они не ушли.
import { OPERATOR } from './legal.mjs';

let transport = null;
// После скольких неудач письмо считается безнадёжным. Значение приходит из
// конфига при старте; дефолт нужен тестам и разбору очереди до настройки.
let failAfterDefault = 8;

/** transport: async ({to, subject, body}) => void; бросает — значит не отправлено. */
export function setTransport(fn) {
  transport = fn;
}

export function configureMailer({ failAfter } = {}) {
  if (Number.isFinite(failAfter) && failAfter > 0) failAfterDefault = failAfter;
}

export function hasTransport() {
  return typeof transport === 'function';
}

export function queueMail(db, { to, subject, body, kind }) {
  const info = db
    .prepare('INSERT INTO mail_outbox (to_email, subject, body, kind) VALUES (?, ?, ?, ?)')
    .run(to, subject, body, kind);
  return Number(info.lastInsertRowid);
}

/**
 * Разбор очереди. Ошибка одного письма не останавливает остальные: письмо
 * помечается и остаётся в очереди до следующей попытки.
 * failAfter — после скольких неудач считать письмо безнадёжным (статус failed),
 * чтобы очередь не крутила один и тот же битый адрес вечно.
 */
export async function flushOutbox(db, { limit = 20, failAfter = failAfterDefault } = {}) {
  const rows = db
    .prepare("SELECT id, to_email, subject, body, attempts FROM mail_outbox WHERE status = 'queued' ORDER BY id LIMIT ?")
    .all(limit);
  const stat = { sent: 0, failed: 0, pending: 0 };
  for (const row of rows) {
    try {
      if (!transport) throw new Error('SMTP-транспорт не настроен');
      await transport({ to: row.to_email, subject: row.subject, body: row.body });
      db.prepare("UPDATE mail_outbox SET status = 'sent', attempts = attempts + 1, sent_at = datetime('now'), last_error = NULL WHERE id = ?")
        .run(row.id);
      stat.sent += 1;
    } catch (err) {
      const attempts = row.attempts + 1;
      const dead = attempts >= failAfter;
      db.prepare('UPDATE mail_outbox SET status = ?, attempts = ?, last_error = ? WHERE id = ?')
        .run(dead ? 'failed' : 'queued', attempts, String(err.message).slice(0, 500), row.id);
      if (dead) stat.failed += 1;
      else stat.pending += 1;
    }
  }
  return stat;
}

/**
 * Периодический разбор очереди. Нужен именно потому, что отправка отвязана от
 * запроса: SMTP полежал пять минут — письмо уйдёт со следующим проходом, а не
 * потеряется вместе с завершившимся HTTP-запросом.
 * unref() — таймер не держит процесс живым и не мешает тестам.
 */
export function scheduleMailFlush(db, { intervalMs = 10 * 60 * 1000 } = {}) {
  const timer = setInterval(() => {
    flushOutbox(db)
      .then((stat) => {
        if (stat.sent || stat.failed) {
          console.log(`[почта] очередь: отправлено ${stat.sent}, признано неотправленными ${stat.failed}`);
        }
      })
      .catch((err) => console.error('[почта] разбор очереди упал', err));
  }, intervalMs);
  timer.unref();
  return timer;
}

/** Сводка для админки: сколько писем висит и сколько признано неотправленными. */
export function outboxSummary(db) {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM mail_outbox GROUP BY status').all();
  const out = { queued: 0, sent: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export function recentMail(db, limit = 20) {
  return db
    .prepare('SELECT id, to_email, subject, kind, status, attempts, last_error, created_at, sent_at FROM mail_outbox ORDER BY id DESC LIMIT ?')
    .all(limit);
}

// --- тексты писем ---------------------------------------------------------
//
// Письмо — это тоже обработка ПДн, поэтому в теле МИНИМУМ: имя, статус и ссылка.
// Ни города, ни пола, ни рейтинга — почта идёт по открытым каналам.

const SIGN = `\n\n—\n${OPERATOR.name}\n${OPERATOR.email}\n${OPERATOR.phone}`;

export function mailSubmitted({ fullName, statusUrl }) {
  return {
    subject: 'Заявка на регистрацию принята — ФТСО',
    body:
      `Здравствуйте, ${fullName}.\n\n` +
      'Ваша заявка на включение в рейтинг Федерации тенниса Смоленской области принята ' +
      'и передана на проверку. О решении сообщим этим же письмом.\n\n' +
      `Статус заявки: ${statusUrl}\n` +
      'Ссылка личная — не пересылайте её посторонним.' +
      SIGN,
  };
}

export function mailApproved({ fullName, statusUrl }) {
  return {
    subject: 'Заявка одобрена — ФТСО',
    body:
      `Здравствуйте, ${fullName}.\n\n` +
      'Ваша заявка одобрена, вы включены в рейтинг Федерации.\n\n' +
      `Статус заявки: ${statusUrl}` +
      SIGN,
  };
}

export function mailRejected({ fullName, reason, statusUrl }) {
  return {
    subject: 'Заявка отклонена — ФТСО',
    body:
      `Здравствуйте, ${fullName}.\n\n` +
      'Ваша заявка отклонена.\n' +
      (reason ? `Причина: ${reason}\n` : '') +
      '\nЕсли это ошибка, ответьте на это письмо или напишите нам.\n' +
      `Статус заявки: ${statusUrl}` +
      SIGN,
  };
}
