// Сид ВЫДУМАННЫМИ данными. Даёт ДВА снимка rating_cache, чтобы колонка
// «Изменение» была проверяемой: стрелки вверх, вниз, «— 0» и «нов.».
//
// Запуск: npm run migrate && npm run seed
import { getDb, closeDb, dbPath } from './connect.mjs';
import { migrate } from './migrate.mjs';
import { hashPassword } from '../server/lib/password.mjs';
import { loadConfig } from '../server/lib/config.mjs';
import { recompute } from '../server/lib/rating-service.mjs';

const config = loadConfig();
const db = getDb();
migrate();

/** Дата на N дней назад по UTC — чтобы турниры попадали в окно 364 дня. */
function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

// --- пользователи ---------------------------------------------------------
// Пароль супер-админа берётся ИЗ .env, не хардкодом и не из git.
const upsertUser = (username, password, role) => {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE id = ?').run(
      hashPassword(password),
      role,
      existing.id,
    );
    return existing.id;
  }
  return db
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, hashPassword(password), role).lastInsertRowid;
};

upsertUser(config.superAdmin.username, config.superAdmin.password, 'super-admin');
// Второй пользователь — для проверки гейтинга по ролям (в чужой раздел -> 403).
const tournamentAdminPassword =
  process.env.TOURNAMENT_ADMIN_PASSWORD || config.superAdmin.password;
upsertUser('turnir', tournamentAdminPassword, 'tournament-admin');

// --- данные рейтинга ------------------------------------------------------
db.exec('DELETE FROM rating_cache; DELETE FROM matches; DELETE FROM results; DELETE FROM tournaments; DELETE FROM players;');

const PLAYERS = [
  ['Артём Ковалёв', 'Смоленск', 'M', '19-34'],
  ['Дмитрий Волков', 'Вязьма', 'M', '19-34'],
  ['Сергей Новиков', 'Смоленск', 'M', '35-44'],
  ['Илья Морозов', 'Рославль', 'M', '19-34'],
  ['Павел Захаров', 'Сафоново', 'M', '45-54'],
  ['Анна Соколова', 'Смоленск', 'F', '19-34'],
  ['Мария Лебедева', 'Вязьма', 'F', 'до 19'],
  // Намеренно «злое» имя: проверка экранирования вывода (хранимый XSS).
  // В таблице рейтинга должно показаться ТЕКСТОМ, скрипт не выполняется.
  ['<script>alert(1)</script>', 'Ярцево', 'M', '19-34'],
];

const insPlayer = db.prepare('INSERT INTO players (full_name, city, sex, age_group) VALUES (?, ?, ?, ?)');
const P = PLAYERS.map((p) => Number(insPlayer.run(...p).lastInsertRowid));

const TOURNAMENTS = [
  ['Кубок Смоленска', daysAgo(300), 'A'],
  ['Открытое первенство Вязьмы', daysAgo(240), 'B'],
  ['Осенний турнир Рославля', daysAgo(180), 'B'],
  ['Гран-при «Днепр»', daysAgo(120), 'A'],
  ['Кубок Сафоново', daysAgo(60), 'B'],
];
const insTournament = db.prepare('INSERT INTO tournaments (name, end_date, category) VALUES (?, ?, ?)');
const T = TOURNAMENTS.map((t) => Number(insTournament.run(...t).lastInsertRowid));

const insResult = db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, ?)');
const insMatch = db.prepare(
  'INSERT INTO matches (tournament_id, winner_player_id, loser_player_id) VALUES (?, ?, ?)',
);
const addResults = (tIdx, rows) => rows.forEach(([pIdx, place]) => insResult.run(T[tIdx], P[pIdx], place));

// ЭТАП 1 — три турнира. По ним считается ПЕРВЫЙ снимок.
addResults(0, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]); // Кубок Смоленска (A)
addResults(1, [[1, 1], [0, 2], [5, 3], [6, 4], [2, 5]]); // Первенство Вязьмы (B)
addResults(2, [[2, 1], [3, 2], [4, 3], [5, 4], [1, 5]]); // Турнир Рославля (B)
insMatch.run(T[0], P[0], P[1]);
insMatch.run(T[1], P[1], P[0]); // обратный матч — отдельная строка, разрешён
insMatch.run(T[2], P[2], P[3]);

const first = recompute(db, {
  staleLockMinutes: config.rating.staleLockMinutes,
  keepSnapshots: config.rating.keepSnapshots,
});

// ЭТАП 2 — ещё два турнира, ранги перетасовываются, приходит новый игрок.
// По ним считается ВТОРОЙ снимок: относительно него и рисуются стрелки.
addResults(3, [[1, 1], [2, 2], [0, 3], [7, 4], [5, 5]]); // Гран-при «Днепр» (A)
addResults(4, [[7, 1], [4, 2], [6, 3], [3, 4], [0, 5]]); // Кубок Сафоново (B)
insMatch.run(T[3], P[1], P[2]);
insMatch.run(T[4], P[7], P[4]);

const second = recompute(db, {
  staleLockMinutes: config.rating.staleLockMinutes,
  keepSnapshots: config.rating.keepSnapshots,
});

console.log(`[seed] база: ${dbPath()}`);
console.log(`[seed] игроков: ${P.length}, турниров: ${T.length}`);
console.log(`[seed] снимок 1: #${first.snapshotId} (${first.players} игроков)`);
console.log(`[seed] снимок 2: #${second.snapshotId} (${second.players} игроков)`);
console.log(`[seed] пользователи: ${config.superAdmin.username} (super-admin), turnir (tournament-admin)`);
closeDb();
