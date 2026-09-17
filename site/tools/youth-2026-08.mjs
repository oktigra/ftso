// ДОЛИВКА ТУРНИРА №5 «Первенство Смоленской области до 13 и до 17 лет» (24–29.08.2026)
// из семи сеток протокола (вложения письма info@ftso67.ru от 15.09.2026, гл. судья Плешков Е.В.).
//
// Что делает (только то, чего на сайте ещё нет):
//   • одиночные сетки Юноши до 13 / Юноши до 17 / Девушки до 17 — дописывает финал, матч за 3 место,
//     сверяет каждый уже записанный счёт с протоколом (расхождение печатает; с --fix перезаписывает),
//     затем «Записать места» — как кнопка в админке, плюс места 3/4 по матчу за 3 место;
//   • парные сетки Юноши до 13 пары / Девушки до 13 пары / Микст до 13 / Микст до 17 — создаёт сетку,
//     сеет пары, разносит счёт, пишет места (микст — в разряд «микст», не в «парный»).
//   Матчи без счёта в протоколе (микст до 13) записываются без счёта: победитель известен, счёта нет.
//
// Запуск из /var/www/ftso/site (под пользователем ftso):
//   node tools/youth-2026-08.mjs               — СУХОЙ ПРОГОН: всё считает, печатает план, откатывает
//   node tools/youth-2026-08.mjs --apply       — запись одной транзакцией; перед ней копия БД рядом
//   node tools/youth-2026-08.mjs --apply --fix — то же + перезапись расходящихся счетов по протоколу
//   node tools/youth-2026-08.mjs --apply --recalc — то же + снимок рейтинга (как кнопка «Пересчитать»)
//   --anna-is-valeria — считать «Безимову Анну» (пары до 13) той же «Безимовой Валерией», что в одиночке
import { copyFileSync } from 'node:fs';
import { loadEnvFile, loadConfig } from '../server/lib/config.mjs';
import { getDb, dbPath } from '../db/connect.mjs';
import { normalizeName } from '../server/lib/registrations.mjs';
import { seed, decide, undo, bracketPlaces, roundsOf, roundName } from '../server/lib/brackets.mjs';
import { parseScore } from '../server/lib/groups.mjs';
import { logAction } from '../server/lib/action-log.mjs';
import { recompute } from '../server/lib/rating-service.mjs';

const ARGS = new Set(process.argv.slice(2));
const APPLY = ARGS.has('--apply'); const FIX = ARGS.has('--fix'); const RECALC = ARGS.has('--recalc');
const ANNA_IS_VALERIA = ARGS.has('--anna-is-valeria');

// Турнир на сайте узнаём по датам и названию, а не по номеру: номер — производная.
const TOURNAMENT = { start: '2026-08-24', end: '2026-08-29', nameRe: /первенство.*до 13 и до 17/i };
const PLAYED_ON = '2026-08-29';

// Опечатки протокола → как игрок записан на сайте (сверено с /tournaments/5 17.09.2026)
const ALIAS = {
  'захарова алина': 'Захарова Арина',
  'переходкин константин': 'Переходкин Валентин',
  'косногова елизавета': 'Косоногова Елизавета',
  'коржаков клементий': 'Коржаков Климентий',
  'коржаков клим': 'Коржаков Климентий',
};
if (ANNA_IS_VALERIA) ALIAS['безимова анна'] = 'Безимова Валерия';
// Пол для игроков, которых на сайте ещё нет (заводятся с городом турнира, без даты рождения)
const NEW_SEX = { 'шевелев марк': 'M', 'безимова анна': 'F' };

const B = '—'; // свободная позиция (bye)
// Счёт везде — ОТ ПОБЕДИТЕЛЯ, как в протоколе. null — счёта в протоколе нет.
const DRAWS = [
  {
    name: 'Юноши до 13', kind: 'single', size: 32, existing: true,
    seeds: ['Троян Михаил', B, 'Стаин Иван', 'Алферов Леонид', 'Вислогузов Артем', B, B, 'Переходкин Валентин',
      'Бондарев Артем', B, 'Гирвиц Матвей', B, 'Станкеев Александр', B, B, 'Лось Александр',
      'Коржаков Иван', B, 'Михайлов Тимофей', B, 'Семин Олег', B, B, 'Титоренко Елисей',
      'Кугелев Михаил', B, 'Степаньков Степан', B, 'Станкеев Дмитрий', B, B, 'Сенин Александр'],
    matches: [
      ['Стаин Иван', 'Алферов Леонид', '6:2 6:3'],
      ['Троян Михаил', 'Стаин Иван', '6:0 6:1'], ['Переходкин Валентин', 'Вислогузов Артем', '6:0 6:0'],
      ['Бондарев Артем', 'Гирвиц Матвей', '6:0 6:2'], ['Лось Александр', 'Станкеев Александр', '6:0 6:0'],
      ['Коржаков Иван', 'Михайлов Тимофей', '6:0 6:3'], ['Титоренко Елисей', 'Семин Олег', '6:0 6:0'],
      ['Кугелев Михаил', 'Степаньков Степан', '6:3 6:0'], ['Сенин Александр', 'Станкеев Дмитрий', '6:0 6:0'],
      ['Переходкин Валентин', 'Троян Михаил', '7:5 7:5'], ['Бондарев Артем', 'Лось Александр', '6:1 6:1'],
      ['Коржаков Иван', 'Титоренко Елисей', '6:2 6:3'], ['Кугелев Михаил', 'Сенин Александр', '6:2 6:3'],
      ['Бондарев Артем', 'Переходкин Валентин', '7:5 6:3'], ['Коржаков Иван', 'Кугелев Михаил', '6:4 6:0'],
      ['Бондарев Артем', 'Коржаков Иван', '1:6 7:6 6:4'],
    ],
    third: ['Переходкин Валентин', 'Кугелев Михаил', '6:4 4:6 7:6'],
  },
  {
    name: 'Юноши до 17', kind: 'single', size: 16, existing: true,
    seeds: ['Акаев Константин', B, 'Борисов Андрей', 'Семин Никита', 'Таразевич Андрей', B, 'Ефимов Павел', B,
      B, 'Богачев Лев', B, 'Коржаков Климентий', 'Крюковский Михаил', 'Андреев Егор', B, 'Ковалев Семен'],
    matches: [
      ['Борисов Андрей', 'Семин Никита', '6:2 6:1'], ['Андреев Егор', 'Крюковский Михаил', 'отказ'],
      ['Акаев Константин', 'Борисов Андрей', '6:0 6:0'], ['Таразевич Андрей', 'Ефимов Павел', 'неявка'],
      ['Коржаков Климентий', 'Богачев Лев', '6:2 6:1'], ['Ковалев Семен', 'Андреев Егор', '6:0 6:0'],
      ['Акаев Константин', 'Таразевич Андрей', '3:6 6:0 6:3'], ['Ковалев Семен', 'Коржаков Климентий', '6:2 6:1'],
      ['Ковалев Семен', 'Акаев Константин', '2:6 6:3 6:0'],
    ],
    third: ['Таразевич Андрей', 'Коржаков Климентий', '6:1 6:1'],
  },
  {
    name: 'Девушки до 17', kind: 'single', size: 16, existing: true,
    seeds: ['Захарян Кристина', B, 'Тарасова Варвара', 'Баяндина Злата', 'Коржакова Елизавета', B, 'Фролович Алина', 'Мушкатерова Анастасия',
      'Пурикова Софья', 'Дарчи Кристина', B, 'Захарян София', 'Комарова Виктория', B, B, 'Полякова Анастасия'],
    matches: [
      ['Тарасова Варвара', 'Баяндина Злата', '6:4 4:6 6:4'], ['Мушкатерова Анастасия', 'Фролович Алина', '6:0 6:0'],
      ['Пурикова Софья', 'Дарчи Кристина', '6:0 6:2'],
      ['Захарян Кристина', 'Тарасова Варвара', '6:0 6:0'], ['Мушкатерова Анастасия', 'Коржакова Елизавета', 'отказ'],
      ['Захарян София', 'Пурикова Софья', '6:3 6:0'], ['Полякова Анастасия', 'Комарова Виктория', '6:2 6:3'],
      ['Захарян Кристина', 'Мушкатерова Анастасия', '6:1 6:0'], ['Захарян София', 'Полякова Анастасия', '6:4 6:2'],
      ['Захарян Кристина', 'Захарян София', '6:1 6:2'],
    ],
    third: ['Полякова Анастасия', 'Мушкатерова Анастасия', '6:4 6:2'],
  },
  {
    name: 'Юноши до 13 пары', kind: 'double', size: 8,
    seeds: ['Сенин Александр / Переходкин Валентин', 'Лось Александр / Гирвиц Матвей', 'Стаин Иван / Михайлов Тимофей', 'Кугелев Михаил / Титоренко Елисей',
      'Коржаков Иван / Вислогузов Артем', 'Станкеев Александр / Станкеев Дмитрий', 'Степаньков Степан / Алферов Леонид', 'Троян Михаил / Бондарев Артем'],
    matches: [
      ['Лось Александр / Гирвиц Матвей', 'Сенин Александр / Переходкин Валентин', '2:6 6:4 11:9'],
      ['Кугелев Михаил / Титоренко Елисей', 'Стаин Иван / Михайлов Тимофей', '7:5 6:1'],
      ['Коржаков Иван / Вислогузов Артем', 'Станкеев Александр / Станкеев Дмитрий', '6:1 6:3'],
      ['Троян Михаил / Бондарев Артем', 'Степаньков Степан / Алферов Леонид', '6:1 6:0'],
      ['Кугелев Михаил / Титоренко Елисей', 'Лось Александр / Гирвиц Матвей', '7:6 6:2'],
      ['Троян Михаил / Бондарев Артем', 'Коржаков Иван / Вислогузов Артем', '6:2 6:2'],
      ['Троян Михаил / Бондарев Артем', 'Кугелев Михаил / Титоренко Елисей', '6:1 6:1'],
    ],
    third: ['Коржаков Иван / Вислогузов Артем', 'Лось Александр / Гирвиц Матвей', '6:4 4:6 10:6'],
  },
  {
    name: 'Девушки до 13 пары', kind: 'double', size: 16,
    seeds: ['Антонова Мария / Тимашкова Анастасия', B, 'Статенина Ева / Каяниди Агата', 'Косоногова Елизавета / Безимова Анна',
      'Захарова Арина / Кудренко Ева', B, 'Полуянова Таина / Борисова Алиса', B,
      'Шамплетова Анастасия / Петрович Веста', B, B, 'Анисимова Анна / Вавиленкова Анна',
      'Нозикова Мария / Богданова Валерия', 'Вислогузова Анна / Ковалева Александра', B, 'Алекса София / Зайцева Вера'],
    matches: [
      ['Косоногова Елизавета / Безимова Анна', 'Статенина Ева / Каяниди Агата', '4:6 6:1 10:6'],
      ['Вислогузова Анна / Ковалева Александра', 'Нозикова Мария / Богданова Валерия', '6:3 6:3'],
      ['Антонова Мария / Тимашкова Анастасия', 'Косоногова Елизавета / Безимова Анна', '6:0 6:1'],
      ['Захарова Арина / Кудренко Ева', 'Полуянова Таина / Борисова Алиса', '6:0 6:0'],
      ['Анисимова Анна / Вавиленкова Анна', 'Шамплетова Анастасия / Петрович Веста', '6:0 6:1'],
      ['Алекса София / Зайцева Вера', 'Вислогузова Анна / Ковалева Александра', '6:1 6:2'],
      ['Антонова Мария / Тимашкова Анастасия', 'Захарова Арина / Кудренко Ева', '6:1 6:1'],
      ['Алекса София / Зайцева Вера', 'Анисимова Анна / Вавиленкова Анна', '7:6 6:0'],
      ['Антонова Мария / Тимашкова Анастасия', 'Алекса София / Зайцева Вера', '6:3 6:3'],
    ],
    third: ['Захарова Арина / Кудренко Ева', 'Анисимова Анна / Вавиленкова Анна', '6:4 6:3'],
  },
  {
    name: 'Микст до 13', kind: 'double', mixed: true, size: 16,
    seeds: ['Антонова Мария / Бондарев Артем', B, 'Каяниди Агата / Станкеев Александр', 'Кудренко Ева / Степаньков Степан',
      'Анисимова Анна / Сенин Александр', 'Полуянова Таина / Станкеев Дмитрий', 'Алекса София / Коржаков Иван', 'Петрович Веста / Троян Михаил',
      'Безимова Валерия / Гирвиц Матвей', 'Захарова Арина / Кугелев Михаил', 'Борисова Алиса / Алферов Леонид', 'Зайцева Вера / Титоренко Елисей',
      'Косоногова Елизавета / Лось Александр', 'Вислогузова Анна / Вислогузов Артем', B, 'Тимашкова Анастасия / Переходкин Валентин'],
    matches: [
      ['Кудренко Ева / Степаньков Степан', 'Каяниди Агата / Станкеев Александр', '6:2 6:7 10:4'],
      ['Анисимова Анна / Сенин Александр', 'Полуянова Таина / Станкеев Дмитрий', '6:0 6:0'],
      ['Алекса София / Коржаков Иван', 'Петрович Веста / Троян Михаил', '7:6 7:5'],
      ['Захарова Арина / Кугелев Михаил', 'Безимова Валерия / Гирвиц Матвей', '6:4 6:4'],
      ['Зайцева Вера / Титоренко Елисей', 'Борисова Алиса / Алферов Леонид', '6:0 6:0'],
      ['Косоногова Елизавета / Лось Александр', 'Вислогузова Анна / Вислогузов Артем', '6:0 6:0'],
      ['Антонова Мария / Бондарев Артем', 'Кудренко Ева / Степаньков Степан', '6:0 6:2'],
      ['Алекса София / Коржаков Иван', 'Анисимова Анна / Сенин Александр', null],
      ['Зайцева Вера / Титоренко Елисей', 'Захарова Арина / Кугелев Михаил', '6:2 6:4'],
      ['Тимашкова Анастасия / Переходкин Валентин', 'Косоногова Елизавета / Лось Александр', '6:7 6:4 10:6'],
      ['Антонова Мария / Бондарев Артем', 'Алекса София / Коржаков Иван', null],
      ['Зайцева Вера / Титоренко Елисей', 'Тимашкова Анастасия / Переходкин Валентин', null],
      ['Зайцева Вера / Титоренко Елисей', 'Антонова Мария / Бондарев Артем', null],
    ],
    third: ['Алекса София / Коржаков Иван', 'Тимашкова Анастасия / Переходкин Валентин', null],
  },
  {
    name: 'Микст до 17', kind: 'double', mixed: true, size: 8,
    seeds: ['Захарян Кристина / Акаев Константин', 'Андреев Егор / Фролович Алина', 'Мушкатерова Анастасия / Коржаков Климентий', 'Борисов Андрей / Тарасова Варвара',
      'Ковалев Семен / Ковалева Александра', 'Полякова Анастасия / Богачев Лев', 'Дарчи Кристина / Шевелев Марк', 'Захарян София / Таразевич Андрей'],
    matches: [
      ['Захарян Кристина / Акаев Константин', 'Андреев Егор / Фролович Алина', '6:0 6:0'],
      ['Мушкатерова Анастасия / Коржаков Климентий', 'Борисов Андрей / Тарасова Варвара', '7:5 6:0'],
      ['Полякова Анастасия / Богачев Лев', 'Ковалев Семен / Ковалева Александра', '6:2 6:4'],
      ['Захарян София / Таразевич Андрей', 'Дарчи Кристина / Шевелев Марк', 'отказ'],
      ['Захарян Кристина / Акаев Константин', 'Мушкатерова Анастасия / Коржаков Климентий', '6:0 6:0'],
      ['Захарян София / Таразевич Андрей', 'Полякова Анастасия / Богачев Лев', '6:0 6:0'],
      ['Захарян Кристина / Акаев Константин', 'Захарян София / Таразевич Андрей', '6:4 4:6 10:6'],
    ],
    third: ['Мушкатерова Анастасия / Коржаков Климентий', 'Полякова Анастасия / Богачев Лев', '6:2 6:4'],
  },
];

// ---------------------------------------------------------------------------
loadEnvFile();
const config = loadConfig({ requireSecrets: false });
const db = getDb();
const out = []; const log = (s) => { out.push(s); console.log(s); };
const warn = (s) => log(`  ! ${s}`);

const tour = db.prepare('SELECT id, name, city, start_date, end_date FROM tournaments WHERE start_date = ? AND end_date = ?').all(TOURNAMENT.start, TOURNAMENT.end)
  .find((t) => TOURNAMENT.nameRe.test(t.name));
if (!tour) { console.error(`Турнир ${TOURNAMENT.start}—${TOURNAMENT.end} не найден — ничего не делаю`); process.exit(2); }
const TID = tour.id;
log(`Турнир #${TID} «${tour.name}» (${tour.start_date} — ${tour.end_date}), режим: ${APPLY ? 'ЗАПИСЬ' : 'СУХОЙ ПРОГОН'}${FIX ? ' + правка счетов' : ''}`);

// --- игроки -----------------------------------------------------------------
const created = []; const byKey = new Map();
for (const p of db.prepare('SELECT id, full_name FROM players WHERE anonymized_at IS NULL').all()) {
  const k = normalizeName(p.full_name); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(p);
}
const canon = (raw) => { const k = normalizeName(raw); return ALIAS[k] || String(raw).trim().replace(/\s+/g, ' '); };
const pid = (raw) => {
  const name = canon(raw); const k = normalizeName(name);
  const found = byKey.get(k) || [];
  if (found.length > 1) throw new Error(`«${name}»: на сайте несколько игроков — ${found.map((p) => '#' + p.id).join(', ')}`);
  if (found.length === 1) return found[0].id;
  const sex = NEW_SEX[k];
  if (!sex) throw new Error(`«${name}»: на сайте нет и пола для заведения не задано`);
  const id = Number(db.prepare('INSERT INTO players (full_name, city, sex) VALUES (?, ?, ?)').run(name, tour.city || 'Смоленск', sex).lastInsertRowid);
  byKey.set(k, [{ id, full_name: name }]); created.push(`#${id} ${name} (${sex === 'F' ? 'жен' : 'муж'})`);
  return id;
};
const entrant = (raw, kind) => {
  const parts = String(raw).split('/').map((x) => x.trim()).filter(Boolean);
  if (kind === 'double' && parts.length !== 2) throw new Error(`Пара «${raw}» записана не как «А / Б»`);
  return { playerId: pid(parts[0]), partnerId: kind === 'double' ? pid(parts[1]) : null };
};
const nameOf = (id) => db.prepare('SELECT full_name FROM players WHERE id = ?').get(id)?.full_name || `#${id}`;
const label = (slot) => (slot ? nameOf(slot.player_id) + (slot.partner_id ? ' / ' + nameOf(slot.partner_id) : '') : '—');

// счёт от победителя → от ВЕРХНЕГО слота (так ждёт decide)
function orient(scoreFromWinner, winnerIsTop) {
  const s = String(scoreFromWinner).trim();
  if (/^неявка$/i.test(s)) return winnerIsTop ? 'неявка 2' : 'неявка 1';
  if (/^отказ$/i.test(s)) return winnerIsTop ? 'отказ 2' : 'отказ 1';
  if (winnerIsTop) return s;
  return s.split(' ').map((x) => { const m = /^(\d+):(\d+)(\(\d+\))?$/.exec(x); return m ? `${m[2]}:${m[1]}${m[3] || ''}` : x; }).join(' ');
}
const slotAt = (bid, r, pos) => db.prepare('SELECT player_id, partner_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(bid, r, pos) || null;
const findPair = (bid, R, a, b) => {
  for (let r = 0; r < R; r++) {
    const n = 2 ** (R - r) / 2;
    for (let k = 0; k < n; k++) {
      const t = slotAt(bid, r, 2 * k)?.player_id; const u = slotAt(bid, r, 2 * k + 1)?.player_id;
      if (t && u && ((t === a && u === b) || (t === b && u === a))) return { r, k, top: t };
    }
  }
  return null;
};
// матч без счёта: победитель проходит, строка матча без score (как decide, но без разбора счёта)
function decideNoScore(b, r, k, winnerId) {
  const A = slotAt(b.id, r, 2 * k); const C = slotAt(b.id, r, 2 * k + 1);
  const w = winnerId === A.player_id ? A : C; const l = w === A ? C : A;
  db.prepare('DELETE FROM matches WHERE tournament_id = ? AND stage = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))').run(TID, `b:${b.id}`, A.player_id, C.player_id, C.player_id, A.player_id);
  db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, winner_partner_id, loser_partner_id, played_on) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)').run(TID, w.player_id, l.player_id, b.kind, `b:${b.id}`, w.partner_id, l.partner_id, PLAYED_ON);
  db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id, partner_id) VALUES (?, ?, ?, ?, ?)').run(b.id, r + 1, k, w.player_id, w.partner_id);
}
// места микста: логика bracketPlaces, но разряд 'mixed' — bracketPlaces пишет разряд сетки ('double')
// и снёс бы парные места тех же детей
function mixedPlaces(b) {
  const R = roundsOf(b.size);
  const champion = slotAt(b.id, R, 0)?.player_id; if (!champion) throw new Error(`${b.name}: финал не сыгран`);
  const rows = db.prepare('SELECT round, player_id, partner_id FROM bracket_slots WHERE bracket_id = ?').all(b.id);
  const maxRound = new Map(); const partnerOf = new Map();
  for (const s of rows) { maxRound.set(s.player_id, Math.max(maxRound.get(s.player_id) ?? -1, s.round)); if (s.partner_id) partnerOf.set(s.player_id, s.partner_id); }
  const del = db.prepare("DELETE FROM results WHERE tournament_id = ? AND player_id = ? AND discipline = 'mixed'");
  const ins = db.prepare("INSERT INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, 'mixed')");
  let n = 0;
  for (const [p, mr] of maxRound) {
    const lost = R - 1 - mr; const place = p === champion ? 1 : lost === 0 ? 2 : 2 ** lost + 1;
    for (const who of [p, partnerOf.get(p)].filter(Boolean)) { del.run(TID, who); ins.run(TID, who, place); n++; }
  }
  return n;
}
const setPlace = (discipline, playerId, place) => {
  db.prepare('DELETE FROM results WHERE tournament_id = ? AND player_id = ? AND discipline = ?').run(TID, playerId, discipline);
  db.prepare('INSERT INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, ?)').run(TID, playerId, place, discipline);
};

// --- ход --------------------------------------------------------------------
const stats = { brackets: 0, seeded: 0, decided: 0, kept: 0, fixed: 0, diff: 0, noscore: 0, third: 0, places: 0 };
if (APPLY) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  const bak = `${dbPath()}.bak.youth-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
  copyFileSync(dbPath(), bak); log(`Копия БД перед записью: ${bak}`);
}
db.exec('BEGIN IMMEDIATE');
try {
  for (const d of DRAWS) {
    log(`\n== ${d.name} (${d.kind === 'double' ? (d.mixed ? 'микст' : 'пары') : 'одиночный'}, на ${d.size})`);
    const disc = d.mixed ? 'mixed' : d.kind;
    let b = db.prepare('SELECT id, name, kind, size FROM tournament_brackets WHERE tournament_id = ? AND kind = ?').all(TID, d.kind)
      .find((x) => normalizeName(x.name) === normalizeName(d.name));
    if (d.existing && !b) throw new Error(`${d.name}: сетка на сайте не найдена, а ожидалась`);
    if (!d.existing && b) { warn(`сетка уже есть на сайте (#${b.id}) — пропускаю раздел целиком`); continue; }
    if (!b) {
      const id = Number(db.prepare('INSERT INTO tournament_brackets (tournament_id, name, kind, size) VALUES (?, ?, ?, ?)').run(TID, d.name, d.kind, d.size).lastInsertRowid);
      b = { id, name: d.name, kind: d.kind, size: d.size }; stats.brackets++; log(`  создана сетка #${id}`);
    }
    const R = roundsOf(b.size);
    // посев: сверка либо посев
    d.seeds.forEach((s, i) => {
      if (s === B) return;
      const e = entrant(s, d.kind);
      const have = slotAt(b.id, 0, i);
      if (have) {
        if (have.player_id !== e.playerId || (have.partner_id || null) !== (e.partnerId || null)) throw new Error(`${d.name}: позиция ${i + 1} на сайте «${label(have)}», в протоколе «${s}»`);
        return;
      }
      seed(db, TID, b.id, i + 1, e.playerId, e.partnerId); stats.seeded++;
    });
    if (!d.existing) log(`  посеяно позиций: ${d.seeds.filter((s) => s !== B).length}`);
    // байи первого круга
    for (let k = 0; k < b.size / 2; k++) {
      const t = slotAt(b.id, 0, 2 * k); const u = slotAt(b.id, 0, 2 * k + 1);
      if ((t ? 1 : 0) + (u ? 1 : 0) === 1 && !slotAt(b.id, 1, k)) decide(db, TID, b.id, 0, k, 'bye');
    }
    // матчи по кругам
    for (const [w, l, sc] of d.matches) {
      const wi = entrant(w, d.kind).playerId; const li = entrant(l, d.kind).playerId;
      const pair = findPair(b.id, R, wi, li);
      if (!pair) throw new Error(`${d.name}: пара «${w}» — «${l}» не найдена в сетке (порядок кругов?)`);
      const stage = roundName(b.size, pair.r);
      const already = slotAt(b.id, pair.r + 1, pair.k);
      if (already) {
        const m = db.prepare('SELECT score, winner_player_id FROM matches WHERE tournament_id = ? AND stage = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))').get(TID, `b:${b.id}`, wi, li, li, wi);
        const want = sc === null ? null : parseScore(orient(sc, true)).score; // от победителя, в форме хранения
        if (already.player_id !== wi) { stats.diff++; warn(`${stage}: ${w} — ${l}: на сайте победил «${nameOf(already.player_id)}», по протоколу «${w}» — НЕ ТРОГАЮ, разберитесь руками`); continue; }
        if ((m?.score ?? null) === want || sc === null) { stats.kept++; continue; }
        if (!FIX) { stats.diff++; warn(`${stage}: ${w} — ${l}: на сайте «${m?.score ?? 'без счёта'}», по протоколу «${sc}» (с --fix перепишу)`); continue; }
        if (slotAt(b.id, pair.r + 2, Math.floor(pair.k / 2)) && pair.r + 2 <= R) { stats.diff++; warn(`${stage}: ${w} — ${l}: счёт расходится, но следующий круг уже записан — не трогаю`); continue; }
        undo(db, TID, b.id, pair.r, pair.k);
        decide(db, TID, b.id, pair.r, pair.k, orient(sc, pair.top === wi)); stats.fixed++;
        log(`  ${stage}: ${w} — ${l}: «${m?.score ?? 'без счёта'}» → «${sc}» (исправлено)`); continue;
      }
      if (sc === null) { decideNoScore(b, pair.r, pair.k, wi); stats.noscore++; log(`  ${stage}: ${w} — ${l}: без счёта в протоколе (победитель записан)`); continue; }
      decide(db, TID, b.id, pair.r, pair.k, orient(sc, pair.top === wi)); stats.decided++;
      log(`  ${stage}: ${w} — ${l} ${sc}`);
    }
    // места
    if (!slotAt(b.id, R, 0)) { warn(`финал не записан — места не считаю`); continue; }
    const before = db.prepare('SELECT COUNT(*) c FROM results WHERE tournament_id = ? AND discipline = ? AND player_id IN (SELECT player_id FROM bracket_slots WHERE bracket_id = ? UNION SELECT partner_id FROM bracket_slots WHERE bracket_id = ? AND partner_id IS NOT NULL)').get(TID, disc, b.id, b.id).c;
    const n = d.mixed ? mixedPlaces(b) : bracketPlaces(db, TID, b.id); stats.places += n;
    // матч за 3 место: отдельный матч + места 3/4 (bracketPlaces даёт обоим проигравшим полуфинала 3)
    if (d.third) {
      const [tw, tl, tsc] = d.third; const W = entrant(tw, d.kind); const L = entrant(tl, d.kind);
      const exists = db.prepare("SELECT 1 FROM matches WHERE tournament_id = ? AND stage = 'manual' AND winner_player_id = ? AND loser_player_id = ? AND kind = ?").get(TID, W.playerId, L.playerId, d.kind);
      if (!exists) {
        db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, winner_partner_id, loser_partner_id, played_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(TID, W.playerId, L.playerId, tsc === null ? null : parseScore(tsc).score, d.kind, 'manual', W.partnerId, L.partnerId, PLAYED_ON);
        stats.third++;
      }
      for (const id of [W.playerId, W.partnerId].filter(Boolean)) setPlace(disc, id, 3);
      for (const id of [L.playerId, L.partnerId].filter(Boolean)) setPlace(disc, id, 4);
      log(`  3 место: ${tw} — ${tl} ${tsc ?? 'без счёта'}`);
    }
    const rows = db.prepare('SELECT r.place, p.full_name FROM results r JOIN players p ON p.id = r.player_id WHERE r.tournament_id = ? AND r.discipline = ? AND r.player_id IN (SELECT player_id FROM bracket_slots WHERE bracket_id = ? UNION SELECT partner_id FROM bracket_slots WHERE bracket_id = ? AND partner_id IS NOT NULL) ORDER BY r.place, p.full_name').all(TID, disc, b.id, b.id);
    log(`  места (${disc}): было строк ${before}, стало ${rows.length}: ` + rows.map((r) => `${r.place} ${r.full_name}`).join('; '));
  }

  log(`\nИТОГО: сеток создано ${stats.brackets}, посеяно ${stats.seeded}, матчей записано ${stats.decided} (+${stats.noscore} без счёта), совпало с сайтом ${stats.kept}, исправлено ${stats.fixed}, расхождений оставлено ${stats.diff}, матчей за 3 место ${stats.third}, строк мест ${stats.places}`);
  if (created.length) log(`Заведены новые игроки (без даты рождения — дозаполнить в «Игроках»): ${created.join('; ')}`);
  else log('Новых игроков не заведено');

  if (!APPLY) { db.exec('ROLLBACK'); log('\nСУХОЙ ПРОГОН — ничего не записано. Запись: тот же запуск с --apply'); process.exit(0); }
  logAction(db, null, 'tournament.fill.youth-2026-08', TID, { ...stats, created: created.length, fix: FIX });
  db.exec('COMMIT');
  log('\nЗАПИСАНО.');
} catch (err) {
  db.exec('ROLLBACK');
  console.error(`\nОШИБКА, ничего не записано: ${err.message}`);
  process.exit(1);
}

if (RECALC) {
  const r = recompute(db, { staleLockMinutes: config.rating.staleLockMinutes, keepSnapshots: config.rating.keepSnapshots });
  log(r.ok ? `Снимок рейтинга #${r.snapshotId}, игроков ${r.players}${r.warnings?.length ? ', предупреждений ' + r.warnings.length : ''}` : `Рейтинг не пересчитан: ${r.reason}`);
}
