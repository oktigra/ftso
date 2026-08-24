/**
 * РУБИЛЬНИК ПРИЁМА ПЕРСОНАЛЬНЫХ ДАННЫХ.
 *
 * Оператор — РФСОО «ФТСО» — на 23.08.2026 отсутствует в реестре операторов
 * Роскомнадзора. По ст. 22 152-ФЗ уведомление подаётся ДО начала обработки;
 * штраф для юрлица 100–300 тыс. ₽. Плюс домен ещё без сертификата.
 *
 * Пункт 11 «Порядка к запуску» (BACKLOG.md) требует: публичный приём реальных
 * ПДн открывается только после SSL. Этот модуль — механизм того пункта.
 *
 * ПРИНЦИП: код за рубильником полностью рабочий и законный. Выключен ровно один
 * флаг. Включение INTAKE_ENABLED=1 не требует ни одной правки кода.
 *
 * ПОЧЕМУ MIDDLEWARE, А НЕ ПРОВЕРКИ В ОБРАБОТЧИКАХ: список закрытых маршрутов
 * должен читаться одним взглядом. Проверка, размазанная по двадцати
 * обработчикам, рано или поздно потеряет один из них — а потерянный маршрут
 * здесь означает незаконную обработку.
 */

/**
 * GET-маршруты, где вместо формы показывается заглушка.
 * Точное совпадение пути либо префикс (для :token и вложенных).
 */
export const CLOSED_GET = [
  '/register',
  '/tournament-request',
  '/cabinet', // включая /cabinet/login, /cabinet/forgot, /cabinet/reset/:token, /cabinet/photo
];

/**
 * POST-маршруты, отклоняемые ДО записи в БД, отправки почты и сохранения файлов.
 *
 * ВАЖНО, ЧТО СЮДА ВХОДИТ АДМИНКА. Ручное заведение игрока секретарём — такая же
 * обработка ПДн, как и публичная форма, и наличие бумажного согласия её не
 * легализует, пока нет уведомления РКН. Поэтому ПДн-действия админки закрыты,
 * а контентные (новости, турниры, документы, справочники объектов) — открыты:
 * наполнять сайт содержимым закон не мешает.
 */
export const CLOSED_POST = [
  // Публичные формы
  '/register',
  '/tournament-request',
  // Личный кабинет игрока целиком (вход, восстановление, профиль, удаление)
  '/cabinet',
  // ПДн-действия админки
  '/admin/players',
  '/admin/registrations',
  '/admin/tournament-requests',
  // Пересчёт рейтинга — обработка данных игроков
  '/admin/rating/recompute',
  // Справочники людей: тренеры и судьи — публикация ФИО (ст. 10.1)
  '/admin/directories/coaches',
  '/admin/directories/referees',
];

/**
 * НЕ закрывается никогда — перечислено явно, чтобы случайный префикс не съел:
 *  /login, /logout        — вход АДМИНА (у игрока свой вход, /cabinet/login);
 *  /admin/account/*       — админ обязан мочь сменить себе пароль;
 *  /admin/users/*         — учётки сотрудников, нужны для работы с контентом;
 *  /privacy, /consent     — правовые тексты доступны в любом состоянии;
 *  /cookies               — состав cookie доступен всегда;
 *  публичный просмотр     — новости, турниры, рейтинг, справочники, документы.
 */
export const NEVER_CLOSED = [
  '/login',
  '/logout',
  '/admin/account',
  '/admin/users',
  '/privacy',
  '/consent',
  '/cookies',
];

function matches(path, list) {
  return list.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Закрыт ли путь при выключенном приёме (для тестов и шаблонов). */
export function isClosedPath(path, method = 'GET') {
  if (matches(path, NEVER_CLOSED)) return false;
  return matches(path, method === 'POST' ? CLOSED_POST : CLOSED_GET);
}

export const CLOSED_TITLE = 'Приём заявок временно закрыт — ФТСО';

export const CLOSED_MESSAGE =
  'Приём заявок временно закрыт. Сайт находится в режиме разработки. ' +
  'Регистрация игроков, подача заявок на турниры и личный кабинет откроются ' +
  'после завершения подготовки.';

/**
 * @param {() => boolean} isEnabled читается на каждый запрос, чтобы тесты могли
 *   переключать состояние без перезапуска приложения.
 */
export function intakeGate(isEnabled) {
  return function intakeGateMiddleware(req, res, next) {
    if (isEnabled()) return next();

    const path = req.path;
    if (matches(path, NEVER_CLOSED)) return next();

    if (req.method === 'POST' && matches(path, CLOSED_POST)) {
      // 403, а не 500 и не тихий редирект: отправитель должен понять, что
      // произошло, а мониторинг — отличить отказ по правилу от поломки.
      return res.status(403).render('intake-closed', {
        title: CLOSED_TITLE,
        message: CLOSED_MESSAGE,
        rejected: true,
      });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && matches(path, CLOSED_GET)) {
      // 200: страница существует и осмысленна. 503 сломал бы индексацию
      // и подмешал ложную тревогу в uptime-мониторинг.
      return res.status(200).render('intake-closed', {
        title: CLOSED_TITLE,
        message: CLOSED_MESSAGE,
        rejected: false,
      });
    }

    return next();
  };
}
