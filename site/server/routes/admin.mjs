import { requireRole, ROLES, ACTIVE_ROLES, rolesFor } from '../middleware/auth.mjs';
import { safeRefererPath } from '../lib/safe-path.mjs';
import { hashPassword, verifyPassword, temporaryPassword } from '../lib/password.mjs';
import { logAction, recentActions } from '../lib/action-log.mjs';
import {
  playerInput,
  tournamentInput,
  intAtLeast,
  isoDate,
  str,
  oneOf,
  SEXES,
  CATEGORIES,
  TOURNAMENT_KIND_RU,
  ValidationError,
  splitName,
} from '../lib/validate.mjs';
import {
  recompute,
  currentStandings,
  lastSnapshots,
  lockState,
  statusLabel,
} from '../lib/rating-service.mjs';
import { setDistributionConsent, consentState, eraseConsents } from '../lib/consent-journal.mjs';
import {
  pendingRegistrations,
  decidedRegistrations,
  findNameMatches,
  findDuplicate,
  approveRegistration,
  rejectRegistration,
  byId as registrationById,
} from '../lib/registrations.mjs';
import {
  pendingRequests,
  decidedRequests,
  requestFiles,
  approveRequest,
  rejectRequest,
  byId as tournamentRequestById,
} from '../lib/tournament-requests.mjs';
import { sendUpload, uploadById, deleteUpload } from '../lib/uploads.mjs';
import { attachRequestFiles } from '../lib/content.mjs';
import { createAccount, issueResetToken, accountByPlayer } from '../lib/player-accounts.mjs';
import {
  activeGuardianFor,
  attachGuardian,
  guardianByEmail,
  guardianHistoryFor,
  issueGuardianResetToken,
  recordGuardianConsent,
  revokeWard,
} from '../lib/guardians.mjs';
import { revokeGuardianSessions, revokePlayerSessions } from '../lib/erasure.mjs';
import { withConsentErasure } from '../lib/consent-journal.mjs';
import { guardianInput, isMinor, ageOn } from '../lib/validate.mjs';
import {
  queueMail,
  flushOutbox,
  outboxSummary,
  recentMail,
  mailApproved,
  mailRejected,
  mailCabinetInvite,
  mailCabinetLinked,
  mailGuardianInvite,
  mailGuardianWardAdded,
  mailGuardianChanged,
  mailTournamentApproved,
  mailTournamentRejected,
} from '../lib/mailer.mjs';

// Кто ведёт данные рейтинга: турниры, игроков, результаты, пересчёт.
const DATA_ROLES = rolesFor('players'); // игроки, заявки, турниры, рейтинг — данные спортсменов
const ANY_ROLE = [...ROLES]; // сводка и «Мой аккаунт» — всем, кто может войти
// Управление пользователями — ТОЛЬКО super-admin (tournament-admin получит 403).
const OWNER_ROLE = ['super-admin'];

// secret — одноразовое значение (временный пароль, ссылка): показывается крупным блоком с кнопкой «Скопировать».
const flash = (req, res, kind, text, back, secret = null) => {
  req.session.flash = secret ? { kind, text, secret } : { kind, text };
  req.session.save(() => res.redirect(back));
};

export default function mountAdmin(app, { db, config, limitWrites }) {
  // Флеш-сообщение достаётся один раз.
  app.use('/admin', (req, res, next) => {
    res.locals.flash = req.session.flash || null;
    if (req.session.flash) delete req.session.flash;
    // Счётчик в меню: заявка, про которую забыли, — это человек без ответа.
    res.locals.pendingCount = db
      .prepare("SELECT COUNT(*) AS n FROM registrations WHERE status = 'pending'")
      .get().n;
    res.locals.pendingTournamentCount = db
      .prepare("SELECT COUNT(*) AS n FROM tournament_requests WHERE status = 'pending'")
      .get().n;
    next();
  });

  // Ошибку валидации внутри админки показываем сообщением, сервер жив.
  const guard = (handler) => (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (err) {
      if (err instanceof ValidationError) {
        // Referer управляется клиентом — берём из него только НАШ локальный путь,
        // иначе получился бы открытый редирект.
        return flash(req, res, 'error', err.message, safeRefererPath(req, '/admin'));
      }
      return next(err);
    }
  };

  // --- дашборд ------------------------------------------------------------
  app.get('/admin', requireRole(...ANY_ROLE), (req, res) => {
    const counts = {
      players: db.prepare('SELECT COUNT(*) AS n FROM players').get().n,
      tournaments: db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n,
      results: db.prepare('SELECT COUNT(*) AS n FROM results').get().n,
      matches: db.prepare('SELECT COUNT(*) AS n FROM matches').get().n,
      snapshots: db.prepare('SELECT COUNT(*) AS n FROM rating_cache').get().n,
    };
    const standings = currentStandings(db);
    res.render('admin/dashboard', {
      title: 'Админка — ФТСО',
      counts,
      standings,
      statusText: standings ? statusLabel(standings.status) : null,
      lock: lockState(db),
      snapshots: lastSnapshots(db, 5).map((s) => ({
        id: s.id,
        computedAt: s.computedAt,
        status: s.status,
        players: s.data.players.length,
      })),
    });
  });

  // --- игроки -------------------------------------------------------------
  app.get('/admin/players', requireRole(...DATA_ROLES), (req, res) => {
    const players = db.prepare('SELECT * FROM players ORDER BY full_name').all();
    res.render('admin/players', {
      title: 'Игроки — админка ФТСО',
      // Состояние согласий рядом с игроком: секретарь должен видеть, ПОЧЕМУ
      // игрок не публикуется, а не гадать по флагу.
      players: players.map((p) => ({
        ...p,
        // Несовершеннолетие — ВЫЧИСЛЯЕМАЯ отметка, а не показ даты рождения:
        // секретарю нужно знать, нужен ли представитель, а не сама дата.
        minor: Boolean(p.birth_date) && isMinor(p.birth_date),
        guardian: activeGuardianFor(db, p.id) || null,
        guardianHistory: guardianHistoryFor(db, p.id),
        consent: consentState(db, p.id),
        // Кабинет: есть ли аккаунт — для кнопки «ссылка для входа» (когда почта не доходит).
        account: accountByPlayer(db, p.id) || null,
        nameParts: splitName(p.full_name),
      })),
      sexes: SEXES,
    });
  });

  app.post(
    '/admin/players',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const data = playerInput(req.body);
      // Публикация результатов — по факту участия (п. 5 ч. 1 ст. 6), поэтому
      // ни флага «публикуется», ни основания публикации у карточки нет.
      // Согласие по ст. 10.1 — только на фото, и оно даётся в кабинете.
      // ДУБЛИ: ФИО + дата рождения и РНИ — стоп; тёзка с другой датой — можно.
      const dup = findDuplicate(db, { full_name: data.full_name, birth_date: data.birth_date });
      if (dup) throw new ValidationError(dup.replace(/ Если у вас.*$/, ''));
      if (data.rni && db.prepare('SELECT id FROM players WHERE rni = ?').get(data.rni)) {
        throw new ValidationError(`РНИ ${data.rni} уже у игрока #${db.prepare('SELECT id FROM players WHERE rni = ?').get(data.rni).id}`);
      }
      const info = db
        .prepare('INSERT INTO players (full_name, city, sex, birth_date, rni) VALUES (?, ?, ?, ?, ?)')
        .run(data.full_name, data.city, data.sex, data.birth_date, data.rni);
      const id = Number(info.lastInsertRowid);
      logAction(db, req.session.user.id, 'player.create', id, data);
      flash(req, res, 'ok', `Игрок «${data.full_name}» добавлен.`, '/admin/players');
    }),
  );

  app.post(
    '/admin/players/:id/update',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const data = playerInput(req.body);
      const before = db.prepare('SELECT id, birth_date FROM players WHERE id = ?').get(id);
      if (!before) throw new ValidationError('Игрок не найден');
      // ДУБЛИ при правке: ФИО + дата (с учётом сохраняемой даты) и РНИ — не про себя.
      const twin = findNameMatches(db, data.full_name, data.birth_date || before.birth_date)
        .find((p) => p.id !== id && p.birth_date && p.birth_date === (data.birth_date || before.birth_date));
      if (twin) throw new ValidationError(`Игрок с такими ФИО и датой рождения уже есть (#${twin.id})`);
      if (data.rni) {
        const rniOwner = db.prepare('SELECT id FROM players WHERE rni = ? AND id <> ?').get(data.rni, id);
        if (rniOwner) throw new ValidationError(`РНИ ${data.rni} уже у игрока #${rniOwner.id}`);
      }
      // COALESCE, а не присваивание: пустое поле формы значит «не менять».
      // Затереть дату рождения случайным сохранением карточки нельзя — по ней
      // работает снятие гейта представителя.
      const info = db
        .prepare(
          'UPDATE players SET full_name = ?, city = ?, sex = ?, birth_date = COALESCE(?, birth_date), rni = ? WHERE id = ?',
        )
        .run(data.full_name, data.city, data.sex, data.birth_date, data.rni, id);
      if (!info.changes) throw new ValidationError('Игрок не найден');
      logAction(db, req.session.user.id, 'player.update', id, data);
      flash(req, res, 'ok', 'Игрок обновлён.', '/admin/players');
    }),
  );

  app.post(
    '/admin/players/:id/delete',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      // ПРАВО НА ЗАБВЕНИЕ (ст. 21): записи согласий стираются явно, не только
      // каскадом — удаление игрока в личном кабинете будет ОБЕЗЛИЧИВАНИЕМ
      // строки, а не DELETE, и каскад там не сработает.
      const wiped = eraseConsents(db, id);
      // Ворота журнала открываем на всё удаление: каскад от players уносит и
      // заявки, а вместе с ними — согласия, данные при подаче. Журнал закрыт на
      // удаление триггером СУБД, и это законное исключение, а не обход.
      withConsentErasure(db, () => db.prepare('DELETE FROM players WHERE id = ?').run(id));
      logAction(db, req.session.user.id, 'player.delete', id, { consents_erased: wiped });
      flash(req, res, 'ok', 'Игрок удалён.', '/admin/players');
    }),
  );

  /**
   * УДАЛЕНИЕ ФОТОГРАФИИ УЧАСТНИКА УПОЛНОМОЧЕННЫМ ЛИЦОМ (ТЗ ред. 6 §7) — на случай
   * неподобающего изображения. Та же механика, что в кабинете: файл с диска,
   * строка uploads, ссылка в players — одной транзакцией; профиль и рейтинг не
   * трогаются. Причина пишется в журнал действий.
   */
  app.post(
    '/admin/players/:id/photo/delete',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT photo_upload_id FROM players WHERE id = ?').get(id);
      if (!row) throw new ValidationError('Игрок не найден');
      if (!row.photo_upload_id) throw new ValidationError('У игрока нет фотографии');
      db.transaction(() => {
        db.prepare('UPDATE players SET photo_upload_id = NULL WHERE id = ?').run(id);
        deleteUpload(db, row.photo_upload_id, config.upload.dir);
        // Фото = единственное данное под ст. 10.1: снятое секретарём фото — это
        // прекращение распространения, в журнал идёт отзыв с пометкой источника.
        setDistributionConsent(db, id, false, { source: 'offline' });
      })();
      logAction(db, req.session.user.id, 'player.photo.delete', id, {
        reason: String(req.body.reason || '').slice(0, 200) || null,
      });
      flash(req, res, 'ok', 'Фотография удалена.', '/admin/players');
    }),
  );

  /**
   * ЗАМЕНА ЗАКОННОГО ПРЕДСТАВИТЕЛЯ — развод, лишение родительских прав, смерть,
   * отзыв представителем согласия на обработку СВОИХ данных.
   *
   * Через админку, а не самообслуживанием, по существу дела: основание замены —
   * документ (решение суда, свидетельство, заявление), и проверяет его человек.
   * Поэтому здесь, как и у публикации ФИО вручную, ОБЯЗАТЕЛЬНЫ основание и дата
   * документа: «в админке нажали кнопку» правовым основанием не является.
   *
   * Запись ИГРОКА не пересоздаётся: меняется представитель, а не участник.
   * Второго действующего представителя не появится — частичный уникальный
   * индекс не даст.
   */
  app.post(
    '/admin/players/:id/guardian',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const player = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
      if (!player) throw new ValidationError('Игрок не найден');
      if (player.anonymized_at) throw new ValidationError('Данные этого игрока удалены');
      if (!player.birth_date || !isMinor(player.birth_date)) {
        throw new ValidationError(
          'Законный представитель назначается только несовершеннолетнему участнику. ' +
            'Проверьте дату рождения в карточке.',
        );
      }
      const data = guardianInput(req.body);
      // Чем подтверждены полномочия и какой датой. Формулировки свои: «основание
      // публикации» здесь читалось бы не о том.
      const proof = {
        basis: str(req.body.guardian_basis, 'Документ, подтверждающий полномочия', { max: 200 }),
        documentDate: isoDate(req.body.guardian_document_date, 'Дата документа'),
      };
      const previous = activeGuardianFor(db, id);

      const out = db.transaction(() => {
        // Старая связь гасится ПЕРВОЙ: частичный уникальный индекс не допустит
        // второго действующего представителя, и порядок здесь не косметика.
        if (previous) revokeWard(db, id, { source: 'offline' });
        const { guardian } = attachGuardian(db, id, data);
        recordGuardianConsent(db, guardian, {
          source: 'offline',
          basis: proof.basis,
          documentDate: proof.documentDate,
        });
        // Основание аккаунта ставим явно: игрока могли завести руками, и без
        // этой отметки гейт (в том числе снятие в 18) не сработает. Взрослого
        // сюда не занесёт — выше проверен возраст по дате рождения.
        db.prepare("UPDATE player_accounts SET consent_basis = 'representative' WHERE player_id = ?").run(id);
        return guardian;
      })();

      // СЕССИИ СНЯТОГО представителя гасим сразу: доработать сеанс в кабинете
      // ребёнка он не должен — полномочий больше нет.
      let revoked = 0;
      if (previous) {
        revoked = revokeGuardianSessions(db, previous.id) + revokePlayerSessions(db, id, null);
      }

      if (!out.password_hash) {
        const token = issueGuardianResetToken(db, out.id);
        const letter = mailGuardianChanged({
          fullName: player.full_name,
          setUrl: `${req.protocol}://${req.get('host')}/cabinet/reset/g/${token}`,
        });
        queueMail(db, { to: out.email, kind: 'cabinet.guardian.changed', ...letter });
      } else {
        const note = mailGuardianWardAdded({ childName: player.full_name });
        queueMail(db, { to: out.email, kind: 'cabinet.guardian.ward', ...note });
      }
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));

      logAction(db, req.session.user.id, 'guardian.replace', id, {
        previous_guardian_id: previous ? previous.id : null,
        guardian_id: out.id,
        sessions_revoked: revoked,
        ...proof,
      });
      flash(
        req,
        res,
        'ok',
        previous
          ? `Законный представитель заменён: ${out.full_name}. Доступ прежнего прекращён.`
          : `Законный представитель назначен: ${out.full_name}.`,
        '/admin/players',
      );
    }),
  );

  // --- заявки на регистрацию ----------------------------------------------
  const statusUrlFor = (req, token) => `${req.protocol}://${req.get('host')}/register/status/${token}`;

  app.get('/admin/registrations', requireRole(...DATA_ROLES), (req, res) => {
    res.render('admin/registrations', {
      title: 'Заявки на регистрацию — админка ФТСО',
      // ВОЗМОЖНОЕ СОВПАДЕНИЕ, а не автослияние: одинаковое ФИО показывается
      // модератору подсказкой, решение о привязке принимает человек.
      pending: pendingRegistrations(db).map((r) => {
        const matches = findNameMatches(db, r.full_name, r.birth_date);
        const minor = Boolean(r.birth_date) && isMinor(r.birth_date);
        return {
          ...r,
          matches,
          minor,
          age: r.birth_date ? ageOn(r.birth_date) : null,
          // Представитель уже заведён — значит, это второй ребёнок: новый логин
          // не появится, участник добавится к существующему доступу.
          guardianKnown: minor && Boolean(guardianByEmail(db, r.guardian_email)),
        };
      }),
      decided: decidedRegistrations(db),
      mail: outboxSummary(db),
      mailLog: recentMail(db, 10),
      sexRu: { M: 'муж.', F: 'жен.' },
    });
  });

  app.post(
    '/admin/registrations/:id/approve',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      // link_player_id пуст -> заводим нового игрока; заполнен -> привязываем
      // заявку к существующему (секретарь ввёл человека раньше).
      const linkTo = String(req.body.link_player_id || '').trim();
      const playerId = linkTo ? intAtLeast(linkTo, 'Игрок для привязки') : null;
      let out;
      try {
        out = approveRegistration(db, id, { playerId, userId: req.session.user.id });
      } catch (err) {
        throw new ValidationError(err.message);
      }
      const reg = out.registration;
      const letter = mailApproved({ fullName: reg.full_name, statusUrl: statusUrlFor(req, reg.status_token) });
      queueMail(db, { to: reg.email, kind: 'registration.approved', ...letter });

      // ЛИЧНЫЙ КАБИНЕТ открывается здесь же: аккаунт создаётся без пароля, а
      // пароль задаётся по одноразовой ссылке. Пароль за человека мы не
      // придумываем и по почте не отправляем.
      //
      // ДЛЯ НЕСОВЕРШЕННОЛЕТНЕГО кабинет заводится на РЕБЁНКА, но БЕЗ почты и
      // без пароля: входит представитель своим логином. Ссылка установки
      // пароля уходит ЕМУ и только если пароля у него ещё нет — второй ребёнок
      // той же матери не заводит второй логин и не сбрасывает ей пароль.
      const host = `${req.protocol}://${req.get('host')}`;
      let account;
      try {
        account = createAccount(db, {
          playerId: out.playerId,
          email: out.guardian ? null : reg.email,
          consentBasis: out.guardian ? 'representative' : 'self',
        });
      } catch (err) {
        if (err.code === 'ACCOUNT_EMAIL_TAKEN') throw new ValidationError(err.message);
        throw err;
      }

      if (out.guardian) {
        // Приглашение — только НОВОМУ представителю. Второй ребёнок той же
        // матери не должен перевыпускать ей токен: это убило бы ссылку из
        // первого письма, по которой она, может быть, как раз идёт.
        if (out.guardianCreated && !out.guardian.password_hash) {
          const token = issueGuardianResetToken(db, out.guardian.id);
          const invite = mailGuardianInvite({
            childName: reg.full_name,
            setUrl: `${host}/cabinet/reset/g/${token}`,
          });
          queueMail(db, { to: out.guardian.email, kind: 'cabinet.guardian.invite', ...invite });
        } else {
          const note = mailGuardianWardAdded({ childName: reg.full_name });
          queueMail(db, { to: out.guardian.email, kind: 'cabinet.guardian.ward', ...note });
        }
      } else if (!account.password_hash) {
        const token = issueResetToken(db, account.id);
        const invite = mailCabinetInvite({
          fullName: reg.full_name,
          setUrl: `${host}/cabinet/reset/${token}`,
        });
        queueMail(db, { to: account.email, kind: 'cabinet.invite', ...invite });
      } else {
        // Пароль у человека уже есть: он законный представитель и входит тем же
        // адресом. Второй пароль ему не нужен — нужен только факт.
        const note = mailCabinetLinked({ fullName: reg.full_name });
        queueMail(db, { to: account.email, kind: 'cabinet.linked', ...note });
      }
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      logAction(db, req.session.user.id, 'registration.approve', id, {
        player_id: out.playerId,
        created_player: out.created,
        minor: Boolean(out.guardian),
        guardian_created: out.guardianCreated,
      });
      flash(
        req,
        res,
        'ok',
        out.created
          ? `Заявка одобрена, игрок «${reg.full_name}» заведён.`
          : `Заявка одобрена и привязана к существующему игроку #${out.playerId}.`,
        '/admin/registrations',
      );
    }),
  );

  app.post(
    '/admin/registrations/:id/reject',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const reason = str(req.body.reason, 'Причина', { max: 300, required: false });
      let reg;
      try {
        reg = rejectRegistration(db, id, { reason, userId: req.session.user.id });
      } catch (err) {
        throw new ValidationError(err.message);
      }
      const letter = mailRejected({
        fullName: reg.full_name,
        reason,
        statusUrl: statusUrlFor(req, reg.status_token),
      });
      queueMail(db, { to: reg.email, kind: 'registration.rejected', ...letter });
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      logAction(db, req.session.user.id, 'registration.reject', id, { reason });
      flash(req, res, 'ok', 'Заявка отклонена, уведомление поставлено в очередь.', '/admin/registrations');
    }),
  );

  // Повторная отправка застрявших писем — ручная кнопка. Автоматической
  // бесконечной ретрай-петли нет намеренно: чинить обычно надо SMTP, а не долбить.
  app.post(
    '/admin/registrations/mail/retry',
    requireRole(...DATA_ROLES),
    limitWrites,
    (req, res, next) => {
      db.prepare("UPDATE mail_outbox SET status = 'queued', attempts = 0 WHERE status = 'failed'").run();
      flushOutbox(db)
        .then((stat) => {
          logAction(db, req.session.user.id, 'mail.retry', null, stat);
          flash(req, res, 'ok', `Отправлено: ${stat.sent}, осталось в очереди: ${stat.pending}.`, '/admin/registrations');
        })
        .catch(next);
    },
  );

  // --- заявки «провести турнир» -------------------------------------------
  const requestStatusUrl = (req, token) =>
    `${req.protocol}://${req.get('host')}/tournament-request/status/${token}`;

  app.get('/admin/tournament-requests', requireRole(...DATA_ROLES), (req, res) => {
    res.render('admin/tournament-requests', {
      title: 'Заявки на турниры — админка ФТСО',
      pending: pendingRequests(db).map((r) => ({ ...r, files: requestFiles(db, r.id) })),
      decided: decidedRequests(db),
    });
  });

  /**
   * ОТДАЧА приложенного документа. Только за логином и только через наш
   * маршрут: файлы лежат вне webroot, статикой не раздаются, и отдаются как
   * attachment — см. lib/uploads.mjs.
   */
  app.get('/admin/files/:id', requireRole(...DATA_ROLES), (req, res, next) => {
    const id = intAtLeast(req.params.id, 'id');
    const row = uploadById(db, id);
    if (!row) return next();
    if (!sendUpload(res, row, config.upload.dir)) return next();
  });

  app.post(
    '/admin/tournament-requests/:id/approve',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      let out;
      try {
        out = approveRequest(db, id, { userId: req.session.user.id });
      } catch (err) {
        throw new ValidationError(err.message);
      }
      const r = out.request;
      // Документы переезжают с заявки на САМ турнир: заявку однажды вычистит
      // срок хранения, а положение турнира в календаре должно остаться.
      attachRequestFiles(db, id, out.tournamentId);
      const letter = mailTournamentApproved({
        organizer: r.organizer,
        name: r.name,
        statusUrl: requestStatusUrl(req, r.status_token),
      });
      queueMail(db, { to: r.email, kind: 'tournament.approved', ...letter });
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      logAction(db, req.session.user.id, 'tournament_request.approve', id, {
        tournament_id: out.tournamentId,
      });
      flash(
        req,
        res,
        'ok',
        `Турнир «${r.name}» согласован и добавлен в календарь (#${out.tournamentId}). ` +
          'Результаты вносятся через раздел «Результаты».',
        '/admin/tournament-requests',
      );
    }),
  );

  app.post(
    '/admin/tournament-requests/:id/reject',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const reason = str(req.body.reason, 'Причина', { max: 300, required: false });
      let r;
      try {
        r = rejectRequest(db, id, { reason, userId: req.session.user.id });
      } catch (err) {
        throw new ValidationError(err.message);
      }
      const letter = mailTournamentRejected({
        organizer: r.organizer,
        name: r.name,
        reason,
        statusUrl: requestStatusUrl(req, r.status_token),
      });
      queueMail(db, { to: r.email, kind: 'tournament.rejected', ...letter });
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      logAction(db, req.session.user.id, 'tournament_request.reject', id, { reason });
      flash(req, res, 'ok', 'Заявка отклонена, уведомление поставлено в очередь.', '/admin/tournament-requests');
    }),
  );

  // --- турниры ------------------------------------------------------------
  app.get('/admin/tournaments', requireRole(...DATA_ROLES), (req, res) => {
    res.render('admin/tournaments', {
      title: 'Турниры — админка ФТСО',
      tournaments: db
        .prepare(
          `SELECT t.*, (SELECT COUNT(*) FROM results r WHERE r.tournament_id = t.id) AS entries
             FROM tournaments t ORDER BY t.end_date DESC`,
        )
        .all(),
      categories: CATEGORIES,
      kindRu: TOURNAMENT_KIND_RU,
    });
  });

  app.post(
    '/admin/tournaments',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const data = tournamentInput(req.body);
      const info = db
        .prepare('INSERT INTO tournaments (name, end_date, category, city, start_date, kind, age_group) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(data.name, data.end_date, data.category, data.city, data.start_date, data.kind, data.age_group);
      logAction(db, req.session.user.id, 'tournament.create', info.lastInsertRowid, data);
      flash(req, res, 'ok', `Турнир «${data.name}» добавлен.`, '/admin/tournaments');
    }),
  );

  app.post(
    '/admin/tournaments/:id/update',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const data = tournamentInput(req.body);
      const info = db
        .prepare('UPDATE tournaments SET name = ?, end_date = ?, category = ?, city = ?, start_date = ?, kind = ?, age_group = ? WHERE id = ?')
        .run(data.name, data.end_date, data.category, data.city, data.start_date, data.kind, data.age_group, id);
      if (!info.changes) throw new ValidationError('Турнир не найден');
      logAction(db, req.session.user.id, 'tournament.update', id, data);
      flash(req, res, 'ok', 'Турнир обновлён.', '/admin/tournaments');
    }),
  );

  app.post(
    '/admin/tournaments/:id/delete',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      db.prepare('DELETE FROM tournaments WHERE id = ?').run(id);
      logAction(db, req.session.user.id, 'tournament.delete', id, null);
      flash(req, res, 'ok', 'Турнир удалён.', '/admin/tournaments');
    }),
  );

  // --- результаты и матчи турнира ----------------------------------------
  app.get('/admin/tournaments/:id/results', requireRole(...DATA_ROLES), (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) return next();
    const id = Number(req.params.id);
    const tournament = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!tournament) return next();
    res.render('admin/results', {
      title: `Результаты: ${tournament.name} — админка ФТСО`,
      tournament,
      players: db.prepare('SELECT id, full_name, city FROM players ORDER BY full_name').all(),
      results: db
        .prepare(
          `SELECT r.id, r.place, p.full_name, p.city
             FROM results r JOIN players p ON p.id = r.player_id
            WHERE r.tournament_id = ? ORDER BY r.place`,
        )
        .all(id),
      matches: db
        .prepare(
          `SELECT m.id, m.score, m.played_on, m.kind, w.full_name AS winner, l.full_name AS loser
             FROM matches m
             JOIN players w ON w.id = m.winner_player_id
             JOIN players l ON l.id = m.loser_player_id
            WHERE m.tournament_id = ? ORDER BY m.id`,
        )
        .all(id),
      maxParticipants: config.rating.maxParticipants,
    });
  });

  app.post(
    '/admin/tournaments/:id/results',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const tournamentId = intAtLeast(req.params.id, 'Турнир');
      const playerId = intAtLeast(req.body.player_id, 'Игрок');
      const place = intAtLeast(req.body.place, 'Место', 1);
      const back = `/admin/tournaments/${tournamentId}/results`;

      if (!db.prepare('SELECT 1 FROM tournaments WHERE id = ?').get(tournamentId)) {
        throw new ValidationError('Турнир не найден');
      }
      if (!db.prepare('SELECT 1 FROM players WHERE id = ?').get(playerId)) {
        throw new ValidationError('Игрок не найден');
      }
      // Лимит участников на турнир — разумный потолок, сверх отклоняем.
      const entries = db
        .prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ?')
        .get(tournamentId).n;
      if (entries >= config.rating.maxParticipants) {
        throw new ValidationError(
          `Достигнут потолок участников турнира (${config.rating.maxParticipants})`,
        );
      }
      try {
        db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, ?)').run(
          tournamentId,
          playerId,
          place,
        );
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          throw new ValidationError('У этого игрока уже есть результат в этом турнире');
        }
        throw err;
      }
      logAction(db, req.session.user.id, 'result.create', tournamentId, { playerId, place });
      flash(req, res, 'ok', 'Результат добавлен.', back);
    }),
  );

  app.post(
    '/admin/results/:id/delete',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT tournament_id FROM results WHERE id = ?').get(id);
      db.prepare('DELETE FROM results WHERE id = ?').run(id);
      logAction(db, req.session.user.id, 'result.delete', id, null);
      flash(
        req,
        res,
        'ok',
        'Результат удалён.',
        row ? `/admin/tournaments/${row.tournament_id}/results` : '/admin/tournaments',
      );
    }),
  );

  app.post(
    '/admin/tournaments/:id/matches',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const tournamentId = intAtLeast(req.params.id, 'Турнир');
      const winner = intAtLeast(req.body.winner_player_id, 'Победитель');
      const loser = intAtLeast(req.body.loser_player_id, 'Проигравший');
      // Счёт и дата — для публичного профиля (ТЗ ред. 6 §5). Оба необязательны:
      // пустая дата на витрине подменяется датой окончания турнира.
      const score = str(req.body.score, 'Счёт', { max: 60, required: false }) || null;
      const playedOn = String(req.body.played_on || '').trim() ? isoDate(req.body.played_on, 'Дата матча') : null;
      const back = `/admin/tournaments/${tournamentId}/results`;
      if (winner === loser) throw new ValidationError('Победитель и проигравший совпадают');
      try {
        db.prepare(
          'INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, played_on) VALUES (?, ?, ?, ?, ?)',
        ).run(tournamentId, winner, loser, score, playedOn);
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          throw new ValidationError('Такой матч уже внесён (обратный матч вносится отдельно)');
        }
        if (String(err.message).includes('FOREIGN KEY')) {
          throw new ValidationError('Турнир или игрок не найден');
        }
        throw err;
      }
      logAction(db, req.session.user.id, 'match.create', tournamentId, { winner, loser });
      flash(req, res, 'ok', 'Матч добавлен.', back);
    }),
  );

  app.post(
    '/admin/matches/:id/delete',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const row = db.prepare('SELECT tournament_id FROM matches WHERE id = ?').get(id);
      db.prepare('DELETE FROM matches WHERE id = ?').run(id);
      logAction(db, req.session.user.id, 'match.delete', id, null);
      flash(
        req,
        res,
        'ok',
        'Матч удалён.',
        row ? `/admin/tournaments/${row.tournament_id}/results` : '/admin/tournaments',
      );
    }),
  );

  // --- пересчёт рейтинга --------------------------------------------------
  // Пересчёт ПО КНОПКЕ, не cron. Лок от двойного нажатия/параллельных вызовов.
  app.post(
    '/admin/rating/recompute',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      let result;
      try {
        result = recompute(db, {
          staleLockMinutes: config.rating.staleLockMinutes,
          keepSnapshots: config.rating.keepSnapshots,
          minIntervalSeconds: config.rating.minIntervalSeconds,
        });
      } catch (err) {
        // Движок падает на битых данных, а не молчит — показываем сообщением,
        // сервер жив, лок уже снят в finally.
        logAction(db, req.session.user.id, 'rating.recompute.failed', null, { error: err.message });
        throw new ValidationError(`Пересчёт не выполнен: ${err.message}`);
      }
      if (!result.ok) {
        const text =
          result.reason === 'too-soon'
            ? `Рейтинг только что пересчитан. Повторный пересчёт возможен через ${result.retryAfter} с — так два почти одинаковых снимка не обнулят колонку «Изменение».`
            : 'Пересчёт уже идёт — подождите.';
        return flash(req, res, 'error', text, '/admin');
      }
      logAction(db, req.session.user.id, 'rating.recompute', result.snapshotId, {
        players: result.players,
      });
      const warn = result.warnings.length ? ` Предупреждения: ${result.warnings.join('; ')}` : '';
      flash(req, res, 'ok', `Рейтинг пересчитан: ${result.players} игроков.${warn}`, '/admin');
    }),
  );

  // --- свой пароль --------------------------------------------------------
  // ИНСТРУКЦИЯ ПО АДМИНИСТРИРОВАНИЮ (ТЗ п. 11) — всем ролям, разделы по правам.
  app.get('/admin/guide', requireRole(...ANY_ROLE), (req, res) => {
    res.render('admin/guide', { title: 'Инструкция — админка ФТСО' });
  });

  app.get('/admin/account', requireRole(...ANY_ROLE), (req, res) => {
    res.render('admin/account', { title: 'Мой аккаунт — админка ФТСО' });
  });

  app.post(
    '/admin/account/password',
    requireRole(...ANY_ROLE),
    limitWrites,
    guard((req, res) => {
      // Смена СВОЕГО пароля требует ТЕКУЩИЙ пароль — иначе угон сессии = постоянный
      // захват аккаунта.
      const current = String(req.body.current_password || '');
      const next = str(req.body.new_password, 'Новый пароль', { min: 10, max: 200 });
      const row = db
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(req.session.user.id);
      if (!row || !verifyPassword(current, row.password_hash)) {
        throw new ValidationError('Текущий пароль неверен');
      }
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
        hashPassword(next),
        req.session.user.id,
      );
      logAction(db, req.session.user.id, 'user.password.self', req.session.user.id, null);
      req.session.user.mustChangePassword = false;
      flash(req, res, 'ok', 'Пароль изменён.', '/admin');
    }),
  );

  // --- пользователи: ТОЛЬКО super-admin (tournament-admin -> 403) ----------
  app.get('/admin/users', requireRole(...OWNER_ROLE), (req, res) => {
    res.render('admin/users', {
      title: 'Пользователи — админка ФТСО',
      users: db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all(),
      roles: ROLES,
      activeRoles: ACTIVE_ROLES,
      log: recentActions(db, 30),
    });
  });

  app.post(
    '/admin/users',
    requireRole(...OWNER_ROLE),
    limitWrites,
    guard((req, res) => {
      // ПУБЛИЧНОЙ формы регистрации НЕТ: пользователей заводит super-admin отсюда.
      const username = str(req.body.username, 'Логин', { min: 3, max: 60 });
      const password = str(req.body.password, 'Пароль', { min: 10, max: 200 });
      const role = oneOf(req.body.role, 'Роль', ROLES);
      try {
        const info = db
          .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
          .run(username, hashPassword(password), role);
        logAction(db, req.session.user.id, 'user.create', info.lastInsertRowid, { username, role });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) {
          throw new ValidationError('Такой логин уже занят');
        }
        throw err;
      }
      flash(req, res, 'ok', `Пользователь «${username}» создан.`, '/admin/users');
    }),
  );

  /**
   * Ссылка для входа в кабинет — на экран секретарю. Нужна, когда письмо не
   * доходит (почта закрыта или адрес неверный): ссылку передают лично.
   * Тот же механизм, что в письме: одноразовый токен, 72 часа.
   */
  app.post(
    '/admin/players/:id/cabinet-link',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      const account = accountByPlayer(db, id);
      if (!account) throw new ValidationError('У игрока нет кабинета — он появляется при одобрении заявки');
      const token = issueResetToken(db, account.id, { hours: 72 });
      const url = `${req.protocol}://${req.get('host')}/cabinet/reset/${token}`;
      logAction(db, req.session.user.id, 'player.cabinet.link', id, null);
      flash(req, res, 'ok', 'Ссылка для входа в кабинет — действует 72 часа, один раз; передайте игроку лично.', '/admin/players', url);
    }),
  );

  app.post(
    '/admin/users/:id/password',
    requireRole(...OWNER_ROLE),
    limitWrites,
    guard((req, res) => {
      // super-admin сбрасывает пароль ДРУГОГО пользователя БЕЗ его текущего:
      // выдаётся ВРЕМЕННЫЙ пароль, показывается один раз, при входе обязательна смена.
      const id = intAtLeast(req.params.id, 'id');
      const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id);
      if (!target) throw new ValidationError('Пользователь не найден');
      const password = temporaryPassword();
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), id);
      logAction(db, req.session.user.id, 'user.password.reset', id, null);
      // СЕБЕ (решение владельца 05.09.2026): временный выдаётся так же, сессия остаётся,
      // но тут же ведёт на смену — временный вводится как «текущий», новый — свой.
      if (id === req.session.user.id) {
        req.session.user.mustChangePassword = true;
        return flash(req, res, 'ok', 'Ваш временный пароль — введите его ниже как текущий и задайте новый. Больше он не покажется.', '/admin/account?change=1', password);
      }
      flash(req, res, 'ok', `Временный пароль для «${target.username}» — сообщите лично; при входе сайт потребует его сменить. Больше он не покажется.`, '/admin/users', password);
    }),
  );

  app.post(
    '/admin/users/:id/delete',
    requireRole(...OWNER_ROLE),
    limitWrites,
    guard((req, res) => {
      const id = intAtLeast(req.params.id, 'id');
      if (id === req.session.user.id) throw new ValidationError('Нельзя удалить самого себя');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      logAction(db, req.session.user.id, 'user.delete', id, null);
      flash(req, res, 'ok', 'Пользователь удалён.', '/admin/users');
    }),
  );
}
