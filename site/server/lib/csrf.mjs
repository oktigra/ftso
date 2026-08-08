// CSRF: синхронизирующий токен. Кладётся в сессию, ставится скрытым полем в
// КАЖДОЙ форме (включая /login — иначе login CSRF: жертву логинят под аккаунтом
// атакующего) и проверяется на КАЖДОМ POST. express-session сам CSRF не закрывает.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function csrfToken(req) {
  if (!req.session) throw new Error('csrfToken: сессии нет — session middleware должен идти раньше');
  if (!req.session.csrfToken) req.session.csrfToken = randomBytes(32).toString('base64url');
  return req.session.csrfToken;
}

/**
 * Сверка присланного токена с сессионным. Вынесена наружу, потому что для
 * multipart-форм тело разбирается ПОЗЖЕ общего middleware, и проверку делает
 * парсер формы (lib/multipart.mjs) — но по этой же функции, а не по своей.
 */
export function csrfMatches(req, sent) {
  return Boolean(req.session) && sameToken(sent, req.session.csrfToken);
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Анонимная сессия ДОЛЖНА существовать до рендера GET /login, чтобы токену было
 * куда лечь — иначе проверка тихо ломается. Поэтому токен генерим на любом GET.
 */
export function csrfMiddleware() {
  return (req, res, next) => {
    res.locals.csrfToken = csrfToken(req);
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    // MULTIPART: тела здесь ещё нет — express.urlencoded такие запросы не
    // разбирает. Проверку делает parseMultipart сразу после разбора полей;
    // без неё поля формы получить нечем, поэтому пропустить её невозможно.
    if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();

    const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
    if (!sameToken(sent, req.session.csrfToken)) {
      const err = new Error('CSRF-токен отсутствует или неверен');
      err.status = 403;
      err.publicMessage = 'Форма устарела или отправлена не с этого сайта. Обновите страницу и повторите.';
      return next(err);
    }
    return next();
  };
}
