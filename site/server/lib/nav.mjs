// Структура сайта — из ДОГОВОРА (Приложение № 1 «Техническое задание», §3).
// 12 разделов в меню + динамическая страница турнира /tournaments/:id.
// Живой в этом шаге — рейтинг; остальные разделы отдают заглушку
// «раздел в разработке» с ВЕРНЫМ URL и HTTP 200 (иначе поисковик не проиндексирует).

// title    — полное название раздела (заголовок страницы и <title>).
// navTitle — короткая подпись только для меню шапки.
// primary  — пункт стоит в ряду шапки; остальные — под кнопкой «Ещё».
//
// Почему не все 12 в ряд: контейнер макета 1200px, из них на меню остаётся ~650px
// (бренд + переключатель темы + «Регистрация»). 12 полных названий занимают ~1140px
// и либо переносятся на три строки, либо уезжают за экран — вид шапки из макета
// рушится в обоих случаях. Поэтому шесть основных пунктов пилюлями, как в макете,
// а остальные шесть — в выпадающем «Ещё». Все 12 адресов доступны из шапки.
export const SECTIONS = [
  { path: '/', title: 'Главная', live: true, primary: true },
  { path: '/federation', title: 'О Федерации', navTitle: 'Федерация', live: false },
  { path: '/news', title: 'Новости', live: false, primary: true },
  { path: '/tournaments', title: 'Турниры', live: false, primary: true },
  { path: '/rating', title: 'Рейтинг', live: true, primary: true },
  { path: '/coaches', title: 'Тренеры', live: false },
  { path: '/courts', title: 'Теннисные корты', navTitle: 'Корты', live: false },
  { path: '/clubs', title: 'Теннисные клубы', navTitle: 'Клубы', live: false },
  { path: '/referees', title: 'Судьи', live: false, note: 'Наполнение заказчик определит позже.' },
  { path: '/gallery', title: 'Галерея', live: false },
  { path: '/documents', title: 'Документы', live: false, primary: true },
  { path: '/contacts', title: 'Контакты', live: false, primary: true },
];

// Меню шапки: в дизайне пункты — ЯКОРЯ одной страницы, а сайт МНОГОСТРАНИЧНЫЙ.
// Вид шапки сохранён, ссылки перестроены на РЕАЛЬНЫЕ разделы.
export const HEADER_PRIMARY = SECTIONS.filter((s) => s.primary);
export const HEADER_MORE = SECTIONS.filter((s) => !s.primary);

export const FOOTER_SECTIONS = [
  { path: '/tournaments', title: 'Турниры' },
  { path: '/rating', title: 'Рейтинг' },
  { path: '/news', title: 'Новости' },
  { path: '/documents', title: 'Документы' },
];

// Регистрация игрока ЖИВАЯ — ведёт на /register. Остальные три пока «#»:
// личный кабинет и заявка на турнир — отдельные пункты бэклога.
export const FOOTER_PARTICIPANTS = [
  { href: '/register', title: 'Регистрация игрока' },
  { href: '#', title: 'Личный кабинет' },
  { href: '#', title: 'Заявка на турнир' },
  { href: '#', title: 'Секретарям турниров' },
];

// 152-ФЗ: эти две ссылки В объёме и ведут на РЕАЛЬНЫЕ страницы.
export const FOOTER_LEGAL = [
  { path: '/privacy', title: 'Политика конфиденциальности' },
  { path: '/consent', title: 'Согласие на обработку данных' },
];

export const STUB_SECTIONS = SECTIONS.filter((s) => !s.live);
