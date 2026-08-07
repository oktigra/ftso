// Пароли: только scrypt с ЯВНЫМИ параметрами. Колонка password_hash —
// САМОДОСТАТОЧНАЯ строка scrypt$N$r$p$<соль_b64>$<хэш_b64>: алгоритм, параметры
// и соль внутри, отдельной колонки для соли не надо.
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, saltBytes: 16 };

// N=16384, r=8 требует ~16 МБ; дефолтный лимит node — 32 МБ, но берём запас.
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(plain, params = SCRYPT) {
  const { N, r, p, keylen, saltBytes } = params;
  const salt = randomBytes(saltBytes);
  const derived = scryptSync(plain, salt, keylen, { N, r, p, maxmem: MAXMEM });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Разбор самодостаточной строки. Возвращает null, если строка не наша. */
export function parseHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, N, r, p, saltB64, hashB64] = parts;
  const nums = [Number(N), Number(r), Number(p)];
  if (!nums.every((n) => Number.isInteger(n) && n >= 1)) return null;
  return {
    N: nums[0],
    r: nums[1],
    p: nums[2],
    salt: Buffer.from(saltB64, 'base64'),
    hash: Buffer.from(hashB64, 'base64'),
  };
}

/** Сверка через timingSafeEqual. Кривая строка в БД -> false, не падение. */
export function verifyPassword(plain, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, hash } = parsed;
  let derived;
  try {
    derived = scryptSync(plain, salt, hash.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (derived.length !== hash.length) return false;
  return timingSafeEqual(derived, hash);
}

// Несуществующий логин: всё равно считаем scrypt от dummy-значения, чтобы время
// ответа не отличалось от «логин есть, пароль неверный» (timing attack).
const DUMMY_HASH = hashPassword('dummy-password-for-constant-time-compare');

export function burnDummyHash(plain) {
  verifyPassword(plain, DUMMY_HASH);
}
