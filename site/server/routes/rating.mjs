import { currentStandings, statusLabel, RATING_CONFIG, DISCIPLINE_RU } from '../lib/rating-service.mjs';
import { toCSV as engineCSV } from '../../../rating/export.mjs';
import { AGE_GROUPS, SEXES } from '../lib/validate.mjs';
import { AGE_SLICES, sliceById } from '../lib/age.mjs';
import { xlsxFromRows } from '../lib/xlsx.mjs';

/** Строки витрины под выгрузку (CSV и XLSX — один состав, ТЗ 4.4). */
function exportRows(table, query) {
  return [
    ['Место', 'Игрок', 'Город', 'Пол', 'Возраст', 'Возрастная группа', 'Очки', 'Изменение'],
    ...applyFilters(table, query).map((p) => [
      p.rank,
      p.playerName,
      p.city,
      SEX_RU[p.sex] || p.sex,
      p.age === null || p.age === undefined ? '' : p.age,
      p.ageGroup || '',
      p.ratingPoints,
      p.change.label,
    ]),
  ];
}

const SEX_RU = { M: 'муж.', F: 'жен.' };
const BOM = '﻿';

/**
 * Фильтры §4.4 + ВОЗРАСТНЫЕ СРЕЗЫ (ТЗ ред. 6, как у РТТ): поиск по фамилии,
 * возрастная группа, пол, срез. Срез — по возрасту в полных годах, игрок стоит во
 * всех подходящих ему срезах сразу; без даты рождения — только в общей таблице.
 * МЕСТО ВНУТРИ СРЕЗА пересчитывается: «до 15» — своя таблица, а не выборка из
 * общей с дырами в нумерации (у РТТ у каждого среза свои места).
 */
function applyFilters(players, query) {
  const q = String(query.q || '').trim().toLowerCase();
  const age = String(query.age || '').trim();
  const sex = String(query.sex || '').trim();
  const slice = sliceById(query.slice);
  const rows = players.filter((p) => {
    if (q && !p.playerName.toLowerCase().includes(q)) return false;
    if (age && p.ageGroup !== age) return false;
    if (sex && p.sex !== sex) return false;
    if (slice && !p.slices.includes(slice.id)) return false;
    return true;
  });
  if (!slice) return rows;
  return rows.map((p, i) => ({ ...p, overallRank: p.rank, rank: i + 1 }));
}

/** Разряд: single (по умолчанию) или double. */
function pickDiscipline(query) {
  return String(query.discipline || '') === 'double' ? 'double' : 'single';
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function mountRating(app, { db }) {
  app.get('/rating', (req, res) => {
    const standings = currentStandings(db);
    const discipline = pickDiscipline(req.query);
    const table = standings ? (discipline === 'double' ? standings.doubles : standings.players) : [];
    // Пустой rating_cache -> «рейтинг ещё не рассчитан», НЕ 500 и не падение.
    const players = standings ? applyFilters(table, req.query) : [];
    const slice = sliceById(req.query.slice);
    res.render('rating', {
      title: 'Рейтинг игроков — ФТСО',
      standings,
      players,
      statusText: standings ? statusLabel(standings.status) : null,
      filters: {
        q: String(req.query.q || ''),
        age: String(req.query.age || ''),
        sex: String(req.query.sex || ''),
        slice: slice ? slice.id : '',
        discipline,
      },
      slice,
      ageSlices: AGE_SLICES,
      ageGroups: AGE_GROUPS,
      sexes: SEXES,
      sexRu: SEX_RU,
      disciplineRu: DISCIPLINE_RU,
      // Вкладка «парный» показывается, только когда парный рейтинг не пуст.
      hasDoubles: Boolean(standings && standings.doubles.length),
      rules: RATING_CONFIG,
      total: table.length,
    });
  });

  // CSV-экспорт: заголовки Content-Disposition + Content-Type, BOM для Excel.
  app.get('/rating.csv', (req, res) => {
    const standings = currentStandings(db);
    const table = standings ? (pickDiscipline(req.query) === 'double' ? standings.doubles : standings.players) : [];
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rating.csv"');
    // BOM задаём кодом (﻿), а не литералом в исходнике: литерал легко теряется
    // при копировании файла, а без BOM Excel открывает UTF-8 кракозябрами.
    if (!standings) return res.send(BOM);

    // format=engine — сырой экспорт СРЕДСТВАМИ ДВИЖКА (rating/export.mjs).
    if (req.query.format === 'engine') {
      return res.send(engineCSV({ ...standings, ratingStatus: standings.status }));
    }

    // По умолчанию — ровно то, что видно в таблице (с учётом фильтров).
    const rows = exportRows(table, req.query);
    res.send(BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  });

  // Excel (ТЗ 4.4): настоящий .xlsx тем же составом, что и таблица.
  app.get('/rating.xlsx', (req, res) => {
    const standings = currentStandings(db);
    const table = standings ? (pickDiscipline(req.query) === 'double' ? standings.doubles : standings.players) : [];
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rating-${standings ? standings.asOf : 'empty'}.xlsx"`);
    res.send(xlsxFromRows(standings ? exportRows(table, req.query) : [['Рейтинг ещё не рассчитан']], { sheet: 'Рейтинг' }));
  });

  // PDF (ТЗ 4.4): печатная версия без шапки/подвала — «Сохранить как PDF»
  // в диалоге печати браузера; отдельной PDF-библиотеки не нужно.
  app.get('/rating/print', (req, res) => {
    const standings = currentStandings(db);
    const discipline = pickDiscipline(req.query);
    const table = standings ? (discipline === 'double' ? standings.doubles : standings.players) : [];
    res.render('rating-print', {
      title: 'Рейтинг игроков — ФТСО',
      standings,
      rows: standings ? exportRows(table, req.query) : [],
      disciplineRu: DISCIPLINE_RU,
      discipline,
      statusText: standings ? statusLabel(standings.status) : null,
    });
  });
}
