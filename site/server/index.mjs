// Точка входа. Миграция запускается ОТДЕЛЬНОЙ командой (`npm run migrate`) —
// здесь только проверяем, что схема применена, и стартуем.
import { loadConfig, ConfigError } from './lib/config.mjs';
import { createApp } from './app.mjs';
import { getDb, dbPath } from '../db/connect.mjs';
import { scheduleDailyPurge } from './lib/retention.mjs';
import { purgeExpired } from './lib/consent-journal.mjs';
import { purgeRegistrations } from './lib/registrations.mjs';
import { purgeRequests } from './lib/tournament-requests.mjs';
import { purgeGuardians } from './lib/guardians.mjs';
import { purgeFeedback } from './lib/feedback.mjs';
import { runAdulthoodCheck } from './lib/adulthood.mjs';
import { setTransport, configureMailer, scheduleMailFlush } from './lib/mailer.mjs';
import { createSmtpTransport, smtpConfigured } from './lib/smtp.mjs';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n[старт прерван] ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const db = getDb();
const schemaReady = db
  .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='users'")
  .get().n;
if (!schemaReady) {
  console.error(
    `\n[старт прерван] Схема не применена в ${dbPath()}.\n` +
      'Выполни сначала: npm run migrate (затем npm run seed).\n',
  );
  process.exit(1);
}

// ПОЧТА. Без реквизитов отправка просто выключена: это не ошибка старта, а
// состояние — заявки принимаются, письма копятся в очереди и видны в админке.
// В лог идут только хост и имя ящика; пароль приложения не печатается нигде.
configureMailer({ failAfter: config.smtp.failAfter });
if (smtpConfigured(config.smtp)) {
  setTransport(createSmtpTransport(config.smtp));
  console.log(`[почта] SMTP ${config.smtp.host}:${config.smtp.port}, ящик ${config.smtp.user}`);
} else {
  console.warn(
    '[почта] SMTP не настроен (пусты SMTP_USER/SMTP_PASS) — письма будут копиться ' +
      'в очереди, статус виден в /admin/registrations. Заявители НЕ уведомляются.',
  );
}
// РУБИЛЬНИК И ПОЧТА: при закрытом приёме (INTAKE_ENABLED=0) разбор очереди
// НЕ запускается. Письмо — это передача ПДн получателя вовне, то есть та же
// обработка; закрытые формы не спасут, если очередь продолжит отправлять
// накопленное. Письма не теряются — лежат в mail_outbox и уйдут после
// включения приёма (таймер поднимется на следующем старте).
if (config.intakeEnabled) {
  scheduleMailFlush(db, { intervalMs: config.smtp.retryMinutes * 60 * 1000 });
} else {
  console.warn('[почта] приём ПДн закрыт (INTAKE_ENABLED=0) — разбор очереди писем остановлен.');
}

// СРОКИ ХРАНЕНИЯ: при старте и дальше раз в сутки.
scheduleDailyPurge('журнал согласий', () => purgeExpired(db, config.consent.retentionDays));
scheduleDailyPurge('заявки на регистрацию', () => purgeRegistrations(db, config.register.retentionDays));
scheduleDailyPurge('обращения', () => purgeFeedback(db, config.feedback.retentionDays));
// Заявки на турниры чистятся ВМЕСТЕ С ФАЙЛАМИ: снести строку и оставить
// документы на диске значит хранить чужие данные без основания и без срока.
scheduleDailyPurge('заявки на турниры', () =>
  purgeRequests(db, config.tournamentRequest.retentionDays, config.upload.dir),
);
// Данные представителя живут ПОСЛЕ снятия: они подтверждают правомерность
// обработки данных ребёнка за прошлые годы. Чистятся вместе с записями его
// согласий по GUARDIAN_RETENTION_DAYS.
scheduleDailyPurge('данные законных представителей', () =>
  purgeGuardians(db, config.guardian.retentionDays),
);

// ПЕРЕХОД УЧАСТНИКОВ В 18 ЛЕТ. Тем же суточным планировщиком и намеренно НЕ в
// обработчике запроса: гейт представителя снимается фоном, а живые сессии при
// этом не трогаются — переход не должен случаться посреди чужого сеанса.
// Проверка ДОГОНЯЮЩАЯ: она ищет всех, кому уже исполнилось 18, а не только
// тех, у кого день рождения сегодня, поэтому простой сервера ничего не теряет.
scheduleDailyPurge('переход участников в 18 лет', () => {
  const report = runAdulthoodCheck(db, { baseUrl: config.siteUrl });
  if (report.unreachable) {
    console.warn(`[переход в 18] некому сообщить: ${report.unreachable} — секретарь уведомлён`);
  }
  return report.promoted + report.reminded + report.frozen;
});

const app = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log(`ФТСО: http://${config.host}:${config.port}  (NODE_ENV=${process.env.NODE_ENV || 'development'})`);
  if (!config.isProd) {
    console.log('Внимание: NODE_ENV != production -> cookie без Secure (иначе dev по HTTP не работает).');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => {
      app.locals.closeStore();
      process.exit(0);
    });
  });
}
