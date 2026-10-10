// ПУБЛИЧНАЯ ЗАЯВКА «ПРОВЕСТИ ТУРНИР» — форма с документами.
//
// Форма отправляется как multipart, поэтому CSRF проверяет parseMultipart:
// общий middleware для таких запросов тело ещё не разобрал (см. lib/csrf.mjs).
//
// Документы проходят через ОБЩИЙ слой загрузки (lib/uploads.mjs): magic bytes,
// лимит, хранение вне webroot, ресайз с чисткой EXIF. Своих проверок здесь нет
// намеренно — иначе правила разойдутся с галереей и /documents.
import { tournamentRequestInput, ValidationError } from '../lib/validate.mjs';
import { AGE_LIMIT_PRESETS } from '../lib/age.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { checkTicket, consumeTicket } from '../lib/form-guard.mjs';
import { storeUpload, deleteUpload, UPLOAD_PROFILES } from '../lib/uploads.mjs';
import { createRequest, byToken, docsGate } from '../lib/tournament-requests.mjs';
import { tournamentFiles } from '../lib/content.mjs';
import { queueMail, flushOutbox, mailTournamentSubmitted } from '../lib/mailer.mjs';
import { LEGAL_VERSION_LABEL, OPERATOR } from '../lib/legal.mjs';
import { CATEGORIES } from '../lib/validate.mjs';

const STATUS_RU = { pending: 'на рассмотрении', approved: 'согласована', rejected: 'отклонена' };
const PROFILE = 'tournament-doc';
// Всего документов у турнира от организатора (положение, сетка, регламент, дополнения).
const MAX_DOCS = 10;

export default function mountTournamentRequest(app, { db, config, limitTournamentRequest }) {
  const maxFiles = config.tournamentRequest.maxFiles;
  const maxFileBytes = UPLOAD_PROFILES[PROFILE].maxBytes;

  function renderForm(req, res, { errors = [], status = 200 } = {}) {
    res.status(status).render('tournament-request', {
      title: 'Провести турнир — ФТСО',
      errors,
      values: req.session.tournamentDraft || {},
      categories: CATEGORIES,
      agePresets: AGE_LIMIT_PRESETS,
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

      // ЧЕРНОВИК кладём ДО билета и валидации: человек, ошибившийся в вопросе
      // «вы не робот» или отправивший слишком быстро, не должен терять ввод.
      req.session.tournamentDraft = {
        name: fields.name,
        city: fields.city,
        start_date: fields.start_date,
        end_date: fields.end_date,
        category: fields.category,
        organizer: fields.organizer,
        email: fields.email,
        phone: fields.phone,
        comment: fields.comment,
        age_limit: fields.age_limit,
        age_min: fields.age_min,
        age_max: fields.age_max,
        consent_processing: fields.consent_processing === '1',
      };

      // Билет формы: поля пришли из multipart, поэтому передаём их явно.
      checkTicket(req, config, fields);

      const data = tournamentRequestInput(fields);
      if (fields.consent_processing !== '1') {
        throw new ValidationError(
          'Без согласия на обработку персональных данных заявку принять нельзя: у обработки контактов организатора должно быть основание.',
        );
      }

      // Документы в заявке больше не принимаются (10.10.2026): они грузятся по ссылке
      // на статус после согласования, с открытия приёма заявок.
      if (files.length) {
        throw new ValidationError('Документы турнира загружаются после согласования — по ссылке на статус заявки, с началом приёма заявок.');
      }

      const { token } = createRequest(db, { fields: data, uploads: stored, ip: req.ip });
      consumeTicket(req);
      req.formAccepted?.(); // лимит тратит только принятая заявка: отбитый файл — нет

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

  function renderStatus(req, res, request, { errors = [], status = 200 } = {}) {
    const gate = docsGate(db, request);
    const docs = gate.tournament ? tournamentFiles(db, gate.tournament.id) : [];
    const notice = req.session.docsNotice || null;
    delete req.session.docsNotice;
    res.status(status).render('tournament-request-status', {
      title: 'Статус заявки на турнир — ФТСО',
      request,
      statusText: STATUS_RU[request.status] || request.status,
      gate,
      docs,
      errors,
      notice,
      maxFiles,
      maxFileMb: Math.round(maxFileBytes / 1024 / 1024),
      op: OPERATOR,
    });
  }

  app.get('/tournament-request/status/:token', (req, res, next) => {
    const request = byToken(db, req.params.token);
    if (!request) return next();
    renderStatus(req, res, request);
  });

  // ДОКУМЕНТЫ ОТ ОРГАНИЗАТОРА — по секретной ссылке статуса, когда открыт приём заявок.
  // Файлы идут через общий слой загрузки (magic bytes, лимит, EXIF) и сразу
  // прикрепляются к турниру; секретарю уходит письмо, лишнее он снимет в админке.
  app.post('/tournament-request/status/:token/files', limitTournamentRequest, async (req, res, next) => {
    const request = byToken(db, req.params.token);
    if (!request) return next();
    const stored = [];
    try {
      const { files } = await parseMultipart(req, { maxFileBytes, maxFiles, maxFieldBytes: 8 * 1024 });
      const gate = docsGate(db, request);
      if (!gate.open) throw new ValidationError(gate.reason);
      if (!files.length) throw new ValidationError('Выберите хотя бы один файл.');
      const already = tournamentFiles(db, gate.tournament.id).length;
      if (already + files.length > MAX_DOCS) {
        throw new ValidationError(`У турнира уже ${already} документов, всего можно ${MAX_DOCS}. Лишние уберёт секретарь — напишите ему.`);
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
      const ins = db.prepare('INSERT INTO tournament_files (tournament_id, upload_id, title) VALUES (?, ?, ?)');
      db.transaction(() => { for (const u of stored) ins.run(gate.tournament.id, u.id, u.original_name || null); })();
      req.formAccepted?.();
      queueMail(db, {
        to: OPERATOR.email,
        kind: 'tournament.docs.uploaded',
        subject: `Организатор загрузил документы: ${gate.tournament.name}`,
        body: `Организатор (${request.organizer}) загрузил к турниру «${gate.tournament.name}» документов: ${stored.length}.\n` +
          stored.map((u) => `— ${u.original_name}`).join('\n') +
          `\n\nПроверить и при необходимости снять: /admin/tournaments`,
      });
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      req.session.docsNotice = `Загружено документов: ${stored.length}. Они уже прикреплены к турниру.`;
      return req.session.save(() => res.redirect(303, `/tournament-request/status/${request.status_token}`));
    } catch (err) {
      for (const row of stored) {
        try { deleteUpload(db, row.id, config.upload.dir); } catch (e) { console.error('[документы турнира] не удалось убрать файл после отката', e); }
      }
      if (err instanceof ValidationError) return renderStatus(req, res, request, { errors: err.messages, status: 400 });
      return next(err);
    }
  });
}
