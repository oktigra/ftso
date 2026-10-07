/**
 * RATE-LIMIT на ПУБЛИЧНУЮ форму — отдельным счётчиком и куда жёстче, чем
 * админский: за формой регистрации нет входа, а каждая заявка порождает
 * запись с ПДн и письмо. Ключ свой (`r:`), чтобы поток заявок не съедал лимит
 * админки и наоборот.
 *
 * ДВА СЧЁТЧИКА НА IP (07.10.2026, по живой проверке форм):
 *  - `<key>:<ip>`     — ПРИНЯТЫЕ заявки. Пополняется только когда маршрут
 *    дошёл до записи в базу и позвал `req.formAccepted()`. Отказ валидации
 *    (файл больше лимита, исполняемый файл, пустое поле) лимит НЕ тратит —
 *    иначе человек, у которого дважды не прошёл файл, третьей попыткой
 *    упирался в 429 и не мог подать нормальную заявку.
 *  - `<key>:<ip>:all` — ВСЕ POST, включая отбитые. Потолок от флуда
 *    невалидными запросами: по умолчанию впятеро выше лимита принятых.
 * `countAll: true` — прежнее поведение (каждый POST тратит лимит): для
 * кабинета неудачные входы и должны считаться.
 */
export function publicFormLimiter(db, {
  maxPerWindow, windowMinutes, key = 'r', countAll = false, maxAttemptsPerWindow = maxPerWindow * 5,
}) {
  const ensure = db.prepare(
    "INSERT INTO write_attempts (key, count, window_at) VALUES (?, 0, datetime('now')) " +
      'ON CONFLICT(key) DO NOTHING',
  );
  const rollWindow = db.prepare(
    "UPDATE write_attempts SET count = 0, window_at = datetime('now') " +
      "WHERE key = ? AND window_at <= datetime('now', ?)",
  );
  const bump = db.prepare('UPDATE write_attempts SET count = count + 1 WHERE key = ?');
  const read = db.prepare('SELECT count FROM write_attempts WHERE key = ?');
  const count = (k) => {
    ensure.run(k);
    rollWindow.run(k, `-${windowMinutes} minutes`);
    return read.get(k).count;
  };
  const limited = (next) => {
    const err = new Error('Слишком много заявок');
    err.status = 429;
    err.publicMessage =
      `Слишком много заявок с одного адреса. Подождите ${windowMinutes} мин. ` +
      'Если это ошибка — напишите нам, заявку примут вручную.';
    return next(err);
  };

  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const accepted = `${key}:${req.ip}`;
    if (countAll) {
      count(accepted);
      bump.run(accepted);
      if (read.get(accepted).count > maxPerWindow) return limited(next);
      return next();
    }
    const attempts = `${key}:${req.ip}:all`;
    count(attempts);
    bump.run(attempts);
    if (read.get(attempts).count > maxAttemptsPerWindow) return limited(next);
    if (count(accepted) >= maxPerWindow) return limited(next);
    let counted = false;
    req.formAccepted = () => {
      if (counted) return;
      counted = true;
      bump.run(accepted);
    };
    return next();
  };
}

// RATE-LIMIT на запись: не только вход, но и POST-действия админки.
// Счёт по IP в скользящем окне, хранение в SQLite (переживает рестарт).
export function writeLimiter(db, { maxPerWindow, windowMinutes }) {
  const ensure = db.prepare(
    "INSERT INTO write_attempts (key, count, window_at) VALUES (?, 0, datetime('now')) " +
      'ON CONFLICT(key) DO NOTHING',
  );
  const rollWindow = db.prepare(
    "UPDATE write_attempts SET count = 0, window_at = datetime('now') " +
      "WHERE key = ? AND window_at <= datetime('now', ?)",
  );
  const bump = db.prepare('UPDATE write_attempts SET count = count + 1 WHERE key = ?');
  const read = db.prepare('SELECT count FROM write_attempts WHERE key = ?');

  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const key = `w:${req.ip}`;
    ensure.run(key);
    rollWindow.run(key, `-${windowMinutes} minutes`);
    bump.run(key);
    const row = read.get(key);
    if (row && row.count > maxPerWindow) {
      const err = new Error('Слишком много операций записи');
      err.status = 429;
      err.publicMessage = `Слишком много действий подряд. Подождите ${windowMinutes} мин.`;
      return next(err);
    }
    return next();
  };
}
