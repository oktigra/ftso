// ПЕРЕХОД В 18 — КОНЕЧНЫЙ АВТОМАТ.
//
//   representative --(фоновая проверка: исполнилось 18)--> awaiting_self
//   awaiting_self  --(человек подтвердил согласие от себя)--> self
//   awaiting_self  --(30 дней молчания)--> awaiting_self + frozen_at (заморозка)
//   frozen         --(человек подтвердил согласие от себя)--> self
//
// ТРИ ПРАВИЛА, из которых вырос весь модуль:
//
//  1) ПЕРЕХОД НЕ СЛУЧАЕТСЯ ПОСРЕДИ СЕАНСА. Фоновая проверка меняет только
//     строку аккаунта и НЕ трогает живые сессии: представитель, набирающий
//     текст в кабинете в полночь, не должен обнаружить себя выкинутым. Гейт
//     срабатывает при следующем входе — там сессии этого кабинета и гасятся.
//
//  2) ДЕТЕКТ ДОГОНЯЕТ. Ищутся не «те, кому исполнилось 18 сегодня», а ВСЕ
//     аккаунты с consent_basis = 'representative' и возрастом ≥ 18. Сервер
//     стоял неделю, таймер не отработал, база поднята из старого бэкапа —
//     просроченные всё равно найдутся, потому что они всё ещё
//     'representative'. Повторный проход идемпотентен: найденные уже не
//     'representative'.
//
//  3) ПОПАСТЬ НА ЭКРАН ПЕРЕХОДА МОЖНО ТОЛЬКО ПО ЛИЧНОЙ ССЫЛКЕ. Своего входа у
//     вчерашнего ребёнка нет (почта пуста, пароля не было), а представитель с
//     наступлением 18 действовать за него уже не вправе — иначе «собственное
//     согласие совершеннолетнего» дал бы за него родитель, и оно ничего не
//     стоило бы. Ссылка уходит на известный контакт (представителя), но
//     заполняет форму сам человек.
import { randomBytes, createHash } from 'node:crypto';
import { ADULT_AGE, ValidationError, email as emailField, today } from './validate.mjs';
import { OPERATOR } from './legal.mjs';
import {
  accountByEmail,
  checkPasswordPolicy,
  setPassword,
  isAwaitingSelf,
} from './player-accounts.mjs';
import { revokeWard } from './guardians.mjs';
import { recordConsent, revokeCovered, syncPlayerPublicFlag } from './consent-journal.mjs';
import { revokePlayerSessions } from './erasure.mjs';
import {
  queueMail,
  mailAdultTransition,
  mailAdultReminder,
  mailAdultFrozen,
  mailAdultFrozenStaff,
  mailAdultUnreachable,
} from './mailer.mjs';

export const REMINDER_DAYS = 14;
export const FREEZE_DAYS = 30;

const hashToken = (token) => createHash('sha256').update(String(token || '')).digest('hex');

/**
 * Токен экрана перехода. В БД лежит ХЭШ: дамп базы не должен давать доступ к
 * чужому переходу. Срока годности намеренно нет — протухшая ссылка означала бы
 * человека, запертого снаружи собственных данных; гасится завершением перехода.
 */
export function issueTransitionToken(db, accountId) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('UPDATE player_accounts SET transition_token = ? WHERE id = ?').run(hashToken(token), accountId);
  return token;
}

export function accountByTransitionToken(db, token) {
  if (!token) return undefined;
  return db
    .prepare("SELECT * FROM player_accounts WHERE transition_token = ? AND consent_basis = 'awaiting_self'")
    .get(hashToken(token));
}

export const transitionUrl = (baseUrl, token) =>
  `${String(baseUrl).replace(/\/+$/, '')}/cabinet/adult/${token}`;

/** Кому писать: своя почта, если она уже есть, иначе контакт представителя. */
const CONTACT_SQL = `
  SELECT a.id, a.player_id, a.email, a.transition_token, p.full_name,
         (SELECT g.email FROM guardian_wards w JOIN guardians g ON g.id = w.guardian_id
           WHERE w.player_id = p.id AND w.revoked_at IS NULL) AS guardian_email
    FROM player_accounts a JOIN players p ON p.id = a.player_id`;

/**
 * ФОНОВАЯ ПРОВЕРКА. Возвращает отчёт по каждому шагу — он идёт в лог сервера,
 * чтобы «переход не сработал» было видно, а не выяснялось от человека, который
 * не может войти.
 */
export function runAdulthoodCheck(db, { baseUrl, now = today() } = {}) {
  const report = { promoted: 0, reminded: 0, frozen: 0, unreachable: 0 };

  /** Письмо человеку; некуда писать — это отдельная беда, и о ней узнаёт секретарь. */
  const notify = (acc, kind, letter) => {
    const to = acc.email || acc.guardian_email;
    if (to) {
      queueMail(db, { to, kind, ...letter });
      return true;
    }
    queueMail(db, {
      to: OPERATOR.email,
      kind: 'cabinet.adult.unreachable',
      ...mailAdultUnreachable({ playerId: acc.player_id, fullName: acc.full_name }),
    });
    report.unreachable += 1;
    return false;
  };

  // --- шаг 1: гейт представителя снят, начался переход ----------------------
  const grown = db
    .prepare(
      `${CONTACT_SQL}
        WHERE a.consent_basis = 'representative'
          AND p.birth_date IS NOT NULL
          AND p.anonymized_at IS NULL
          AND p.birth_date <= date(?, ?)`,
    )
    .all(now, `-${ADULT_AGE} years`);

  for (const acc of grown) {
    db.transaction(() => {
      db.prepare(
        `UPDATE player_accounts
            SET consent_basis = 'awaiting_self', transition_started_at = datetime('now')
          WHERE id = ? AND consent_basis = 'representative'`,
      ).run(acc.id);
      const token = issueTransitionToken(db, acc.id);
      notify(acc, 'cabinet.adult.start', mailAdultTransition({
        fullName: acc.full_name,
        url: transitionUrl(baseUrl, token),
      }));
    })();
    report.promoted += 1;
  }

  // --- шаг 2: напоминание на +14 дней --------------------------------------
  // Токен выдаётся НОВЫЙ: в БД лежит только его хэш, и восстановить прежнюю
  // ссылку для письма нечем. Прежняя перестаёт работать — это осознанно:
  // рабочая ссылка всегда одна, из последнего письма, а на устаревшую отвечает
  // экран «запросить ссылку заново» (см. routes/cabinet.mjs).
  const toRemind = db
    .prepare(
      `${CONTACT_SQL}
        WHERE a.consent_basis = 'awaiting_self'
          AND a.transition_reminded_at IS NULL
          AND a.frozen_at IS NULL
          AND p.anonymized_at IS NULL
          AND a.transition_started_at <= datetime('now', ?)`,
    )
    .all(`-${REMINDER_DAYS} days`);

  for (const acc of toRemind) {
    db.transaction(() => {
      db.prepare("UPDATE player_accounts SET transition_reminded_at = datetime('now') WHERE id = ?")
        .run(acc.id);
      const token = issueTransitionToken(db, acc.id);
      notify(acc, 'cabinet.adult.reminder', mailAdultReminder({
        fullName: acc.full_name,
        url: transitionUrl(baseUrl, token),
        daysLeft: FREEZE_DAYS - REMINDER_DAYS,
      }));
    })();
    report.reminded += 1;
  }

  // --- шаг 3: заморозка на +30 дней ----------------------------------------
  // Данные НЕ удаляются: молчание — не отзыв согласия и не требование удаления.
  // Кабинет становится недоступен для действий, а секретарь узнаёт о человеке,
  // оставшемся без работающего кабинета: возможно, до него просто не дошло
  // письмо, и связаться нужно иначе.
  const toFreeze = db
    .prepare(
      `${CONTACT_SQL}
        WHERE a.consent_basis = 'awaiting_self'
          AND a.frozen_at IS NULL
          AND p.anonymized_at IS NULL
          AND a.transition_started_at <= datetime('now', ?)`,
    )
    .all(`-${FREEZE_DAYS} days`);

  for (const acc of toFreeze) {
    db.transaction(() => {
      db.prepare("UPDATE player_accounts SET frozen_at = datetime('now') WHERE id = ?").run(acc.id);
      const token = issueTransitionToken(db, acc.id);
      notify(acc, 'cabinet.adult.frozen', mailAdultFrozen({
        fullName: acc.full_name,
        url: transitionUrl(baseUrl, token),
      }));
      queueMail(db, {
        to: OPERATOR.email,
        kind: 'cabinet.adult.frozen.staff',
        ...mailAdultFrozenStaff({ playerId: acc.player_id, fullName: acc.full_name }),
      });
    })();
    report.frozen += 1;
  }

  return report;
}

/**
 * ВЫСЛАТЬ ССЫЛКУ ЗАНОВО. Ссылка устарела, письмо потерялось, ящик представителя
 * недоступен — человек не должен из-за этого остаться отрезанным от своих
 * данных. Ищем по ЛЮБОМУ известному контакту незавершённого перехода: своей
 * почте (если уже указана) или почте действующего представителя.
 *
 * Ответ вызывающему одинаков независимо от того, нашлось что-то или нет —
 * иначе форма превращается в проверку «есть ли такой участник».
 */
export function resendTransitionLink(db, contactEmail, { baseUrl }) {
  const address = String(contactEmail || '').trim().toLowerCase();
  if (!address) return false;
  const acc = db
    .prepare(
      `${CONTACT_SQL}
        WHERE a.consent_basis = 'awaiting_self'
          AND p.anonymized_at IS NULL
          AND (a.email = ? OR EXISTS (
                SELECT 1 FROM guardian_wards w JOIN guardians g ON g.id = w.guardian_id
                 WHERE w.player_id = p.id AND w.revoked_at IS NULL AND g.email = ?))`,
    )
    .get(address, address);
  if (!acc) return false;
  const token = issueTransitionToken(db, acc.id);
  queueMail(db, {
    to: acc.email || acc.guardian_email,
    kind: 'cabinet.adult.resend',
    ...mailAdultTransition({ fullName: acc.full_name, url: transitionUrl(baseUrl, token) }),
  });
  return true;
}

/**
 * ЗАВЕРШЕНИЕ ПЕРЕХОДА. Одной транзакцией, потому что промежуточное состояние
 * здесь — это либо аккаунт без основания обработки, либо два действующих
 * согласия от разных людей на одни и те же данные.
 *
 * Порядок событий в журнале важен: сперва ОТЗЫВ представительских согласий (с
 * той редакцией, которую они покрывали), потом СОБСТВЕННОЕ согласие текущей
 * редакции. Обратный порядок читался бы как «человек подтвердил, а потом всё
 * отозвал».
 *
 * Согласие на ОБРАБОТКУ обязательно: без него нет основания хранить данные, и
 * завершать переход нечем. Отказ — это не «пустая форма», а требование удаления,
 * и обрабатывается он отдельным экраном (см. routes/cabinet.mjs).
 */
export function completeTransition(db, accountId, { email, password, password2, distribution = false, ip = null }) {
  const account = db.prepare('SELECT * FROM player_accounts WHERE id = ?').get(accountId);
  if (!account) throw new ValidationError('Кабинет не найден.');
  if (!isAwaitingSelf(account)) throw new ValidationError('Переход для этого кабинета не требуется.');

  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(account.player_id);
  if (!player || player.anonymized_at) throw new ValidationError('Данные этого участника удалены.');

  const newEmail = emailField(email, 'Ваша электронная почта');
  // ПОЧТА-ДУБЛИКАТ. Занять чужой адрес нельзя: адрес и есть логин, и молча
  // подменить им чужой вход — прямой путь к захвату кабинета.
  const taken = accountByEmail(db, newEmail);
  if (taken && taken.id !== account.id) {
    throw new ValidationError(
      'Этот адрес почты уже используется другим кабинетом. Укажите свой адрес — он станет вашим логином.',
    );
  }
  if (String(password) !== String(password2)) {
    throw new ValidationError('Пароль и его повтор не совпадают.');
  }
  checkPasswordPolicy(password, { email: newEmail, fullName: player.full_name });

  const subjectRef = `${player.full_name} <${newEmail}>`;

  db.transaction(() => {
    // 1. Представительские согласия за ребёнка — отзыв НОВЫМИ строками, каждая
    //    несёт ту редакцию, которую отзываемое согласие покрывало.
    for (const kind of ['processing', 'distribution']) {
      revokeCovered(db, { playerId: player.id, kind, source: 'web', ip });
    }
    // 2. Гейт снимается: связь с представителем гасится, и если этот ребёнок был
    //    у него последним — снимается и сам представитель, с этого дня идёт
    //    срок хранения его данных.
    revokeWard(db, player.id, { source: 'web', ip });

    // 3. Собственное согласие — текущей редакции.
    recordConsent(db, {
      playerId: player.id, subjectRef, kind: 'processing', event: 'granted', source: 'web', ip,
    });
    if (distribution) {
      recordConsent(db, {
        playerId: player.id, subjectRef, kind: 'distribution', event: 'granted', source: 'web', ip,
      });
    }
    syncPlayerPublicFlag(db, player.id);

    // 4. Аккаунт «взрослеет»: свой логин, снятая заморозка, погашенный токен
    //    перехода. Владелец кабинета не менялся — менялось основание.
    db.prepare(
      `UPDATE player_accounts
          SET email = ?, consent_basis = 'self', frozen_at = NULL,
              transition_started_at = NULL, transition_reminded_at = NULL, transition_token = NULL
        WHERE id = ?`,
    ).run(newEmail, account.id);
    setPassword(db, account.id, password);
  })();

  // 5. Все прежние сессии этого кабинета — вон: доступ, выданный представителю,
  //    не должен пережить смену основания.
  revokePlayerSessions(db, player.id, null);
  return db.prepare('SELECT * FROM player_accounts WHERE id = ?').get(account.id);
}
