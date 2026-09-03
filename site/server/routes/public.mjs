import { STUB_SECTIONS, SECTIONS } from '../lib/nav.mjs';
import {
  currentStandings,
  statusLabel,
  RATING_CONFIG,
  ERASED_LABEL,
} from '../lib/rating-service.mjs';
import { HOME_STATS, HOME_NEXT_EVENT } from '../lib/home-content.mjs';
import { OPERATOR, LEGAL_VERSION_LABEL, PUBLIC_DOCUMENTS } from '../lib/legal.mjs';
import { DIRECTORIES, listDirectory } from '../lib/directories.mjs';
import {
  publishedNews,
  newsById,
  tournamentList,
  tournamentParticipants,
  tournamentMatches,
  tournamentFiles,
  federationDocuments,
  galleryItems,
  isPubliclyVisibleUpload,
} from '../lib/content.mjs';
import { uploadById, sendUpload } from '../lib/uploads.mjs';

const LABELS = { erasedLabel: ERASED_LABEL };
const sectionFor = (path) => SECTIONS.find((s) => s.path === path);

export default function mountPublic(app, { db, config }) {
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
      // Турниры и новости на главной теперь ЖИВЫЕ — из своих таблиц.
      tournaments: tournamentList(db).slice(0, 5),
      news: publishedNews(db, 3),
      stats: HOME_STATS,
      nextEvent: HOME_NEXT_EVENT,
      rules: RATING_CONFIG,
    });
  });

  // --- новости -------------------------------------------------------------
  app.get('/news', (req, res) => {
    res.render('news-list', {
      title: 'Новости — ФТСО',
      news: publishedNews(db),
      section: sectionFor('/news'),
    });
  });

  app.get('/news/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    // publishedOnly: черновик по прямой ссылке наружу не отдаём.
    const item = newsById(db, Number(req.params.id), { publishedOnly: true });
    if (!item) return next();
    res.render('news-item', { title: `${item.title} — ФТСО`, item });
  });

  // --- турниры -------------------------------------------------------------
  app.get('/tournaments', (req, res) => {
    res.render('tournaments-list', {
      title: 'Турниры — ФТСО',
      tournaments: tournamentList(db),
      section: sectionFor('/tournaments'),
    });
  });

  app.get('/tournaments/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const tournament = db
      .prepare('SELECT id, name, end_date, category FROM tournaments WHERE id = ?')
      .get(Number(req.params.id));
    if (!tournament) return next(); // -> общий 404-обработчик
    res.status(200).render('tournament', {
      title: `${tournament.name} — ФТСО`,
      tournament,
      // Участники и матчи со ссылками на публичные профили /player/:id.
      participants: tournamentParticipants(db, tournament.id, LABELS),
      matches: tournamentMatches(db, tournament.id, LABELS),
      documents: tournamentFiles(db, tournament.id),
      section: sectionFor('/tournaments'),
    });
  });

  // --- справочники ---------------------------------------------------------
  for (const spec of Object.values(DIRECTORIES)) {
    app.get(spec.path, (req, res) => {
      res.render('directory', {
        title: `${spec.title} — ФТСО`,
        spec,
        rows: listDirectory(db, spec),
        section: sectionFor(spec.path),
      });
    });
  }

  // --- контентные разделы --------------------------------------------------
  app.get('/federation', (req, res) => {
    res.render('federation', {
      title: 'О Федерации — ФТСО',
      op: OPERATOR,
      documents: federationDocuments(db).filter((d) => /устав|учредит/i.test(d.category)),
      publicDocuments: PUBLIC_DOCUMENTS,
      section: sectionFor('/federation'),
    });
  });

  app.get('/documents', (req, res) => {
    const rows = federationDocuments(db);
    // Группировка по категориям — на сервере: шаблону остаётся только вывод.
    const byCategory = new Map();
    for (const row of rows) {
      if (!byCategory.has(row.category)) byCategory.set(row.category, []);
      byCategory.get(row.category).push(row);
    }
    res.render('documents', {
      title: 'Документы — ФТСО',
      groups: [...byCategory.entries()],
      // Регистрационные документы из открытых реестров — из кода, не из библиотеки.
      publicDocuments: PUBLIC_DOCUMENTS,
      section: sectionFor('/documents'),
    });
  });

  app.get('/gallery', (req, res) => {
    res.render('gallery', {
      title: 'Галерея — ФТСО',
      items: galleryItems(db),
      section: sectionFor('/gallery'),
    });
  });

  app.get('/contacts', (req, res) => {
    res.render('contacts', {
      title: 'Контакты — ФТСО',
      op: OPERATOR,
      section: sectionFor('/contacts'),
    });
  });

  /**
   * ПУБЛИЧНАЯ ОТДАЧА ФАЙЛА. Тем же защищённым путём, что и в админке:
   * файл лежит вне webroot, статикой не раздаётся, уходит как attachment с
   * nosniff. Публичным он считается ТОЛЬКО если привязан к опубликованной
   * сущности — документ заявки, ждущей модерации, сюда не попадёт.
   */
  app.get('/files/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const id = Number(req.params.id);
    if (!isPubliclyVisibleUpload(db, id)) return next();
    const row = uploadById(db, id);
    if (!row || !sendUpload(res, row, config.upload.dir)) return next();
  });

  // Заглушки ОСТАВШИХСЯ разделов: HTTP 200 (не 404) с корректным <title>.
  for (const section of STUB_SECTIONS) {
    app.get(section.path, (req, res) => {
      res.status(200).render('stub', {
        title: `${section.title} — ФТСО`,
        section,
      });
    });
  }

  // 152-ФЗ: эти страницы В объёме и реальны (не заглушки-«#»).
  // bodyView задаётся ЗДЕСЬ, из кода: в шаблон не должно попадать имя файла,
  // собранное из запроса, иначе include превратится в чтение произвольного пути.
  app.get('/privacy', (req, res) => {
    res.render('legal', {
      title: 'Политика обработки персональных данных — ФТСО',
      heading: 'Политика обработки персональных данных',
      bodyView: 'legal/privacy',
      op: OPERATOR,
      legalVersionLabel: LEGAL_VERSION_LABEL,
    });
  });

  app.get('/consent', (req, res) => {
    res.render('legal', {
      title: 'Согласие на обработку персональных данных — ФТСО',
      heading: 'Согласие на обработку персональных данных',
      bodyView: 'legal/consent',
      op: OPERATOR,
      legalVersionLabel: LEGAL_VERSION_LABEL,
    });
  });
}
