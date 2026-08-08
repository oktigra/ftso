// Миграция: ОТДЕЛЬНАЯ команда `npm run migrate` ДО старта сервера,
// не авто-в-старте (иначе гонка). Идемпотентна: CREATE TABLE IF NOT EXISTS.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, dbPath, closeDb } from './connect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * ALTER TABLE ADD COLUMN идемпотентным не бывает: второй запуск падает
 * «duplicate column». Поэтому колонки, добавленные к УЖЕ СУЩЕСТВУЮЩИМ таблицам,
 * доливаются здесь с проверкой по PRAGMA — в schema.sql они объявлены сразу,
 * чтобы чистая база создавалась одним CREATE.
 */
function addColumnIfMissing(db, table, column, definition) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (has) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

export function migrate() {
  const db = getDb();
  db.exec(readFileSync(resolve(HERE, 'schema.sql'), 'utf8'));
  // Флаг публикуемости для баз, созданных до журнала согласий. Дефолт 0:
  // существующие игроки становятся НЕпубличными, пока согласие на
  // распространение не подтверждено — умолчание в пользу субъекта, а не витрины.
  addColumnIfMissing(db, 'players', 'is_public', 'INTEGER NOT NULL DEFAULT 0');
  // Привязка согласия к заявке: согласие даётся, когда игрока ещё нет.
  addColumnIfMissing(db, 'consents', 'registration_id', 'INTEGER REFERENCES registrations(id)');
  // Правовое основание и дата бумажного согласия — для внесённых секретарём.
  addColumnIfMissing(db, 'consents', 'basis', 'TEXT');
  addColumnIfMissing(db, 'consents', 'document_date', 'TEXT');
  // Личный кабинет: фото профиля и отметка обезличивания по ст. 21.
  addColumnIfMissing(db, 'players', 'photo_upload_id', 'INTEGER REFERENCES uploads(id)');
  addColumnIfMissing(db, 'players', 'anonymized_at', 'TEXT');
  return db;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log(`[migrate] схема применена: ${dbPath()}`);
  closeDb();
}
