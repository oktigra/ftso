// АДМИНКА КОНТЕНТА: новости, справочники, документы Федерации, галерея.
//
// Вынесено из routes/admin.mjs отдельным файлом: тот и так ведёт данные
// рейтинга и две модерации, а здесь другая зона ответственности — витрина.
//
// Все загрузки идут через ОБЩИЙ слой (lib/uploads.mjs). Своих проверок файлов
// здесь нет и быть не должно — за этим следит проверка приёмки.
import { requireRole, rolesFor } from '../middleware/auth.mjs';
import { safeRefererPath } from '../lib/safe-path.mjs';
import { logAction } from '../lib/action-log.mjs';
import { intAtLeast, str, ValidationError } from '../lib/validate.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { SEO_PAGES, SEO_DEFAULTS, seoFor, saveSeo } from '../lib/seo.mjs';
import { SITE_TEXTS, saveText } from '../lib/texts.mjs';
import { postInBackground, postToMax, maxWhoAmI, maxFindChats, maxEnabled } from '../lib/max-post.mjs';
import { applyStarterDocuments, applyStarterNews, STARTER_DOCUMENTS, STARTER_NEWS } from '../lib/starter-content.mjs';
import { allPartners } from '../lib/partners.mjs';
import { DIRECTORY_SEED, applyDirectorySeed } from '../lib/directory-seed.mjs';
import { storeUpload, deleteUpload, uploadById, sendUpload } from '../lib/uploads.mjs';
import {
  DIRECTORIES,
  directoryByKey,
  directoryInput,
  listDirectory,
  createDirectoryRow,
  updateDirectoryRow,
  deleteDirectoryRow,
} from '../lib/directories.mjs';
import {
  newsInput,
  allNews,
  newsById,
  newsAttachments,
  NEWS_CATEGORIES,
  siteAsset,
  documentInput,
  galleryInput,
  federationDocuments,
  galleryItems,
  internalDocuments,
  internalDocInput,
  INTERNAL_DOC_CATEGORIES,
} from '../lib/content.mjs';
import { listFeedback, markFeedbackDone, deleteFeedback } from '../lib/feedback.mjs';

const CONTENT_ROLES = rolesFor('library'); // справочники, документы, галерея
const NEWS_ROLES = rolesFor('news');

const flash = (req, res, kind, text, back) => {
  req.session.flash = { kind, text };
  req.session.save(() => res.redirect(back));
};

export default function mountAdminContent(app, { db, config, limitWrites }) {
  const guard = (handler) => async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (err instanceof ValidationError) {
        return flash(req, res, 'error', err.message, safeRefererPath(req, '/admin'));
      }
      return next(err);
    }
  };

  /** Один файл из multipart-формы + поля. Проверку типа делает слой загрузки. */
  async function oneFile(req, { profile, field, required = true }) {
    const { fields, files } = await parseMultipart(req, { maxFiles: 1 });
    const file = files.find((f) => f.field === field);
    if (!file) {
      if (required) throw new ValidationError('Файл не выбран.');
      return { fields, upload: null };
    }
    const upload = await storeUpload(db, {
      buffer: file.buffer,
      filename: file.filename,
      profile,
      dir: config.upload.dir,
      uploadedBy: req.session.user.id,
    });
    return { fields, upload };
  }

  // --- новости -------------------------------------------------------------
  app.get('/admin/news', requireRole(...NEWS_ROLES), (req, res) => {
    res.render('admin/news', {
      title: 'Новости — админка ФТСО',
      categories: NEWS_CATEGORIES,
      news: allNews(db).map((n) => ({ ...n, attachments: newsAttachments(db, n.id) })),
    });
  });

  app.post(
    '/admin/news',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard((req, res) => {
      const data = newsInput(req.body);
      const info = db
        .prepare(
          `INSERT INTO news (title, summary, body, is_published, published_at, created_by, author, category)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.title,
          data.summary,
          data.body,
          data.is_published,
          data.published_at,
          req.session.user.id,
          data.author,
          data.category,
        );
      if (data.is_published) postInBackground(db, config, req.session.user.id, 'news.publish', { text: `📰 **${data.title}**${data.summary ? '\n' + data.summary : ''}`, url: `${req.protocol}://${req.get('host')}/news/${info.lastInsertRowid}`, button: 'Читать на сайте' });
      logAction(db, req.session.user.id, 'news.create', Number(info.lastInsertRowid), {
        title: data.title,
        is_published: data.is_published,
      });
      flash(req, res, 'ok', 'Новость добавлена.', '/admin/news');
    }),
  );

  app.post(
    '/admin/news/:id/update',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const data = newsInput(req.body);
      const wasPublished = db.prepare('SELECT is_published FROM news WHERE id = ?').get(id)?.is_published;
      const info = db
        .prepare(
          `UPDATE news SET title = ?, summary = ?, body = ?, is_published = ?,
                           published_at = ?, author = ?, category = ?, updated_at = datetime('now')
            WHERE id = ?`,
        )
        .run(data.title, data.summary, data.body, data.is_published, data.published_at, data.author, data.category, id);
      if (!info.changes) throw new ValidationError('Новость не найдена');
      logAction(db, req.session.user.id, 'news.update', id, { is_published: data.is_published });
      if (data.is_published && !wasPublished) postInBackground(db, config, req.session.user.id, 'news.publish', { text: `📰 **${data.title}**${data.summary ? '\n' + data.summary : ''}`, url: `${req.protocol}://${req.get('host')}/news/${id}`, button: 'Читать на сайте' });
      flash(req, res, 'ok', 'Новость обновлена.', '/admin/news');
    }),
  );

  // ОБЛОЖКА НОВОСТИ (изображение, показывается в карточке и в самой новости).
  app.post(
    '/admin/news/:id/cover',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard(async (req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = newsById(db, id);
      if (!row) throw new ValidationError('Новость не найдена');
      const { upload } = await oneFile(req, { profile: 'gallery', field: 'cover' });
      db.transaction(() => {
        db.prepare('UPDATE news SET cover_upload_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(upload.id, id);
        if (row.cover_upload_id) deleteUpload(db, row.cover_upload_id, config.upload.dir);
      })();
      logAction(db, req.session.user.id, 'news.cover', id, { upload: upload.id });
      flash(req, res, 'ok', 'Обложка сохранена.', '/admin/news');
    }),
  );

  app.post(
    '/admin/news/:id/cover/delete',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = newsById(db, id);
      if (!row || !row.cover_upload_id) throw new ValidationError('Обложки нет');
      db.transaction(() => {
        db.prepare('UPDATE news SET cover_upload_id = NULL WHERE id = ?').run(id);
        deleteUpload(db, row.cover_upload_id, config.upload.dir);
      })();
      logAction(db, req.session.user.id, 'news.cover.delete', id, null);
      flash(req, res, 'ok', 'Обложка снята.', '/admin/news');
    }),
  );

  // ВЛОЖЕНИЯ (ТЗ 4.2): документ или изображение файлом, либо ссылка.
  app.post(
    '/admin/news/:id/attachments',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard(async (req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      if (!newsById(db, id)) throw new ValidationError('Новость не найдена');
      let fields; let upload = null;
      if (/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
        ({ fields, upload } = await oneFile(req, { profile: 'tournament-doc', field: 'file', required: false }));
      } else {
        fields = req.body;
      }
      const url = str(fields.url, 'Ссылка', { max: 500, required: false });
      if (url && !/^https?:\/\//i.test(url)) throw new ValidationError('Ссылка должна начинаться с http:// или https://');
      if (!upload && !url) throw new ValidationError('Выберите файл или укажите ссылку');
      if (upload && url) throw new ValidationError('Либо файл, либо ссылка — не оба сразу');
      const title = str(fields.title, 'Название', { max: 160, required: false }) || (upload ? upload.original_name : url);
      const info = db
        .prepare('INSERT INTO news_attachments (news_id, upload_id, url, title) VALUES (?, ?, ?, ?)')
        .run(id, upload ? upload.id : null, upload ? null : url, title);
      logAction(db, req.session.user.id, 'news.attachment.add', id, { attachment: Number(info.lastInsertRowid), kind: upload ? 'file' : 'link' });
      flash(req, res, 'ok', upload ? 'Файл прикреплён.' : 'Ссылка добавлена.', '/admin/news');
    }),
  );

  app.post(
    '/admin/news/:id/attachments/:aid/delete',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const aid = intAtLeast(req.params.aid, 'вложение');
      const a = db.prepare('SELECT upload_id FROM news_attachments WHERE id = ? AND news_id = ?').get(aid, id);
      if (!a) throw new ValidationError('Вложение не найдено');
      db.transaction(() => {
        db.prepare('DELETE FROM news_attachments WHERE id = ?').run(aid);
        if (a.upload_id) deleteUpload(db, a.upload_id, config.upload.dir);
      })();
      logAction(db, req.session.user.id, 'news.attachment.delete', id, { attachment: aid });
      flash(req, res, 'ok', 'Вложение удалено.', '/admin/news');
    }),
  );

  app.post(
    '/admin/news/:id/delete',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = newsById(db, id);
      if (row && row.cover_upload_id) deleteUpload(db, row.cover_upload_id, config.upload.dir);
      for (const a of db.prepare('SELECT upload_id FROM news_attachments WHERE news_id = ? AND upload_id IS NOT NULL').all(id)) {
        deleteUpload(db, a.upload_id, config.upload.dir);
      }
      db.prepare('DELETE FROM news WHERE id = ?').run(id);
      logAction(db, req.session.user.id, 'news.delete', id, null);
      flash(req, res, 'ok', 'Новость удалена.', '/admin/news');
    }),
  );

  // --- справочники ---------------------------------------------------------
  app.get('/admin/directories/:key', requireRole(...CONTENT_ROLES), (req, res, next) => {
    const spec = directoryByKey(req.params.key);
    if (!spec) return next();
    res.render('admin/directory', {
      seedCount: (DIRECTORY_SEED[spec.key] || []).length,
      title: `${spec.title} — админка ФТСО`,
      spec,
      rows: listDirectory(db, spec),
      directories: Object.values(DIRECTORIES),
    });
  });

  app.post(
    '/admin/directories/:key',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res, next) => {
      const spec = directoryByKey(req.params.key);
      if (!spec) return next();
      const data = directoryInput(spec, req.body, { db });
      const id = createDirectoryRow(db, spec, data);
      logAction(db, req.session.user.id, `${spec.key}.create`, id, data);
      flash(req, res, 'ok', 'Запись добавлена.', `/admin/directories/${spec.key}`);
    }),
  );

  app.post(
    '/admin/directories/:key/:id/update',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res, next) => {
      const spec = directoryByKey(req.params.key);
      if (!spec) return next();
      const id = intAtLeast(req.params.id, 'id');
      const data = directoryInput(spec, req.body, { db });
      updateDirectoryRow(db, spec, id, data);
      logAction(db, req.session.user.id, `${spec.key}.update`, id, data);
      flash(req, res, 'ok', 'Запись обновлена.', `/admin/directories/${spec.key}`);
    }),
  );

  // СТАРТОВЫЙ СПИСОК (корты и клубы области по открытым источникам, 05.09.2026):
  // одна кнопка, повтор безвреден — уже существующие названия пропускаются.
  app.post(
    '/admin/directories/:key/seed',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res, next) => {
      const spec = directoryByKey(req.params.key);
      if (!spec || !DIRECTORY_SEED[spec.key]) return next();
      const out = applyDirectorySeed(db, spec);
      logAction(db, req.session.user.id, `${spec.key}.seed`, null, out);
      flash(req, res, 'ok', `Стартовый список: добавлено ${out.added}, уже было ${out.skipped} (дозаполнено пустых полей: ${out.filled}) из ${out.total}. Проверьте пометки «уточнить».`, `/admin/directories/${spec.key}`);
    }),
  );

  // ФОТО ЗАПИСИ СПРАВОЧНИКА (ТЗ 4.5/4.6): отдельная форма у строки — загрузка
  // и снятие. Картинка пересобирается (EXIF снимается) профилем gallery.
  app.post(
    '/admin/directories/:key/:id/photo',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard(async (req, res, next) => {
      const spec = directoryByKey(req.params.key);
      if (!spec || !spec.photo) return next();
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare(`SELECT id, photo_upload_id FROM ${spec.table} WHERE id = ?`).get(id);
      if (!row) throw new ValidationError('Запись не найдена');
      const { upload } = await oneFile(req, { profile: 'gallery', field: 'photo' });
      db.transaction(() => {
        db.prepare(`UPDATE ${spec.table} SET photo_upload_id = ? WHERE id = ?`).run(upload.id, id);
        if (row.photo_upload_id) deleteUpload(db, row.photo_upload_id, config.upload.dir);
      })();
      logAction(db, req.session.user.id, `${spec.key}.photo`, id, { upload: upload.id });
      flash(req, res, 'ok', 'Фото сохранено.', `/admin/directories/${spec.key}`);
    }),
  );

  app.post(
    '/admin/directories/:key/:id/photo/delete',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res, next) => {
      const spec = directoryByKey(req.params.key);
      if (!spec || !spec.photo) return next();
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare(`SELECT photo_upload_id FROM ${spec.table} WHERE id = ?`).get(id);
      if (!row || !row.photo_upload_id) throw new ValidationError('Фото нет');
      db.transaction(() => {
        db.prepare(`UPDATE ${spec.table} SET photo_upload_id = NULL WHERE id = ?`).run(id);
        deleteUpload(db, row.photo_upload_id, config.upload.dir);
      })();
      logAction(db, req.session.user.id, `${spec.key}.photo.delete`, id, null);
      flash(req, res, 'ok', 'Фото снято.', `/admin/directories/${spec.key}`);
    }),
  );

  app.post(
    '/admin/directories/:key/:id/delete',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res, next) => {
      const spec = directoryByKey(req.params.key);
      if (!spec) return next();
      const id = intAtLeast(req.params.id, 'id');
      deleteDirectoryRow(db, spec, id);
      logAction(db, req.session.user.id, `${spec.key}.delete`, id, null);
      flash(req, res, 'ok', 'Запись удалена.', `/admin/directories/${spec.key}`);
    }),
  );

  // --- АВТОПОСТ В MAX: состояние, проверка бота, поиск канала, тестовый пост (супер-админ) ---
  const SUPER = rolesFor('users');
  app.get('/admin/max', requireRole(...SUPER), (req, res) => {
    res.render('admin/max', { title: 'MAX — админка ФТСО', maxOn: maxEnabled(config), hasToken: Boolean(config.maxBotToken), chatId: config.maxChatId, result: null });
  });
  app.post('/admin/max/check', requireRole(...SUPER), limitWrites, async (req, res) => {
    const who = await maxWhoAmI(config);
    const chats = await maxFindChats(config);
    res.render('admin/max', { title: 'MAX — админка ФТСО', maxOn: maxEnabled(config), hasToken: Boolean(config.maxBotToken), chatId: config.maxChatId, result: { who, chats } });
  });
  app.post('/admin/max/test', requireRole(...SUPER), limitWrites, guard(async (req, res) => {
    const r = await postToMax(config, { text: 'Проверка связи: сайт ftso67.ru → канал MAX ✅', url: `${req.protocol}://${req.get('host')}/`, button: 'Открыть сайт' });
    logAction(db, req.session.user.id, r.ok ? 'max.post' : 'max.post.failed', null, { kind: 'test', status: r.status, error: r.error });
    flash(req, res, r.ok ? 'ok' : 'error', r.ok ? 'Тестовый пост ушёл в канал.' : `Не ушло: ${r.error || 'HTTP ' + r.status}`, '/admin/max');
  }));

  // --- ПАРТНЁРЫ И СПОНСОРЫ (06.09.2026) --------------------------------------
  app.get('/admin/partners', requireRole(...CONTENT_ROLES), (req, res) => {
    res.render('admin/partners', { title: 'Партнёры — админка ФТСО', partnersList: allPartners(db) });
  });
  app.post(
    '/admin/partners',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard(async (req, res) => {
      const { fields, upload } = await oneFile(req, { profile: 'gallery', field: 'logo', required: false });
      const name = str(fields.name, 'Название', { max: 120 });
      const url = str(fields.url, 'Ссылка', { max: 300, required: false }) || null;
      if (url && !/^https?:\/\//i.test(url)) throw new ValidationError('Ссылка должна начинаться с http:// или https://');
      const sort = Number(fields.sort) || 100;
      const info = db.prepare('INSERT INTO partners (name, url, logo_upload_id, sort) VALUES (?, ?, ?, ?)').run(name, url, upload ? upload.id : null, sort);
      logAction(db, req.session.user.id, 'partner.create', Number(info.lastInsertRowid), { name, sort });
      flash(req, res, 'ok', upload ? `Партнёр «${name}» добавлен.` : `Партнёр «${name}» добавлен — загрузите логотип, без него он не показывается.`, '/admin/partners');
    }),
  );
  app.post(
    '/admin/partners/:id/logo',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard(async (req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT logo_upload_id FROM partners WHERE id = ?').get(id);
      if (!row) throw new ValidationError('Партнёр не найден');
      const { upload } = await oneFile(req, { profile: 'gallery', field: 'logo' });
      db.transaction(() => {
        db.prepare('UPDATE partners SET logo_upload_id = ? WHERE id = ?').run(upload.id, id);
        if (row.logo_upload_id) deleteUpload(db, row.logo_upload_id, config.upload.dir);
      })();
      logAction(db, req.session.user.id, 'partner.logo', id, { upload: upload.id });
      flash(req, res, 'ok', 'Логотип обновлён.', '/admin/partners');
    }),
  );
  app.post(
    '/admin/partners/:id/update',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const name = str(req.body.name, 'Название', { max: 120 });
      const url = str(req.body.url, 'Ссылка', { max: 300, required: false }) || null;
      if (url && !/^https?:\/\//i.test(url)) throw new ValidationError('Ссылка должна начинаться с http:// или https://');
      const info = db.prepare('UPDATE partners SET name = ?, url = ?, sort = ?, is_active = ? WHERE id = ?')
        .run(name, url, Number(req.body.sort) || 100, req.body.is_active === '1' ? 1 : 0, id);
      if (!info.changes) throw new ValidationError('Партнёр не найден');
      logAction(db, req.session.user.id, 'partner.update', id, { name });
      flash(req, res, 'ok', 'Сохранено.', '/admin/partners');
    }),
  );
  app.post(
    '/admin/partners/:id/delete',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT logo_upload_id FROM partners WHERE id = ?').get(id);
      if (!row) throw new ValidationError('Партнёр не найден');
      db.transaction(() => {
        db.prepare('DELETE FROM partners WHERE id = ?').run(id);
        if (row.logo_upload_id) deleteUpload(db, row.logo_upload_id, config.upload.dir);
      })();
      logAction(db, req.session.user.id, 'partner.delete', id, null);
      flash(req, res, 'ok', 'Партнёр удалён.', '/admin/partners');
    }),
  );

  // --- ТЕКСТЫ САЙТА (ТЗ п. 5 «управление страницами») ------------------------
  app.get('/admin/texts', requireRole(...CONTENT_ROLES), (req, res) => {
    res.render('admin/texts', {
      title: 'Тексты сайта — админка ФТСО',
      texts: SITE_TEXTS.map((t) => ({ ...t, value: db.prepare('SELECT value FROM site_texts WHERE key = ?').get(t.key)?.value || '' })),
    });
  });

  app.post(
    '/admin/texts',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res) => {
      const key = String(req.body.key || '');
      if (!SITE_TEXTS.some((t) => t.key === key)) throw new ValidationError('Неизвестный текст');
      saveText(db, key, req.body.value);
      logAction(db, req.session.user.id, 'site.text', null, { key });
      flash(req, res, 'ok', 'Текст сохранён.', '/admin/texts');
    }),
  );

  // --- SEO (ТЗ п. 5): title/description разделов ---------------------------
  app.get('/admin/seo', requireRole(...CONTENT_ROLES), (req, res) => {
    res.render('admin/seo', {
      title: 'SEO страниц — админка ФТСО',
      pages: SEO_PAGES.map(([path, label]) => ({ path, label, current: seoFor(db, path), fallback: SEO_DEFAULTS[path] || '' })),
    });
  });

  app.post(
    '/admin/seo',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res) => {
      const path = String(req.body.path || '');
      if (!SEO_PAGES.some(([p]) => p === path)) throw new ValidationError('Неизвестная страница');
      const data = {
        title: str(req.body.title, 'Title', { max: 120, required: false }),
        description: str(req.body.description, 'Description', { max: 300, required: false }),
      };
      saveSeo(db, path, data);
      logAction(db, req.session.user.id, 'seo.update', null, { path, ...data });
      flash(req, res, 'ok', `SEO для «${path}» сохранено.`, '/admin/seo');
    }),
  );

  // --- документы Федерации и галерея --------------------------------------
  // СТАРТОВЫЕ ДОКУМЕНТЫ И НОВОСТИ (06.09.2026): одна кнопка, повтор безвреден.
  app.post(
    '/admin/library/starter',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard(async (req, res) => {
      const out = await applyStarterDocuments(db, config, req.session.user.id);
      logAction(db, req.session.user.id, 'documents.starter', null, out);
      flash(req, res, 'ok', `Стартовые документы: добавлено ${out.added}, уже было ${out.skipped} из ${out.total}.`, '/admin/library');
    }),
  );
  app.post(
    '/admin/news/starter',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard((req, res) => {
      const out = applyStarterNews(db, req.session.user.id);
      logAction(db, req.session.user.id, 'news.starter', null, out);
      flash(req, res, 'ok', `Стартовые новости (черновики): добавлено ${out.added}, уже было ${out.skipped} из ${out.total}. Прочтите, поправьте и опубликуйте.`, '/admin/news');
    }),
  );

  // ФОТО БАННЕРА ГЛАВНОЙ: одна картинка по ключу home-hero, замена удаляет прежнюю.
  app.post(
    '/admin/library/hero',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard(async (req, res) => {
      const { upload } = await oneFile(req, { profile: 'gallery', field: 'file' });
      const prev = siteAsset(db, 'home-hero');
      db.transaction(() => {
        db.prepare("INSERT INTO site_assets (key, upload_id, updated_at) VALUES ('home-hero', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET upload_id = excluded.upload_id, updated_at = excluded.updated_at").run(upload.id);
        if (prev) deleteUpload(db, prev, config.upload.dir);
      })();
      logAction(db, req.session.user.id, 'site.hero', null, { upload: upload.id });
      flash(req, res, 'ok', 'Фото баннера главной обновлено.', '/admin/library');
    }),
  );

  app.post(
    '/admin/library/hero/delete',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res) => {
      const prev = siteAsset(db, 'home-hero');
      if (!prev) throw new ValidationError('Фото баннера нет');
      db.transaction(() => {
        db.prepare("DELETE FROM site_assets WHERE key = 'home-hero'").run();
        deleteUpload(db, prev, config.upload.dir);
      })();
      logAction(db, req.session.user.id, 'site.hero.delete', null, null);
      flash(req, res, 'ok', 'Фото баннера снято — на главной заглушка.', '/admin/library');
    }),
  );

  app.get('/admin/library', requireRole(...CONTENT_ROLES), (req, res) => {
    res.render('admin/library', {
      title: 'Документы и галерея — админка ФТСО',
      heroUploadId: siteAsset(db, 'home-hero'),
      documents: federationDocuments(db),
      gallery: galleryItems(db),
      tournaments: db.prepare('SELECT id, name, end_date FROM tournaments ORDER BY end_date DESC, id DESC').all(),
    });
  });

  app.post(
    '/admin/library/documents',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard(async (req, res) => {
      const { fields, upload } = await oneFile(req, { profile: 'documents', field: 'file' });
      try {
        const data = documentInput(fields);
        const info = db
          .prepare('INSERT INTO federation_documents (title, category, upload_id) VALUES (?, ?, ?)')
          .run(data.title, data.category, upload.id);
        logAction(db, req.session.user.id, 'document.create', Number(info.lastInsertRowid), data);
      } catch (err) {
        // Файл уже на диске — при отказе убираем его, чтобы не осиротел.
        deleteUpload(db, upload.id, config.upload.dir);
        throw err;
      }
      flash(req, res, 'ok', 'Документ опубликован.', '/admin/library');
    }),
  );

  app.post(
    '/admin/library/documents/:id/delete',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT upload_id FROM federation_documents WHERE id = ?').get(id);
      db.prepare('DELETE FROM federation_documents WHERE id = ?').run(id);
      if (row) deleteUpload(db, row.upload_id, config.upload.dir);
      logAction(db, req.session.user.id, 'document.delete', id, null);
      flash(req, res, 'ok', 'Документ удалён.', '/admin/library');
    }),
  );

  // --- ОБРАЩЕНИЯ С ФОРМЫ ОБРАТНОЙ СВЯЗИ: секретарь и super-admin ---------------------
  const FEEDBACK_ROLES = rolesFor('feedback');

  app.get('/admin/feedback', requireRole(...FEEDBACK_ROLES), (req, res) => {
    res.render('admin/feedback', { title: 'Обращения — админка ФТСО', items: listFeedback(db) });
  });

  app.post(
    '/admin/feedback/:id/done',
    requireRole(...FEEDBACK_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      if (!markFeedbackDone(db, id, req.session.user.id)) throw new ValidationError('Обращение не найдено или уже обработано');
      logAction(db, req.session.user.id, 'feedback.done', id, null);
      flash(req, res, 'ok', 'Обращение отмечено обработанным.', '/admin/feedback');
    }),
  );

  app.post(
    '/admin/feedback/:id/delete',
    requireRole(...FEEDBACK_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      if (!deleteFeedback(db, id)) throw new ValidationError('Обращение не найдено');
      logAction(db, req.session.user.id, 'feedback.delete', id, null);
      flash(req, res, 'ok', 'Обращение удалено.', '/admin/feedback');
    }),
  );

  // --- ЗАКРЫТЫЕ ДОКУМЕНТЫ ФЕДЕРАЦИИ: только super-admin; наружу не отдаются ---------
  const VAULT_ROLE = rolesFor('vault');

  app.get('/admin/vault', requireRole(...VAULT_ROLE), (req, res) => {
    res.render('admin/vault', {
      title: 'Закрытые документы — админка ФТСО',
      documents: internalDocuments(db),
      categories: INTERNAL_DOC_CATEGORIES,
    });
  });

  app.post(
    '/admin/vault',
    requireRole(...VAULT_ROLE),
    limitWrites,
    guard(async (req, res) => {
      const { fields, upload } = await oneFile(req, { profile: 'internal-doc', field: 'file' });
      try {
        const data = internalDocInput(fields);
        const info = db
          .prepare('INSERT INTO internal_documents (title, category, note, upload_id) VALUES (?, ?, ?, ?)')
          .run(data.title, data.category, data.note, upload.id);
        logAction(db, req.session.user.id, 'vault.create', Number(info.lastInsertRowid), { title: data.title, category: data.category });
      } catch (err) {
        deleteUpload(db, upload.id, config.upload.dir);
        throw err;
      }
      flash(req, res, 'ok', 'Документ сохранён в закрытый раздел.', '/admin/vault');
    }),
  );

  /** Скачивание — вложением, только super-admin. Публичный /files/:id эти файлы не видит. */
  app.get('/admin/vault/:id/file', requireRole(...VAULT_ROLE), (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const row = db.prepare('SELECT upload_id FROM internal_documents WHERE id = ?').get(Number(req.params.id));
    if (!row) return next();
    const upload = uploadById(db, row.upload_id);
    if (!upload || !sendUpload(res, upload, config.upload.dir)) return next();
  });

  app.post(
    '/admin/vault/:id/delete',
    requireRole(...VAULT_ROLE),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT upload_id FROM internal_documents WHERE id = ?').get(id);
      db.prepare('DELETE FROM internal_documents WHERE id = ?').run(id);
      if (row) deleteUpload(db, row.upload_id, config.upload.dir);
      logAction(db, req.session.user.id, 'vault.delete', id, null);
      flash(req, res, 'ok', 'Документ удалён.', '/admin/vault');
    }),
  );

  app.post(
    '/admin/library/gallery',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard(async (req, res) => {
      // Профиль gallery -> только изображения; ресайз и снятие EXIF делает слой.
      const { fields, upload } = await oneFile(req, { profile: 'gallery', field: 'file' });
      try {
        const data = galleryInput(fields);
        if (data.tournament_id && !db.prepare('SELECT 1 FROM tournaments WHERE id = ?').get(data.tournament_id)) {
          throw new ValidationError('Турнир не найден');
        }
        const info = db
          .prepare('INSERT INTO gallery_items (title, upload_id, tournament_id) VALUES (?, ?, ?)')
          .run(data.title, upload.id, data.tournament_id);
        logAction(db, req.session.user.id, 'gallery.create', Number(info.lastInsertRowid), data);
      } catch (err) {
        deleteUpload(db, upload.id, config.upload.dir);
        throw err;
      }
      flash(req, res, 'ok', 'Фотография добавлена.', '/admin/library');
    }),
  );

  app.post(
    '/admin/library/gallery/:id/delete',
    requireRole(...CONTENT_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT upload_id FROM gallery_items WHERE id = ?').get(id);
      db.prepare('DELETE FROM gallery_items WHERE id = ?').run(id);
      if (row) deleteUpload(db, row.upload_id, config.upload.dir);
      logAction(db, req.session.user.id, 'gallery.delete', id, null);
      flash(req, res, 'ok', 'Фотография удалена.', '/admin/library');
    }),
  );

  // --- документы турнира ---------------------------------------------------
  app.post(
    '/admin/tournaments/:id/files',
    requireRole('super-admin', 'tournament-admin'),
    limitWrites,
    guard(async (req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      if (!db.prepare('SELECT 1 FROM tournaments WHERE id = ?').get(id)) {
        throw new ValidationError('Турнир не найден');
      }
      const { fields, upload } = await oneFile(req, { profile: 'tournament-doc', field: 'file' });
      const title = str(fields.title, 'Заголовок', { max: 200, required: false });
      db.prepare('INSERT INTO tournament_files (tournament_id, upload_id, title) VALUES (?, ?, ?)')
        .run(id, upload.id, title);
      logAction(db, req.session.user.id, 'tournament.file.add', id, { upload: upload.id });
      flash(req, res, 'ok', 'Документ прикреплён к турниру.', '/admin/tournaments');
    }),
  );
}
