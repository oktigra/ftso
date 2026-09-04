// АДМИНКА КОНТЕНТА: новости, справочники, документы Федерации, галерея.
//
// Вынесено из routes/admin.mjs отдельным файлом: тот и так ведёт данные
// рейтинга и две модерации, а здесь другая зона ответственности — витрина.
//
// Все загрузки идут через ОБЩИЙ слой (lib/uploads.mjs). Своих проверок файлов
// здесь нет и быть не должно — за этим следит проверка приёмки.
import { requireRole } from '../middleware/auth.mjs';
import { safeRefererPath } from '../lib/safe-path.mjs';
import { logAction } from '../lib/action-log.mjs';
import { intAtLeast, str, ValidationError } from '../lib/validate.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
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
  documentInput,
  galleryInput,
  federationDocuments,
  galleryItems,
  internalDocuments,
  internalDocInput,
  INTERNAL_DOC_CATEGORIES,
} from '../lib/content.mjs';

const CONTENT_ROLES = ['super-admin', 'content-manager', 'tournament-admin'];
const NEWS_ROLES = ['super-admin', 'news-editor', 'content-manager'];

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
    res.render('admin/news', { title: 'Новости — админка ФТСО', news: allNews(db) });
  });

  app.post(
    '/admin/news',
    requireRole(...NEWS_ROLES),
    limitWrites,
    guard((req, res) => {
      const data = newsInput(req.body);
      const info = db
        .prepare(
          `INSERT INTO news (title, summary, body, is_published, published_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.title,
          data.summary,
          data.body,
          data.is_published,
          data.published_at,
          req.session.user.id,
        );
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
      const info = db
        .prepare(
          `UPDATE news SET title = ?, summary = ?, body = ?, is_published = ?,
                           published_at = ?, updated_at = datetime('now')
            WHERE id = ?`,
        )
        .run(data.title, data.summary, data.body, data.is_published, data.published_at, id);
      if (!info.changes) throw new ValidationError('Новость не найдена');
      logAction(db, req.session.user.id, 'news.update', id, { is_published: data.is_published });
      flash(req, res, 'ok', 'Новость обновлена.', '/admin/news');
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
      const data = directoryInput(spec, req.body);
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
      const data = directoryInput(spec, req.body);
      updateDirectoryRow(db, spec, id, data);
      logAction(db, req.session.user.id, `${spec.key}.update`, id, data);
      flash(req, res, 'ok', 'Запись обновлена.', `/admin/directories/${spec.key}`);
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

  // --- документы Федерации и галерея --------------------------------------
  app.get('/admin/library', requireRole(...CONTENT_ROLES), (req, res) => {
    res.render('admin/library', {
      title: 'Документы и галерея — админка ФТСО',
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

  // --- ЗАКРЫТЫЕ ДОКУМЕНТЫ ФЕДЕРАЦИИ: только super-admin; наружу не отдаются ---------
  const VAULT_ROLE = ['super-admin'];

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
