// Стор сессий express-session на SQLite: сессия переживает рестарт, а logout
// уничтожает СЕРВЕРНУЮ запись — старый перехваченный cookie больше не валиден.
import session from 'express-session';

const Store = session.Store;

export class SqliteStore extends Store {
  constructor(db, { ttlMs = 1000 * 60 * 60 * 12, sweepEveryMs = 1000 * 60 * 10 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.stmt = {
      get: db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?'),
      set: db.prepare(
        'INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at',
      ),
      del: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      all: db.prepare('SELECT data FROM sessions WHERE expires_at > ?'),
      count: db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
      clear: db.prepare('DELETE FROM sessions'),
    };
    this.sweep();
    this.timer = setInterval(() => this.sweep(), sweepEveryMs);
    if (this.timer.unref) this.timer.unref();
  }

  sweep() {
    this.stmt.sweep.run(Date.now());
  }

  expiryOf(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = this.stmt.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.stmt.del.run(sid);
        return cb(null, null);
      }
      return cb(null, JSON.parse(row.data));
    } catch (err) {
      return cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmt.set.run(sid, JSON.stringify(sess), this.expiryOf(sess));
      return cb && cb(null);
    } catch (err) {
      return cb && cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      const row = this.stmt.get.get(sid);
      if (row) this.stmt.set.run(sid, row.data, this.expiryOf(sess));
      return cb && cb(null);
    } catch (err) {
      return cb && cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmt.del.run(sid);
      return cb && cb(null);
    } catch (err) {
      return cb && cb(err);
    }
  }

  length(cb) {
    try {
      return cb(null, this.stmt.count.get(Date.now()).n);
    } catch (err) {
      return cb(err);
    }
  }

  clear(cb) {
    try {
      this.stmt.clear.run();
      return cb && cb(null);
    } catch (err) {
      return cb && cb(err);
    }
  }

  close() {
    if (this.timer) clearInterval(this.timer);
  }
}
