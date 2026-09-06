// РЕДАКТИРУЕМЫЕ ТЕКСТЫ САЙТА (ТЗ п. 5 «управление страницами»): заголовок и
// подводка главной, подводка календаря, текст «О Федерации». Обычный текст,
// абзацы — пустой строкой; HTML не принимается (экранируется при выводе).
// Пусто в базе — берётся заготовка. Кэш в памяти, сброс при сохранении.
export const SITE_TEXTS = [
  { key: 'home-title', label: 'Главная — заголовок', max: 120, multiline: false,
    fallback: 'Теннис Смоленской области — в единой рейтинговой системе' },
  { key: 'home-lead', label: 'Главная — подводка под заголовком', max: 400, multiline: true,
    fallback: 'Календарь турниров, региональный рейтинг игроков и личный кабинет спортсмена. Один сайт для спортсменов, организаторов и болельщиков.' },
  { key: 'home-tournaments-lead', label: 'Главная — подводка к календарю', max: 300, multiline: true,
    fallback: 'Соревнования Федерации по регламенту ФТСО. Категории A и B определяют рейтинговый коэффициент.' },
  { key: 'home-cabinet-lead', label: 'Главная — карточка «Регистрация онлайн»', max: 200, multiline: false,
    fallback: 'Личный кабинет игрока — заявка на участие, профиль и результаты.' },
  { key: 'coaches-intro', label: '«Тренеры» — подводка над списком', max: 1500, multiline: true,
    fallback: 'Тренеры по большому теннису, работающие в Смоленской области: для детей и взрослых, начинающих и продвинутых, индивидуально и в группах. В карточке — город, место работы, специализация, режим и контакты; на пробное занятие записывайтесь у тренера напрямую.\n\nЕсли вы тренер и хотите попасть в реестр — напишите на info@ftso67.ru с пометкой «Тренеры»: ФИО, город, место работы, квалификация, с кем работаете, контакт.' },
  { key: 'referees-intro', label: '«Судьи» — подводка над списком', max: 1500, multiline: true,
    fallback: 'Реестр судей, сотрудничающих с Федерацией тенниса Смоленской области. Организаторы турниров могут обращаться к судьям напрямую.\n\nЕсли вы судья и хотите попасть в реестр — напишите на info@ftso67.ru с пометкой «Судьи»: ФИО, город, категория, контакт.' },
  { key: 'courts-intro', label: '«Корты» — подводка над списком', max: 1500, multiline: true,
    fallback: 'Теннисные корты Смоленской области: адреса, покрытие, число кортов, сезонность, режим работы и цены. Заметили ошибку или знаете корт, которого нет в списке, — напишите на info@ftso67.ru.' },
  { key: 'clubs-intro', label: '«Клубы» — подводка над списком', max: 1500, multiline: true,
    fallback: 'Теннисные клубы Смоленской области: адреса, контакты, сайты. Чтобы добавить клуб или поправить сведения — напишите на info@ftso67.ru.' },
  { key: 'federation-about', label: '«О Федерации» — раздел «Организация»', max: 4000, multiline: true,
    fallback: 'Федерация тенниса Смоленской области — региональная спортивная общественная организация, объединяющая теннисистов, тренеров, судей и организаторов соревнований Смоленской области.\n\nФедерация ведёт единый региональный рейтинг, согласует календарь соревнований и публикует итоговые протоколы турниров.' },
];

let cache = null;
export function loadTexts(db) {
  cache = new Map(db.prepare('SELECT key, value FROM site_texts').all().map((r) => [r.key, r.value]));
  return cache;
}
export function siteText(db, key) {
  if (!cache) loadTexts(db);
  const spec = SITE_TEXTS.find((t) => t.key === key);
  const v = cache.get(key);
  return v && v.trim() ? v : (spec ? spec.fallback : '');
}
export function saveText(db, key, value) {
  const spec = SITE_TEXTS.find((t) => t.key === key);
  if (!spec) throw new Error('unknown text key');
  const v = String(value || '').replace(/\r\n/g, '\n').trim().slice(0, spec.max);
  if (v) db.prepare(`INSERT INTO site_texts (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, v);
  else db.prepare('DELETE FROM site_texts WHERE key = ?').run(key);
  loadTexts(db);
}
/** Абзацы для шаблона: разбивка по пустой строке. */
export const paragraphs = (text) => String(text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
