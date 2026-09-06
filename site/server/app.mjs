import express from 'express';
import { seoFor, SEO_DEFAULTS } from './lib/seo.mjs';
import { activePartners } from './lib/partners.mjs';
import { FAQ } from './lib/faq.mjs';
import { siteText } from './lib/texts.mjs';
import session from 'express-session';
import helmet from 'helmet';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getDb } from '../db/connect.mjs';
import { SqliteStore } from './lib/session-store.mjs';
import { csrfMiddleware } from './lib/csrf.mjs';
import { LoginAttempts } from './lib/login-attempts.mjs';
import { writeLimiter, publicFormLimiter } from './middleware/write-limit.mjs';
import { currentUser, ROLE_SECTIONS } from './middleware/auth.mjs';
import { intakeGate } from './middleware/intake-gate.mjs';
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
import mountCabinet from './routes/cabinet.mjs';
import mountRating from './routes/rating.mjs';
import mountPlayer from './routes/player.mjs';
import mountServiceFiles from './routes/service-files.mjs';
import mountAuth from './routes/auth.mjs';
import mountAdmin from './routes/admin.mjs';
import mountAdminContent from './routes/admin-content.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Показывать ли плашку «режим разработки»: принудительно по DEV_NOTICE=1 либо
 * автоматически, пока на сайте нет ни одного результата соревнований —
 * «наполнение» меряется по факту, а не по флагу, который на бою некому снять.
 * Запрос — LIMIT 1 по таблице, микросекунды; кэша нарочно нет, чтобы плашка
 * ушла тем же запросом, что показал первый результат.
 */
/** Инициалы: первые буквы двух первых слов ФИО («Коротков Олег Александрович» → «КО»). */
export function initialsOf(fullName) {
  return String(fullName || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

/** Кому показывать инициалы: игрок → кабинет, представитель → кабинет, сотрудник админки → админка. */
function headerAccount(db, req) {
  const s = req.session || {};
  if (s.player && s.player.playerId) {
    const p = db.prepare('SELECT full_name FROM players WHERE id = ?').get(s.player.playerId);
    if (p) return { href: '/cabinet', initials: initialsOf(p.full_name), title: p.full_name };
  }
  if (s.guardian && s.guardian.guardianId) {
    const g = db.prepare('SELECT full_name FROM guardians WHERE id = ?').get(s.guardian.guardianId);
    if (g) return { href: '/cabinet', initials: initialsOf(g.full_name), title: `${g.full_name} (представитель)` };
  }
  if (s.user && s.user.username) return { href: '/admin', initials: initialsOf(s.user.username), title: `${s.user.username} · админка` };
  return null;
}

/** Домены Метрики для CSP: скрипт — .ru, хит визита и cookie-sync — .com. */
export const METRIKA_HOSTS = ['https://mc.yandex.ru', 'https://mc.yandex.com'];

/**
 * ПЛАШКА «САЙТ В РАЗРАБОТКЕ» (решение владельца 06.09.2026 после двух самопроизвольных
 * пропаж): висит, ПОКА ВЛАДЕЛЕЦ САМ НЕ СНИМЕТ. Никакой автоматики — только режимы
 * on (по умолчанию) и off, переключатель в «Сводке» админки. DEV_NOTICE=1 в .env
 * держит плашку принудительно даже при off.
 * Режим 'auto' из прежней редакции понимается как 'on' (плашку не снимает).
 */
export function devNoticeMode(db) {
  const row = db.prepare("SELECT value FROM site_settings WHERE key = 'dev_notice'").get();
  return row?.value === 'off' ? 'off' : 'on';
}

export function devNoticeOn(db, config) {
  if (config.devNotice) return true;
  return devNoticeMode(db) === 'on';
}

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

  // Камера, микрофон и геолокация сайту не нужны — запрещаем явно: чужой скрипт,
  // попади он на страницу, не сможет запросить их от имени сайта.
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
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
          // Яндекс.Метрика — единственная внешняя зависимость, и только когда счётчик
          // задан. tag.js грузится с mc.yandex.ru, а ХИТ визита (/watch) и синк cookie
          // уходят на mc.yandex.com — без него счётчик молча теряет визиты (замер
          // 05.09.2026: tag.js 200, watch отбит CSP). Пара доменов Яндекса — ровно две.
          'img-src': ["'self'", 'data:', ...(config.metrikaId ? METRIKA_HOSTS : [])],
          'script-src': ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`, ...(config.metrikaId ? METRIKA_HOSTS : [])],
          'style-src': ["'self'"],
          // шрифты ЛОКАЛЬНЫЕ, внешних доменов нет
          'font-src': ["'self'"],
          'connect-src': ["'self'", ...(config.metrikaId ? METRIKA_HOSTS : [])],
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

  // ВЕРСИЯ СТАТИКИ: кэш /static живёт 30 дней, поэтому app.js и site.css подключаются
  // с ?v=<хэш содержимого> — после выката адрес меняется и браузеры берут свежий файл.
  const assetVersion = createHash('md5')
    .update(readFileSync(resolve(ROOT, 'public/js/app.js')))
    .update(readFileSync(resolve(ROOT, 'public/css/site.css')))
    .digest('hex').slice(0, 8);
  app.locals.assetVersion = assetVersion;

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
    res.locals.maxUrl = config.maxUrl;
    res.locals.rememberDays = config.rememberDays;
    // Метрика: номер счётчика и решение посетителя из cookie ftso.analytics
    // ('1' принял, '0' отказался, нет — баннер). Куки читаем сами: парсер не подключён.
    res.locals.metrikaId = config.metrikaId;
    const m = /(?:^|;\s*)ftso\.analytics=([01])/.exec(req.headers.cookie || '');
    res.locals.analyticsChoice = m ? m[1] : '';
    res.locals.currentPath = req.path;
    // Канонический адрес: боевой домен из конфига + путь без query и без «/» в конце.
    res.locals.siteUrl = config.siteUrl.replace(/\/$/, '');
    res.locals.canonicalUrl = res.locals.siteUrl + (req.path === '/' ? '/' : req.path.replace(/\/+$/, ''));
    res.locals.year = new Date().getFullYear();
    res.locals.user = null;
    res.locals.sections = [];
    res.locals.csrfToken = '';
    // Состояние рубильника — в шаблоны: от него зависит текст баннера.
    res.locals.intakeEnabled = config.intakeEnabled;
    res.locals.cabinetSignedIn = false; // сессии здесь ещё нет — выставляется ниже, после session()
    // Баннер только на публичной части: в админке он бесполезен, а на узких
    // админ-таблицах ещё и мешает. Держится САМ, пока сайт не наполнен
    // (решение владельца 04.09: «до наполнения»), — переменной на сервере
    // крутить некому. DEV_NOTICE=1 — принудительно.
    res.locals.devNotice = !req.path.startsWith('/admin') && devNoticeOn(db, config);
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
    // Судья по временной ссылке: отозванная или просроченная ссылка гасит сессию сразу.
    if (req.session && req.session.judge) {
      const j = db.prepare('SELECT revoked_at, expires_at FROM judge_tokens WHERE id = ?').get(req.session.judge.tokenId);
      if (!j || j.revoked_at || j.expires_at < new Date().toISOString()) delete req.session.judge;
    }
    res.locals.user = currentUser(req);
    // Кнопка «Вход» в шапке: игрок или представитель уже в кабинете — «Кабинет».
    res.locals.cabinetSignedIn = Boolean(req.session && (req.session.player || req.session.guardian));
    // КНОПКА АККАУНТА В ШАПКЕ (решение владельца 06.09.2026): вошёл — инициалы
    // (первые буквы фамилии и имени) вместо «Вход»; не вошёл — «Вход».
    res.locals.headerAccount = headerAccount(db, req);
    // SEO (ТЗ п. 5): правка из админки по адресу + заготовка раздела.
    // Партнёры — в подвал на всех публичных страницах и в полосу главной.
    res.locals.partners = req.path.startsWith('/admin') ? [] : activePartners(db);
    res.locals.faq = FAQ;
    res.locals.partnersTitle = siteText(db, 'partners-title');
    res.locals.partnersCta = siteText(db, 'partners-cta');
    res.locals.seo = seoFor(db, req.path);
    res.locals.seoDefault = SEO_DEFAULTS[req.path] || '';
    res.locals.sections = res.locals.user ? ROLE_SECTIONS[res.locals.user.role] || [] : [];
    next();
  });

  const limitRegister = publicFormLimiter(db, config.register);
  // Счётчик СВОЙ (ключ «t»): поток заявок на турниры не должен съедать лимит
  // регистрации игроков и наоборот.
  const limitTournamentRequest = publicFormLimiter(db, { ...config.tournamentRequest, key: 't' });
  // Форма обратной связи — те же лимиты, что у регистрации, свой ключ.
  const limitFeedback = publicFormLimiter(db, { ...config.register, key: 'f' });
  // И у кабинета свой (ключ «c»): подбор пароля не должен закрывать приём заявок.
  const limitCabinet = publicFormLimiter(db, { ...config.cabinet, key: 'c' });

  const ctx = {
    db, config, attempts, limitWrites, limitRegister, limitTournamentRequest, limitFeedback, limitCabinet, store,
  };

  // РУБИЛЬНИК — до монтирования маршрутов, чтобы ни один обработчик приёма ПДн
  // не получил управление при выключенном приёме. Состояние читается на каждый
  // запрос: тесты переключают его без перезапуска приложения.
  app.use(intakeGate(() => config.intakeEnabled));

  mountAuth(app, ctx);
  mountAdmin(app, ctx);
  mountAdminContent(app, ctx);
  mountRating(app, ctx);
  mountPlayer(app, ctx);
  mountServiceFiles(app, { ...ctx, root: ROOT });
  mountRegister(app, ctx);
  mountTournamentRequest(app, ctx);
  mountCabinet(app, ctx);
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
