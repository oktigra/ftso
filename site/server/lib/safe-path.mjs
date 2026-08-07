// Куда МОЖНО редиректить. Значение приходит из ?next или из заголовка Referer —
// то есть управляется клиентом. Без проверки это открытый редирект: подставив
// внешний адрес, пользователя уводят с сайта под видом нашего перехода.
// Пускаем только локальный путь: начинается с одного «/» и не с «//» (протокол-
// относительный адрес //evil.example увёл бы на чужой домен) и не с «/\».
export function safeLocalPath(value, fallback = '/admin') {
  if (typeof value !== 'string' || value === '') return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  return value;
}

/** То же для Referer: из полного адреса берём путь, но только если хост наш. */
export function safeRefererPath(req, fallback = '/admin') {
  const referer = req.get('referer');
  if (!referer) return fallback;
  let url;
  try {
    url = new URL(referer, `${req.protocol}://${req.get('host')}`);
  } catch {
    return fallback;
  }
  if (url.host !== req.get('host')) return fallback;
  return safeLocalPath(url.pathname + url.search, fallback);
}
