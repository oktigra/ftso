// Роли и гейтинг админ-маршрутов.
// Гейтинг ОДНОЗНАЧНЫЙ:
//   публичные страницы разделов — БЕЗ входа (они публичные);
//   админ-маршрут, не залогинен -> редирект на /login;
//   админ-маршрут, залогинен, но роль не та -> 403.
// Каждая админ-точка несёт требуемую роль ЯВНО.

export const ROLES = ['super-admin', 'content-manager', 'news-editor', 'tournament-admin'];

// В ЭТОМ шаге рабочие роли — super-admin и tournament-admin.
// content-manager и news-editor заведены, но НЕ подключены: их матрица доступа
// определяется, когда придут их разделы.
export const ACTIVE_ROLES = ['super-admin', 'tournament-admin'];

export function currentUser(req) {
  return req.session && req.session.user ? req.session.user : null;
}

/** Требует вход + одну из ролей. Роль передаётся явно на каждом маршруте. */
export function requireRole(...allowed) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) {
      const back = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?next=${back}`);
    }
    if (!allowed.includes(user.role)) {
      const err = new Error(`Роль ${user.role} не допущена к ${req.originalUrl}`);
      err.status = 403;
      err.publicMessage = 'Недостаточно прав для этого раздела.';
      return next(err);
    }
    // Временный пароль (выдан скриптом): пока не сменён — только страница смены.
    if (user.mustChangePassword && !req.path.startsWith('/admin/account') && req.path !== '/logout') {
      return res.redirect('/admin/account?change=1');
    }
    return next();
  };
}

/** Уже вошёл — на /login делать нечего. */
export function redirectIfAuthed(req, res, next) {
  if (currentUser(req)) return res.redirect('/admin');
  return next();
}
