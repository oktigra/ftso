// ДНИ ТУРНИРА — ежедневная проверка (правила владельца 10.10.2026).
//
// 1. День открытия приёма заявок (entryOpens: A — за месяц до начала, B и C — за две
//    недели): организатору — письмо «загрузите документы» (runDocsOpenNotices), а
//    Федерации — информационное письмо, что по турниру открылся приём. Один раз.
// 2. «Заявка открыта» = к турниру загружен хотя бы один документ. Если ко дню начала
//    документов нет — турнир «не состоялся»: остаётся в календаре с этой меткой, в
//    рейтинг не идёт (результатов у него нет), Федерации и организатору — письмо.
//    Секретарь может снять метку (held_status = 'confirmed'), повторно она не ставится.
//
// Правило действует для турниров, начинающихся с NOT_HELD_FROM: у прошедших турниров
// документов в системе не было, хотя они состоялись. Турнир с результатами меткой не
// помечается никогда — результаты и есть доказательство, что он прошёл.
import { entryOpens } from './content.mjs';
import { runDocsOpenNotices } from './tournament-requests.mjs';
import { queueMail, mailEntryOpenStaff, mailTournamentNotHeld } from './mailer.mjs';
import { OPERATOR } from './legal.mjs';

export const NOT_HELD_FROM = '2026-10-10';

const todayIso = () => new Date().toISOString().slice(0, 10);

export function runEntryOpenStaffNotices(db, { now = todayIso() } = {}) {
  const rows = db
    .prepare(`SELECT id, name, category, city, start_date, end_date FROM tournaments
               WHERE is_published = 1 AND entry_open_notified_at IS NULL AND held_status IS NOT 'not_held'`)
    .all();
  let sent = 0;
  for (const t of rows) {
    const start = t.start_date || t.end_date;
    if (now < entryOpens(t) || now >= start) continue;
    db.transaction(() => {
      queueMail(db, { to: OPERATOR.email, kind: 'tournament.entry.open.staff', ...mailEntryOpenStaff(t) });
      db.prepare("UPDATE tournaments SET entry_open_notified_at = datetime('now') WHERE id = ?").run(t.id);
    })();
    sent += 1;
  }
  return sent;
}

export function runNotHeldCheck(db, { now = todayIso() } = {}) {
  const rows = db
    .prepare(`SELECT t.id, t.name, t.category, t.city, t.start_date, t.end_date FROM tournaments t
               WHERE t.is_published = 1 AND t.held_status IS NULL
                 AND COALESCE(t.start_date, t.end_date) <= ? AND COALESCE(t.start_date, t.end_date) >= ?
                 AND NOT EXISTS (SELECT 1 FROM tournament_files f WHERE f.tournament_id = t.id)
                 AND NOT EXISTS (SELECT 1 FROM results r WHERE r.tournament_id = t.id)`)
    .all(now, NOT_HELD_FROM);
  const organizerOf = db.prepare("SELECT organizer, email FROM tournament_requests WHERE tournament_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1");
  for (const t of rows) {
    db.transaction(() => {
      db.prepare("UPDATE tournaments SET held_status = 'not_held' WHERE id = ?").run(t.id);
      queueMail(db, { to: OPERATOR.email, kind: 'tournament.not_held.staff', ...mailTournamentNotHeld({ tournament: t, staff: true }) });
      const org = organizerOf.get(t.id);
      if (org && org.email) {
        queueMail(db, { to: org.email, kind: 'tournament.not_held', ...mailTournamentNotHeld({ tournament: t, organizer: org.organizer }) });
      }
    })();
  }
  return rows.length;
}

/** Всё ежедневное по дням турнира одним заходом планировщика. */
export function runTournamentDayChecks(db, { baseUrl, now = todayIso() } = {}) {
  return runDocsOpenNotices(db, { baseUrl, now }) + runEntryOpenStaffNotices(db, { now }) + runNotHeldCheck(db, { now });
}
