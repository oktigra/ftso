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

/**
 * СУДЬЯ ТУРНИРА: сессия без учётной записи (req.session.judge = {tournamentId, tokenId,
 * expiresAt}). Пускается только на маршруты ввода счёта СВОЕГО турнира — группы, сетка,
 * протокол, файлы, страница результатов; всё остальное в админке — 403.
 */
const JUDGE_ALLOWED = [
  ['GET', /^\/admin\/tournaments\/(\d+)\/results$/],
  ['POST', /^\/admin\/tournaments\/(\d+)\/groups\/\d+\/(cell|members|members\/\d+\/delete)$/],
  ['POST', /^\/admin\/tournaments\/(\d+)\/brackets\/\d+\/(decide|undo|seed|unseed|swap)$/],
  ['POST', /^\/admin\/tournaments\/(\d+)\/protocol\/import$/],
  ['GET', /^\/admin\/tournaments\/(\d+)\/(bracket\.pdf|bracket\.docx|protocol\.xlsx|print)$/],
];
export function judgeAllows(req) {
  const j = req.session && req.session.judge;
  if (!j || !j.expiresAt || j.expiresAt < new Date().toISOString()) return false;
  for (const [method, re] of JUDGE_ALLOWED) {
    if (req.method !== method) continue;
    const m = re.exec(req.path);
    if (m && Number(m[1]) === j.tournamentId) return true;
  }
  return false;
}

/** Требует вход + одну из ролей. Роль передаётся явно на каждом маршруте. */
export function requireRole(...allowed) {
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user && judgeAllows(req)) {
      res.locals.judgeMode = true;
      return next();
    }
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
