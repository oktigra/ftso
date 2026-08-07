import { STUB_SECTIONS, SECTIONS } from '../lib/nav.mjs';
import { currentStandings, statusLabel, RATING_CONFIG } from '../lib/rating-service.mjs';
import { HOME_TOURNAMENTS, HOME_NEWS, HOME_STATS, HOME_NEXT_EVENT } from '../lib/home-content.mjs';

export default function mountPublic(app, { db }) {
  // Главная — по утверждённому дизайну. Живой блок один: ТОП-5 рейтинга.
  app.get('/', (req, res) => {
    const standings = currentStandings(db);
    res.render('home', {
      title: 'Федерация тенниса Смоленской области — официальный сайт',
      // Пустой rating_cache (ещё ни разу не считали) -> витрина показывает
      // «рейтинг ещё не рассчитан», а не 500.
      top5: standings ? standings.players.slice(0, 5) : [],
      standings,
      statusText: standings ? statusLabel(standings.status) : null,
      // Блоки турниров и новостей на главной — ПОКА статичное содержимое дизайна:
      // реальные данные подключим, когда придут эти модули.
      tournaments: HOME_TOURNAMENTS,
      news: HOME_NEWS,
      stats: HOME_STATS,
      nextEvent: HOME_NEXT_EVENT,
      rules: RATING_CONFIG,
    });
  });

  // Заглушки разделов: HTTP 200 (не 404) с корректным <title> — иначе поисковик
  // не проиндексирует URL. БЕЗ входа: публичные страницы разделов публичны.
  for (const section of STUB_SECTIONS) {
    app.get(section.path, (req, res) => {
      res.status(200).render('stub', {
        title: `${section.title} — ФТСО`,
        section,
      });
    });
  }

  // Динамическая карточка турнира. Маршрут-заглушка: оживёт с модулем турниров.
  // Несуществующий id -> 404 в стиле сайта, не дефолтный Express.
  app.get('/tournaments/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const tournament = db
      .prepare('SELECT id, name, end_date, category FROM tournaments WHERE id = ?')
      .get(Number(req.params.id));
    if (!tournament) return next(); // -> общий 404-обработчик
    res.status(200).render('tournament', {
      title: `${tournament.name} — ФТСО`,
      tournament,
      section: SECTIONS.find((s) => s.path === '/tournaments'),
    });
  });

  // 152-ФЗ: эти страницы В объёме и реальны (не заглушки-«#»).
  app.get('/privacy', (req, res) => {
    res.render('legal', {
      title: 'Политика конфиденциальности — ФТСО',
      heading: 'Политика конфиденциальности',
      kind: 'privacy',
    });
  });

  app.get('/consent', (req, res) => {
    res.render('legal', {
      title: 'Согласие на обработку персональных данных — ФТСО',
      heading: 'Согласие на обработку персональных данных',
      kind: 'consent',
    });
  });
}
