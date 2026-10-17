import { currentStandings, statusLabel, RATING_CONFIG, tableFor, RATING_GROUPS, RATING_GROUP_RU, LIST_DISCIPLINE_RU, listKey } from '../lib/rating-service.mjs';
import { methodView } from '../lib/rating-method-view.mjs';
import { toCSV as engineCSV } from '../../../rating/export.mjs';
import { SEXES } from '../lib/validate.mjs';
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
 * СПИСКИ (методика 17.10.2026): рейтинговая группа (взрослые / до 17 / до 13) и разряд
 * (одиночный / парный) выбираются вкладками — это шесть отдельных классификаций. Внутри
 * списка — пол (места считаются заново внутри пола, равные очки делят место, в скобках —
 * место в списке без фильтра) и поиск по фамилии (только вид, места не меняет).
 * Прежние срезы по году рождения ушли: возраст теперь задаёт группа сетки.
 */
function applyFilters(players, query) {
  const q = String(query.q || '').trim().toLowerCase();
  const sex = String(query.sex || '').trim();
  const rows = players.filter((p) => {
    if (q && !p.playerName.toLowerCase().includes(q)) return false;
    if (sex && p.sex !== sex) return false;
    return true;
  });
  if (!sex) return rows;
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

/** Список: группа (adult по умолчанию) и разряд single | pair; старые ссылки double/mixed → парный. */
function pickList(query) {
  const group = RATING_GROUPS.includes(String(query.group || '')) ? String(query.group) : 'adult';
  const d = String(query.discipline || '');
  const discipline = d === 'pair' || d === 'double' || d === 'mixed' ? 'pair' : 'single';
  return { group, discipline, key: listKey(group, discipline), label: `${RATING_GROUP_RU[group]} · ${LIST_DISCIPLINE_RU[discipline].toLowerCase()} разряд` };
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function mountRating(app, { db }) {
  app.get('/rating', (req, res) => {
    const standings = currentStandings(db);
    const list = pickList(req.query);
    const table = tableFor(standings, list.key);
    // Пустой rating_cache -> «рейтинг ещё не рассчитан», НЕ 500 и не падение.
    const players = standings ? applyFilters(table, req.query) : [];
    res.render('rating', {
      title: 'Рейтинг игроков — ФТСО',
      standings,
      players,
      statusText: standings ? statusLabel(standings.status) : null,
      filters: { q: String(req.query.q || ''), sex: String(req.query.sex || ''), group: list.group, discipline: list.discipline },
      list,
      groups: RATING_GROUPS,
      groupRu: RATING_GROUP_RU,
      sexes: SEXES,
      sexRu: SEX_RU,
      counts: standings ? Object.fromEntries(Object.entries(standings.lists).map(([k, v]) => [k, v.length])) : {},
      method: methodView(),
      rules: RATING_CONFIG,
      total: table.length,
    });
  });

  // КАК СЧИТАЕТСЯ РЕЙТИНГ — отдельной страницей (ссылки из вопросов-ответов и с карточек турниров).
  app.get('/rating/metodika', (req, res) => {
    res.render('rating-method', { title: 'Как считается рейтинг — ФТСО', method: methodView() });
  });

  // CSV-экспорт: заголовки Content-Disposition + Content-Type, BOM для Excel.
  app.get('/rating.csv', (req, res) => {
    const standings = currentStandings(db);
    const table = tableFor(standings, pickList(req.query).key);
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="rating.csv"');
    // BOM задаём кодом (﻿), а не литералом в исходнике: литерал легко теряется
    // при копировании файла, а без BOM Excel открывает UTF-8 кракозябрами.
    if (!standings) return res.send(BOM);

    // format=engine — сырой экспорт СРЕДСТВАМИ ДВИЖКА (rating/export.mjs).
    if (req.query.format === 'engine') {
      return res.send(engineCSV({ ...standings, players: table, ratingStatus: standings.status }));
    }

    // По умолчанию — ровно то, что видно в таблице (с учётом фильтров).
    const rows = exportRows(table, req.query);
    res.send(BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  });

  // Excel (ТЗ 4.4): настоящий .xlsx тем же составом, что и таблица.
  app.get('/rating.xlsx', (req, res) => {
    const standings = currentStandings(db);
    const table = tableFor(standings, pickList(req.query).key);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rating-${standings ? standings.asOf : 'empty'}.xlsx"`);
    res.send(xlsxFromRows(standings ? exportRows(table, req.query) : [['Рейтинг ещё не рассчитан']], { sheet: 'Рейтинг' }));
  });

  // PDF (ТЗ 4.4): печатная версия без шапки/подвала — «Сохранить как PDF»
  // в диалоге печати браузера; отдельной PDF-библиотеки не нужно.
  app.get('/rating/print', (req, res) => {
    const standings = currentStandings(db);
    const list = pickList(req.query);
    const table = tableFor(standings, list.key);
    res.render('rating-print', {
      title: 'Рейтинг игроков — ФТСО',
      standings,
      rows: standings ? exportRows(table, req.query) : [],
      listLabel: list.label,
      statusText: standings ? statusLabel(standings.status) : null,
    });
  });
}
