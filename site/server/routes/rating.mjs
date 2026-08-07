import { currentStandings, statusLabel, RATING_CONFIG } from '../lib/rating-service.mjs';
import { toCSV as engineCSV } from '../../../rating/export.mjs';
import { AGE_GROUPS, SEXES } from '../lib/validate.mjs';

const SEX_RU = { M: 'муж.', F: 'жен.' };
const BOM = '﻿';

/** Фильтры §4.4: поиск по фамилии, возрастная группа, пол. */
function applyFilters(players, query) {
  const q = String(query.q || '').trim().toLowerCase();
  const age = String(query.age || '').trim();
  const sex = String(query.sex || '').trim();
  return players.filter((p) => {
    if (q && !p.playerName.toLowerCase().includes(q)) return false;
    if (age && p.ageGroup !== age) return false;
    if (sex && p.sex !== sex) return false;
    return true;
  });
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function mountRating(app, { db }) {
  app.get('/rating', (req, res) => {
    const standings = currentStandings(db);
    // Пустой rating_cache -> «рейтинг ещё не рассчитан», НЕ 500 и не падение.
    const players = standings ? applyFilters(standings.players, req.query) : [];
    res.render('rating', {
      title: 'Рейтинг игроков — ФТСО',
      standings,
      players,
      statusText: standings ? statusLabel(standings.status) : null,
      filters: {
        q: String(req.query.q || ''),
        age: String(req.query.age || ''),
        sex: String(req.query.sex || ''),
      },
      ageGroups: AGE_GROUPS,
      sexes: SEXES,
      sexRu: SEX_RU,
      rules: RATING_CONFIG,
      total: standings ? standings.players.length : 0,
    });
  });

  // CSV-экспорт: заголовки Content-Disposition + Content-Type, BOM для Excel.
  app.get('/rating.csv', (req, res) => {
    const standings = currentStandings(db);
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
    const rows = [
      ['Место', 'Игрок', 'Город', 'Пол', 'Возрастная группа', 'Очки', 'Изменение'],
      ...applyFilters(standings.players, req.query).map((p) => [
        p.rank,
        p.playerName,
        p.city,
        SEX_RU[p.sex] || p.sex,
        p.ageGroup || '',
        p.ratingPoints,
        p.change.label,
      ]),
    ];
    res.send(BOM + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n');
  });
}
