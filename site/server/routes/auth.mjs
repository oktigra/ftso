import { verifyPassword, burnDummyHash } from '../lib/password.mjs';
import { redirectIfAuthed } from '../middleware/auth.mjs';
import { logAction } from '../lib/action-log.mjs';
import { acctKey } from '../lib/login-attempts.mjs';
import { safeLocalPath } from '../lib/safe-path.mjs';

/** next разрешаем только как локальный путь — не открытый редирект. */
const safeNext = (value) => safeLocalPath(value, '/admin');

export default function mountAuth(app, { db, config, attempts, limitWrites }) {
  app.get('/login', redirectIfAuthed, (req, res) => {
    // Анонимная сессия уже создана (saveUninitialized) и CSRF-токен положен
    // csrfMiddleware — иначе проверке на POST не с чем сверяться.
    res.render('login', {
      title: 'Вход — ФТСО',
      error: null,
      username: '',
      next: safeNext(req.query.next),
    });
  });

  app.post('/login', limitWrites, (req, res, next) => {
    const username = String(req.body.username || '').trim().slice(0, 120);
    const password = String(req.body.password || '');
    let target = safeNext(req.body.next);
    const ip = req.ip;

    const deny = (error, status = 401) =>
      res.status(status).render('login', { title: 'Вход — ФТСО', error, username, next: target });

    if (!username || !password) return deny('Введите логин и пароль.', 400);

    if (attempts.blocked(username, ip)) {
      const until = attempts.lockedUntil(acctKey(username, ip));
      return deny(
        `Слишком много неудачных попыток. Вход временно заблокирован${until ? ` до ${until} UTC` : ''}.`,
        429,
      );
    }

    const user = db
      .prepare('SELECT id, username, password_hash, role, must_change_password FROM users WHERE username = ?')
      .get(username);

    // Несуществующий логин: ВСЁ РАВНО считаем scrypt от dummy-значения, чтобы
    // время ответа не отличалось от «логин есть, пароль неверный».
    const ok = user ? verifyPassword(password, user.password_hash) : (burnDummyHash(password), false);

    if (!ok) {
      attempts.registerFailure(username, ip);
      return deny('Неверный логин или пароль.');
    }

    // Session fixation: ротируем session ID ДО записи данных сессии.
    req.session.regenerate((err) => {
      if (err) return next(err);
      attempts.registerSuccess(username, ip);
      req.session.user = { id: user.id, username: user.username, role: user.role, mustChangePassword: Boolean(user.must_change_password) };
      if (user.must_change_password) target = '/admin/account?change=1';
      logAction(db, user.id, 'login', user.id, null);
      req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect(target)));
    });
  });

  // Logout уничтожает СЕРВЕРНУЮ сессию: старый перехваченный cookie больше не валиден.
  app.post('/logout', limitWrites, (req, res, next) => {
    const user = req.session.user;
    if (user) logAction(db, user.id, 'logout', user.id, null);
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ftso.sid', {
        httpOnly: true,
        secure: config.isProd,
        sameSite: 'lax',
      });
      res.redirect('/login');
    });
  });
}
