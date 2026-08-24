// ОДИН ЧЕЛОВЕК — ОДИН ВХОД.
//
// Задача, из которой вырос модуль: родитель, который сам играет. У него ДВЕ
// роли — участник рейтинга и законный представитель своего ребёнка — и один
// почтовый ящик. Держать под этим два логина с двумя паролями значит заставлять
// человека помнить, «каким из своих паролей» он сейчас входит, и объяснять ему
// разницу, которой в его голове нет.
//
// Поэтому адрес почты здесь — ИДЕНТИФИКАТОР ЧЕЛОВЕКА, а не строки в таблице.
// Вход один, пароль один, а после входа человек выбирает КАБИНЕТ: свой
// собственный либо кабинет ребёнка, за которого он отвечает.
//
// Роли по-прежнему живут в разных таблицах, и это правильно: у участника —
// профиль, история и согласия за себя, у представителя — полномочия и согласие
// на СВОИ данные. Модуль не сливает их в одну сущность, он лишь связывает по
// адресу и держит пароли синхронными.
//
// БЕЗОПАСНОСТЬ. Пара «участник + представитель» на одном адресе возникает
// ТОЛЬКО через модерацию (одобрение заявки секретарём): либо у представителя
// появляется свой кабинет участника, либо участник становится представителем
// ребёнка. Самообслуживанием — сменой почты в профиле или на экране перехода в
// 18 — занять чужую роль нельзя: такие адреса отклоняются (см. guardianOwns).
import { hashPassword, verifyPassword } from './password.mjs';

const norm = (email) => String(email || '').trim().toLowerCase();

/**
 * Все роли одного человека по адресу почты. account — кабинет участника,
 * guardian — доступ законного представителя; любая из ролей может отсутствовать.
 */
export function personByEmail(db, email) {
  const address = norm(email);
  if (!address) return { email: '', account: null, guardian: null };
  return {
    email: address,
    account: db.prepare('SELECT * FROM player_accounts WHERE email = ?').get(address) || null,
    guardian: db.prepare('SELECT * FROM guardians WHERE email = ?').get(address) || null,
  };
}

/** Занят ли адрес доступом ЗАКОННОГО ПРЕДСТАВИТЕЛЯ (кроме указанного). */
export function guardianOwns(db, email, { exceptGuardianId = null } = {}) {
  const g = db.prepare('SELECT id, revoked_at FROM guardians WHERE email = ?').get(norm(email));
  if (!g || g.id === exceptGuardianId) return null;
  return g;
}

/**
 * ЕДИНЫЙ ПАРОЛЬ. Хэш пишется во ВСЕ роли этого адреса разом: смена пароля —
 * это смена пароля человека, а не одной из его ролей. Рассинхрон означал бы,
 * что «пароль сменился», но старый где-то ещё пускает.
 *
 * Токены сброса гасятся тем же движением и у обеих ролей: ссылка одноразовая,
 * и «одноразовая наполовину» — это просто действующая ссылка.
 */
export function setPersonPassword(db, email, password) {
  const address = norm(email);
  const hash = hashPassword(password);
  return db.transaction(() => ({
    accounts: db
      .prepare(
        `UPDATE player_accounts
            SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL,
                password_changed_at = datetime('now')
          WHERE email = ?`,
      )
      .run(hash, address).changes,
    guardians: db
      .prepare(
        `UPDATE guardians
            SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL,
                password_changed_at = datetime('now')
          WHERE email = ?`,
      )
      .run(hash, address).changes,
  }))();
}

/**
 * ПОДХВАТ УЖЕ ЗАДАННОГО ПАРОЛЯ при появлении второй роли. Родитель, у которого
 * пароль есть, не должен задавать второй — и наоборот. Копируется готовый хэш:
 * пароля в открытом виде у нас нет и быть не должно.
 *
 * Если пароль есть у обеих ролей (адрес свели вместе, когда оба уже жили
 * самостоятельно), побеждает пароль СОБСТВЕННОГО кабинета участника: это
 * основная роль человека, и именно её пароль он вводил чаще.
 */
export function adoptPassword(db, email) {
  const { account, guardian } = personByEmail(db, email);
  if (!account || !guardian) return 'нечего связывать';
  if (account.password_hash) {
    if (account.password_hash === guardian.password_hash) return 'уже синхронны';
    db.prepare('UPDATE guardians SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?')
      .run(account.password_hash, guardian.id);
    return 'пароль участника распространён на доступ представителя';
  }
  if (guardian.password_hash) {
    db.prepare('UPDATE player_accounts SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL WHERE id = ?')
      .run(guardian.password_hash, account.id);
    return 'пароль представителя распространён на кабинет участника';
  }
  return 'пароля пока нет ни у одной роли';
}

/**
 * Проверка входа по адресу и паролю — сразу по всем ролям человека.
 *
 * Хэши синхронны (setPersonPassword, adoptPassword), но сверяем с каждым: если
 * синхронизация где-то не отработала, человек всё равно войдёт своим паролем, а
 * не упрётся в «неверный пароль» из-за нашей внутренней кухни. Снятый
 * представитель ролью не считается: подопечных у него нет.
 */
export function checkPersonLogin(db, email, password) {
  const person = personByEmail(db, email);
  const accountOk = person.account && person.account.password_hash
    && verifyPassword(password, person.account.password_hash);
  const guardianOk = person.guardian && person.guardian.password_hash && !person.guardian.revoked_at
    && verifyPassword(password, person.guardian.password_hash);
  if (!accountOk && !guardianOk) return null;
  return {
    email: person.email,
    account: accountOk ? person.account : null,
    guardian: guardianOk ? person.guardian : null,
  };
}

/** Есть ли у адреса вообще хоть какая-то роль — для защиты от перебора адресов. */
export function personExists(db, email) {
  const { account, guardian } = personByEmail(db, email);
  return Boolean(account || guardian);
}

/**
 * СПИСОК ДОСТУПНЫХ КАБИНЕТОВ. Свой — первым: это профиль самого человека, а
 * дети идут следом. Обезличенные по ст. 21 не показываются: их данных больше
 * нет, открывать нечего.
 */
export function cabinetsOf(db, { account = null, guardian = null } = {}) {
  const out = [];
  if (account) {
    const own = db
      .prepare("SELECT id, full_name, city FROM players WHERE id = ? AND anonymized_at IS NULL")
      .get(account.player_id);
    if (own) {
      out.push({
        playerId: own.id,
        fullName: own.full_name,
        city: own.city,
        role: 'self',
        relation: null,
        // Собственный кабинет в состоянии перехода — случай возможный: человек
        // вырос, но согласие от себя ещё не подтвердил.
        awaitingSelf: account.consent_basis === 'awaiting_self',
        frozen: Boolean(account.frozen_at),
      });
    }
  }
  if (guardian && !guardian.revoked_at) {
    const wards = db
      .prepare(
        `SELECT p.id, p.full_name, p.city, w.relation, a.consent_basis, a.frozen_at
           FROM guardian_wards w
           JOIN players p ON p.id = w.player_id
           LEFT JOIN player_accounts a ON a.player_id = p.id
          WHERE w.guardian_id = ? AND w.revoked_at IS NULL AND p.anonymized_at IS NULL
          ORDER BY p.full_name`,
      )
      .all(guardian.id);
    for (const w of wards) {
      out.push({
        playerId: w.id,
        fullName: w.full_name,
        city: w.city,
        role: 'guardian',
        relation: w.relation,
        awaitingSelf: w.consent_basis === 'awaiting_self',
        frozen: Boolean(w.frozen_at),
      });
    }
  }
  return out;
}
