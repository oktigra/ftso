// Пример работы движка на выдуманном сезоне ФТСО.
// Запуск: node rating/example.mjs
// Печатает standings в консоль и пишет rating/out/standings.csv и standings.json

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeStandings, computeStandingsByAgeGroup, DEFAULT_CONFIG } from './rating.mjs';
import { printStandings, writeFiles, formatTable } from './export.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// asOf задан явно, чтобы пример был воспроизводим.
// В бою поле можно не передавать — по умолчанию это сегодняшняя дата по UTC.
const asOf = '2026-08-05';

const config = {
  ...DEFAULT_CONFIG,
  ratingStatus: 'preliminary', // первый год — рейтинг предварительный
};

const tournaments = [
  { id: 'ch-obl-2025', name: 'Чемпионат области 2025', endDate: '2025-09-14', category: 'A' },
  { id: 'perv-obl-2025', name: 'Первенство области 2025', endDate: '2025-10-05', category: 'A' },
  { id: 'kubok-osen', name: 'Осенний кубок', endDate: '2025-11-02', category: 'B' },
  { id: 'zima-open', name: 'Зимний турнир', endDate: '2026-01-25', category: 'B' },
  { id: 'vesna-cup', name: 'Весенний кубок', endDate: '2026-04-12', category: 'B' },
  { id: 'ch-obl-2026', name: 'Чемпионат области 2026', endDate: '2026-06-21', category: 'A' },
  { id: 'leto-open', name: 'Летний турнир', endDate: '2026-07-19', category: 'B' },
  // вне окна: завершился больше 364 дней назад — в зачёт не идёт
  { id: 'kubok-2025-vesna', name: 'Весенний кубок 2025', endDate: '2025-05-18', category: 'B' },
];

const results = [
  // Смирнов
  { playerId: 'sm', playerName: 'Смирнов Алексей', tournamentId: 'ch-obl-2025', place: 1 },
  { playerId: 'sm', playerName: 'Смирнов Алексей', tournamentId: 'kubok-osen', place: 1 },
  { playerId: 'sm', playerName: 'Смирнов Алексей', tournamentId: 'zima-open', place: 2 },
  { playerId: 'sm', playerName: 'Смирнов Алексей', tournamentId: 'ch-obl-2026', place: 3 },
  { playerId: 'sm', playerName: 'Смирнов Алексей', tournamentId: 'leto-open', place: 1 },
  { playerId: 'sm', playerName: 'Смирнов Алексей', tournamentId: 'kubok-2025-vesna', place: 1 },
  // Кузнецов
  { playerId: 'kz', playerName: 'Кузнецов Дмитрий', tournamentId: 'ch-obl-2025', place: 2 },
  { playerId: 'kz', playerName: 'Кузнецов Дмитрий', tournamentId: 'kubok-osen', place: 3 },
  { playerId: 'kz', playerName: 'Кузнецов Дмитрий', tournamentId: 'zima-open', place: 1 },
  { playerId: 'kz', playerName: 'Кузнецов Дмитрий', tournamentId: 'vesna-cup', place: 2 },
  { playerId: 'kz', playerName: 'Кузнецов Дмитрий', tournamentId: 'ch-obl-2026', place: 4 },
  { playerId: 'kz', playerName: 'Кузнецов Дмитрий', tournamentId: 'leto-open', place: 5 },
  // Попова
  { playerId: 'pp', playerName: 'Попова Мария', tournamentId: 'perv-obl-2025', place: 1 },
  { playerId: 'pp', playerName: 'Попова Мария', tournamentId: 'zima-open', place: 3 },
  { playerId: 'pp', playerName: 'Попова Мария', tournamentId: 'vesna-cup', place: 1 },
  { playerId: 'pp', playerName: 'Попова Мария', tournamentId: 'leto-open', place: 9 },
  // Волков — 70 + 70 + 50 = 190
  { playerId: 'vl', playerName: 'Волков Игорь', tournamentId: 'kubok-osen', place: 2 },
  { playerId: 'vl', playerName: 'Волков Игорь', tournamentId: 'ch-obl-2026', place: 8 },
  { playerId: 'vl', playerName: 'Волков Игорь', tournamentId: 'leto-open', place: 2 },
  // Орлов — ровно те же 190 (25+25+45+45+50), разводит тай-брейк
  { playerId: 'or', playerName: 'Орлов Сергей', tournamentId: 'kubok-osen', place: 5 },
  { playerId: 'or', playerName: 'Орлов Сергей', tournamentId: 'zima-open', place: 5 },
  { playerId: 'or', playerName: 'Орлов Сергей', tournamentId: 'vesna-cup', place: 3 },
  { playerId: 'or', playerName: 'Орлов Сергей', tournamentId: 'leto-open', place: 3 },
  { playerId: 'or', playerName: 'Орлов Сергей', tournamentId: 'ch-obl-2026', place: 5 },
  // Новичок: один турнир далеко за таблицей очков
  { playerId: 'nv', playerName: 'Новиков Пётр', tournamentId: 'leto-open', place: 21 },
];

const matches = [
  // Волков и Орлов равны по очкам (190). Ступень 2 подняла бы Волкова (70 против 50 на
  // первой позиции), но ступень 1 идёт раньше: Орлов обыграл Волкова — он и выше.
  { tournamentId: 'kubok-osen', winnerPlayerId: 'or', loserPlayerId: 'vl' },
  { tournamentId: 'leto-open', winnerPlayerId: 'sm', loserPlayerId: 'kz' },
  { tournamentId: 'zima-open', winnerPlayerId: 'kz', loserPlayerId: 'pp' },
];

const players = [
  { playerId: 'sm', ageGroup: 'взрослые' },
  { playerId: 'kz', ageGroup: 'взрослые' },
  { playerId: 'pp', ageGroup: 'взрослые' },
  { playerId: 'vl', ageGroup: 'взрослые' },
  { playerId: 'or', ageGroup: 'до 17' },
  { playerId: 'nv', ageGroup: 'до 17' },
];

const standings = computeStandings({ tournaments, results, matches, asOf, config });
printStandings(standings);

const paths = writeFiles(standings, {
  csvPath: join(HERE, 'out', 'standings.csv'),
  jsonPath: join(HERE, 'out', 'standings.json'),
});
console.log(`\nЗаписано: ${paths.csvPath}\n           ${paths.jsonPath}`);

console.log('\n--- то же самое, разложенное по возрастным группам ---');
const byAge = computeStandingsByAgeGroup({ tournaments, results, matches, players, asOf, config });
for (const group of byAge.groups) {
  console.log(`\nГруппа: ${group.ageGroup ?? 'без группы'}`);
  console.log(formatTable({ ...standings, players: group.players }));
}
