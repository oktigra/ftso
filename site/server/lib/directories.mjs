// СПРАВОЧНИКИ (тренеры, корты, клубы, судьи) — ОДНА реализация CRUD на четыре
// раздела, а не четыре почти одинаковых модуля. Причина та же, по которой один
// слой загрузки файлов: четыре копии разойдутся, и разойдутся молча.
//
// Раздел описывается ДАННЫМИ (таблица, поля, порядок), а код общий.
import { str, isoDate, ValidationError } from './validate.mjs';

/**
 * personal: true — в справочнике есть ФИО живых людей. Публикация ФИО это
 * распространение (ст. 10.1), поэтому у таких разделов ОБЯЗАТЕЛЬНЫ основание
 * и дата документа: тренер и судья не отмечали галочку на сайте, значит у
 * Федерации должен быть документ, и он должен быть назван.
 */
export const DIRECTORIES = {
  coaches: {
    key: 'coaches',
    table: 'coaches',
    title: 'Тренеры',
    path: '/coaches',
    orderBy: 'full_name',
    personal: true,
    fields: [
      { name: 'full_name', label: 'ФИО', required: true, max: 120 },
      { name: 'club', label: 'Клуб', max: 160 },
      { name: 'contact', label: 'Контакт', max: 160 },
      { name: 'note', label: 'Примечание', max: 500 },
    ],
  },
  referees: {
    key: 'referees',
    table: 'referees',
    title: 'Судьи',
    path: '/referees',
    orderBy: 'full_name',
    personal: true,
    fields: [
      { name: 'full_name', label: 'ФИО', required: true, max: 120 },
      { name: 'category', label: 'Категория', max: 80 },
      { name: 'city', label: 'Город', max: 80 },
      { name: 'note', label: 'Примечание', max: 500 },
    ],
  },
  courts: {
    key: 'courts',
    table: 'courts',
    title: 'Теннисные корты',
    path: '/courts',
    orderBy: 'name',
    personal: false,
    fields: [
      { name: 'name', label: 'Название', required: true, max: 160 },
      { name: 'address', label: 'Адрес', max: 200 },
      { name: 'surface', label: 'Покрытие', max: 80 },
      { name: 'map_url', label: 'Ссылка на карту', max: 300 },
      { name: 'note', label: 'Примечание', max: 500 },
    ],
  },
  clubs: {
    key: 'clubs',
    table: 'clubs',
    title: 'Теннисные клубы',
    path: '/clubs',
    orderBy: 'name',
    personal: false,
    fields: [
      { name: 'name', label: 'Название', required: true, max: 160 },
      { name: 'address', label: 'Адрес', max: 200 },
      { name: 'contact', label: 'Контакт', max: 160 },
      { name: 'site', label: 'Сайт', max: 200 },
      { name: 'note', label: 'Примечание', max: 500 },
    ],
  },
};

export const directoryByKey = (key) => DIRECTORIES[key] || null;

/** Разбор формы по описанию раздела. Ничего лишнего из тела не берётся. */
export function directoryInput(spec, body) {
  const data = {};
  for (const field of spec.fields) {
    data[field.name] = str(body[field.name], field.label, {
      max: field.max,
      required: Boolean(field.required),
    });
  }
  if (spec.personal) {
    // Публикация ФИО без названного основания невозможна — это не формальность,
    // а единственное, чем оператор объяснит публикацию чужого имени.
    data.basis = str(body.basis, 'Основание публикации', { max: 200 });
    data.document_date = isoDate(body.document_date, 'Дата документа');
  }
  return data;
}

const columnsOf = (spec) =>
  spec.fields.map((f) => f.name).concat(spec.personal ? ['basis', 'document_date'] : []);

export function listDirectory(db, spec) {
  return db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${spec.orderBy}`).all();
}

export function createDirectoryRow(db, spec, data) {
  const cols = columnsOf(spec);
  const info = db
    .prepare(
      `INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    )
    .run(...cols.map((c) => data[c]));
  return Number(info.lastInsertRowid);
}

export function updateDirectoryRow(db, spec, id, data) {
  const cols = columnsOf(spec);
  const info = db
    .prepare(`UPDATE ${spec.table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .run(...cols.map((c) => data[c]), id);
  if (!info.changes) throw new ValidationError('Запись не найдена');
  return info.changes;
}

export function deleteDirectoryRow(db, spec, id) {
  return db.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).run(id).changes;
}
