// РАЗРЯДЫ ПО ПРИКАЗУ — массовое внесение (17.10.2026). Секретарь вставляет список ФИО из
// приказа Минспорта (по строке), выбирает разряд, номер и дату приказа, срок действия.
// Сопоставление: «фамилия + имя» совпали ровно с одной карточкой — разряд ей (и, если в
// карточке нет отчества, ФИО дополняется полным из приказа). Нет совпадения — новая карточка
// (пол — по отчеству). Сомнительное (несколько карточек, карточка с одной фамилией) — НЕ
// трогается, а показывается в отчёте: решает секретарь. Режим «только проверить» ничего не пишет.
import { normalizeName } from './registrations.mjs';
import { SPORT_RANKS } from './sport-rank.mjs';

const stem = (n) => normalizeName(n).split(' ').slice(0, 2).join(' ');
const surname = (n) => normalizeName(n).split(' ')[0];

function sexByPatronymic(full) {
  const parts = String(full).trim().split(/\s+/);
  const mid = (parts[2] || '').toLowerCase();
  if (/(вич|ич)$/.test(mid)) return 'M';
  if (/(вна|чна|шна|кызы)$/.test(mid)) return 'F';
  return null;
}

/** План без записи: [{ name, action: 'update'|'create'|'skip', playerId?, note }]. */
export function planRanks(db, text) {
  const players = db.prepare('SELECT id, full_name, sex FROM players WHERE anonymized_at IS NULL').all();
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.map((name) => {
    const parts = name.split(' ');
    if (parts.length < 2) return { name, action: 'skip', note: 'нужны хотя бы фамилия и имя' };
    const same = players.filter((p) => stem(p.full_name) === stem(name) && normalizeName(p.full_name).split(' ').length >= 2);
    if (same.length === 1) {
      const p = same[0];
      const upgrade = normalizeName(p.full_name).split(' ').length < parts.length;
      return { name, action: 'update', playerId: p.id, fullName: upgrade ? name : p.full_name, note: `#${p.id} ${p.full_name}${upgrade ? ' → ФИО дополнится отчеством' : ''}` };
    }
    if (same.length > 1) return { name, action: 'skip', note: `несколько карточек: ${same.map((p) => `#${p.id} ${p.full_name}`).join(', ')} — внесите в нужную вручную` };
    const bare = players.filter((p) => normalizeName(p.full_name) === surname(name));
    if (bare.length) return { name, action: 'skip', note: `есть карточка только с фамилией: ${bare.map((p) => `#${p.id} ${p.full_name}`).join(', ')} — если это он(а), дополните имя в карточке и повторите` };
    const sex = sexByPatronymic(name);
    if (!sex) return { name, action: 'skip', note: 'не удалось определить пол по отчеству — добавьте игрока вручную' };
    return { name, action: 'create', sex, note: `новая карточка (${sex === 'M' ? 'муж.' : 'жен.'}, город — ${'Смоленск'})` };
  });
}

/** Применить план; rank — { sport_rank, sport_rank_order, sport_rank_date, sport_rank_until }. */
export function applyRanks(db, plan, rank, { city = 'Смоленск' } = {}) {
  if (!SPORT_RANKS.some((r) => r.id === rank.sport_rank)) throw new Error('Неизвестный разряд');
  const upd = db.prepare('UPDATE players SET full_name = ?, sport_rank = ?, sport_rank_order = ?, sport_rank_date = ?, sport_rank_until = ? WHERE id = ?');
  const ins = db.prepare('INSERT INTO players (full_name, city, sex, sport_rank, sport_rank_order, sport_rank_date, sport_rank_until) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const done = { updated: 0, created: 0, skipped: 0, ids: [] };
  db.transaction(() => {
    for (const row of plan) {
      if (row.action === 'update') {
        upd.run(row.fullName, rank.sport_rank, rank.sport_rank_order, rank.sport_rank_date, rank.sport_rank_until, row.playerId);
        done.updated += 1; done.ids.push(row.playerId);
      } else if (row.action === 'create') {
        const info = ins.run(row.name, city, row.sex, rank.sport_rank, rank.sport_rank_order, rank.sport_rank_date, rank.sport_rank_until);
        done.created += 1; done.ids.push(Number(info.lastInsertRowid));
      } else done.skipped += 1;
    }
  })();
  return done;
}
