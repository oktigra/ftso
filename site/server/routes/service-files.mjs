// СЛУЖЕБНЫЕ ФАЙЛЫ ДЛЯ ПОИСКОВИКОВ И БРАУЗЕРОВ — по аудиту WebGuardReport 03.09.2026.
//
// /robots.txt   — открыты все публичные разделы, закрыты вход, админка, кабинет и
//                 выдача файлов; указана карта сайта.
// /sitemap.xml  — живая: разделы из nav.mjs + опубликованные новости + турниры +
//                 профили игроков (не обезличенных). Индексация профилей открыта
//                 для всех, как у РТТ (ТЗ ред. 6). Кэш минуту — база небольшая.
// /llms.txt     — записка для ИИ-поисковиков: кто мы и где главное.
// /favicon.ico  — значок для браузеров, которые не спрашивают <link rel=icon>.
import { resolve } from 'node:path';
import { SECTIONS } from '../lib/nav.mjs';
import { OPERATOR } from '../lib/legal.mjs';

const XML = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export default function mountServiceFiles(app, { db, config, root }) {
  const site = config.siteUrl.replace(/\/$/, '');

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain; charset=utf-8').send(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /admin',
        'Disallow: /login',
        'Disallow: /cabinet',
        'Disallow: /files/',
        'Disallow: /rating.csv',
        `Sitemap: ${site}/sitemap.xml`,
        '',
      ].join('\n'),
    );
  });

  app.get('/sitemap.xml', (req, res) => {
    const urls = [];
    const add = (path, lastmod, priority) => urls.push({ loc: site + path, lastmod, priority });
    for (const s of SECTIONS.filter((x) => x.live)) add(s.path, null, s.path === '/' ? '1.0' : '0.7');
    add('/privacy', null, '0.3');
    add('/consent', null, '0.3');
    db.prepare("SELECT id, COALESCE(published_at, date(created_at)) AS d FROM news WHERE is_published = 1 ORDER BY id")
      .all()
      .forEach((n) => add(`/news/${n.id}`, n.d, '0.6'));
    db.prepare('SELECT id, end_date FROM tournaments ORDER BY id')
      .all()
      .forEach((t) => add(`/tournaments/${t.id}`, t.end_date, '0.6'));
    db.prepare('SELECT id FROM players WHERE anonymized_at IS NULL ORDER BY id')
      .all()
      .forEach((p) => add(`/player/${p.id}`, null, '0.5'));
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls
        .map((u) => `  <url><loc>${XML(u.loc)}</loc>${u.lastmod ? `<lastmod>${XML(u.lastmod)}</lastmod>` : ''}<priority>${u.priority}</priority></url>`)
        .join('\n') +
      '\n</urlset>\n';
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.type('application/xml; charset=utf-8').send(body);
  });

  app.get('/llms.txt', (req, res) => {
    res.type('text/plain; charset=utf-8').send(
      [
        `# ${OPERATOR.name} (ФТСО)`,
        '',
        '> Официальный сайт региональной федерации тенниса: календарь турниров, региональный рейтинг игроков по возрастным срезам, публичные профили участников, новости, справочники тренеров, судей, кортов и клубов Смоленской области.',
        '',
        '## Главные страницы',
        '',
        ...SECTIONS.filter((x) => x.live).map((s) => `- [${s.title}](${site}${s.path})`),
        '',
        '## Правовое',
        '',
        `- [Политика конфиденциальности](${site}/privacy)`,
        `- [Согласие на обработку персональных данных](${site}/consent)`,
        '',
        `Контакты: ${OPERATOR.email}, ${OPERATOR.phone}. ${OPERATOR.address}.`,
        '',
      ].join('\n'),
    );
  });

  app.get('/favicon.ico', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.type('image/x-icon').sendFile(resolve(root, 'public', 'img', 'favicon.ico'));
  });
}
