// АККАУНТЫ ИГРОКОВ для личного кабинета: политика паролей, вход, установка и
// сброс пароля по почте.
//
// Хэширование берётся готовое (lib/password.mjs, scrypt) — второй способ
// хранения паролей в проекте не появляется.
import { randomBytes, createHash } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.mjs';
import { ValidationError } from './validate.mjs';

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

export function accountByEmail(db, email) {
  return db.prepare('SELECT * FROM player_accounts WHERE email = ?').get(String(email || '').toLowerCase());
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

/** Создание аккаунта при одобрении заявки. Пароль игрок задаёт сам по ссылке. */
export function createAccount(db, { playerId, email }) {
  const existing = accountByPlayer(db, playerId);
  if (existing) return existing;
  const info = db
    .prepare('INSERT INTO player_accounts (player_id, email) VALUES (?, ?)')
    .run(playerId, String(email).toLowerCase());
  return db.prepare('SELECT * FROM player_accounts WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function checkLogin(db, email, password) {
  const account = accountByEmail(db, email);
  if (!account || !account.password_hash) return null;
  return verifyPassword(password, account.password_hash) ? account : null;
}

/** Профиль для кабинета: сам игрок + его аккаунт. */
export function cabinetProfile(db, playerId) {
  return db
    .prepare(
      `SELECT p.id, p.full_name, p.city, p.sex, p.age_group, p.is_public, p.anonymized_at,
              p.photo_upload_id, a.email
         FROM players p LEFT JOIN player_accounts a ON a.player_id = p.id
        WHERE p.id = ?`,
    )
    .get(playerId);
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
