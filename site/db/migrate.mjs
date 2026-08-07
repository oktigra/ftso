// Миграция: ОТДЕЛЬНАЯ команда `npm run migrate` ДО старта сервера,
// не авто-в-старте (иначе гонка). Идемпотентна: CREATE TABLE IF NOT EXISTS.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, dbPath, closeDb } from './connect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function migrate() {
  const db = getDb();
  db.exec(readFileSync(resolve(HERE, 'schema.sql'), 'utf8'));
  return db;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log(`[migrate] схема применена: ${dbPath()}`);
  closeDb();
}
