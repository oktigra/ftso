// Роли и гейтинг админ-маршрутов.
// Гейтинг ОДНОЗНАЧНЫЙ:
//   публичные страницы разделов — БЕЗ входа (они публичные);
//   админ-маршрут, не залогинен -> редирект на /login;
//   админ-маршрут, залогинен, но роль не та -> 403.
// Каждая админ-точка несёт требуемую роль ЯВНО.

export const ROLES = ['super-admin', 'content-manager', 'news-editor', 'tournament-admin'];

// С 04.09.2026 рабочие все четыре роли. МАТРИЦА РАЗДЕЛОВ — единственный источник
// и для меню, и для проверок в маршрутах (requireRole получает наборы отсюда):
//   super-admin      — всё, включая пользователей и закрытые документы;
//   tournament-admin — игроки, заявки, турниры, рейтинг (данные спортсменов) + справочники,
//                      библиотека, обращения;
//   content-manager  — новости, справочники, документы и галерея, обращения; к ПДн игроков нет;
//   news-editor      — только новости.
export const ACTIVE_ROLES = [...ROLES];
export const ROLE_SECTIONS = {
  'super-admin': ['dashboard', 'players', 'registrations', 'tournaments', 'tournament-requests', 'rating', 'news', 'directories', 'library', 'feedback', 'account', 'vault', 'users'],
  'tournament-admin': ['dashboard', 'players', 'registrations', 'tournaments', 'tournament-requests', 'rating', 'directories', 'library', 'feedback', 'account'],
  'content-manager': ['dashboard', 'news', 'directories', 'library', 'feedback', 'account'],
  'news-editor': ['dashboard', 'news', 'account'],
};
/** Роли, которым открыт раздел, — для requireRole(...rolesFor('players')). */
export function rolesFor(section) {
  return ROLES.filter((r) => (ROLE_SECTIONS[r] || []).includes(section));
}

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
