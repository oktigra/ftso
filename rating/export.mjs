// Экспорт standings: печать таблицей в консоль, CSV и JSON.
// Стилизованный PDF/Excel под дизайн — отдельный шаг, когда будет макет.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATUS_RU = { preliminary: 'ПРЕДВАРИТЕЛЬНЫЙ', final: 'основной' };

function countedShort(counted) {
  return counted.map((e) => `${e.name} [${e.category}] место ${e.place} = ${e.points}`).join('; ');
}

/** Таблица для консоли. */
export function formatTable(standings) {
  const head = ['#', 'Игрок', 'Очки', 'Турниров', 'Зачётные'];
  const rows = standings.players.map((p) => [
    String(p.rank),
    `${p.playerName} (${p.playerId})`,
    String(p.ratingPoints),
    String(p.totalInWindow),
    countedShort(p.counted),
  ]);
  const widths = head.map((h, i) =>
    Math.max([...h].length, ...rows.map((r) => [...r[i]].length), 0),
  );
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const status = STATUS_RU[standings.ratingStatus] || standings.ratingStatus;
  return [
    `Рейтинг ФТСО на ${standings.asOf} — статус: ${status}`,
    line(head),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...rows.map(line),
  ].join('\n');
}

export function printStandings(standings) {
  console.log(formatTable(standings));
}

function csvCell(v) {
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV с BOM — чтобы Excel открыл UTF-8 без плясок. */
export function toCSV(standings) {
  const rows = [
    ['rank', 'playerId', 'playerName', 'ratingPoints', 'totalInWindow', 'ratingStatus', 'counted'],
    ...standings.players.map((p) => [
      p.rank,
      p.playerId,
      p.playerName,
      p.ratingPoints,
      p.totalInWindow,
      standings.ratingStatus,
      countedShort(p.counted),
    ]),
  ];
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function toJSON(standings) {
  return JSON.stringify(standings, null, 2) + '\n';
}

/** Записать оба файла. Возвращает пути. */
export function writeFiles(standings, { csvPath, jsonPath }) {
  for (const p of [csvPath, jsonPath]) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(csvPath, toCSV(standings), 'utf8');
  writeFileSync(jsonPath, toJSON(standings), 'utf8');
  return { csvPath, jsonPath };
}
