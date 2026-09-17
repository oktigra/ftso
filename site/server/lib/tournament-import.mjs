// ИМПОРТ ТУРНИРА ИЗ ТЕКСТА (06.09.2026): секретарь или агент переписывает протокол
// простым текстом — сайт заводит турнир ЧЕРНОВИКОМ, недостающих игроков, сетки/группы,
// матчи и места. Формат (строки, регистр не важен):
//
//   Турнир: Первенство области среди ветеранов
//   Даты: 2026-09-02 — 2026-09-06        (одна дата = завершение)
//   Город: Смоленск | Категория: A | Судья: Н. Груздин
//
//   Сетка: Мужчины 50+ | пол: M | возраст: 50+          ← олимпийка; размер по числу пар 1/8, 1/4, 1/2
//   1/4: Антонов — X → Антонов                            ← «X» = свободен (bye)
//   1/4: Гапеев — Степаньков 6:1/6:2 → Степаньков          ← счёт сетами через «/» или пробел
//   Финал: Антонов — Шульц 6:0/6:2 → Антонов
//   3 место: Степаньков — Костылев 5:7/6:3/10:6 → Костылев ← отдельный матч, места 3/4
//
//   Группа: Женщины 45+ | пол: F                        ← круговая, участники — из строк матчей
//   Букатина — Адаева 6:3/6:4                            ← слева победитель (если нет «→»)
//   Третьякова — Лобанова не сыгран                       ← пропускается
//
//   Пары: Мужские пары | пол: M                          ← парный разряд: только итоговые места
//   Итог: 1 Ермаков/Пестов, 2 Акаев/Груздин, 3 Антонов/Строков
//
//   Сетка: Микст до 17 | разряд: микст                   ← ПАРНАЯ или МИКСТОВАЯ сетка (17.09.2026):
//   1/2: Захарян / Акаев — Андреев / Фролович 6:0/6:0 → Захарян / Акаев     участник — ПАРА «А / Б»
//   Финал: Захарян / Акаев — Захарян С. / Таразевич → Захарян / Акаев       (счёта может не быть:
//   3 место: Мушкатерова / Коржаков — Полякова / Богачев 6:2/6:4            победитель после «→»)
//
// «разряд:» у раздела — одиночный (по умолчанию) | парный | микст. Микст играется парами,
// но места идут в свой зачёт, а не в парный.
//
// Игрок задаётся фамилией (и инициалом/именем, если есть): «Антонов», «Адаева И.», «Иванов Иван».
// Незнакомый заводится с полом раздела и городом турнира, дата рождения — пустая (секретарь
// дозаполнит). Одна фамилия на двоих в базе → ошибка с подсказкой «#номер». Ничего не пишется,
// пока разбор не прошёл целиком; на выходе — подробный отчёт.
import { ValidationError } from './validate.mjs';
import { normalizeName } from './registrations.mjs';
import { parseScore } from './groups.mjs';
import { bracketPlaces } from './brackets.mjs';
import { assertAgeAllowed } from './age.mjs';

const DASH = /\s+[—–-]\s+/;
const ROUND_OF = { '1/16': 32, '1/8': 16, '1/4': 8, '1/2': 4, 'финал': 2 };

function normScore(s) {
  // «6-2 6-3» → «6:2 6:3»; «/» между сетами → пробел; «отказ п/б» → «отказ»; «отказ» без номера = снялся проигравший
  return String(s || '').trim().replace(/п\/б/gi, '').replace(/(\d)-(\d)/g, '$1:$2').replace(/\//g, ' ').replace(/\s+/g, ' ').trim();
}

/** Разбор текста в структуру — без базы. */
export function parseTournamentText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const t = { name: '', start_date: null, end_date: null, city: '', category: 'B', judge: '', sections: [] };
  let cur = null;
  const kv = (line) => Object.fromEntries(line.split('|').map((p) => p.trim()).filter(Boolean).map((p) => { const m = /^([^:]+):\s*(.*)$/.exec(p); return m ? [m[1].trim().toLowerCase(), m[2].trim()] : ['', p]; }));
  for (const line of lines) {
    const low = line.toLowerCase();
    let m;
    if ((m = /^турнир:\s*(.+)$/i.exec(line))) { t.name = m[1].trim(); continue; }
    if ((m = /^даты?:\s*(.+)$/i.exec(line))) {
      const ds = m[1].match(/\d{4}-\d{2}-\d{2}/g) || [];
      if (!ds.length) throw new ValidationError(`Даты: нужен формат ГГГГ-ММ-ДД («${line}»)`);
      t.start_date = ds.length > 1 ? ds[0] : null; t.end_date = ds[ds.length - 1]; continue;
    }
    if (/^(город|категория|судья|место|организатор|контакт):/i.test(line)) {
      const o = kv(line);
      if (o['город']) t.city = o['город']; if (o['категория']) t.category = o['категория'].toUpperCase(); if (o['судья']) t.judge = o['судья'];
      if (o['место']) t.venue = o['место']; if (o['организатор']) t.organizer = o['организатор']; if (o['контакт']) t.organizer_contact = o['контакт'];
      continue;
    }
    if ((m = /^(сетка|группа|пары):\s*(.+)$/i.exec(line))) {
      const o = kv(m[2]); const title = (m[2].split('|')[0] || '').trim();
      const kindWord = m[1].toLowerCase();
      // РАЗРЯД РАЗДЕЛА (17.09.2026): «разряд: одиночный|парный|микст». Слово из названия
      // («Микст до 13», «Мужские пары») тоже считается — секретарю не надо помнить ключ.
      const discWord = String(o['разряд'] || '').toLowerCase();
      const mixedByName = /микст|смешан/i.test(title);
      const pairByName = /\bпар(ы|ный|ные)\b/i.test(title);
      const discipline = /микст|смешан/.test(discWord) || (!discWord && mixedByName) ? 'mixed'
        : /пар/.test(discWord) || (!discWord && pairByName) ? 'double'
        : /одиноч/.test(discWord) ? 'single' : null;
      cur = { type: kindWord === 'сетка' ? 'bracket' : kindWord === 'группа' ? 'group' : 'pairs', title, sex: (o['пол'] || '').toUpperCase() || null, age: o['возраст'] || null, discipline, matches: [], places: [] };
      t.sections.push(cur); continue;
    }
    if (!cur) throw new ValidationError(`Строка вне раздела: «${line}» — сначала «Сетка:», «Группа:» или «Пары:»`);
    if ((m = /^итог:\s*(.+)$/i.exec(line))) {
      for (const part of m[1].split(/[,;]\s*/)) {
        const pm = /^(\d+)(?:\s*место)?[\s.:-]+(.+)$/.exec(part.trim());
        if (pm) cur.places.push({ place: Number(pm[1]), who: pm[2].trim() });
      }
      continue;
    }
    // матч: [этап:] A — B [счёт] [→ победитель]
    let stage = null; let rest = line;
    const st = /^((?:1\/(?:16|8|4|2))|финал|3 место|за 3 место|предварительный(?: этап)?)\s*:\s*(.+)$/i.exec(line);
    if (st) { stage = st[1].toLowerCase().replace(/^за /, ''); rest = st[2]; }
    let winner = null;
    const arrow = rest.split(/\s*(?:→|->|=>)\s*/);
    if (arrow.length > 1) { winner = arrow[1].trim(); rest = arrow[0].trim(); }
    const sides = rest.split(DASH);
    if (sides.length < 2) throw new ValidationError(`Не разобрана строка матча: «${line}» (нужно «А — Б 6:3/6:4»)`);
    const a = sides[0].trim();
    const tail = sides.slice(1).join(' — ').trim();
    // счёт — хвост после имени: цифры/двоеточия/слэши/скобки/слова неявка,отказ,не сыгран
    const sm = /^(.*?)(?:\s+((?:\d{1,2}[:\-]\d{1,2}(?:\(\d+\))?[\s/]*)+(?:отказ(?:\s*п\/б)?\s*\d?|отк\.?\s*\d?)?|неявка(?:\s*\d)?|не сыгран(?:о)?|отказ(?:\s*п\/б)?|w\/o))?$/i.exec(tail);
    const b = (sm ? sm[1] : tail).trim(); const scoreRaw = sm && sm[2] ? sm[2].trim() : '';
    if (!b) throw new ValidationError(`Не разобран соперник в строке «${line}»`);
    if (/^не сыгран/i.test(scoreRaw) || (!scoreRaw && !winner)) { cur.matches.push({ stage, a, b, skipped: true }); continue; }
    cur.matches.push({ stage, a, b, score: scoreRaw, winner });
  }
  if (!t.sections.length) throw new ValidationError('Нет ни одного раздела «Сетка:» / «Группа:» / «Пары:»');
  return t;
}

const isBye = (s) => /^(x|х|—|-|bye|свободен)$/i.test(String(s).trim());

/** Переворот сетов: счёт в протоколе пишется с точки зрения ЛЕВОГО игрока строки. */
function flipSets(s) {
  return String(s).split(' ').map((x) => { const m = /^(\d{1,2}):(\d{1,2})(\(\d+\))?$/.exec(x); return m ? `${m[2]}:${m[1]}${m[3] || ''}` : x; }).join(' ');
}

/**
 * Применение: создаёт турнир (черновиком) ЛИБО дописывает разделы в существующий
 * (tournamentId), одной транзакцией. Возвращает отчёт.
 *
 * ДОЛИВКА (17.09.2026): раздел с тем же названием и разрядом дополняется — уже
 * записанные пары не трогаются, дописываются недостающие. Так протокол, пришедший
 * позже (финалы, парные сетки, микст), ложится в тот же турнир, а не в дубль.
 */
export function importTournament(db, text, { userId = null, tournamentId = null } = {}) {
  const t = parseTournamentText(text);
  let target = null;
  if (tournamentId) {
    target = db.prepare('SELECT id, name, city, end_date FROM tournaments WHERE id = ?').get(tournamentId);
    if (!target) throw new ValidationError('Турнир для дополнения не найден');
  } else {
    if (!t.name) throw new ValidationError('Нет строки «Турнир: название»');
    if (!t.end_date) throw new ValidationError('Нет строки «Даты: ГГГГ-ММ-ДД»');
    if (!['A', 'B', 'C'].includes(t.category)) throw new ValidationError('Категория — A, B или C');
  }
  const city = (target ? target.city : t.city) || t.city || 'Смоленская область';
  const playedOn = t.end_date || (target ? target.end_date : null);
  const report = { players_created: [], warnings: [], sections: [], appended: Boolean(tournamentId) };
  // Имена, уже встреченные в ЭТОМ импорте: «Захарян К.» и «Захарян» в поздних кругах — тот же
  // человек, что «Захарян Кристина» в первом. Сначала ищем среди них, потом в базе.
  const seen = new Map(); // normalizeName(полное) → id
  const matchShort = (shortKey, fullKey) => {
    const [sur, ini] = shortKey.split(' '); const [fsur, fname] = fullKey.split(' ');
    if (sur !== fsur) return false;
    if (!ini) return true; // голая фамилия
    return Boolean(fname) && fname.startsWith(ini.replace(/\.$/, ''));
  };
  const findOrCreate = (raw, sex) => {
    const name = String(raw).trim().replace(/\s+/g, ' ');
    const key = normalizeName(name);
    const isShort = !/\s/.test(key) || /^\S+\s\S{1,2}\.?$/.test(name.replace(/\s+/g, ' ')) && key.split(' ')[1].length <= 2;
    if (seen.has(key)) return seen.get(key);
    if (isShort) {
      const cands = [...seen.entries()].filter(([k]) => matchShort(key, k));
      if (cands.length === 1) return cands[0][1];
      if (cands.length > 1) throw new ValidationError(`«${name}»: в этом протоколе несколько подходящих — ${cands.map(([k]) => k).join(', ')}; напишите имя полностью`);
    }
    const all = db.prepare('SELECT id, full_name, city FROM players WHERE anonymized_at IS NULL').all();
    let found = all.filter((p) => normalizeName(p.full_name) === key);
    if (!found.length && isShort) found = all.filter((p) => matchShort(key, normalizeName(p.full_name)));
    if (found.length > 1) throw new ValidationError(`«${name}»: в базе несколько игроков — ${found.map((p) => `#${p.id} ${p.full_name} (${p.city || '—'})`).join(', ')}; укажите «#номер»`);
    const idm = /^#(\d+)$/.exec(name);
    if (idm) return Number(idm[1]);
    if (found.length === 1) { seen.set(normalizeName(found[0].full_name), found[0].id); return found[0].id; }
    if (isShort) report.warnings.push(`«${name}»: заведён без имени — дозаполните в «Игроках»`);
    // ВОЗМОЖНЫЙ ДУБЛЬ: в базе есть «Фамилия Имя Отчество», а в протоколе — «Фамилия Имя».
    // Точное сравнение их не связывает, и появляется вторая карточка того же человека.
    // Молча склеивать нельзя (тёзки), поэтому предупреждаем и показываем номер.
    const prefix = all.filter((p) => {
      const n = normalizeName(p.full_name);
      return n !== key && (n.startsWith(`${key} `) || key.startsWith(`${n} `));
    });
    if (prefix.length) {
      report.warnings.push(
        `«${name}»: возможно, это уже заведённый игрок ${prefix.map((p) => `#${p.id} ${p.full_name}`).join(', ')} — сверьте и объедините вручную`,
      );
    }
    // ПОЛ В МИКСТЕ. Раздел микста помечен «пол: X», и раньше такой игрок молча
    // становился мужчиной (sex || 'M'). Пробуем определить по окончанию фамилии —
    // для русских фамилий это надёжно, — а когда не выходит, предупреждаем.
    let useSex = sex;
    if (!useSex || useSex === 'X') {
      const surname = normalizeName(name).split(' ')[0] || '';
      if (/(ова|ева|ёва|ина|ына|ская|цкая|ая)$/.test(surname)) useSex = 'F';
      else if (/(ов|ев|ёв|ин|ын|ский|цкий|ый|ий|ко|ук|юк|ич)$/.test(surname)) useSex = 'M';
      else {
        useSex = 'M';
        report.warnings.push(`«${name}»: пол не определяется по фамилии, записан «мужской» — проверьте в «Игроках»`);
      }
    }
    const id = Number(db.prepare('INSERT INTO players (full_name, city, sex) VALUES (?, ?, ?)').run(name, city, useSex).lastInsertRowid);
    report.players_created.push({ id, name });
    seen.set(key, id);
    return id;
  };
  /** Как пара записана строкой — для сверки имени победителя в «3 место». */
  const entrantLabel = (raw) => String(raw).split(/\s*(?:\/|\s+и\s+)\s*/).map((x) => x.trim()).filter(Boolean).join(' / ');
  /** «Иванов / Петров» → {playerId, partnerId}; одиночный разряд — один игрок.
   *  Возраст сверяется с ограничением турнира: протокол не должен заносить в
   *  детскую сетку взрослого (у кого дата рождения не заполнена — пропускается). */
  const entrantOf = (raw, kind, sex) => {
    const parts = String(raw).split(/\s*(?:\/|\s+и\s+)\s*/).map((x) => x.trim()).filter(Boolean);
    if (kind === 'double') {
      if (parts.length !== 2) throw new ValidationError(`Пара записывается как «Фамилия / Фамилия», получено «${String(raw).trim()}»`);
      return { playerId: findOrCreate(parts[0], sex), partnerId: findOrCreate(parts[1], sex) };
    }
    return { playerId: findOrCreate(parts[0], sex), partnerId: null };
  };
  const checkedAge = new Set();
  const entrantChecked = (raw, kind, sex, tid) => {
    const e = entrantOf(raw, kind, sex);
    for (const id of [e.playerId, e.partnerId].filter(Boolean)) {
      if (checkedAge.has(id)) continue;
      assertAgeAllowed(db, tid, [id], { ValidationError });
      checkedAge.add(id);
    }
    return e;
  };

  const runAll = db.transaction(() => {
    const tid = target ? target.id : Number(db.prepare('INSERT INTO tournaments (name, start_date, end_date, category, city, kind, venue, organizer, organizer_contact, is_published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .run(t.name, t.start_date, t.end_date, t.category, t.city || null, /первенств|чемпионат/i.test(t.name) ? 'championship' : 'other', t.venue || null, t.organizer || null, t.judge ? `Главный судья: ${t.judge}` : (t.organizer_contact || null)).lastInsertRowid);
    const slotAt = (bid, r, pos) => db.prepare('SELECT player_id, partner_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(bid, r, pos) || null;
    const nameOf = (id) => db.prepare('SELECT full_name FROM players WHERE id = ?').get(id)?.full_name || `#${id}`;
    const slotLabel = (sl) => (sl ? nameOf(sl.player_id) + (sl.partner_id ? ` / ${nameOf(sl.partner_id)}` : '') : '—');

    for (const s of t.sections) {
      const sec = { title: s.title, type: s.type, matches: 0, places: 0, reused: false };
      // Пол раздела: «X» (микст) НЕ схлопываем в мужской — findOrCreate определит его
      // по фамилии каждого игрока отдельно.
      const sex = s.sex === 'F' ? 'F' : s.sex === 'X' ? 'X' : 'M';
      // Разряд ЗАЧЁТА раздела: «разряд: …» либо название; для «Пары:» по умолчанию парный,
      // для сеток и групп — одиночный.
      const disc = s.discipline || (s.type === 'pairs' ? 'double' : 'single');
      const kind = disc === 'single' ? 'single' : 'double';
      sec.discipline = disc;

      if (s.type === 'group') {
        let g = db.prepare('SELECT id, name, kind, discipline FROM tournament_groups WHERE tournament_id = ? AND kind = ?').all(tid, kind)
          .find((x) => normalizeName(x.name) === normalizeName(s.title));
        if (g) sec.reused = true;
        else {
          const gid = Number(db.prepare('INSERT INTO tournament_groups (tournament_id, name, kind, discipline) VALUES (?, ?, ?, ?)').run(tid, s.title.slice(0, 40), kind, disc).lastInsertRowid);
          g = { id: gid, name: s.title, kind, discipline: disc };
        }
        const members = new Map();
        const memberId = (n) => {
          if (!members.has(n)) {
            const e = entrantChecked(n, kind, sex, tid); members.set(n, e);
            db.prepare('INSERT OR IGNORE INTO tournament_group_members (group_id, player_id, seed) VALUES (?, ?, ?)').run(g.id, e.playerId, members.size + 1);
            if (e.partnerId) db.prepare('INSERT OR IGNORE INTO tournament_group_members (group_id, player_id, seed) VALUES (?, ?, ?)').run(g.id, e.partnerId, members.size + 1);
          }
          return members.get(n);
        };
        for (const m of s.matches) {
          const a = memberId(m.a); const b = memberId(m.b);
          if (m.skipped) continue;
          const sc = normScore(m.score);
          let parsed; try { parsed = parseScore(sc); } catch (e) { throw new ValidationError(`${s.title}: ${m.a} — ${m.b}: ${e.message}`); }
          const rowWon = m.winner ? normalizeName(m.winner) === normalizeName(m.a) || (!/\s/.test(normalizeName(m.winner)) && normalizeName(m.a).split(' ')[0] === normalizeName(m.winner)) : parsed.rowWon;
          const w = rowWon ? a : b; const l = rowWon ? b : a;
          const score = rowWon === parsed.rowWon ? parsed.score : parseScore(flipSets(sc)).score;
          if (db.prepare('SELECT 1 FROM matches WHERE tournament_id = ? AND stage = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))').get(tid, `g:${g.id}`, w.playerId, l.playerId, l.playerId, w.playerId)) continue;
          db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, winner_partner_id, loser_partner_id, played_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(tid, w.playerId, l.playerId, score, kind, `g:${g.id}`, w.partnerId, l.partnerId, playedOn);
          sec.matches++;
        }
      } else if (s.type === 'bracket') {
        const rounds = s.matches.filter((m) => m.stage && ROUND_OF[m.stage]);
        const first = rounds.length ? Math.max(...rounds.map((m) => ROUND_OF[m.stage])) : 0;
        let b = db.prepare('SELECT id, name, kind, discipline, size FROM tournament_brackets WHERE tournament_id = ? AND kind = ?').all(tid, kind)
          .find((x) => normalizeName(x.name) === normalizeName(s.title));
        if (b) sec.reused = true;
        else {
          if (!first) throw new ValidationError(`${s.title}: в сетке нет строк «1/4:», «1/2:», «Финал:»`);
          const bid = Number(db.prepare('INSERT INTO tournament_brackets (tournament_id, name, kind, discipline, size) VALUES (?, ?, ?, ?, ?)').run(tid, s.title.slice(0, 40), kind, disc, first).lastInsertRowid);
          b = { id: bid, name: s.title, kind, discipline: disc, size: first };
        }
        const size = b.size;
        if (first && first > size) throw new ValidationError(`${s.title}: сетка на сайте на ${size}, а в протоколе круг на ${first}`);
        const R = Math.log2(size);
        // ПОСЕВ первого круга — по порядку строк первого круга протокола. Занятый слот
        // сверяется: расхождение — стоп, чтобы доливка не перекроила чужую сетку.
        const firstRound = s.matches.filter((m) => m.stage && ROUND_OF[m.stage] === size);
        const putSlot = (pos, raw) => {
          if (isBye(raw)) return;
          const e = entrantChecked(raw, kind, sex, tid);
          const have = slotAt(b.id, 0, pos);
          if (have) {
            if (have.player_id !== e.playerId || (have.partner_id || null) !== (e.partnerId || null)) {
              throw new ValidationError(`${s.title}: позиция ${pos + 1} занята — на сайте «${slotLabel(have)}», в протоколе «${raw}»`);
            }
            return;
          }
          if (db.prepare('SELECT 1 FROM bracket_slots WHERE bracket_id = ? AND (player_id = ? OR partner_id = ?)').get(b.id, e.playerId, e.playerId)) return;
          db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id, partner_id) VALUES (?, 0, ?, ?, ?)').run(b.id, pos, e.playerId, e.partnerId);
        };
        firstRound.forEach((m, k) => { putSlot(2 * k, m.a); putSlot(2 * k + 1, m.b); });
        // Свободная позиция первого круга: единственный игрок пары проходит дальше.
        for (let k = 0; k < size / 2; k++) {
          const a = slotAt(b.id, 0, 2 * k); const c = slotAt(b.id, 0, 2 * k + 1);
          if (((a ? 1 : 0) + (c ? 1 : 0)) === 1 && !slotAt(b.id, 1, k)) {
            const who = a || c;
            db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id, partner_id) VALUES (?, 1, ?, ?, ?)').run(b.id, k, who.player_id, who.partner_id);
          }
        }
        // МАТЧИ по кругам: пара ищется по тем, кто реально стоит в слотах.
        for (let r = 0; r < R; r++) {
          const roundMatches = s.matches.filter((m) => m.stage && ROUND_OF[m.stage] === size / 2 ** r);
          for (let k = 0; k < size / 2 ** (r + 1); k++) {
            const A = slotAt(b.id, r, 2 * k); const C = slotAt(b.id, r, 2 * k + 1);
            if (!A && !C) continue;
            if (!A || !C) { if (r > 0) report.warnings.push(`${s.title}: круг ${r + 1}, пара ${k + 1} — соперник не определён (предыдущая пара не сыграна)`); continue; }
            if (slotAt(b.id, r + 1, k)) continue; // итог уже записан — доливка его не трогает
            const m = roundMatches.find((x) => {
              const ids = [x.a, x.b].filter((n) => !isBye(n)).map((n) => entrantOf(n, kind, sex).playerId);
              return ids.includes(A.player_id) && ids.includes(C.player_id);
            });
            if (!m || m.skipped) { report.warnings.push(`${s.title}: пара ${r === R - 1 ? 'финала' : 'круга ' + (r + 1)} не сыграна — сетка оставлена открытой`); continue; }
            const aId = isBye(m.a) ? null : entrantOf(m.a, kind, sex).playerId;
            const sc = normScore(m.score);
            let parsed = null;
            if (sc) { try { parsed = parseScore(sc); } catch (e) { throw new ValidationError(`${s.title}: ${m.a} — ${m.b}: ${e.message}`); } }
            // Победитель — из «→», иначе по счёту. Счёт в строке — с точки зрения ЛЕВОГО
            // участника, поэтому «6:4 5:2 отказ → Костылев» значит «вёл, но снялся».
            const winnerId = m.winner ? entrantOf(m.winner, kind, sex).playerId : (parsed ? (parsed.rowWon ? aId : (aId === A.player_id ? C.player_id : A.player_id)) : null);
            if (!winnerId || ![A.player_id, C.player_id].includes(winnerId)) throw new ValidationError(`${s.title}: не понял, кто выиграл пару ${m.a} — ${m.b}`);
            const W = winnerId === A.player_id ? A : C;
            const L = W === A ? C : A;
            // Счёт хранится ОТ ПОБЕДИТЕЛЯ: если победил не левый — переворачиваем сеты.
            const winnerIsA = winnerId === aId;
            const score = parsed ? ((winnerIsA === parsed.rowWon) ? parsed.score : parseScore(flipSets(sc)).score) : null;
            if (!score) report.warnings.push(`${s.title}: ${m.a} — ${m.b}: счёта в протоколе нет, записан только победитель`);
            db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, winner_partner_id, loser_partner_id, played_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .run(tid, W.player_id, L.player_id, score, kind, `b:${b.id}`, W.partner_id, L.partner_id, playedOn);
            db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id, partner_id) VALUES (?, ?, ?, ?, ?)').run(b.id, r + 1, k, W.player_id, W.partner_id);
            sec.matches++;
          }
        }
        // МЕСТА: только при сыгранном финале. Матч за 3 место — отдельным матчем, места 3/4.
        const champion = slotAt(b.id, R, 0);
        const third = s.matches.find((m) => m.stage === '3 место' && !m.skipped);
        // Пересчитываем места, только если раздел что-то внёс либо мест ещё нет: повторная
        // доливка того же текста не должна перетирать 3/4, расставленные матчем за 3 место.
        const hadPlaces = db.prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ? AND discipline = ? AND player_id IN (SELECT player_id FROM bracket_slots WHERE bracket_id = ?)').get(tid, disc, b.id).n;
        if (champion && (sec.matches > 0 || !hadPlaces)) {
          sec.places += bracketPlaces(db, tid, b.id);
          if (third) {
            // Победитель — из «→», иначе по счёту (слева победитель, как в остальных строках).
            const thirdScore = normScore(third.score);
            const aWon = third.winner
              ? normalizeName(third.winner) === normalizeName(third.a) || normalizeName(entrantLabel(third.a)) === normalizeName(third.winner)
              : (thirdScore ? parseScore(thirdScore).rowWon : true);
            const W = entrantOf(aWon ? third.a : third.b, kind, sex);
            const L = entrantOf(aWon ? third.b : third.a, kind, sex);
            const sc = thirdScore ? (aWon === (parseScore(thirdScore).rowWon) ? parseScore(thirdScore).score : parseScore(flipSets(thirdScore)).score) : null;
            const already = db.prepare("SELECT 1 FROM matches WHERE tournament_id = ? AND stage = 'manual' AND kind = ? AND ((winner_player_id = ? AND loser_player_id = ?) OR (winner_player_id = ? AND loser_player_id = ?))").get(tid, kind, W.playerId, L.playerId, L.playerId, W.playerId);
            if (!already) {
              db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, winner_partner_id, loser_partner_id, played_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
                .run(tid, W.playerId, L.playerId, sc, kind, 'manual', W.partnerId, L.partnerId, playedOn);
              sec.matches++;
            }
            const put = db.prepare('INSERT OR REPLACE INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, ?)');
            const wipe = db.prepare('DELETE FROM results WHERE tournament_id = ? AND player_id = ? AND discipline = ?');
            for (const id of [W.playerId, W.partnerId].filter(Boolean)) { wipe.run(tid, id, disc); put.run(tid, id, 3, disc); sec.places++; }
            for (const id of [L.playerId, L.partnerId].filter(Boolean)) { wipe.run(tid, id, disc); put.run(tid, id, 4, disc); sec.places++; }
          }
        } else if (s.places.length) {
          // Финал не в протоколе, но итог известен (например, из публикации) — места из «Итог:».
          const ins = db.prepare('INSERT OR REPLACE INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, ?)');
          for (const pl of s.places) for (const n of pl.who.split('/').map((x) => x.trim()).filter(Boolean)) { ins.run(tid, entrantChecked(n, 'single', sex, tid).playerId, pl.place, disc); sec.places++; }
          report.warnings.push(`${s.title}: финал не сыгран в протоколе — места взяты из строки «Итог»`);
        } else report.warnings.push(`${s.title}: финал не сыгран — места не записаны`);
      } else { // pairs — только итоговые места
        const ins = db.prepare('INSERT OR REPLACE INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, ?)');
        for (const pl of s.places) {
          for (const n of pl.who.split('/').map((x) => x.trim()).filter(Boolean)) { ins.run(tid, entrantChecked(n, 'single', sex, tid).playerId, pl.place, disc); sec.places++; }
        }
        if (!s.places.length) report.warnings.push(`${s.title}: для парного разряда нужна строка «Итог: 1 А/Б, 2 В/Г …»`);
      }
      report.sections.push(sec);
    }
    return tid;
  });
  const tid = runAll();
  return { tournamentId: tid, ...report, players_created_count: report.players_created.length };
}
