// СРОК ДОКУМЕНТА НА КАТЕГОРИЮ СУДЬИ (10.10.2026, решение владельца).
//
// Категорию присваивают или подтверждают документом, у документа срок — 1 или 2
// года (его выбирает сам судья в анкете). Сайт считает дату окончания и за месяц
// до неё пишет судье, что документы пора оформлять заново. Секретарь видит
// «истекает / истёк» в справочнике судей в админке.
//
// Проверка ДОГОНЯЮЩАЯ, как у перехода в 18 лет: ищет всех, кому пора, а не только
// тех, у кого срок ровно через 30 дней, — простой сервера ничего не теряет.
// Повтора нет: в category_reminded_for пишется срок, о котором уже напомнили;
// судья обновил дату — срок новый, и через год-два придёт новое напоминание.
import { queueMail, mailRefereeExpiry } from './mailer.mjs';

export const REMIND_DAYS_BEFORE = 30;

const today = () => new Date().toISOString().slice(0, 10);

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Дата окончания: дата документа + срок в годах (29 февраля → 28 февраля). */
export function categoryExpires(row) {
  if (!row || !row.category_date || !row.category_valid_years) return null;
  const [y, m, d] = row.category_date.split('-').map(Number);
  const year = y + Number(row.category_valid_years);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** ok — действует; soon — истекает в ближайшие 30 дней; expired — истёк; null — срок не задан. */
export function categoryState(row, now = today()) {
  const exp = categoryExpires(row);
  if (!exp) return null;
  if (exp < now) return 'expired';
  if (addDays(exp, -REMIND_DAYS_BEFORE) <= now) return 'soon';
  return 'ok';
}

export function runRefereeReminders(db, { now = today() } = {}) {
  const rows = db
    .prepare("SELECT id, full_name, category, category_date, category_valid_years, email, category_reminded_for FROM referees WHERE category_date IS NOT NULL AND category_valid_years IS NOT NULL AND email IS NOT NULL AND email <> ''")
    .all();
  const mark = db.prepare('UPDATE referees SET category_reminded_for = ? WHERE id = ?');
  let sent = 0;
  for (const r of rows) {
    const exp = categoryExpires(r);
    if (!exp || r.category_reminded_for === exp) continue;
    if (addDays(exp, -REMIND_DAYS_BEFORE) > now) continue;
    db.transaction(() => {
      queueMail(db, { to: r.email, kind: 'referee.category.expiry', ...mailRefereeExpiry({ fullName: r.full_name, category: r.category, expires: exp, expired: exp < now }) });
      mark.run(exp, r.id);
    })();
    sent += 1;
  }
  return sent;
}
