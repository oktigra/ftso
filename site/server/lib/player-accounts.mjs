// АККАУНТЫ ИГРОКОВ для личного кабинета: политика паролей, вход, установка и
// сброс пароля по почте.
//
// Хэширование берётся готовое (lib/password.mjs, scrypt) — второй способ
// хранения паролей в проекте не появляется.
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.mjs';
import { ValidationError } from './validate.mjs';
import { activeGuardianFor } from './guardians.mjs';
import { adoptPassword } from './identity.mjs';

export const PASSWORD_MIN = 10;
const PASSWORD_MAX = 200;

// Короткий список того, что подбирают первым делом. Полноценные словари здесь
// не нужны: длина плюс требование разнородности отсекает основную массу.
const OBVIOUS = ['password', 'пароль', 'qwerty', '123456', 'ftso', 'tennis', 'теннис', 'admin'];

/**
 * ПОЛИТИКА ПАРОЛЕЙ. Проверяется на СЕРВЕРЕ: подсказки в браузере — удобство,
 * а не защита. Требуем длину и разнородность, а не «спецсимвол обязательно»:
 * последнее гонит людей в «Password1!», который подбирается легче длинной фразы.
 */
export function checkPasswordPolicy(password, { email = '', fullName = '' } = {}) {
  const pw = String(password || '');
  const problems = [];
  if (pw.length < PASSWORD_MIN) problems.push(`Пароль: минимум ${PASSWORD_MIN} символов`);
  if (pw.length > PASSWORD_MAX) problems.push(`Пароль: максимум ${PASSWORD_MAX} символов`);
  if (!/[^\d\s]/.test(pw)) problems.push('Пароль: одних цифр недостаточно — добавьте буквы');
  if (!/\d/.test(pw) && !/[^\p{L}\d\s]/u.test(pw)) {
    problems.push('Пароль: добавьте цифру или знак — одних букв недостаточно');
  }
  if (/^(.)\1+$/.test(pw)) problems.push('Пароль: один символ повторяется — так нельзя');

  const low = pw.toLowerCase();
  for (const bad of OBVIOUS) {
    if (low.includes(bad)) {
      problems.push('Пароль: содержит слишком очевидное слово');
      break;
    }
  }
  // Пароль не должен совпадать с собственной почтой или именем: это первое,
  // что пробует подбирающий, зная адрес из заявки.
  const local = String(email).split('@')[0].toLowerCase();
  if (local && local.length >= 4 && low.includes(local)) problems.push('Пароль: не должен содержать ваш адрес почты');
  for (const part of String(fullName).toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && low.includes(part)) {
      problems.push('Пароль: не должен содержать ваше имя или фамилию');
      break;
    }
  }
  if (problems.length) throw new ValidationError(problems);
  return pw;
}

/**
 * Аккаунт по адресу. Пустой адрес НЕ ищем: у детей под гейтом почта пуста, и
 * запрос с пустой строкой не должен возвращать «первого попавшегося ребёнка».
 */
export function accountByEmail(db, email) {
  const address = String(email || '').toLowerCase();
  if (!address) return undefined;
  return db.prepare('SELECT * FROM player_accounts WHERE email = ?').get(address);
}

export function accountByPlayer(db, playerId) {
  return db.prepare('SELECT * FROM player_accounts WHERE player_id = ?').get(playerId);
}

/**
 * Токен установки/сброса пароля. В БД лежит ХЭШ токена, а не сам токен: дамп
 * базы не должен давать возможность зайти в чужой кабинет.
 */
export function issueResetToken(db, accountId, { hours = 24 } = {}) {
  const token = randomBytes(32).toString('base64url');
  const hashed = createHash('sha256').update(token).digest('hex');
  db.prepare(
    "UPDATE player_accounts SET reset_token = ?, reset_expires_at = datetime('now', ?) WHERE id = ?",
  ).run(hashed, `+${Number(hours)} hours`, accountId);
  return token;
}

/** Аккаунт по токену — только если токен не просрочен. */
export function accountByResetToken(db, token) {
  const hashed = createHash('sha256').update(String(token || '')).digest('hex');
  return db
    .prepare(
      "SELECT * FROM player_accounts WHERE reset_token = ? AND reset_expires_at > datetime('now')",
    )
    .get(hashed);
}

/**
 * Установка пароля. Токен гасится в той же транзакции — ссылка одноразовая,
 * иначе письмо из почтового ящика остаётся вечным ключом к кабинету.
 */
export function setPassword(db, accountId, password) {
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE player_accounts
          SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL,
              password_changed_at = datetime('now')
        WHERE id = ?`,
    ).run(hashPassword(password), accountId);
  });
  tx();
}

/**
 * Создание аккаунта при одобрении заявки. Пароль игрок задаёт сам по ссылке.
 *
 * consentBasis:
 *   'self'           — субъект отвечает за себя (совершеннолетний);
 *   'representative' — за несовершеннолетнего согласие дал законный
 *                      представитель; аккаунт принадлежит РЕБЁНКУ, а логином и
 *                      контактом служит почта ПРЕДСТАВИТЕЛЯ, пока держится гейт.
 */
export function createAccount(db, { playerId, email = null, consentBasis = 'self' }) {
  const existing = accountByPlayer(db, playerId);
  if (existing) return existing;
  // Почта ПУСТА, пока держится гейт: своего входа у ребёнка нет, входит
  // представитель своим логином. Пустое поле не нарушает UNIQUE, поэтому двое
  // детей одного представителя заводятся спокойно.
  const address = email ? String(email).toLowerCase() : null;
  if (address) {
    const taken = accountByEmail(db, address);
    if (taken) {
      const err = new Error(`Адрес ${address} уже служит логином кабинета игрока #${taken.player_id}.`);
      err.code = 'ACCOUNT_EMAIL_TAKEN';
      throw err;
    }
  }
  const info = db
    .prepare('INSERT INTO player_accounts (player_id, email, consent_basis) VALUES (?, ?, ?)')
    .run(playerId, address, consentBasis);
  // Тот же адрес уже служит входом законного представителя — значит, это ОДИН
  // человек (пару создаёт только модерация), и пароль у него уже есть.
  if (address) adoptPassword(db, address);
  return db.prepare('SELECT * FROM player_accounts WHERE id = ?').get(Number(info.lastInsertRowid));
}

/**
 * ОСНОВАНИЕ, на котором держится аккаунт. NULL == 'self': аккаунты, заведённые
 * ДО появления слоя представителей, взрослые по определению — флоу
 * представителя тогда не существовало, и задним числом объявлять их детскими
 * значило бы придумывать факты о людях.
 */
export const basisOf = (account) => (account && account.consent_basis) || 'self';
export const isRepresented = (account) => basisOf(account) === 'representative';
export const isAwaitingSelf = (account) => basisOf(account) === 'awaiting_self';
export const isFrozen = (account) => Boolean(account && account.frozen_at) && isAwaitingSelf(account);

export function checkLogin(db, email, password) {
  const account = accountByEmail(db, email);
  if (!account || !account.password_hash) return null;
  return verifyPassword(password, account.password_hash) ? account : null;
}

/**
 * Профиль для кабинета: сам игрок + его аккаунт.
 *
 * ДАТЫ РОЖДЕНИЯ ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ. Она внутреннее поле: нужна фоновой
 * проверке совершеннолетия и провижинингу, а этот объект уходит в шаблон
 * кабинета целиком. Достаточно вычисленного состояния гейта — оно и показывается.
 */
export function cabinetProfile(db, playerId) {
  const row = db
    .prepare(
      `SELECT p.id, p.full_name, p.city, p.sex, p.age_group, p.is_public, p.anonymized_at,
              p.photo_upload_id, a.email, a.consent_basis, a.frozen_at, a.transition_started_at
         FROM players p LEFT JOIN player_accounts a ON a.player_id = p.id
        WHERE p.id = ?`,
    )
    .get(playerId);
  if (!row) return row;
  const guardian = isRepresented(row) ? activeGuardianFor(db, playerId) : null;
  return {
    ...row,
    basis: basisOf(row),
    // В шаблон уходит только то, что кабинет показывает: кто представитель и кем
    // приходится. Пароль и токены представителя тут делать нечего.
    guardian: guardian
      ? { full_name: guardian.full_name, relation: guardian.relation, email: guardian.email }
      : null,
    frozen: isFrozen(row),
  };
}

/**
 * История игрока: турниры, места и матчи. Берётся ИЗ БД напрямую, а не из
 * снимка рейтинга: снимок обезличен для витрины, а себя игрок видит целиком.
 */
export function playerHistory(db, playerId) {
  const results = db
    .prepare(
      `SELECT t.name, t.end_date, t.category, r.place
         FROM results r JOIN tournaments t ON t.id = r.tournament_id
        WHERE r.player_id = ? ORDER BY t.end_date DESC`,
    )
    .all(playerId);
  const matches = db
    .prepare(
      `SELECT t.name AS tournament, t.end_date,
              CASE WHEN m.winner_player_id = ? THEN 'победа' ELSE 'поражение' END AS outcome,
              CASE WHEN m.winner_player_id = ? THEN lo.full_name ELSE wi.full_name END AS opponent,
              CASE WHEN m.winner_player_id = ? THEN lo.anonymized_at ELSE wi.anonymized_at END AS opponent_erased
         FROM matches m
         JOIN tournaments t ON t.id = m.tournament_id
         JOIN players wi ON wi.id = m.winner_player_id
         JOIN players lo ON lo.id = m.loser_player_id
        WHERE m.winner_player_id = ? OR m.loser_player_id = ?
        ORDER BY t.end_date DESC, m.id DESC`,
    )
    .all(playerId, playerId, playerId, playerId, playerId);
  return { results, matches };
}
