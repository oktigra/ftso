// СТАРТОВОЕ НАПОЛНЕНИЕ СПРАВОЧНИКОВ «Корты» и «Клубы» (05.09.2026, по открытым
// источникам: сайты организаций alpinatennis.ru и smena-smolensk.ru, Яндекс.Карты
// «теннисные корты Смоленская область», Google Maps, справочник spravker).
// Загружается кнопкой в админке; записи с уже существующим названием пропускаются.
// Личных данных нет — только организации, адреса и служебные телефоны с их сайтов.
// Что не подтверждено по двум источникам — помечено в «Примечании» словом «уточнить».
export const DIRECTORY_SEED = {
  courts: [
    { name: 'Теннисный клуб «Алпина»', city: 'Смоленск', address: 'ул. Попова, 27', surface: 'хард', courts_count: '3', season: 'круглый год (крытые)', club: 'ТК «Алпина»', contact: '+7 (4812) 77-60-60, alpinatennis@mail.ru', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Попова, 27', note: 'Покрытие хард, сертифицировано ITF; раздевалки, душевые, кафе, перетяжка ракеток, магазин. Ежедневно 8:00–23:00. Источник: alpinatennis.ru.' },
    { name: 'Спортивный клуб «Купол»', city: 'Смоленск', address: 'ул. Попова, 31', surface: 'хард', courts_count: 'уточнить', season: 'круглый год (под куполом)', club: 'СК «Купол»', contact: '+7 (919) 041-07-77, +7 (4812) 68-66-08', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Попова, 31', note: 'Крытый корт под куполом, тренер, раздевалки, душ. Ежедневно 8:00–22:00. Здесь же — юридический адрес Федерации. Число кортов — уточнить.' },
    { name: 'База отдыха «Смена» — открытые корты', city: 'Смоленск', address: 'ул. Лесная, 8', surface: 'хард', courts_count: '2', season: 'лето', club: 'СОК «Смена» (АО «Газпром газораспределение Смоленск»)', contact: '+7 (4812) 42-08-04, smena-smolensk@mail.ru', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Лесная, 8', note: 'Два открытых корта с покрытием HARD. Источник: smena-smolensk.ru/bolshoj-tennis.' },
    { name: 'База отдыха «Смена» — крытые корты', city: 'Смоленск', address: 'ул. Лесная, 8', surface: 'Multiflex (зал)', courts_count: '2', season: 'круглый год', club: 'СОК «Смена» (АО «Газпром газораспределение Смоленск»)', contact: '+7 (4812) 42-08-04, smena-smolensk@mail.ru', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Лесная, 8', note: 'Два корта в универсальном спортивном зале, покрытие MULTIFLEX. Источник: smena-smolensk.ru/bolshoj-tennis.' },
    { name: 'Спортивный комплекс ЦСКА (филиал ФАУ МО РФ ЦСКА)', city: 'Смоленск', address: 'ул. Багратиона, 25', surface: 'уточнить', courts_count: 'уточнить', season: 'лето (открытые)', club: 'ЦСКА, Смоленск', contact: '+7 (4812) 65-37-50', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Багратиона, 25', note: 'Открытые теннисные корты на территории комплекса (стадион, бассейн, гостиница). Покрытие и число кортов — уточнить у администрации.' },
    { name: 'Спортивный комплекс «МЖК»', city: 'Сафоново', address: 'микрорайон МЖК, 2а', surface: 'уточнить', courts_count: '1', season: 'круглый год (в зале)', club: '', contact: '', map_url: 'https://yandex.ru/maps/?text=Сафоново, микрорайон МЖК, 2а', note: 'По отзывам — большой теннисный корт в зале спорткомплекса, есть и настольный теннис. Телефон и покрытие — уточнить.' },
  ],
  clubs: [
    { name: 'Теннисный клуб «Алпина»', city: 'Смоленск', address: 'ул. Попова, 27', contact: '+7 (4812) 77-60-60, +7 (910) 787-79-60, alpinatennis@mail.ru', site: 'https://alpinatennis.ru/', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Попова, 27', note: 'Три крытых корта хард, тренеры для детей и взрослых, детские турниры по системе 10S и любительские турниры, лицензия на образовательную деятельность.' },
    { name: 'Спортивный клуб «Купол»', city: 'Смоленск', address: 'ул. Попова, 31', contact: '+7 (919) 041-07-77, +7 (4812) 68-66-08', site: '', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Попова, 31', note: 'Крытый корт хард, тренер, секции для детей; спортивный магазин. Адрес Федерации тенниса Смоленской области.' },
    { name: 'Спортивно-оздоровительный комплекс «Смена»', city: 'Смоленск', address: 'ул. Лесная, 8', contact: '+7 (4812) 42-08-04, smena-smolensk@mail.ru', site: 'https://smena-smolensk.ru/', map_url: 'https://yandex.ru/maps/?text=Смоленск, ул. Лесная, 8', note: 'База отдыха АО «Газпром газораспределение Смоленск»: 2 открытых корта хард и 2 крытых в зале, бассейн, прокат.' },
  ],
};

/** Вставляет записи, которых ещё нет по названию. Возвращает { added, skipped }. */
export function applyDirectorySeed(db, spec) {
  const rows = DIRECTORY_SEED[spec.key] || [];
  const cols = spec.fields.map((f) => f.name);
  let added = 0; let skipped = 0;
  const exists = db.prepare(`SELECT 1 FROM ${spec.table} WHERE name = ?`);
  const ins = db.prepare(`INSERT INTO ${spec.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  db.transaction(() => {
    for (const r of rows) {
      if (exists.get(r.name)) { skipped++; continue; }
      ins.run(...cols.map((c) => (r[c] === undefined || r[c] === '' ? null : String(r[c]))));
      added++;
    }
  })();
  return { added, skipped, total: rows.length };
}
