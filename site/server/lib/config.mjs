// Конфиг из .env. Обязательной переменной нет -> сервер ПАДАЕТ с внятным
// сообщением, а не криптической ошибкой в рантайме.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Крошечный парсер .env — без зависимости dotenv. Уже заданное окружение сильнее файла. */
export function loadEnvFile(file = resolve(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export class ConfigError extends Error {}

function required(name, hint) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new ConfigError(
      `${name} не задан. Заполни .env (образец — .env.example). ${hint || ''}`.trim(),
    );
  }
  return v;
}

export function loadConfig({ requireSecrets = true } = {}) {
  loadEnvFile();
  const isProd = process.env.NODE_ENV === 'production';

  // МАССИВ секретов: первый подписывает, остальные принимают старые cookie ->
  // смену секрета переживают уже выданные сессии (ротация без разлогина всех).
  let sessionSecrets = [];
  if (requireSecrets) {
    const raw = required('SESSION_SECRET', 'Через запятую можно перечислить старые секреты для ротации.');
    sessionSecrets = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (sessionSecrets.length === 0) throw new ConfigError('SESSION_SECRET пуст после разбора.');
    if (requireSecrets) required('SUPER_ADMIN_PASSWORD', 'Пароль супер-админа берётся ОТСЮДА, не из кода.');
  }

  return {
    isProd,
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST || '127.0.0.1',
    sessionSecrets,
    superAdmin: {
      username: process.env.SUPER_ADMIN_USERNAME || 'admin',
      password: process.env.SUPER_ADMIN_PASSWORD || '',
    },
    // За nginx/Caddy обязательно, иначе req.ip = 127.0.0.1 и блокировка по
    // «логин+IP» схлопывается, а Secure-cookie не распознаёт HTTPS.
    trustProxy: Number(process.env.TRUST_PROXY || 0),
    login: {
      maxAccountFails: Number(process.env.LOGIN_MAX_ACCOUNT_FAILS || 5),
      maxIpFails: Number(process.env.LOGIN_MAX_IP_FAILS || 20),
      lockMinutes: Number(process.env.LOGIN_LOCK_MINUTES || 15),
    },
    write: {
      maxPerWindow: Number(process.env.WRITE_MAX_PER_WINDOW || 120),
      windowMinutes: Number(process.env.WRITE_WINDOW_MINUTES || 15),
    },
    rating: {
      // Протухший лок: пересчёт упал на середине -> через N минут лок недействителен,
      // иначе кнопка «Пересчитать» залипнет навсегда.
      staleLockMinutes: Number(process.env.RATING_STALE_LOCK_MINUTES || 5),
      // Вторая защита от двойного нажатия «Пересчитать»: не чаще раза в N секунд.
      minIntervalSeconds: Number(process.env.RATING_MIN_INTERVAL_SECONDS || 10),
      keepSnapshots: Number(process.env.RATING_KEEP_SNAPSHOTS || 24),
      maxParticipants: Number(process.env.TOURNAMENT_MAX_PARTICIPANTS || 256),
    },
    bodyLimit: process.env.BODY_LIMIT || '100kb',
  };
}
