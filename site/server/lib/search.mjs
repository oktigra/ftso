// ПОИСК ПО САЙТУ (06.09.2026): турниры, игроки (только не обезличенные, по ФИО и городу),
// новости (опубликованные), тренеры, корты, клубы. Сравнение — в JS без учёта регистра
// кириллицы (SQLite LIKE его не знает); данных на сайте — сотни строк, не миллионы.
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const hit = (needle, ...fields) => fields.some((f) => norm(f).includes(needle));

export function siteSearch(db, query, { limitPer = 8 } = {}) {
  const q = norm(query);
  if (q.length < 2) return { q: String(query || '').trim(), groups: [], total: 0 };
  const groups = [];
  const add = (title, items) => { if (items.length) groups.push({ title, items: items.slice(0, limitPer), more: items.length > limitPer }); };
  add('Турниры', db.prepare('SELECT id, name, city, end_date, category FROM tournaments WHERE is_published = 1 ORDER BY end_date DESC').all()
    .filter((t) => hit(q, t.name, t.city)).map((t) => ({ href: `/tournaments/${t.id}`, title: t.name, note: `${t.end_date}${t.city ? ' · ' + t.city : ''} · категория ${t.category}` })));
  add('Игроки', db.prepare('SELECT id, full_name, city FROM players WHERE anonymized_at IS NULL ORDER BY full_name').all()
    .filter((p) => hit(q, p.full_name, p.city)).map((p) => ({ href: `/player/${p.id}`, title: p.full_name, note: p.city || '' })));
  add('Новости', db.prepare("SELECT id, title, summary, body, COALESCE(published_at, date(created_at)) AS d FROM news WHERE is_published = 1 ORDER BY d DESC").all()
    .filter((n) => hit(q, n.title, n.summary, n.body)).map((n) => ({ href: `/news/${n.id}`, title: n.title, note: n.d })));
  add('Тренеры', db.prepare('SELECT id, full_name, city, club FROM coaches ORDER BY full_name').all()
    .filter((c) => hit(q, c.full_name, c.city, c.club)).map((c) => ({ href: '/coaches', title: c.full_name, note: [c.city, c.club].filter(Boolean).join(' · ') })));
  add('Корты', db.prepare('SELECT id, name, city, address, surface FROM courts ORDER BY name').all()
    .filter((c) => hit(q, c.name, c.city, c.address, c.surface)).map((c) => ({ href: '/courts', title: c.name, note: [c.city, c.address].filter(Boolean).join(', ') })));
  add('Клубы', db.prepare('SELECT id, name, city, address FROM clubs ORDER BY name').all()
    .filter((c) => hit(q, c.name, c.city, c.address)).map((c) => ({ href: '/clubs', title: c.name, note: [c.city, c.address].filter(Boolean).join(', ') })));
  return { q: String(query || '').trim(), groups, total: groups.reduce((n, g) => n + g.items.length, 0) };
}
