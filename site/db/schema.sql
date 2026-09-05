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
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- 1 — пароль временный (выдан скриптом deploy/set-secrets.sh): до смены
  -- пользователь видит только /admin/account. Сбрасывается сменой пароля.
  must_change_password INTEGER NOT NULL DEFAULT 0
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
  is_public INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  -- Фото профиля (личный кабинет). Файл живёт в uploads, вне webroot.
  photo_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  -- ДАТА РОЖДЕНИЯ — СТРОГО ВНУТРЕННЕЕ ПОЛЕ. Нужна ровно для одного: определить,
  -- несовершеннолетний ли субъект (за него согласие даёт законный представитель,
  -- ч. 1 ст. 9 152-ФЗ) и когда гейт представителя снимается. В публичный вывод
  -- (рейтинг, карточка турнира, снимок standings_json) и в сериализованные
  -- ответы кабинета НЕ попадает — см. проверку в acceptance.mjs.
  birth_date TEXT
    CHECK (birth_date IS NULL OR (birth_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                  AND birth_date IS strftime('%Y-%m-%d', birth_date))),
  -- ОБЕЗЛИЧЕНА ПО СТ. 21. Строка игрока остаётся, но личных данных в ней больше
  -- нет: ФИО затёрто, город и группа очищены, аккаунт и фото удалены.
  -- Строку нельзя было удалить целиком — на неё ссылаются матчи, а они влияют
  -- на рейтинг СОПЕРНИКОВ. Игрок остаётся анонимной вершиной графа матчей.
  anonymized_at TEXT,
  -- Номер РНИ (Российский теннисный тур). Публичный профиль ФТСО со временем
  -- свяжется с федеральным; в эту задачу связка не входит, поле — задел.
  rni       TEXT
);

CREATE TABLE IF NOT EXISTS tournaments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  -- формат + РЕАЛЬНОСТЬ даты: GLOB ловит форму, strftime ловит 2026-13-40 и 2026-02-30
  -- (strftime вернёт NULL или нормализует -> сравнение через IS даст 0 -> CHECK не пройдёт)
  end_date TEXT NOT NULL
    CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    CHECK (end_date IS strftime('%Y-%m-%d', end_date)),
  category TEXT NOT NULL CHECK (category IN ('A','B')),
  -- ТЗ п. 4.3 (05.09.2026): город, дата начала, тип и возраст — для фильтров календаря.
  -- kind: 'team' командная встреча, 'championship' первенство/чемпионат, 'other' иной турнир.
  city       TEXT,
  start_date TEXT,
  kind       TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('team','championship','other')),
  age_group  TEXT
);

-- discipline — разряд: 'single' одиночный, 'double' парный. Рейтинги считаются
-- РАЗДЕЛЬНО, как у РТТ; один игрок в одном турнире может иметь место в обоих.
CREATE TABLE IF NOT EXISTS results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id)     ON DELETE CASCADE,
  place         INTEGER NOT NULL CHECK (place >= 1 AND place = CAST(place AS INTEGER)),
  discipline    TEXT NOT NULL DEFAULT 'single' CHECK (discipline IN ('single','double')),
  UNIQUE (tournament_id, player_id, discipline)
);

-- Обратный матч (B победил A) — ДРУГАЯ строка, разрешён: сыграли дважды.
-- score — счёт по сетам как текст («6:4 3:6 10:8»), played_on — дата матча;
-- пустая дата на витрине заменяется датой окончания турнира. kind и партнёры —
-- парный разряд: у 'single' партнёры пусты, у 'double' заполнены оба.
CREATE TABLE IF NOT EXISTS matches (
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
  -- Одна и та же пара может сыграть в одном турнире и в одиночке, и в паре.
  UNIQUE (tournament_id, winner_player_id, loser_player_id, kind)
);

-- Снимки рейтинга. Копятся; retention — последние 24, чистятся при пересчёте.
CREATE TABLE IF NOT EXISTS rating_cache (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  status         TEXT NOT NULL,
  standings_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rating_cache_id ON rating_cache (id DESC);

-- ЗАЯВКИ НА РЕГИСТРАЦИЮ. Публичная форма кладёт сюда, в players игрок попадает
-- ТОЛЬКО после модерации: иначе любой прохожий печатает себя в публичный рейтинг.
--
-- МИНИМИЗАЦИЯ (ч. 5 ст. 5 152-ФЗ): собираем ФИО, город, пол, e-mail —
-- и всё. Возрастная группа необязательна, телефона и даты рождения нет вовсе.
-- E-mail обязателен: это единственный канал сообщить решение модератора.
--
-- status_token — секрет ссылки на страницу статуса. Заявитель не заводит пароль
-- (пароли будут в личном кабинете), а статус смотреть должен: длинный
-- случайный токен в адресе — доступ по факту владения ссылкой, не по перебору id.
CREATE TABLE IF NOT EXISTS registrations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  city          TEXT NOT NULL CHECK (length(trim(city))      BETWEEN 1 AND 80),
  sex           TEXT NOT NULL CHECK (sex IN ('M','F')),
  age_group     TEXT,
  email         TEXT NOT NULL CHECK (length(trim(email)) BETWEEN 5 AND 160),
  -- Дата рождения обязательна с введения слоя несовершеннолетних: без неё нельзя
  -- решить, кто даёт согласие — сам субъект или его законный представитель.
  -- У заявок, поданных ДО этого, поле пустое (см. db/migrate.mjs).
  birth_date    TEXT,
  -- ЗАКОННЫЙ ПРЕДСТАВИТЕЛЬ заявителя младше 18. Живёт на заявке до модерации:
  -- игрока ещё нет, вешать представителя не на что. При одобрении переезжает
  -- в guardians одной транзакцией с созданием аккаунта.
  guardian_full_name TEXT,
  guardian_relation  TEXT,
  guardian_email     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  status_token  TEXT NOT NULL UNIQUE,
  -- заполняется при одобрении: новый игрок либо привязка к существующему
  player_id     INTEGER REFERENCES players(id) ON DELETE CASCADE,
  decided_by    INTEGER REFERENCES users(id)   ON DELETE SET NULL,
  decided_at    TEXT,
  reject_reason TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations (status, id DESC);
-- РНИ (номер игрока в РТТ) — точный идентификатор человека: двух игроков с одним РНИ не бывает.
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_rni ON players (rni) WHERE rni IS NOT NULL;

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
  -- Согласие даётся В МОМЕНТ ПОДАЧИ заявки, когда игрока ещё нет. Пока заявка
  -- на модерации, запись висит на ней; при одобрении к ней доливается player_id.
  registration_id INTEGER REFERENCES registrations(id) ON DELETE CASCADE,
  -- ПРЕДСТАВИТЕЛЬ КАК САМОСТОЯТЕЛЬНЫЙ СУБЪЕКТ. Согласие представителя на
  -- обработку ЕГО СОБСТВЕННЫХ данных (ФИО, родство, e-mail) — это отдельное
  -- согласие отдельного субъекта, а не часть согласия за ребёнка. Поэтому у
  -- него свой kind ('representative_processing') и своя привязка: subject_ref
  -- указывает на представителя, guardian_id — на его запись.
  guardian_id   INTEGER REFERENCES guardians(id) ON DELETE CASCADE,
  subject_ref   TEXT,
  kind          TEXT NOT NULL CHECK (kind  IN ('processing','distribution','representative_processing')),
  event         TEXT NOT NULL CHECK (event IN ('granted','revoked')),
  -- РЕДАКЦИЯ принятого текста (server/lib/legal.mjs). Согласие без указания
  -- редакции юридически пусто: через год не доказать, что именно приняли.
  legal_version TEXT NOT NULL,
  -- 'web' — отметка в форме на сайте, 'offline' — бумажное согласие, внесённое
  -- секретарём. Для 'offline' ip осмысленно пуст.
  source        TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web','offline')),
  -- Для ОФЛАЙН-согласия, внесённого секретарём: чем именно подтверждено право
  -- публиковать ФИО и какой датой подписана бумага. Для заводимых вручную
  -- игроков «галочка в админке» основанием не является — им нужен документ.
  basis         TEXT,
  document_date TEXT,
  ip            TEXT,
  at            TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Поиск последнего события по паре «игрок + вид согласия».
CREATE INDEX IF NOT EXISTS idx_consents_player_kind ON consents (player_id, kind, id DESC);
-- Автоочистка ходит по дате.
CREATE INDEX IF NOT EXISTS idx_consents_at ON consents (at);

-- НЕИЗМЕНЯЕМОСТЬ ЖУРНАЛА НА УРОВНЕ СУБД.
--
-- Append-only журнал, который держится только на дисциплине кода, перестаёт
-- быть доказательством: одна забытая UPDATE — и запись согласия «всегда была
-- такой». Поэтому запрет стоит в самой БД, триггерами, и обойти его из
-- приложения нельзя.
--
-- Но удалять записи ИНОГДА ОБЯЗАНЫ: право на забвение (ст. 21) и срок хранения
-- журнала — это не «правка», а исполнение закона. Разрешённое удаление
-- открывает ВОРОТА consents_gate ровно на время своей транзакции
-- (см. withConsentErasure в server/lib/consent-journal.mjs). Любое удаление
-- мимо этой функции — включая каскад от players/registrations/guardians —
-- отвергается СУБД.
CREATE TABLE IF NOT EXISTS consents_gate (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  erasure_open INTEGER NOT NULL DEFAULT 0 CHECK (erasure_open IN (0,1))
);
INSERT OR IGNORE INTO consents_gate (id, erasure_open) VALUES (1, 0);
-- Сами триггеры — и индекс по guardian_id — живут в ОТДЕЛЬНОМ файле
-- db/after-upgrade.sql и накатываются ПОСЛЕ всех правок колонок: они ссылаются
-- на consents.guardian_id, а в базе, поднятой с прежней схемы, этой колонки на
-- момент применения schema.sql ещё нет (см. db/migrate.mjs).

-- ЗАКОННЫЕ ПРЕДСТАВИТЕЛИ несовершеннолетних участников.
--
-- Представитель — не владелец кабинета и не второй профиль ребёнка, а
-- ВХОДНАЯ СУЩНОСТЬ СО СВОИМ ЛОГИНОМ: кабинет принадлежит ребёнку, представитель
-- в него входит и действует от его имени, пока держится гейт. В 18 гейт
-- снимается, аккаунт «взрослеет», передачи владения не происходит — владелец
-- не менялся.
--
-- ОДНА ЗАПИСЬ НА РЕАЛЬНОГО ЧЕЛОВЕКА, а не на пару «родитель+ребёнок». У матери
-- двоих юниоров один логин и один пароль, дети — в списке подопечных. Иначе
-- почта представителя пришлось бы дублировать в двух кабинетах, а она уникальна:
-- второй ребёнок просто не завёлся бы.
CREATE TABLE IF NOT EXISTS guardians (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  -- Логин представителя. UNIQUE среди представителей: это его вход.
  email         TEXT NOT NULL UNIQUE CHECK (length(trim(email)) BETWEEN 5 AND 160),
  password_hash TEXT CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%'),
  reset_token         TEXT,
  reset_expires_at    TEXT,
  password_changed_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- Проставляется, когда у представителя не осталось действующих подопечных
  -- (все выросли или заменены). Запись НЕ удаляется сразу: она объясняет, на
  -- каком основании данные детей обрабатывались раньше. Отсюда идёт отсчёт
  -- срока хранения — GUARDIAN_RETENTION_DAYS.
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_guardians_reset ON guardians (reset_token);
CREATE INDEX IF NOT EXISTS idx_guardians_revoked ON guardians (revoked_at);

-- СВЯЗКА «представитель — подопечный». Отдельной таблицей, а не полем на
-- аккаунте, по двум причинам: у одного представителя несколько детей, а степень
-- родства принадлежит именно ПАРЕ (одному ребёнку он отец, другому — опекун).
--
-- Связь не удаляется при снятии, а гасится revoked_at: замена представителя
-- (развод, лишение прав, смерть) не должна стирать историю того, кто давал
-- согласие за ребёнка раньше.
CREATE TABLE IF NOT EXISTS guardian_wards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guardian_id INTEGER NOT NULL REFERENCES guardians(id) ON DELETE CASCADE,
  player_id   INTEGER NOT NULL REFERENCES players(id)   ON DELETE CASCADE,
  relation    TEXT NOT NULL CHECK (length(trim(relation)) BETWEEN 1 AND 60),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at  TEXT
);
-- НЕ БОЛЕЕ ОДНОГО ДЕЙСТВУЮЩЕГО представителя на ребёнка — на уровне СУБД, а не
-- проверкой в коде: два действующих представителя означают два конкурирующих
-- источника согласия за одного ребёнка.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guardian_wards_active ON guardian_wards (player_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_guardian_wards_guardian ON guardian_wards (guardian_id, revoked_at);

-- ЗАГРУЖЕННЫЕ ФАЙЛЫ — общая таблица на все аплоады (документы турниров,
-- галерея, /documents). Сам файл лежит ВНЕ webroot под случайным именем;
-- присланное имя хранится здесь и используется только при отдаче.
--
-- profile — назначение загрузки (см. UPLOAD_PROFILES): от него зависят
-- разрешённые типы и лимит размера. mime и kind проставляются ПО СОДЕРЖИМОМУ,
-- а не по тому, что сказал клиент.
CREATE TABLE IF NOT EXISTS uploads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  stored_name   TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  profile       TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  meta          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_uploads_profile ON uploads (profile, id DESC);

-- ЗАЯВКИ «ПРОВЕСТИ ТУРНИР». Как и регистрация игрока: публичная форма кладёт
-- сюда, в tournaments турнир попадает ТОЛЬКО после модерации.
-- Результаты для рейтинга вводятся структурно через готовый CRUD админки —
-- файлами рейтинг не кормится.
CREATE TABLE IF NOT EXISTS tournament_requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  city          TEXT NOT NULL CHECK (length(trim(city)) BETWEEN 1 AND 80),
  end_date      TEXT NOT NULL
    CHECK (end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
    CHECK (end_date IS strftime('%Y-%m-%d', end_date)),
  category      TEXT NOT NULL CHECK (category IN ('A','B')),
  organizer     TEXT NOT NULL CHECK (length(trim(organizer)) BETWEEN 1 AND 160),
  email         TEXT NOT NULL CHECK (length(trim(email)) BETWEEN 5 AND 160),
  phone         TEXT,
  comment       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  status_token  TEXT NOT NULL UNIQUE,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
  decided_by    INTEGER REFERENCES users(id)       ON DELETE SET NULL,
  decided_at    TEXT,
  reject_reason TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tournament_requests_status ON tournament_requests (status, id DESC);

-- Файлы, приложенные к заявке (положение, сетка). Отдельной таблицей, потому
-- что файлов несколько, а удаление заявки обязано унести их с собой.
CREATE TABLE IF NOT EXISTS tournament_request_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES tournament_requests(id) ON DELETE CASCADE,
  upload_id  INTEGER NOT NULL REFERENCES uploads(id)             ON DELETE CASCADE,
  UNIQUE (request_id, upload_id)
);

-- АККАУНТ ИГРОКА для личного кабинета. Отдельно от users: users — это
-- сотрудники Федерации с ролями, у игрока роли нет, у него есть свой профиль.
-- password_hash NULL — аккаунт создан при одобрении заявки, пароль игрок ещё
-- не задал: он приходит по ссылке из письма.
CREATE TABLE IF NOT EXISTS player_accounts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id           INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  -- ПОЧТА ПУСТА, ПОКА ДЕЙСТВУЕТ ГЕЙТ ПРЕДСТАВИТЕЛЯ. Свою почту ребёнок по
  -- закону заводит с 14 лет, а до 14 — только через представителя, поэтому
  -- требовать её нельзя: входит представитель, своим логином (таблица
  -- guardians). Пустое поле — не «недозаполненный аккаунт», а состояние: у
  -- ребёнка НЕТ отдельного входа, пока за него отвечает представитель.
  -- UNIQUE при этом не мешает: в SQLite NULL уникальности не нарушает, и у
  -- матери двоих юниоров оба кабинета спокойно существуют без почты.
  -- Свой адрес человек указывает при переходе в 18 — он и становится логином.
  email               TEXT UNIQUE,
  password_hash       TEXT CHECK (password_hash IS NULL OR password_hash LIKE 'scrypt$%'),
  -- Токен установки/сброса пароля: одноразовый, с истечением.
  reset_token         TEXT,
  reset_expires_at    TEXT,
  password_changed_at TEXT,
  -- ЧЕЙ СОГЛАСИЕМ ДЕРЖИТСЯ АККАУНТ:
  --   'representative' — за несовершеннолетнего согласие дал законный
  --                      представитель, он же контакт и логин кабинета;
  --   'awaiting_self'  — 18 наступило, представительское согласие больше не
  --                      основание, собственное ещё не дано (гейт перехода);
  --   'self'           — субъект отвечает за себя сам.
  -- NULL — аккаунт заведён ДО введения этого слоя: флоу представителя тогда не
  -- существовало, такой аккаунт ВЕЗДЕ трактуется как 'self' и в минорный
  -- жизненный цикл не попадает. Поэтому в запросах пишется ЯВНОЕ
  -- `= 'representative'` / `IN ('representative','awaiting_self')`, и НИКОГДА
  -- `<> 'self'`: NULL <> 'self' в SQL не истина, и такое условие тихо теряло бы
  -- строки — либо, наоборот, затягивало бы взрослых в чужой сценарий.
  consent_basis       TEXT CHECK (consent_basis IS NULL
                                  OR consent_basis IN ('representative','awaiting_self','self')),
  -- Отметки перехода в 18. Нужны, чтобы фоновая проверка была ИДЕМПОТЕНТНОЙ:
  -- письмо в день 0, напоминание на +14 и заморозка на +30 должны случиться
  -- по одному разу, а не на каждом проходе таймера.
  transition_started_at  TEXT,
  transition_reminded_at TEXT,
  -- ХЭШ ТОКЕНА экрана перехода. Своего входа у вчерашнего ребёнка нет (почта
  -- пуста, пароля не было), а представитель в 18 уже не вправе действовать за
  -- него — значит, попасть на экран перехода можно только по личной ссылке.
  -- Срока годности у неё намеренно НЕТ: протухшая ссылка означала бы человека,
  -- запертого снаружи собственных данных. Гасится завершением перехода.
  transition_token       TEXT,
  -- ЗАМОРОЗКА (+30 дней без завершения перехода): кабинет только на чтение,
  -- значимые действия недоступны. Данные при этом НЕ удаляются.
  frozen_at              TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_player_accounts_reset ON player_accounts (reset_token);

-- ИСХОДЯЩАЯ ПОЧТА. Письмо сперва ЛОЖИТСЯ В ОЧЕРЕДЬ и только потом отправляется:
-- иначе сбой SMTP означал бы «заявка принята, но человеку никто не сообщил», и
-- узнать об этом было бы неоткуда. Непосланное видно в админке — это и есть
-- fallback «не молча».
CREATE TABLE IF NOT EXISTS mail_outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_outbox_status ON mail_outbox (status, id);

-- НОВОСТИ. Черновик и публикация разведены: is_published решает, видна ли
-- запись публично. Удалять ради «спрятать» ничего не нужно.
CREATE TABLE IF NOT EXISTS news (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  summary        TEXT,
  body           TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 20000),
  cover_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  is_published   INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0,1)),
  published_at   TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  author         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news (is_published, published_at DESC);

-- ВЛОЖЕНИЯ К НОВОСТИ (ТЗ 4.2): документ/изображение (upload_id) либо ссылка (url).
CREATE TABLE IF NOT EXISTS news_attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  news_id    INTEGER NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  upload_id  INTEGER REFERENCES uploads(id) ON DELETE CASCADE,
  url        TEXT,
  title      TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((upload_id IS NOT NULL) <> (url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_news_attachments_news ON news_attachments (news_id, id);

-- ДОКУМЕНТЫ ТУРНИРА, привязанные к САМОМУ турниру (а не к заявке): заявка
-- может быть вычищена по сроку хранения, а положение турнира в календаре
-- остаётся. При согласовании заявки её файлы перевешиваются сюда.
CREATE TABLE IF NOT EXISTS tournament_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  upload_id     INTEGER NOT NULL REFERENCES uploads(id)     ON DELETE CASCADE,
  title         TEXT,
  UNIQUE (tournament_id, upload_id)
);

-- СПРАВОЧНИКИ. Отдельные таблицы, а не статика в шаблоне: их ведёт секретарь
-- через админку, как игроков.
--
-- ФИО тренера и судьи — ПЕРСОНАЛЬНЫЕ ДАННЫЕ, и их публикация на сайте это
-- распространение (ст. 10.1). Поэтому у обеих таблиц есть ОБЯЗАТЕЛЬНОЕ
-- основание публикации с датой документа — ровно как у игроков, заводимых
-- секретарём вручную: галочка в админке основанием не является.
CREATE TABLE IF NOT EXISTS coaches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  club          TEXT,
  contact       TEXT,
  note          TEXT,
  city           TEXT,
  specialization TEXT,
  qualification  TEXT,
  groups         TEXT,
  photo_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  basis         TEXT NOT NULL CHECK (length(trim(basis)) BETWEEN 1 AND 200),
  document_date TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS referees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT NOT NULL CHECK (length(trim(full_name)) BETWEEN 1 AND 120),
  category      TEXT,
  city          TEXT,
  note          TEXT,
  basis         TEXT NOT NULL CHECK (length(trim(basis)) BETWEEN 1 AND 200),
  document_date TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Корты и клубы — сведения об организациях и объектах, не о людях:
-- основание публикации им не требуется.
CREATE TABLE IF NOT EXISTS courts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  address    TEXT,
  surface    TEXT,
  map_url    TEXT,
  note       TEXT,
  city         TEXT,
  courts_count TEXT,
  season       TEXT,
  club         TEXT,
  contact      TEXT,
  photo_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clubs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  address    TEXT,
  contact    TEXT,
  site       TEXT,
  note       TEXT,
  city       TEXT,
  map_url    TEXT,
  photo_upload_id INTEGER REFERENCES uploads(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ДОКУМЕНТЫ ФЕДЕРАЦИИ (/documents): файл + заголовок + категория.
CREATE TABLE IF NOT EXISTS federation_documents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  category   TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 80),
  upload_id  INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_federation_documents_cat ON federation_documents (category, id DESC);

-- ОБРАЩЕНИЯ ЧЕРЕЗ ФОРМУ ОБРАТНОЙ СВЯЗИ (/contacts). Основание — согласие (редакция
-- Политики в legal_version). Обработанные чистятся через config.feedback.retentionDays.
CREATE TABLE IF NOT EXISTS feedback_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  email         TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 200),
  message       TEXT NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 2000),
  legal_version TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','done')),
  handled_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback_messages (status, id DESC);

-- ЗАКРЫТЫЕ ДОКУМЕНТЫ ФЕДЕРАЦИИ: справки 152-ФЗ, приказы, уведомления РКН, договоры.
-- Видны и скачиваются ТОЛЬКО super-admin (/admin/vault); в isPubliclyVisibleUpload
-- НЕ входят — публичный /files/:id их не отдаёт. Хранятся в uploads -> попадают в бэкап.
CREATE TABLE IF NOT EXISTS internal_documents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  category   TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 80),
  note       TEXT,
  upload_id  INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_internal_documents_cat ON internal_documents (category, id DESC);

-- ГАЛЕРЕЯ. Изображение проходит общий слой загрузки: ресайз и снятие EXIF
-- (в снимке с телефона лежат координаты) делает lib/uploads.mjs.
CREATE TABLE IF NOT EXISTS gallery_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  upload_id  INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  -- Соревнование, на котором сделан снимок (репортажная съёмка, ст. 152.1 ГК);
  -- турнир удалён -> фото остаётся без привязки.
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
