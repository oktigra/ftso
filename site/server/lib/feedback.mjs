// Обращения через форму обратной связи на /contacts (ТЗ п. 8, 4.10).
// Данные: имя, e-mail, текст. Основание — согласие (чекбокс со ссылкой на Политику),
// редакция Политики пишется в запись. Хранение: до ответа и retentionDays после
// отметки «обработано» — чистится scheduleDailyPurge (см. server/index.mjs).
// Письмо секретарю кладётся в очередь; при закрытой почте обращения видны в админке.
import { str, email as emailField, ValidationError } from './validate.mjs';

export function feedbackInput(body) {
  if (String(body.consent_processing || '') !== '1') {
    throw new ValidationError('Нужно согласие на обработку персональных данных');
  }
  return {
    name: str(body.name, 'Имя', { max: 120 }),
    email: emailField(body.email),
    message: str(body.message, 'Сообщение', { min: 5, max: 2000 }),
  };
}

export function createFeedback(db, { name, email, message, legalVersion }) {
  return Number(
    db
      .prepare('INSERT INTO feedback_messages (name, email, message, legal_version) VALUES (?, ?, ?, ?)')
      .run(name, email, message, legalVersion).lastInsertRowid,
  );
}

export function listFeedback(db) {
  return db
    .prepare(
      `SELECT f.id, f.name, f.email, f.message, f.status, f.created_at, f.handled_at, u.username AS handled_by
         FROM feedback_messages f LEFT JOIN users u ON u.id = f.handled_by
        ORDER BY CASE f.status WHEN 'new' THEN 0 ELSE 1 END, f.id DESC`,
    )
    .all();
}

export function markFeedbackDone(db, id, userId) {
  return db
    .prepare("UPDATE feedback_messages SET status = 'done', handled_by = ?, handled_at = datetime('now') WHERE id = ? AND status = 'new'")
    .run(userId, id).changes;
}

export function deleteFeedback(db, id) {
  return db.prepare('DELETE FROM feedback_messages WHERE id = ?').run(id).changes;
}

/** Срок хранения: обработанные обращения старше retentionDays удаляются. Новые не трогаем — на них ещё не ответили. */
export function purgeFeedback(db, retentionDays) {
  return db
    .prepare("DELETE FROM feedback_messages WHERE status = 'done' AND handled_at IS NOT NULL AND handled_at < datetime('now', ?)")
    .run(`-${Number(retentionDays)} days`).changes;
}
