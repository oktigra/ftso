// ЛИЧНЫЙ КАБИНЕТ ИГРОКА.
//
// Сессия игрока держится ОТДЕЛЬНО от админской (req.session.player против
// req.session.user): это разные субъекты с разными правами, и смешивать их в
// одном поле означало бы, что ошибка в одной проверке открывает чужой раздел.
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
  PASSWORD_MIN,
} from '../lib/player-accounts.mjs';
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

  app.use('/cabinet', (req, res, next) => {
    res.locals.cabinetFlash = req.session.cabinetFlash || null;
    if (req.session.cabinetFlash) delete req.session.cabinetFlash;
    res.locals.op = OPERATOR;
    next();
  });

  /**
   * СТРАНИЦА «НЕТ ДОСТУПА» вместо сухого 403: незалогиненный игрок должен
   * понять, откуда у него берётся доступ (заявка -> одобрение -> письмо),
   * а не увидеть отказ без объяснения.
   */
  function requirePlayer(req, res, next) {
    const player = req.session.player;
    if (!player) {
      return res.status(403).render('cabinet/no-access', { title: 'Личный кабинет — ФТСО' });
    }
    const profile = cabinetProfile(db, player.playerId);
    // Данные удалены по ст. 21 — входить больше некуда, и сессию гасим.
    if (!profile || profile.anonymized_at) {
      return req.session.destroy(() =>
        res.status(403).render('cabinet/no-access', { title: 'Личный кабинет — ФТСО', erased: true }),
      );
    }
    req.playerProfile = profile;
    return next();
  }

  // --- вход ----------------------------------------------------------------
  app.get('/cabinet/login', (req, res) => {
    if (req.session.player) return res.redirect('/cabinet');
    res.render('cabinet/login', { title: 'Вход в личный кабинет — ФТСО', error: null, email: '' });
  });

  app.post('/cabinet/login', limitCabinet, (req, res, next) => {
    const login = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const password = String(req.body.password || '');
    const deny = (error, status = 401) =>
      res.status(status).render('cabinet/login', { title: 'Вход в личный кабинет — ФТСО', error, email: login });

    if (!login || !password) return deny('Введите почту и пароль.', 400);

    const account = checkLogin(db, login, password);
    if (!account) {
      // Ответ по времени не должен отличать «адреса нет» от «пароль неверен».
      if (!accountByEmail(db, login)) burnDummyHash(password);
      return deny('Неверная почта или пароль.');
    }
    const profile = cabinetProfile(db, account.player_id);
    if (!profile || profile.anonymized_at) return deny('Этот кабинет закрыт: данные удалены по заявлению.', 403);

    // Session fixation: ротируем идентификатор сессии ДО записи данных.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.player = { accountId: account.id, playerId: account.player_id };
      req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/cabinet')));
    });
  });

  app.post('/cabinet/logout', limitWrites, (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ftso.sid', { httpOnly: true, secure: config.isProd, sameSite: 'lax' });
      res.redirect('/cabinet/login');
    });
  });

  // --- профиль -------------------------------------------------------------
  app.get('/cabinet', requirePlayer, (req, res) => {
    const profile = req.playerProfile;
    res.render('cabinet/index', {
      title: 'Личный кабинет — ФТСО',
      profile,
      consent: consentState(db, profile.id),
      history: playerHistory(db, profile.id),
      passwordMin: PASSWORD_MIN,
    });
  });

  /** Фото профиля — через тот же слой отдачи: вне webroot, attachment. */
  app.get('/cabinet/photo', requirePlayer, (req, res, next) => {
    const profile = req.playerProfile;
    if (!profile.photo_upload_id) return next();
    const row = uploadById(db, profile.photo_upload_id);
    if (!row || !sendUpload(res, row, config.upload.dir)) return next();
  });

  app.post('/cabinet/profile', requirePlayer, limitWrites, async (req, res, next) => {
    const profile = req.playerProfile;
    let storedPhoto = null;
    try {
      const { fields, files } = await parseMultipart(req, {
        maxFileBytes: 8 * 1024 * 1024,
        maxFiles: 1,
      });
      const fullName = str(fields.full_name, 'ФИО', { max: 120 });
      const newEmail = emailField(fields.email);

      // Почта — логин в кабинет, поэтому занятый адрес отклоняем явно.
      const taken = accountByEmail(db, newEmail);
      if (taken && taken.player_id !== profile.id) {
        throw new ValidationError('Этот адрес почты уже используется другим кабинетом.');
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
        db.prepare('UPDATE player_accounts SET email = ? WHERE player_id = ?').run(newEmail, profile.id);
      })();
      // Старое фото убираем ПОСЛЕ успешной замены: иначе неудачная загрузка
      // оставила бы профиль вообще без фотографии.
      if (storedPhoto && previousPhoto) deleteUpload(db, previousPhoto, config.upload.dir);

      logAction(db, null, 'cabinet.profile.update', profile.id, { photo: Boolean(storedPhoto) });
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

  /** Согласие на публикацию игрок отзывает и возвращает САМ — это его право. */
  app.post('/cabinet/publication', requirePlayer, limitWrites, (req, res) => {
    const profile = req.playerProfile;
    const wanted = String(req.body.publish || '') === '1';
    setDistributionConsent(db, profile.id, wanted, { source: 'web', ip: req.ip });
    logAction(db, null, wanted ? 'consent.distribution.granted' : 'consent.distribution.revoked', profile.id, {
      source: 'web',
      by: 'player',
    });
    return flash(
      req,
      res,
      'ok',
      wanted
        ? 'Согласие на публикацию дано — ваши результаты видны в открытом рейтинге.'
        : 'Согласие на публикацию отозвано. В открытых таблицах на месте вашей фамилии — «Скрыто по заявлению»; место и очки сохранены.',
      '/cabinet',
    );
  });

  // --- пароль --------------------------------------------------------------
  app.post('/cabinet/password', requirePlayer, limitWrites, (req, res, next) => {
    const profile = req.playerProfile;
    try {
      const account = accountByPlayer(db, profile.id);
      const current = String(req.body.current_password || '');
      if (!checkLogin(db, account.email, current)) {
        throw new ValidationError('Текущий пароль введён неверно.');
      }
      const next1 = String(req.body.new_password || '');
      if (next1 !== String(req.body.new_password2 || '')) {
        throw new ValidationError('Новый пароль и его повтор не совпадают.');
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
        const setUrl = `${req.protocol}://${req.get('host')}/cabinet/reset/${token}`;
        const letter = mailPasswordReset({ fullName: profile.full_name, setUrl });
        queueMail(db, { to: account.email, kind: 'cabinet.reset', ...letter });
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
      token: req.params.token,
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
        token: req.params.token,
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

  // --- удаление данных (ст. 21) -------------------------------------------
  app.get('/cabinet/delete', requirePlayer, (req, res) => {
    res.render('cabinet/delete', { title: 'Удаление данных — ФТСО', profile: req.playerProfile });
  });

  app.post('/cabinet/delete', requirePlayer, limitWrites, async (req, res, next) => {
    const profile = req.playerProfile;
    try {
      // Подтверждение словом, а не одной кнопкой: действие необратимо.
      if (String(req.body.confirm || '').trim().toUpperCase() !== 'УДАЛИТЬ') {
        throw new ValidationError('Для подтверждения введите слово УДАЛИТЬ.');
      }
      const account = accountByPlayer(db, profile.id);
      // ПОРЯДОК ВАЖЕН: письмо ставим в очередь и пытаемся отправить ДО
      // обезличивания — после него адреса уже нет. Если отправить не удалось,
      // письмо не «подождёт в очереди»: обезличивание уносит и его, потому что
      // хранить адрес человека, потребовавшего удаления, нельзя даже ради
      // уведомления. Уведомление — вежливость, удаление — обязанность.
      if (account) {
        const letter = mailErased({ fullName: profile.full_name });
        queueMail(db, { to: account.email, kind: 'cabinet.erased', ...letter });
        await flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
      }
      const report = erasePlayer(db, profile.id, { uploadDir: config.upload.dir });
      logAction(db, null, 'cabinet.erase', profile.id, {
        matches_kept: report.matchesKept,
        results_kept: report.resultsKept,
        snapshots_scrubbed: report.snapshotsScrubbed,
        vacuumed: report.vacuumed,
      });
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
