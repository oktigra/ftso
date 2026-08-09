// ЛИЧНЫЙ КАБИНЕТ ИГРОКА.
//
// Сессия игрока держится ОТДЕЛЬНО от админской (req.session.player против
// req.session.user): это разные субъекты с разными правами, и смешивать их в
// одном поле означало бы, что ошибка в одной проверке открывает чужой раздел.
//
// ТРЕТИЙ ВХОД — ЗАКОННЫЙ ПРЕДСТАВИТЕЛЬ (req.session.guardian). Кабинет при этом
// ОДИН И ТОТ ЖЕ: он принадлежит ребёнку, представитель в него входит своим
// логином и действует от имени ребёнка, пока держится гейт. Отдельного
// «родительского кабинета» нет — был бы второй профиль на одного человека.
//
// Что игрок правит: ФИО, почту, фото. Что НЕ правит: рейтинг, очки, места —
// они считаются движком по результатам, а не задаются владельцем профиля.
import { str, email as emailField, ValidationError } from '../lib/validate.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { storeUpload, deleteUpload, uploadById, sendUpload } from '../lib/uploads.mjs';
import {
  checkLogin,
  checkPasswordPolicy,
  setPassword,
  issueResetToken,
  accountByResetToken,
  accountByEmail,
  accountByPlayer,
  cabinetProfile,
  playerHistory,
  isRepresented,
  isAwaitingSelf,
  isFrozen,
  PASSWORD_MIN,
} from '../lib/player-accounts.mjs';
import {
  checkGuardianLogin,
  guardianByEmail,
  guardianById,
  guardianByResetToken,
  issueGuardianResetToken,
  setGuardianPassword,
  wardsOf,
  activeGuardianFor,
} from '../lib/guardians.mjs';
import {
  accountByTransitionToken,
  completeTransition,
  resendTransitionLink,
} from '../lib/adulthood.mjs';
import { erasePlayer, revokePlayerSessions } from '../lib/erasure.mjs';
import { setDistributionConsent, consentState } from '../lib/consent-journal.mjs';
import { queueMail, flushOutbox, mailPasswordReset, mailErased } from '../lib/mailer.mjs';
import { logAction } from '../lib/action-log.mjs';
import { OPERATOR } from '../lib/legal.mjs';
import { burnDummyHash } from '../lib/password.mjs';

const PHOTO_PROFILE = 'gallery';

export default function mountCabinet(app, { db, config, limitWrites, limitCabinet }) {
  const flash = (req, res, kind, text, back) => {
    req.session.cabinetFlash = { kind, text };
    req.session.save(() => res.redirect(back));
  };
  const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

  app.use('/cabinet', (req, res, next) => {
    res.locals.cabinetFlash = req.session.cabinetFlash || null;
    if (req.session.cabinetFlash) delete req.session.cabinetFlash;
    res.locals.op = OPERATOR;
    // Кто действует — знает каждый шаблон кабинета: у представителя другой
    // заголовок, другие подписи и меньше доступного.
    res.locals.actor = req.session.guardian ? 'guardian' : req.session.player ? 'player' : null;
    next();
  });

  /**
   * СТРАНИЦА «НЕТ ДОСТУПА» вместо сухого 403: незалогиненный игрок должен
   * понять, откуда у него берётся доступ (заявка -> одобрение -> письмо),
   * а не увидеть отказ без объяснения.
   */
  const noAccess = (res, extra = {}) =>
    res.status(403).render('cabinet/no-access', { title: 'Личный кабинет — ФТСО', ...extra });

  /**
   * ЕДИНЫЙ ГЕЙТ КАБИНЕТА. Пускает либо самого игрока, либо его действующего
   * законного представителя — и в обоих случаях дальше работает ОДИН кабинет
   * одного и того же ребёнка.
   *
   * ПЕРЕХОД В 18 проверяется ЗДЕСЬ ЖЕ и НИЧЕГО НЕ МЕНЯЕТ в БД: фоновая проверка
   * уже перевела аккаунт в 'awaiting_self', а представитель с этого момента не
   * вправе действовать за совершеннолетнего — ему показывается объяснение, а не
   * кабинет. Собственное согласие человек даёт сам, по личной ссылке.
   */
  function requireCabinet(req, res, next) {
    const guardianSession = req.session.guardian;
    const playerSession = req.session.player;
    if (!guardianSession && !playerSession) return noAccess(res);

    const playerId = guardianSession ? guardianSession.playerId : playerSession.playerId;
    if (!playerId) return res.redirect('/cabinet/wards');

    const profile = cabinetProfile(db, playerId);
    // Данные удалены по ст. 21 — входить больше некуда, и сессию гасим.
    if (!profile || profile.anonymized_at) {
      return req.session.destroy(() => noAccess(res, { erased: true }));
    }

    if (guardianSession) {
      // Связь могли снять (замена представителя, переход в 18) прямо во время
      // сеанса — проверяем на КАЖДОМ запросе, а не только при входе.
      const link = activeGuardianFor(db, playerId);
      if (!link || link.id !== guardianSession.guardianId) {
        delete req.session.guardian.playerId;
        return req.session.save(() =>
          res.status(403).render('cabinet/ward-gone', {
            title: 'Доступ представителя прекращён — ФТСО',
            fullName: profile.full_name,
          }),
        );
      }
      if (profile.basis === 'awaiting_self') {
        return res.status(200).render('cabinet/adult-notice', {
          title: 'Участнику исполнилось 18 — ФТСО',
          fullName: profile.full_name,
          frozen: Boolean(profile.frozen_at),
        });
      }
      req.actor = { kind: 'guardian', guardianId: guardianSession.guardianId, playerId };
    } else {
      req.actor = { kind: 'player', accountId: playerSession.accountId, playerId };
    }
    req.playerProfile = profile;
    return next();
  }

  // --- вход ----------------------------------------------------------------
  app.get('/cabinet/login', (req, res) => {
    if (req.session.player || req.session.guardian) return res.redirect('/cabinet');
    res.render('cabinet/login', { title: 'Вход в личный кабинет — ФТСО', error: null, email: '' });
  });

  /**
   * ОДНА форма входа на всех. Сперва проверяется аккаунт участника, затем —
   * законного представителя: адреса живут в разных таблицах, и разводить два
   * похожих экрана значило бы заставлять человека угадывать, какой из них его.
   */
  app.post('/cabinet/login', limitCabinet, (req, res, next) => {
    const login = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const password = String(req.body.password || '');
    const deny = (error, status = 401) =>
      res.status(status).render('cabinet/login', { title: 'Вход в личный кабинет — ФТСО', error, email: login });

    if (!login || !password) return deny('Введите почту и пароль.', 400);

    const account = checkLogin(db, login, password);
    if (account) {
      const profile = cabinetProfile(db, account.player_id);
      if (!profile || profile.anonymized_at) return deny('Этот кабинет закрыт: данные удалены по заявлению.', 403);
      // ГЕЙТ ПЕРЕХОДА: аккаунт, которому уже исполнилось 18, дальше пускается
      // только через экран перехода. Ссылка на него личная и уже отправлена —
      // здесь остаётся объяснить, где её взять.
      if (isAwaitingSelf(account)) {
        return res.status(403).render('cabinet/adult-link', {
          title: 'Подтвердите согласие от себя — ФТСО',
          sent: false,
          frozen: isFrozen(account),
        });
      }
      // Session fixation: ротируем идентификатор сессии ДО записи данных.
      return req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.player = { accountId: account.id, playerId: account.player_id };
        req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/cabinet')));
      });
    }

    const guardian = checkGuardianLogin(db, login, password);
    if (guardian) {
      return req.session.regenerate((err) => {
        if (err) return next(err);
        // playerId кладётся В ТОТ ЖЕ объект намеренно: отзыв сессий ищет
        // подстроку "playerId":N, и сессия представителя обязана попадать под
        // тот же поиск — иначе при удалении данных ребёнка она бы уцелела.
        req.session.guardian = { guardianId: guardian.id, playerId: null };
        req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/cabinet/wards')));
      });
    }

    // Ответ по времени не должен отличать «адреса нет» от «пароль неверен».
    if (!accountByEmail(db, login) && !guardianByEmail(db, login)) burnDummyHash(password);
    return deny('Неверная почта или пароль.');
  });

  app.post('/cabinet/logout', limitWrites, (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ftso.sid', { httpOnly: true, secure: config.isProd, sameSite: 'lax' });
      res.redirect('/cabinet/login');
    });
  });

  // --- подопечные представителя -------------------------------------------
  app.get('/cabinet/wards', (req, res) => {
    const session = req.session.guardian;
    if (!session) return noAccess(res);
    const guardian = guardianById(db, session.guardianId);
    if (!guardian || guardian.revoked_at) {
      return req.session.destroy(() => noAccess(res, { guardianDone: true }));
    }
    res.render('cabinet/wards', {
      title: 'Участники — личный кабинет ФТСО',
      guardian,
      wards: wardsOf(db, guardian.id),
    });
  });

  app.post('/cabinet/wards/select', limitWrites, (req, res, next) => {
    const session = req.session.guardian;
    if (!session) return noAccess(res);
    const playerId = Number(String(req.body.player_id || '').trim());
    // Выбор проверяется по СВЯЗИ, а не по присланному числу: иначе чужой
    // кабинет открывался бы подстановкой id в форму.
    const allowed = wardsOf(db, session.guardianId).some((w) => w.player_id === playerId);
    if (!allowed) return noAccess(res);
    req.session.guardian.playerId = playerId;
    return req.session.save((err) => (err ? next(err) : res.redirect('/cabinet')));
  });

  // --- профиль -------------------------------------------------------------
  app.get('/cabinet', requireCabinet, (req, res) => {
    const profile = req.playerProfile;
    res.render('cabinet/index', {
      title: 'Личный кабинет — ФТСО',
      profile,
      consent: consentState(db, profile.id),
      history: playerHistory(db, profile.id),
      passwordMin: PASSWORD_MIN,
      byGuardian: req.actor.kind === 'guardian',
      wardCount: req.actor.kind === 'guardian' ? wardsOf(db, req.actor.guardianId).length : 0,
    });
  });

  /** Фото профиля — через тот же слой отдачи: вне webroot, attachment. */
  app.get('/cabinet/photo', requireCabinet, (req, res, next) => {
    const profile = req.playerProfile;
    if (!profile.photo_upload_id) return next();
    const row = uploadById(db, profile.photo_upload_id);
    if (!row || !sendUpload(res, row, config.upload.dir)) return next();
  });

  app.post('/cabinet/profile', requireCabinet, limitWrites, async (req, res, next) => {
    const profile = req.playerProfile;
    const byGuardian = req.actor.kind === 'guardian';
    let storedPhoto = null;
    try {
      const { fields, files } = await parseMultipart(req, {
        maxFileBytes: 8 * 1024 * 1024,
        maxFiles: 1,
      });
      const fullName = str(fields.full_name, 'ФИО', { max: 120 });
      // ПОЧТУ РЕБЁНКА НЕ ТРОГАЕМ: пока держится гейт, её нет вовсе, а контакт —
      // почта представителя, и меняется она в его собственном профиле.
      const newEmail = byGuardian ? null : emailField(fields.email);

      if (newEmail) {
        // Почта — логин в кабинет, поэтому занятый адрес отклоняем явно.
        const taken = accountByEmail(db, newEmail);
        if (taken && taken.player_id !== profile.id) {
          throw new ValidationError('Этот адрес почты уже используется другим кабинетом.');
        }
      }

      const photo = files.find((f) => f.field === 'photo');
      if (photo) {
        storedPhoto = await storeUpload(db, {
          buffer: photo.buffer,
          filename: photo.filename,
          profile: PHOTO_PROFILE,
          dir: config.upload.dir,
          meta: { kind: 'player-photo', playerId: profile.id },
        });
      }

      const previousPhoto = profile.photo_upload_id;
      db.transaction(() => {
        db.prepare('UPDATE players SET full_name = ?, photo_upload_id = COALESCE(?, photo_upload_id) WHERE id = ?')
          .run(fullName, storedPhoto ? storedPhoto.id : null, profile.id);
        if (newEmail) {
          db.prepare('UPDATE player_accounts SET email = ? WHERE player_id = ?').run(newEmail, profile.id);
        }
      })();
      // Старое фото убираем ПОСЛЕ успешной замены: иначе неудачная загрузка
      // оставила бы профиль вообще без фотографии.
      if (storedPhoto && previousPhoto) deleteUpload(db, previousPhoto, config.upload.dir);

      logAction(db, null, 'cabinet.profile.update', profile.id, {
        photo: Boolean(storedPhoto),
        by: byGuardian ? 'guardian' : 'player',
      });
      return flash(req, res, 'ok', 'Профиль обновлён.', '/cabinet');
    } catch (err) {
      if (storedPhoto) {
        try {
          deleteUpload(db, storedPhoto.id, config.upload.dir);
        } catch (e) {
          console.error('[кабинет] не удалось убрать фото после отката', e);
        }
      }
      if (err instanceof ValidationError) return flash(req, res, 'error', err.message, '/cabinet');
      if (err.status === 403) return next(err);
      return next(err);
    }
  });

  /**
   * Согласие на публикацию игрок отзывает и возвращает САМ — это его право.
   * За несовершеннолетнего им распоряжается законный представитель: согласие на
   * распространение за ребёнка давал он, ему же принадлежит и отзыв.
   */
  app.post('/cabinet/publication', requireCabinet, limitWrites, (req, res) => {
    const profile = req.playerProfile;
    const byGuardian = req.actor.kind === 'guardian';
    const wanted = String(req.body.publish || '') === '1';
    setDistributionConsent(db, profile.id, wanted, { source: 'web', ip: req.ip });
    logAction(db, null, wanted ? 'consent.distribution.granted' : 'consent.distribution.revoked', profile.id, {
      source: 'web',
      by: byGuardian ? 'guardian' : 'player',
    });
    return flash(
      req,
      res,
      'ok',
      wanted
        ? 'Согласие на публикацию дано — результаты видны в открытом рейтинге.'
        : 'Согласие на публикацию отозвано. В открытых таблицах на месте фамилии — «Скрыто по заявлению»; место и очки сохранены.',
      '/cabinet',
    );
  });

  // --- пароль --------------------------------------------------------------
  //
  // Под сессией представителя меняется пароль ПРЕДСТАВИТЕЛЯ: своего пароля у
  // ребёнка под гейтом нет, и «сменить пароль ребёнка» означало бы завести ему
  // вход, которого по закону быть не должно.
  app.post('/cabinet/password', requireCabinet, limitWrites, (req, res, next) => {
    const profile = req.playerProfile;
    const byGuardian = req.actor.kind === 'guardian';
    try {
      const current = String(req.body.current_password || '');
      const next1 = String(req.body.new_password || '');
      if (next1 !== String(req.body.new_password2 || '')) {
        throw new ValidationError('Новый пароль и его повтор не совпадают.');
      }

      if (byGuardian) {
        const guardian = guardianById(db, req.actor.guardianId);
        if (!checkGuardianLogin(db, guardian.email, current)) {
          throw new ValidationError('Текущий пароль введён неверно.');
        }
        checkPasswordPolicy(next1, { email: guardian.email, fullName: guardian.full_name });
        setGuardianPassword(db, guardian.id, next1);
        logAction(db, null, 'cabinet.password.change', profile.id, { by: 'guardian' });
        return flash(req, res, 'ok', 'Пароль представителя изменён.', '/cabinet');
      }

      const account = accountByPlayer(db, profile.id);
      if (!checkLogin(db, account.email, current)) {
        throw new ValidationError('Текущий пароль введён неверно.');
      }
      checkPasswordPolicy(next1, { email: account.email, fullName: profile.full_name });
      setPassword(db, account.id, next1);

      // ОТЗЫВ СЕССИЙ: если пароль меняют потому, что его увели, чужая сессия
      // обязана умереть здесь же, а не дожить до истечения.
      const revoked = revokePlayerSessions(db, profile.id, req.sessionID);
      logAction(db, null, 'cabinet.password.change', profile.id, { sessions_revoked: revoked });
      return flash(
        req,
        res,
        'ok',
        `Пароль изменён. Остальные входы в кабинет прекращены (${revoked}).`,
        '/cabinet',
      );
    } catch (err) {
      if (err instanceof ValidationError) return flash(req, res, 'error', err.message, '/cabinet');
      return next(err);
    }
  });

  // --- сброс пароля по почте ----------------------------------------------
  app.get('/cabinet/forgot', (req, res) => {
    res.render('cabinet/forgot', { title: 'Восстановление доступа — ФТСО', done: false });
  });

  app.post('/cabinet/forgot', limitCabinet, (req, res) => {
    const login = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const account = accountByEmail(db, login);
    if (account) {
      const profile = cabinetProfile(db, account.player_id);
      if (profile && !profile.anonymized_at) {
        const token = issueResetToken(db, account.id);
        const letter = mailPasswordReset({
          fullName: profile.full_name,
          setUrl: `${baseUrl(req)}/cabinet/reset/${token}`,
        });
        queueMail(db, { to: account.email, kind: 'cabinet.reset', ...letter });
        flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      }
    } else {
      // Представитель восстанавливает доступ тем же путём и тем же ответом.
      const guardian = guardianByEmail(db, login);
      if (guardian && !guardian.revoked_at) {
        const token = issueGuardianResetToken(db, guardian.id);
        const letter = mailPasswordReset({
          fullName: guardian.full_name,
          setUrl: `${baseUrl(req)}/cabinet/reset/g/${token}`,
        });
        queueMail(db, { to: guardian.email, kind: 'cabinet.reset', ...letter });
        flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      }
    }
    // Ответ ОДИНАКОВЫЙ независимо от того, есть такой адрес или нет: иначе
    // форма превращается в проверку «зарегистрирован ли этот человек».
    res.render('cabinet/forgot', { title: 'Восстановление доступа — ФТСО', done: true });
  });

  app.get('/cabinet/reset/:token', (req, res, next) => {
    const account = accountByResetToken(db, req.params.token);
    if (!account) return next();
    res.render('cabinet/reset', {
      title: 'Новый пароль — ФТСО',
      action: `/cabinet/reset/${req.params.token}`,
      error: null,
      passwordMin: PASSWORD_MIN,
    });
  });

  app.post('/cabinet/reset/:token', limitCabinet, (req, res, next) => {
    const account = accountByResetToken(db, req.params.token);
    if (!account) return next();
    const render = (error) =>
      res.status(400).render('cabinet/reset', {
        title: 'Новый пароль — ФТСО',
        action: `/cabinet/reset/${req.params.token}`,
        error,
        passwordMin: PASSWORD_MIN,
      });
    try {
      const password = String(req.body.password || '');
      if (password !== String(req.body.password2 || '')) {
        throw new ValidationError('Пароль и его повтор не совпадают.');
      }
      const profile = cabinetProfile(db, account.player_id);
      checkPasswordPolicy(password, { email: account.email, fullName: profile ? profile.full_name : '' });
      setPassword(db, account.id, password);
      // Смена пароля по ссылке — тоже повод выкинуть все прежние сессии.
      revokePlayerSessions(db, account.player_id, null);
      logAction(db, null, 'cabinet.password.reset', account.player_id, null);
      return res.render('cabinet/reset-done', { title: 'Пароль установлен — ФТСО' });
    } catch (err) {
      if (err instanceof ValidationError) return render(err.message);
      return next(err);
    }
  });

  // Установка и сброс пароля ПРЕДСТАВИТЕЛЯ. Отдельный адрес, потому что токены
  // живут в разных таблицах, а совпадение хэшей между ними было бы случайностью,
  // на которую нельзя опираться при выборе, чей пароль менять.
  app.get('/cabinet/reset/g/:token', (req, res, next) => {
    const guardian = guardianByResetToken(db, req.params.token);
    if (!guardian) return next();
    res.render('cabinet/reset', {
      title: 'Новый пароль представителя — ФТСО',
      action: `/cabinet/reset/g/${req.params.token}`,
      error: null,
      passwordMin: PASSWORD_MIN,
    });
  });

  app.post('/cabinet/reset/g/:token', limitCabinet, (req, res, next) => {
    const guardian = guardianByResetToken(db, req.params.token);
    if (!guardian) return next();
    const render = (error) =>
      res.status(400).render('cabinet/reset', {
        title: 'Новый пароль представителя — ФТСО',
        action: `/cabinet/reset/g/${req.params.token}`,
        error,
        passwordMin: PASSWORD_MIN,
      });
    try {
      const password = String(req.body.password || '');
      if (password !== String(req.body.password2 || '')) {
        throw new ValidationError('Пароль и его повтор не совпадают.');
      }
      checkPasswordPolicy(password, { email: guardian.email, fullName: guardian.full_name });
      setGuardianPassword(db, guardian.id, password);
      logAction(db, null, 'cabinet.guardian.password.reset', guardian.id, null);
      return res.render('cabinet/reset-done', { title: 'Пароль установлен — ФТСО' });
    } catch (err) {
      if (err instanceof ValidationError) return render(err.message);
      return next(err);
    }
  });

  // --- переход в 18 --------------------------------------------------------
  //
  // Вход сюда ТОЛЬКО по личной ссылке: своего пароля у вчерашнего ребёнка нет, а
  // представитель за совершеннолетнего решать уже не вправе. Ссылка приходит на
  // известный контакт, но форму заполняет сам человек.
  const transitionView = (req, res, account, { error = null, values = {}, status = 200 }) => {
    const player = db.prepare('SELECT full_name FROM players WHERE id = ?').get(account.player_id);
    return res.status(status).render('cabinet/adult', {
      title: 'Согласие от себя — ФТСО',
      token: req.params.token,
      fullName: player ? player.full_name : '',
      frozen: Boolean(account.frozen_at),
      error,
      values,
      passwordMin: PASSWORD_MIN,
    });
  };

  /** Ссылка устарела или потерялась — экран «выслать заново». */
  app.get('/cabinet/adult', (req, res) => {
    res.render('cabinet/adult-link', { title: 'Подтвердите согласие от себя — ФТСО', sent: false, frozen: false });
  });

  app.post('/cabinet/adult/resend', limitCabinet, (req, res) => {
    resendTransitionLink(db, req.body.email, { baseUrl: baseUrl(req) });
    flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
    // Ответ одинаков независимо от результата — как и в восстановлении пароля.
    res.render('cabinet/adult-link', { title: 'Ссылка отправлена — ФТСО', sent: true, frozen: false });
  });

  app.get('/cabinet/adult/:token', (req, res, next) => {
    const account = accountByTransitionToken(db, req.params.token);
    if (!account) return next();
    return transitionView(req, res, account, {});
  });

  app.post('/cabinet/adult/:token', limitCabinet, (req, res, next) => {
    const account = accountByTransitionToken(db, req.params.token);
    if (!account) return next();
    const values = { email: String(req.body.email || ''), distribution: req.body.consent_distribution === '1' };
    try {
      // Согласие на ОБРАБОТКУ — обязательное условие: без него нет основания
      // хранить данные, и «завершить переход» означало бы обрабатывать их без
      // основания. Отказ ведёт не сюда, а на удаление — соседней кнопкой.
      if (req.body.consent_processing !== '1') {
        throw new ValidationError(
          'Без согласия на обработку персональных данных кабинет работать не может — ' +
            'это его правовое основание. Если согласия вы не даёте, воспользуйтесь удалением данных.',
        );
      }
      completeTransition(db, account.id, {
        email: req.body.email,
        password: String(req.body.password || ''),
        password2: String(req.body.password2 || ''),
        distribution: req.body.consent_distribution === '1',
        ip: req.ip,
      });
      logAction(db, null, 'cabinet.adult.completed', account.player_id, {
        distribution: req.body.consent_distribution === '1',
      });
      // Человек уже подтвердил, кто он: пускаем его в кабинет сразу, не заставляя
      // тут же входить только что заданным паролем.
      return req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.player = { accountId: account.id, playerId: account.player_id };
        req.session.cabinetFlash = {
          kind: 'ok',
          text: 'Согласие принято от вашего имени. Кабинет теперь ваш: логин — указанная почта.',
        };
        req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/cabinet')));
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return transitionView(req, res, account, { error: err.message, values, status: 400 });
      }
      return next(err);
    }
  });

  /**
   * ОТКАЗ от собственного согласия на экране перехода = требование удаления.
   * Отдельным подтверждением словом, как и в обычном удалении: действие
   * необратимо, и «случайно нажал» здесь стоит человеку всей его истории.
   */
  app.get('/cabinet/adult/:token/erase', (req, res, next) => {
    const account = accountByTransitionToken(db, req.params.token);
    if (!account) return next();
    const profile = cabinetProfile(db, account.player_id);
    if (!profile) return next();
    res.render('cabinet/delete', {
      title: 'Удаление данных — ФТСО',
      profile,
      action: `/cabinet/adult/${req.params.token}/erase`,
      byGuardian: false,
      adultDecline: true,
    });
  });

  app.post('/cabinet/adult/:token/erase', limitCabinet, async (req, res, next) => {
    const account = accountByTransitionToken(db, req.params.token);
    if (!account) return next();
    const profile = cabinetProfile(db, account.player_id);
    if (!profile) return next();
    try {
      if (String(req.body.confirm || '').trim().toUpperCase() !== 'УДАЛИТЬ') {
        throw new ValidationError('Для подтверждения введите слово УДАЛИТЬ.');
      }
      await eraseAndNotify(db, profile, config, { by: 'adult-decline' });
      return res.render('cabinet/erased', { title: 'Данные удалены — ФТСО', op: OPERATOR });
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).render('cabinet/delete', {
          title: 'Удаление данных — ФТСО',
          profile,
          action: `/cabinet/adult/${req.params.token}/erase`,
          byGuardian: false,
          adultDecline: true,
          error: err.message,
        });
      }
      return next(err);
    }
  });

  // --- удаление данных (ст. 21) -------------------------------------------
  app.get('/cabinet/delete', requireCabinet, (req, res) => {
    res.render('cabinet/delete', {
      title: 'Удаление данных — ФТСО',
      profile: req.playerProfile,
      action: '/cabinet/delete',
      byGuardian: req.actor.kind === 'guardian',
      adultDecline: false,
    });
  });

  app.post('/cabinet/delete', requireCabinet, limitWrites, async (req, res, next) => {
    const profile = req.playerProfile;
    try {
      // Подтверждение словом, а не одной кнопкой: действие необратимо.
      if (String(req.body.confirm || '').trim().toUpperCase() !== 'УДАЛИТЬ') {
        throw new ValidationError('Для подтверждения введите слово УДАЛИТЬ.');
      }
      await eraseAndNotify(db, profile, config, { by: req.actor.kind });
      return req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie('ftso.sid', { httpOnly: true, secure: config.isProd, sameSite: 'lax' });
        res.render('cabinet/erased', { title: 'Данные удалены — ФТСО', op: OPERATOR });
      });
    } catch (err) {
      if (err instanceof ValidationError) return flash(req, res, 'error', err.message, '/cabinet/delete');
      return next(err);
    }
  });
}

/**
 * УДАЛЕНИЕ + УВЕДОМЛЕНИЕ. Вынесено, потому что вызывается из двух мест: из
 * кабинета (сам участник или его представитель) и с экрана перехода в 18, где
 * отказ от собственного согласия и есть требование удаления.
 *
 * ПОРЯДОК ВАЖЕН: письмо ставим в очередь и пытаемся отправить ДО обезличивания —
 * после него адреса уже нет. Если отправить не удалось, письмо не «подождёт в
 * очереди»: обезличивание уносит и его, потому что хранить адрес человека,
 * потребовавшего удаления, нельзя даже ради уведомления. Уведомление —
 * вежливость, удаление — обязанность.
 */
async function eraseAndNotify(db, profile, config, { by }) {
  const guardian = activeGuardianFor(db, profile.id);
  const to = profile.email || (guardian ? guardian.email : null);
  if (to) {
    const letter = mailErased({ fullName: profile.full_name });
    queueMail(db, { to, kind: 'cabinet.erased', ...letter });
    await flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
  }
  const report = erasePlayer(db, profile.id, { uploadDir: config.upload.dir });
  logAction(db, null, 'cabinet.erase', profile.id, {
    by,
    matches_kept: report.matchesKept,
    results_kept: report.resultsKept,
    guardians_removed: report.guardiansRemoved,
    snapshots_scrubbed: report.snapshotsScrubbed,
    vacuumed: report.vacuumed,
  });
  return report;
}
