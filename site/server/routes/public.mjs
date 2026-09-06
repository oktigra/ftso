import { STUB_SECTIONS, SECTIONS } from '../lib/nav.mjs';
import {
  currentStandings,
  statusLabel,
  RATING_CONFIG,
  ERASED_LABEL,
} from '../lib/rating-service.mjs';
import { OPERATOR, LEGAL_VERSION, LEGAL_VERSION_LABEL, PUBLIC_DOCUMENTS } from '../lib/legal.mjs';
import { feedbackInput, createFeedback } from '../lib/feedback.mjs';
import { queueMail } from '../lib/mailer.mjs';
import {
  ValidationError, CATEGORIES, TOURNAMENT_KINDS, TOURNAMENT_KIND_RU, TOURNAMENT_STATUSES, TOURNAMENT_STATUS_RU, TOURNAMENT_SEX_RU,
} from '../lib/validate.mjs';
import { DIRECTORIES, listDirectory, directoryFilterOptions } from '../lib/directories.mjs';
import { descriptionFrom } from '../lib/seo.mjs';
import { siteSearch } from '../lib/search.mjs';
import { FAQ } from '../lib/faq.mjs';
import { siteText, paragraphs } from '../lib/texts.mjs';
import { listGroups, scoreFor } from '../lib/groups.mjs';
import { listBrackets } from '../lib/brackets.mjs';
import { mountTournamentSheets } from '../lib/tournament-sheet-routes.mjs';
import {
  publishedNews,
  newsById,
  newsAttachments,
  NEWS_CATEGORIES,
  tournamentList,
  tournamentFilterOptions,
  homeStats,
  homeNextEvent,
  homeTournaments,
  recentMatches,
  siteAsset,
  tournamentParticipants,
  tournamentMatches,
  tournamentFiles,
  federationDocuments,
  galleryItems,
  isPubliclyVisibleUpload,
} from '../lib/content.mjs';
import { uploadById, sendUpload, sendUploadInline } from '../lib/uploads.mjs';

const LABELS = { erasedLabel: ERASED_LABEL };
const sectionFor = (path) => SECTIONS.find((s) => s.path === path);

export default function mountPublic(app, { db, config, limitFeedback }) {
  // Главная — по утверждённому дизайну. Живой блок один: ТОП-5 рейтинга.
  app.get('/', (req, res) => {
    const standings = currentStandings(db);
    res.render('home', {
      title: 'Федерация тенниса Смоленской области — официальный сайт',
      // Пустой rating_cache (ещё ни разу не считали) -> витрина показывает
      // «рейтинг ещё не рассчитан», а не 500.
      top5: standings ? standings.players.slice(0, 5) : [],
      topBySex: standings ? { M: standings.players.filter((p) => p.sex === 'M').slice(0, 10), F: standings.players.filter((p) => p.sex === 'F').slice(0, 10), all: standings.players.slice(0, 10) } : { M: [], F: [], all: [] },
      homeTournaments: homeTournaments(db, 4),
      recentMatches: recentMatches(db, 8).map((m) => ({ ...m, scoreShown: scoreFor(m.score, true) })),
      myRatingHref: req.session && req.session.player ? `/player/${req.session.player.playerId}` : '/rating',
      standings,
      statusText: standings ? statusLabel(standings.status) : null,
      // Турниры и новости на главной теперь ЖИВЫЕ — из своих таблиц.
      tournaments: tournamentList(db).slice(0, 5),
      news: publishedNews(db, 3),
      heroUploadId: siteAsset(db, 'home-hero'),
      texts: {
        title: siteText(db, 'home-title'),
        lead: siteText(db, 'home-lead'),
        tournamentsLead: siteText(db, 'home-tournaments-lead'),
        cabinetLead: siteText(db, 'home-cabinet-lead'),
      },
      stats: homeStats(db, standings),
      nextEvent: homeNextEvent(db),
      rules: RATING_CONFIG,
    });
  });

  // --- новости -------------------------------------------------------------
  app.get('/news', (req, res) => {
    // Поиск по новостям (ТЗ 4.2): заголовок, анонс, текст. Обычная GET-форма.
    const q = String(req.query.q || '').trim().slice(0, 80);
    res.render('news-list', {
      title: 'Новости — ФТСО',
      news: publishedNews(db, 50, q, String(req.query.category || '')),
      q,
      category: NEWS_CATEGORIES[String(req.query.category || '')] ? String(req.query.category) : '',
      categories: NEWS_CATEGORIES,
      section: sectionFor('/news'),
    });
  });

  // Фото баннера главной (загружается в админке, «Документы и галерея»).
  app.get('/partners/:id/logo', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const row = db.prepare('SELECT logo_upload_id FROM partners WHERE id = ? AND is_active = 1').get(Number(req.params.id));
    if (!row || !row.logo_upload_id) return next();
    const upload = uploadById(db, row.logo_upload_id);
    if (!upload || !sendUploadInline(req, res, upload, config.upload.dir)) return next();
  });

  app.get('/site/hero', (req, res, next) => {
    const id = siteAsset(db, 'home-hero');
    if (!id) return next();
    const upload = uploadById(db, id);
    if (!upload || !sendUploadInline(req, res, upload, config.upload.dir)) return next();
  });

  app.get('/news/:id/cover', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const item = newsById(db, Number(req.params.id), { publishedOnly: true });
    if (!item || !item.cover_upload_id) return next();
    const upload = uploadById(db, item.cover_upload_id);
    if (!upload || !sendUploadInline(req, res, upload, config.upload.dir)) return next();
  });

  app.get('/news/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    // publishedOnly: черновик по прямой ссылке наружу не отдаём.
    const item = newsById(db, Number(req.params.id), { publishedOnly: true });
    if (!item) return next();
    res.render('news-item', {
      title: `${item.title} — ФТСО`,
      metaDescription: descriptionFrom(item.summary || item.body),
      item,
      attachments: newsAttachments(db, item.id),
    });
  });

  // --- турниры -------------------------------------------------------------
  // ОРГАНИЗАТОРАМ И СЕКРЕТАРЯМ (06.09.2026): одна страница, где собрано всё, что уже есть —
  // заявка на проведение, протокол, как результаты попадают в рейтинг, FAQ.
  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 80);
    res.render('search', { title: q ? `«${q}» — поиск — ФТСО` : 'Поиск по сайту — ФТСО', metaDescription: 'Поиск по турнирам, игрокам, новостям, тренерам, кортам и клубам Федерации тенниса Смоленской области.', result: siteSearch(db, q), section: null });
  });

  app.get('/faq', (req, res) => {
    res.render('faq', {
      title: 'Вопросы и ответы — ФТСО',
      metaDescription: 'Как попасть в рейтинг, зарегистрировать ребёнка, заявить турнир и где взять бланк протокола — короткие ответы Федерации тенниса Смоленской области.',
      faq: FAQ,
      section: null,
    });
  });

  app.get('/organizers', (req, res) => {
    res.render('organizers', {
      title: 'Организаторам и секретарям турниров — ФТСО',
      metaDescription: 'Как заявить турнир в календарь Федерации тенниса Смоленской области, скачать протокол, передать результаты для рейтинга: пошагово и ответы на частые вопросы.',
      op: OPERATOR,
      section: null,
    });
  });

  app.get('/tournaments', (req, res) => {
    // Фильтры — только из известных значений: чужая строка в SQL не попадает,
    // а невалидная молча сбрасывается в «все».
    const q = (k, max = 40) => String(req.query[k] || '').trim().slice(0, max);
    const filters = {
      month: /^\d{4}-\d{2}$/.test(q('month')) ? q('month') : '',
      city: q('city', 80),
      category: CATEGORIES.includes(q('category')) ? q('category') : '',
      age: q('age'),
      status: TOURNAMENT_STATUSES.includes(q('status')) ? q('status') : '',
      kind: TOURNAMENT_KINDS.includes(q('kind')) ? q('kind') : '',
      sex: ['M', 'F', 'X'].includes(q('sex')) ? q('sex') : '',
    };
    res.render('tournaments-list', {
      title: 'Турниры — ФТСО',
      tournaments: tournamentList(db, filters),
      filters,
      options: tournamentFilterOptions(db),
      kindRu: TOURNAMENT_KIND_RU,
      statusRu: TOURNAMENT_STATUS_RU,
      sexRu: TOURNAMENT_SEX_RU,
      categories: CATEGORIES,
      section: sectionFor('/tournaments'),
    });
  });

  // Сетка/протокол/печать турнира — общий модуль; на витрине только опубликованные.
  mountTournamentSheets(app, { db, prefix: '/tournaments', publishedOnly: true, erasedLabel: ERASED_LABEL });

  app.get('/tournaments/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const tournament = db
      .prepare('SELECT id, name, end_date, start_date, category, city, kind, age_group, sex, venue, organizer, organizer_contact, fee, entry_deadline FROM tournaments WHERE id = ? AND is_published = 1')
      .get(Number(req.params.id));
    if (!tournament) return next(); // -> общий 404-обработчик
    res.status(200).render('tournament', {
      title: `${tournament.name} — ФТСО`,
      metaDescription: descriptionFrom(
        `${({ team: 'Командная встреча', championship: 'Первенство', other: 'Турнир' })[tournament.kind] || 'Турнир'} «${tournament.name}»` +
        `${tournament.city ? ', ' + tournament.city : ''}, ${tournament.start_date ? tournament.start_date + ' — ' : ''}${tournament.end_date}, ` +
        `категория ${tournament.category}${tournament.age_group ? ', ' + tournament.age_group : ''}. Участники, результаты и матчи — на сайте Федерации тенниса Смоленской области.`,
      ),
      tournament,
      groups: listGroups(db, tournament.id),
      brackets: listBrackets(db, tournament.id),
      // Участники и матчи со ссылками на публичные профили /player/:id.
      participants: tournamentParticipants(db, tournament.id, LABELS),
      matches: tournamentMatches(db, tournament.id, LABELS),
      documents: tournamentFiles(db, tournament.id),
      // Снимки с этого соревнования (репортажная съёмка, ст. 152.1 ГК) — те же, что на /gallery.
      gallery: galleryItems(db, { tournamentId: tournament.id }),
      section: sectionFor('/tournaments'),
    });
  });

  // --- справочники ---------------------------------------------------------
  for (const spec of Object.values(DIRECTORIES)) {
    if (spec.photo) {
      app.get(`${spec.path}/:id/photo`, (req, res, next) => {
        if (!/^\d+$/.test(req.params.id)) return next();
        const row = db.prepare(`SELECT photo_upload_id FROM ${spec.table} WHERE id = ?`).get(Number(req.params.id));
        if (!row || !row.photo_upload_id) return next();
        const upload = uploadById(db, row.photo_upload_id);
        if (!upload || !sendUploadInline(req, res, upload, config.upload.dir)) return next();
      });
    }
    app.get(spec.path, (req, res) => {
      const filters = {};
      for (const f of spec.fields) if (f.filter) filters[f.name] = String(req.query[f.name] || '').trim().slice(0, f.max);
      res.render('directory', {
        title: `${spec.title} — ФТСО`,
        intro: paragraphs(siteText(db, `${spec.key}-intro`)),
        spec,
        rows: listDirectory(db, spec, filters),
        filters,
        options: directoryFilterOptions(db, spec),
        section: sectionFor(spec.path),
      });
    });
  }

  // --- контентные разделы --------------------------------------------------
  app.get('/federation', (req, res) => {
    res.render('federation', {
      title: 'О Федерации — ФТСО',
      about: paragraphs(siteText(db, 'federation-about')),
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

  /**
   * Снимок галереи как картинка. Инлайн здесь безопасен: профиль gallery
   * пропускает только растровые изображения по сигнатуре байтов (SVG не
   * проходит), а sendUploadInline сам отдаёт SVG вложением с nosniff.
   */
  app.get('/gallery/:id/image', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const row = db.prepare('SELECT upload_id FROM gallery_items WHERE id = ?').get(Number(req.params.id));
    if (!row) return next();
    const upload = uploadById(db, row.upload_id);
    if (!upload || !sendUploadInline(req, res, upload, config.upload.dir)) return next();
  });

  app.get('/contacts', (req, res) => {
    res.render('contacts', {
      title: 'Контакты — ФТСО',
      op: OPERATOR,
      section: sectionFor('/contacts'),
      sent: req.query.sent === '1',
      feedbackError: req.query.error ? String(req.query.error).slice(0, 200) : null,
      feedbackDraft: req.query.error ? { name: req.query.name || '', email: req.query.email || '' } : null,
    });
  });

  /**
   * ФОРМА ОБРАТНОЙ СВЯЗИ (ТЗ п. 8, 4.10). Приём ПДн — закрыт рубильником при
   * INTAKE_ENABLED=0 (intake-gate, CLOSED_POST). Лимит как у регистрации, honeypot
   * «website», согласие обязательно, редакция Политики пишется в запись.
   * Письмо секретарю — в очередь; при закрытой почте обращения видны в админке.
   */
  const feedbackChain = limitFeedback ? [limitFeedback] : [];
  app.post('/contacts/feedback', ...feedbackChain, (req, res, next) => {
    // Honeypot: бот заполнил скрытое поле — отвечаем как при успехе, ничего не пишем.
    if (String(req.body.website || '').trim() !== '') return res.redirect('/contacts?sent=1');
    try {
      const data = feedbackInput(req.body);
      const id = createFeedback(db, { ...data, legalVersion: LEGAL_VERSION });
      queueMail(db, {
        to: OPERATOR.email,
        kind: 'feedback.new',
        subject: `Обращение с сайта № ${id}: ${data.name}`,
        body: `Имя: ${data.name}\nE-mail: ${data.email}\n\n${data.message}\n\nОтветить и отметить: /admin/feedback`,
      });
      return res.redirect('/contacts?sent=1');
    } catch (err) {
      if (err instanceof ValidationError) {
        const q = new URLSearchParams({ error: err.message, name: String(req.body.name || '').slice(0, 120), email: String(req.body.email || '').slice(0, 200) });
        return res.redirect(`/contacts?${q}#feedback`);
      }
      return next(err);
    }
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
