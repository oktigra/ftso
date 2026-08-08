import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb } from '../db/connect.mjs';
import { SqliteStore } from './lib/session-store.mjs';
import { csrfMiddleware } from './lib/csrf.mjs';
import { LoginAttempts } from './lib/login-attempts.mjs';
import { writeLimiter, publicFormLimiter } from './middleware/write-limit.mjs';
import { currentUser } from './middleware/auth.mjs';
import {
  HEADER_PRIMARY,
  HEADER_MORE,
  FOOTER_SECTIONS,
  FOOTER_PARTICIPANTS,
  FOOTER_LEGAL,
} from './lib/nav.mjs';
import { OPERATOR } from './lib/legal.mjs';
import { ValidationError } from './lib/validate.mjs';

import mountPublic from './routes/public.mjs';
import mountRegister from './routes/register.mjs';
import mountTournamentRequest from './routes/tournament-request.mjs';
import mountRating from './routes/rating.mjs';
import mountAuth from './routes/auth.mjs';
import mountAdmin from './routes/admin.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(config) {
  const db = getDb();
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', resolve(ROOT, 'views'));
  app.set('x-powered-by', false);

  // ОБРАТНЫЙ ПРОКСИ: прод за nginx/Caddy. Без trust proxy req.ip вернёт адрес
  // прокси (127.0.0.1) — блокировка по «логин+IP» схлопнется (все запросы = один
  // адрес), а Secure-cookie не распознает HTTPS.
  app.set('trust proxy', config.trustProxy);

  // nonce на запрос: инлайновый анти-FOUC скрипт темы должен пережить строгий CSP.
  app.use((req, res, next) => {
    res.locals.cspNonce = randomBytes(16).toString('base64');
    next();
  });

  // helmet — только БАЗА; CSP настраивается ВРУЧНУЮ.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          // img-src ... data: — под фоновое зерно из дизайна (SVG в data:-URI)
          'img-src': ["'self'", 'data:'],
          'script-src': ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
          'style-src': ["'self'"],
          // шрифты ЛОКАЛЬНЫЕ, внешних доменов нет
          'font-src': ["'self'"],
          'connect-src': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'object-src': ["'none'"],
        },
      },
      frameguard: { action: 'deny' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      // HSTS только за HTTPS в проде
      hsts: config.isProd ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ЛИМИТ ТЕЛА ЗАПРОСА: гигантский POST не должен класть память.
  app.use(express.urlencoded({ extended: false, limit: config.bodyLimit }));
  app.use(express.json({ limit: config.bodyLimit }));

  app.use(
    '/static',
    express.static(resolve(ROOT, 'public'), {
      maxAge: config.isProd ? '30d' : 0,
      index: false,
      dotfiles: 'ignore',
    }),
  );

  // Локали макета ставим ДО сессии и CSRF: страница ошибки использует шапку и
  // подвал, а отказ может случиться в самом csrfMiddleware — тогда без этих
  // значений упал бы уже рендер страницы ошибки и наружу ушёл бы стектрейс.
  app.use((req, res, next) => {
    res.locals.navPrimary = HEADER_PRIMARY;
    res.locals.navMore = HEADER_MORE;
    res.locals.footerSections = FOOTER_SECTIONS;
    res.locals.footerParticipants = FOOTER_PARTICIPANTS;
    res.locals.footerLegal = FOOTER_LEGAL;
    // Реквизиты оператора — ОДИН источник на весь сайт (подвал, юр-страницы,
    // «Контакты»): расхождение контактов оператора между страницами читается
    // как недостоверные сведения об операторе.
    res.locals.operator = OPERATOR;
    res.locals.currentPath = req.path;
    res.locals.year = new Date().getFullYear();
    res.locals.user = null;
    res.locals.csrfToken = '';
    next();
  });

  const store = new SqliteStore(db);
  app.use(
    session({
      name: 'ftso.sid',
      // МАССИВ секретов: первый подписывает, остальные принимают старые cookie ->
      // ротация секрета без разлогина всех.
      secret: config.sessionSecrets,
      store,
      resave: false,
      saveUninitialized: true, // анонимная сессия нужна, чтобы CSRF-токену GET /login было куда лечь
      rolling: true,
      cookie: {
        httpOnly: true,
        // Secure ПО СРЕДЕ: иначе в dev по HTTP вход не работает.
        secure: config.isProd,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 12,
      },
    }),
  );

  app.use(csrfMiddleware());

  const attempts = new LoginAttempts(db, config.login);
  const limitWrites = writeLimiter(db, config.write);

  // Текущий пользователь — только когда сессия уже разобрана.
  app.use((req, res, next) => {
    res.locals.user = currentUser(req);
    next();
  });

  const limitRegister = publicFormLimiter(db, config.register);
  // Счётчик СВОЙ (ключ «t»): поток заявок на турниры не должен съедать лимит
  // регистрации игроков и наоборот.
  const limitTournamentRequest = publicFormLimiter(db, { ...config.tournamentRequest, key: 't' });

  const ctx = { db, config, attempts, limitWrites, limitRegister, limitTournamentRequest, store };

  mountAuth(app, ctx);
  mountAdmin(app, ctx);
  mountRating(app, ctx);
  mountRegister(app, ctx);
  mountTournamentRequest(app, ctx);
  mountPublic(app, ctx);

  /**
   * Безопасный рендер страницы ошибки. Если сам шаблон почему-то не отрисовался,
   * отдаём минимальную страницу — но НИКОГДА не даём Express свалиться в свой
   * дефолтный обработчик, который в dev печатает стектрейс прямо в ответ.
   */
  function renderSafe(res, view, locals, status, fallbackText) {
    res.status(status).render(view, locals, (err, html) => {
      if (!err) return res.send(html);
      console.error('[ошибка рендера страницы ошибки]', err);
      res.type('html').send(
        '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">' +
          `<title>Ошибка ${status} — ФТСО</title></head><body>` +
          `<h1>Ошибка ${status}</h1><p>${fallbackText}</p>` +
          '<p><a href="/">На главную</a></p></body></html>',
      );
    });
  }

  // 404 — своя страница в стиле сайта, HTTP 404.
  app.use((req, res) => {
    renderSafe(res, 'errors/404', { title: 'Страница не найдена — ФТСО' }, 404, 'Страница не найдена.');
  });

  // 500 — своя страница; наружу НЕ утекает стектрейс/детали, они пишутся в лог сервера.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || (err instanceof ValidationError ? 400 : 500);
    if (status >= 500) console.error('[ошибка]', err);
    else console.warn(`[${status}]`, err.message);

    const message =
      err.publicMessage ||
      (err instanceof ValidationError
        ? err.message
        : status === 403
          ? 'Недостаточно прав.'
          : status === 404
            ? 'Страница не найдена.'
            : 'Внутренняя ошибка сервера. Мы уже знаем о ней.');

    if (res.headersSent) return;
    renderSafe(res, 'errors/error', { title: `Ошибка ${status} — ФТСО`, status, message }, status, message);
  });

  app.locals.closeStore = () => store.close();
  return app;
}
