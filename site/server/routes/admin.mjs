import { requireRole, ROLES, ACTIVE_ROLES } from '../middleware/auth.mjs';
import { safeRefererPath } from '../lib/safe-path.mjs';
import { hashPassword, verifyPassword } from '../lib/password.mjs';
import { logAction, recentActions } from '../lib/action-log.mjs';
import {
  playerInput,
  publicFlag,
  tournamentInput,
  intAtLeast,
  isoDate,
  str,
  oneOf,
  AGE_GROUPS,
  SEXES,
  CATEGORIES,
  ValidationError,
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
  registrationAllowsPublication,
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
import { createAccount, issueResetToken } from '../lib/player-accounts.mjs';
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
const DATA_ROLES = ['super-admin', 'tournament-admin'];
// Управление пользователями — ТОЛЬКО super-admin (tournament-admin получит 403).
const OWNER_ROLE = ['super-admin'];

/**
 * ПРАВОВОЕ ОСНОВАНИЕ публикации для игроков, заводимых секретарём вручную.
 * Галочка в админке основанием не является: человек, который сам ничего не
 * отмечал на сайте, должен иметь документ — и документ должен быть НАЗВАН,
 * иначе публикацию его ФИО нечем оправдать.
 */
const publicationBasis = (body) => ({
  basis: str(body.consent_basis, 'Основание публикации', { max: 200 }),
  documentDate: isoDate(body.consent_document_date, 'Дата согласия'),
});

const flash = (req, res, kind, text, back) => {
  req.session.flash = { kind, text };
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
  app.get('/admin', requireRole(...DATA_ROLES), (req, res) => {
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
        // ОТМЕТКА В КАРТОЧКЕ: чем и от какой даты подтверждена публикация.
        proof: db
          .prepare(
            "SELECT basis, document_date, at FROM consents " +
              "WHERE player_id = ? AND kind = 'distribution' AND event = 'granted' ORDER BY id DESC LIMIT 1",
          )
          .get(p.id) || null,
      })),
      ageGroups: AGE_GROUPS,
      sexes: SEXES,
    });
  });

  app.post(
    '/admin/players',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const data = playerInput(req.body);
      const publish = publicFlag(req.body);
      const info = db
        .prepare('INSERT INTO players (full_name, city, sex, age_group, birth_date, rni) VALUES (?, ?, ?, ?, ?, ?)')
        .run(data.full_name, data.city, data.sex, data.age_group, data.birth_date, data.rni);
      const id = Number(info.lastInsertRowid);
      // Публикация включается ТОЛЬКО событием журнала: секретарь отмечает, что
      // бумажное согласие на распространение получено. Прямой записи в is_public
      // нет нигде, иначе витрина разъедется с согласием.
      if (publish === true) {
        const proof = publicationBasis(req.body);
        setDistributionConsent(db, id, true, { source: 'offline', ...proof });
        logAction(db, req.session.user.id, 'consent.distribution.granted', id, { source: 'offline', ...proof });
      }
      logAction(db, req.session.user.id, 'player.create', id, { ...data, is_public: publish === true ? 1 : 0 });
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
      const publish = publicFlag(req.body);
      const before = db.prepare('SELECT is_public FROM players WHERE id = ?').get(id);
      if (!before) throw new ValidationError('Игрок не найден');
      // COALESCE, а не присваивание: пустое поле формы значит «не менять».
      // Затереть дату рождения случайным сохранением карточки нельзя — по ней
      // работает снятие гейта представителя.
      const info = db
        .prepare(
          'UPDATE players SET full_name = ?, city = ?, sex = ?, age_group = ?, birth_date = COALESCE(?, birth_date), rni = ? WHERE id = ?',
        )
        .run(data.full_name, data.city, data.sex, data.age_group, data.birth_date, data.rni, id);
      if (!info.changes) throw new ValidationError('Игрок не найден');
      // Смена публикации = событие журнала (выдача или ОТЗЫВ согласия на
      // распространение), а не правка флага. Отзыв по ч. 12-13 ст. 10.1 обязан
      // снять публикацию — здесь это происходит сразу, а не за 3 рабочих дня.
      // publish === null («поле не пришло») согласие НЕ трогает.
      if (publish !== null && Boolean(before.is_public) !== publish) {
        // Основание требуется только при ВКЛЮЧЕНИИ публикации. Отзыв обоснования
        // не требует: это воля субъекта, и задерживать её нечем.
        const proof = publish ? publicationBasis(req.body) : {};
        setDistributionConsent(db, id, publish, { source: 'offline', ...proof });
        logAction(
          db,
          req.session.user.id,
          publish ? 'consent.distribution.granted' : 'consent.distribution.revoked',
          id,
          { source: 'offline', ...proof },
        );
      }
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
        const allowsPublication = registrationAllowsPublication(db, r.id);
        const matches = findNameMatches(db, r.full_name);
        const minor = Boolean(r.birth_date) && isMinor(r.birth_date);
        return {
          ...r,
          matches,
          allowsPublication,
          minor,
          age: r.birth_date ? ageOn(r.birth_date) : null,
          // Представитель уже заведён — значит, это второй ребёнок: новый логин
          // не появится, участник добавится к существующему доступу.
          guardianKnown: minor && Boolean(guardianByEmail(db, r.guardian_email)),
          // КОНФЛИКТ ВОЛИ: заявитель публикацию НЕ разрешил, а найденный тёзка
          // сейчас публикуется. Само это не решается: если это тот же человек,
          // публикацию надо снять; если однофамилец — трогать нельзя. Решает
          // модератор, поэтому просто показываем.
          publicationConflict: !allowsPublication && matches.some((m) => m.is_public),
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
    });
  });

  app.post(
    '/admin/tournaments',
    requireRole(...DATA_ROLES),
    limitWrites,
    guard((req, res) => {
      const data = tournamentInput(req.body);
      const info = db
        .prepare('INSERT INTO tournaments (name, end_date, category) VALUES (?, ?, ?)')
        .run(data.name, data.end_date, data.category);
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
        .prepare('UPDATE tournaments SET name = ?, end_date = ?, category = ? WHERE id = ?')
        .run(data.name, data.end_date, data.category, id);
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
  app.get('/admin/account', requireRole(...DATA_ROLES), (req, res) => {
    res.render('admin/account', { title: 'Мой аккаунт — админка ФТСО' });
  });

  app.post(
    '/admin/account/password',
    requireRole(...DATA_ROLES),
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
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
        hashPassword(next),
        req.session.user.id,
      );
      logAction(db, req.session.user.id, 'user.password.self', req.session.user.id, null);
      flash(req, res, 'ok', 'Пароль изменён.', '/admin/account');
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

  app.post(
    '/admin/users/:id/password',
    requireRole(...OWNER_ROLE),
    limitWrites,
    guard((req, res) => {
      // super-admin сбрасывает пароль ДРУГОГО пользователя БЕЗ его текущего —
      // это корректно для админ-сброса и прописано явно.
      const id = intAtLeast(req.params.id, 'id');
      const password = str(req.body.password, 'Новый пароль', { min: 10, max: 200 });
      const info = db
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(hashPassword(password), id);
      if (!info.changes) throw new ValidationError('Пользователь не найден');
      logAction(db, req.session.user.id, 'user.password.reset', id, null);
      flash(req, res, 'ok', 'Пароль пользователя сброшен.', '/admin/users');
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
