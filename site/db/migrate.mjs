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

/**
 * ЖУРНАЛ СОГЛАСИЙ обзавёлся третьим видом записи ('representative_processing' —
 * согласие законного представителя на обработку ЕГО СОБСТВЕННЫХ данных) и
 * привязкой к представителю. Вид перечислен в CHECK, а CHECK в SQLite не
 * правится через ALTER — таблицу приходится пересобирать.
 *
 * Идёт ПОСЛЕ schema.sql: новая таблица ссылается внешним ключом на guardians,
 * и без неё SQLite не даст даже перелить строки. Но ДО триггеров неизменяемости:
 * их тело читает consents.guardian_id, которой на старой базе ещё нет.
 * Пересборка идёт ОДНОЙ транзакцией: оборванная миграция не должна оставить
 * базу без журнала согласий.
 */
function upgradeConsents(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'consents'")
    .get();
  // Таблицы нет вовсе (чистая база) либо она уже нового образца — работы нет.
  if (!table) return false;
  if (table.sql.includes('representative_processing')) return false;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE consents_upgraded (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id     INTEGER REFERENCES players(id) ON DELETE CASCADE,
        registration_id INTEGER REFERENCES registrations(id) ON DELETE CASCADE,
        guardian_id   INTEGER REFERENCES guardians(id) ON DELETE CASCADE,
        subject_ref   TEXT,
        kind          TEXT NOT NULL CHECK (kind  IN ('processing','distribution','representative_processing')),
        event         TEXT NOT NULL CHECK (event IN ('granted','revoked')),
        legal_version TEXT NOT NULL,
        source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','offline')),
        basis         TEXT,
        document_date TEXT,
        ip            TEXT,
        at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO consents_upgraded
             (id, player_id, registration_id, subject_ref, kind, event, legal_version, source, basis, document_date, ip, at)
      SELECT  id, player_id, registration_id, subject_ref, kind, event, legal_version, source, basis, document_date, ip, at
        FROM consents;
      DROP TABLE consents;
      ALTER TABLE consents_upgraded RENAME TO consents;
    `);
  })();
  return true;
}

/**
 * РЕЗУЛЬТАТЫ ОБЗАВЕЛИСЬ РАЗРЯДОМ (одиночный/парный). Уникальность «турнир +
 * игрок» стала «турнир + игрок + разряд»: в одном турнире игрок занимает место
 * и в одиночке, и в паре. UNIQUE в SQLite через ALTER не правится — пересборка.
 */
function upgradeResults(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'results'")
    .get();
  if (!table) return false;
  if (table.sql.includes('discipline')) return false;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE results_upgraded (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        player_id     INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
        place         INTEGER NOT NULL CHECK (place >= 1 AND place = CAST(place AS INTEGER)),
        discipline    TEXT NOT NULL DEFAULT 'single' CHECK (discipline IN ('single','double')),
        UNIQUE (tournament_id, player_id, discipline)
      );
      INSERT INTO results_upgraded (id, tournament_id, player_id, place, discipline)
      SELECT id, tournament_id, player_id, place, 'single' FROM results;
      DROP TABLE results;
      ALTER TABLE results_upgraded RENAME TO results;
    `);
  })();
  return true;
}

/**
 * МАТЧИ ОБЗАВЕЛИСЬ СЧЁТОМ, ДАТОЙ, РАЗРЯДОМ И ПАРТНЁРАМИ ПО ПАРЕ. Уникальность
 * «турнир + победитель + проигравший» стала «… + разряд»: те же двое могут в
 * одном турнире встретиться и в одиночке, и в паре. Пересборка одной транзакцией.
 */
function upgradeMatches(db) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'matches'")
    .get();
  if (!table) return false;
  if (table.sql.includes('winner_partner_id')) return false;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE matches_upgraded (
        id               INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
        tournament_id    INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        winner_player_id INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
        loser_player_id  INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
        score            TEXT CHECK (score IS NULL OR length(score) <= 60),
        played_on        TEXT CHECK (played_on IS NULL OR (played_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                                           AND played_on IS strftime('%Y-%m-%d', played_on))),
        kind             TEXT NOT NULL DEFAULT 'single' CHECK (kind IN ('single','double')),
        winner_partner_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        loser_partner_id  INTEGER REFERENCES players(id) ON DELETE CASCADE,
        CHECK (winner_player_id <> loser_player_id),
        UNIQUE (tournament_id, winner_player_id, loser_player_id, kind)
      );
      INSERT INTO matches_upgraded (id, tournament_id, winner_player_id, loser_player_id)
      SELECT id, tournament_id, winner_player_id, loser_player_id FROM matches;
      DROP TABLE matches;
      ALTER TABLE matches_upgraded RENAME TO matches;
    `);
  })();
  return true;
}

/**
 * ПОЧТА АККАУНТА СТАЛА НЕОБЯЗАТЕЛЬНОЙ. Пока за ребёнка отвечает законный
 * представитель, своего входа у ребёнка нет вовсе: логин и пароль — у
 * представителя (таблица guardians), а player_accounts.email пуст. NOT NULL в
 * SQLite снимается только пересборкой таблицы.
 *
 * UNIQUE сохраняется: NULL уникальности не нарушает, поэтому двое детей одного
 * представителя уживаются, а взрослые по-прежнему не могут занять чужой адрес.
 */
function upgradePlayerAccounts(db) {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='player_accounts'").get();
  if (!has) return false;
  const emailCol = db.prepare('PRAGMA table_info(player_accounts)').all().find((c) => c.name === 'email');
  if (!emailCol || emailCol.notnull === 0) return false;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE player_accounts_upgraded (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id           INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
        email               TEXT UNIQUE,
        password_hash       TEXT CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%'),
        reset_token         TEXT,
        reset_expires_at    TEXT,
        password_changed_at TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO player_accounts_upgraded
             (id, player_id, email, password_hash, reset_token, reset_expires_at, password_changed_at, created_at)
      SELECT  id, player_id, email, password_hash, reset_token, reset_expires_at, password_changed_at, created_at
        FROM player_accounts;
      DROP TABLE player_accounts;
      ALTER TABLE player_accounts_upgraded RENAME TO player_accounts;
    `);
  })();
  return true;
}

export function migrate() {
  const db = getDb();
  // ПОРЯДОК ВАЖЕН И НЕ СЛУЧАЕН:
  //  1) schema.sql — таблицы и индексы (в том числе guardians, на которых
  //     держится внешний ключ пересобираемого журнала согласий);
  //  2) пересборка таблиц, которым не хватает CHECK/NOT NULL — ALTER их не правит;
  //  3) доливка недостающих колонок;
  //  4) after-upgrade.sql — триггеры неизменяемости журнала и индекс по
  //     представителю: они ссылаются на consents.guardian_id, поэтому раньше
  //     шага 2 просто не создадутся («no such column»).
  db.exec(readFileSync(resolve(HERE, 'schema.sql'), 'utf8'));
  const rebuilt = upgradeConsents(db);
  const accountsRebuilt = upgradePlayerAccounts(db);
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

  // --- слой несовершеннолетних и законного представителя -------------------
  //
  // Всё доливается ДОПИСЫВАЮЩЕ и с пустым значением по умолчанию. Аккаунты,
  // заведённые ДО этой миграции, получают consent_basis = NULL и остаются
  // взрослыми ('self'): флоу представителя тогда не существовало, и затягивать
  // их в минорный жизненный цикл было бы выдумыванием фактов о людях.
  addColumnIfMissing(db, 'players', 'birth_date', 'TEXT');
  addColumnIfMissing(db, 'registrations', 'birth_date', 'TEXT');
  addColumnIfMissing(db, 'registrations', 'guardian_full_name', 'TEXT');
  addColumnIfMissing(db, 'registrations', 'guardian_relation', 'TEXT');
  addColumnIfMissing(db, 'registrations', 'guardian_email', 'TEXT');
  addColumnIfMissing(
    db,
    'player_accounts',
    'consent_basis',
    "TEXT CHECK (consent_basis IS NULL OR consent_basis IN ('representative','awaiting_self','self'))",
  );
  addColumnIfMissing(db, 'player_accounts', 'transition_started_at', 'TEXT');
  addColumnIfMissing(db, 'player_accounts', 'transition_reminded_at', 'TEXT');
  addColumnIfMissing(db, 'player_accounts', 'transition_token', 'TEXT');
  addColumnIfMissing(db, 'player_accounts', 'frozen_at', 'TEXT');

  // --- публичный профиль, матчи со счётом, парный разряд (ТЗ ред. 6) ---------
  addColumnIfMissing(db, 'players', 'rni', 'TEXT');
  // ТЗ п. 4.3 — фильтры календаря турниров (05.09.2026).
  addColumnIfMissing(db, 'tournaments', 'city', 'TEXT');
  addColumnIfMissing(db, 'tournaments', 'start_date', 'TEXT');
  addColumnIfMissing(db, 'tournaments', 'kind', "TEXT NOT NULL DEFAULT 'other'");
  addColumnIfMissing(db, 'tournaments', 'age_group', 'TEXT');
  // ТЗ 4.5/4.6 — поля справочников и фильтры (05.09.2026).
  for (const c of ['city', 'specialization', 'qualification', 'groups']) addColumnIfMissing(db, 'coaches', c, 'TEXT');
  for (const c of ['city', 'courts_count', 'season', 'club', 'contact']) addColumnIfMissing(db, 'courts', c, 'TEXT');
  for (const c of ['city', 'map_url']) addColumnIfMissing(db, 'clubs', c, 'TEXT');
  // ТЗ 4.5/4.6 «фото» у тренеров, кортов, клубов.
  for (const t of ['coaches', 'courts', 'clubs']) addColumnIfMissing(db, t, 'photo_upload_id', 'INTEGER REFERENCES uploads(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'gallery_items', 'tournament_id', 'INTEGER REFERENCES tournaments(id) ON DELETE SET NULL');
  const resultsRebuilt = upgradeResults(db);
  const matchesRebuilt = upgradeMatches(db);
  db.exec(readFileSync(resolve(HERE, 'after-upgrade.sql'), 'utf8'));
  if (resultsRebuilt) console.log('[migrate] результаты пересобраны: добавлен разряд (одиночный/парный)');
  if (matchesRebuilt) console.log('[migrate] матчи пересобраны: счёт, дата, разряд и партнёры по паре');
  if (rebuilt) console.log('[migrate] журнал согласий пересобран: добавлены вид «представитель» и привязка guardian_id');
  if (accountsRebuilt) console.log('[migrate] аккаунты игроков пересобраны: почта стала необязательной (вход детей — через представителя)');
  return db;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log(`[migrate] схема применена: ${dbPath()}`);
  closeDb();
}
