// ОБЪЕДИНЕНИЕ ДВУХ КАРТОЧЕК ОДНОГО ЧЕЛОВЕКА (19.09.2026). Причина боем: заявка на
// регистрацию «коротков олег» одобрена «новым игроком» — сайт завёл #111 и повесил на
// него кабинет, а результаты и рейтинг остались на #2 «Коротков Олег Александрович».
// До этого дубли сливали командой в терминале (11.09) — и та команда забыла кабинет,
// согласия и фото. Здесь переезжает ВСЁ, что ссылается на карточку, одним делом.
//
// keep — карточка, которая остаётся; drop — дубль, который после переноса удаляется.
import { eraseConsents, withConsentErasure } from './consent-journal.mjs';

const LINK_COLUMNS = [
  // [таблица, колонка, уникальность, по которой возможен конфликт с keep]
  ['results', 'player_id', ['tournament_id', 'discipline']],
  ['matches', 'winner_player_id', null],
  ['matches', 'loser_player_id', null],
  ['matches', 'winner_partner_id', null],
  ['matches', 'loser_partner_id', null],
  ['tournament_voids', 'a', null],
  ['tournament_voids', 'b', null],
  ['tournament_group_members', 'player_id', ['group_id']],
  ['bracket_slots', 'player_id', null],
  ['bracket_slots', 'partner_id', null],
  ['registrations', 'player_id', null],
  ['guardian_wards', 'player_id', ['guardian_id']],
  ['coaches', 'player_id', null],
];

/** Что переедет — для подтверждения секретарю перед слиянием. */
export function mergePreview(db, keepId, dropId) {
  const keep = db.prepare('SELECT * FROM players WHERE id = ?').get(keepId);
  const drop = db.prepare('SELECT * FROM players WHERE id = ?').get(dropId);
  if (!keep || !drop) throw new Error('Одна из карточек не найдена');
  if (keepId === dropId) throw new Error('Нельзя объединить карточку саму с собой');
  if (keep.anonymized_at || drop.anonymized_at) throw new Error('Обезличенную карточку объединять нельзя');
  const count = (table, col) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(dropId).n;
  const account = db.prepare('SELECT id FROM player_accounts WHERE player_id = ?');
  return {
    keep, drop,
    results: count('results', 'player_id'),
    matches: db.prepare('SELECT COUNT(*) AS n FROM matches WHERE winner_player_id = ? OR loser_player_id = ? OR winner_partner_id = ? OR loser_partner_id = ?').get(dropId, dropId, dropId, dropId).n,
    consents: count('consents', 'player_id'),
    accountDrop: Boolean(account.get(dropId)), accountKeep: Boolean(account.get(keepId)),
    photoDrop: Boolean(drop.photo_upload_id), photoKeep: Boolean(keep.photo_upload_id),
  };
}

/**
 * Само слияние — одна транзакция. Возвращает сводку. Бросает, если у ОБЕИХ карточек есть
 * кабинет: два входа не сложить в один, секретарь сперва решает, какой оставить.
 */
export function mergePlayers(db, keepId, dropId) {
  const p = mergePreview(db, keepId, dropId);
  if (p.accountDrop && p.accountKeep) throw new Error(`У обеих карточек есть кабинет (#${keepId} и #${dropId}) — сначала удалите лишний кабинет, потом объединяйте`);
  const summary = { moved: {}, skippedDuplicates: {}, consentsCopied: 0, accountMoved: false, photoMoved: false };
  const run = db.transaction(() => {
    for (const [table, col, uniq] of LINK_COLUMNS) {
      let skipped = 0;
      if (uniq) {
        // Строка дубля, у которой в keep уже есть пара по уникальному ключу, — лишняя: keep главнее.
        const rows = db.prepare(`SELECT rowid AS rid, ${uniq.join(', ')} FROM ${table} WHERE ${col} = ?`).all(dropId);
        for (const r of rows) {
          const where = uniq.map((c) => `${c} IS ?`).join(' AND ');
          const clash = db.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ? AND ${where}`).get(keepId, ...uniq.map((c) => r[c]));
          if (clash) { db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(r.rid); skipped++; }
        }
      }
      const moved = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(keepId, dropId).changes;
      summary.moved[`${table}.${col}`] = moved;
      if (skipped) summary.skippedDuplicates[`${table}.${col}`] = skipped;
    }
    // Кабинет: UNIQUE(player_id) — перевешиваем целиком, вход и пароль сохраняются.
    if (p.accountDrop && !p.accountKeep) {
      db.prepare('UPDATE player_accounts SET player_id = ? WHERE player_id = ?').run(keepId, dropId);
      summary.accountMoved = true;
    }
    // Согласия: журнал неизменяем (триггер), поэтому на keep пишутся НОВЫЕ строки с тем же
    // содержанием и основанием «перенос при объединении»; строки дубля уйдут вместе с ним.
    const consents = db.prepare('SELECT * FROM consents WHERE player_id = ? ORDER BY id').all(dropId);
    const ins = db.prepare(`INSERT INTO consents (player_id, registration_id, guardian_id, subject_ref, kind, event, legal_version, source, basis, document_date, ip, at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?, NULL, ?)`);
    for (const c of consents) {
      ins.run(keepId, c.registration_id, c.guardian_id, c.subject_ref, c.kind, c.event, c.legal_version,
        `Перенос при объединении карточек #${dropId} → #${keepId}${c.basis ? '; было: ' + c.basis : ''}`, c.document_date || c.at.slice(0, 10), c.at);
      summary.consentsCopied++;
    }
    // Поля карточки: keep главнее, пустое заполняем из дубля. Фото — только если у keep нет.
    const fields = ['city', 'sex', 'birth_date', 'age_group', 'rni', 'photo_upload_id', 'is_public'];
    const have = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
    for (const f of fields.filter((x) => have.includes(x))) {
      if (f === 'photo_upload_id' && p.photoKeep) continue;
      db.prepare(`UPDATE players SET ${f} = COALESCE(${f}, (SELECT ${f} FROM players WHERE id = ?)) WHERE id = ? AND ${f} IS NULL`).run(dropId, keepId);
      if (f === 'photo_upload_id' && !p.photoKeep && p.photoDrop) {
        // Файл теперь принадлежит keep; у дубля ссылку снимаем, чтобы его удаление не унесло файл.
        db.prepare('UPDATE players SET photo_upload_id = NULL WHERE id = ?').run(dropId);
        summary.photoMoved = true;
      }
    }
    // Дубль — прочь, штатным путём удаления игрока (ворота журнала согласий открыты явно).
    eraseConsents(db, dropId);
    withConsentErasure(db, () => db.prepare('DELETE FROM players WHERE id = ?').run(dropId));
  });
  run();
  return summary;
}
