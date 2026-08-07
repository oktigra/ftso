// Один коннект к SQLite на процесс. ОДИН процесс Node на сервере:
// better-sqlite3 синхронный, при многопроцессной записи SQLite даёт
// "database is locked" — поэтому НЕ PM2 cluster, НЕ несколько воркеров.
import Database from 'better-sqlite3';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function dbPath() {
  return resolve(process.env.DB_FILE || resolve(HERE, 'ftso.sqlite'));
}

let handle = null;

export function getDb() {
  if (handle) return handle;
  const file = dbPath();
  mkdirSync(dirname(file), { recursive: true });
  handle = new Database(file, {
    // таймаут на повреждённую БД / полный диск — не висим вечно
    timeout: Number(process.env.DB_TIMEOUT_MS || 5000),
  });
  handle.pragma('foreign_keys = ON');
  handle.pragma('journal_mode = WAL');
  return handle;
}

export function closeDb() {
  if (handle) {
    handle.close();
    handle = null;
  }
}
