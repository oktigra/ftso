// SEO-НАСТРОЙКИ СТРАНИЦ (ТЗ п. 5, п. 7): уникальные title и description.
// Три слоя, по убыванию приоритета:
//  1) правка секретаря в админке (/admin/seo) — таблица seo_pages по адресу;
//  2) description, вычисленный маршрутом из содержимого (новость, турнир, игрок);
//  3) заготовка по разделу из SEO_DEFAULTS.
// Кэш в памяти: читается на каждый запрос, обновляется при сохранении.
export const SEO_DEFAULTS = {
  '/': 'Официальный сайт Федерации тенниса Смоленской области: календарь турниров, региональный рейтинг игроков, новости, тренеры, корты и клубы.',
  '/federation': 'О Федерации тенниса Смоленской области: цели, руководство, реквизиты, документы.',
  '/news': 'Новости Федерации тенниса Смоленской области: анонсы, итоги турниров, пресс-релизы.',
  '/tournaments': 'Календарь теннисных турниров Смоленской области: даты, города, категории, результаты, архив.',
  '/rating': 'Региональный рейтинг теннисистов Смоленской области: 6 лучших турниров за 52 недели, обновление раз в месяц.',
  '/coaches': 'Тренеры по теннису Смоленской области: квалификация, специализация, клуб, контакты.',
  '/courts': 'Теннисные корты Смоленской области: адреса, покрытие, количество кортов, сезонность, карта.',
  '/clubs': 'Теннисные клубы Смоленской области: адреса, контакты, сайты.',
  '/referees': 'Судьи Федерации тенниса Смоленской области.',
  '/gallery': 'Фотогалерея турниров и мероприятий Федерации тенниса Смоленской области.',
  '/documents': 'Документы Федерации тенниса Смоленской области: устав, положения, регламенты.',
  '/contacts': 'Контакты Федерации тенниса Смоленской области: адрес, телефон, электронная почта, форма обратной связи.',
};

/** Список редактируемых страниц для админки: адрес → подпись. */
export const SEO_PAGES = [
  ['/', 'Главная'], ['/federation', 'О Федерации'], ['/news', 'Новости'], ['/tournaments', 'Турниры'],
  ['/rating', 'Рейтинг'], ['/coaches', 'Тренеры'], ['/courts', 'Теннисные корты'], ['/clubs', 'Теннисные клубы'],
  ['/referees', 'Судьи'], ['/gallery', 'Галерея'], ['/documents', 'Документы'], ['/contacts', 'Контакты'],
];

let cache = null;
export function loadSeo(db) {
  cache = new Map(db.prepare('SELECT path, title, description FROM seo_pages').all().map((r) => [r.path, r]));
  return cache;
}
export function seoFor(db, path) {
  if (!cache) loadSeo(db);
  return cache.get(path) || null;
}
export function saveSeo(db, path, { title, description }) {
  db.prepare(
    `INSERT INTO seo_pages (path, title, description, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET title = excluded.title, description = excluded.description, updated_at = excluded.updated_at`,
  ).run(path, title || null, description || null);
  loadSeo(db);
}

/** Description из свободного текста: первые ~160 знаков по границе слова. */
export function descriptionFrom(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 80)).trim()}…`;
}
