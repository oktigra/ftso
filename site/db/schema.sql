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
  age_group TEXT
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
