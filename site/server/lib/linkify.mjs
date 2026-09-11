// АВТОССЫЛКИ В ТЕКСТЕ НОВОСТИ. Текст из админки — обычный текст, HTML из него в
// разметку не попадает (экранируется). Но адреса в нём должны быть кликабельны:
// «https://…» и свой домен «ftso67.ru/…» (с www или без) становятся <a>.
// Хвостовая пунктуация (точка, запятая, скобка, кавычка «»), в адрес не входит.
// Чужие адреса открываются с rel="noopener noreferrer"; свои — как обычные.

const OWN_HOST = 'ftso67.ru';

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const URL_RE = /(https?:\/\/[^\s<>«»"']+)|(?<![\w/.@-])((?:www\.)?ftso67\.ru(?:\/[^\s<>«»"']*)?)/g;
const TRAIL_RE = /[.,;:!?)»]+$/;

export function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(URL_RE, (match, full, own) => {
    const raw = full || own;
    const trail = (raw.match(TRAIL_RE) || [''])[0];
    const url = raw.slice(0, raw.length - trail.length);
    if (!url) return match;
    const href = full ? url : `https://${url}`;
    let host = '';
    try { host = new URL(href.replace(/&amp;/g, '&')).hostname.replace(/^www\./, ''); } catch { return match; }
    const external = host !== OWN_HOST;
    const rel = external ? ' rel="noopener noreferrer"' : '';
    return `<a href="${href}"${rel}>${url}</a>${trail}`;
  });
}
