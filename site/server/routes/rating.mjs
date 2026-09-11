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
 * возрастная группа, пол, срез. Срез — по возрасту, игрок стоит во всех
 * подходящих ему срезах сразу; без даты рождения — только в общей таблице.
 *
 * МЕСТА — ПО ПРАВИЛУ РТТ (сверено с классификацией РТТ 11.09.2026, зеркало
 * rttstat.ru, рейтинг от 02.09.2026): классификация ведётся отдельными списками
 * по полу и возрасту (юноши до 15, девушки до 15, мужчины, женщины…), в каждом
 * списке места СВОИ, с первого; равные очки делят место, следующее место
 * перешагивает делящих (1, 2, 2, 4). Фильтр по региону/городу у РТТ — только
 * вид: строки нумеруются заново, а место из родительского списка остаётся рядом.
 *
 * У нас так же: пол, возрастная группа и срез образуют СПИСОК — места считаются
 * внутри него, деление места наследуется от общей таблицы (кто делил там, делит и
 * тут); поиск по фамилии — только ВИД, места общей таблицы не меняет. Общая
 * таблица без фильтров остаётся (у РТТ смешанного списка нет, у федерации —
 * есть): в скобках на пластине — место в ней.
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
  if (!slice && !sex && !age) return rows;
  return rerank(rows);
}

/** Места внутри списка: с первого, делящие место в общей таблице делят и здесь. */
function rerank(rows) {
  let place = 0;
  let prevOverall = null;
  return rows.map((p, i) => {
    if (p.rank !== prevOverall) place = i + 1;
    prevOverall = p.rank;
    return { ...p, overallRank: p.rank, rank: place };
  });
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
