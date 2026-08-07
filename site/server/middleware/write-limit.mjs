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
