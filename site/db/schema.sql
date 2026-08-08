-- Схема каркаса сайта ФТСО. Идемпотентна: CREATE TABLE IF NOT EXISTS.
-- Запускается ОТДЕЛЬНОЙ командой `npm run migrate` ДО старта сервера.
PRAGMA foreign_keys = ON;

-- Пользователи админки. Публичной регистрации нет: super-admin заводит остальных.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  -- самодостаточная строка scrypt$N$r$p$<соль_b64>$<хэш_b64>
  password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  role          TEXT NOT NULL CHECK (role IN ('super-admin','content-manager','news-editor','tournament-admin')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Игрок — сущность БД: имя одно на игрока, движок не ругается на разные имена.
CREATE TABLE IF NOT EXISTS players (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  city      TEXT NOT NULL CHECK (length(trim(city)) BETWEEN 1 AND 80),
  sex       TEXT NOT NULL CHECK (sex IN ('M','F')),
  -- контролируемый список, набор задаёт Федерация -> жёсткий CHECK не ставим,
  -- проверяется валидацией в server/lib/validate.mjs
  age_group TEXT,
  -- ПУБЛИКУЕМОСТЬ. Дефолт 0 = НЕ публиковать: публикация ФИО в открытом рейтинге —
  -- это распространение (ст. 10.1 152-ФЗ), для него нужно ОТДЕЛЬНОЕ согласие.
  -- Флаг НЕ выставляется руками: он производный от журнала согласий, его
  -- пересчитывает syncPlayerPublicFlag() по последнему событию kind='distribution'.
  -- Отозвал согласие -> флаг снят -> игрок уходит под «Скрыто по заявлению»,
  -- СОХРАНЯЯ место и очки (движок считает по реальным данным).
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1))
);

CREATE TABLE IF NOT EXISTS tournaments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  -- формат + РЕАЛЬНОСТЬ даты: GLOB ловит форму, strftime ловит 2026-13-40 и 2026-02-30
  -- (strftime вернёт NULL или нормализует -> сравнение через IS даст 0 -> CHECK не пройдёт)
  end_date TEXT NOT NULL
    CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    CHECK (end_date IS strftime('%Y-%m-%d', end_date)),
  category TEXT NOT NULL CHECK (category IN ('A','B'))
);

CREATE TABLE IF NOT EXISTS results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
  place         INTEGER NOT NULL CHECK (place >= 1 AND place = CAST(place AS INTEGER)),
  UNIQUE (tournament_id, player_id)
);

-- Обратный матч (B победил A) — ДРУГАЯ строка, разрешён: сыграли дважды.
CREATE TABLE IF NOT EXISTS matches (
  id               INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  tournament_id    INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  winner_player_id INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
  loser_player_id  INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
  CHECK (winner_player_id <> loser_player_id),
  UNIQUE (tournament_id, winner_player_id, loser_player_id)
);

-- Снимки рейтинга. Копятся; retention — последние 24, чистятся при пересчёте.
CREATE TABLE IF NOT EXISTS rating_cache (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL,
  standings_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rating_cache_id ON rating_cache (id DESC);

-- ЖУРНАЛ СОГЛАСИЙ (152-ФЗ). Доказательство того, ЧТО и КОГДА принял субъект.
-- Согласий ДВА и они раздельные (ч. 6 ст. 10.1): 'processing' — обработка (ст. 9),
-- 'distribution' — распространение, то есть публикация в открытом доступе.
-- Пишется СОБЫТИЯМИ: 'granted' и 'revoked'. Отзыв — не удаление строки, а новая
-- запись с датой, иначе нечем доказать, что согласие когда-то действовало.
--
-- Сама запись журнала — тоже ПДн, поэтому у неё есть retention: отозванные
-- согласия чистятся через CONSENT_RETENTION_DAYS (см. lib/consent-journal.mjs).
--
-- player_id NULL — заявка подана, но игрок ещё не заведён (модерация впереди);
-- subject_ref хранит, кем субъект представился, иначе запись недоказуема.
-- ON DELETE CASCADE — право на забвение (ст. 21): снесли игрока, ушли и согласия.
CREATE TABLE IF NOT EXISTS consents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id     INTEGER REFERENCES players(id) ON DELETE CASCADE,
  subject_ref   TEXT,
  kind          TEXT NOT NULL CHECK (kind  IN ('processing','distribution')),
  event         TEXT NOT NULL CHECK (event IN ('granted','revoked')),
  -- РЕДАКЦИЯ принятого текста (server/lib/legal.mjs). Согласие без указания
  -- редакции юридически пусто: через год не доказать, что именно приняли.
  legal_version TEXT NOT NULL,
  -- 'web' — отметка в форме на сайте, 'offline' — бумажное согласие, внесённое
  -- секретарём. Для 'offline' ip осмысленно пуст.
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','offline')),
  ip            TEXT,
  at            TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Поиск последнего события по паре «игрок + вид согласия».
CREATE INDEX IF NOT EXISTS idx_consents_player_kind ON consents (player_id, kind, id DESC);
-- Автоочистка ходит по дате.
CREATE INDEX IF NOT EXISTS idx_consents_at ON consents (at);

-- Журнал действий: кто, что, когда. action = JSON {type, object_id, diff}.
CREATE TABLE IF NOT EXISTS action_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action  TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_action_log_user ON action_log (user_id);
CREATE INDEX IF NOT EXISTS idx_action_log_at   ON action_log (at);

-- Лимит попыток входа — в БД, а не в памяти: блокировка переживает рестарт.
-- key двух видов: "acct:<логин>|<ip>" (5 / 15 мин) и "ip:<ip>" (20 / 15 мин).
CREATE TABLE IF NOT EXISTS login_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key          TEXT NOT NULL UNIQUE,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Лок пересчёта рейтинга: одна строка (id = 1).
CREATE TABLE IF NOT EXISTS compute_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  is_computing INTEGER NOT NULL DEFAULT 0 CHECK (is_computing IN (0,1)),
  started_at   TEXT
);
INSERT OR IGNORE INTO compute_lock (id, is_computing, started_at) VALUES (1, 0, NULL);

-- Стор сессий express-session: сессия переживает рестарт.
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Общий лимит POST-действий админки (не только вход).
CREATE TABLE IF NOT EXISTS write_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT NOT NULL UNIQUE,
  count      INTEGER NOT NULL DEFAULT 0,
  window_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
