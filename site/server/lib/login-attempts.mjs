// Ограничение попыток входа — в SQLite, НЕ в памяти: рестарт не обнуляет блокировки.
// Ключа два вида:
//   acct:<логин>|<ip>  — 5 неудач / 15 мин. Блокируется ПАРА логин+IP, не логин
//                        глобально: иначе злоумышленник блокирует чужой аккаунт,
//                        зная только логин (DoS).
//   ip:<ip>            — общий лимит с одного адреса, 20 / 15 мин.
// Инкремент АТОМАРНО одним UPDATE ... SET failed_count = failed_count + 1,
// без read-modify-write в JS.

export const acctKey = (username, ip) => `acct:${username}|${ip}`;
export const ipKey = (ip) => `ip:${ip}`;

export class LoginAttempts {
  constructor(db, { maxAccountFails, maxIpFails, lockMinutes }) {
    this.db = db;
    this.maxAccountFails = maxAccountFails;
    this.maxIpFails = maxIpFails;
    this.lockMinutes = lockMinutes;
    this.stmt = {
      get: db.prepare('SELECT key, failed_count, locked_until FROM login_attempts WHERE key = ?'),
      ensure: db.prepare(
        "INSERT INTO login_attempts (key, failed_count, updated_at) VALUES (?, 0, datetime('now')) " +
          'ON CONFLICT(key) DO NOTHING',
      ),
      bump: db.prepare(
        'UPDATE login_attempts SET failed_count = failed_count + 1, ' +
          "updated_at = datetime('now') WHERE key = ?",
      ),
      lock: db.prepare(
        "UPDATE login_attempts SET locked_until = datetime('now', ?), updated_at = datetime('now') " +
          'WHERE key = ? AND failed_count >= ?',
      ),
      reset: db.prepare(
        "UPDATE login_attempts SET failed_count = 0, locked_until = NULL, updated_at = datetime('now') " +
          'WHERE key = ?',
      ),
      expireLock: db.prepare(
        "UPDATE login_attempts SET failed_count = 0, locked_until = NULL, updated_at = datetime('now') " +
          "WHERE key = ? AND locked_until IS NOT NULL AND locked_until <= datetime('now')",
      ),
    };
  }

  /** Блокировка активна? Истёкшая блокировка снимается здесь же. */
  isLocked(key) {
    this.stmt.expireLock.run(key);
    const row = this.stmt.get.get(key);
    return Boolean(row && row.locked_until);
  }

  lockedUntil(key) {
    const row = this.stmt.get.get(key);
    return row ? row.locked_until : null;
  }

  /** true, если вход сейчас запрещён по паре логин+IP ИЛИ по общему лимиту IP. */
  blocked(username, ip) {
    return this.isLocked(acctKey(username, ip)) || this.isLocked(ipKey(ip));
  }

  registerFailure(username, ip) {
    const modifier = `+${this.lockMinutes} minutes`;
    const pairs = [
      [acctKey(username, ip), this.maxAccountFails],
      [ipKey(ip), this.maxIpFails],
    ];
    for (const [key, limit] of pairs) {
      this.stmt.ensure.run(key);
      this.stmt.bump.run(key);
      this.stmt.lock.run(modifier, key, limit);
    }
  }

  /** Успешный вход обнуляет счётчик ключа (пары логин+IP) и общий счётчик IP. */
  registerSuccess(username, ip) {
    this.stmt.reset.run(acctKey(username, ip));
    this.stmt.reset.run(ipKey(ip));
  }
}
