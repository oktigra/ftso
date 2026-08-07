// Точка входа. Миграция запускается ОТДЕЛЬНОЙ командой (`npm run migrate`) —
// здесь только проверяем, что схема применена, и стартуем.
import { loadConfig, ConfigError } from './lib/config.mjs';
import { createApp } from './app.mjs';
import { getDb, dbPath } from '../db/connect.mjs';

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
