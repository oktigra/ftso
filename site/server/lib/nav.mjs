// Структура сайта — из ДОГОВОРА (Приложение № 1 «Техническое задание», §3).
// 12 разделов в меню + динамическая страница турнира /tournaments/:id.
// ВСЕ 12 разделов живые: у каждого свой маршрут и своё содержимое.
// Механизм заглушек (STUB_SECTIONS + views/stub.ejs) оставлен намеренно —
// он понадобится следующему разделу, который заведут раньше наполнения.

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
  { path: '/federation', title: 'О Федерации', navTitle: 'Федерация', live: true },
  { path: '/news', title: 'Новости', live: true, primary: true },
  { path: '/tournaments', title: 'Турниры', live: true, primary: true },
  { path: '/rating', title: 'Рейтинг', live: true, primary: true },
  { path: '/coaches', title: 'Тренеры', live: true },
  { path: '/courts', title: 'Теннисные корты', navTitle: 'Корты', live: true },
  { path: '/clubs', title: 'Теннисные клубы', navTitle: 'Клубы', live: true },
  { path: '/referees', title: 'Судьи', live: true, note: 'Наполнение заказчик определит позже.' },
  { path: '/gallery', title: 'Галерея', live: true },
  { path: '/documents', title: 'Документы', live: true, primary: true },
  { path: '/contacts', title: 'Контакты', live: true, primary: true },
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

// Живые: регистрация игрока (/register) и личный кабинет (/cabinet).
// «Заявка на турнир» и «Секретарям турниров» — участие в турнире и приём
// документов от секретарей, это отдельные пункты бэклога, пока «#».
export const FOOTER_PARTICIPANTS = [
  { href: '/register', title: 'Регистрация игрока' },
  { href: '/cabinet', title: 'Личный кабинет' },
  { href: '#', title: 'Заявка на турнир' },
  { href: '/organizers', title: 'Организаторам и секретарям' },
];

// 152-ФЗ: эти две ссылки В объёме и ведут на РЕАЛЬНЫЕ страницы.
export const FOOTER_LEGAL = [
  { path: '/privacy', title: 'Политика конфиденциальности' },
  { path: '/consent', title: 'Согласие на обработку данных' },
];

export const STUB_SECTIONS = SECTIONS.filter((s) => !s.live);
