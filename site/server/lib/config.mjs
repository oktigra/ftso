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
    smtp: {
      host: process.env.SMTP_HOST || 'smtp.yandex.ru',
      port: Number(process.env.SMTP_PORT || 465),
      // 465 -> TLS сразу; для 587 (STARTTLS) поставить SMTP_SECURE=0.
      secure: process.env.SMTP_SECURE !== '0',
      user: process.env.SMTP_USER || '',
      // ПАРОЛЬ ПРИЛОЖЕНИЯ, не пароль от почты. Живёт только в .env, в git его нет
      // и в логи он не попадает: наружу печатается лишь хост и имя ящика.
      pass: process.env.SMTP_PASS || '',
      from: process.env.MAIL_FROM || '',
      // Повтор застрявших писем. Не агрессивно: короткий сбой SMTP не должен
      // сжечь все попытки за пять минут и пометить письмо безнадёжным.
      retryMinutes: Number(process.env.MAIL_RETRY_MINUTES || 10),
      failAfter: Number(process.env.MAIL_FAIL_AFTER || 8),
    },
    register: {
      // Публичная форма без входа: 5 заявок с адреса в час. Живому человеку
      // хватает с запасом, скрипту — нет.
      maxPerWindow: Number(process.env.REGISTER_MAX_PER_WINDOW || 5),
      windowMinutes: Number(process.env.REGISTER_WINDOW_MINUTES || 60),
      // RETENTION заявок: отклонённые и брошенные на модерации чистятся через
      // год. Одобренные живут вместе с игроком — они объясняют основание.
      retentionDays: Number(process.env.REGISTRATION_RETENTION_DAYS || 365),
    },
    consent: {
      // RETENTION журнала согласий. Считается ОТ ОТЗЫВА: действующее согласие
      // не чистится никогда — оно и есть основание обработки. 1095 дней = 3 года,
      // общий срок исковой давности: столько ещё можно спорить о правомерности
      // обработки, и столько нужно доказательство. Действующие согласия и
      // непривязанные заявки живут по тому же сроку.
      retentionDays: Number(process.env.CONSENT_RETENTION_DAYS || 1095),
    },
    bodyLimit: process.env.BODY_LIMIT || '100kb',
  };
}
