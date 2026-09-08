/**
 * ЗАЯВКА ТРЕНЕРА В РЕЕСТР (08.09.2026).
 *
 * Карточка тренера на сайте — это распространение персональных данных
 * неопределённому кругу лиц: нужно согласие по ст. 10.1, а не основание из ст. 6.
 * Бумажный бланк (tools/build-consent-forms.mjs) остаётся, но тренеру не обязательно
 * идти в Федерацию: он заполняет форму сам и ставит отметки по каждому полю.
 *
 * Ключевое правило: ОПУБЛИКОВАТЬ МОЖНО ТОЛЬКО ОТМЕЧЕННОЕ. Поле без галочки не
 * переносится в карточку вовсе — даже если тренер его заполнил.
 *
 * Заявка не публикуется сама: секретарь проверяет и одобряет, одобрение создаёт
 * карточку с основанием «согласие через сайт от <дата>» — это то, что по закону
 * должно лежать в поле «Основание публикации».
 */
import { randomBytes } from 'node:crypto';
import { ValidationError, str, email as emailField } from './validate.mjs';

/** Поля, у которых есть отдельная отметка согласия. */
export const OPTIONAL_FIELDS = [
  { key: 'city', allow: 'allow_city', label: 'Город' },
  { key: 'club', allow: 'allow_club', label: 'Клуб или место работы' },
  { key: 'specialization', allow: 'allow_specialization', label: 'Специализация' },
  { key: 'qualification', allow: 'allow_qualification', label: 'Образование, категория, стаж' },
  { key: 'groups', allow: 'allow_groups', label: 'С кем работает' },
  { key: 'contact', allow: 'allow_contact', label: 'Контакт для связи' },
];

/** Текст согласия фиксируется в заявке целиком: потом он и есть доказательство. */
export function consentText(operator) {
  return [
    `Согласие на обработку персональных данных, разрешённых для распространения (ст. 10.1 152-ФЗ).`,
    `Оператор: ${operator.name}, ${operator.address}, ОГРН ${operator.ogrn}, ИНН ${operator.inn}.`,
    `Цель: ведение и размещение реестра тренеров на сайте ${operator.site}.`,
    `Разрешаю опубликовать на сайте сведения, отмеченные мной в форме; неотмеченные не публикуются.`,
    `Согласие действует до отзыва; отзыв — письменно на ${operator.email}, снятие с сайта в течение трёх рабочих дней (ч. 12 ст. 10.1).`,
  ].join(' ');
}

function flag(body, name) {
  return body[name] === 'on' || body[name] === '1' || body[name] === 'true' ? 1 : 0;
}

export function applicationInput(body, operator) {
  if (!flag(body, 'consent_10_1')) {
    throw new ValidationError('Без согласия на публикацию сведений заявку принять нельзя');
  }
  const data = {
    full_name: str(body.full_name, 'ФИО', { min: 3, max: 120 }),
    email: emailField(body.email, 'E-mail для связи'),
    note: str(body.note, 'Примечание', { max: 500, required: false }),
    consent_10_1: 1,
    consent_text: consentText(operator),
  };
  for (const f of OPTIONAL_FIELDS) {
    const value = str(body[f.key], f.label, { max: 200, required: false });
    const allowed = flag(body, f.allow);
    // Заполнено, но не отмечено — не ошибка: человек мог передумать. Просто не берём.
    data[f.key] = allowed ? value : null;
    data[f.allow] = allowed && value ? 1 : 0;
  }
  return data;
}

export function createApplication(db, data, ip) {
  const token = randomBytes(24).toString('base64url');
  const cols = ['full_name', 'email', 'note', 'consent_10_1', 'consent_text', ...OPTIONAL_FIELDS.flatMap((f) => [f.key, f.allow])];
  const sql = `INSERT INTO coach_applications (${cols.join(', ')}, status_token, ip) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`;
  const id = Number(db.prepare(sql).run(...cols.map((c) => data[c]), token, ip || null).lastInsertRowid);
  return { id, token };
}

export function listApplications(db, status = 'pending') {
  return db
    .prepare('SELECT * FROM coach_applications WHERE status = ? ORDER BY id DESC')
    .all(status);
}

export function getApplication(db, id) {
  return db.prepare('SELECT * FROM coach_applications WHERE id = ?').get(id);
}

export function getByToken(db, token) {
  return db.prepare('SELECT id, full_name, status, reject_reason, created_at FROM coach_applications WHERE status_token = ?').get(token);
}

/**
 * Одобрение: создаёт карточку тренера ТОЛЬКО из отмеченных полей.
 * Основание — «согласие через сайт от <дата подачи>», дата документа — та же:
 * именно это по закону должно лежать в карточке как основание публикации.
 */
export function approveApplication(db, id, userId) {
  const app = getApplication(db, id);
  if (!app) throw new ValidationError('Заявка не найдена');
  if (app.status !== 'pending') throw new ValidationError('Заявка уже рассмотрена');
  const day = String(app.created_at || '').slice(0, 10);
  const basis = `согласие через сайт от ${day}`;
  const values = {};
  for (const f of OPTIONAL_FIELDS) values[f.key] = app[f.allow] ? app[f.key] : null;
  const coachId = Number(
    db
      .prepare(
        'INSERT INTO coaches (full_name, city, club, specialization, qualification, groups, contact, note, basis, document_date) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        app.full_name, values.city, values.club, values.specialization,
        values.qualification, values.groups, values.contact, null, basis, day,
      ).lastInsertRowid,
  );
  db.prepare("UPDATE coach_applications SET status = 'approved', coach_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?")
    .run(coachId, userId || null, id);
  return { coachId, basis };
}

export function rejectApplication(db, id, userId, reason) {
  const app = getApplication(db, id);
  if (!app) throw new ValidationError('Заявка не найдена');
  if (app.status !== 'pending') throw new ValidationError('Заявка уже рассмотрена');
  db.prepare("UPDATE coach_applications SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?")
    .run(str(reason, 'Причина', { max: 300, required: false }), userId || null, id);
}

export function pendingCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM coach_applications WHERE status = 'pending'").get().n;
}
