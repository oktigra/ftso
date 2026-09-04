// ЛИЧНЫЙ КАБИНЕТ ИГРОКА.
//
// Сессия игрока держится ОТДЕЛЬНО от админской (req.session.player против
// req.session.user): это разные субъекты с разными правами, и смешивать их в
// одном поле означало бы, что ошибка в одной проверке открывает чужой раздел.
//
// ВХОД ОДИН НА ЧЕЛОВЕКА, а ролей у него может быть две. Родитель, который сам
// играет, — обычное дело в областном теннисе: он и участник рейтинга, и законный
// представитель своего ребёнка, и почтовый ящик у него один. Поэтому адрес почты
// опознаёт ЧЕЛОВЕКА (см. lib/identity.mjs), пароль у него один, а после входа он
// выбирает КАБИНЕТ: свой собственный либо кабинет ребёнка.
//
// Кабинет ребёнка при этом ОДИН И ТОТ ЖЕ: он принадлежит ребёнку, представитель
// в него входит и действует от его имени, пока держится гейт. Отдельного
// «родительского кабинета» нет — был бы второй профиль на одного человека.
// req.session.player — открыт свой кабинет, req.session.guardian — кабинет
// подопечного; cabinetMode говорит, какой из них открыт, когда ролей две.
//
// Что игрок правит: ФИО, почту, фото. Что НЕ правит: рейтинг, очки, места —
// они считаются движком по результатам, а не задаются владельцем профиля.
import { str, email as emailField, ValidationError, personName, splitName } from '../lib/validate.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { storeUpload, deleteUpload, uploadById, sendUpload } from '../lib/uploads.mjs';
import {
  checkPasswordPolicy,
  setPassword,
  issueResetToken,
  accountByResetToken,
  accountByEmail,
  accountByPlayer,
  cabinetProfile,
  playerHistory,
  isAwaitingSelf,
  isFrozen,
  PASSWORD_MIN,
} from '../lib/player-accounts.mjs';
import {
  guardianById,
  guardianByResetToken,
  issueGuardianResetToken,
  activeGuardianFor,
} from '../lib/guardians.mjs';
import {
  accountByTransitionToken,
  completeTransition,
  resendTransitionLink,
} from '../lib/adulthood.mjs';
import {
  cabinetsOf,
  checkPersonLogin,
  guardianOwns,
  personByEmail,
  personExists,
  setPersonPassword,
} from '../lib/identity.mjs';
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
    // заголовок, другие подписи и меньше доступного. Когда ролей две, решает
    // cabinetMode — какой кабинет человек открыл.
    res.locals.actor = cabinetMode(req);
    // Ссылка «другой кабинет» показывается, только если выбирать есть из чего.
    res.locals.hasChoice = Boolean(req.session.player && req.session.guardian);
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
   * КАКОЙ КАБИНЕТ ОТКРЫТ. Когда у человека одна роль, вопроса нет. Когда две
   * (сам играет и отвечает за ребёнка) — решает явный выбор, сделанный на
   * странице «Мои кабинеты»; молча угадывать за человека, чей профиль он хотел
   * открыть, нельзя.
   */
  function cabinetMode(req) {
    const hasPlayer = Boolean(req.session.player);
    const hasGuardian = Boolean(req.session.guardian);
    if (!hasPlayer && !hasGuardian) return null;
    if (req.session.cabinetMode === 'guardian' && hasGuardian) return 'guardian';
    if (req.session.cabinetMode === 'player' && hasPlayer) return 'player';
    if (hasPlayer && !hasGuardian) return 'player';
    if (hasGuardian && !hasPlayer) return 'guardian';
    return null;
  }

  /**
   * ЕДИНЫЙ ГЕЙТ КАБИНЕТА. Пускает либо самого игрока, либо его действующего
   * законного представителя — и в обоих случаях дальше работает ОДИН кабинет
   * одного и того же участника.
   *
   * ПЕРЕХОД В 18 проверяется ЗДЕСЬ ЖЕ и НИЧЕГО НЕ МЕНЯЕТ в БД: фоновая проверка
   * уже перевела аккаунт в 'awaiting_self', а представитель с этого момента не
   * вправе действовать за совершеннолетнего — ему показывается объяснение, а не
   * кабинет. Собственное согласие человек даёт сам, по личной ссылке.
   */
  function requireCabinet(req, res, next) {
    const mode = cabinetMode(req);
    if (!mode) {
      // Роли есть, но какая открыта — не решено: отправляем выбирать.
      if (req.session.player || req.session.guardian) return res.redirect('/cabinet/wards');
      return noAccess(res);
    }
    const guardianSession = mode === 'guardian' ? req.session.guardian : null;
    const playerSession = mode === 'player' ? req.session.player : null;

    const playerId = guardianSession ? guardianSession.playerId : playerSession.playerId;
    if (!playerId) return res.redirect('/cabinet/wards');

    const profile = cabinetProfile(db, playerId);
    // Данные удалены по ст. 21 — открывать нечего. Сессию гасим целиком только
    // если других кабинетов у человека нет: у родителя, удалившего свой
    // профиль, остаётся доступ представителя, и выкидывать его незачем.
    if (!profile || profile.anonymized_at) {
      if (mode === 'player' && req.session.guardian) {
        delete req.session.player;
        req.session.cabinetMode = 'guardian';
        return req.session.save(() => res.redirect('/cabinet/wards'));
      }
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
   * ОДНА форма входа на всех и ОДИН вход на человека. Адрес почты опознаёт
   * человека целиком: и его собственный кабинет, и кабинеты детей, за которых
   * он отвечает. Разводить это на два экрана значило бы заставлять родителя,
   * который сам играет, помнить, «каким из своих логинов» он сейчас входит.
   */
  app.post('/cabinet/login', limitCabinet, (req, res, next) => {
    const login = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const password = String(req.body.password || '');
    const deny = (error, status = 401) =>
      res.status(status).render('cabinet/login', { title: 'Вход в личный кабинет — ФТСО', error, email: login });

    if (!login || !password) return deny('Введите почту и пароль.', 400);

    const person = checkPersonLogin(db, login, password);
    if (!person) {
      // Ответ по времени не должен отличать «адреса нет» от «пароль неверен».
      if (!personExists(db, login)) burnDummyHash(password);
      return deny('Неверная почта или пароль.');
    }

    // Собственный кабинет открывается, только если он есть и работает.
    let account = person.account;
    if (account) {
      const profile = cabinetProfile(db, account.player_id);
      if (!profile || profile.anonymized_at) account = null;
    }
    // ГЕЙТ ПЕРЕХОДА: своему кабинету исполнилось 18, а согласия от себя ещё нет.
    // Если других ролей у человека нет — дальше только через экран перехода;
    // если он ещё и представитель, вход состоится, а свой кабинет будет ждать
    // подтверждения в списке.
    if (account && isAwaitingSelf(account)) {
      if (!person.guardian) {
        return res.status(403).render('cabinet/adult-link', {
          title: 'Подтвердите согласие от себя — ФТСО',
          sent: false,
          frozen: isFrozen(account),
        });
      }
    }
    if (!account && !person.guardian) {
      return deny('Этот кабинет закрыт: данные удалены по заявлению.', 403);
    }

    // Session fixation: ротируем идентификатор сессии ДО записи данных.
    return req.session.regenerate((err) => {
      if (err) return next(err);
      // playerId кладётся в ОБА объекта намеренно: отзыв сессий ищет подстроку
      // "playerId":N, и сессия представителя обязана попадать под тот же поиск —
      // иначе при удалении данных ребёнка она бы уцелела.
      if (account && !isAwaitingSelf(account)) {
        req.session.player = { accountId: account.id, playerId: account.player_id };
      }
      if (person.guardian) req.session.guardian = { guardianId: person.guardian.id, playerId: null };
      // «Сохранить данные для входа» — кука живёт rememberDays вместо 12 часов.
      if (req.body.remember === '1') req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * config.rememberDays;

      const cabinets = cabinetsOf(db, { account, guardian: person.guardian });
      const usable = cabinets.filter((c) => !c.awaitingSelf);
      // Кабинет ровно один — открываем его сразу: выбор из одного варианта это
      // не выбор, а лишний экран.
      if (usable.length === 1 && cabinets.length === 1) {
        const only = usable[0];
        if (only.role === 'self') {
          req.session.cabinetMode = 'player';
        } else {
          req.session.cabinetMode = 'guardian';
          req.session.guardian.playerId = only.playerId;
        }
        return req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/cabinet')));
      }
      return req.session.save((saveErr) => (saveErr ? next(saveErr) : res.redirect('/cabinet/wards')));
    });
  });

  app.post('/cabinet/logout', limitWrites, (req, res, next) => {
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ftso.sid', { httpOnly: true, secure: config.isProd, sameSite: 'lax' });
      res.redirect('/cabinet/login');
    });
  });

  // --- выбор кабинета ------------------------------------------------------
  //
  // Экран существует ровно потому, что у одного человека может быть несколько
  // кабинетов: свой собственный и кабинеты детей, за которых он отвечает.
  // Выбор делает человек, а не система за него.

  /** Роли текущей сессии — из БД, а не из cookie: связь могли снять минуту назад. */
  const sessionRoles = (req) => ({
    account: req.session.player
      ? db.prepare('SELECT * FROM player_accounts WHERE id = ?').get(req.session.player.accountId)
      : null,
    guardian: req.session.guardian ? guardianById(db, req.session.guardian.guardianId) : null,
  });

  app.get('/cabinet/wards', (req, res) => {
    if (!req.session.player && !req.session.guardian) return noAccess(res);
    const roles = sessionRoles(req);
    if (roles.guardian && roles.guardian.revoked_at) roles.guardian = null;
    const cabinets = cabinetsOf(db, roles);
    if (!cabinets.length) {
      return req.session.destroy(() => noAccess(res, { guardianDone: true }));
    }
    res.render('cabinet/wards', {
      title: 'Мои кабинеты — ФТСО',
      person: roles.guardian || roles.account,
      email: (roles.guardian && roles.guardian.email) || (roles.account && roles.account.email) || '',
      guardianName: roles.guardian ? roles.guardian.full_name : null,
      cabinets,
    });
  });

  app.post('/cabinet/wards/select', limitWrites, (req, res, next) => {
    if (!req.session.player && !req.session.guardian) return noAccess(res);
    const playerId = Number(String(req.body.player_id || '').trim());
    const roles = sessionRoles(req);
    // Выбор проверяется по РОЛЯМ, а не по присланному числу: иначе чужой
    // кабинет открывался бы подстановкой id в форму.
    const target = cabinetsOf(db, roles).find((c) => c.playerId === playerId);
    if (!target) return noAccess(res);
    // СВОЙ кабинет, которому исполнилось 18, открывать нечем: сперва собственное
    // согласие. Кабинет ПОДОПЕЧНОГО в том же состоянии открывается — но покажет
    // представителю объяснение вместо действий (см. requireCabinet).
    if (target.role === 'self' && target.awaitingSelf) return res.redirect('/cabinet/adult');

    if (target.role === 'self') {
      req.session.cabinetMode = 'player';
    } else {
      req.session.cabinetMode = 'guardian';
      req.session.guardian.playerId = playerId;
    }
    return req.session.save((err) => (err ? next(err) : res.redirect('/cabinet')));
  });

  // --- профиль -------------------------------------------------------------
  app.get('/cabinet', requireCabinet, (req, res) => {
    const profile = req.playerProfile;
    res.render('cabinet/index', {
      title: 'Личный кабинет — ФТСО',
      profile,
      nameParts: splitName(profile.full_name),
      consent: consentState(db, profile.id),
      history: playerHistory(db, profile.id),
      passwordMin: PASSWORD_MIN,
      byGuardian: req.actor.kind === 'guardian',
      // Ссылка «другой кабинет» показывается, только когда их правда несколько.
      cabinetCount: cabinetsOf(db, sessionRoles(req)).length,
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
      const fullName = personName(fields);
      // ПОЧТУ РЕБЁНКА НЕ ТРОГАЕМ: пока держится гейт, её нет вовсе, а контакт —
      // почта представителя, и меняется она в его собственном профиле.
      const newEmail = byGuardian ? null : emailField(fields.email);

      if (newEmail) {
        // Почта — логин в кабинет, поэтому занятый адрес отклоняем явно.
        const taken = accountByEmail(db, newEmail);
        if (taken && taken.player_id !== profile.id) {
          throw new ValidationError('Этот адрес почты уже используется другим кабинетом.');
        }
        // ЗАХВАТ РОЛИ. Адрес, под которым входит законный представитель, даёт
        // доступ к кабинетам его детей. Сменив на него свою почту, посторонний
        // получил бы этот доступ вместе с ним. Пара «участник + представитель»
        // на одном адресе создаётся ТОЛЬКО модерацией, самообслуживанием — нет.
        if (guardianOwns(db, newEmail)) {
          throw new ValidationError(
            'Этот адрес уже используется для входа законного представителя. ' +
              'Укажите другой или обратитесь в Федерацию.',
          );
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
        // ЗАГРУЗКА ФОТО = СОГЛАСИЕ на его распространение (ст. 10.1, раздел 2
        // Согласия). Замена — отзыв по прежнему снимку и выдача по новому, обе
        // строки той же транзакцией, что и сама замена: фото и согласие не
        // расходятся ни на миг.
        if (storedPhoto) {
          if (previousPhoto) setDistributionConsent(db, profile.id, false, { source: 'web', ip: req.ip });
          setDistributionConsent(db, profile.id, true, { source: 'web', ip: req.ip });
        }
      })();
      // Старое фото убираем ПОСЛЕ успешной замены: иначе неудачная загрузка
      // оставила бы профиль вообще без фотографии.
      if (storedPhoto && previousPhoto) deleteUpload(db, previousPhoto, config.upload.dir);

      logAction(db, null, 'cabinet.profile.update', profile.id, {
        photo: Boolean(storedPhoto),
        by: byGuardian ? 'guardian' : 'player',
      });
      if (storedPhoto) {
        logAction(db, null, 'consent.distribution.granted', profile.id, {
          source: 'web', photo: true, by: byGuardian ? 'guardian' : 'player',
        });
      }
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
   * УДАЛЕНИЕ ФОТОГРАФИИ (ТЗ ред. 6 §7): файл уходит с диска, строка uploads — из
   * БД, ссылка в players обнуляется одной транзакцией. После этого /player/:id/photo
   * отвечает 404 сразу, а профиль открывается без изображения. Всё остальное —
   * рейтинг, результаты, матчи — не затрагивается.
   */
  app.post('/cabinet/photo/delete', requireCabinet, limitWrites, (req, res) => {
    const profile = req.playerProfile;
    if (!profile.photo_upload_id) return flash(req, res, 'error', 'Фотография не загружена.', '/cabinet');
    const uploadId = profile.photo_upload_id;
    const byGuardian = req.actor.kind === 'guardian';
    db.transaction(() => {
      db.prepare('UPDATE players SET photo_upload_id = NULL WHERE id = ?').run(profile.id);
      deleteUpload(db, uploadId, config.upload.dir);
      // УДАЛЕНИЕ ФОТО = ОТЗЫВ согласия на его распространение (п. 2.5 Согласия).
      // Единственный способ отозвать: отдельной кнопки «отозвать» нет, потому
      // что фото и есть согласие — снял фото, снял и согласие.
      setDistributionConsent(db, profile.id, false, { source: 'web', ip: req.ip });
    })();
    logAction(db, null, 'cabinet.photo.delete', profile.id, { by: byGuardian ? 'guardian' : 'player' });
    logAction(db, null, 'consent.distribution.revoked', profile.id, {
      source: 'web', photo: true, by: byGuardian ? 'guardian' : 'player',
    });
    return flash(req, res, 'ok', 'Фотография удалена; отзыв согласия на её распространение записан в журнал.', '/cabinet');
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

      // ПАРОЛЬ У ЧЕЛОВЕКА ОДИН на все его роли: и на собственный кабинет, и на
      // доступ представителя. Менять его «в одной роли» значит оставить старый
      // пароль работающим в другой — то есть не сменить.
      const guardian = byGuardian ? guardianById(db, req.actor.guardianId) : null;
      const account = byGuardian ? null : accountByPlayer(db, profile.id);
      const email = guardian ? guardian.email : account.email;
      const who = guardian ? guardian.full_name : profile.full_name;

      if (!checkPersonLogin(db, email, current)) {
        throw new ValidationError('Текущий пароль введён неверно.');
      }
      checkPasswordPolicy(next1, { email, fullName: who });
      const spread = setPersonPassword(db, email, next1);

      // ОТЗЫВ СЕССИЙ: если пароль меняют потому, что его увели, чужая сессия
      // обязана умереть здесь же, а не дожить до истечения.
      const revoked = revokePlayerSessions(db, profile.id, req.sessionID);
      logAction(db, null, 'cabinet.password.change', profile.id, {
        by: byGuardian ? 'guardian' : 'player',
        roles_updated: spread.accounts + spread.guardians,
        sessions_revoked: revoked,
      });
      return flash(
        req,
        res,
        'ok',
        spread.accounts && spread.guardians
          ? `Пароль изменён — он общий для вашего кабинета и доступа представителя. Остальные входы прекращены (${revoked}).`
          : `Пароль изменён. Остальные входы в кабинет прекращены (${revoked}).`,
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
    const person = personByEmail(db, login);
    // ОДНО ПИСЬМО НА ЧЕЛОВЕКА, даже если ролей у него две: пароль общий, и
    // новый, заданный по ссылке, встанет сразу на все роли (setPersonPassword).
    // Ссылка выдаётся от собственного кабинета, если он есть, иначе от доступа
    // представителя — токены живут в разных таблицах.
    let token = null;
    let letter = null;
    if (person.account) {
      const profile = cabinetProfile(db, person.account.player_id);
      if (profile && !profile.anonymized_at) {
        token = issueResetToken(db, person.account.id);
        letter = mailPasswordReset({
          fullName: profile.full_name,
          setUrl: `${baseUrl(req)}/cabinet/reset/${token}`,
        });
      }
    }
    if (!token && person.guardian && !person.guardian.revoked_at) {
      token = issueGuardianResetToken(db, person.guardian.id);
      letter = mailPasswordReset({
        fullName: person.guardian.full_name,
        setUrl: `${baseUrl(req)}/cabinet/reset/g/${token}`,
      });
    }
    if (letter) {
      queueMail(db, { to: person.email, kind: 'cabinet.reset', ...letter });
      flushOutbox(db).catch((err) => console.error('[почта] разбор очереди упал', err));
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
      // Пароль общий на все роли адреса: если этот же человек ещё и законный
      // представитель, второй пароль ему заводить незачем.
      if (account.email) setPersonPassword(db, account.email, password);
      else setPassword(db, account.id, password);
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
      setPersonPassword(db, guardian.email, password);
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
    const values = { email: String(req.body.email || '') };
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
        uploadDir: config.upload.dir,
        ip: req.ip,
      });
      logAction(db, null, 'cabinet.adult.completed', account.player_id, {});
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
