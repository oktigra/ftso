// ПУБЛИЧНАЯ ЗАЯВКА «ПРОВЕСТИ ТУРНИР» — форма с документами.
//
// Форма отправляется как multipart, поэтому CSRF проверяет parseMultipart:
// общий middleware для таких запросов тело ещё не разобрал (см. lib/csrf.mjs).
//
// Документы проходят через ОБЩИЙ слой загрузки (lib/uploads.mjs): magic bytes,
// лимит, хранение вне webroot, ресайз с чисткой EXIF. Своих проверок здесь нет
// намеренно — иначе правила разойдутся с галереей и /documents.
import { tournamentRequestInput, ValidationError } from '../lib/validate.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { storeUpload, deleteUpload, UPLOAD_PROFILES } from '../lib/uploads.mjs';
import { createRequest, byToken } from '../lib/tournament-requests.mjs';
import { queueMail, flushOutbox, mailTournamentSubmitted } from '../lib/mailer.mjs';
import { LEGAL_VERSION_LABEL, OPERATOR } from '../lib/legal.mjs';
import { CATEGORIES } from '../lib/validate.mjs';

const STATUS_RU = { pending: 'на рассмотрении', approved: 'согласована', rejected: 'отклонена' };
const PROFILE = 'tournament-doc';

export default function mountTournamentRequest(app, { db, config, limitTournamentRequest }) {
  const maxFiles = config.tournamentRequest.maxFiles;
  const maxFileBytes = UPLOAD_PROFILES[PROFILE].maxBytes;

  function renderForm(req, res, { errors = [], status = 200 } = {}) {
    res.status(status).render('tournament-request', {
      title: 'Провести турнир — ФТСО',
      errors,
      values: req.session.tournamentDraft || {},
      categories: CATEGORIES,
      maxFiles,
      maxFileMb: Math.round(maxFileBytes / 1024 / 1024),
      legalVersionLabel: LEGAL_VERSION_LABEL,
      op: OPERATOR,
    });
  }

  app.get('/tournament-request', (req, res) => renderForm(req, res));

  app.post('/tournament-request', limitTournamentRequest, async (req, res, next) => {
    // Файлы кладутся на диск ДО транзакции БД, поэтому при любой ошибке ниже
    // их надо убрать: осиротевший файл на диске — это чужие данные без владельца.
    const stored = [];
    const cleanup = () => {
      for (const row of stored) {
        try {
          deleteUpload(db, row.id, config.upload.dir);
        } catch (err) {
          console.error('[заявка на турнир] не удалось убрать файл после отката', err);
        }
      }
    };

    try {
      const { fields, files } = await parseMultipart(req, {
        maxFileBytes,
        maxFiles,
        maxFieldBytes: 8 * 1024,
      });

      // АНТИСПАМ: приманка. Заполнена — отвечаем как при успехе и ничего не пишем.
      if (String(fields.website || '').trim() !== '') return res.redirect('/tournament-request/sent');

      // ЧЕРНОВИК кладём ДО валидации: упавшая проверка не должна стирать ввод.
      req.session.tournamentDraft = {
        name: fields.name,
        city: fields.city,
        end_date: fields.end_date,
        category: fields.category,
        organizer: fields.organizer,
        email: fields.email,
        phone: fields.phone,
        comment: fields.comment,
        consent_processing: fields.consent_processing === '1',
      };

      const data = tournamentRequestInput(fields);
      if (fields.consent_processing !== '1') {
        throw new ValidationError(
          'Без согласия на обработку персональных данных заявку принять нельзя: у обработки контактов организатора должно быть основание.',
        );
      }

      for (const file of files) {
        stored.push(
          // eslint-disable-next-line no-await-in-loop
          await storeUpload(db, {
            buffer: file.buffer,
            filename: file.filename,
            profile: PROFILE,
            dir: config.upload.dir,
            meta: { declaredType: file.declaredType, field: file.field },
          }),
        );
      }

      const { token } = createRequest(db, { fields: data, uploads: stored, ip: req.ip });

      const statusUrl = `${req.protocol}://${req.get('host')}/tournament-request/status/${token}`;
      const letter = mailTournamentSubmitted({ organizer: data.organizer, name: data.name, statusUrl });
      queueMail(db, { to: data.email, kind: 'tournament.submitted', ...letter });
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));

      delete req.session.tournamentDraft;
      return req.session.save(() => res.redirect(`/tournament-request/status/${token}`));
    } catch (err) {
      cleanup();
      if (err instanceof ValidationError) {
        // Черновик восстанавливаем из ТЕЛА запроса, а не из разобранных полей:
        // разбор мог упасть до конца. Файлы вернуть нельзя — браузер их не
        // отдаёт повторно, поэтому об этом сказано в форме прямым текстом.
        return req.session.save(() => renderForm(req, res, { errors: err.messages, status: 400 }));
      }
      return next(err);
    }
  });

  app.get('/tournament-request/sent', (req, res) => {
    res.render('tournament-request-status', {
      title: 'Заявка отправлена — ФТСО',
      request: null,
      files: [],
      statusText: 'на рассмотрении',
      op: OPERATOR,
    });
  });

  app.get('/tournament-request/status/:token', (req, res, next) => {
    const request = byToken(db, req.params.token);
    if (!request) return next();
    res.render('tournament-request-status', {
      title: 'Статус заявки на турнир — ФТСО',
      request,
      statusText: STATUS_RU[request.status] || request.status,
      op: OPERATOR,
    });
  });
}
