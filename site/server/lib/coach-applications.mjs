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

/**
 * СУДЬИ. Состав полей — по тому, что ведёт региональная коллегия судей: категория
 * (ЮС, 3К, 2К, 1К, ВК по требованиям Минспорта; международные значки ITF пишутся
 * словами), дата её присвоения или подтверждения — категорию подтверждают раз в
 * несколько лет, и без даты непонятно, действует ли она, — роли на турнирах и опыт.
 */
export const REFEREE_FIELDS = [
  { key: 'city', allow: 'allow_city', label: 'Город' },
  { key: 'category', allow: 'allow_category', label: 'Квалификационная категория' },
  { key: 'category_date', allow: 'allow_category_date', label: 'Когда присвоена или подтверждена' },
  { key: 'roles', allow: 'allow_roles', label: 'Роли на турнирах' },
  { key: 'experience', allow: 'allow_experience', label: 'Опыт судейства' },
  { key: 'contact', allow: 'allow_contact', label: 'Контакт для связи' },
];

/** Текст согласия фиксируется в заявке целиком: потом он и есть доказательство. */
export function consentText(operator, purpose = 'реестра тренеров') {
  return [
    `Согласие на обработку персональных данных, разрешённых для распространения (ст. 10.1 152-ФЗ).`,
    `Оператор: ${operator.name}, ${operator.address}, ОГРН ${operator.ogrn}, ИНН ${operator.inn}.`,
    `Цель: ведение и размещение ${purpose} на сайте ${operator.site}.`,
    `Разрешаю опубликовать на сайте сведения, отмеченные мной в форме; неотмеченные не публикуются.`,
    `Согласие действует до отзыва; отзыв — письменно на ${operator.email}, снятие с сайта в течение трёх рабочих дней (ч. 12 ст. 10.1).`,
  ].join(' ');
}

function flag(body, name) {
  return body[name] === 'on' || body[name] === '1' || body[name] === 'true' ? 1 : 0;
}

/** Описание двух реестров: одна механика, разные таблицы и поля. */
export const REGISTRIES = {
  coaches: {
    table: 'coach_applications', target: 'coaches', idColumn: 'coach_id',
    fields: OPTIONAL_FIELDS, title: 'тренеров', purpose: 'реестра тренеров',
  },
  referees: {
    table: 'referee_applications', target: 'referees', idColumn: 'referee_id',
    fields: REFEREE_FIELDS, title: 'судей', purpose: 'реестра спортивных судей',
  },
};

export function applicationInput(body, operator, fields = OPTIONAL_FIELDS, purpose = 'реестра тренеров') {
  if (!flag(body, 'consent_10_1')) {
    throw new ValidationError('Без согласия на публикацию сведений заявку принять нельзя');
  }
  const data = {
    full_name: str(body.full_name, 'ФИО', { min: 3, max: 120 }),
    email: emailField(body.email, 'E-mail для связи'),
    note: str(body.note, 'Примечание', { max: 500, required: false }),
    consent_10_1: 1,
    consent_text: consentText(operator, purpose),
  };
  for (const f of fields) {
    const value = str(body[f.key], f.label, { max: 200, required: false });
    const allowed = flag(body, f.allow);
    // Заполнено, но не отмечено — не ошибка: человек мог передумать. Просто не берём.
    data[f.key] = allowed ? value : null;
    data[f.allow] = allowed && value ? 1 : 0;
  }
  return data;
}

export function createApplication(db, data, ip, registry = REGISTRIES.coaches) {
  const token = randomBytes(24).toString('base64url');
  const cols = ['full_name', 'email', 'note', 'consent_10_1', 'consent_text', ...registry.fields.flatMap((f) => [f.key, f.allow])];
  const sql = `INSERT INTO ${registry.table} (${cols.join(', ')}, status_token, ip) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`;
  const id = Number(db.prepare(sql).run(...cols.map((c) => data[c]), token, ip || null).lastInsertRowid);
  return { id, token };
}

export function listApplications(db, status = 'pending', registry = REGISTRIES.coaches) {
  return db.prepare(`SELECT * FROM ${registry.table} WHERE status = ? ORDER BY id DESC`).all(status);
}

export function getApplication(db, id, registry = REGISTRIES.coaches) {
  return db.prepare(`SELECT * FROM ${registry.table} WHERE id = ?`).get(id);
}

export function getByToken(db, token, registry = REGISTRIES.coaches) {
  return db
    .prepare(`SELECT id, full_name, status, reject_reason, created_at FROM ${registry.table} WHERE status_token = ?`)
    .get(token);
}

/**
 * Одобрение: создаёт карточку тренера ТОЛЬКО из отмеченных полей.
 * Основание — «согласие через сайт от <дата подачи>», дата документа — та же:
 * именно это по закону должно лежать в карточке как основание публикации.
 */
export function approveApplication(db, id, userId, registry = REGISTRIES.coaches) {
  const app = getApplication(db, id, registry);
  if (!app) throw new ValidationError('Заявка не найдена');
  if (app.status !== 'pending') throw new ValidationError('Заявка уже рассмотрена');
  const day = String(app.created_at || '').slice(0, 10);
  const basis = `согласие через сайт от ${day}`;
  const values = {};
  for (const f of registry.fields) values[f.key] = app[f.allow] ? app[f.key] : null;
  const cols = ['full_name', ...registry.fields.map((f) => f.key), 'basis', 'document_date'];
  const vals = [app.full_name, ...registry.fields.map((f) => values[f.key]), basis, day];
  const newId = Number(
    db.prepare(`INSERT INTO ${registry.target} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid,
  );
  db.prepare(`UPDATE ${registry.table} SET status = 'approved', ${registry.idColumn} = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`)
    .run(newId, userId || null, id);
  return { coachId: newId, basis };
}

export function rejectApplication(db, id, userId, reason, registry = REGISTRIES.coaches) {
  const app = getApplication(db, id, registry);
  if (!app) throw new ValidationError('Заявка не найдена');
  if (app.status !== 'pending') throw new ValidationError('Заявка уже рассмотрена');
  db.prepare(`UPDATE ${registry.table} SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?`)
    .run(str(reason, 'Причина', { max: 300, required: false }), userId || null, id);
}

export function pendingCount(db, registry = REGISTRIES.coaches) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${registry.table} WHERE status = 'pending'`).get().n;
}
