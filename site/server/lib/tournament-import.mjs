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
// Игрок задаётся фамилией (и инициалом/именем, если есть): «Антонов», «Адаева И.», «Иванов Иван».
// Незнакомый заводится с полом раздела и городом турнира, дата рождения — пустая (секретарь
// дозаполнит). Одна фамилия на двоих в базе → ошибка с подсказкой «#номер». Ничего не пишется,
// пока разбор не прошёл целиком; на выходе — подробный отчёт.
import { ValidationError } from './validate.mjs';
import { normalizeName } from './registrations.mjs';
import { parseScore } from './groups.mjs';
import { seedOrder } from './brackets.mjs';

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
      cur = { type: kindWord === 'сетка' ? 'bracket' : kindWord === 'группа' ? 'group' : 'pairs', title, sex: (o['пол'] || '').toUpperCase() || null, age: o['возраст'] || null, matches: [], places: [] };
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
    if (/^не сыгран/i.test(scoreRaw) || (!scoreRaw && !winner && cur.type !== 'bracket')) { cur.matches.push({ stage, a, b, skipped: true }); continue; }
    cur.matches.push({ stage, a, b, score: scoreRaw, winner });
  }
  if (!t.name) throw new ValidationError('Нет строки «Турнир: название»');
  if (!t.end_date) throw new ValidationError('Нет строки «Даты: ГГГГ-ММ-ДД»');
  if (!['A', 'B'].includes(t.category)) throw new ValidationError('Категория — A или B');
  if (!t.sections.length) throw new ValidationError('Нет ни одного раздела «Сетка:» / «Группа:» / «Пары:»');
  return t;
}

const isBye = (s) => /^(x|х|—|-|bye|свободен)$/i.test(String(s).trim());

/** Применение: создаёт турнир (черновик) и всё содержимое одной транзакцией. Возвращает отчёт. */
export function importTournament(db, text, { userId = null } = {}) {
  const t = parseTournamentText(text);
  const report = { players_created: [], warnings: [], sections: [] };
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
    const id = Number(db.prepare('INSERT INTO players (full_name, city, sex) VALUES (?, ?, ?)').run(name, t.city || 'Смоленская область', sex || 'M').lastInsertRowid);
    report.players_created.push({ id, name });
    seen.set(key, id);
    return id;
  };
  const runAll = db.transaction(() => {
    const tid = Number(db.prepare('INSERT INTO tournaments (name, start_date, end_date, category, city, kind, venue, organizer, organizer_contact, is_published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)')
      .run(t.name, t.start_date, t.end_date, t.category, t.city || null, /первенств|чемпионат/i.test(t.name) ? 'championship' : 'other', t.venue || null, t.organizer || null, t.judge ? `Главный судья: ${t.judge}` : (t.organizer_contact || null)).lastInsertRowid);
    for (const s of t.sections) {
      const sec = { title: s.title, type: s.type, matches: 0, places: 0 };
      const sex = s.sex === 'F' ? 'F' : 'M';
      if (s.type === 'group') {
        const gid = Number(db.prepare('INSERT INTO tournament_groups (tournament_id, name, kind) VALUES (?, ?, ?)').run(tid, s.title.slice(0, 40), 'single').lastInsertRowid);
        const members = new Map();
        const memberId = (n) => { if (!members.has(n)) { const id = findOrCreate(n, sex); members.set(n, id); db.prepare('INSERT OR IGNORE INTO tournament_group_members (group_id, player_id, seed) VALUES (?, ?, ?)').run(gid, id, members.size + 1); } return members.get(n); };
        for (const m of s.matches) {
          const a = memberId(m.a); const b = memberId(m.b);
          if (m.skipped) continue;
          const sc = normScore(m.score) || (m.winner ? 'неявка 2' : '');
          let parsed; try { parsed = parseScore(sc); } catch (e) { throw new ValidationError(`${s.title}: ${m.a} — ${m.b}: ${e.message}`); }
          const rowWon = m.winner ? normalizeName(m.winner) === normalizeName(m.a) || (!/\s/.test(normalizeName(m.winner)) && normalizeName(m.a).split(' ')[0] === normalizeName(m.winner)) : parsed.rowWon;
          const w = rowWon ? a : b; const l = rowWon ? b : a;
          const score = rowWon === parsed.rowWon ? parsed.score : parseScore(sc.split(' ').map((x) => { const mm = /^(\d+):(\d+)(\(\d+\))?$/.exec(x); return mm ? `${mm[2]}:${mm[1]}${mm[3] || ''}` : x; }).join(' ')).score;
          db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, played_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tid, w, l, score, 'single', `g:${gid}`, t.end_date);
          sec.matches++;
        }
      } else if (s.type === 'bracket') {
        const rounds = s.matches.filter((m) => m.stage && ROUND_OF[m.stage]);
        const first = rounds.length ? Math.max(...rounds.map((m) => ROUND_OF[m.stage])) : 0;
        if (!first) throw new ValidationError(`${s.title}: в сетке нет строк «1/4:», «1/2:», «Финал:»`);
        const size = first;
        const bid = Number(db.prepare('INSERT INTO tournament_brackets (tournament_id, name, kind, size) VALUES (?, ?, ?, ?)').run(tid, s.title.slice(0, 40), 'single', size).lastInsertRowid);
        // Раунд 0 — пары первого круга по порядку строк
        const firstRound = s.matches.filter((m) => m.stage && ROUND_OF[m.stage] === size);
        const nameId = new Map();
        const pid = (n) => { if (isBye(n)) return null; if (!nameId.has(n)) nameId.set(n, findOrCreate(n, sex)); return nameId.get(n); };
        firstRound.forEach((m, k) => {
          const a = pid(m.a); const b = pid(m.b);
          if (a) db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, 0, ?, ?)').run(bid, 2 * k, a);
          if (b) db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, 0, ?, ?)').run(bid, 2 * k + 1, b);
        });
        const R = Math.log2(size);
        for (let r = 0; r < R; r++) {
          const roundMatches = s.matches.filter((m) => m.stage && ROUND_OF[m.stage] === size / 2 ** r);
          const pairsN = size / 2 ** (r + 1);
          for (let k = 0; k < pairsN; k++) {
            const a = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(bid, r, 2 * k)?.player_id || null;
            const b = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = ?').get(bid, r, 2 * k + 1)?.player_id || null;
            if (!a && !b) continue;
            if (!a || !b) {
              // Свободная позиция — только в первом круге (bye). Дальше пустой слот = недоигранная пара
              // предыдущего круга: никого не продвигаем, иначе игрок «выиграет» несыгранный матч.
              if (r === 0) db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, ?, ?, ?)').run(bid, r + 1, k, a || b);
              else report.warnings.push(`${s.title}: круг ${r + 1}, пара ${k + 1} — соперник не определён (предыдущая пара не сыграна)`);
              continue;
            }
            const m = roundMatches.find((x) => { const ids = [pid(x.a), pid(x.b)]; return ids.includes(a) && ids.includes(b); });
            if (!m || m.skipped) { report.warnings.push(`${s.title}: пара ${r === R - 1 ? 'финала' : 'круга ' + (r + 1)} не сыграна — сетка оставлена открытой`); continue; }
            const sc = normScore(m.score) || 'неявка 2';
            const aIsTop = pid(m.a) === a;
            let parsed; try { parsed = parseScore(sc); } catch (e) { throw new ValidationError(`${s.title}: ${m.a} — ${m.b}: ${e.message}`); }
            let winnerId = m.winner ? pid(m.winner) : (parsed.rowWon ? pid(m.a) : pid(m.b));
            if (![a, b].includes(winnerId)) throw new ValidationError(`${s.title}: победитель «${m.winner}» не из пары ${m.a} — ${m.b}`);
            const loserId = winnerId === a ? b : a;
            // счёт хранится от победителя: parsed.score уже «от победителя строки m.a»; если победитель m.b — перевернуть
            const winnerIsA = winnerId === pid(m.a);
            const score = (winnerIsA === parsed.rowWon) ? parsed.score : parseScore(sc.split(' ').map((x) => { const mm = /^(\d+):(\d+)(\(\d+\))?$/.exec(x); return mm ? `${mm[2]}:${mm[1]}${mm[3] || ''}` : x; }).join(' ')).score;
            db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, played_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tid, winnerId, loserId, score, 'single', `b:${bid}`, t.end_date);
            db.prepare('INSERT INTO bracket_slots (bracket_id, round, position, player_id) VALUES (?, ?, ?, ?)').run(bid, r + 1, k, winnerId);
            sec.matches++;
          }
        }
        // Матч за 3 место — отдельный матч, места 3/4
        const third = s.matches.find((m) => m.stage === '3 место');
        const champion = db.prepare('SELECT player_id FROM bracket_slots WHERE bracket_id = ? AND round = ? AND position = 0').get(bid, R)?.player_id;
        if (champion) {
          const rows = db.prepare('SELECT round, player_id FROM bracket_slots WHERE bracket_id = ?').all(bid);
          const maxRound = new Map(); for (const x of rows) maxRound.set(x.player_id, Math.max(maxRound.get(x.player_id) ?? -1, x.round));
          const ins = db.prepare('INSERT OR REPLACE INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, ?)');
          for (const [p, mr] of maxRound) { const lost = R - 1 - mr; ins.run(tid, p, p === champion ? 1 : lost === 0 ? 2 : 2 ** lost + 1, 'single'); sec.places++; }
          if (third && !third.skipped) {
            const a = pid(third.a); const b = pid(third.b); const sc = normScore(third.score) || 'неявка 2';
            const parsed = parseScore(sc); const winnerId = third.winner ? pid(third.winner) : (parsed.rowWon ? a : b); const loserId = winnerId === a ? b : a;
            const winnerIsA = winnerId === a;
            const score = (winnerIsA === parsed.rowWon) ? parsed.score : parseScore(sc.split(' ').map((x) => { const mm = /^(\d+):(\d+)(\(\d+\))?$/.exec(x); return mm ? `${mm[2]}:${mm[1]}${mm[3] || ''}` : x; }).join(' ')).score;
            db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, kind, stage, played_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(tid, winnerId, loserId, score, 'single', 'manual', t.end_date);
            ins.run(tid, winnerId, 3, 'single'); ins.run(tid, loserId, 4, 'single'); sec.matches++;
          }
        } else if (s.places.length) {
          // Финал не в протоколе, но итог известен (например, из публикации) — места из строки «Итог:».
          const ins = db.prepare('INSERT OR REPLACE INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, ?)');
          for (const pl of s.places) { ins.run(tid, findOrCreate(pl.who, sex), pl.place, 'single'); sec.places++; }
          report.warnings.push(`${s.title}: финал не сыгран в протоколе — места взяты из строки «Итог»`);
        } else report.warnings.push(`${s.title}: финал не сыгран — места не записаны`);
      } else { // pairs — только места
        const ins = db.prepare('INSERT OR REPLACE INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, ?)');
        for (const pl of s.places) {
          for (const n of pl.who.split('/').map((x) => x.trim()).filter(Boolean)) { ins.run(tid, findOrCreate(n, sex), pl.place, 'double'); sec.places++; }
        }
        if (!s.places.length) report.warnings.push(`${s.title}: для парного разряда нужна строка «Итог: 1 А/Б, 2 В/Г …»`);
      }
      report.sections.push(sec);
    }
    return tid;
  });
  const tournamentId = runAll();
  return { tournamentId, ...report, players_created_count: report.players_created.length };
}
