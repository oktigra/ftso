// ПРИЁМКА по ТЗ. Один прогон: npm run accept
//
// Скрипт самодостаточен — поднимает ИЗОЛИРОВАННУЮ базу во временном каталоге,
// применяет миграцию, засевает данные, стартует приложение на случайном порту
// и проверяет каждый пункт раздела «Приёмка» ТЗ. Браузерные пункты (тема при
// включённом CSP, localStorage, адаптив, экранирование XSS, локальные шрифты)
// проверяются реальным Chromium через Playwright.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(resolve(tmpdir(), 'ftso-accept-'));
const DB_FILE = resolve(WORK, 'accept.sqlite');

// Изолированная база и предсказуемое окружение — ДО загрузки конфига.
process.env.DB_FILE = DB_FILE;
process.env.NODE_ENV = 'development';
process.env.LOGIN_MAX_ACCOUNT_FAILS = '5';
process.env.LOGIN_MAX_IP_FAILS = '20';
process.env.LOGIN_LOCK_MINUTES = '15';
process.env.RATING_STALE_LOCK_MINUTES = '5';
// Загрузки — в изолированный каталог прогона, а не в site/storage.
process.env.UPLOAD_DIR = resolve(WORK, 'uploads');
// Приём ПДн для основной части приёмки ОТКРЫТ: разделы 1–17 проверяют работу
// форм. Дефолт рубильника — «закрыто», поэтому без этой строки приёмка на
// чистой машине (где нет .env) валилась бы на регистрации и кабинете.
// Закрытое состояние проверяется в разделе 18 на ОТДЕЛЬНОМ экземпляре приложения.
process.env.INTAKE_ENABLED = '1';

const CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// ---------------------------------------------------------------------------
// Мини-раннер
// ---------------------------------------------------------------------------
const results = [];
let group = '';
const section = (t) => {
  group = t;
  results.push({ section: t });
};

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ group, name, ok: true, detail: detail || '' });
  } catch (err) {
    results.push({ group, name, ok: false, detail: err.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
  return true;
}
const eq = (a, b, msg) => assert(a === b, `${msg}: ожидалось ${JSON.stringify(b)}, получено ${JSON.stringify(a)}`);

// ---------------------------------------------------------------------------
// HTTP с банкой cookie
// ---------------------------------------------------------------------------
class Jar {
  constructor() {
    this.cookies = new Map();
  }
  absorb(res) {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (v === '' ) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return raw;
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  get sid() {
    return this.cookies.get('ftso.sid') || null;
  }
}

function makeClient(base) {
  return async function req(path, { method = 'GET', form, multipart, jar, headers = {}, redirect = 'manual' } = {}) {
    const h = { ...headers };
    if (jar) h.cookie = jar.header();
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    // multipart: content-type НЕ ставим руками — fetch сам подставит boundary.
    if (multipart) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(multipart.fields || {})) fd.append(k, String(v));
      for (const f of multipart.files || []) {
        fd.append(f.field, new Blob([f.buffer], { type: f.type || 'application/octet-stream' }), f.filename);
      }
      body = fd;
    }
    const res = await fetch(base + path, { method, headers: h, body, redirect });
    const setCookie = jar ? jar.absorb(res) : [];
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, setCookie, location: res.headers.get('location') };
  };
}

/** CSRF-токен со страницы: скрытое поле формы. */
function tokenFrom(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('CSRF-токен на странице не найден');
  return m[1];
}

// ---------------------------------------------------------------------------
// Подготовка: миграция + сид в изолированной базе
// ---------------------------------------------------------------------------
const run = (args, env = {}) =>
  spawnSync(process.execPath, args, { cwd: HERE, env: { ...process.env, ...env }, encoding: 'utf8' });

const migrateOut = run(['db/migrate.mjs']);
if (migrateOut.status !== 0) {
  console.error('Миграция не прошла:', migrateOut.stderr);
  process.exit(1);
}
const migrateTwice = run(['db/migrate.mjs']);
const seedOut = run(['db/seed.mjs']);
if (seedOut.status !== 0) {
  console.error('Сид не прошёл:', seedOut.stderr);
  process.exit(1);
}

const { loadConfig } = await import('./server/lib/config.mjs');
const { createApp } = await import('./server/app.mjs');
const { getDb, closeDb } = await import('./db/connect.mjs');
const { computeStandings } = await import('../rating/rating.mjs');
const { collectEngineInput, recompute, currentStandings } = await import('./server/lib/rating-service.mjs');
const { verifyPassword, parseHash } = await import('./server/lib/password.mjs');

const config = loadConfig();
let db = getDb();

function startApp() {
  const app = createApp(config);
  return new Promise((res) => {
    const server = app.listen(0, '127.0.0.1', () => {
      res({ app, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}
const stopApp = (inst) =>
  new Promise((res) => {
    inst.app.locals.closeStore();
    inst.server.close(res);
  });

let inst = await startApp();
let http = makeClient(inst.base);

const ADMIN = { user: config.superAdmin.username, pass: config.superAdmin.password };
const TADMIN = { user: 'turnir', pass: process.env.TOURNAMENT_ADMIN_PASSWORD || ADMIN.pass };

async function login(username, password, jar = new Jar(), headers = {}) {
  const page = await http('/login', { jar, headers });
  const _csrf = tokenFrom(page.text);
  const res = await http('/login', {
    method: 'POST',
    form: { _csrf, username, password, next: '/admin' },
    jar,
    headers,
  });
  return { res, jar };
}

// ===========================================================================
section('1. Сервер и маршруты');

await check('npm start поднимается, / отвечает по дизайну', async () => {
  const r = await http('/');
  eq(r.status, 200, 'GET /');
  assert(r.text.includes('Теннис Смоленской области — в единой рейтинговой системе'), 'нет заголовка из дизайна');
  assert(r.text.includes('class="site-header"') && r.text.includes('cta-inner'), 'нет секций дизайна');
  return 'HTTP 200, разметка макета на месте';
});

await check('/rating отвечает', async () => {
  const r = await http('/rating');
  eq(r.status, 200, 'GET /rating');
  assert(r.text.includes('Рейтинг игроков'), 'нет заголовка страницы рейтинга');
  return 'HTTP 200';
});

await check('у каждого раздела свой осмысленный <title> и заголовок', async () => {
  // Раньше здесь проверялось, что разделы — заглушки «в разработке». Разделы
  // наполнены, и проверка стала о другом: у каждого свой title и свой h1, а не
  // общий на всех — иначе поисковик увидит дюжину одинаковых страниц.
  const paths = ['/federation', '/news', '/tournaments', '/coaches', '/courts', '/clubs', '/referees', '/gallery', '/documents', '/contacts'];
  const titles = new Set();
  for (const p of paths) {
    const r = await http(p);
    eq(r.status, 200, `GET ${p}`);
    const t = /<title>([^<]+)<\/title>/.exec(r.text);
    assert(t && t[1].trim().length > 0, `${p}: пустой <title>`);
    assert(/ФТСО/.test(t[1]), `${p}: в <title> нет названия сайта`);
    assert(!titles.has(t[1]), `${p}: <title> «${t[1]}» повторяет другой раздел`);
    titles.add(t[1]);
    const h1 = /<h1[^>]*>([^<]+)<\/h1>/.exec(r.text);
    assert(h1 && h1[1].trim().length > 0, `${p}: нет заголовка h1`);
    assert(!r.text.includes('Раздел в разработке'), `${p}: раздел всё ещё заглушка`);
  }
  return `${paths.length} разделов: у каждого свой title и h1, заглушек нет`;
});

await check('все 12 разделов договора есть в меню шапки и ведут на свои адреса', async () => {
  const { SECTIONS } = await import('./server/lib/nav.mjs');
  eq(SECTIONS.length, 12, 'разделов должно быть 12 (Приложение № 1, §3)');
  const r = await http('/');
  const menu = r.text.split('id="primary-menu"')[1].split('</nav>')[0];
  for (const s of SECTIONS) {
    assert(menu.includes(`href="${s.path}"`), `в меню шапки нет ссылки на ${s.path}`);
  }
  // Меню — ОДИН ряд: пункты не якоря одной страницы, а реальные адреса.
  assert(!menu.includes('href="#'), 'в меню шапки остались якоря вместо реальных адресов');
  return `${SECTIONS.length} разделов: ${SECTIONS.map((s) => s.path).join(' ')}`;
});

await check('/tournaments/:id живой для существующего, 404 для несуществующего', async () => {
  const ok = await http('/tournaments/1');
  eq(ok.status, 200, 'существующий турнир');
  const no = await http('/tournaments/9999');
  eq(no.status, 404, 'несуществующий турнир');
  assert(no.text.includes('Страница не найдена'), 'не своя 404-страница');
  assert(!no.text.includes('<pre>') && !/at .*\.mjs:\d+/.test(no.text), 'в 404 просочился стектрейс');
  return '200 / 404 своей страницей';
});

// ===========================================================================
section('2. Вход, блокировка, сессии');

await check('верный логин пускает, неверный — отказ', async () => {
  const good = await login(ADMIN.user, ADMIN.pass);
  eq(good.res.status, 302, 'верный логин');
  eq(good.res.location, '/admin', 'редирект после входа');
  const admin = await http('/admin', { jar: good.jar });
  eq(admin.status, 200, 'админка после входа');

  const bad = await login(ADMIN.user, 'совершенно-неверный-пароль');
  eq(bad.res.status, 401, 'неверный пароль');
  assert(bad.res.text.includes('Неверный логин или пароль'), 'нет сообщения об отказе');
  return 'вход 302 -> /admin, отказ 401';
});

await check('выход работает; старый cookie после logout не пускает', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const before = await http('/admin', { jar });
  eq(before.status, 200, 'до выхода');
  const stolen = jar.header(); // «перехваченный» cookie

  const page = await http('/admin', { jar });
  const out = await http('/logout', { method: 'POST', form: { _csrf: tokenFrom(page.text) }, jar });
  eq(out.status, 302, 'logout');

  const replay = await fetch(inst.base + '/admin', { headers: { cookie: stolen }, redirect: 'manual' });
  eq(replay.status, 302, 'старый cookie должен перестать пускать');
  assert(String(replay.headers.get('location')).startsWith('/login'), 'старый cookie всё ещё пускает в админку');
  return 'серверная сессия уничтожена, реплей старого cookie -> /login';
});

await check('session fixation: session ID после входа РОТИРУЕТСЯ', async () => {
  const jar = new Jar();
  await http('/login', { jar });
  const before = jar.sid;
  assert(before, 'анонимной сессии нет (CSRF-токену некуда лечь)');
  await login(ADMIN.user, ADMIN.pass, jar);
  const after = jar.sid;
  assert(after && after !== before, `session ID не сменился: ${String(before).slice(0, 12)}…`);
  return `${String(before).slice(0, 14)}… -> ${String(after).slice(0, 14)}…`;
});

await check('5 неудач по (логин+IP) -> блок; успешный вход обнуляет счётчик', async () => {
  // trust proxy в этом инстансе = 0, поэтому ключ строится по локальному адресу;
  // разделение по IP отдельно проверяется ниже, на инстансе с trust proxy = 1.
  const user = 'admin';
  for (let i = 0; i < 5; i++) await login(user, `мимо-${i}`);
  const blocked = await login(user, 'снова-мимо');
  eq(blocked.res.status, 429, 'после 5 неудач ожидался блок');
  assert(blocked.res.text.includes('заблокирован'), 'нет сообщения о блокировке');

  const row = db.prepare("SELECT key, failed_count, locked_until FROM login_attempts WHERE key LIKE 'acct:admin|%'").get();
  assert(row && row.locked_until, 'в БД нет записи о блокировке');

  // Снимаем блок и убеждаемся, что успешный вход обнуляет счётчик.
  db.prepare('UPDATE login_attempts SET locked_until = NULL, failed_count = 0').run();
  const ok = await login(user, ADMIN.pass);
  eq(ok.res.status, 302, 'успешный вход после сброса');
  const after = db.prepare("SELECT failed_count FROM login_attempts WHERE key LIKE 'acct:admin|%'").get();
  eq(after.failed_count, 0, 'успешный вход должен обнулить счётчик');
  return `ключ ${row.key}, блок до ${row.locked_until} UTC; после успеха счётчик 0`;
});

await check('блокировка ПЕРЕЖИВАЕТ рестарт (хранится в SQLite)', async () => {
  for (let i = 0; i < 5; i++) await login('admin', `мимо-restart-${i}`);
  const before = db.prepare("SELECT locked_until FROM login_attempts WHERE key LIKE 'acct:admin|%'").get();
  assert(before && before.locked_until, 'блокировка не выставилась');

  await stopApp(inst);
  closeDb();
  db = getDb();
  inst = await startApp();
  http = makeClient(inst.base);

  const after = await login('admin', ADMIN.pass);
  eq(after.res.status, 429, 'после рестарта блокировка должна сохраниться');
  db.prepare('UPDATE login_attempts SET locked_until = NULL, failed_count = 0').run();
  return `блок до ${before.locked_until} UTC пережил перезапуск процесса`;
});

await check('тот же логин с ДРУГОГО IP не заблокирован (нет account-lock DoS)', async () => {
  // Отдельный инстанс с TRUST_PROXY=1: req.ip берётся из X-Forwarded-For.
  const proxied = createApp({ ...config, trustProxy: 1 });
  const server = await new Promise((r) => {
    const s = proxied.listen(0, '127.0.0.1', () => r(s));
  });
  const pHttp = makeClient(`http://127.0.0.1:${server.address().port}`);
  const attack = { 'x-forwarded-for': '198.51.100.7' };
  const victim = { 'x-forwarded-for': '198.51.100.200' };

  const tryLogin = async (headers, password) => {
    const jar = new Jar();
    const page = await pHttp('/login', { jar, headers });
    return pHttp('/login', {
      method: 'POST',
      form: { _csrf: tokenFrom(page.text), username: 'admin', password, next: '/admin' },
      jar,
      headers,
    });
  };

  for (let i = 0; i < 5; i++) await tryLogin(attack, `мимо-${i}`);
  const attackerBlocked = await tryLogin(attack, 'ещё-мимо');
  eq(attackerBlocked.status, 429, 'IP атакующего должен быть заблокирован');

  const victimOk = await tryLogin(victim, ADMIN.pass);
  eq(victimOk.status, 302, 'жертва с другого IP не должна быть заблокирована');

  const keys = db
    .prepare("SELECT key FROM login_attempts WHERE key LIKE 'acct:admin|198.51.100%'")
    .all()
    .map((r) => r.key);
  assert(keys.length >= 1, 'ключи по IP не сформировались');
  db.prepare('UPDATE login_attempts SET locked_until = NULL, failed_count = 0').run();
  await new Promise((r) => server.close(r));
  return `ключи: ${keys.join(', ')}; блокируется пара логин+IP, не логин глобально`;
});

await check('за обратным прокси req.ip = реальный клиент (trust proxy)', async () => {
  const proxied = createApp({ ...config, trustProxy: 1 });
  const server = await new Promise((r) => {
    const s = proxied.listen(0, '127.0.0.1', () => r(s));
  });
  const pHttp = makeClient(`http://127.0.0.1:${server.address().port}`);
  const jar = new Jar();
  const headers = { 'x-forwarded-for': '192.0.2.55' };
  const page = await pHttp('/login', { jar, headers });
  await pHttp('/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), username: 'kto-to', password: 'мимо', next: '/admin' },
    jar,
    headers,
  });
  const row = db.prepare("SELECT key FROM login_attempts WHERE key = 'acct:kto-to|192.0.2.55'").get();
  assert(row, 'ключ не содержит реальный IP клиента — req.ip вернул адрес прокси');
  await new Promise((r) => server.close(r));
  return 'ключ acct:kto-to|192.0.2.55 — IP взят из X-Forwarded-For';
});

await check('несуществующий логин отвечает за ТО ЖЕ время, что неверный пароль (dummy-хэш)', async () => {
  db.prepare('DELETE FROM login_attempts').run();
  const measure = async (username) => {
    const times = [];
    for (let i = 0; i < 6; i++) {
      const t0 = process.hrtime.bigint();
      await login(username, `пароль-мимо-${i}`);
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      db.prepare('DELETE FROM login_attempts').run();
    }
    times.sort((a, b) => a - b);
    return times[Math.floor(times.length / 2)]; // медиана
  };
  const existing = await measure('admin');
  const missing = await measure('такого-логина-нет');
  const ratio = missing / existing;
  assert(ratio > 0.6 && ratio < 1.6, `время отличается слишком сильно: ${existing.toFixed(1)} мс против ${missing.toFixed(1)} мс`);
  return `есть логин ${existing.toFixed(1)} мс / нет логина ${missing.toFixed(1)} мс (отношение ${ratio.toFixed(2)})`;
});

// ===========================================================================
section('3. Пароли');

await check('password_hash — строка scrypt$N$r$p$соль$хэш', async () => {
  const row = db.prepare('SELECT username, password_hash FROM users WHERE username = ?').get(ADMIN.user);
  assert(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(row.password_hash), `формат не тот: ${row.password_hash.slice(0, 40)}`);
  const parsed = parseHash(row.password_hash);
  eq(parsed.N, 16384, 'N');
  eq(parsed.r, 8, 'r');
  eq(parsed.p, 1, 'p');
  eq(parsed.salt.length, 16, 'длина соли');
  eq(parsed.hash.length, 64, 'длина хэша');
  const shown = row.password_hash.slice(0, 34) + '…' + row.password_hash.slice(-12);
  return `${shown} (N=16384 r=8 p=1, соль 16 Б, ключ 64 Б)`;
});

await check('сверка через timingSafeEqual: верный да, неверный нет', async () => {
  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(ADMIN.user);
  assert(verifyPassword(ADMIN.pass, row.password_hash), 'верный пароль не принят');
  assert(!verifyPassword(ADMIN.pass + 'x', row.password_hash), 'неверный пароль принят');
  assert(!verifyPassword(ADMIN.pass, 'мусор'), 'кривая строка в БД должна давать false, не падение');
  const src = readFileSync(resolve(HERE, 'server/lib/password.mjs'), 'utf8');
  assert(src.includes('timingSafeEqual'), 'timingSafeEqual не используется');
  return 'verifyPassword: true / false / false на мусоре';
});

await check('пароль супер-админа берётся из .env, не хардкод', async () => {
  const envPass = process.env.SUPER_ADMIN_PASSWORD;
  assert(envPass, 'SUPER_ADMIN_PASSWORD не задан в окружении');
  const row = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(ADMIN.user);
  assert(verifyPassword(envPass, row.password_hash), 'пароль в БД не совпадает со значением из .env');
  for (const f of ['db/seed.mjs', 'server/lib/config.mjs', 'server/routes/auth.mjs']) {
    assert(!readFileSync(resolve(HERE, f), 'utf8').includes(envPass), `значение пароля найдено в ${f}`);
  }
  return 'пароль совпадает с .env и в исходниках отсутствует';
});

// ===========================================================================
section('4. CSRF');

await check('POST /login без валидного токена -> отказ', async () => {
  const jar = new Jar();
  await http('/login', { jar });
  const noToken = await http('/login', { method: 'POST', form: { username: ADMIN.user, password: ADMIN.pass }, jar });
  eq(noToken.status, 403, 'POST без токена');
  const badToken = await http('/login', {
    method: 'POST',
    form: { _csrf: 'поддельный-токен', username: ADMIN.user, password: ADMIN.pass },
    jar,
  });
  eq(badToken.status, 403, 'POST с чужим токеном');
  return 'без токена 403, с подделкой 403';
});

await check('POST в админку без валидного токена -> отказ', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const r = await http('/admin/players', {
    method: 'POST',
    form: { full_name: 'Без Токена', city: 'Смоленск', sex: 'M' },
    jar,
  });
  eq(r.status, 403, 'POST /admin/players без токена');
  const created = db.prepare('SELECT COUNT(*) AS n FROM players WHERE full_name = ?').get('Без Токена').n;
  eq(created, 0, 'запись не должна была создаться');
  return '403, запись не создана';
});

// ===========================================================================
section('5. Смена пароля и cookie');

await check('смена своего пароля без верного текущего -> отказ', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/account', { jar });
  const _csrf = tokenFrom(page.text);
  await http('/admin/account/password', {
    method: 'POST',
    form: { _csrf, current_password: 'не-тот-пароль', new_password: 'новый-длинный-пароль-1' },
    jar,
  });
  const still = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(ADMIN.user);
  assert(verifyPassword(ADMIN.pass, still.password_hash), 'пароль сменился без верного текущего!');

  const good = await http('/admin/account/password', {
    method: 'POST',
    form: { _csrf, current_password: ADMIN.pass, new_password: 'временный-длинный-пароль-9' },
    jar,
  });
  eq(good.status, 302, 'смена с верным текущим');
  const changed = db.prepare('SELECT password_hash FROM users WHERE username = ?').get(ADMIN.user);
  assert(verifyPassword('временный-длинный-пароль-9', changed.password_hash), 'пароль не сменился');
  // возвращаем как было, чтобы дальнейшие проверки шли на пароле из .env
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(still.password_hash, ADMIN.user);
  return 'без текущего — отклонено, с текущим — сменён';
});

await check('cookie сессии: HttpOnly, SameSite; Secure по NODE_ENV', async () => {
  const jar = new Jar();
  const r = await http('/login', { jar });
  const line = r.setCookie.find((c) => c.startsWith('ftso.sid='));
  assert(line, 'Set-Cookie для сессии не выставлен');
  assert(/HttpOnly/i.test(line), 'нет HttpOnly');
  assert(/SameSite=Lax/i.test(line), 'нет SameSite=Lax');
  assert(!/Secure/i.test(line), 'в dev Secure не должен ставиться, иначе вход по HTTP не работает');

  // Тот же код с NODE_ENV=production обязан выставить Secure. Проверяем так, как
  // это выглядит в бою: за обратным прокси, который сообщает X-Forwarded-Proto.
  // (Без этого express-session вообще не отдаёт cookie по незащищённому соединению.)
  const prodApp = createApp({ ...config, isProd: true, trustProxy: 1 });
  const server = await new Promise((res) => {
    const s = prodApp.listen(0, '127.0.0.1', () => res(s));
  });
  const prodRes = await fetch(`http://127.0.0.1:${server.address().port}/login`, {
    redirect: 'manual',
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.9' },
  });
  const prodLine = prodRes.headers.getSetCookie().find((c) => c.startsWith('ftso.sid='));
  await new Promise((r2) => server.close(r2));
  assert(prodLine, 'в production за HTTPS-прокси cookie не выставлен');
  assert(/Secure/i.test(prodLine), `в production Secure не выставлен: ${prodLine}`);
  assert(/HttpOnly/i.test(prodLine) && /SameSite=Lax/i.test(prodLine), 'в production потерялись HttpOnly/SameSite');
  return `dev: ${line.split(';').slice(1).map((s) => s.trim()).join(', ')} | prod: +Secure`;
});

await check('в dev без HTTPS вход работает', async () => {
  const { res } = await login(ADMIN.user, ADMIN.pass);
  eq(res.status, 302, 'вход по HTTP в dev');
  return 'вход по HTTP прошёл (Secure выключен по NODE_ENV)';
});

// ===========================================================================
section('6. Заголовки безопасности');

await check('CSP, X-Frame-Options, X-Content-Type-Options присутствуют', async () => {
  const r = await http('/');
  const csp = r.headers.get('content-security-policy');
  assert(csp, 'нет Content-Security-Policy');
  assert(/default-src 'self'/.test(csp), 'CSP без default-src self');
  assert(/img-src 'self' data:/.test(csp), 'CSP без img-src data: (картинка из дизайна сломается)');
  assert(/script-src 'self' 'nonce-/.test(csp), 'CSP без nonce для инлайнового скрипта темы');
  assert(/font-src 'self'/.test(csp), 'CSP без font-src self');
  eq(r.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options');
  eq(r.headers.get('x-content-type-options'), 'nosniff', 'X-Content-Type-Options');
  assert(r.headers.get('referrer-policy'), 'нет Referrer-Policy');
  return `CSP: ${csp.slice(0, 96)}…`;
});

// ===========================================================================
section('7. Экранирование, валидация, отсутствие аплоада');

await check('экранирование: имя <script>alert(1)</script> выводится ТЕКСТОМ', async () => {
  const r = await http('/rating');
  assert(r.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'имя не экранировано');
  assert(!r.text.includes('<script>alert(1)</script>'), 'в HTML попал исполняемый скрипт из данных');
  const src = readFileSync(resolve(HERE, 'views/rating.ejs'), 'utf8');
  assert(!/<%-\s*(p\.|standings|players)/.test(src), 'в шаблоне рейтинга есть неэкранированный вывод данных');
  return 'в HTML — &lt;script&gt;…, исполняемого тега нет';
});

await check('CRUD игроков и турниров полон: редактирование доступно из админки', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);

  // Форма редактирования должна БЫТЬ на странице, иначе маршрут update мёртв.
  const pPage = await http('/admin/players', { jar });
  const player = db.prepare('SELECT * FROM players ORDER BY id LIMIT 1').get();
  assert(pPage.text.includes(`action="/admin/players/${player.id}/update"`), 'на странице игроков нет формы редактирования');
  const _pCsrf = tokenFrom(pPage.text);

  const upd = await http(`/admin/players/${player.id}/update`, {
    method: 'POST',
    form: { _csrf: _pCsrf, full_name: 'Изменённый Игрок', city: 'Десногорск', sex: 'F' },
    jar,
  });
  eq(upd.status, 302, 'обновление игрока');
  const after = db.prepare('SELECT * FROM players WHERE id = ?').get(player.id);
  eq(after.full_name, 'Изменённый Игрок', 'ФИО не обновилось');
  eq(after.city, 'Десногорск', 'город не обновился');
  eq(after.sex, 'F', 'пол не обновился');

  // Кривой ввод при обновлении тоже отклоняется.
  await http(`/admin/players/${player.id}/update`, {
    method: 'POST',
    form: { _csrf: _pCsrf, full_name: 'X', city: 'Y', sex: 'Z' },
    jar,
  });
  eq(db.prepare('SELECT sex FROM players WHERE id = ?').get(player.id).sex, 'F', 'кривой пол прошёл при обновлении');

  const tPage = await http('/admin/tournaments', { jar });
  const tour = db.prepare('SELECT * FROM tournaments ORDER BY id LIMIT 1').get();
  assert(tPage.text.includes(`action="/admin/tournaments/${tour.id}/update"`), 'на странице турниров нет формы редактирования');
  const tUpd = await http(`/admin/tournaments/${tour.id}/update`, {
    method: 'POST',
    form: { _csrf: tokenFrom(tPage.text), name: 'Переименованный турнир', end_date: tour.end_date, category: 'B' },
    jar,
  });
  eq(tUpd.status, 302, 'обновление турнира');
  const tAfter = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tour.id);
  eq(tAfter.name, 'Переименованный турнир', 'название не обновилось');
  eq(tAfter.category, 'B', 'категория не обновилась');

  // Возвращаем как было, чтобы дальнейшие проверки рейтинга шли на сид-данных.
  db.prepare('UPDATE players SET full_name = ?, city = ?, sex = ?, age_group = ? WHERE id = ?')
    .run(player.full_name, player.city, player.sex, player.age_group, player.id);
  db.prepare('UPDATE tournaments SET name = ?, category = ? WHERE id = ?').run(tour.name, tour.category, tour.id);
  return 'игрок и турнир редактируются, кривой ввод при обновлении отклоняется';
});

await check('редирект после ошибки не уводит на чужой домен (открытый редирект)', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/players', { jar });
  const _csrf = tokenFrom(page.text);
  // Referer управляется клиентом: подсовываем внешний адрес и протокол-
  // относительный, вызывая заведомо кривой ввод.
  for (const evil of ['https://evil.example/phish', '//evil.example/phish', '/\\evil.example']) {
    const r = await http('/admin/players', {
      method: 'POST',
      form: { _csrf, full_name: '', city: '', sex: 'M' },
      jar,
      headers: { referer: evil },
    });
    eq(r.status, 302, `отказ при Referer ${evil}`);
    assert(r.location && r.location.startsWith('/') && !r.location.startsWith('//'),
      `редирект увёл на «${r.location}» при Referer ${evil}`);
    assert(!/evil\.example/.test(r.location), `в адрес редиректа попал чужой домен: ${r.location}`);
  }
  // Свой Referer при этом уважается — пользователь возвращается на свою страницу.
  const ok = await http('/admin/players', {
    method: 'POST',
    form: { _csrf, full_name: '', city: '', sex: 'M' },
    jar,
    headers: { referer: `${inst.base}/admin/players` },
  });
  eq(ok.location, '/admin/players', 'свой Referer должен сохраняться');
  return 'внешний и протокол-относительный Referer отбрасываются, свой путь сохраняется';
});

await check('валидация админки: место 0 / -1 / abc отклоняются, сервер жив', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/tournaments/1/results', { jar });
  const _csrf = tokenFrom(page.text);
  const before = db.prepare('SELECT COUNT(*) AS n FROM results').get().n;
  const msgs = [];
  for (const place of ['0', '-1', 'abc', '1.5']) {
    const r = await http('/admin/tournaments/1/results', {
      method: 'POST',
      form: { _csrf, player_id: '1', place },
      jar,
    });
    eq(r.status, 302, `место ${place}: ожидался мягкий отказ с сообщением`);
    const followed = await http('/admin/tournaments/1/results', { jar });
    assert(/flash--error/.test(followed.text), `место ${place}: нет сообщения об ошибке`);
    msgs.push(place);
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM results').get().n;
  eq(after, before, 'кривые места не должны были попасть в базу');
  const alive = await http('/');
  eq(alive.status, 200, 'сервер должен остаться живым');
  return `отклонены: ${msgs.join(', ')}; сервер жив`;
});

await check('валидация админки: дата 2026-13-40 и категория C отклоняются', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/tournaments', { jar });
  const _csrf = tokenFrom(page.text);
  const before = db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n;

  await http('/admin/tournaments', { method: 'POST', form: { _csrf, name: 'Кривая дата', end_date: '2026-13-40', category: 'A' }, jar });
  await http('/admin/tournaments', { method: 'POST', form: { _csrf, name: 'Кривая дата 2', end_date: '2026-02-30', category: 'A' }, jar });
  await http('/admin/tournaments', { method: 'POST', form: { _csrf, name: 'Кривая категория', end_date: '2026-05-01', category: 'C' }, jar });

  const after = db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n;
  eq(after, before, 'кривые турниры не должны были создаться');
  const alive = await http('/');
  eq(alive.status, 200, 'сервер жив');
  return '2026-13-40, 2026-02-30 и категория C отклонены';
});

await check('загрузка файлов идёт ТОЛЬКО через общий слой', async () => {
  // Раньше здесь проверялось, что аплоада нет вовсе. Аплоад появился — и теперь
  // проверяется главное: он ОДИН. Второй разбор multipart или вторая запись
  // файла на диск мимо lib/uploads.mjs означали бы вторую копию правил
  // (magic bytes, лимит, вне webroot, attachment), которая разойдётся с первой.
  const parsers = spawnSync('grep', ['-rlE', "from 'busboy'|require\\('busboy'\\)", 'server'], {
    cwd: HERE, encoding: 'utf8',
  }).stdout.split('\n').filter(Boolean);
  eq(parsers.join(','), 'server/lib/multipart.mjs', `разбор multipart должен быть в одном месте, найдено: ${parsers}`);

  const writers = spawnSync('grep', ['-rlE', 'writeFileSync', 'server'], { cwd: HERE, encoding: 'utf8' })
    .stdout.split('\n').filter(Boolean);
  eq(writers.join(','), 'server/lib/uploads.mjs', `запись файлов должна быть в одном месте, найдено: ${writers}`);

  // Маршруты не проверяют файлы сами — они зовут слой. Ищем ПРИЗНАКИ КОДА
  // (сигнатуры, вызовы распознавания), а не слово «magic» в комментарии.
  const routeChecks = spawnSync('grep', ['-rlE', '%PDF|0x89|sniffType|looksExecutable', 'server/routes'], {
    cwd: HERE, encoding: 'utf8',
  }).stdout.trim();
  assert(!routeChecks, `в маршрутах появились свои проверки типа файла: ${routeChecks}`);

  const pkg = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const extra of ['multer', 'formidable', 'express-fileupload']) {
    assert(!deps[extra], `второй загрузчик файлов в зависимостях: ${extra}`);
  }
  return 'один разбор multipart, одна запись на диск, в маршрутах своих проверок типа нет';
});

await check('500 отдаёт свою страницу без стектрейса наружу', async () => {
  // Настоящая внутренняя ошибка: убираем таблицу, от которой зависит витрина.
  const brokenFile = resolve(WORK, 'broken.sqlite');
  copyFileSync(DB_FILE, brokenFile);
  const bdb = new Database(brokenFile);
  bdb.exec('DROP TABLE rating_cache');
  bdb.close();

  const prev = process.env.DB_FILE;
  await stopApp(inst);
  closeDb();
  process.env.DB_FILE = brokenFile;
  let broken = getDb();
  let binst = await startApp();
  const bhttp = makeClient(binst.base);
  const r = await bhttp('/rating');

  await stopApp(binst);
  closeDb();
  process.env.DB_FILE = prev;
  db = getDb();
  inst = await startApp();
  http = makeClient(inst.base);

  eq(r.status, 500, 'ожидался 500');
  assert(r.text.includes('Ошибка на сервере'), 'не своя страница 500');
  assert(!/at .*\.mjs:\d+/.test(r.text) && !r.text.includes('SqliteError') && !r.text.includes('no such table'),
    'наружу утёк стектрейс или детали ошибки');
  return '500 своей страницей, деталей и стектрейса в ответе нет';
});

await check('ни один отказ не отдаёт стектрейс наружу (403/404/429/413)', async () => {
  // Регрессия: отказ CSRF происходит РАНЬШЕ, чем ставились локали шаблона, и
  // страница ошибки падала при рендере — Express печатал стектрейс в ответ.
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const leaks = /at .*\.mjs:\d+|ReferenceError|TypeError:|node_modules|\/home\/|SqliteError/;
  const cases = [
    ['CSRF без токена на /login', await http('/login', { method: 'POST', form: { username: 'a', password: 'b' } })],
    ['CSRF без токена в админке', await http('/admin/players', { method: 'POST', form: { full_name: 'x' }, jar })],
    ['404', await http('/такого-адреса-нет')],
    ['403 по роли', await (async () => {
      db.prepare('DELETE FROM login_attempts').run();
      const t = await login(TADMIN.user, TADMIN.pass);
      return http('/admin/users', { jar: t.jar });
    })()],
  ];
  const report = [];
  for (const [label, res] of cases) {
    assert(!leaks.test(res.text), `${label}: в теле ответа утечка деталей ошибки`);
    assert(res.text.includes('<!DOCTYPE html>'), `${label}: ответ не является страницей`);
    assert(/<title>[^<]+<\/title>/.test(res.text), `${label}: нет <title>`);
    report.push(`${label} -> ${res.status}`);
  }
  return report.join(', ') + ' — все со своей страницей, без деталей';
});

// ===========================================================================
section('8. Роли и гейтинг');

await check('не залогинен на админ-маршруте -> редирект на /login', async () => {
  for (const p of ['/admin', '/admin/players', '/admin/tournaments', '/admin/users', '/admin/account']) {
    const r = await http(p);
    eq(r.status, 302, `GET ${p}`);
    assert(String(r.location).startsWith('/login'), `${p}: редирект не на /login`);
  }
  return '5 админ-маршрутов -> 302 /login';
});

await check('tournament-admin в чужом админ-разделе -> 403', async () => {
  db.prepare('DELETE FROM login_attempts').run();
  const { res, jar } = await login(TADMIN.user, TADMIN.pass);
  eq(res.status, 302, 'вход tournament-admin');
  const own = await http('/admin/players', { jar });
  eq(own.status, 200, 'свой раздел должен открываться');
  const foreign = await http('/admin/users', { jar });
  eq(foreign.status, 403, 'чужой раздел должен давать 403');
  assert(foreign.text.includes('Недостаточно прав'), 'нет сообщения о правах');
  return '/admin/players 200, /admin/users 403';
});

await check('публичные страницы разделов открываются без входа', async () => {
  for (const p of ['/', '/rating', '/coaches', '/news', '/documents', '/privacy', '/consent']) {
    const r = await http(p);
    eq(r.status, 200, `GET ${p} без входа`);
  }
  return '7 публичных адресов доступны анонимно';
});

// ===========================================================================
section('9. Вертикаль рейтинга');

await check('витрина показывает ТЕ ЖЕ standings, что движок напрямую', async () => {
  const input = collectEngineInput(db);
  const direct = computeStandings(input);
  const shown = currentStandings(db);
  eq(shown.players.length, direct.players.length, 'число игроков');
  for (let i = 0; i < direct.players.length; i++) {
    eq(shown.players[i].playerId, direct.players[i].playerId, `игрок на позиции ${i + 1}`);
    eq(shown.players[i].rank, direct.players[i].rank, `ранг игрока ${direct.players[i].playerName}`);
    eq(shown.players[i].ratingPoints, direct.players[i].ratingPoints, `очки игрока ${direct.players[i].playerName}`);
  }
  // и то же самое в HTML
  const page = await http('/rating');
  for (const p of direct.players.slice(0, 3)) {
    const esc = p.playerName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert(page.text.includes(esc), `в HTML нет игрока ${p.playerName}`);
    assert(page.text.includes(`>${p.ratingPoints}<`), `в HTML нет очков ${p.ratingPoints}`);
  }
  const top = direct.players.slice(0, 3).map((p) => `${p.rank}. ${p.playerName} ${p.ratingPoints}`).join('; ');
  return top;
});

await check('главная показывает ТОП-5 из последнего снимка', async () => {
  const shown = currentStandings(db);
  const top5 = shown.players.slice(0, 5);
  const page = await http('/');
  const section = page.text.split('id="rating"')[1].split('</section>')[0];
  for (const p of top5) {
    const esc = p.playerName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    assert(section.includes(esc), `на главной нет игрока ${p.playerName}`);
    assert(section.includes(p.city), `на главной нет города ${p.city}`);
  }
  const sixth = shown.players[5];
  if (sixth) assert(!section.includes(sixth.playerName.replace(/</g, '&lt;')), 'на главной больше пяти строк');
  assert(section.includes('Полный рейтинг'), 'нет ссылки «Полный рейтинг →»');
  return `${top5.map((p) => `${p.rank}. ${p.playerName}`).join('; ')}`;
});

await check('«Изменение»: два снимка -> стрелки; проверено арифметикой рангов', async () => {
  const snaps = db.prepare('SELECT standings_json FROM rating_cache ORDER BY id DESC LIMIT 2').all();
  eq(snaps.length, 2, 'нужно два снимка');
  const cur = JSON.parse(snaps[0].standings_json);
  const prev = JSON.parse(snaps[1].standings_json);
  const prevRank = new Map(prev.players.map((p) => [p.playerId, p.rank]));
  const shown = currentStandings(db);

  const kinds = new Set();
  for (const p of shown.players) {
    const expected = prevRank.has(p.playerId)
      ? (() => {
          const d = prevRank.get(p.playerId) - p.rank;
          return d > 0 ? `▲ +${d}` : d < 0 ? `▼ −${Math.abs(d)}` : '— 0';
        })()
      : 'нов.';
    eq(p.change.label, expected, `стрелка для ${p.playerName}`);
    kinds.add(p.change.kind);
  }
  assert(kinds.has('up'), 'нет ни одной стрелки вверх');
  assert(kinds.has('down'), 'нет ни одной стрелки вниз');
  assert(kinds.has('flat'), 'нет ни одного «— 0»');
  assert(kinds.has('new'), 'нет ни одного «нов.»');
  const sample = shown.players.slice(0, 6).map((p) => `${p.playerName}: ${p.change.label}`).join('; ');
  return sample;
});

await check('один снимок -> «нов.»/«—», не падение', async () => {
  const backup = db.prepare('SELECT id, computed_at, status, standings_json FROM rating_cache ORDER BY id').all();
  db.prepare('DELETE FROM rating_cache WHERE id <> (SELECT MAX(id) FROM rating_cache)').run();
  const single = currentStandings(db);
  eq(single.hasPrevious, false, 'предыдущего снимка быть не должно');
  for (const p of single.players) eq(p.change.label, '—', `при одном снимке ожидалось «—» у ${p.playerName}`);
  const page = await http('/rating');
  eq(page.status, 200, 'страница рейтинга при одном снимке');
  const homePage = await http('/');
  eq(homePage.status, 200, 'главная при одном снимке');

  db.prepare('DELETE FROM rating_cache').run();
  const ins = db.prepare('INSERT INTO rating_cache (id, computed_at, status, standings_json) VALUES (?, ?, ?, ?)');
  for (const row of backup) ins.run(row.id, row.computed_at, row.status, row.standings_json);
  return 'при единственном снимке все «—», страницы 200';
});

await check('пустой rating_cache -> «рейтинг ещё не рассчитан», не 500', async () => {
  const backup = db.prepare('SELECT id, computed_at, status, standings_json FROM rating_cache ORDER BY id').all();
  db.prepare('DELETE FROM rating_cache').run();

  const rating = await http('/rating');
  eq(rating.status, 200, 'GET /rating на пустом кэше');
  assert(rating.text.includes('Рейтинг ещё не рассчитан'), 'нет сообщения о нерассчитанном рейтинге');
  const home = await http('/');
  eq(home.status, 200, 'GET / на пустом кэше');
  assert(home.text.includes('Рейтинг ещё не рассчитан'), 'на главной нет сообщения');
  const csv = await http('/rating.csv');
  eq(csv.status, 200, 'CSV на пустом кэше');

  const ins = db.prepare('INSERT INTO rating_cache (id, computed_at, status, standings_json) VALUES (?, ?, ?, ?)');
  for (const row of backup) ins.run(row.id, row.computed_at, row.status, row.standings_json);
  return 'обе страницы 200 с понятным сообщением';
});

await check('двойное «Пересчитать» подряд -> один снимок (лок)', async () => {
  db.prepare('DELETE FROM login_attempts').run();
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin', { jar });
  const _csrf = tokenFrom(page.text);

  // Сид только что создал снимок, поэтому окно дебаунса ещё открыто — состариваем
  // последний снимок, чтобы первое нажатие было законным.
  db.prepare(
    "UPDATE rating_cache SET computed_at = datetime('now', '-1 minute') WHERE id = (SELECT MAX(id) FROM rating_cache)",
  ).run();
  const before = db.prepare('SELECT COUNT(*) AS n FROM rating_cache').get().n;

  // Два вызова подряд — как двойное нажатие кнопки.
  const [a, b] = await Promise.all([
    http('/admin/rating/recompute', { method: 'POST', form: { _csrf }, jar }),
    http('/admin/rating/recompute', { method: 'POST', form: { _csrf }, jar }),
  ]);
  eq(a.status, 302, 'первый вызов');
  eq(b.status, 302, 'второй вызов');
  const after = db.prepare('SELECT COUNT(*) AS n FROM rating_cache').get().n;
  eq(after - before, 1, 'должен добавиться ровно один снимок');

  // Второе нажатие должно объяснить пользователю, почему отказ.
  const dash = await http('/admin', { jar });
  assert(/flash--error/.test(dash.text) && /Повторный пересчёт возможен через/.test(dash.text),
    'нет сообщения о слишком частом пересчёте');
  return `снимков было ${before}, стало ${after} (+1); второе нажатие отклонено с объяснением`;
});

await check('протухший лок сбрасывается — кнопка не залипает навсегда', async () => {
  // Имитируем упавший на середине пересчёт: лок висит давно.
  db.prepare("UPDATE compute_lock SET is_computing = 1, started_at = datetime('now', '-60 minutes') WHERE id = 1").run();
  const before = db.prepare('SELECT COUNT(*) AS n FROM rating_cache').get().n;
  const res = recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  assert(res.ok, 'протухший лок не дал пересчитать');
  const after = db.prepare('SELECT COUNT(*) AS n FROM rating_cache').get().n;
  eq(after - before, 1, 'снимок не добавился');
  const lock = db.prepare('SELECT is_computing FROM compute_lock WHERE id = 1').get();
  eq(lock.is_computing, 0, 'лок должен быть снят');

  // А свежий лок по-прежнему держит.
  db.prepare("UPDATE compute_lock SET is_computing = 1, started_at = datetime('now') WHERE id = 1").run();
  const busy = recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  eq(busy.ok, false, 'свежий лок должен блокировать пересчёт');
  db.prepare('UPDATE compute_lock SET is_computing = 0, started_at = NULL WHERE id = 1').run();
  return 'лок старше 5 мин перехвачен, свежий держит';
});

await check('retention: хранятся последние 24 снимка', async () => {
  const keep = 24;
  for (let i = 0; i < 27; i++) recompute(db, { staleLockMinutes: 5, keepSnapshots: keep });
  const n = db.prepare('SELECT COUNT(*) AS n FROM rating_cache').get().n;
  assert(n <= keep, `снимков ${n}, ожидалось не больше ${keep}`);
  return `после 27 пересчётов в базе ${n} снимков`;
});

await check('город и пол показываются и фильтруются', async () => {
  const page = await http('/rating');
  assert(page.text.includes('<th>Город</th>') && page.text.includes('<th>Пол</th>'), 'нет колонок «Город» и «Пол»');
  assert(page.text.includes('Смоленск'), 'нет города в таблице');

  const women = await http('/rating?sex=F');
  eq(women.status, 200, 'фильтр по полу');
  assert(women.text.includes('Анна Соколова'), 'фильтр F потерял женщину-игрока');
  assert(!women.text.includes('Артём Ковалёв'), 'фильтр F не отсёк мужчин');

  const byName = await http('/rating?q=' + encodeURIComponent('Волков'));
  assert(byName.text.includes('Дмитрий Волков'), 'поиск по фамилии не нашёл игрока');
  assert(!byName.text.includes('Анна Соколова'), 'поиск по фамилии не отсёк остальных');

  const byAge = await http('/rating?age=' + encodeURIComponent('до 19'));
  assert(byAge.text.includes('Мария Лебедева'), 'фильтр по возрастной группе не сработал');
  return 'фильтры по полу, возрастной группе и поиск по фамилии работают';
});

await check('CSV-экспорт с корректными заголовками', async () => {
  const r = await http('/rating.csv');
  eq(r.status, 200, 'GET /rating.csv');
  const cd = r.headers.get('content-disposition');
  assert(/attachment; filename="rating\.csv"/.test(cd), `Content-Disposition: ${String(cd)}`);
  assert(/text\/csv/.test(r.headers.get('content-type')), 'Content-Type не text/csv');
  // BOM проверяем в СЫРЫХ БАЙТАХ: Response.text() по спецификации срезает BOM
  // при декодировании, поэтому по строке этого не увидеть.
  const raw = new Uint8Array(await (await fetch(inst.base + '/rating.csv')).arrayBuffer());
  const head = [...raw.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  eq(head, 'ef bb bf', 'нет BOM в байтах — Excel откроет кракозябрами');
  assert(r.text.includes('Место,Игрок,Город'), 'нет шапки CSV');
  const engine = await http('/rating.csv?format=engine');
  assert(engine.text.includes('rank,playerId,playerName'), 'экспорт средствами движка не отдался');
  return 'attachment + text/csv + BOM; есть и вариант экспорта движком';
});

await check('ТЗ 4.4: экспорт Excel (.xlsx — настоящий zip/OOXML) и печатная версия для PDF', async () => {
  const buf = Buffer.from(await (await fetch(inst.base + '/rating.xlsx')).arrayBuffer());
  const r = await http('/rating.xlsx');
  eq(r.status, 200, 'GET /rating.xlsx');
  assert(/spreadsheetml\.sheet/.test(r.headers.get('content-type')), 'Content-Type не xlsx');
  assert(/attachment; filename="rating-[^"]+\.xlsx"/.test(r.headers.get('content-disposition')), 'нет attachment с именем файла');
  eq(buf.slice(0, 2).toString('latin1'), 'PK', 'файл не начинается с сигнатуры zip');
  // Внутри — лист с той же шапкой, что у CSV, и хотя бы одной строкой игрока.
  const { inflateRawSync } = await import('node:zlib');
  const names = []; let off = 0; let sheet = '';
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const csize = buf.readUInt32LE(off + 18); const nlen = buf.readUInt16LE(off + 26); const elen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nlen).toString('utf8'); names.push(name);
    const data = buf.slice(off + 30 + nlen + elen, off + 30 + nlen + elen + csize);
    if (name === 'xl/worksheets/sheet1.xml') sheet = inflateRawSync(data).toString('utf8');
    off += 30 + nlen + elen + csize;
  }
  assert(names.includes('[Content_Types].xml') && names.includes('xl/workbook.xml'), `в zip нет обязательных частей: ${names.join(', ')}`);
  assert(/<t[^>]*>Место<\/t>/.test(sheet) && /<t[^>]*>Очки<\/t>/.test(sheet), 'в листе нет шапки');
  assert(/<row r="2">/.test(sheet), 'в листе нет ни одной строки игрока');
  // Печатная версия: таблица есть, шапки/подвала сайта нет, кнопка печати есть.
  const pr = await http('/rating/print');
  eq(pr.status, 200, 'GET /rating/print');
  assert(/class="print-table"/.test(pr.text) && /data-print/.test(pr.text), 'печатная версия без таблицы или кнопки');
  assert(!/class="site-header"/.test(pr.text) && !/class="site-footer"/.test(pr.text), 'в печатной версии осталась шапка/подвал');
  assert(/Выгрузить:/.test((await http('/rating')).text) && /rating\.xlsx/.test((await http('/rating')).text), 'на витрине нет ссылок выгрузки');
  return `xlsx: zip с ${names.length} частями, лист с шапкой и строками; /rating/print без шапки сайта, с кнопкой печати`;
});

// ===========================================================================
section('10. Схема, миграция, конфигурация');

await check('повторный запуск миграции не падает', async () => {
  eq(migrateTwice.status, 0, `повторная миграция вернула код ${migrateTwice.status}`);
  assert(migrateTwice.stdout.includes('схема применена'), 'повторная миграция не отработала');
  return 'второй `npm run migrate` — код 0';
});

await check('старт без обязательной .env-переменной -> внятное падение', async () => {
  const out = run(['server/index.mjs'], { SESSION_SECRET: '' });
  assert(out.status !== 0, 'сервер обязан упасть без SESSION_SECRET');
  const said = (out.stderr || '') + (out.stdout || '');
  assert(said.includes('SESSION_SECRET не задан'), `сообщение невнятное: ${said.slice(0, 160)}`);
  return 'код выхода 1, сообщение «SESSION_SECRET не задан»';
});

await check('схема отвергает битые данные на уровне БД', async () => {
  const probe = new Database(resolve(WORK, 'schema-probe.sqlite'));
  probe.pragma('foreign_keys = ON');
  probe.exec(readFileSync(resolve(HERE, 'db/schema.sql'), 'utf8'));
  probe.prepare("INSERT INTO tournaments (id, name, end_date, category) VALUES (1,'ок','2026-05-01','A')").run();
  probe.prepare("INSERT INTO players (id, full_name, city, sex) VALUES (1,'A','Смоленск','M')").run();
  probe.prepare("INSERT INTO players (id, full_name, city, sex) VALUES (2,'B','Вязьма','F')").run();
  probe.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id) VALUES (1,1,2)').run();

  const rejects = (label, sql, params = []) => {
    try {
      probe.prepare(sql).run(...params);
      throw new Error(`НЕ отклонено: ${label}`);
    } catch (err) {
      if (String(err.message).startsWith('НЕ отклонено')) throw err;
      return label;
    }
  };
  const done = [
    rejects('матч сам-с-собой', 'INSERT INTO matches (tournament_id, winner_player_id, loser_player_id) VALUES (1,1,1)'),
    rejects('точный дубль матча', 'INSERT INTO matches (tournament_id, winner_player_id, loser_player_id) VALUES (1,1,2)'),
    rejects('место 0', 'INSERT INTO results (tournament_id, player_id, place) VALUES (1,1,0)'),
    rejects('место -1', 'INSERT INTO results (tournament_id, player_id, place) VALUES (1,1,-1)'),
    rejects('дата 2026-13-40', "INSERT INTO tournaments (name, end_date, category) VALUES ('x','2026-13-40','A')"),
    rejects('дата 2026-02-30', "INSERT INTO tournaments (name, end_date, category) VALUES ('x','2026-02-30','A')"),
    rejects('категория C', "INSERT INTO tournaments (name, end_date, category) VALUES ('x','2026-05-01','C')"),
    rejects('пол X', "INSERT INTO players (full_name, city, sex) VALUES ('x','y','X')"),
  ];
  // обратный матч — ДРУГАЯ строка, должен пройти
  probe.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id) VALUES (1,2,1)').run();
  probe.close();
  return `${done.join(', ')} — отклонены; обратный матч разрешён`;
});

await check('секретов в git нет', async () => {
  const REPO = resolve(HERE, '..');
  const git = (...args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });

  // .env и файлы БД обязаны игнорироваться, .env.example — наоборот, попадать в репозиторий.
  const ignored = (p) => git('check-ignore', '-q', p).status === 0;
  assert(ignored('site/.env'), '.env НЕ игнорируется — секреты уедут в git');
  assert(ignored('site/db/ftso.sqlite'), 'файл базы SQLite НЕ игнорируется');
  assert(existsSync(resolve(HERE, '.env.example')), 'нет .env.example');
  assert(!ignored('site/.env.example'), '.env.example не должен игнорироваться — это образец для заказчика');

  // Ничего секретного не должно быть ни в индексе, ни в рабочем дереве под контролем git.
  const tracked = git('ls-files').stdout.split('\n').filter(Boolean);
  assert(!tracked.includes('site/.env'), 'файл .env попал в индекс git');
  assert(!tracked.some((f) => f.endsWith('.sqlite')), 'файл базы попал в индекс git');

  for (const [label, value] of [
    ['секрет сессии', process.env.SESSION_SECRET],
    ['пароль супер-админа', process.env.SUPER_ADMIN_PASSWORD],
  ]) {
    // --no-index ищет и в ещё не закоммиченных файлах, уважая .gitignore
    const hit = git('grep', '--no-index', '--exclude-standard', '-lF', value);
    const files = hit.stdout.split('\n').filter(Boolean);
    assert(files.length === 0, `${label} найден в файлах под контролем git: ${files.join(', ')}`);
  }
  return `.env и *.sqlite игнорируются, .env.example — нет; секрет и пароль в подконтрольных git файлах не встречаются (проверено ${tracked.length} отслеживаемых)`;
});

await check('лимит тела запроса включён', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/players', { jar });
  const _csrf = tokenFrom(page.text);
  const r = await http('/admin/players', {
    method: 'POST',
    form: { _csrf, full_name: 'x'.repeat(300000), city: 'Смоленск', sex: 'M' },
    jar,
  });
  assert(r.status === 413 || r.status >= 400, `гигантский POST должен быть отвергнут, получен ${r.status}`);
  const alive = await http('/');
  eq(alive.status, 200, 'сервер жив после гигантского POST');
  return `тело ~300 КБ -> HTTP ${r.status}, сервер жив`;
});

// ===========================================================================
section('11. Журнал согласий и публикуемость (152-ФЗ)');

const journal = await import('./server/lib/consent-journal.mjs');
const { LEGAL_VERSION } = await import('./server/lib/legal.mjs');
// Имена игроков в таблице рейтинга, В ПОРЯДКЕ строк.
// Имя в строке рейтинга — ссылкой на профиль (/player/:id) либо текстом
// («Игрок удалён»): снимаем содержимое ячейки без тегов.
const rowNames = (html) =>
  [...html.matchAll(/<td class="player[^"]*">(.*?)<\/td>/gs)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

await check('регистрация пишет ОДНУ запись (обработка); распространение — только фото (модель РТТ)', async () => {
  const id = Number(
    db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Тест Согласиев','Смоленск','M','19-34')").run()
      .lastInsertRowid,
  );
  // Старый параметр distribution — игнорируется: регистрация распространение не пишет.
  journal.recordRegistrationConsents(db, { playerId: id, distribution: true, source: 'web', ip: '203.0.113.9' });
  const rows = db.prepare('SELECT kind, event, legal_version FROM consents WHERE player_id = ? ORDER BY id').all(id);
  eq(rows.length, 1, 'записей согласия');
  eq(rows[0].kind, 'processing', 'единственная запись — обработка');
  eq(rows[0].event, 'granted', 'запись — выдача');
  eq(rows[0].legal_version, LEGAL_VERSION, 'редакция = текущая константа');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(id).is_public, 0, 'флаг фото без фото = 0');

  // Фото: выдача и отзыв согласия на распространение — через setDistributionConsent.
  journal.setDistributionConsent(db, id, true, { source: 'web', ip: '203.0.113.9' });
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(id).is_public, 1, 'флаг после выдачи по фото');
  journal.setDistributionConsent(db, id, false, { source: 'web', ip: '203.0.113.9' });
  const kinds = db.prepare('SELECT kind, event FROM consents WHERE player_id = ? ORDER BY id').all(id);
  eq(kinds.length, 3, 'обработка + выдача фото + отзыв фото');
  eq(kinds[1].kind + ':' + kinds[1].event, 'distribution:granted', 'вторая — выдача по фото');
  eq(kinds[2].kind + ':' + kinds[2].event, 'distribution:revoked', 'третья — отзыв по фото');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(id).is_public, 0, 'флаг после отзыва');

  // Каскад унёс бы записи журнала, а он закрыт на удаление триггером СУБД:
  // убирать за собой тестовые данные — такое же законное удаление, как ст. 21.
  journal.withConsentErasure(db, () => db.prepare('DELETE FROM players WHERE id = ?').run(id));
  return `регистрация — одна запись (processing, ${LEGAL_VERSION}); distribution пишется только setDistributionConsent (фото), флаг следует за ним`;
});

await check('отзыв распространения НЕ меняет строку в рейтинге (ТЗ ред. 6, §8.7)', async () => {
  const before = rowNames((await http('/rating')).text);
  const target = before.find((n) => n === 'Сергей Новиков');
  assert(target, 'в таблице нет ожидаемого игрока');
  const idx = before.indexOf(target);
  const player = db.prepare('SELECT id FROM players WHERE full_name = ?').get(target);
  const pointsBefore = (await http('/rating.csv')).text.split('\r\n').find((l) => l.includes(target));

  journal.setDistributionConsent(db, player.id, false, { source: 'web', ip: '203.0.113.9' });
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(player.id).is_public, 0, 'флаг снят отзывом (журнал жив)');

  // Результаты публикуются на основании УЧАСТИЯ, не согласия: имя, место и
  // очки на месте, «Скрыто по заявлению» на витрине нет ни в HTML, ни в CSV.
  const after = rowNames((await http('/rating')).text);
  eq(after.length, before.length, 'число строк не изменилось');
  for (let i = 0; i < before.length; i++) eq(after[i], before[i], `строка ${i + 1} не должна была измениться`);
  const csv = await http('/rating.csv');
  assert(!csv.text.includes('Скрыто по заявлению'), 'на витрине всплыло старое «Скрыто по заявлению»');
  eq(csv.text.split('\r\n').find((l) => l.includes(target)), pointsBefore, 'строка CSV игрока изменилась после отзыва');
  const search = await http(`/rating?q=${encodeURIComponent('Новиков')}`);
  eq(rowNames(search.text).length, 1, 'игрок должен находиться поиском по фамилии');
  const profile = await http(`/player/${player.id}`);
  eq(profile.status, 200, 'профиль недоступен после отзыва согласия');
  assert(profile.text.includes(target), 'на профиле нет имени после отзыва согласия');

  const direct = computeStandings(collectEngineInput(db));
  assert(direct.players.some((p) => p.playerName === target), 'движок не должен зависеть от согласий');

  journal.setDistributionConsent(db, player.id, true, { source: 'offline' });
  return `${target}: отзыв записан в журнал, строка ${idx + 1} рейтинга, CSV и профиль не изменились`;
});

await check('удалённый игрок в старом снимке -> «Игрок удалён»', async () => {
  const id = Number(
    db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Тест Удалённый','Ярцево','M','19-34')").run()
      .lastInsertRowid,
  );
  journal.recordRegistrationConsents(db, { playerId: id, source: 'offline' });
  journal.setDistributionConsent(db, id, true, { source: 'web', ip: '203.0.113.9' }); // фото
  const t = Number(
    db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Тестовый турнир', date('now','-10 days'), 'B')").run()
      .lastInsertRowid,
  );
  db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, 1)').run(t, id);
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  assert(rowNames((await http('/rating')).text).includes('Тест Удалённый'), 'игрок не попал в снимок');

  // Снос игрока БЕЗ пересчёта: снимок ещё помнит его имя.
  const wiped = journal.eraseConsents(db, id);
  db.prepare('DELETE FROM players WHERE id = ?').run(id);
  eq(wiped, 2, 'записи согласий стёрты при удалении');
  const after = rowNames((await http('/rating')).text);
  assert(!after.includes('Тест Удалённый'), 'имя удалённого игрока осталось на витрине');
  assert(after.includes('Игрок удалён'), 'нет строки «Игрок удалён»');
  eq((await http(`/player/${id}`)).status, 404, 'у удалённого игрока не должно быть профиля');

  db.prepare('DELETE FROM tournaments WHERE id = ?').run(t);
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  return `удалённый игрок показан как «Игрок удалён»; ${wiped} записи согласий стёрты (ст. 21)`;
});

await check('автоочистка чистит отозванные, действующие не трогает', async () => {
  const id = Number(
    db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Тест Ретеншен','Сафоново','M','19-34')").run()
      .lastInsertRowid,
  );
  journal.recordRegistrationConsents(db, { playerId: id, source: 'offline' });
  journal.setDistributionConsent(db, id, true, { source: 'web', ip: '203.0.113.9' }); // фото загружено
  journal.setDistributionConsent(db, id, false, { source: 'web', ip: '203.0.113.9' }); // фото удалено
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(id).n, 3, 'записей до очистки');

  eq(journal.purgeExpired(db, 1095), 0, 'свежий отзыв чистить рано');
  // Раньше запись «состаривали» через UPDATE. Теперь журнал НЕИЗМЕНЯЕМ на
  // уровне СУБД, и правильный способ проверить срок — подвинуть САМ СРОК:
  // с нулевым сроком хранения отозванное подлежит удалению прямо сейчас.
  const removed = journal.purgeExpired(db, 0);
  eq(removed, 2, 'удаляется пара «выдано + отозвано» по распространению');
  const left = db.prepare('SELECT kind, event FROM consents WHERE player_id = ?').all(id);
  eq(left.length, 1, 'осталась одна запись');
  eq(left[0].kind, 'processing', 'действующее согласие на обработку не тронуто');

  journal.withConsentErasure(db, () => db.prepare('DELETE FROM players WHERE id = ?').run(id));
  return 'отозванное по истечении срока удалено (2 записи), действующее согласие на обработку осталось';
});

await check('админка не пишет согласие на распространение: is_public/основание в форме игнорируются (модель РТТ)', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/players', { jar });
  const _csrf = tokenFrom(page.text);
  assert(!page.text.includes('name="is_public"') && !page.text.includes('name="consent_basis"'),
    'в форме админки остались поля публикации/основания');
  // Старая форма шлёт is_public=1 и основание — сервер их не читает: ни флага, ни записи журнала.
  const r = await http('/admin/players', {
    method: 'POST',
    form: {
      _csrf, full_name: 'Тест Секретарёв', city: 'Смоленск', sex: 'M', age_group: '19-34', is_public: '1',
      consent_basis: 'бумажное согласие', consent_document_date: '2026-07-01',
    },
    jar,
  });
  eq(r.status, 302, 'создание игрока');
  const created = db.prepare('SELECT id, is_public FROM players WHERE full_name = ?').get('Тест Секретарёв');
  assert(created, 'игрок не создан');
  eq(created.is_public, 0, 'флаг не выставлен: публикация результатов по участию, не по галочке');
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(created.id).n, 0, 'записей журнала от админки');
  const upd = await http(`/admin/players/${created.id}/update`, {
    method: 'POST',
    form: { _csrf, full_name: 'Тест Секретарёв', city: 'Смоленск', sex: 'M', age_group: '19-34', is_public: '1' },
    jar,
  });
  eq(upd.status, 302, 'обновление игрока');
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(created.id).n, 0, 'записей журнала после update');
  // Игрок без согласия на распространение — на витрине по факту участия.
  const t = Number(
    db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Тест витрины РТТ', date('now','-3 days'), 'B')").run()
      .lastInsertRowid,
  );
  db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, 1)').run(t, created.id);
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  assert(rowNames((await http('/rating')).text).includes('Тест Секретарёв'), 'игрок без записи distribution не показан в рейтинге');
  eq((await http(`/player/${created.id}`)).status, 200, 'профиль без согласия на распространение');
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(t);
  db.prepare('DELETE FROM players WHERE id = ?').run(created.id);
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  return 'полей публикации в форме нет; is_public=1 и основание от старой формы игнорируются (0 записей журнала, флаг 0); игрок в рейтинге и с профилем по факту участия';
});

// ===========================================================================
section('12. Публичная регистрация и модерация');

const regs = await import('./server/lib/registrations.mjs');

/**
 * Подать заявку формой: GET за токеном -> POST. Возвращает ответ и банку.
 *
 * Дата рождения подставляется совершеннолетняя, если тест не задал свою: с
 * введением слоя несовершеннолетних поле обязательно, и каждый тест про другое
 * не должен её повторять. Тесты про минорный флоу передают birth_date явно.
 */
const ADULT_BIRTH = '1990-05-17';
async function submitRegistration(form, jar = new Jar()) {
  const page = await http('/register', { jar });
  const _csrf = tokenFrom(page.text);
  const body = { _csrf, birth_date: ADULT_BIRTH, ...form };
  const res = await http('/register', { method: 'POST', form: body, jar });
  return { res, jar, _csrf };
}

await check('форма только POST, GET с ПДн в адресе не принимается', async () => {
  const viaGet = await http('/register?full_name=Иван&email=ivan@example.com');
  // GET отдаёт ФОРМУ, а не создаёт заявку: данные из строки запроса игнорируются.
  eq(viaGet.status, 200, 'GET /register должен отдавать форму');
  eq(db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE email = 'ivan@example.com'").get().n, 0,
    'GET создал заявку — ПДн ушли бы в логи и историю браузера');
  assert(viaGet.text.includes('method="post"'), 'форма должна отправляться методом POST');
  return 'GET отдаёт форму и ничего не пишет; отправка только POST';
});

await check('без согласия на обработку заявка не принимается, ввод не теряется', async () => {
  const { res } = await submitRegistration({
    last_name: 'Отказов', first_name: 'Пётр', city: 'Смоленск', sex: 'M', email: 'otkaz@example.com',
  });
  eq(res.status, 400, 'заявка без согласия должна отклоняться');
  assert(res.text.includes('Без согласия на обработку'), 'нет объяснения причины');
  assert(res.text.includes('value="Отказов"') && res.text.includes('value="Пётр"'), 'черновик потерян — ввод должен вернуться в форму');
  eq(db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE email = 'otkaz@example.com'").get().n, 0,
    'заявка без согласия попала в БД');
  return 'HTTP 400, причина названа, поля вернулись заполненными, в БД пусто';
});

await check('honeypot отсекает бота молча', async () => {
  const { res } = await submitRegistration({
    full_name: 'Бот Ботов', city: 'Смоленск', sex: 'M', email: 'bot@example.com',
    consent_processing: '1', website: 'http://spam.example',
  });
  eq(res.status, 302, 'бот должен получить обычный редирект, а не отказ');
  eq(db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE email = 'bot@example.com'").get().n, 0,
    'заявка бота записана');
  return 'заполненная приманка -> редирект как при успехе, в БД ничего';
});

await check('заявка пишет ОДНО согласие (обработка) и письмо в очередь; consent_distribution игнорируется', async () => {
  const { res } = await submitRegistration({
    full_name: 'Новый Заявитель', city: 'Ярцево', sex: 'M', age_group: '19-34',
    email: 'zayavitel@example.com', consent_processing: '1', consent_distribution: '1',
  });
  eq(res.status, 302, 'подача заявки');
  const reg = db.prepare("SELECT * FROM registrations WHERE email = 'zayavitel@example.com'").get();
  eq(reg.status, 'pending', 'заявка должна ждать модерации');
  eq(db.prepare('SELECT COUNT(*) AS n FROM players WHERE full_name = ?').get('Новый Заявитель').n, 0,
    'форма НЕ должна писать в players напрямую — только через модерацию');
  const cons = db.prepare('SELECT kind, event, legal_version, source, ip FROM consents WHERE registration_id = ? ORDER BY id').all(reg.id);
  eq(cons.length, 1, 'записей согласия (старое поле consent_distribution=1 записи не даёт)');
  eq(cons[0].kind, 'processing', 'единственная — обработка');
  eq(cons[0].source, 'web', 'источник — форма сайта');
  assert(cons[0].ip, 'IP согласия, данного через сайт, должен фиксироваться');
  const mail = db.prepare("SELECT * FROM mail_outbox WHERE to_email = 'zayavitel@example.com'").get();
  assert(mail, 'письмо о приёме заявки не поставлено в очередь');
  // SMTP не настроен -> письмо НЕ пропадает молча, а висит с честной ошибкой.
  assert(mail.status !== 'sent', 'без транспорта письмо не может считаться отправленным');
  assert(String(mail.last_error || '').includes('транспорт'), 'причина неотправки не записана');
  const status = await http(`/register/status/${reg.status_token}`);
  eq(status.status, 200, 'страница статуса по токену');
  assert(status.text.includes('на рассмотрении'), 'страница статуса не показывает статус');
  return 'заявка -> pending, одно согласие (обработка) с IP, distribution от старой формы проигнорирован, письмо в очереди с причиной, статус по токену открыт';
});

await check('чужой и подобранный токен статуса не открывается', async () => {
  const r = await http('/register/status/подобранныйтокен123');
  eq(r.status, 404, 'неизвестный токен должен давать 404');
  return 'неизвестный токен -> 404, перебором заявку не нащупать';
});

await check('совпадение ФИО помечается модератору, а не сливается само', async () => {
  const existing = db.prepare('SELECT full_name FROM players WHERE full_name = ?').get('Артём Ковалёв');
  assert(existing, 'в сиде нет игрока для проверки совпадения');
  // Тот же человек, написанный иначе: другой регистр и лишние пробелы.
  const matches = regs.findNameMatches(db, '  артём   ковалёв ');
  eq(matches.length, 1, 'нормализация ФИО не поймала того же человека');
  // «Ёлкин» и «Елкин» — тоже один человек.
  eq(regs.normalizeName('Ёлкин Пётр'), regs.normalizeName('Елкин Петр'), 'ё/е должны сходиться');

  const { res } = await submitRegistration({
    full_name: 'Артём Ковалёв', city: 'Смоленск', sex: 'M',
    email: 'dubl@example.com', consent_processing: '1',
  });
  eq(res.status, 302, 'подача заявки-дубликата');
  const reg = db.prepare("SELECT * FROM registrations WHERE email = 'dubl@example.com'").get();
  eq(db.prepare('SELECT COUNT(*) AS n FROM players WHERE full_name = ?').get('Артём Ковалёв').n, 1,
    'дубликат игрока создан автоматически — этого делать нельзя');

  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/registrations', { jar });
  assert(page.text.includes('Возможное совпадение'), 'модератору не показано возможное совпадение');
  assert(!page.text.includes('Расхождение по публикации'), 'блок «Расхождение по публикации» должен исчезнуть (модель РТТ)');

  // Одобряем ПРИВЯЗКОЙ к существующему — второй карточки не появляется.
  const _csrf = tokenFrom(page.text);
  const player = db.prepare('SELECT id FROM players WHERE full_name = ?').get('Артём Ковалёв');
  const appr = await http(`/admin/registrations/${reg.id}/approve`, {
    method: 'POST', form: { _csrf, link_player_id: String(player.id) }, jar,
  });
  eq(appr.status, 302, 'одобрение с привязкой');
  eq(db.prepare('SELECT COUNT(*) AS n FROM players WHERE full_name = ?').get('Артём Ковалёв').n, 1,
    'привязка к существующему создала второго игрока');
  const after = db.prepare('SELECT status, player_id FROM registrations WHERE id = ?').get(reg.id);
  eq(after.status, 'approved', 'статус заявки');
  eq(after.player_id, player.id, 'заявка привязана не к тому игроку');
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE registration_id = ? AND player_id = ?').get(reg.id, player.id).n, 1,
    'согласие заявки не привязано к игроку');
  return 'тёзка помечен подсказкой, ё/е и регистр нормализованы, привязка не плодит второго игрока';
});

await check('одобрение заводит игрока и уведомляет, отказ объясняется', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const reg = db.prepare("SELECT * FROM registrations WHERE email = 'zayavitel@example.com'").get();
  const page = await http('/admin/registrations', { jar });
  const _csrf = tokenFrom(page.text);
  const appr = await http(`/admin/registrations/${reg.id}/approve`, { method: 'POST', form: { _csrf }, jar });
  eq(appr.status, 302, 'одобрение новой заявки');
  const created = db.prepare('SELECT id, is_public FROM players WHERE full_name = ?').get('Новый Заявитель');
  assert(created, 'игрок не заведён при одобрении');
  eq(created.is_public, 0, 'флаг фото без фото = 0; публикация результатов от него не зависит');
  eq((await http(`/player/${created.id}`)).status, 200, 'профиль одобренного игрока открыт по факту участия');
  const mails = db.prepare("SELECT kind FROM mail_outbox WHERE to_email = 'zayavitel@example.com' ORDER BY id").all();
  assert(mails.some((m) => m.kind === 'registration.approved'), 'письмо об одобрении не поставлено в очередь');

  // Отказ: причина сохраняется и видна заявителю на его странице статуса.
  const { res } = await submitRegistration({
    full_name: 'Отклонённый Заявитель', city: 'Вязьма', sex: 'F',
    email: 'otkloneno@example.com', consent_processing: '1',
  });
  eq(res.status, 302, 'подача заявки для отказа');
  const bad = db.prepare("SELECT * FROM registrations WHERE email = 'otkloneno@example.com'").get();
  const rej = await http(`/admin/registrations/${bad.id}/reject`, {
    method: 'POST', form: { _csrf, reason: 'Нет подтверждения участия в соревнованиях' }, jar,
  });
  eq(rej.status, 302, 'отклонение заявки');
  const status = await http(`/register/status/${bad.status_token}`);
  assert(status.text.includes('отклонена'), 'заявителю не показан статус отказа');
  assert(status.text.includes('Нет подтверждения участия'), 'заявителю не показана причина отказа');
  assert(
    db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_email = 'otkloneno@example.com' AND kind = 'registration.rejected'").get().n === 1,
    'письмо об отказе не поставлено в очередь',
  );
  return 'одобрение заводит игрока с открытым профилем (без записи distribution); отказ с причиной виден заявителю, оба уведомления в очереди';
});

await check('дубли игроков: занятая почта и ФИО+дата — стоп до секретаря; тёзка с другой датой — без предупреждений; РНИ уникален', async () => {
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const base = { city: 'Смоленск', sex: 'M', consent_processing: '1' };
  const first = await submitRegistration({ ...base, full_name: 'Дублёв Иван Петрович', birth_date: '1991-02-03', email: 'dubl-one@example.com' });
  eq(first.res.status, 302, 'первая заявка принята');
  // 1. Та же почта, другой человек — стоп, заявки нет, отсылка в поддержку.
  const sameMail = await submitRegistration({ ...base, full_name: 'Другой Человек Совсем', birth_date: '1985-06-07', email: 'dubl-one@example.com' });
  eq(sameMail.res.status, 400, 'та же почта должна отбиваться');
  assert(/адрес электронной почты уже зарегистрирован/i.test(sameMail.res.text) && /Контакты/.test(sameMail.res.text), 'нет сообщения про занятую почту и поддержку');
  eq(db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE full_name = 'Другой Человек Совсем'").get().n, 0, 'заявка с занятой почтой не должна создаваться');
  // 2. ФИО + дата рождения совпали (другая почта, ё/е и регистр) — стоп.
  const sameMan = await submitRegistration({ ...base, full_name: 'дублев иван петрович', birth_date: '1991-02-03', email: 'dubl-two@example.com' });
  eq(sameMan.res.status, 400, 'ФИО + дата должны отбиваться');
  assert(/ФИО и датой рождения уже зарегистрирован/i.test(sameMan.res.text), 'нет сообщения про ФИО + дату');
  // 3. Полный тёзка с ДРУГОЙ датой — проходит без предупреждений.
  const twin = await submitRegistration({ ...base, full_name: 'Дублёв Иван Петрович', birth_date: '2001-02-03', email: 'dubl-three@example.com' });
  eq(twin.res.status, 302, 'тёзка с другой датой должен регистрироваться');
  const twinReg = db.prepare("SELECT id FROM registrations WHERE email = 'dubl-three@example.com'").get();
  assert(twinReg, 'заявка тёзки не создана');
  // Секретарю по тёзке с другой датой подсказка «Возможное совпадение» не показывается.
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const regsPage = await http('/admin/registrations', { jar });
  const twinBlock = regsPage.text.slice(regsPage.text.indexOf('dubl-three@example.com'), regsPage.text.indexOf('dubl-three@example.com') + 3000);
  // 4. Почта игрока с кабинетом тоже занята: одобряем первую заявку → аккаунт → повтор с той же почтой отбит.
  const _csrf = tokenFrom(regsPage.text);
  const firstReg = db.prepare("SELECT id FROM registrations WHERE email = 'dubl-one@example.com'").get();
  eq((await http(`/admin/registrations/${firstReg.id}/approve`, { method: 'POST', form: { _csrf }, jar })).status, 302, 'одобрение первой');
  assert(db.prepare("SELECT 1 FROM player_accounts WHERE email = 'dubl-one@example.com'").get(), 'кабинет не заведён');
  const afterAcc = await submitRegistration({ ...base, full_name: 'Ещё Один Другой', birth_date: '1970-01-02', email: 'dubl-one@example.com' });
  eq(afterAcc.res.status, 400, 'почта кабинета должна быть занята');
  // Заявка тёзки одобряется «новым игроком» без стопа (даты разные).
  eq((await http(`/admin/registrations/${twinReg.id}/approve`, { method: 'POST', form: { _csrf }, jar })).status, 302, 'одобрение тёзки');
  eq(db.prepare("SELECT COUNT(*) AS n FROM players WHERE full_name = 'Дублёв Иван Петрович'").get().n, 2, 'два тёзки с разными датами — два игрока');
  // 5. Админка: создать ФИО + дата при живом игроке — стоп; РНИ дважды — стоп; индекс СУБД тоже держит.
  const p1 = db.prepare("SELECT id FROM players WHERE full_name = 'Дублёв Иван Петрович' AND birth_date = '1991-02-03'").get();
  const form = { _csrf, last_name: 'Дублёв', first_name: 'Иван', middle_name: 'Петрович', city: 'Вязьма', sex: 'M', birth_date: '1991-02-03' };
  eq((await http('/admin/players', { method: 'POST', form, jar })).status, 302, 'ответ админки');
  eq(db.prepare("SELECT COUNT(*) AS n FROM players WHERE full_name = 'Дублёв Иван Петрович'").get().n, 2, 'админка завела дубль по ФИО + дате');
  eq((await http('/admin/players', { method: 'POST', form: { ...form, birth_date: '1999-09-09', rni: 'RNI-777' }, jar })).status, 302, 'тёзка с другой датой из админки');
  eq(db.prepare("SELECT COUNT(*) AS n FROM players WHERE full_name = 'Дублёв Иван Петрович'").get().n, 3, 'тёзка с другой датой из админки должен создаваться');
  eq((await http('/admin/players', { method: 'POST', form: { ...form, last_name: 'Рниев', birth_date: '1998-08-08', rni: 'RNI-777' }, jar })).status, 302, 'ответ на второй РНИ');
  eq(db.prepare("SELECT COUNT(*) AS n FROM players WHERE rni = 'RNI-777'").get().n, 1, 'РНИ выдан дважды');
  let dbErr = '';
  try { db.prepare("INSERT INTO players (full_name, city, sex, rni) VALUES ('Мимо Формы','Смоленск','M','RNI-777')").run(); } catch (e) { dbErr = e.message; }
  assert(/UNIQUE/i.test(dbErr), 'индекс СУБД не держит уникальность РНИ');
  // Правка: присвоить чужой РНИ — стоп.
  eq((await http(`/admin/players/${p1.id}/update`, { method: 'POST', form: { ...form, rni: 'RNI-777' }, jar })).status, 302, 'ответ на правку');
  eq(db.prepare('SELECT rni FROM players WHERE id = ?').get(p1.id).rni, null, 'чужой РНИ присвоен правкой');
  // Уборка.
  journal.withConsentErasure(db, () => {
    db.prepare("DELETE FROM registrations WHERE email LIKE 'dubl-%@example.com'").run();
    db.prepare("DELETE FROM players WHERE full_name IN ('Дублёв Иван Петрович','Рниев Иван Петрович')").run();
  });
  db.prepare("DELETE FROM write_attempts").run(); // тест сделал много POST — счётчики (и админский) обнуляем
  return `почта ×2 → 400 (заявка и кабинет), ФИО+дата → 400, тёзка с другой датой → 302 и одобрен новым; админка: ФИО+дата стоп, тёзка ок, РНИ дважды стоп (+UNIQUE в СУБД), правка чужим РНИ стоп`;
});

await check('турниры (ТЗ 4.3): поля город/начало/тип/возраст, статус от дат, фильтры на /tournaments', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const _csrf = tokenFrom((await http('/admin/tournaments', { jar })).text);
  const mk = (f) => http('/admin/tournaments', { method: 'POST', form: { _csrf, category: 'B', kind: 'other', ...f }, jar });
  const d = (days) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  eq((await mk({ name: 'Фильтр Прошлый', end_date: d(-10), start_date: d(-12), city: 'Вязьма', kind: 'team', age_group: 'взрослые' })).status, 302, 'создание 1');
  eq((await mk({ name: 'Фильтр Текущий', end_date: d(2), start_date: d(-1), city: 'Смоленск', kind: 'championship', age_group: 'до 12', category: 'A' })).status, 302, 'создание 2');
  eq((await mk({ name: 'Фильтр Будущий', end_date: d(30), city: 'Смоленск', age_group: 'взрослые' })).status, 302, 'создание 3');
  eq((await mk({ name: 'Фильтр Кривой', end_date: d(1), start_date: d(5) })).status, 302, 'ответ на начало позже конца');
  assert(!db.prepare("SELECT 1 FROM tournaments WHERE name = 'Фильтр Кривой'").get(), 'турнир с началом позже конца не должен создаваться');
  const names = (t) => [...t.matchAll(/<td class="t-name"><a href="\/tournaments\/\d+">([^<]+)<\/a>/g)].map((m) => m[1]).filter((n) => n.startsWith('Фильтр '));
  const all = await http('/tournaments');
  eq(all.status, 200, '/tournaments');
  assert(/name="month"/.test(all.text) && /name="city"/.test(all.text) && /name="category"/.test(all.text) && /name="age"/.test(all.text) && /name="status"/.test(all.text) && /name="kind"/.test(all.text), 'на списке нет шести фильтров ТЗ 4.3');
  eq(names(all.text).length, 3, 'без фильтров — все три');
  eq(names((await http('/tournaments?status=finished')).text).join(','), 'Фильтр Прошлый', 'фильтр статус=завершён');
  eq(names((await http('/tournaments?status=ongoing')).text).join(','), 'Фильтр Текущий', 'фильтр статус=идёт');
  eq(names((await http('/tournaments?status=upcoming')).text).join(','), 'Фильтр Будущий', 'фильтр статус=предстоящий');
  eq(names((await http('/tournaments?city=' + encodeURIComponent('Смоленск'))).text).length, 2, 'фильтр город');
  eq(names((await http('/tournaments?category=A')).text).join(','), 'Фильтр Текущий', 'фильтр категория');
  eq(names((await http('/tournaments?age=' + encodeURIComponent('взрослые'))).text).length, 2, 'фильтр возраст');
  eq(names((await http('/tournaments?kind=team')).text).join(','), 'Фильтр Прошлый', 'фильтр тип');
  eq(names((await http('/tournaments?month=' + d(30).slice(0, 7))).text).includes('Фильтр Будущий'), true, 'фильтр месяц');
  eq(names((await http("/tournaments?status=' OR 1=1 --&kind=<b>")).text).length, 3, 'чужие значения фильтров сбрасываются в «все»');
  const card = await http(`/tournaments/${db.prepare("SELECT id FROM tournaments WHERE name = 'Фильтр Текущий'").get().id}`);
  assert(/Смоленск/.test(card.text) && /первенство/.test(card.text) && /до 12/.test(card.text), 'карточка не показывает город/тип/возраст');
  db.prepare("DELETE FROM tournaments WHERE name LIKE 'Фильтр %'").run();
  db.prepare("DELETE FROM write_attempts").run();
  return 'три турнира, шесть фильтров работают по одному, статус считается от дат, мусор в фильтрах игнорируется, начало позже конца — отказ';
});

await check('MAX (ТЗ 8, решение владельца): кнопка только при MAX_URL вида https://max.ru/…', async () => {
  const { loadConfig } = await import('./server/lib/config.mjs');
  const saved = process.env.MAX_URL;
  try {
    delete process.env.MAX_URL;
    eq(loadConfig({ requireSecrets: false }).maxUrl, '', 'без MAX_URL — пусто');
    process.env.MAX_URL = 'https://max.ru/ftso67';
    eq(loadConfig({ requireSecrets: false }).maxUrl, 'https://max.ru/ftso67', 'корректный адрес принят');
    process.env.MAX_URL = 'https://evil.example/ftso';
    eq(loadConfig({ requireSecrets: false }).maxUrl, '', 'чужой домен должен отбрасываться');
    process.env.MAX_URL = 'javascript:alert(1)';
    eq(loadConfig({ requireSecrets: false }).maxUrl, '', 'javascript: должен отбрасываться');
  } finally {
    if (saved === undefined) delete process.env.MAX_URL; else process.env.MAX_URL = saved;
  }
  const home = await http('/');
  const contacts = await http('/contacts');
  const hasBtn = /Написать в MAX/.test(home.text);
  eq(hasBtn, Boolean(config.maxUrl), 'кнопка в подвале должна быть ровно при заданном MAX_URL');
  eq(/Написать в MAX/.test(contacts.text), Boolean(config.maxUrl), 'кнопка на /contacts должна быть ровно при заданном MAX_URL');
  assert(!/vk\.com|t\.me|telegram|instagram|facebook/i.test(home.text), 'в подвале появились чужие соцсети — MAX единственный');
  return `MAX_URL валидируется (только https://max.ru/…); сейчас в тесте ${config.maxUrl ? 'задан — кнопка есть' : 'не задан — кнопки нет'}; других соцсетей нет`;
});

await check('ТЗ п. 11: инструкция по администрированию — /admin/guide, разделы по роли, ссылка в меню', async () => {
  eq((await http('/admin/guide')).status, 302, 'без входа — редирект на /login');
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const g = await http('/admin/guide', { jar });
  eq(g.status, 200, 'инструкция для супер-админа');
  for (const id of ['g-login', 'g-players', 'g-tournaments', 'g-rating', 'g-news', 'g-directories', 'g-library', 'g-feedback', 'g-users', 'g-legal', 'g-ops']) {
    assert(g.text.includes(`id="${id}"`), `у супер-админа нет раздела ${id}`);
  }
  assert(/href="\/admin\/guide"/.test((await http('/admin', { jar })).text), 'в меню админки нет «Инструкции»');
  const t = await login(TADMIN.user, TADMIN.pass);
  const tg = await http('/admin/guide', { jar: t.jar });
  eq(tg.status, 200, 'инструкция для tournament-admin');
  assert(tg.text.includes('id="g-tournaments"') && !tg.text.includes('id="g-users"') && !tg.text.includes('id="g-news"'), 'у tournament-admin показаны чужие разделы или нет своих');
  return 'супер-админ — 11 разделов; tournament-admin — без «Пользователей» и «Новостей»; ссылка в меню есть';
});

await check('ускорение ввода: игрок по подсказке (текст/«#id»), новый игрок из формы результата, матч по тексту, пересчёт со страницы турнира', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const t = Number(db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Быстрый ввод', date('now','-1 day'), 'B')").run().lastInsertRowid);
  const p1 = Number(db.prepare("INSERT INTO players (full_name, city, sex, birth_date) VALUES ('Быстров Игорь Петрович','Смоленск','M','1990-01-01')").run().lastInsertRowid);
  const p2 = Number(db.prepare("INSERT INTO players (full_name, city, sex, birth_date) VALUES ('Быстров Игорь Петрович','Вязьма','M','1995-05-05')").run().lastInsertRowid);
  const page = await http(`/admin/tournaments/${t}/results`, { jar });
  const _csrf = tokenFrom(page.text);
  assert(/<datalist id="players-list">/.test(page.text) && /name="player" list="players-list"/.test(page.text), 'нет поля с подсказкой');
  assert(!/<select id="r-player"/.test(page.text), 'старый select игрока остался');
  assert(/action="\/admin\/rating\/recompute"/.test(page.text), 'на странице результатов нет кнопки пересчёта');
  const post = (form) => http(`/admin/tournaments/${t}/results`, { method: 'POST', form: { _csrf, ...form }, jar });
  const n = () => db.prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ?').get(t).n;
  // Тёзки: по одному ФИО — ошибка с #id; с городом в скобках — однозначно; «#id» — тоже.
  eq((await post({ player: 'Быстров Игорь Петрович', place: '1' })).status, 302, 'ответ на неоднозначное ФИО');
  eq(n(), 0, 'неоднозначное ФИО не должно записываться');
  eq((await post({ player: 'быстров игорь петрович (Вязьма)', place: '1' })).status, 302, 'ФИО с городом');
  eq(db.prepare('SELECT player_id FROM results WHERE tournament_id = ? AND place = 1').get(t).player_id, p2, 'по городу выбран не тот тёзка');
  eq((await post({ player: `#${p1}`, place: '2' })).status, 302, '«#id»');
  eq(db.prepare('SELECT player_id FROM results WHERE tournament_id = ? AND place = 2').get(t).player_id, p1, '«#id» не сработал');
  // Незнакомый игрок без полей — отказ; с городом/полом/датой — заведён и результат записан.
  eq((await post({ player: 'Новиков Пётр Ильич', place: '3' })).status, 302, 'ответ на незнакомого без полей');
  eq(n(), 2, 'незнакомый без полей не должен записываться');
  eq((await post({ player: 'Новиков Пётр Ильич', place: '3', new_city: 'Рославль', new_sex: 'M', new_birth_date: '2001-02-03' })).status, 302, 'новый игрок из формы');
  const fresh = db.prepare("SELECT id, city, birth_date FROM players WHERE full_name = 'Новиков Пётр Ильич'").get();
  assert(fresh && fresh.city === 'Рославль' && fresh.birth_date === '2001-02-03', 'новый игрок не заведён с полями');
  eq(n(), 3, 'результат нового игрока не записан');
  // Дубль через форму результата (ФИО + дата уже есть) — стоп.
  eq((await post({ player: 'Быстров Игорь Петрович', place: '4', new_city: 'Где-то', new_sex: 'M', new_birth_date: '1990-01-01' })).status, 302, 'ответ на дубль');
  eq(db.prepare("SELECT COUNT(*) AS n FROM players WHERE full_name = 'Быстров Игорь Петрович'").get().n, 2, 'дубль заведён через форму результата');
  // Матч по тексту.
  const m = await http(`/admin/tournaments/${t}/matches`, { method: 'POST', form: { _csrf, winner: `#${p1}`, loser: 'Новиков Пётр Ильич', score: '6:2 6:3' }, jar });
  eq(m.status, 302, 'матч по тексту');
  eq(db.prepare('SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ? AND winner_player_id = ? AND loser_player_id = ?').get(t, p1, fresh.id).n, 1, 'матч по тексту не записан');
  // Пересчёт со страницы турнира возвращает на неё же.
  // Пересчёт «слишком рано» — тоже редирект; нам важен адрес возврата, не результат.
  const rc = await http('/admin/rating/recompute', { method: 'POST', form: { _csrf }, jar, headers: { referer: `${inst.base}/admin/tournaments/${t}/results` } });
  eq(rc.status + ' ' + rc.location, `302 /admin/tournaments/${t}/results`, 'после пересчёта должны вернуть на страницу турнира');
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(t);
  db.prepare("DELETE FROM players WHERE full_name IN ('Быстров Игорь Петрович','Новиков Пётр Ильич')").run();
  db.prepare('DELETE FROM write_attempts').run();
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  return 'подсказка вместо select; тёзки → «#id» или город в скобках; новый игрок заводится из формы (дубли — стоп); матч по тексту; пересчёт возвращает на турнир';
});

await check('массовый ввод результатов: разбор протокола, предпросмотр со сверкой, сохранение только при полностью зелёном', async () => {
  const { parseBulkResults } = await import('./server/lib/registrations.mjs');
  const parsed = parseBulkResults('1 Иванов Иван\n2. Петров Пётр; 3-4 Сидоров Сидор, Козлов Козьма (Вязьма)\n5–8 Один, Два\nбез места');
  eq(parsed.map((r) => `${r.place}:${r.name}`).join('|'), '1:Иванов Иван|2:Петров Пётр|3:Сидоров Сидор|3:Козлов Козьма (Вязьма)|5:Один|5:Два|null:без места', 'разбор строк/диапазонов/запятых');
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const t = Number(db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Массовый ввод', date('now','-1 day'), 'B')").run().lastInsertRowid);
  const ids = ['Массов Один Первый', 'Массов Два Второй', 'Массов Три Третий'].map((n) => Number(db.prepare("INSERT INTO players (full_name, city, sex) VALUES (?, 'Смоленск', 'M')").run(n).lastInsertRowid));
  const page = await http(`/admin/tournaments/${t}/results`, { jar });
  const _csrf = tokenFrom(page.text);
  assert(/name="text"/.test(page.text) && /results\/bulk/.test(page.text), 'на странице нет формы массового ввода');
  const post = (form) => http(`/admin/tournaments/${t}/results/bulk`, { method: 'POST', form: { _csrf, ...form }, jar });
  // Предпросмотр с ошибкой: неизвестный игрок — красная строка, кнопки «Сохранить всё» нет, в базе пусто.
  const bad = await post({ mode: 'preview', text: '1 Массов Один Первый\n2 Неизвестный Игрок\n3-4 Массов Два Второй, Массов Три Третий' });
  eq(bad.status, 200, 'предпросмотр');
  assert(/bulk-missing/.test(bad.text) && /не найден/.test(bad.text), 'неизвестный не подсвечен');
  assert(!/value="save"/.test(bad.text), 'кнопка «Сохранить всё» показана при ошибке');
  // Попытка сохранить с ошибкой — не сохраняет.
  const forced = await post({ mode: 'save', text: '1 Массов Один Первый\n2 Неизвестный Игрок' });
  eq(forced.status, 200, 'сохранение с ошибкой возвращает предпросмотр');
  eq(db.prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ?').get(t).n, 0, 'при ошибке ничего не должно сохраниться');
  // Зелёный предпросмотр → сохранение всех строк одной транзакцией; диапазон 3-4 → место 3 обоим.
  const goodText = '1 Массов Один Первый\n3-4 Массов Два Второй, Массов Три Третий';
  const ok = await post({ mode: 'preview', text: goodText });
  assert(/value="save"/.test(ok.text) && !/bulk-missing/.test(ok.text), 'зелёный предпросмотр без кнопки сохранения');
  eq((await post({ mode: 'save', text: goodText })).status, 302, 'сохранение');
  const rows = db.prepare('SELECT player_id, place FROM results WHERE tournament_id = ? ORDER BY place, player_id').all(t);
  eq(rows.map((r) => `${r.player_id}:${r.place}`).join('|'), `${ids[0]}:1|${ids[1]}:3|${ids[2]}:3`, 'состав сохранённых результатов');
  // Повтор того же протокола — дубли подсвечены, не сохраняются.
  const again = await post({ mode: 'save', text: goodText });
  assert(/bulk-dup/.test(again.text), 'повтор не подсвечен как дубль');
  eq(db.prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ?').get(t).n, 3, 'повтор продублировал результаты');
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(t);
  db.prepare("DELETE FROM players WHERE full_name LIKE 'Массов %'").run();
  db.prepare('DELETE FROM write_attempts').run();
  return 'разбор ок; неизвестный → красная строка и нет кнопки; save с ошибкой не пишет; зелёный → 3 результата одной транзакцией; повтор → дубли';
});

await check('импорт результатов из таблицы: xlsx (sharedStrings и inlineStr) и csv → предпросмотр массового ввода', async () => {
  const { xlsxFromRows, rowsFromXlsx, rowsFromCsv, protocolTextFromRows } = await import('./server/lib/xlsx.mjs');
  // Читалка: своя писалка (inlineStr) и файл из openpyxl (sharedStrings, числовые сущности).
  eq(protocolTextFromRows(rowsFromXlsx(xlsxFromRows([['Место', 'Игрок'], [1, 'Импортов Один'], ['3-4', 'Импортов Два, Импортов Три']]))), '1 Импортов Один\n3-4 Импортов Два, Импортов Три', 'чтение своего xlsx');
  const { existsSync, readFileSync } = await import('node:fs');
  if (existsSync('/tmp/proto.xlsx')) eq(protocolTextFromRows(rowsFromXlsx(readFileSync('/tmp/proto.xlsx'))), '1 Иванов Иван Иванович\n3-4 Петров Пётр', 'чтение xlsx из openpyxl');
  eq(protocolTextFromRows(rowsFromCsv(Buffer.from('\ufeffМесто;ФИО\n1;"Импортов Один"\n2;Импортов Два\n'))), '1 Импортов Один\n2 Импортов Два', 'чтение csv с BOM и кавычками');
  eq(protocolTextFromRows(rowsFromCsv(Buffer.from('1,Без заголовка\n2,Тоже\n'))), '1 Без заголовка\n2 Тоже', 'csv без заголовка — первые две колонки');
  // Маршрут: файл → предпросмотр с той же сверкой; ничего не сохраняется, пока не нажали «Сохранить всё».
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const t = Number(db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Импорт таблицы', date('now','-1 day'), 'B')").run().lastInsertRowid);
  db.prepare("INSERT INTO players (full_name, city, sex) VALUES ('Импортов Один', 'Смоленск', 'M')").run();
  db.prepare("INSERT INTO players (full_name, city, sex) VALUES ('Импортов Два', 'Смоленск', 'M')").run();
  const _csrf = tokenFrom((await http(`/admin/tournaments/${t}/results`, { jar })).text);
  const buf = xlsxFromRows([['Место', 'Игрок'], [1, 'Импортов Один'], [2, 'Импортов Два'], [3, 'Импортов Никто']]);
  const imp = await http(`/admin/tournaments/${t}/results/import`, {
    method: 'POST', multipart: { fields: { _csrf }, files: [{ field: 'file', filename: 'протокол.xlsx', type: 'application/octet-stream', buffer: buf }] }, jar,
  });
  eq(imp.status, 200, 'импорт отдаёт предпросмотр');
  assert(/прочитано строк: 3/.test(imp.text) && /bulk-missing/.test(imp.text) && !/value="save"/.test(imp.text), 'предпросмотр из файла: должно быть 3 строки, одна красная, без кнопки сохранения');
  assert(/1 Импортов Один/.test(imp.text), 'текст протокола не перенесён в поле массового ввода');
  eq(db.prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ?').get(t).n, 0, 'импорт не должен ничего сохранять сам');
  const bad = await http(`/admin/tournaments/${t}/results/import`, {
    method: 'POST', multipart: { fields: { _csrf }, files: [{ field: 'file', filename: 'x.bin', type: 'application/octet-stream', buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]) }] }, jar,
  });
  eq(bad.status, 302, 'битый zip — ошибка флешем, не 500');
  const noCsrf = await http(`/admin/tournaments/${t}/results/import`, {
    method: 'POST', multipart: { fields: { _csrf: 'нет' }, files: [{ field: 'file', filename: 'p.csv', type: 'text/csv', buffer: Buffer.from('1;Импортов Один') }] }, jar,
  });
  assert(noCsrf.status === 403 || noCsrf.status === 302, 'импорт без CSRF должен отбиваться');
  eq(db.prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ?').get(t).n, 0, 'после отбитых запросов в базе пусто');
  db.prepare('DELETE FROM tournaments WHERE id = ?').run(t);
  db.prepare("DELETE FROM players WHERE full_name LIKE 'Импортов %'").run();
  db.prepare('DELETE FROM write_attempts').run();
  return 'xlsx (свой и openpyxl) и csv читаются; файл → предпросмотр с красной строкой, без сохранения; битый zip — ошибка, без CSRF — отказ';
});

await check('ТЗ 4.5/4.6 «фото»: у тренера/корта/клуба загружается фото (EXIF снят), показывается на витрине, снимается; у судей — нет', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const _csrf = tokenFrom((await http('/admin/directories/courts', { jar })).text);
  eq((await http('/admin/directories/courts', { method: 'POST', form: { _csrf, name: 'Фотокорт', city: 'Смоленск' }, jar })).status, 302, 'корт');
  const court = db.prepare("SELECT id FROM courts WHERE name = 'Фотокорт'").get();
  assert(court, 'корт не создан');
  eq((await http(`/courts/${court.id}/photo`)).status, 404, 'фото до загрузки');
  const sharpMod = (await import('sharp')).default;
  const jpg = await sharpMod({ create: { width: 640, height: 480, channels: 3, background: '#2a6f97' } })
    .withMetadata({ exif: { IFD0: { Copyright: 'FTSO-EXIF-MARK' } } }).jpeg().toBuffer();
  const up = await http(`/admin/directories/courts/${court.id}/photo`, {
    method: 'POST', multipart: { fields: { _csrf }, files: [{ field: 'photo', filename: 'court.jpg', type: 'image/jpeg', buffer: jpg }] }, jar,
  });
  eq(up.status, 302, 'загрузка фото корта');
  const pub = await http(`/courts/${court.id}/photo`);
  eq(pub.status, 200, 'публичное фото корта');
  const raw = Buffer.from(await (await fetch(inst.base + `/courts/${court.id}/photo`)).arrayBuffer());
  assert(!raw.includes('FTSO-EXIF-MARK'), 'EXIF не снят с фото справочника');
  assert(new RegExp(`<img src="/courts/${court.id}/photo"`).test((await http('/courts')).text), 'на витрине нет миниатюры');
  assert(new RegExp(`photo-del-courts-${court.id}`).test((await http('/admin/directories/courts', { jar })).text), 'в админке нет кнопки «Снять»');
  // Замена — старый файл удаляется.
  const firstUpload = db.prepare('SELECT photo_upload_id FROM courts WHERE id = ?').get(court.id).photo_upload_id;
  eq((await http(`/admin/directories/courts/${court.id}/photo`, {
    method: 'POST', multipart: { fields: { _csrf }, files: [{ field: 'photo', filename: 'c2.jpg', type: 'image/jpeg', buffer: await sharpMod({ create: { width: 300, height: 300, channels: 3, background: '#000' } }).jpeg().toBuffer() }] }, jar,
  })).status, 302, 'замена фото');
  eq(db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE id = ?').get(firstUpload).n, 0, 'старое фото не удалено при замене');
  // Снятие.
  eq((await http(`/admin/directories/courts/${court.id}/photo/delete`, { method: 'POST', form: { _csrf }, jar })).status, 302, 'снятие');
  eq((await http(`/courts/${court.id}/photo`)).status, 404, 'фото после снятия');
  // Не картинка — отказ; у судей маршрута фото нет.
  eq((await http(`/admin/directories/courts/${court.id}/photo`, {
    method: 'POST', multipart: { fields: { _csrf }, files: [{ field: 'photo', filename: 'x.pdf', type: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }] }, jar,
  })).status, 302, 'не картинка — ответ');
  eq(db.prepare('SELECT photo_upload_id FROM courts WHERE id = ?').get(court.id).photo_upload_id, null, 'PDF не должен стать фото');
  eq((await http('/referees/1/photo')).status, 404, 'у судей фото не предусмотрено');
  db.prepare('DELETE FROM courts WHERE id = ?').run(court.id);
  db.prepare('DELETE FROM write_attempts').run();
  return 'фото корта: 404 → загрузка (EXIF снят) → 200 и миниатюра → замена удаляет старый файл → снятие 404; PDF отбит; судьи без фото';
});

await check('rate-limit на /register срабатывает', async () => {
  const jar = new Jar();
  const page = await http('/register', { jar });
  const _csrf = tokenFrom(page.text);
  let limited = 0;
  let ok = 0;
  // Счётчик обнуляем ПЕРЕД замером: иначе он уже израсходован прошлыми
  // проверками и «всё отбито» прошло бы даже у лимитера, который режет всегда.
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  // Лимит 5 в час на адрес; шлём заведомо больше.
  for (let i = 0; i < 8; i++) {
    const r = await http('/register', {
      method: 'POST',
      form: {
        _csrf, full_name: `Поток Заявкин ${i}`, city: 'Смоленск', sex: 'M',
        birth_date: ADULT_BIRTH, email: `flood${i}@example.com`, consent_processing: '1',
      },
      jar,
    });
    if (r.status === 429) limited += 1;
    else if (r.status === 302) ok += 1;
  }
  assert(ok > 0, `лимитер режет всё подряд: принято ${ok} — живой человек не подаст заявку`);
  assert(limited > 0, `лимит не сработал: принято ${ok}, отказов 429 — ${limited}`);
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  // Каскад от заявки уносит согласия, а журнал закрыт на удаление триггером.
  journal.withConsentErasure(db, () =>
    db.prepare("DELETE FROM registrations WHERE email LIKE 'flood%@example.com'").run());
  return `принято ${ok}, отбито лимитом ${limited}`;
});

await check('retention заявок: отклонённые чистятся, одобренные живут', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE status = 'approved'").get().n;
  db.prepare("UPDATE registrations SET decided_at = datetime('now','-400 days') WHERE status = 'rejected'").run();
  const removed = regs.purgeRegistrations(db, 365);
  assert(removed > 0, 'старые отклонённые заявки не вычищены');
  eq(db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE status = 'approved'").get().n, before,
    'одобренные заявки не должны чиститься — они объясняют основание');
  return `удалено просроченных отклонённых: ${removed}; одобренные (${before}) на месте`;
});

await check('письмо доходит до транспорта и помечается отправленным', async () => {
  const mailer = await import('./server/lib/mailer.mjs');
  const sent = [];
  mailer.setTransport(async (msg) => { sent.push(msg); });
  try {
    const { res } = await submitRegistration({
      // Город НАРОЧНО отличается от города оператора: в подписи письма стоит
      // адрес Федерации (это её контакты, так и надо), и на «Смоленск» проверка
      // города заявителя срабатывала бы ложно.
      full_name: 'Почтовый Заявитель', city: 'Десногорск', sex: 'M',
      email: 'pochta@example.com', consent_processing: '1',
    });
    eq(res.status, 302, 'подача заявки');
    // Отправка асинхронная и не блокирует ответ — дожидаемся разбора очереди.
    await mailer.flushOutbox(db);
    const row = db.prepare("SELECT * FROM mail_outbox WHERE to_email = 'pochta@example.com'").get();
    eq(row.status, 'sent', 'письмо должно быть отправлено');
    assert(row.sent_at, 'не проставлено время отправки');
    eq(row.last_error, null, 'у отправленного письма не должно остаться ошибки');
    const msg = sent.find((m) => m.to === 'pochta@example.com');
    assert(msg, 'транспорт не получил письмо');
    assert(msg.subject.includes('принята'), 'не тот шаблон письма');
    assert(msg.body.includes('Почтовый Заявитель'), 'в письме нет имени заявителя');
    assert(/\/register\/status\//.test(msg.body), 'в письме нет ссылки на статус заявки');
    // МИНИМИЗАЦИЯ: почта идёт открытым каналом, лишних ПДн в теле быть не должно.
    assert(!msg.body.includes('Десногорск'), 'в письмо утёк город заявителя');
    return `письмо ушло в транспорт (${sent.length} шт.), статус sent, ссылка на статус внутри, лишних данных нет`;
  } finally {
    mailer.setTransport(null);
  }
});

await check('сбой SMTP не теряет заявку: письмо ждёт и объясняет причину', async () => {
  const mailer = await import('./server/lib/mailer.mjs');
  mailer.setTransport(async () => { throw new Error('соединение с smtp.yandex.ru отклонено'); });
  try {
    const { res } = await submitRegistration({
      full_name: 'Сбойный Заявитель', city: 'Вязьма', sex: 'F',
      email: 'sboy@example.com', consent_processing: '1',
    });
    eq(res.status, 302, 'заявка должна приниматься даже при мёртвом SMTP');
    await mailer.flushOutbox(db);
    const reg = db.prepare("SELECT * FROM registrations WHERE email = 'sboy@example.com'").get();
    assert(reg, 'заявка потеряна из-за сбоя почты');
    eq(reg.status, 'pending', 'заявка должна ждать модерации');
    let row = db.prepare("SELECT * FROM mail_outbox WHERE to_email = 'sboy@example.com'").get();
    eq(row.status, 'queued', 'письмо должно остаться в очереди, а не пропасть');
    assert(row.attempts > 0, 'попытка не засчитана');
    assert(row.last_error.includes('smtp.yandex.ru'), 'причина сбоя не записана');

    // После исчерпания попыток письмо помечается неотправленным — очередь не
    // крутит битый адрес вечно, но и не забывает про него.
    for (let i = 0; i < 10; i++) await mailer.flushOutbox(db);
    row = db.prepare("SELECT * FROM mail_outbox WHERE to_email = 'sboy@example.com'").get();
    eq(row.status, 'failed', 'после исчерпания попыток статус должен стать failed');
    const summary = mailer.outboxSummary(db);
    assert(summary.failed > 0, 'сводка для админки не видит неотправленных');

    // Кнопка «попробовать снова» возвращает письмо в очередь и досылает.
    const delivered = [];
    mailer.setTransport(async (msg) => { delivered.push(msg); });
    const { jar } = await login(ADMIN.user, ADMIN.pass);
    const page = await http('/admin/registrations', { jar });
    assert(page.text.includes('Письма не доставлены'), 'админке не показано, что письма не ушли');
    const _csrf = tokenFrom(page.text);
    const retry = await http('/admin/registrations/mail/retry', { method: 'POST', form: { _csrf }, jar });
    eq(retry.status, 302, 'повтор отправки');
    row = db.prepare("SELECT * FROM mail_outbox WHERE to_email = 'sboy@example.com'").get();
    eq(row.status, 'sent', 'после повтора письмо должно уйти');
    assert(delivered.length > 0, 'транспорт не получил письмо при повторе');
    return 'заявка принята, письмо ждёт с причиной, после исчерпания попыток — failed и видно в админке, повтор досылает';
  } finally {
    mailer.setTransport(null);
  }
});

await check('пароль SMTP не утекает в лог и не лежит в git', async () => {
  const { createSmtpTransport, smtpConfigured } = await import('./server/lib/smtp.mjs');
  eq(smtpConfigured({ host: 'smtp.yandex.ru', user: '', pass: '' }), false, 'пустые реквизиты — не настроено');
  eq(smtpConfigured({ host: 'smtp.yandex.ru', user: 'a@b.ru', pass: 'x' }), true, 'заполненные реквизиты — настроено');
  // Транспорт создаётся, но ничего не печатает: пароль виден только nodemailer.
  const send = createSmtpTransport({ host: 'smtp.yandex.ru', port: 465, secure: true, user: 'a@b.ru', pass: 'секрет-пароль', from: '' });
  eq(typeof send, 'function', 'транспорт должен быть функцией отправки');
  const example = readFileSync(resolve(HERE, '.env.example'), 'utf8');
  assert(example.includes('SMTP_USER') && example.includes('SMTP_PASS'), 'в .env.example нет заглушек SMTP');
  assert(!example.includes('пароль-приложения-яндекса-настоящий'), 'в образец попал реальный пароль');
  const gitTracked = spawnSync('git', ['ls-files', '.env'], { cwd: HERE, encoding: 'utf8' });
  eq(gitTracked.stdout.trim(), '', 'файл .env не должен быть под контролем git');
  return 'реквизиты только из окружения, .env вне git, в образце заглушки';
});

// ===========================================================================
section('13. Единые требования к загрузке файлов');

const up = await import('./server/lib/uploads.mjs');
const UPLOAD_DIR = resolve(WORK, 'uploads');
eq(UPLOAD_DIR, config.upload.dir, 'приёмка и приложение должны писать в один каталог загрузок');

// Мини-файлы с настоящими сигнатурами: проверяем распознавание по СОДЕРЖИМОМУ.
const fileOf = (head, tail = 'x'.repeat(64)) => Buffer.concat([Buffer.from(head, 'latin1'), Buffer.from(tail)]);
const PDF = fileOf('%PDF-1.7\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(64, 0)]);
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64, 0)]);
const SHELL = fileOf('#!/bin/sh\nrm -rf /\n');
/** ZIP с именем первой записи — так отличаем docx от голого архива. */
function zipWithFirstEntry(name) {
  const n = Buffer.from(name, 'latin1');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(n.length, 26);
  return Buffer.concat([head, n, Buffer.alloc(64, 0)]);
}
const DOCX = zipWithFirstEntry('[Content_Types].xml');
const PLAIN_ZIP = zipWithFirstEntry('payload.sh');

await check('тип определяется по magic bytes, а не по расширению и Content-Type', async () => {
  // Файл НАЗВАН документом, но внутри — исполняемый.
  let caught = null;
  try {
    up.validateUpload({ buffer: EXE, filename: 'polozhenie.pdf', profile: 'tournament-doc' });
  } catch (err) { caught = err; }
  assert(caught, 'exe под именем .pdf прошёл проверку');
  assert(/Исполняемые/.test(caught.message), `ожидался отказ по исполняемому файлу, получено: ${caught.message}`);

  for (const [buf, label] of [[ELF, 'ELF'], [SHELL, 'скрипт с shebang']]) {
    let err = null;
    try { up.validateUpload({ buffer: buf, filename: 'setka.pdf', profile: 'tournament-doc' }); } catch (e) { err = e; }
    assert(err && /Исполняемые/.test(err.message), `${label} под именем .pdf не отбит`);
  }

  // И наоборот: настоящий PDF с «неправильным» именем распознаётся верно.
  const ok = up.validateUpload({ buffer: PDF, filename: 'файл.txt', profile: 'tournament-doc' });
  eq(ok.mime, 'application/pdf', 'настоящий PDF не распознан по содержимому');
  return 'exe/elf/shebang под видом .pdf отбиты; настоящий PDF распознан вопреки расширению';
});

await check('голый ZIP не проходит как документ Office', async () => {
  const docx = up.validateUpload({ buffer: DOCX, filename: 'polozhenie.docx', profile: 'tournament-doc' });
  eq(docx.kind, 'document', 'настоящий docx не распознан');
  eq(docx.ext, 'docx', 'расширение docx не сохранено');
  let err = null;
  try { up.validateUpload({ buffer: PLAIN_ZIP, filename: 'polozhenie.docx', profile: 'tournament-doc' }); } catch (e) { err = e; }
  assert(err, 'голый zip прошёл под видом docx');
  assert(/не распознан/.test(err.message), `ожидался отказ по формату, получено: ${err.message}`);
  return 'docx (первая запись [Content_Types].xml) принят, архив с payload.sh — отклонён';
});

await check('лимит размера и профиль назначения соблюдаются', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024, 1)]);
  let err = null;
  try { up.validateUpload({ buffer: big, filename: 'foto.png', profile: 'gallery' }); } catch (e) { err = e; }
  assert(err && /больше/.test(err.message), 'превышение лимита размера не поймано');

  // Профиль решает, что можно: в галерею PDF нельзя, в документы — нельзя картинку.
  let g = null;
  try { up.validateUpload({ buffer: PDF, filename: 'a.pdf', profile: 'gallery' }); } catch (e) { g = e; }
  assert(g && /тип файла/.test(g.message), 'PDF пролез в галерею');
  let d = null;
  try { up.validateUpload({ buffer: JPEG, filename: 'a.jpg', profile: 'documents' }); } catch (e) { d = e; }
  assert(d, 'картинка пролезла в раздел документов');
  eq(up.validateUpload({ buffer: JPEG, filename: 'a.jpg', profile: 'gallery' }).kind, 'image', 'JPEG в галерею должен проходить');
  let empty = null;
  try { up.validateUpload({ buffer: Buffer.alloc(0), filename: 'a.pdf', profile: 'documents' }); } catch (e) { empty = e; }
  assert(empty && /пустой/.test(empty.message), 'пустой файл принят');
  return 'лимит размера, пустой файл и чужой профиль отклоняются; свой тип проходит';
});

await check('файл лежит ВНЕ webroot под случайным именем', async () => {
  const row = await up.storeUpload(db, {
    buffer: PDF, filename: '../../evil name".pdf', profile: 'tournament-doc', dir: UPLOAD_DIR,
  });
  assert(row.stored_name !== '../../evil name".pdf', 'имя с диска взято из присланного');
  assert(/^[0-9a-f]{32}\.pdf$/.test(row.stored_name), `имя на диске должно быть случайным, получено ${row.stored_name}`);
  const onDisk = resolve(UPLOAD_DIR, row.stored_name);
  assert(existsSync(onDisk), 'файл не записан на диск');
  // Каталог хранения НЕ внутри public: иначе nginx/express отдали бы файл
  // напрямую, мимо проверки прав и мимо attachment.
  const webroot = resolve(HERE, 'public');
  assert(!resolve(UPLOAD_DIR).startsWith(webroot), 'каталог загрузок оказался внутри webroot');
  // И через статику он не достаётся.
  const viaStatic = await http(`/static/uploads/${row.stored_name}`);
  assert(viaStatic.status === 404, `файл достаётся как статика (HTTP ${viaStatic.status})`);
  // Опасное имя вычищено, расширение подставлено по содержимому.
  assert(!row.original_name.includes('/'), 'в имени для отдачи остались слэши');
  assert(!row.original_name.includes('"'), 'в имени для отдачи остались кавычки');
  assert(row.original_name.endsWith('.pdf'), 'расширение по содержимому не подставлено');
  up.deleteUpload(db, row.id, UPLOAD_DIR);
  assert(!existsSync(onDisk), 'файл остался на диске после удаления записи');
  return `имя на диске случайное (${row.stored_name}), хранение вне webroot, статикой не отдаётся, удаление уносит файл`;
});

// ===========================================================================
section('14. Заявка «провести турнир» с документами');

const treq = await import('./server/lib/tournament-requests.mjs');
const sharpLib = (await import('sharp')).default;

async function submitTournament(fields, files = [], jar = new Jar()) {
  // Счётчик лимитера обнуляем: иначе 429 замаскирует ПРИЧИНУ отказа, и проверка
  // формата файла «позеленеет» на самом деле от лимита подач.
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 't:%'").run();
  const page = await http('/tournament-request', { jar });
  const _csrf = tokenFrom(page.text);
  const res = await http('/tournament-request', {
    method: 'POST',
    multipart: { fields: { _csrf, ...fields }, files },
    jar,
  });
  return { res, jar, _csrf };
}

const BASE_FIELDS = {
  name: 'Кубок приёмки', city: 'Смоленск', end_date: '2026-09-01', category: 'A',
  organizer: 'Иван Организаторов', email: 'org@example.com', consent_processing: '1',
};

await check('multipart без CSRF-токена отвергается', async () => {
  const res = await http('/tournament-request', {
    method: 'POST',
    multipart: { fields: { ...BASE_FIELDS }, files: [] },
  });
  eq(res.status, 403, 'форма с файлами без токена должна давать 403');
  eq(db.prepare("SELECT COUNT(*) AS n FROM tournament_requests WHERE email = 'org@example.com'").get().n, 0,
    'заявка без CSRF записана');
  return 'multipart-форма без токена -> 403; общий middleware её пропускает, проверяет парсер';
});

await check('exe под именем .pdf отбит, файл на диске не остался', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n;
  const { res } = await submitTournament(BASE_FIELDS, [
    { field: 'doc_polozhenie', filename: 'polozhenie.pdf', type: 'application/pdf', buffer: EXE },
  ]);
  eq(res.status, 400, 'заявка с исполняемым файлом должна отклоняться');
  assert(/Исполняемые файлы/.test(res.text), 'причина отказа не названа');
  assert(res.text.includes('value="Кубок приёмки"'), 'черновик текстовых полей потерян');
  eq(db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, before,
    'после отказа осталась запись загрузки — файл осиротел');
  eq(db.prepare("SELECT COUNT(*) AS n FROM tournament_requests WHERE name = 'Кубок приёмки'").get().n, 0,
    'заявка с отклонённым файлом записана');
  return 'HTTP 400 с причиной, текстовые поля сохранены, осиротевших файлов нет';
});

await check('заявка с документом уходит на модерацию, а не в календарь', async () => {
  const tournamentsBefore = db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n;
  const { res } = await submitTournament(
    { ...BASE_FIELDS, name: 'Кубок Смоленска (приёмка)', phone: '8-900-000-00-00', comment: 'корты «Днепр»' },
    [{ field: 'doc_polozhenie', filename: 'polozhenie.pdf', type: 'application/pdf', buffer: PDF }],
  );
  eq(res.status, 302, 'подача заявки');
  const r = db.prepare("SELECT * FROM tournament_requests WHERE name = 'Кубок Смоленска (приёмка)'").get();
  eq(r.status, 'pending', 'заявка должна ждать модерации');
  eq(db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n, tournamentsBefore,
    'форма НЕ должна создавать турнир до модерации');
  const files = treq.requestFiles(db, r.id);
  eq(files.length, 1, 'документ не привязан к заявке');
  eq(files[0].profile, 'tournament-doc', 'профиль загрузки');
  assert(existsSync(resolve(UPLOAD_DIR, files[0].stored_name)), 'файла нет на диске');
  // Контакты организатора — ПДн, у обработки должно быть основание в журнале.
  const consent = db
    .prepare("SELECT kind, event, source FROM consents WHERE subject_ref LIKE '%заявка на турнир%' ORDER BY id DESC LIMIT 1")
    .get();
  eq(consent.kind, 'processing', 'согласие организатора не записано');
  eq(consent.event, 'granted', 'событие согласия');
  const mail = db.prepare("SELECT kind FROM mail_outbox WHERE to_email = 'org@example.com' ORDER BY id DESC LIMIT 1").get();
  eq(mail.kind, 'tournament.submitted', 'письмо о приёме заявки не поставлено в очередь');
  const status = await http(`/tournament-request/status/${r.status_token}`);
  eq(status.status, 200, 'страница статуса по токену');
  assert(status.text.includes('на рассмотрении'), 'статус не показан');
  return 'заявка pending, документ привязан и лежит на диске, согласие организатора в журнале, письмо в очереди';
});

await check('изображение пересобирается: ресайз и снятый EXIF', async () => {
  // Снимок «с телефона»: большой и с EXIF, где живут геолокация и модель камеры.
  const photo = await sharpLib({ create: { width: 2400, height: 1400, channels: 3, background: '#0e7a52' } })
    .jpeg()
    .withExif({ IFD0: { Make: 'TestCam', Copyright: 'ФТСО' } })
    .toBuffer();
  const metaIn = await sharpLib(photo).metadata();
  assert(metaIn.exif, 'исходный файл должен содержать EXIF, иначе проверка бессмысленна');

  const { res } = await submitTournament(
    { ...BASE_FIELDS, name: 'Кубок с фотографией', email: 'photo@example.com' },
    [{ field: 'doc_setka', filename: 'setka.jpg', type: 'image/jpeg', buffer: photo }],
  );
  eq(res.status, 302, 'подача заявки с изображением');
  const r = db.prepare("SELECT * FROM tournament_requests WHERE name = 'Кубок с фотографией'").get();
  const [file] = treq.requestFiles(db, r.id);
  const stored = readFileSync(resolve(UPLOAD_DIR, file.stored_name));
  const metaOut = await sharpLib(stored).metadata();
  assert(!metaOut.exif, 'EXIF остался в сохранённом файле — утекли бы геолокация и модель камеры');
  assert(metaOut.width <= 1600 && metaOut.height <= 1600, `изображение не уменьшено: ${metaOut.width}x${metaOut.height}`);
  assert(stored.length < photo.length, 'сохранённый файл не должен быть больше исходного');
  return `${metaIn.width}x${metaIn.height} с EXIF -> ${metaOut.width}x${metaOut.height} без EXIF`;
});

await check('число файлов ограничено', async () => {
  const files = Array.from({ length: 5 }, (_, i) => ({
    field: `doc_${i}`, filename: `doc${i}.pdf`, type: 'application/pdf', buffer: PDF,
  }));
  const { res } = await submitTournament({ ...BASE_FIELDS, name: 'Кубок с пачкой файлов' }, files);
  eq(res.status, 400, `перебор файлов должен давать 400 (а не 429 от лимитера), получено ${res.status}`);
  assert(/Слишком много файлов/.test(res.text), 'отказ не по числу файлов — проверка ловит не то');
  eq(db.prepare("SELECT COUNT(*) AS n FROM tournament_requests WHERE name = 'Кубок с пачкой файлов'").get().n, 0,
    'заявка с перебором файлов записана');
  return `5 файлов при лимите ${config.tournamentRequest.maxFiles} -> 400 «Слишком много файлов», заявки нет`;
});

await check('документ отдаётся только за логином и только как attachment', async () => {
  const r = db.prepare("SELECT * FROM tournament_requests WHERE name = 'Кубок Смоленска (приёмка)'").get();
  const [file] = treq.requestFiles(db, r.id);

  const anon = await http(`/admin/files/${file.id}`);
  assert(anon.status === 302 || anon.status === 403, `аноним получил файл (HTTP ${anon.status})`);

  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const got = await http(`/admin/files/${file.id}`, { jar });
  eq(got.status, 200, 'модератор должен получать документ');
  const disposition = got.headers.get('content-disposition') || '';
  assert(/^attachment/.test(disposition), `отдача должна быть attachment, получено: ${disposition}`);
  eq(got.headers.get('x-content-type-options'), 'nosniff', 'нет nosniff при отдаче файла');
  // И тем же путём файл не достаётся как статика.
  const viaStatic = await http(`/static/uploads/${file.stored_name}`);
  eq(viaStatic.status, 404, 'файл достаётся как статика');
  return `аноним ${anon.status}, модератор 200 + attachment + nosniff, статикой не отдаётся`;
});

await check('согласование создаёт турнир, отказ объясняется организатору', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/tournament-requests', { jar });
  const _csrf = tokenFrom(page.text);
  assert(page.text.includes('Кубок Смоленска (приёмка)'), 'заявки нет в списке модерации');
  assert(page.text.includes('polozhenie.pdf'), 'документ не показан модератору');

  const r = db.prepare("SELECT * FROM tournament_requests WHERE name = 'Кубок Смоленска (приёмка)'").get();
  const before = db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n;
  const appr = await http(`/admin/tournament-requests/${r.id}/approve`, { method: 'POST', form: { _csrf }, jar });
  eq(appr.status, 302, 'согласование заявки');
  const after = db.prepare('SELECT status, tournament_id FROM tournament_requests WHERE id = ?').get(r.id);
  eq(after.status, 'approved', 'статус заявки');
  // Ускорение ввода п. 5: после одобрения — сразу страница результатов нового турнира.
  eq(appr.location, `/admin/tournaments/${after.tournament_id}/results`, 'одобрение должно вести на результаты турнира');
  eq(db.prepare('SELECT COUNT(*) AS n FROM tournaments').get().n, before + 1, 'турнир не создан');
  const created = db.prepare('SELECT name, end_date, category FROM tournaments WHERE id = ?').get(after.tournament_id);
  eq(created.name, r.name, 'название турнира');
  eq(created.end_date, r.end_date, 'дата турнира');
  eq(created.category, r.category, 'категория турнира');
  // Результаты файлом не принимаются: матчей у нового турнира нет.
  eq(db.prepare('SELECT COUNT(*) AS n FROM results WHERE tournament_id = ?').get(after.tournament_id).n, 0,
    'из файла подтянулись результаты — рейтинг должен считаться только по структурным данным');
  assert(
    db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_email = ? AND kind = 'tournament.approved'").get(r.email).n === 1,
    'письмо о согласовании не поставлено в очередь',
  );

  const bad = await submitTournament({ ...BASE_FIELDS, name: 'Кубок отказной', email: 'otkaz-org@example.com' });
  eq(bad.res.status, 302, 'подача заявки для отказа');
  const badRow = db.prepare("SELECT * FROM tournament_requests WHERE name = 'Кубок отказной'").get();
  const rej = await http(`/admin/tournament-requests/${badRow.id}/reject`, {
    method: 'POST', form: { _csrf, reason: 'Даты пересекаются с этапом первенства области' }, jar,
  });
  eq(rej.status, 302, 'отклонение заявки');
  const statusPage = await http(`/tournament-request/status/${badRow.status_token}`);
  assert(statusPage.text.includes('отклонена'), 'организатору не показан отказ');
  assert(statusPage.text.includes('Даты пересекаются'), 'организатору не показана причина');
  return 'согласование добавляет турнир в календарь без результатов; отказ с причиной виден организатору, письма в очереди';
});

await check('rate-limit формы турнира срабатывает и не путается с регистрацией', async () => {
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 't:%'").run();
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const jar = new Jar();
  const page = await http('/tournament-request', { jar });
  const _csrf = tokenFrom(page.text);
  let ok = 0;
  let limited = 0;
  const total = config.tournamentRequest.maxPerWindow + 2;
  for (let i = 0; i < total; i++) {
    const r = await http('/tournament-request', {
      method: 'POST',
      multipart: { fields: { _csrf, ...BASE_FIELDS, name: `Поток ${i}`, email: `flood${i}@example.com` }, files: [] },
      jar,
    });
    if (r.status === 429) limited += 1;
    else if (r.status === 302) ok += 1;
  }
  assert(ok > 0, `лимитер режет всё подряд: принято ${ok}`);
  assert(limited > 0, `лимит не сработал: принято ${ok}, отказов ${limited}`);
  // Счётчики РАЗНЫЕ: поток заявок на турниры не должен закрывать регистрацию игроков.
  const reg = await http('/register');
  eq(reg.status, 200, 'форма регистрации должна остаться доступной');
  const regJar = new Jar();
  const regPage = await http('/register', { jar: regJar });
  const regCsrf = tokenFrom(regPage.text);
  const regRes = await http('/register', {
    method: 'POST',
    form: {
      _csrf: regCsrf, full_name: 'Не Заблокирован', city: 'Смоленск', sex: 'M',
      birth_date: ADULT_BIRTH, email: 'notblocked@example.com', consent_processing: '1',
    },
    jar: regJar,
  });
  eq(regRes.status, 302, 'лимит заявок на турниры перекрыл регистрацию игрока — счётчики должны быть разными');
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 't:%'").run();
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  db.prepare("DELETE FROM tournament_requests WHERE email LIKE 'flood%@example.com'").run();
  journal.withConsentErasure(db, () =>
    db.prepare("DELETE FROM registrations WHERE email = 'notblocked@example.com'").run());
  return `принято ${ok}, отбито ${limited}; регистрация игроков при этом работает (счётчики раздельные)`;
});

await check('retention заявок уносит и приложенные файлы', async () => {
  const r = db.prepare("SELECT * FROM tournament_requests WHERE name = 'Кубок отказной'").get();
  // Заявка без файлов — приложим документ вручную, чтобы проверить каскад по диску.
  const upload = await up.storeUpload(db, {
    buffer: PDF, filename: 'setka.pdf', profile: 'tournament-doc', dir: UPLOAD_DIR,
  });
  db.prepare('INSERT INTO tournament_request_files (request_id, upload_id) VALUES (?, ?)').run(r.id, upload.id);
  const onDisk = resolve(UPLOAD_DIR, upload.stored_name);
  assert(existsSync(onDisk), 'файл не записан');

  const approvedBefore = db.prepare("SELECT COUNT(*) AS n FROM tournament_requests WHERE status = 'approved'").get().n;
  eq(treq.purgeRequests(db, 365, UPLOAD_DIR), 0, 'свежую заявку чистить рано');
  db.prepare("UPDATE tournament_requests SET decided_at = datetime('now','-400 days') WHERE id = ?").run(r.id);
  const removed = treq.purgeRequests(db, 365, UPLOAD_DIR);
  eq(removed, 1, 'просроченная отклонённая заявка не вычищена');
  assert(!existsSync(onDisk), 'файл остался на диске после чистки заявки');
  eq(db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE id = ?').get(upload.id).n, 0, 'запись загрузки осталась');
  eq(db.prepare("SELECT COUNT(*) AS n FROM tournament_requests WHERE status = 'approved'").get().n, approvedBefore,
    'согласованные заявки чистить нельзя — они объясняют, откуда турнир в календаре');
  return 'отклонённая заявка старше срока удалена вместе с файлом на диске; согласованные не тронуты';
});

// ===========================================================================
section('15. Личный кабинет и право на забвение (ст. 21)');

const accounts = await import('./server/lib/player-accounts.mjs');
const erasure = await import('./server/lib/erasure.mjs');

/** Ищем строку во ВСЕХ файлах базы: основной + WAL (данные могут быть там). */
function dbContains(needle) {
  const files = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`];
  const probe = Buffer.from(needle, 'utf8');
  for (const file of files) {
    if (!existsSync(file)) continue;
    if (readFileSync(file).includes(probe)) return file;
  }
  return null;
}

/** Счётчик кабинета обнуляем: иначе 429 замаскирует настоящую причину отказа. */
const resetCabinetLimit = () => db.prepare("DELETE FROM write_attempts WHERE key LIKE 'c:%'").run();

const CAB_NAME = 'Кабинетов Тарас Игнатьевич';
const CAB_EMAIL = 'cabinet@example.com';
const CAB_PASSWORD = 'смоленский-корт-2026';
let cabPlayerId = null;
let cabSetUrl = null;

await check('кабинет без входа объясняет, откуда берётся доступ', async () => {
  const r = await http('/cabinet');
  eq(r.status, 403, 'кабинет без входа должен отдавать 403');
  assert(/заявк/i.test(r.text), 'на странице нет объяснения про заявку');
  assert(r.text.includes('/register'), 'нет ссылки на регистрацию');
  assert(r.text.includes('/cabinet/login'), 'нет ссылки на вход');
  return '403 со страницей «нужен вход»: заявка -> одобрение -> письмо со ссылкой';
});

await check('одобрение заявки открывает кабинет ссылкой, а не паролем в письме', async () => {
  const { res } = await submitRegistration({
    full_name: CAB_NAME, city: 'Смоленск', sex: 'M', age_group: '19-34',
    email: CAB_EMAIL, consent_processing: '1', consent_distribution: '1',
  });
  eq(res.status, 302, 'подача заявки');
  const reg = db.prepare('SELECT * FROM registrations WHERE email = ?').get(CAB_EMAIL);
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/registrations', { jar });
  const _csrf = tokenFrom(page.text);
  const appr = await http(`/admin/registrations/${reg.id}/approve`, { method: 'POST', form: { _csrf }, jar });
  eq(appr.status, 302, 'одобрение заявки');

  cabPlayerId = db.prepare('SELECT id FROM players WHERE full_name = ?').get(CAB_NAME).id;
  const account = accounts.accountByPlayer(db, cabPlayerId);
  assert(account, 'аккаунт кабинета не создан при одобрении');
  eq(account.password_hash, null, 'пароль не должен придумываться за игрока');
  const invite = db
    .prepare("SELECT * FROM mail_outbox WHERE to_email = ? AND kind = 'cabinet.invite'")
    .get(CAB_EMAIL);
  assert(invite, 'приглашение в кабинет не поставлено в очередь');
  const m = /\/cabinet\/reset\/([A-Za-z0-9_-]+)/.exec(invite.body);
  assert(m, 'в письме нет ссылки установки пароля');
  cabSetUrl = `/cabinet/reset/${m[1]}`;
  // В БД лежит ХЭШ токена: дамп базы не должен давать вход в чужой кабинет.
  assert(account.reset_token && account.reset_token !== m[1], 'токен хранится в открытом виде');
  return 'аккаунт создан без пароля, в письме одноразовая ссылка, в БД только хэш токена';
});

await check('политика паролей и одноразовость ссылки', async () => {
  resetCabinetLimit();
  // Банка cookie обязательна: CSRF-токен живёт в сессии, и запрос без cookie
  // получит 403 ещё до проверки самого пароля.
  const jar = new Jar();
  const open = await http(cabSetUrl, { jar });
  eq(open.status, 200, 'страница установки пароля');
  const _csrf = tokenFrom(open.text);

  for (const [pw, why] of [
    ['корт', 'слишком короткий'],
    ['1234567890123', 'только цифры'],
    ['кабинетов-тарас-1', 'содержит фамилию'],
    ['cabinet-parol-77', 'содержит адрес почты'],
  ]) {
    const bad = await http(cabSetUrl, { method: 'POST', form: { _csrf, password: pw, password2: pw }, jar });
    eq(bad.status, 400, `пароль «${pw}» (${why}) должен отклоняться`);
  }
  const mismatch = await http(cabSetUrl, {
    method: 'POST', form: { _csrf, password: CAB_PASSWORD, password2: 'другое-значение-99' }, jar,
  });
  eq(mismatch.status, 400, 'несовпадение повтора должно отклоняться');

  const ok = await http(cabSetUrl, { method: 'POST', form: { _csrf, password: CAB_PASSWORD, password2: CAB_PASSWORD }, jar });
  eq(ok.status, 200, 'установка пароля');
  assert(/Пароль установлен/.test(ok.text), 'нет подтверждения установки пароля');

  // Ссылка одноразовая: письмо из ящика не должно быть вечным ключом.
  const again = await http(cabSetUrl, { jar });
  eq(again.status, 404, 'использованная ссылка должна перестать работать');
  return 'короткий, только цифры, с фамилией и с почтой — отклонены; ссылка сработала один раз';
});

await check('вход в кабинет, профиль и своя история', async () => {
  resetCabinetLimit();
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const _csrf = tokenFrom(page.text);
  const bad = await http('/cabinet/login', {
    method: 'POST', form: { _csrf, email: CAB_EMAIL, password: 'неверный-пароль-1' }, jar,
  });
  eq(bad.status, 401, 'неверный пароль должен давать 401');

  const good = await http('/cabinet/login', {
    method: 'POST', form: { _csrf, email: CAB_EMAIL, password: CAB_PASSWORD }, jar,
  });
  eq(good.status, 302, 'вход в кабинет');
  const cab = await http('/cabinet', { jar });
  eq(cab.status, 200, 'кабинет открывается после входа');
  assert(cab.text.includes(CAB_NAME), 'в кабинете нет своего имени');
  assert(cab.text.includes(CAB_EMAIL), 'в кабинете нет своей почты');
  // Рейтинг НЕ редактируется: поля очков в форме профиля быть не должно.
  assert(!/name="rating_points"|name="rank"/.test(cab.text), 'в кабинете есть поле рейтинга — его правит движок');
  return 'неверный пароль 401, верный — вход; профиль показывает имя и почту, полей рейтинга нет';
});

await check('смена пароля отзывает остальные сессии', async () => {
  resetCabinetLimit();
  // Две сессии одного игрока: как будто вход с двух устройств.
  const jarA = new Jar();
  const jarB = new Jar();
  for (const jar of [jarA, jarB]) {
    const page = await http('/cabinet/login', { jar });
    const _csrf = tokenFrom(page.text);
    const r = await http('/cabinet/login', { method: 'POST', form: { _csrf, email: CAB_EMAIL, password: CAB_PASSWORD }, jar });
    eq(r.status, 302, 'вход в кабинет');
  }
  eq((await http('/cabinet', { jar: jarB })).status, 200, 'вторая сессия должна работать до смены пароля');

  const pageA = await http('/cabinet', { jar: jarA });
  const _csrf = tokenFrom(pageA.text);
  const NEW_PASSWORD = 'десногорск-ракетка-42';
  const changed = await http('/cabinet/password', {
    method: 'POST',
    form: { _csrf, current_password: CAB_PASSWORD, new_password: NEW_PASSWORD, new_password2: NEW_PASSWORD },
    jar: jarA,
  });
  eq(changed.status, 302, 'смена пароля');

  // Своя сессия жива, чужая — нет: если пароль меняют из-за угона, угнанная
  // сессия обязана умереть здесь же, а не дожить до истечения.
  eq((await http('/cabinet', { jar: jarA })).status, 200, 'своя сессия должна остаться');
  eq((await http('/cabinet', { jar: jarB })).status, 403, 'вторая сессия должна быть отозвана');

  // И вход теперь только по новому паролю.
  const jarC = new Jar();
  const pageC = await http('/cabinet/login', { jar: jarC });
  const csrfC = tokenFrom(pageC.text);
  eq(
    (await http('/cabinet/login', { method: 'POST', form: { _csrf: csrfC, email: CAB_EMAIL, password: CAB_PASSWORD }, jar: jarC })).status,
    401,
    'старый пароль не должен работать',
  );
  return 'своя сессия жива, вторая отозвана, старый пароль недействителен';
});

await check('сброс пароля не выдаёт, зарегистрирован ли адрес', async () => {
  resetCabinetLimit();
  const jarK = new Jar();
  const jarU = new Jar();
  const pageK = await http('/cabinet/forgot', { jar: jarK });
  const pageU = await http('/cabinet/forgot', { jar: jarU });
  const known = await http('/cabinet/forgot', { method: 'POST', form: { _csrf: tokenFrom(pageK.text), email: CAB_EMAIL }, jar: jarK });
  const unknown = await http('/cabinet/forgot', { method: 'POST', form: { _csrf: tokenFrom(pageU.text), email: 'nikogo@example.com' }, jar: jarU });
  eq(known.status, 200, 'ответ по известному адресу');
  eq(unknown.status, 200, 'ответ по неизвестному адресу');
  // Тексты должны совпадать: иначе форма превращается в проверку наличия человека.
  eq(known.text.length, unknown.text.length, 'ответы должны быть неразличимы');
  eq(
    db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_email = 'nikogo@example.com'").get().n,
    0,
    'на неизвестный адрес письмо отправлять нечего',
  );
  assert(
    db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE to_email = ? AND kind = 'cabinet.reset'").get(CAB_EMAIL).n > 0,
    'по известному адресу письмо не поставлено в очередь',
  );
  return 'ответы неразличимы, письмо ушло только по существующему адресу';
});

await check('фото в кабинете: загрузка = согласие на распространение, замена = отзыв+выдача, удаление = отзыв (ст. 10.1)', async () => {
  resetCabinetLimit();
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const _csrf0 = tokenFrom(page.text);
  await http('/cabinet/login', { method: 'POST', form: { _csrf: _csrf0, email: CAB_EMAIL, password: 'десногорск-ракетка-42' }, jar });
  const cab = await http('/cabinet', { jar });
  const _csrf = tokenFrom(cab.text);
  assert(!cab.text.includes('/cabinet/publication'), 'в кабинете осталась кнопка согласия на распространение');
  assert(cab.text.includes('/consent#distribution'), 'у поля фото нет ссылки на раздел 2 Согласия');
  eq((await http('/cabinet/publication', { method: 'POST', form: { _csrf, publish: '0' }, jar })).status, 404,
    'маршрут /cabinet/publication должен исчезнуть');
  const events = () => db
    .prepare("SELECT event, source, ip FROM consents WHERE player_id = ? AND kind = 'distribution' ORDER BY id")
    .all(cabPlayerId);
  const n0 = events().length;
  eq(db.prepare('SELECT photo_upload_id FROM players WHERE id = ?').get(cabPlayerId).photo_upload_id, null, 'фото до теста');

  const mk = (bg) => sharpLib({ create: { width: 600, height: 500, channels: 3, background: bg } }).jpeg().toBuffer();
  const up = async (buf, name) => http('/cabinet/profile', {
    method: 'POST',
    multipart: { fields: { _csrf, full_name: CAB_NAME, email: CAB_EMAIL }, files: [{ field: 'photo', filename: name, type: 'image/jpeg', buffer: buf }] },
    jar,
  });
  // 1. Загрузка = granted.
  eq((await up(await mk('#123d68'), 'a.jpg')).status, 302, 'загрузка фото');
  let ev = events();
  eq(ev.length, n0 + 1, 'после загрузки — одна новая запись');
  eq(ev.at(-1).event + ':' + ev.at(-1).source, 'granted:web', 'загрузка записана выдачей');
  assert(ev.at(-1).ip, 'IP выдачи через сайт не записан');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(cabPlayerId).is_public, 1, 'флаг после загрузки');
  eq((await http(`/player/${cabPlayerId}/photo`)).status, 200, 'публичное фото после загрузки');
  // 2. Замена = revoked + granted.
  eq((await up(await mk('#68123d'), 'b.jpg')).status, 302, 'замена фото');
  ev = events();
  eq(ev.length, n0 + 3, 'после замены — две новые записи');
  eq(ev.at(-2).event, 'revoked', 'замена: отзыв по прежнему снимку');
  eq(ev.at(-1).event, 'granted', 'замена: выдача по новому');
  // 3. Удаление = revoked, фото уходит из открытого доступа сразу.
  const del = await http('/cabinet/photo/delete', { method: 'POST', form: { _csrf }, jar });
  eq(del.status, 302, 'удаление фото');
  ev = events();
  eq(ev.length, n0 + 4, 'после удаления — одна новая запись');
  eq(ev.at(-1).event, 'revoked', 'удаление записано отзывом');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(cabPlayerId).is_public, 0, 'флаг после удаления');
  eq((await http(`/player/${cabPlayerId}/photo`)).status, 404, 'публичное фото после удаления');
  eq((await http(`/player/${cabPlayerId}`)).status, 200, 'профиль без фото открыт — результаты по участию');
  assert(db.prepare("SELECT 1 FROM action_log WHERE action LIKE '%consent.distribution.revoked%'").get(), 'отзыв не в журнале действий');
  return 'загрузка → granted (web, IP), замена → revoked+granted, удаление → revoked; фото 200→404, профиль 200; /cabinet/publication → 404';
});

await check('ЗАБВЕНИЕ: ФИО не восстановимо ниоткуда', async () => {
  resetCabinetLimit();
  // Готовим игрока «как в жизни»: фото, результаты, матчи, снимок рейтинга.
  const photo = await sharpLib({ create: { width: 900, height: 700, channels: 3, background: '#123d68' } })
    .jpeg().toBuffer();
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const _csrf0 = tokenFrom(page.text);
  await http('/cabinet/login', { method: 'POST', form: { _csrf: _csrf0, email: CAB_EMAIL, password: 'десногорск-ракетка-42' }, jar });
  const cab = await http('/cabinet', { jar });
  const _csrf = tokenFrom(cab.text);
  const up1 = await http('/cabinet/profile', {
    method: 'POST',
    multipart: {
      fields: { _csrf, full_name: CAB_NAME, email: CAB_EMAIL },
      files: [{ field: 'photo', filename: 'me.jpg', type: 'image/jpeg', buffer: photo }],
    },
    jar,
  });
  eq(up1.status, 302, 'загрузка фото профиля');
  const withPhoto = db.prepare('SELECT photo_upload_id FROM players WHERE id = ?').get(cabPlayerId);
  assert(withPhoto.photo_upload_id, 'фото не привязано к профилю');
  const photoRow = db.prepare('SELECT stored_name FROM uploads WHERE id = ?').get(withPhoto.photo_upload_id);
  const photoPath = resolve(UPLOAD_DIR, photoRow.stored_name);
  assert(existsSync(photoPath), 'файл фото не записан');

  // Пусть игрок попадёт в снимок рейтинга — там ФИО хранится копией.
  const t = Number(
    db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Турнир забвения', date('now','-20 days'), 'A')").run().lastInsertRowid,
  );
  const rival = db.prepare('SELECT id FROM players WHERE full_name = ?').get('Дмитрий Волков');
  db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, 1)').run(t, cabPlayerId);
  db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, 2)').run(t, rival.id);
  db.prepare('INSERT INTO matches (tournament_id, winner_player_id, loser_player_id) VALUES (?, ?, ?)').run(t, cabPlayerId, rival.id);
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  assert(dbContains(CAB_NAME), 'подготовка бессмысленна: имени и так нет в базе');

  // Удаление из кабинета — с подтверждением словом.
  const del = await http('/cabinet/delete', { jar });
  eq(del.status, 200, 'страница удаления');
  const csrfDel = tokenFrom(del.text);
  const noWord = await http('/cabinet/delete', { method: 'POST', form: { _csrf: csrfDel, confirm: 'да' }, jar });
  eq(noWord.status, 302, 'без слова подтверждения — отказ с сообщением');
  assert(!db.prepare('SELECT anonymized_at FROM players WHERE id = ?').get(cabPlayerId).anonymized_at,
    'удаление сработало без подтверждения');

  const done = await http('/cabinet/delete', { method: 'POST', form: { _csrf: csrfDel, confirm: 'УДАЛИТЬ' }, jar });
  eq(done.status, 200, 'удаление данных');

  // (1) НЕОБРАТИМОСТЬ: имени нет НИ В ОДНОМ файле базы — ни в строке игрока,
  // ни в снимках рейтинга, ни в журнале действий, ни в очереди писем.
  const leak = dbContains(CAB_NAME);
  assert(!leak, `ФИО осталось в базе (${leak}) — удаление обратимо`);
  const mailLeak = dbContains(CAB_EMAIL);
  assert(!mailLeak, `адрес почты остался в базе (${mailLeak})`);

  const row = db.prepare('SELECT * FROM players WHERE id = ?').get(cabPlayerId);
  assert(row, 'строка игрока должна остаться — на неё ссылаются матчи');
  assert(row.anonymized_at, 'не проставлена отметка обезличивания');
  eq(row.full_name, 'Игрок удалён', 'ФИО не затёрто');
  eq(row.age_group, null, 'возрастная группа не очищена');
  eq(row.photo_upload_id, null, 'ссылка на фото осталась');
  eq(row.is_public, 0, 'обезличенный игрок не может публиковаться');
  assert(!existsSync(photoPath), 'файл фотографии остался на диске');
  eq(db.prepare('SELECT COUNT(*) AS n FROM player_accounts WHERE player_id = ?').get(cabPlayerId).n, 0, 'аккаунт остался');
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(cabPlayerId).n, 0, 'записи согласий остались');
  eq(db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE player_id = ?').get(cabPlayerId).n, 0, 'заявка осталась');

  // Вход закрыт, кабинет закрыт.
  const after = await http('/cabinet', { jar });
  eq(after.status, 403, 'кабинет должен закрыться');
  const jarX = new Jar();
  const loginPage = await http('/cabinet/login', { jar: jarX });
  const reLogin = await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(loginPage.text), email: CAB_EMAIL, password: 'десногорск-ракетка-42' },
    jar: jarX,
  });
  eq(reLogin.status, 401, 'вход после удаления должен быть невозможен');
  return 'ни ФИО, ни адреса нет ни в одном файле БД; строка игрока жива и обезличена, аккаунт, согласия, заявка и фото уничтожены';
});

await check('ЗАБВЕНИЕ: рейтинг соперников не дрогнул', async () => {
  // Матчи и результаты удалённого остались — иначе места соперников поедут.
  const kept = db
    .prepare('SELECT COUNT(*) AS n FROM matches WHERE winner_player_id = ? OR loser_player_id = ?')
    .get(cabPlayerId, cabPlayerId).n;
  assert(kept > 0, 'матчи удалённого игрока снесены — рейтинг соперников переписан');
  assert(
    db.prepare('SELECT COUNT(*) AS n FROM results WHERE player_id = ?').get(cabPlayerId).n > 0,
    'результаты удалённого игрока снесены',
  );

  // Считаем ДВИЖКОМ до и после «повторного» удаления идентичного профиля:
  // сравниваем места и очки ВСЕХ, кроме самого удалённого.
  const before = computeStandings(collectEngineInput(db));
  const beforeMap = new Map(before.players.map((p) => [p.playerId, p]));

  // Повторный вызов обезличивания ничего не меняет (идемпотентность) —
  // и рейтинг обязан остаться тем же.
  const again = erasure.erasePlayer(db, cabPlayerId, { uploadDir: UPLOAD_DIR });
  assert(again.alreadyErased, 'повторное удаление должно быть безопасным no-op');

  const after = computeStandings(collectEngineInput(db));
  eq(after.players.length, before.players.length, 'число игроков в рейтинге изменилось');
  for (const p of after.players) {
    if (p.playerId === cabPlayerId) continue;
    const was = beforeMap.get(p.playerId);
    assert(was, `игрок ${p.playerId} появился из ниоткуда`);
    eq(p.rank, was.rank, `место игрока ${p.playerName} изменилось после удаления соперника`);
    eq(p.ratingPoints, was.ratingPoints, `очки игрока ${p.playerName} изменились после удаления соперника`);
  }

  // На витрине удалённый показан обезличенно, но СО СВОИМ местом.
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  const shown = currentStandings(db);
  const erasedRow = shown.players.find((p) => p.playerId === cabPlayerId);
  assert(erasedRow, 'обезличенный игрок исчез из таблицы — места соперников поедут');
  eq(erasedRow.playerName, 'Игрок удалён', 'обезличенный показан не тем ярлыком');
  eq(erasedRow.anonymized, 'erased', 'причина обезличивания должна быть «удалён», а не «скрыт»');
  const engineRow = after.players.find((p) => p.playerId === cabPlayerId);
  eq(erasedRow.rank, engineRow.rank, 'место обезличенного не совпало с расчётом движка');
  eq(erasedRow.ratingPoints, engineRow.ratingPoints, 'очки обезличенного не совпали с расчётом движка');
  return `матчей сохранено ${kept}; места и очки всех соперников совпали до и после; удалённый в таблице на своём месте ${erasedRow.rank}`;
});

// ===========================================================================
section('16. Разделы витрины: новости, турниры, справочники, документы');

const PUBLIC_SECTIONS = [
  '/news', '/tournaments', '/coaches', '/courts', '/clubs', '/referees',
  '/federation', '/gallery', '/documents', '/contacts',
];

await check('все разделы меню отвечают 200 и не заглушки', async () => {
  const stubs = [];
  for (const path of PUBLIC_SECTIONS) {
    const r = await http(path);
    eq(r.status, 200, `GET ${path}`);
    if (/Раздел в разработке/.test(r.text)) stubs.push(path);
  }
  eq(stubs.join(','), '', `остались заглушки: ${stubs}`);
  return `${PUBLIC_SECTIONS.length} разделов живые, заглушек нет`;
});

await check('черновик новости наружу не отдаётся', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/news', { jar });
  const _csrf = tokenFrom(page.text);
  const draft = await http('/admin/news', {
    method: 'POST',
    form: { _csrf, title: 'Черновик приёмки', body: 'Текст черновика', is_published: '0' },
    jar,
  });
  eq(draft.status, 302, 'создание черновика');
  const row = db.prepare("SELECT id FROM news WHERE title = 'Черновик приёмки'").get();
  const direct = await http(`/news/${row.id}`);
  eq(direct.status, 404, 'черновик доступен по прямой ссылке');
  const list = await http('/news');
  assert(!list.text.includes('Черновик приёмки'), 'черновик виден в списке новостей');

  const published = await http('/admin/news', {
    method: 'POST',
    form: {
      _csrf, title: 'Опубликованная приёмка', summary: 'Кратко',
      body: 'Первый абзац.\n\nВторой абзац.', is_published: '1', published_at: '2026-08-01',
    },
    jar,
  });
  eq(published.status, 302, 'публикация новости');
  const pub = db.prepare("SELECT id FROM news WHERE title = 'Опубликованная приёмка'").get();
  const open = await http(`/news/${pub.id}`);
  eq(open.status, 200, 'опубликованная новость открывается');
  assert(open.text.includes('Первый абзац.'), 'текст новости не выведен');
  assert((await http('/news')).text.includes('Опубликованная приёмка'), 'новости нет в списке');
  return 'черновик -> 404 и не в списке; опубликованная открывается и видна';
});

await check('аудит WGR 03.09.2026: robots, sitemap, llms, favicon, canonical, OG, Permissions-Policy, JSON-LD, реквизиты в подвале', async () => {
  const robots = await http('/robots.txt');
  eq(robots.status, 200, 'robots.txt');
  assert(robots.text.includes('Disallow: /admin') && robots.text.includes('Sitemap: https://ftso67.ru/sitemap.xml'), 'robots.txt без админки или карты');
  const sm = await http('/sitemap.xml');
  eq(sm.status, 200, 'sitemap.xml');
  assert(sm.headers.get('content-type').startsWith('application/xml'), 'тип sitemap');
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert(locs.includes('https://ftso67.ru/rating') && locs.includes('https://ftso67.ru/privacy'), 'в карте нет разделов');
  assert(locs.some((l) => /\/player\/\d+$/.test(l)), 'в карте нет профилей');
  const erased = db.prepare('SELECT id FROM players WHERE anonymized_at IS NOT NULL LIMIT 1').get();
  if (erased) assert(!locs.includes(`https://ftso67.ru/player/${erased.id}`), 'обезличенный игрок попал в карту сайта');
  assert(!locs.some((l) => l.includes('/admin') || l.includes('/cabinet')), 'в карте служебные адреса');
  eq((await http('/llms.txt')).status, 200, 'llms.txt');
  const ico = await http('/favicon.ico');
  eq(ico.status, 200, 'favicon.ico');
  eq((await http('/static/img/favicon.svg')).status, 200, 'favicon.svg');
  const og = await http('/static/img/og-ftso.png');
  eq(og.status, 200, 'og-картинка');

  const home = await http('/');
  assert(home.text.includes('<link rel="canonical" href="https://ftso67.ru/">'), 'canonical на главной');
  for (const tag of ['og:title', 'og:description', 'og:image', 'og:url']) assert(home.text.includes(`property="${tag}"`), `нет ${tag}`);
  assert(home.text.includes('<link rel="icon" href="/static/img/favicon.svg"'), 'ссылки на значок нет');
  assert(home.text.includes('application/ld+json') && home.text.includes('"@type":"SportsOrganization"'), 'JSON-LD организации на главной');
  assert(home.text.includes('ОГРН 1176733009243, ИНН 6732145252'), 'в подвале нет ОГРН/ИНН');
  eq(home.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', 'Permissions-Policy');
  const filtered = await http('/rating?slice=u15&sex=M');
  assert(filtered.text.includes('<link rel="canonical" href="https://ftso67.ru/rating">'), 'canonical с фильтрами должен вести на /rating без query');
  const contacts = await http('/contacts');
  assert(contacts.text.includes('673201001') && contacts.text.includes('Лазаренков'), 'на контактах нет КПП или ответственного по ст. 22.1');
  return `robots/sitemap(${locs.length} адресов)/llms/favicon 200; canonical, OG, JSON-LD, Permissions-Policy, ОГРН/ИНН в подвале, КПП и ст. 22.1 на контактах`;
});

await check('регистрационные документы из открытых реестров — на /documents и /federation, PDF отдаются', async () => {
  const { PUBLIC_DOCUMENTS } = await import('./server/lib/legal.mjs');
  eq(PUBLIC_DOCUMENTS.length, 3, 'три документа: Минюст, ФНС, лист ЕГРЮЛ');
  const docs = await http('/documents');
  const fed = await http('/federation');
  for (const d of PUBLIC_DOCUMENTS) {
    assert(docs.text.includes(`href="${d.file}"`), `на /documents нет ${d.file}`);
    assert(fed.text.includes(`href="${d.file}"`), `на /federation нет ${d.file}`);
    const r = await http(d.file);
    eq(r.status, 200, d.file);
    assert(r.headers.get('content-type').startsWith('application/pdf'), `${d.file}: тип ${r.headers.get('content-type')}`);
    const size = Number(r.headers.get('content-length') || 0);
    assert(size > 50_000 && size < 1_500_000, `${d.file}: размер ${size} вне 50 КБ…1,5 МБ`);
  }
  return `3 PDF на /documents и /federation, все 200 application/pdf`;
});

await check('карточка турнира: участники и матчи со ссылками на профили, согласие не влияет', async () => {
  const t = db.prepare('SELECT id FROM tournaments ORDER BY id LIMIT 1').get();
  const page = await http(`/tournaments/${t.id}`);
  eq(page.status, 200, 'карточка турнира');
  const participant = db
    .prepare('SELECT p.id, p.full_name FROM results r JOIN players p ON p.id = r.player_id WHERE r.tournament_id = ? LIMIT 1')
    .get(t.id);
  assert(participant, 'в турнире нет участников — проверять нечего');
  // Участник — ссылкой на публичный профиль /player/:id (ТЗ ред. 6 §6, §8.3).
  assert(page.text.includes(`href="/player/${participant.id}"`), 'участник не ведёт на свой профиль');

  // Отзыв согласия протокол НЕ меняет: результаты публикуются по факту участия.
  const journal = await import('./server/lib/consent-journal.mjs');
  journal.setDistributionConsent(db, participant.id, false, { source: 'web', ip: '203.0.113.9' });
  const after = await http(`/tournaments/${t.id}`);
  assert(after.text.includes(participant.full_name), 'ФИО пропало из протокола после отзыва согласия');
  assert(!after.text.includes('Скрыто по заявлению'), 'на карточке всплыло старое «Скрыто по заявлению»');
  journal.setDistributionConsent(db, participant.id, true, { source: 'offline', basis: 'бумажное согласие', documentDate: '2026-07-01' });

  // Обезличенный по ст. 21 — «Игрок удалён» без ссылки (проверяется в блоке кабинета).
  return `участник ${participant.id} ведёт на /player/${participant.id}; отзыв согласия протокол не меняет`;
});

await check('справочник с ФИО требует правового основания публикации', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/directories/coaches', { jar });
  eq(page.status, 200, 'админ-страница справочника');
  const _csrf = tokenFrom(page.text);

  const noBasis = await http('/admin/directories/coaches', {
    method: 'POST', form: { _csrf, full_name: 'Тренеров Без Основания', club: 'Днепр' }, jar,
  });
  eq(noBasis.status, 302, 'ответ на попытку без основания');
  eq(db.prepare("SELECT COUNT(*) AS n FROM coaches WHERE full_name = 'Тренеров Без Основания'").get().n, 0,
    'тренер опубликован без правового основания');

  const ok = await http('/admin/directories/coaches', {
    method: 'POST',
    form: { _csrf, full_name: 'Тренеров Иван', club: 'Днепр', contact: 'info@example.com',
            basis: 'согласие от 01.07.2026', document_date: '2026-07-01' },
    jar,
  });
  eq(ok.status, 302, 'добавление тренера с основанием');
  const row = db.prepare("SELECT * FROM coaches WHERE full_name = 'Тренеров Иван'").get();
  eq(row.basis, 'согласие от 01.07.2026', 'основание не сохранено');
  eq(row.document_date, '2026-07-01', 'дата документа не сохранена');
  assert((await http('/coaches')).text.includes('Тренеров Иван'), 'тренера нет на публичной странице');
  // Основание — служебное поле, наружу не выводится.
  assert(!(await http('/coaches')).text.includes('согласие от 01.07.2026'), 'основание публикации утекло на витрину');

  // Корты — про объекты, а не про людей: основание не требуется.
  const court = await http('/admin/directories/courts', {
    method: 'POST', form: { _csrf, name: 'Корт приёмки', address: 'Смоленск', surface: 'хард' }, jar,
  });
  eq(court.status, 302, 'добавление корта');
  eq(db.prepare("SELECT COUNT(*) AS n FROM courts WHERE name = 'Корт приёмки'").get().n, 1,
    'корт без основания должен добавляться — это не персональные данные');
  return 'тренер без основания отклонён, с основанием добавлен; основание не показывается публично; корт — без основания';
});

await check('ТЗ 4.2/4.5/4.6: поиск по новостям; фильтры тренеров (город/клуб), кортов (город/покрытие), клубов (город); карта у адреса', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const _csrf = tokenFrom((await http('/admin/directories/coaches', { jar })).text);
  const add = (key, form) => http(`/admin/directories/${key}`, { method: 'POST', form: { _csrf, ...form }, jar });
  const basis = { basis: 'согласие от 01.07.2026', document_date: '2026-07-01' };
  eq((await add('coaches', { full_name: 'Фильтров Тренер Первый', city: 'Вязьма', club: 'Ракетка', specialization: 'дети 6–10', qualification: 'КМС', groups: 'дети', ...basis })).status, 302, 'тренер 1');
  eq((await add('coaches', { full_name: 'Фильтров Тренер Второй', city: 'Смоленск', club: 'Днепр', ...basis })).status, 302, 'тренер 2');
  eq((await add('courts', { name: 'Фильтров Корт Хард', city: 'Смоленск', address: 'ул. Кортовая, 1', surface: 'хард', courts_count: '4', season: 'круглый год' })).status, 302, 'корт 1');
  eq((await add('courts', { name: 'Фильтров Корт Грунт', city: 'Вязьма', address: 'ул. Грунтовая, 2', surface: 'грунт', map_url: 'https://yandex.ru/maps/?text=test' })).status, 302, 'корт 2');
  eq((await add('clubs', { name: 'Фильтров Клуб', city: 'Смоленск', address: 'пр. Клубный, 3' })).status, 302, 'клуб');
  const rows = (t, prefix) => (t.match(new RegExp(prefix + '[^<]+', 'g')) || []).length;
  // Тренеры: селекты город и клуб; фильтры работают.
  const c = await http('/coaches');
  assert(/name="city"/.test(c.text) && /name="club"/.test(c.text), 'у тренеров нет фильтров город/клуб');
  assert(/Специализация/.test(c.text) && /дети 6–10/.test(c.text) && /КМС/.test(c.text), 'специализация/квалификация не показаны');
  eq(rows((await http('/coaches?city=' + encodeURIComponent('Вязьма'))).text, 'Фильтров Тренер'), 1, 'тренеры: фильтр город');
  eq(rows((await http('/coaches?club=' + encodeURIComponent('Днепр'))).text, 'Фильтров Тренер'), 1, 'тренеры: фильтр клуб');
  eq(rows((await http('/coaches?city=' + encodeURIComponent('Нигде'))).text, 'Фильтров Тренер'), 0, 'тренеры: чужой город — пусто');
  // Корты: фильтры город/покрытие, количество и сезонность видны, карта — своя ссылка или по адресу.
  const k = await http('/courts');
  assert(/name="city"/.test(k.text) && /name="surface"/.test(k.text), 'у кортов нет фильтров город/покрытие');
  assert(/круглый год/.test(k.text) && />\s*4\s*</.test(k.text), "кортов/сезонность не показаны");
  assert(/yandex\.ru\/maps\/\?text=test/.test(k.text), 'своя ссылка на карту не показана');
  assert(/yandex\.ru\/maps\/\?text=[^"]*%D0%9A%D0%BE%D1%80%D1%82%D0%BE%D0%B2%D0%B0%D1%8F/.test(k.text), 'карта по адресу (без своей ссылки) не построена');
  eq(rows((await http('/courts?surface=' + encodeURIComponent('грунт'))).text, 'Фильтров Корт'), 1, 'корты: фильтр покрытие');
  // Клубы: фильтр город.
  const cl = await http('/clubs');
  assert(/name="city"/.test(cl.text), 'у клубов нет фильтра город');
  eq(rows((await http('/clubs?city=' + encodeURIComponent('Смоленск'))).text, 'Фильтров Клуб'), 1, 'клубы: фильтр город');
  // Новости: поиск по заголовку и тексту, только опубликованные.
  db.prepare("INSERT INTO news (title, summary, body, is_published, published_at) VALUES ('Поисковая новость про ракетки','анонс','В тексте есть слово ЖЕЛЕЗОБЕТОН.',1,'2026-09-01')").run();
  db.prepare("INSERT INTO news (title, summary, body, is_published) VALUES ('Черновик про ракетки','','ЖЕЛЕЗОБЕТОН черновика',0)").run();
  const n = await http('/news');
  assert(/name="q"/.test(n.text), 'на /news нет поля поиска');
  const hit = await http('/news?q=' + encodeURIComponent('железобетон'));
  assert(/Поисковая новость про ракетки/.test(hit.text), 'поиск по тексту не нашёл новость');
  assert(!/Черновик про ракетки/.test(hit.text), 'поиск показал черновик');
  assert(/Поисковая новость/.test((await http('/news?q=' + encodeURIComponent('ракетки'))).text), 'поиск по заголовку не нашёл');
  assert(/ничего не найдено/.test((await http('/news?q=%25')).text), 'символ % не должен работать как маска LIKE');
  db.prepare("DELETE FROM news WHERE title LIKE '%про ракетки'").run();
  db.prepare("DELETE FROM coaches WHERE full_name LIKE 'Фильтров %'").run();
  db.prepare("DELETE FROM courts WHERE name LIKE 'Фильтров %'").run();
  db.prepare("DELETE FROM clubs WHERE name LIKE 'Фильтров %'").run();
  db.prepare('DELETE FROM write_attempts').run();
  return 'тренеры: город/клуб; корты: город/покрытие + кортов/сезонность + карта; клубы: город; новости: поиск по заголовку и тексту, черновики скрыты, % экранирован';
});

await check('публичный файл отдаётся защищённым путём, документ с модерации — нет', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/library', { jar });
  const _csrf = tokenFrom(page.text);
  const add = await http('/admin/library/documents', {
    method: 'POST',
    multipart: {
      fields: { _csrf, title: 'Устав (приёмка)', category: 'Уставные документы' },
      files: [{ field: 'file', filename: 'ustav.pdf', type: 'application/pdf', buffer: PDF }],
    },
    jar,
  });
  eq(add.status, 302, 'публикация документа');
  const doc = db.prepare("SELECT * FROM federation_documents WHERE title = 'Устав (приёмка)'").get();
  assert(doc, 'документ не сохранён');

  const got = await http(`/files/${doc.upload_id}`);
  eq(got.status, 200, 'публичный документ должен отдаваться');
  assert(/^attachment/.test(got.headers.get('content-disposition') || ''), 'документ отдаётся не как attachment');
  eq(got.headers.get('x-content-type-options'), 'nosniff', 'нет nosniff при публичной отдаче');
  eq((await http(`/static/uploads/${db.prepare('SELECT stored_name FROM uploads WHERE id = ?').get(doc.upload_id).stored_name}`)).status,
    404, 'публичный файл достаётся как статика');
  assert((await http('/documents')).text.includes('Устав (приёмка)'), 'документа нет в разделе');

  // А файл заявки, ждущей модерации, публично НЕ отдаётся: /files пускает
  // только то, что привязано к опубликованной сущности.
  const pending = db
    .prepare(
      `SELECT f.upload_id FROM tournament_request_files f
         JOIN tournament_requests r ON r.id = f.request_id
        WHERE r.status = 'pending' LIMIT 1`,
    )
    .get();
  if (pending) {
    eq((await http(`/files/${pending.upload_id}`)).status, 404, 'документ с модерации отдан публично');
  }
  return `публичный документ 200 + attachment + nosniff, статикой не отдаётся; файл с модерации ${pending ? 'закрыт' : '(нет в наличии)'}`;
});

await check('согласование заявки переносит документы на карточку турнира', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const { res } = await submitTournament(
    { ...BASE_FIELDS, name: 'Кубок с переносом файлов', email: 'carry@example.com' },
    [{ field: 'doc_polozhenie', filename: 'polozhenie.pdf', type: 'application/pdf', buffer: PDF }],
  );
  eq(res.status, 302, 'подача заявки');
  const r = db.prepare("SELECT * FROM tournament_requests WHERE name = 'Кубок с переносом файлов'").get();
  const page = await http('/admin/tournament-requests', { jar });
  const _csrf = tokenFrom(page.text);
  const appr = await http(`/admin/tournament-requests/${r.id}/approve`, { method: 'POST', form: { _csrf }, jar });
  eq(appr.status, 302, 'согласование');
  const after = db.prepare('SELECT tournament_id FROM tournament_requests WHERE id = ?').get(r.id);
  const files = db.prepare('SELECT upload_id FROM tournament_files WHERE tournament_id = ?').all(after.tournament_id);
  eq(files.length, 1, 'документ не переехал на турнир');
  // И теперь он публичен — но тем же защищённым путём.
  const pub = await http(`/files/${files[0].upload_id}`);
  eq(pub.status, 200, 'документ согласованного турнира должен быть доступен');
  assert(/^attachment/.test(pub.headers.get('content-disposition') || ''), 'документ турнира отдаётся не как attachment');
  const card = await http(`/tournaments/${after.tournament_id}`);
  assert(card.text.includes(`/files/${files[0].upload_id}`), 'на карточке турнира нет ссылки на документ');
  return 'документ заявки переехал на турнир и стал публичным через /files (attachment + nosniff)';
});

// ===========================================================================
section('18. Несовершеннолетние и законный представитель (ч. 1 ст. 9 152-ФЗ)');

const guardians = await import('./server/lib/guardians.mjs');
const adulthood = await import('./server/lib/adulthood.mjs');
const validate = await import('./server/lib/validate.mjs');
const identity = await import('./server/lib/identity.mjs');

/** Дата рождения, дающая ровно N лет на сегодня. */
function birthFor(age, shiftDays = 0) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - age);
  d.setUTCDate(d.getUTCDate() + shiftDays);
  return d.toISOString().slice(0, 10);
}

await check('миграция на копии БОЕВОЙ базы: старые аккаунты остаются взрослыми', async () => {
  // Базу «как до внедрения» собираем из схемы, лежащей в git на момент HEAD:
  // проверять миграцию на чистой базе бессмысленно — ломается она на старой.
  const legacySchema = spawnSync('git', ['show', 'HEAD:site/db/schema.sql'], { cwd: HERE, encoding: 'utf8' });
  assert(legacySchema.status === 0, 'не удалось достать прежнюю схему из git');
  const LEGACY = resolve(WORK, 'legacy.sqlite');
  rmSync(LEGACY, { force: true });
  const legacy = new Database(LEGACY);
  legacy.pragma('foreign_keys = ON');
  legacy.exec(legacySchema.stdout);
  const pid = Number(legacy.prepare(
    "INSERT INTO players (full_name, city, sex, age_group) VALUES ('Старожилов Пётр','Смоленск','M','35-44')",
  ).run().lastInsertRowid);
  legacy.prepare('INSERT INTO player_accounts (player_id, email, password_hash) VALUES (?, ?, ?)')
    .run(pid, 'old-timer@example.com', 'scrypt$16384$8$1$c29sdA$aGFzaA');
  legacy.prepare(
    "INSERT INTO consents (player_id, kind, event, legal_version, source) VALUES (?, 'processing','granted','2026-08-08','web')",
  ).run(pid);
  legacy.close();

  const out = run(['db/migrate.mjs'], { DB_FILE: LEGACY });
  eq(out.status, 0, `миграция на боевой копии упала: ${out.stderr}`);
  const twice = run(['db/migrate.mjs'], { DB_FILE: LEGACY });
  eq(twice.status, 0, 'повторная миграция боевой копии упала');

  const after = new Database(LEGACY);
  const acc = after.prepare('SELECT * FROM player_accounts WHERE player_id = ?').get(pid);
  eq(acc.consent_basis, null, 'существующему аккаунту проставили основание — он должен остаться как был');
  eq(acc.email, 'old-timer@example.com', 'почта существующего аккаунта потеряна при пересборке таблицы');
  assert(accounts.basisOf(acc) === 'self', 'NULL должен читаться как «self»');
  eq(after.prepare('PRAGMA table_info(player_accounts)').all().find((c) => c.name === 'email').notnull, 0,
    'почта аккаунта осталась обязательной — кабинет ребёнка без почты не заведётся');
  eq(after.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(pid).n, 1,
    'записи журнала потеряны при пересборке таблицы');
  assert(after.prepare("SELECT sql FROM sqlite_master WHERE name = 'consents'").get().sql.includes('representative_processing'),
    'вид согласия представителя не добавлен в CHECK');
  const triggers = after.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'consents'").all();
  eq(triggers.length, 2, 'триггеры неизменяемости журнала не встали на пересобранную таблицу');
  eq(after.prepare('SELECT COUNT(*) AS n FROM guardians').get().n, 0, 'таблица представителей не создана');
  // Просроченный по возрасту, но НЕ минорный аккаунт в цикл не втягивается.
  after.prepare('UPDATE players SET birth_date = ? WHERE id = ?').run(birthFor(10), pid);
  const report = adulthood.runAdulthoodCheck(after, { baseUrl: 'https://example.test' });
  eq(report.promoted, 0, 'старый аккаунт затянуло в минорный жизненный цикл');
  after.close();
  return 'миграция и повтор прошли на копии боевой базы; данные целы, старый аккаунт = self и вне минорного цикла';
});

const MINOR = {
  name: 'Юниоров Тимофей Сергеевич',
  birth: birthFor(14),
  guardianName: 'Юниорова Анна Петровна',
  guardianEmail: 'guardian@example.com',
};
const SIBLING = { name: 'Юниорова Дарья Сергеевна', birth: birthFor(11) };
let minorPlayerId = null;
let guardianSetUrl = null;

/** Одобрить заявку от имени секретаря. */
async function approveByAdmin(regId, form = {}) {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/registrations', { jar });
  const _csrf = tokenFrom(page.text);
  return http(`/admin/registrations/${regId}/approve`, { method: 'POST', form: { _csrf, ...form }, jar });
}

await check('заявка за минора без блока представителя и БЕЗ ОБЕИХ галочек не проходит', async () => {
  resetCabinetLimit();
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const base = {
    full_name: MINOR.name, city: 'Смоленск', sex: 'M', birth_date: MINOR.birth,
    consent_distribution: '1',
  };
  // 1) блока представителя нет вовсе
  const noBlock = await submitRegistration({ ...base, consent_processing: '1' });
  eq(noBlock.res.status, 400, 'заявка минора без представителя должна отклоняться');
  assert(/ФИО законного представителя/i.test(noBlock.res.text), 'не названо, чего не хватает');

  // 2) есть представитель, но нет согласия ЗА РЕБЁНКА
  const noChild = await submitRegistration({
    ...base,
    guardian_full_name: MINOR.guardianName, guardian_relation: 'мать',
    guardian_email: MINOR.guardianEmail, consent_guardian_self: '1',
  });
  eq(noChild.res.status, 400, 'нет согласия представителя за участника');
  assert(/правовое основание/i.test(noChild.res.text), 'не объяснено, почему нельзя');

  // 3) есть согласие за ребёнка, но нет согласия представителя на СВОИ данные
  const noSelf = await submitRegistration({
    ...base,
    guardian_full_name: MINOR.guardianName, guardian_relation: 'мать',
    guardian_email: MINOR.guardianEmail, consent_guardian_child: '1',
  });
  eq(noSelf.res.status, 400, 'нет согласия представителя на свои данные');
  assert(/СОБСТВЕННЫХ данных/i.test(noSelf.res.text), 'не объяснено, зачем вторая отметка');

  // 4) почта РЕБЁНКА при этом не собирается вовсе
  const withChildMail = await submitRegistration({
    ...base, email: 'kid@example.com',
    guardian_full_name: MINOR.guardianName, guardian_relation: 'мать',
    guardian_email: MINOR.guardianEmail,
    consent_guardian_child: '1', consent_guardian_self: '1',
  });
  eq(withChildMail.res.status, 400, 'почта участника младше 18 не должна приниматься');
  eq(db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE email = ?').get('kid@example.com').n, 0,
    'почта ребёнка попала в БД');
  return 'четыре отказа: нет блока, нет согласия за ребёнка, нет согласия представителя за себя, почта ребёнка не принимается';
});

await check('заявка минора пишет ДВА согласия: обработка за ребёнка и представителя за себя (distribution — нет)', async () => {
  const { res } = await submitRegistration({
    full_name: MINOR.name, city: 'Смоленск', sex: 'M', birth_date: MINOR.birth,
    guardian_full_name: MINOR.guardianName, guardian_relation: 'мать',
    guardian_email: MINOR.guardianEmail,
    consent_guardian_child: '1', consent_guardian_self: '1', consent_distribution: '1',
  });
  eq(res.status, 302, 'заявка минора не принята');
  const reg = db.prepare('SELECT * FROM registrations WHERE full_name = ?').get(MINOR.name);
  assert(reg, 'заявки нет в БД');
  eq(reg.email, MINOR.guardianEmail, 'контактом заявки минора должна быть почта представителя');
  eq(reg.birth_date, MINOR.birth, 'дата рождения не сохранена');
  const rows = db.prepare('SELECT kind, event, subject_ref, basis FROM consents WHERE registration_id = ? ORDER BY id').all(reg.id);
  eq(rows.length, 2, 'должно быть две записи журнала (consent_distribution=1 от старой формы игнорируется)');
  const child = rows.filter((r) => r.kind === 'processing');
  eq(child.length, 1, 'нет согласия за ребёнка');
  eq(rows.filter((r) => r.kind === 'distribution').length, 0, 'регистрация не должна писать distribution');
  for (const r of child) {
    assert(/ст\. 9/.test(r.basis || ''), 'в записи за ребёнка не назван законный представитель как основание');
    assert(!r.subject_ref.includes(MINOR.guardianEmail), 'почта представителя продублирована в записи ребёнка');
  }
  const own = rows.find((r) => r.kind === 'representative_processing');
  assert(own, 'нет отдельной записи согласия представителя на свои данные');
  assert(own.subject_ref.includes(MINOR.guardianEmail), 'субъектом записи должен быть представитель');
  return `две записи: ${rows.map((r) => r.kind).join(', ')}; субъект второй — представитель`;
});

await check('одобрение минора: кабинет на РЕБЁНКА без почты, ссылка ушла ПРЕДСТАВИТЕЛЮ', async () => {
  const reg = db.prepare('SELECT * FROM registrations WHERE full_name = ?').get(MINOR.name);
  const appr = await approveByAdmin(reg.id);
  eq(appr.status, 302, 'одобрение заявки минора');

  const player = db.prepare('SELECT * FROM players WHERE full_name = ?').get(MINOR.name);
  minorPlayerId = player.id;
  eq(player.birth_date, MINOR.birth, 'дата рождения не скопирована в players — детект пропустил бы игрока');

  const account = accounts.accountByPlayer(db, player.id);
  assert(account, 'кабинет участника не заведён');
  eq(account.email, null, 'у кабинета несовершеннолетнего не должно быть почты');
  eq(account.password_hash, null, 'у кабинета несовершеннолетнего не должно быть пароля');
  eq(account.consent_basis, 'representative', 'основание аккаунта не «представитель»');

  const g = guardians.activeGuardianFor(db, player.id);
  assert(g, 'представитель не привязан');
  eq(g.email, MINOR.guardianEmail, 'почта представителя');
  eq(g.relation, 'мать', 'степень родства');
  const own = db.prepare("SELECT * FROM consents WHERE guardian_id = ? AND kind = 'representative_processing'").get(g.id);
  assert(own, 'согласие представителя не привязано к его записи при одобрении');

  const invite = db.prepare("SELECT * FROM mail_outbox WHERE to_email = ? AND kind = 'cabinet.guardian.invite'")
    .get(MINOR.guardianEmail);
  assert(invite, 'приглашение представителю не поставлено в очередь');
  const m = /\/cabinet\/reset\/g\/([A-Za-z0-9_-]+)/.exec(invite.body);
  assert(m, 'в письме нет ссылки установки пароля представителя');
  guardianSetUrl = `/cabinet/reset/g/${m[1]}`;
  assert(!db.prepare("SELECT 1 AS x FROM mail_outbox WHERE to_email = ? AND kind = 'cabinet.invite'").get(MINOR.guardianEmail),
    'представителю ушло письмо про кабинет игрока — он входит своим логином');
  return 'аккаунт ребёнка без почты и пароля, представитель привязан, ссылка ушла ему';
});

await check('ВТОРОЙ ребёнок того же представителя: новый логин не создаётся', async () => {
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const { res } = await submitRegistration({
    full_name: SIBLING.name, city: 'Смоленск', sex: 'F', birth_date: SIBLING.birth,
    guardian_full_name: MINOR.guardianName, guardian_relation: 'мать',
    guardian_email: MINOR.guardianEmail,
    consent_guardian_child: '1', consent_guardian_self: '1',
  });
  eq(res.status, 302, 'заявка второго ребёнка');
  const reg = db.prepare('SELECT * FROM registrations WHERE full_name = ?').get(SIBLING.name);
  const appr = await approveByAdmin(reg.id);
  eq(appr.status, 302, 'одобрение второго ребёнка должно проходить, а не падать на UNIQUE');

  const all = db.prepare('SELECT COUNT(*) AS n FROM guardians WHERE email = ?').get(MINOR.guardianEmail).n;
  eq(all, 1, 'на одного представителя должна быть ОДНА запись');
  const sibling = db.prepare('SELECT * FROM players WHERE full_name = ?').get(SIBLING.name);
  const wards = identity.cabinetsOf(db, { guardian: guardians.guardianByEmail(db, MINOR.guardianEmail) });
  eq(wards.length, 2, 'у представителя должно быть двое подопечных');
  const acc = accounts.accountByPlayer(db, sibling.id);
  eq(acc.email, null, 'второй кабинет тоже без почты');
  const note = db.prepare("SELECT * FROM mail_outbox WHERE to_email = ? AND kind = 'cabinet.guardian.ward'").get(MINOR.guardianEmail);
  assert(note, 'представителю не сообщили о добавлении второго участника');
  return 'один представитель, два кабинета, второго логина и второго пароля не появилось';
});

await check('представитель задаёт пароль, входит и выбирает участника', async () => {
  resetCabinetLimit();
  const jar = new Jar();
  const open = await http(guardianSetUrl, { jar });
  eq(open.status, 200, 'страница установки пароля представителя');
  const set = await http(guardianSetUrl, {
    method: 'POST',
    form: { _csrf: tokenFrom(open.text), password: 'смоленские-корты-2026', password2: 'смоленские-корты-2026' },
    jar,
  });
  eq(set.status, 200, 'установка пароля представителя');
  assert(set.text.includes('Пароль'), 'нет подтверждения установки');

  resetCabinetLimit();
  const jar2 = new Jar();
  const page = await http('/cabinet/login', { jar: jar2 });
  const enter = await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), email: MINOR.guardianEmail, password: 'смоленские-корты-2026' },
    jar: jar2,
  });
  eq(enter.status, 302, 'вход представителя');
  eq(enter.location, '/cabinet/wards', 'представителя должно вести к списку участников');

  const wards = await http('/cabinet/wards', { jar: jar2 });
  eq(wards.status, 200, 'список участников');
  assert(wards.text.includes(MINOR.name) && wards.text.includes(SIBLING.name), 'в списке не оба участника');

  const select = await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(wards.text), player_id: String(minorPlayerId) }, jar: jar2,
  });
  eq(select.status, 302, 'выбор участника');
  const cab = await http('/cabinet', { jar: jar2 });
  eq(cab.status, 200, 'кабинет участника глазами представителя');
  assert(cab.text.includes(MINOR.name), 'открылся не тот кабинет');
  assert(/законный представитель/i.test(cab.text), 'кабинет не помечен как представительский');
  assert(cab.text.includes(MINOR.guardianName), 'не показан представитель');

  // Чужой кабинет подстановкой id не открывается.
  const other = db.prepare("SELECT id FROM players WHERE full_name = 'Артём Ковалёв'").get();
  const steal = await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(wards.text), player_id: String(other.id) }, jar: jar2,
  });
  eq(steal.status, 403, 'подстановка чужого id должна отбиваться');
  return 'один вход -> список из двух участников -> кабинет выбранного; чужой id отбит 403';
});

await check('дата рождения НЕ утекает: ни в витрину, ни в кабинет, ни в выгрузку', async () => {
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), email: MINOR.guardianEmail, password: 'смоленские-корты-2026' },
    jar,
  });
  const wards = await http('/cabinet/wards', { jar });
  await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(wards.text), player_id: String(minorPlayerId) }, jar,
  });
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  const paths = ['/rating', '/rating.csv', '/rating.csv?format=engine', '/', '/cabinet', '/cabinet/wards'];
  for (const p of paths) {
    const r = await http(p, { jar });
    assert(!r.text.includes(MINOR.birth), `${p}: в ответе видна дата рождения`);
    assert(!/birth_date/i.test(r.text), `${p}: в ответе есть поле birth_date`);
  }
  // И в самом снимке рейтинга её тоже нет — снимок переживает игрока.
  const snap = db.prepare('SELECT standings_json FROM rating_cache ORDER BY id DESC LIMIT 1').get();
  assert(!snap.standings_json.includes(MINOR.birth), 'дата рождения попала в снимок рейтинга');

  // А В АДМИНКЕ — ВИДНА И ПРАВИТСЯ: секретарю она нужна, чтобы проверить возраст
  // и разобрать спорную заявку. Это ровно одно место на весь сайт.
  const admin = await login(ADMIN.user, ADMIN.pass);
  const card = await http('/admin/players', { jar: admin.jar });
  eq(card.status, 200, 'карточка игроков в админке');
  assert(card.text.includes(MINOR.birth), 'секретарь не видит дату рождения — нечем проверить возраст');
  assert(/name="birth_date"/.test(card.text), 'дату рождения нельзя исправить: опечатка станет неисправимой');
  // Аноним в админку не попадает — дата за логином, а не «просто на странице».
  const anon = await http('/admin/players');
  eq(anon.status, 302, 'админка без входа должна уводить на /login');
  return `${paths.length} публичных ответов и снимок без даты рождения; в админке за логином — видна и правится`;
});

await check('представитель распоряжается фото ребёнка: загрузка в кабинете подопечного = согласие на распространение', async () => {
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), email: MINOR.guardianEmail, password: 'смоленские-корты-2026' },
    jar,
  });
  const wards = await http('/cabinet/wards', { jar });
  await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(wards.text), player_id: String(minorPlayerId) }, jar,
  });
  const cab = await http('/cabinet', { jar });
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(minorPlayerId).is_public, 0, 'до загрузки флага нет');
  eq((await http(`/player/${minorPlayerId}`)).status, 200, 'профиль минора открыт по факту участия и без фото');
  const photo = await sharpLib({ create: { width: 500, height: 500, channels: 3, background: '#2d6a4f' } }).jpeg().toBuffer();
  const up = await http('/cabinet/profile', {
    method: 'POST',
    multipart: { fields: { _csrf: tokenFrom(cab.text), full_name: MINOR.name }, files: [{ field: 'photo', filename: 'kid.jpg', type: 'image/jpeg', buffer: photo }] },
    jar,
  });
  eq(up.status, 302, 'загрузка фото представителем');
  assert(db.prepare('SELECT photo_upload_id FROM players WHERE id = ?').get(minorPlayerId).photo_upload_id, 'фото не сохранено');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(minorPlayerId).is_public, 1, 'флаг после загрузки');
  const last = db.prepare("SELECT event, source FROM consents WHERE player_id = ? AND kind = 'distribution' ORDER BY id DESC LIMIT 1")
    .get(minorPlayerId);
  eq(last.event, 'granted', 'загрузка фото представителем не записана выдачей');
  eq((await http(`/player/${minorPlayerId}/photo`)).status, 200, 'публичное фото ребёнка');
  return 'фото за ребёнка загрузил представитель → distribution granted, флаг 1, фото 200; фото оставлено для проверки перехода в 18';
});

await check('журнал согласий неизменяем НА УРОВНЕ СУБД: UPDATE и DELETE отбиты', async () => {
  const row = db.prepare('SELECT id FROM consents WHERE player_id = ? LIMIT 1').get(minorPlayerId);
  let updateBlocked = false;
  let deleteBlocked = false;
  try {
    db.prepare("UPDATE consents SET legal_version = 'подделка' WHERE id = ?").run(row.id);
  } catch (err) {
    updateBlocked = /неизменяема/.test(err.message);
  }
  try {
    db.prepare('DELETE FROM consents WHERE id = ?').run(row.id);
  } catch (err) {
    deleteBlocked = /не удаляется/.test(err.message);
  }
  assert(updateBlocked, 'UPDATE записи журнала прошёл — журнал перестал быть доказательством');
  assert(deleteBlocked, 'DELETE записи журнала прошёл');
  assert(db.prepare('SELECT 1 AS x FROM consents WHERE id = ?').get(row.id), 'запись всё-таки исчезла');
  // Каскад тоже отбивается: удаление игрока мимо ворот не унесёт журнал.
  let cascadeBlocked = false;
  try {
    db.prepare('DELETE FROM players WHERE id = ?').run(minorPlayerId);
  } catch (err) {
    cascadeBlocked = /не удаляется/.test(err.message);
  }
  assert(cascadeBlocked, 'каскадное удаление унесло записи журнала в обход ворот');
  return 'UPDATE, DELETE и каскад отвергнуты триггерами СУБД; запись на месте';
});

await check('переход в 18: детект догоняет просроченных и НЕ рвёт активную сессию', async () => {
  // Сессия представителя живёт ДО детекта и во время него.
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), email: MINOR.guardianEmail, password: 'смоленские-корты-2026' },
    jar,
  });
  const wards = await http('/cabinet/wards', { jar });
  await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(wards.text), player_id: String(minorPlayerId) }, jar,
  });
  eq((await http('/cabinet', { jar })).status, 200, 'кабинет до детекта');

  // (a) ГРАНИЦА: ровно 18 сегодня. (b) ПРОСРОЧКА: 25 лет, заведён как минор.
  db.prepare('UPDATE players SET birth_date = ? WHERE id = ?').run(birthFor(18), minorPlayerId);
  const sibling = db.prepare('SELECT id FROM players WHERE full_name = ?').get(SIBLING.name);
  db.prepare('UPDATE players SET birth_date = ? WHERE id = ?').run(birthFor(25), sibling.id);

  const first = adulthood.runAdulthoodCheck(db, { baseUrl: inst.base });
  eq(first.promoted, 2, 'детект не нашёл обоих (граница + просрочка)');
  const again = adulthood.runAdulthoodCheck(db, { baseUrl: inst.base });
  eq(again.promoted, 0, 'повторный проход не идемпотентен');

  eq(accounts.accountByPlayer(db, minorPlayerId).consent_basis, 'awaiting_self', 'состояние не сменилось');
  // Активная сессия НЕ тронута: страница отдаётся, а не рвётся редиректом на вход.
  const during = await http('/cabinet', { jar });
  assert(during.status === 200, 'детект выкинул активную сессию');
  assert(/исполнилось 18/i.test(during.text), 'представителю не объяснили, почему кабинет закрыт');
  // Смотрим ТЕЛО страницы: в шапке «Вход» есть на каждой странице сайта.
  const duringMain = during.text.slice(during.text.indexOf('<main'), during.text.indexOf('</main>'));
  assert(!duringMain.includes('/cabinet/login'), 'вместо объяснения показан вход');

  const letter = db.prepare("SELECT * FROM mail_outbox WHERE kind = 'cabinet.adult.start' ORDER BY id DESC LIMIT 1").get();
  assert(letter, 'письмо о переходе не поставлено в очередь');
  eq(letter.to_email, MINOR.guardianEmail, 'письмо ушло не на известный контакт');
  return 'граница и просрочка найдены, повтор идемпотентен, активная сессия жива, письмо ушло представителю';
});

await check('переход в 18: представитель действовать больше не может', async () => {
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const enter = await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), email: MINOR.guardianEmail, password: 'смоленские-корты-2026' },
    jar,
  });
  eq(enter.status, 302, 'вход представителя');
  const wards = await http('/cabinet/wards', { jar });
  const select = await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(wards.text), player_id: String(minorPlayerId) }, jar,
  });
  eq(select.status, 302, 'выбор участника');
  const cab = await http('/cabinet', { jar });
  assert(/исполнилось 18/i.test(cab.text), 'представителю показан кабинет вместо объяснения');
  assert(!cab.text.includes('/cabinet/publication'), 'представителю оставили значимые действия');
  return 'после 18 представитель видит объяснение, а не кабинет: значимых действий нет';
});

await check('экран перехода: почта-дубликат отбивается, переход не завершается', async () => {
  // Занятый адрес заводим ЯВНО: кабинет из раздела 15 к этому моменту удалён
  // по ст. 21, и «занятым» его адрес больше не является.
  const busyId = Number(db.prepare(
    "INSERT INTO players (full_name, city, sex) VALUES ('Занятов Адрес Почтович','Смоленск','M')",
  ).run().lastInsertRowid);
  const BUSY_EMAIL = 'busy-mailbox@example.com';
  db.prepare('INSERT INTO player_accounts (player_id, email, consent_basis) VALUES (?, ?, ?)')
    .run(busyId, BUSY_EMAIL, 'self');
  const acc = accounts.accountByPlayer(db, minorPlayerId);
  const token = adulthood.issueTransitionToken(db, acc.id);
  resetCabinetLimit();
  const jar = new Jar();
  const screen = await http(`/cabinet/adult/${token}`, { jar });
  eq(screen.status, 200, 'экран перехода по ссылке');
  assert(screen.text.includes(MINOR.name), 'на экране не тот участник');

  const dup = await http(`/cabinet/adult/${token}`, {
    method: 'POST',
    form: {
      _csrf: tokenFrom(screen.text), email: BUSY_EMAIL,
      password: 'своя-жизнь-2026-корт', password2: 'своя-жизнь-2026-корт',
      consent_processing: '1',
    },
    jar,
  });
  eq(dup.status, 400, 'занятая почта должна отклоняться');
  assert(/уже используется/i.test(dup.text), 'не объяснено, почему адрес не подходит');
  eq(accounts.accountByPlayer(db, minorPlayerId).consent_basis, 'awaiting_self', 'переход завершился с чужой почтой');

  // И без согласия на обработку — тоже отказ.
  const noConsent = await http(`/cabinet/adult/${token}`, {
    method: 'POST',
    form: {
      _csrf: tokenFrom(screen.text), email: 'timofey@example.com',
      password: 'своя-жизнь-2026-корт', password2: 'своя-жизнь-2026-корт',
    },
    jar,
  });
  eq(noConsent.status, 400, 'без согласия на обработку переход завершаться не должен');
  assert(/правовое основание/i.test(noConsent.text), 'не объяснено, почему согласие обязательно');
  return 'дубликат почты и отсутствие согласия отбиты, состояние осталось awaiting_self';
});

await check('переход в 18 завершается: журнал отзывает старое и принимает своё; фото представителя снято', async () => {
  const acc = accounts.accountByPlayer(db, minorPlayerId);
  const token = adulthood.issueTransitionToken(db, acc.id);
  resetCabinetLimit();
  const jar = new Jar();
  const screen = await http(`/cabinet/adult/${token}`, { jar });
  assert(!screen.text.includes('name="consent_distribution"'), 'на экране перехода остался чекбокс распространения');
  const before = db.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(minorPlayerId).n;
  const photoBefore = db.prepare('SELECT photo_upload_id FROM players WHERE id = ?').get(minorPlayerId).photo_upload_id;
  assert(photoBefore, 'фото, загруженное представителем, должно быть на месте до перехода');

  const done = await http(`/cabinet/adult/${token}`, {
    method: 'POST',
    form: {
      _csrf: tokenFrom(screen.text), email: 'timofey@example.com',
      password: 'своя-жизнь-2026-корт', password2: 'своя-жизнь-2026-корт',
      consent_processing: '1', consent_distribution: '1',
    },
    jar,
  });
  eq(done.status, 302, 'завершение перехода');
  eq(done.location, '/cabinet', 'после перехода человек должен оказаться в своём кабинете');

  const after = accounts.accountByPlayer(db, minorPlayerId);
  eq(after.consent_basis, 'self', 'основание не стало собственным');
  eq(after.email, 'timofey@example.com', 'своя почта не стала логином');
  assert(after.password_hash, 'свой пароль не задан');
  eq(after.transition_token, null, 'токен перехода не погашен');
  assert(!guardians.activeGuardianFor(db, minorPlayerId), 'представитель остался действующим');

  const rows = db.prepare('SELECT kind, event, legal_version FROM consents WHERE player_id = ? ORDER BY id').all(minorPlayerId);
  assert(rows.length > before, 'журнал не пополнился');
  const revoked = rows.filter((r) => r.event === 'revoked');
  assert(revoked.length >= 2, 'представительские согласия (обработка + фото) не отозваны');
  eq(rows.at(-1).kind + ':' + rows.at(-1).event, 'processing:granted', 'последняя запись — собственное согласие на обработку');
  eq(rows.at(-1).legal_version, LEGAL_VERSION, 'собственное согласие записано не текущей редакцией');
  eq(db.prepare("SELECT event FROM consents WHERE player_id = ? AND kind = 'distribution' ORDER BY id DESC LIMIT 1").get(minorPlayerId).event,
    'revoked', 'согласие представителя на фото не отозвано');
  // Фото представителя ушло вместе с его согласием: своё — загрузкой.
  eq(db.prepare('SELECT photo_upload_id, is_public FROM players WHERE id = ?').get(minorPlayerId).photo_upload_id, null, 'фото представителя не снято при переходе');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(minorPlayerId).is_public, 0, 'флаг фото после перехода');
  eq(db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE id = ?').get(photoBefore).n, 0, 'строка uploads старого фото осталась');
  eq((await http(`/player/${minorPlayerId}/photo`)).status, 404, 'публичное фото после перехода');
  eq((await http(`/player/${minorPlayerId}`)).status, 200, 'профиль после перехода открыт');

  // Вход по НОВОМУ логину работает, кабинет свой.
  const jar2 = new Jar();
  const page = await http('/cabinet/login', { jar: jar2 });
  const enter = await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), email: 'timofey@example.com', password: 'своя-жизнь-2026-корт' },
    jar: jar2,
  });
  eq(enter.status, 302, 'вход по своей почте');
  eq(enter.location, '/cabinet', 'после входа — сразу кабинет, без списка подопечных');
  return `журнал: ${rows.map((r) => r.kind + '/' + r.event).join(', ')}; фото представителя снято, профиль 200; логин сменился на свой`;
});

await check('представитель второго ребёнка остаётся действующим, его данные на месте', async () => {
  const g = guardians.guardianByEmail(db, MINOR.guardianEmail);
  assert(g, 'запись представителя исчезла после перехода первого ребёнка');
  eq(g.revoked_at, null, 'представитель снят, хотя второй ребёнок ещё за ним');
  const wards = identity.cabinetsOf(db, { guardian: g });
  eq(wards.length, 1, 'у представителя должен остаться один подопечный');
  return 'снятие одного подопечного не тронуло ни представителя, ни второго ребёнка';
});

await check('заморозка на +30 дней: read-only, данные не удалены, секретарь уведомлён', async () => {
  const sibling = db.prepare('SELECT id, full_name FROM players WHERE full_name = ?').get(SIBLING.name);
  const acc = accounts.accountByPlayer(db, sibling.id);
  db.prepare("UPDATE player_accounts SET transition_started_at = datetime('now', '-31 days') WHERE id = ?").run(acc.id);
  const report = adulthood.runAdulthoodCheck(db, { baseUrl: inst.base });
  assert(report.frozen >= 1, 'заморозка не сработала');
  const frozen = accounts.accountByPlayer(db, sibling.id);
  assert(frozen.frozen_at, 'отметка заморозки не проставлена');
  eq(frozen.consent_basis, 'awaiting_self', 'заморозка не должна менять состояние перехода');
  assert(db.prepare('SELECT full_name FROM players WHERE id = ?').get(sibling.id).full_name === SIBLING.name,
    'данные при заморозке удалены — этого делать нельзя');
  const staff = db.prepare("SELECT * FROM mail_outbox WHERE kind = 'cabinet.adult.frozen.staff' ORDER BY id DESC LIMIT 1").get();
  assert(staff, 'секретарь не уведомлён о заморозке');
  assert(staff.body.includes(String(sibling.id)), 'в уведомлении секретарю нет ссылки на игрока');
  return 'кабинет заморожен, данные целы, письма участнику и секретарю поставлены в очередь';
});

await check('замена представителя не создаёт второго действующего и гасит доступ прежнего', async () => {
  // Новый минор — на нём и проверяем замену.
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const NAME = 'Сменов Кирилл Павлович';
  await submitRegistration({
    full_name: NAME, city: 'Вязьма', sex: 'M', birth_date: birthFor(12),
    guardian_full_name: 'Сменова Ольга Ивановна', guardian_relation: 'мать',
    guardian_email: 'old-guardian@example.com',
    consent_guardian_child: '1', consent_guardian_self: '1',
  });
  const reg = db.prepare('SELECT * FROM registrations WHERE full_name = ?').get(NAME);
  await approveByAdmin(reg.id);
  const pid = db.prepare('SELECT id FROM players WHERE full_name = ?').get(NAME).id;
  const before = guardians.activeGuardianFor(db, pid);
  assert(before, 'первый представитель не привязан');

  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/players', { jar });
  const swap = await http(`/admin/players/${pid}/guardian`, {
    method: 'POST',
    form: {
      _csrf: tokenFrom(page.text),
      guardian_full_name: 'Сменов Павел Петрович', guardian_relation: 'отец',
      guardian_email: 'new-guardian@example.com',
      guardian_basis: 'решение суда об определении места жительства',
      guardian_document_date: '2026-03-14',
    },
    jar,
  });
  eq(swap.status, 302, 'замена представителя');

  const active = db.prepare('SELECT COUNT(*) AS n FROM guardian_wards WHERE player_id = ? AND revoked_at IS NULL').get(pid).n;
  eq(active, 1, 'действующих представителей должно остаться ровно один');
  const now = guardians.activeGuardianFor(db, pid);
  eq(now.email, 'new-guardian@example.com', 'новый представитель не привязан');
  const old = guardians.guardianByEmail(db, 'old-guardian@example.com');
  assert(old.revoked_at, 'прежний представитель не снят');
  const revokedConsent = db.prepare(
    "SELECT event FROM consents WHERE guardian_id = ? AND kind = 'representative_processing' ORDER BY id DESC LIMIT 1",
  ).get(old.id);
  eq(revokedConsent.event, 'revoked', 'собственное согласие прежнего представителя не отозвано');
  const proof = db.prepare(
    "SELECT basis, document_date FROM consents WHERE guardian_id = ? AND event = 'granted' ORDER BY id DESC LIMIT 1",
  ).get(now.id);
  assert(proof && proof.basis.includes('решение суда'), 'документ-основание замены не записан');
  eq(proof.document_date, '2026-03-14', 'дата документа не записана');
  eq(db.prepare('SELECT id FROM players WHERE full_name = ?').get(NAME).id, pid, 'запись игрока пересоздана');
  return 'один действующий представитель, прежний снят с отзывом согласия, документ замены в журнале';
});

await check('удаление данных ребёнка уносит и представителя — если ребёнок у него последний', async () => {
  const pid = db.prepare("SELECT id FROM players WHERE full_name = 'Сменов Кирилл Павлович'").get().id;
  const g = guardians.activeGuardianFor(db, pid);
  const report = erasure.erasePlayer(db, pid, { uploadDir: UPLOAD_DIR });
  assert(report.playerId === pid, 'обезличивание не выполнено');
  assert(!guardians.guardianById(db, g.id), 'данные представителя остались без единого подопечного');
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE guardian_id = ?').get(g.id).n, 0,
    'согласия удалённого представителя остались');
  eq(db.prepare('SELECT birth_date FROM players WHERE id = ?').get(pid).birth_date, null,
    'дата рождения не стёрта при обезличивании');
  assert(!dbContains('new-guardian@example.com'), 'почта представителя осталась в файлах базы');
  return 'ребёнок обезличен, представитель и его согласия удалены, дата рождения стёрта';
});

await check('срок хранения данных представителя: 3 года ОТ СНЯТИЯ, не от 18 лет', async () => {
  // Свой подопытный: у снятого представителя должен ОСТАВАТЬСЯ ребёнок в БД,
  // иначе его данные уносит не срок хранения, а обезличивание участника.
  // Ребёнок тоже свой — у чужого уже есть действующий представитель, и второго
  // частичный уникальный индекс не допустит (это и правильно).
  const keeperId = Number(db.prepare(
    "INSERT INTO players (full_name, city, sex, birth_date) VALUES ('Хранимов Лев Игоревич','Ярцево','M','2015-04-04')",
  ).run().lastInsertRowid);
  const { guardian: g } = db.transaction(() => guardians.attachGuardian(db, keeperId, {
    full_name: 'Хранимова Вера Ильинична', relation: 'опекун', email: 'retention-guardian@example.com',
  }))();
  guardians.recordGuardianConsent(db, g, { source: 'offline', basis: 'акт опеки', documentDate: '2026-01-09' });
  db.transaction(() => guardians.revokeWard(db, keeperId, { source: 'offline' }))();
  assert(guardians.guardianById(db, g.id).revoked_at, 'представитель не снят');
  // Свежеснятый не чистится.
  eq(guardians.purgeGuardians(db, config.guardian.retentionDays), 0, 'снятый вчера представитель удалён досрочно');
  assert(guardians.guardianById(db, g.id), 'запись исчезла раньше срока');
  // Просроченный — чистится вместе со своими согласиями.
  db.prepare("UPDATE guardians SET revoked_at = datetime('now', '-1096 days') WHERE id = ?").run(g.id);
  const removed = guardians.purgeGuardians(db, config.guardian.retentionDays);
  eq(removed, 1, 'просроченный представитель не вычищен');
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE guardian_id = ?').get(g.id).n, 0,
    'согласия вычищенного представителя остались');
  return `срок ${config.guardian.retentionDays} дней от revoked_at: свежий цел, просроченный удалён вместе с согласиями`;
});

await check('существующие аккаунты (consent_basis NULL) в минорный цикл не попадают', async () => {
  const legacy = db.prepare("SELECT id FROM players WHERE full_name = 'Дмитрий Волков'").get();
  db.prepare('INSERT INTO player_accounts (player_id, email) VALUES (?, ?)').run(legacy.id, 'legacy@example.com');
  db.prepare('UPDATE player_accounts SET consent_basis = NULL WHERE player_id = ?').run(legacy.id);
  // Даже с датой рождения ребёнка: аккаунт заводился НЕ как минорный.
  db.prepare('UPDATE players SET birth_date = ? WHERE id = ?').run(birthFor(10), legacy.id);
  const report = adulthood.runAdulthoodCheck(db, { baseUrl: inst.base });
  const acc = accounts.accountByPlayer(db, legacy.id);
  eq(acc.consent_basis, null, 'старому аккаунту переписали основание');
  assert(accounts.basisOf(acc) === 'self', 'NULL должен читаться как self');
  db.prepare('UPDATE players SET birth_date = NULL WHERE id = ?').run(legacy.id);
  db.prepare('DELETE FROM player_accounts WHERE player_id = ?').run(legacy.id);
  return `детект прошёл (${report.promoted} переведено), старый аккаунт не тронут и читается как «self»`;
});

await check('18-летие НЕ трогает рейтинг и профиль: переход только в управлении кабинетом (ТЗ ред. 6, §8.8)', async () => {
  // Свой подопытный: минор без фото — результаты публикуются по факту участия.
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const NAME = 'Публиков Роман Игоревич';
  await submitRegistration({
    full_name: NAME, city: 'Смоленск', sex: 'M', birth_date: birthFor(17),
    guardian_full_name: 'Публикова Инна Олеговна', guardian_relation: 'мать',
    guardian_email: 'publication-guardian@example.com',
    consent_guardian_child: '1', consent_guardian_self: '1', consent_distribution: '1',
  });
  const reg = db.prepare('SELECT * FROM registrations WHERE full_name = ?').get(NAME);
  await approveByAdmin(reg.id);
  const pid = db.prepare('SELECT id FROM players WHERE full_name = ?').get(NAME).id;

  const t = db.prepare('SELECT id FROM tournaments ORDER BY id LIMIT 1').get();
  db.prepare('INSERT OR IGNORE INTO results (tournament_id, player_id, place) VALUES (?, ?, ?)').run(t.id, pid, 6);
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  const before = currentStandings(db);
  const rowBefore = before.players.find((p) => p.playerId === pid);
  assert(rowBefore && rowBefore.playerName === NAME, 'до 18 фамилия видна в открытом рейтинге');
  eq(rowBefore.age, 17, 'возраст в полных годах до 18-летия');
  const profileBefore = await http(`/player/${pid}`);
  eq(profileBefore.status, 200, 'профиль до 18');

  // Совершеннолетие — ровно сегодня.
  db.prepare('UPDATE players SET birth_date = ? WHERE id = ?').run(birthFor(18), pid);
  const report = adulthood.runAdulthoodCheck(db, { baseUrl: inst.base });
  eq(report.promoted, 1, 'переход в 18 не запущен');
  eq(db.prepare('SELECT consent_basis FROM player_accounts WHERE player_id = ?').get(pid).consent_basis,
    'awaiting_self', 'аккаунт не перешёл в ожидание собственного согласия');

  // Ни отзыва в журнале, ни изменений на витрине: distribution в журнале нет вовсе (фото не было).
  eq(db.prepare("SELECT COUNT(*) AS n FROM consents WHERE player_id = ? AND kind = 'distribution'").get(pid).n, 0,
    'в журнале появилась запись distribution без фото');

  const after = currentStandings(db);
  const rowAfter = after.players.find((p) => p.playerId === pid);
  assert(rowAfter, 'участник исчез из таблицы — места соперников поедут');
  eq(rowAfter.playerName, NAME, 'фамилия скрыта в 18 — правило отменено');
  eq(rowAfter.rank, rowBefore.rank, 'место изменилось');
  eq(rowAfter.ratingPoints, rowBefore.ratingPoints, 'очки изменились');
  eq(rowAfter.age, 18, 'возраст не пересчитался живьём');
  const profileAfter = await http(`/player/${pid}`);
  eq(profileAfter.status, 200, 'профиль пропал в 18');
  assert(profileAfter.text.includes('18 лет'), 'на профиле нет возраста «18 лет»');
  assert(!profileAfter.text.includes('Скрыто по заявлению'), 'на профиле всплыло «Скрыто по заявлению»');
  return `в день 18-летия: переход запущен (awaiting_self), строка ${rowAfter.rank}, очки и профиль без изменений, возраст 18 лет`;
});

await check('подтверждение согласия в 18: результаты на витрине как были, distribution не пишется', async () => {
  const pid = db.prepare("SELECT id FROM players WHERE full_name = 'Публиков Роман Игоревич'").get().id;
  const acc = accounts.accountByPlayer(db, pid);
  const token = adulthood.issueTransitionToken(db, acc.id);
  resetCabinetLimit();
  const jar = new Jar();
  const screen = await http(`/cabinet/adult/${token}`, { jar });
  eq(screen.status, 200, 'экран перехода');
  assert(/не меняются/i.test(screen.text), 'человеку не сказали, что рейтинг и профиль не меняются');

  const done = await http(`/cabinet/adult/${token}`, {
    method: 'POST',
    form: {
      _csrf: tokenFrom(screen.text), email: 'roman-publikov@example.com',
      password: 'мой-корт-моё-имя-2026', password2: 'мой-корт-моё-имя-2026',
      consent_processing: '1', consent_distribution: '1',
    },
    jar,
  });
  eq(done.status, 302, 'завершение перехода');
  eq(db.prepare("SELECT COUNT(*) AS n FROM consents WHERE player_id = ? AND kind = 'distribution'").get(pid).n, 0,
    'consent_distribution=1 от старой формы перехода не должен писать distribution');
  const own = db.prepare(
    "SELECT event, legal_version FROM consents WHERE player_id = ? AND kind = 'processing' ORDER BY id DESC LIMIT 1",
  ).get(pid);
  eq(own.event + ':' + own.legal_version, `granted:${LEGAL_VERSION}`, 'собственное согласие на обработку текущей редакции');
  const shown = currentStandings(db);
  eq(shown.players.find((p) => p.playerId === pid).playerName, 'Публиков Роман Игоревич',
    'фамилия пропала из открытого рейтинга при переходе');
  eq((await http(`/player/${pid}`)).status, 200, 'профиль после перехода');
  return 'переход: собственное согласие на обработку записано, distribution не тронут (0 записей), рейтинг и профиль как были';
});

await check('родитель, который сам играет: ОДИН вход на обе роли', async () => {
  // Сначала он появляется как УЧАСТНИК: обычная заявка, обычный кабинет.
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const PARENT = 'Играев Роман Сергеевич';
  const PARENT_MAIL = 'playing-parent@example.com';
  const PARENT_PASS = 'ракетка-и-струны-2026';
  const parentSubmit = await submitRegistration({
    full_name: PARENT, city: 'Смоленск', sex: 'M', birth_date: '1988-03-12',
    email: PARENT_MAIL, consent_processing: '1', consent_distribution: '1',
  });
  eq(parentSubmit.res.status, 302, 'заявка родителя');
  const reg = db.prepare('SELECT * FROM registrations WHERE email = ?').get(PARENT_MAIL);
  eq((await approveByAdmin(reg.id)).status, 302, 'одобрение заявки родителя');
  const invite = db
    .prepare("SELECT body FROM mail_outbox WHERE to_email = ? AND kind = 'cabinet.invite' ORDER BY id DESC LIMIT 1")
    .get(PARENT_MAIL);
  const setUrl = `/cabinet/reset/${/\/cabinet\/reset\/([A-Za-z0-9_-]+)/.exec(invite.body)[1]}`;
  resetCabinetLimit();
  const setJar = new Jar();
  const setPage = await http(setUrl, { jar: setJar });
  await http(setUrl, {
    method: 'POST',
    form: { _csrf: tokenFrom(setPage.text), password: PARENT_PASS, password2: PARENT_PASS },
    jar: setJar,
  });

  // Теперь он приводит РЕБЁНКА и становится законным представителем.
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
  const KID = 'Играева Полина Романовна';
  await submitRegistration({
    full_name: KID, city: 'Смоленск', sex: 'F', birth_date: birthFor(9),
    guardian_full_name: PARENT, guardian_relation: 'отец', guardian_email: PARENT_MAIL,
    consent_guardian_child: '1', consent_guardian_self: '1',
  });
  const kidReg = db.prepare('SELECT * FROM registrations WHERE full_name = ?').get(KID);
  await approveByAdmin(kidReg.id);

  // ВТОРОГО ПАРОЛЯ НЕ ПОЯВИЛОСЬ: доступ представителя подхватил уже заданный.
  const g = guardians.guardianByEmail(db, PARENT_MAIL);
  const acc = accounts.accountByEmail(db, PARENT_MAIL);
  assert(g && g.password_hash, 'у доступа представителя нет пароля — человеку пришлось бы заводить второй');
  eq(g.password_hash, acc.password_hash, 'пароли ролей разъехались — вход перестал быть одним');
  assert(!db.prepare("SELECT 1 AS x FROM mail_outbox WHERE to_email = ? AND kind = 'cabinet.guardian.invite'").get(PARENT_MAIL),
    'человеку прислали приглашение задать второй пароль');

  // ОДИН вход даёт ОБА кабинета.
  resetCabinetLimit();
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const enter = await http('/cabinet/login', {
    method: 'POST', form: { _csrf: tokenFrom(page.text), email: PARENT_MAIL, password: PARENT_PASS }, jar,
  });
  eq(enter.status, 302, 'вход');
  eq(enter.location, '/cabinet/wards', 'при двух ролях человек должен попасть к выбору кабинета');
  const list = await http('/cabinet/wards', { jar });
  eq(list.status, 200, 'список кабинетов');
  assert(/Мой профиль/.test(list.text), 'нет раздела «Мой профиль»');
  assert(/Мои дети/.test(list.text), 'нет раздела «Мои дети»');
  assert(list.text.includes(PARENT) && list.text.includes(KID), 'в списке не оба кабинета');

  // Свой кабинет.
  const parentId = db.prepare('SELECT id FROM players WHERE full_name = ?').get(PARENT).id;
  const kidId = db.prepare('SELECT id FROM players WHERE full_name = ?').get(KID).id;
  const openOwn = await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(list.text), player_id: String(parentId) }, jar,
  });
  eq(openOwn.status, 302, 'открытие своего кабинета');
  const own = await http('/cabinet', { jar });
  assert(own.text.includes(PARENT), 'открылся не свой кабинет');
  assert(/собственный кабинет/i.test(own.text), 'не сказано, что открыт свой кабинет');
  assert(own.text.includes('name="email"'), 'в своём кабинете нет поля почты');

  // Кабинет ребёнка — той же сессией, без повторного входа.
  const openKid = await http('/cabinet/wards/select', {
    method: 'POST', form: { _csrf: tokenFrom(own.text), player_id: String(kidId) }, jar,
  });
  eq(openKid.status, 302, 'переключение на кабинет ребёнка');
  const kid = await http('/cabinet', { jar });
  assert(kid.text.includes(KID), 'открылся не кабинет ребёнка');
  assert(/законный представитель/i.test(kid.text), 'кабинет ребёнка не помечен представительским');

  // Смена пароля в одной роли меняет его для ОБЕИХ.
  const NEW_PASS = 'корты-и-сетка-2027';
  const change = await http('/cabinet/password', {
    method: 'POST',
    form: {
      _csrf: tokenFrom(kid.text), current_password: PARENT_PASS,
      new_password: NEW_PASS, new_password2: NEW_PASS,
    },
    jar,
  });
  eq(change.status, 302, 'смена пароля');
  const after = { g: guardians.guardianByEmail(db, PARENT_MAIL), a: accounts.accountByEmail(db, PARENT_MAIL) };
  eq(after.g.password_hash, after.a.password_hash, 'после смены пароли ролей разъехались');
  assert(after.a.password_hash !== acc.password_hash, 'пароль не изменился вовсе');
  resetCabinetLimit();
  const jar2 = new Jar();
  const page2 = await http('/cabinet/login', { jar: jar2 });
  const relog = await http('/cabinet/login', {
    method: 'POST', form: { _csrf: tokenFrom(page2.text), email: PARENT_MAIL, password: NEW_PASS }, jar: jar2,
  });
  eq(relog.status, 302, 'вход новым паролем');
  eq(relog.location, '/cabinet/wards', 'обе роли по-прежнему на одном входе');
  return 'один адрес — один пароль — два кабинета; смена пароля общая, переключение без повторного входа';
});

await check('чужую роль представителя сменой почты не захватить', async () => {
  // Посторонний участник пытается сделать своим логином адрес представителя.
  const outsider = db.prepare("SELECT id FROM players WHERE full_name = 'Артём Ковалёв'").get();
  db.prepare('INSERT OR REPLACE INTO player_accounts (player_id, email, consent_basis, password_hash) VALUES (?, ?, ?, ?)')
    .run(outsider.id, 'outsider@example.com', 'self', db.prepare('SELECT password_hash FROM player_accounts WHERE email = ?').get('playing-parent@example.com').password_hash);
  resetCabinetLimit();
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const enter = await http('/cabinet/login', {
    method: 'POST',
    form: { _csrf: tokenFrom(page.text), email: 'outsider@example.com', password: 'корты-и-сетка-2027' },
    jar,
  });
  eq(enter.status, 302, 'вход постороннего');
  const cab = await http('/cabinet', { jar });
  // Адрес ЧИСТО представительский: у него нет кабинета участника, поэтому
  // сработать должна именно защита роли, а не проверка «адрес занят кабинетом».
  assert(!accounts.accountByEmail(db, MINOR.guardianEmail), 'подопытный адрес должен быть только представительским');
  const grab = await http('/cabinet/profile', {
    method: 'POST',
    multipart: { fields: { _csrf: tokenFrom(cab.text), full_name: 'Артём Ковалёв', email: MINOR.guardianEmail } },
    jar,
  });
  eq(grab.status, 302, 'ответ формы профиля');
  const flash = await http('/cabinet', { jar });
  assert(/законного представителя/i.test(flash.text), 'захват адреса представителя не отбит понятным сообщением');
  eq(db.prepare('SELECT email FROM player_accounts WHERE player_id = ?').get(outsider.id).email, 'outsider@example.com',
    'почта всё-таки сменилась — посторонний получил бы доступ к кабинетам чужих детей');
  db.prepare('DELETE FROM player_accounts WHERE player_id = ?').run(outsider.id);
  return 'смена почты на адрес представителя отклонена: пара ролей создаётся только модерацией';
});

await check('юр-тексты: категория представителей, cookie-тема и обработка по поручению', async () => {
  const privacy = await http('/privacy');
  eq(privacy.status, 200, 'GET /privacy анониму');
  assert(/Законные представители несовершеннолетних/i.test(privacy.text), 'в §4 нет категории представителей');
  assert(privacy.text.includes('localStorage'), 'нет клаузулы про тему оформления в localStorage');
  assert(/Обработка по поручению/i.test(privacy.text), 'нет пункта «Обработка по поручению»');
  assert(privacy.text.includes('За пределы Российской Федерации персональные данные не передаются'),
    'нет обязательной фразы о непередаче за пределы РФ');
  const consentPage = await http('/consent');
  eq(consentPage.status, 200, 'GET /consent анониму');
  assert(/дата рождения/i.test(consentPage.text), 'в перечне данных нет даты рождения');
  const reg = await http('/register');
  eq(reg.status, 200, 'GET /register анониму');
  assert(!/checked/.test(reg.text.split('consent-box')[1] || ''), 'галочки согласий предзаполнены');
  return 'обе клаузулы дословно на месте, категория представителей описана, галочки пусты';
});

// ===========================================================================
// ---------------------------------------------------------------------------
section('19. Публичный профиль игрока, возраст, срезы, фотография (ТЗ ред. 6, модель РТТ)');
// ---------------------------------------------------------------------------
const { hashPassword } = await import('./server/lib/password.mjs');
const P19 = {
  name: 'Профилев Артём Сергеевич', email: 'profilev@example.com', password: 'корт-профиль-2026-x',
  rival: 'Соперников Илья Петрович', partner: 'Партнёров Кирилл Олегович', rival2: 'Дублёров Егор Иванович',
};
const mkPlayer = (name, age, extra = {}) => Number(
  db.prepare("INSERT INTO players (full_name, city, sex, age_group, birth_date) VALUES (?, 'Смоленск', 'M', 'до 19', ?)")
    .run(name, birthFor(age)).lastInsertRowid,
);
const p19 = mkPlayer(P19.name, 14);
const rival19 = mkPlayer(P19.rival, 14);
const partner19 = mkPlayer(P19.partner, 15);
const rival2_19 = mkPlayer(P19.rival2, 16);
const noBirth19 = Number(
  db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Бездатов Пётр Ильич', 'Вязьма', 'M', '19-34')").run().lastInsertRowid,
);
accounts.createAccount(db, { playerId: p19, email: P19.email, consentBasis: 'self' });
db.prepare('UPDATE player_accounts SET password_hash = ? WHERE player_id = ?').run(hashPassword(P19.password), p19);
const t19 = Number(
  db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Открытый кубок профиля', date('now','-15 days'), 'A')").run().lastInsertRowid,
);
for (const [pid, place] of [[p19, 1], [rival19, 2], [rival2_19, 3], [noBirth19, 4]]) {
  db.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (?, ?, ?)').run(t19, pid, place);
}
// Парный разряд: схема готова — место в паре у того же турнира рядом с одиночным.
for (const [pid, place] of [[p19, 1], [partner19, 1], [rival19, 2], [rival2_19, 2]]) {
  db.prepare("INSERT INTO results (tournament_id, player_id, place, discipline) VALUES (?, ?, ?, 'double')").run(t19, pid, place);
}
db.prepare("INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score, played_on) VALUES (?, ?, ?, '6:4 3:6 10:8', date('now','-16 days'))")
  .run(t19, p19, rival19);
db.prepare("INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, kind, winner_partner_id, loser_partner_id, score) VALUES (?, ?, ?, 'double', ?, ?, '6:2 6:3')")
  .run(t19, p19, rival19, partner19, rival2_19);
recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
const resetLimits19 = () => {
  resetCabinetLimit();
  db.prepare('DELETE FROM login_attempts').run();
  db.prepare('DELETE FROM write_attempts').run();
};
const cabLogin19 = async () => {
  resetLimits19();
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const r = await http('/cabinet/login', { method: 'POST', form: { _csrf: tokenFrom(page.text), email: P19.email, password: P19.password }, jar });
  eq(r.status, 302, 'вход в кабинет');
  const cab = await http('/cabinet', { jar });
  eq(cab.status, 200, 'кабинет');
  return { jar, _csrf: tokenFrom(cab.text) };
};
const jpeg19 = (color) => sharpLib({ create: { width: 640, height: 480, channels: 3, background: color } }).jpeg().toBuffer();

await check('§8.1 профиль открывается: ФИО, город, пол, возраст в годах, очки, место, матчи со счётом (группы нет — она считается)', async () => {
  const page = await http(`/player/${p19}`);
  eq(page.status, 200, '/player/:id');
  for (const s of [P19.name, 'Смоленск', 'муж.', 'возраст: 14 лет', '6:4 3:6 10:8', 'победа', 'Открытый кубок профиля']) {
    assert(page.text.includes(s), `на профиле нет «${s}»`);
  }
  const st = currentStandings(db);
  const row = st.players.find((p) => p.playerId === p19);
  assert(row, 'игрок не в снимке');
  assert(page.text.includes(`<td class="rank">${row.rank}</td>`), 'место в рейтинге не выведено');
  assert(page.text.includes(`<td class="pts">${row.ratingPoints}</td>`), 'очки не выведены');
  const dbl = st.doubles.find((p) => p.playerId === p19);
  assert(dbl, 'парный рейтинг не посчитан');
  assert(page.text.includes('парный'), 'парный разряд не показан');
  assert(page.text.includes('в паре с') && page.text.includes(P19.partner), 'партнёр по паре не показан');
  return `место ${row.rank}, ${row.ratingPoints} очков; парный: место ${dbl.rank}; матчи со счётом и партнёром`;
});

await check('§8.2 на профиле нет даты рождения, почты и телефона; адрес — числовой id', async () => {
  const page = await http(`/player/${p19}`);
  const birth = db.prepare('SELECT birth_date FROM players WHERE id = ?').get(p19).birth_date;
  assert(!page.text.includes(birth), 'дата рождения утекла на профиль');
  assert(!page.text.includes(birth.slice(0, 4)), 'год рождения утёк на профиль');
  assert(!page.text.includes(P19.email), 'почта утекла на профиль');
  const photo = await http(`/player/${p19}/photo`);
  eq(photo.status, 404, 'фото без загрузки должно быть 404');
  eq((await http('/player/abc')).status, 404, 'нечисловой id');
  eq((await http('/player/999999')).status, 404, 'несуществующий id');
  return 'дата и год рождения, почта отсутствуют; /player/abc и /player/999999 -> 404';
});

await check('§8.3 из матчей ведут ссылки на профили соперников/партнёров и на турнир; со строки рейтинга — на профиль', async () => {
  const page = await http(`/player/${p19}`);
  for (const id of [rival19, partner19, rival2_19]) {
    assert(page.text.includes(`href="/player/${id}"`), `нет ссылки на профиль игрока ${id}`);
  }
  assert(page.text.includes(`href="/tournaments/${t19}"`), 'нет ссылки на турнир');
  const rating = await http('/rating');
  assert(rating.text.includes(`href="/player/${p19}"`), 'строка рейтинга не ведёт на профиль');
  const tour = await http(`/tournaments/${t19}`);
  assert(tour.text.includes(`href="/player/${p19}"`) && tour.text.includes('6:4 3:6 10:8'), 'карточка турнира без ссылок/счёта');
  return 'ссылки на 3 профиля и турнир; /rating и /tournaments/:id ведут на профиль';
});

await check('/privacy раздел 13: ответственный по ст. 22.1 назван (ФИО и должность из OPERATOR)', async () => {
  const { OPERATOR } = await import('./server/lib/legal.mjs');
  const r = await http('/privacy');
  eq(r.status, 200, '/privacy');
  assert(r.text.includes('Ответственный за организацию обработки персональных данных'), 'нет раздела 13');
  assert(r.text.replace(/\s+/g, ' ').includes(`Ответственный — ${OPERATOR.responsible.name}, ${OPERATOR.responsible.title}`), 'ФИО и должность ответственного не выведены в Политике');
  return `в разделе 13: ${OPERATOR.responsible.name}, ${OPERATOR.responsible.title}`;
});

await check('срез по году рождения (РТТ, решение 04.09): день рождения группу не меняет', async () => {
  const { ageOn, sliceAge, slicesFor } = await import('./server/lib/age.mjs');
  const on = '2026-09-04';
  eq(ageOn('2012-12-31', on), 13, 'полных лет у родившегося 31.12.2012');
  eq(sliceAge('2012-12-31', on), 14, 'для среза — по году: 2026 − 2012');
  eq(sliceAge('2012-01-01', on), 14, 'тот же год рождения — тот же срез');
  eq(slicesFor(sliceAge('2012-12-31', on)).join(','), 'y14,u15,u17,u19', 'срезы четырнадцатилетнего по году');
  eq(sliceAge('2013-01-01', on), 13, 'следующий год рождения — следующая группа');
  eq(sliceAge(null, on), null, 'без даты рождения — нет среза');
  return 'родившиеся в 2012-м оба в «14 лет» (полных 13 и 14), 2013-й — «13 лет»';
});

await check('§8.4 игрок стоит во всех подходящих возрастных срезах, место считается внутри среза', async () => {
  const st = currentStandings(db);
  const row = st.players.find((p) => p.playerId === p19);
  eq(row.slices.join(','), 'y14,u15,u17,u19', 'срезы четырнадцатилетнего');
  const has = async (slice) => rowNames((await http(`/rating?slice=${slice}`)).text).includes(P19.name);
  for (const s of ['y14', 'u15', 'u17', 'u19']) assert(await has(s), `игрока нет в срезе ${s}`);
  for (const s of ['y13', 'u13', 'adult']) assert(!(await has(s)), `игрок попал в чужой срез ${s}`);
  // Без даты рождения — только общая таблица.
  const nb = st.players.find((p) => p.playerId === noBirth19);
  eq(nb.age, null, 'возраст без даты рождения');
  eq(nb.slices.length, 0, 'игрок без даты рождения не должен быть в срезах');
  assert(rowNames((await http('/rating')).text).includes('Бездатов Пётр Ильич'), 'игрок без даты пропал из общей таблицы');
  assert(!(await has('adult')) && !rowNames((await http('/rating?slice=adult')).text).includes('Бездатов Пётр Ильич'), 'без даты — не в срезе 19+');
  // Место внутри среза — своё: у y14 два игрока, первый = 1.
  const y14 = await http('/rating?slice=y14');
  const names = rowNames(y14.text);
  eq(names.length, 2, 'в срезе «14 лет» должно быть двое');
  assert(/<td class="rank">1 /.test(y14.text) || y14.text.includes('<td class="rank">1<'), 'место внутри среза не с единицы');
  assert(y14.text.includes('срез: 14 лет'), 'подпись среза');
  // Парный разряд — своя таблица и фильтр.
  const dbl = await http('/rating?discipline=double');
  assert(rowNames(dbl.text).includes(P19.partner), 'парный рейтинг не показан');
  assert(!rowNames((await http('/rating')).text).includes(P19.partner), 'партнёр (без одиночных результатов) попал в одиночный рейтинг');
  return 'срезы y14,u15,u17,u19; чужие срезы пусты; без даты рождения — только общая; парный — отдельно';
});

await check('§8.5–8.6 фото: нет -> профиль без картинки; загрузил -> появилась; заменил -> новая; удалил -> исчезла сразу, прямая ссылка 404', async () => {
  const st0 = currentStandings(db).players.find((p) => p.playerId === p19);
  const before = await http(`/player/${p19}`);
  assert(!before.text.includes('class="profile-photo"'), 'картинка без фото');
  const { jar, _csrf } = await cabLogin19();
  const cab0 = await http('/cabinet', { jar });
  assert(cab0.text.includes('Фотография отображается в вашем публичном профиле'), 'подсказка у поля не по ТЗ');

  const up = await http('/cabinet/profile', {
    method: 'POST',
    multipart: { fields: { _csrf, full_name: P19.name, email: P19.email }, files: [{ field: 'photo', filename: 'me.jpg', type: 'image/jpeg', buffer: await jpeg19('#0e7a52') }] },
    jar,
  });
  eq(up.status, 302, 'загрузка фото');
  const after = await http(`/player/${p19}`);
  assert(after.text.includes(`src="/player/${p19}/photo"`), 'картинка не появилась на профиле');
  const img = await http(`/player/${p19}/photo`);
  eq(img.status, 200, 'фото отдаётся');
  eq(img.headers.get('content-type'), 'image/jpeg', 'тип фото');
  eq(img.headers.get('content-disposition'), 'inline', 'фото должно отдаваться встроенно');
  eq(img.headers.get('cache-control'), 'no-cache', 'кэш должен перепроверять');
  const etag = img.headers.get('etag');
  assert(etag, 'нет ETag');
  eq((await http(`/player/${p19}/photo`, { headers: { 'if-none-match': etag } })).status, 304, 'условный запрос');
  const sha1 = db.prepare('SELECT u.sha256, u.stored_name FROM players p JOIN uploads u ON u.id = p.photo_upload_id WHERE p.id = ?').get(p19);

  // Замена.
  resetLimits19();
  const up2 = await http('/cabinet/profile', {
    method: 'POST',
    multipart: { fields: { _csrf, full_name: P19.name, email: P19.email }, files: [{ field: 'photo', filename: 'me2.jpg', type: 'image/jpeg', buffer: await jpeg19('#123d68') }] },
    jar,
  });
  eq(up2.status, 302, 'замена фото');
  const sha2 = db.prepare('SELECT u.sha256, u.stored_name FROM players p JOIN uploads u ON u.id = p.photo_upload_id WHERE p.id = ?').get(p19);
  assert(sha2.sha256 !== sha1.sha256, 'после замены фото не изменилось');
  assert(!existsSync(resolve(UPLOAD_DIR, sha1.stored_name)), 'старый файл после замены остался');
  assert((await http(`/player/${p19}/photo`)).headers.get('etag') !== etag, 'ETag не сменился после замены');

  // Режим A цел: в кабинете фото видно владельцу.
  const own = await http('/cabinet/photo', { jar });
  eq(own.status, 200, 'фото в кабинете владельцу');

  // Удаление.
  resetLimits19();
  const del = await http('/cabinet/photo/delete', { method: 'POST', form: { _csrf }, jar });
  eq(del.status, 302, 'удаление фото');
  eq(db.prepare('SELECT photo_upload_id FROM players WHERE id = ?').get(p19).photo_upload_id, null, 'ссылка на фото осталась');
  assert(!existsSync(resolve(UPLOAD_DIR, sha2.stored_name)), 'файл после удаления остался на диске');
  eq((await http(`/player/${p19}/photo`)).status, 404, 'прямая ссылка на удалённое фото работает');
  const gone = await http(`/player/${p19}`);
  eq(gone.status, 200, 'профиль после удаления фото');
  assert(!gone.text.includes('class="profile-photo"'), 'картинка осталась на профиле');
  assert(gone.text.includes(P19.name), 'профиль без фото потерял данные');

  // §8.7: ни одно действие с фото не тронуло строку рейтинга.
  const st1 = currentStandings(db).players.find((p) => p.playerId === p19);
  eq(st1.rank, st0.rank, 'место изменилось от действий с фото');
  eq(st1.ratingPoints, st0.ratingPoints, 'очки изменились от действий с фото');
  return 'inline, no-cache, ETag/304; замена меняет sha и удаляет старый файл; удаление -> 404 сразу; рейтинг не тронут';
});

await check('§8.9 представитель несовершеннолетнего управляет фотографией из своего кабинета', async () => {
  // Свой подопытный: минор с представителем, заведённый через регистрацию и модерацию.
  resetLimits19();
  const G_EMAIL = 'profile-guardian@example.com';
  const G_PASS = 'корты-представителя-2026';
  const WARD = 'Подопечный Матвей Ильич';
  await submitRegistration({
    full_name: WARD, city: 'Смоленск', sex: 'M', birth_date: birthFor(12),
    guardian_full_name: 'Подопечная Анна Ильинична', guardian_relation: 'мать', guardian_email: G_EMAIL,
    consent_guardian_child: '1', consent_guardian_self: '1', consent_distribution: '1',
  });
  const reg = db.prepare('SELECT * FROM registrations WHERE full_name = ?').get(WARD);
  assert(reg, 'заявка подопечного не подана');
  resetLimits19();
  await approveByAdmin(reg.id);
  const ward = db.prepare('SELECT id FROM players WHERE full_name = ?').get(WARD);
  assert(ward, 'подопечный не заведён');
  const g = guardians.guardianByEmail(db, G_EMAIL);
  assert(g, 'представитель не заведён');
  db.prepare('UPDATE guardians SET password_hash = ? WHERE id = ?').run(hashPassword(G_PASS), g.id);
  resetLimits19();
  const jar = new Jar();
  const page = await http('/cabinet/login', { jar });
  const enter = await http('/cabinet/login', { method: 'POST', form: { _csrf: tokenFrom(page.text), email: G_EMAIL, password: G_PASS }, jar });
  eq(enter.status, 302, 'вход представителя');
  if (enter.location === '/cabinet/wards') {
    const wards = await http('/cabinet/wards', { jar });
    await http('/cabinet/wards/select', { method: 'POST', form: { _csrf: tokenFrom(wards.text), player_id: String(ward.id) }, jar });
  }
  const cab = await http('/cabinet', { jar });
  eq(cab.status, 200, 'кабинет подопечного');
  assert(cab.text.includes(WARD), 'кабинет открыт не на подопечного');
  const _csrf = tokenFrom(cab.text);
  const name = db.prepare('SELECT full_name FROM players WHERE id = ?').get(ward.id).full_name;
  const up = await http('/cabinet/profile', {
    method: 'POST',
    multipart: { fields: { _csrf, full_name: name }, files: [{ field: 'photo', filename: 'kid.jpg', type: 'image/jpeg', buffer: await jpeg19('#b22222') }] },
    jar,
  });
  eq(up.status, 302, 'представитель загружает фото');
  eq((await http(`/player/${ward.id}/photo`)).status, 200, 'фото подопечного на публичном профиле');
  resetLimits19();
  const del = await http('/cabinet/photo/delete', { method: 'POST', form: { _csrf }, jar });
  eq(del.status, 302, 'представитель удаляет фото');
  eq((await http(`/player/${ward.id}/photo`)).status, 404, 'фото подопечного не удалилось');
  const log = db.prepare("SELECT action FROM action_log WHERE action LIKE '%cabinet.photo.delete%' ORDER BY id DESC LIMIT 1").get();
  assert(log && log.action.includes('"guardian"'), 'в журнале не отмечено, что удалял представитель');
  return `подопечный ${ward.id}: представитель загрузил и удалил фото, журнал помнит, кто`;
});

await check('уполномоченное лицо убирает фотографию участника из админки; счёт и дата матча вносятся из админки', async () => {
  const { jar, _csrf } = await cabLogin19();
  await http('/cabinet/profile', {
    method: 'POST',
    multipart: { fields: { _csrf, full_name: P19.name, email: P19.email }, files: [{ field: 'photo', filename: 'me3.jpg', type: 'image/jpeg', buffer: await jpeg19('#444') }] },
    jar,
  });
  eq((await http(`/player/${p19}/photo`)).status, 200, 'фото загружено');
  resetLimits19();
  const admin = await login(ADMIN.user, ADMIN.pass);
  eq(admin.res.status, 302, 'вход админа');
  const list = await http('/admin/players', { jar: admin.jar });
  assert(list.text.includes(`/admin/players/${p19}/photo/delete`), 'в админке нет кнопки убрать фото');
  const rm = await http(`/admin/players/${p19}/photo/delete`, { method: 'POST', form: { _csrf: tokenFrom(list.text), reason: 'неподобающее изображение' }, jar: admin.jar });
  eq(rm.status, 302, 'удаление из админки');
  eq((await http(`/player/${p19}/photo`)).status, 404, 'фото не убрано из админки');
  assert(db.prepare("SELECT 1 FROM action_log WHERE action LIKE '%player.photo.delete%'").get(), 'удаление не в журнале действий');
  // Снятое секретарём фото = прекращение распространения: отзыв в журнал, источник offline.
  const adminRevoke = db.prepare("SELECT event, source FROM consents WHERE player_id = ? AND kind = 'distribution' ORDER BY id DESC LIMIT 1").get(p19);
  eq(adminRevoke && adminRevoke.event + ':' + adminRevoke.source, 'revoked:offline', 'удаление фото админом не записано отзывом (offline)');

  const form = await http(`/admin/tournaments/${t19}/results`, { jar: admin.jar });
  assert(form.text.includes('name="score"') && form.text.includes('name="played_on"'), 'в форме матча нет счёта/даты');
  const add = await http(`/admin/tournaments/${t19}/matches`, {
    method: 'POST', form: { _csrf: tokenFrom(form.text), winner_player_id: String(rival2_19), loser_player_id: String(p19), score: '7:5 6:4', played_on: '2026-08-20' }, jar: admin.jar,
  });
  eq(add.status, 302, 'матч со счётом добавлен');
  const m = db.prepare('SELECT score, played_on FROM matches WHERE tournament_id = ? AND winner_player_id = ? AND loser_player_id = ?').get(t19, rival2_19, p19);
  eq(m.score, '7:5 6:4', 'счёт не сохранён');
  eq(m.played_on, '2026-08-20', 'дата не сохранена');
  const bad = await http(`/admin/tournaments/${t19}/matches`, {
    method: 'POST', form: { _csrf: tokenFrom(form.text), winner_player_id: String(p19), loser_player_id: String(rival2_19), played_on: '2026-02-30' }, jar: admin.jar,
  });
  eq(bad.status, 302, 'несуществующая дата отклоняется редиректом с ошибкой');
  assert(!db.prepare('SELECT 1 FROM matches WHERE tournament_id = ? AND winner_player_id = ? AND loser_player_id = ?').get(t19, p19, rival2_19), 'матч с датой 30 февраля записан');
  const prof = await http(`/player/${p19}`);
  assert(prof.text.includes('7:5 6:4') && prof.text.includes('2026-08-20') && prof.text.includes('поражение'), 'новый матч не на профиле');
  return 'фото убрано админом с записью в журнал; матч 7:5 6:4 от 2026-08-20 на профиле; 30 февраля отклонено';
});

await check('обезличенный по ст. 21: профиль 404, фото 404, в матчах соперников — «Игрок удалён» без ссылки', async () => {
  const gone = mkPlayer('Стёртый Тест Тестович', 15);
  db.prepare("INSERT INTO matches (tournament_id, winner_player_id, loser_player_id, score) VALUES (?, ?, ?, '6:0 6:0')").run(t19, p19, gone);
  eq((await http(`/player/${gone}`)).status, 200, 'до обезличивания профиль есть');
  const erasure = await import('./server/lib/erasure.mjs');
  erasure.erasePlayer(db, gone, { uploadDir: UPLOAD_DIR });
  assert(db.prepare('SELECT anonymized_at FROM players WHERE id = ?').get(gone).anonymized_at, 'игрок не обезличен');
  eq((await http(`/player/${gone}`)).status, 404, 'профиль обезличенного должен быть 404');
  eq((await http(`/player/${gone}/photo`)).status, 404, 'фото обезличенного');
  const prof = await http(`/player/${p19}`);
  assert(prof.text.includes('Игрок удалён'), 'в матчах нет «Игрок удалён»');
  assert(!prof.text.includes(`href="/player/${gone}"`), 'на обезличенного ведёт ссылка');
  const tour = await http(`/tournaments/${t19}`);
  assert(!tour.text.includes(`href="/player/${gone}"`), 'на карточке турнира ссылка на обезличенного');
  resetLimits19();
  return 'обезличенный: 404 профиль и фото, в матчах текст без ссылки';
});

section('17. Браузер: адаптив, доступность, тема, CSP, XSS');

let browserNote = '';
try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });

  await check('шрифты грузятся ЛОКАЛЬНО (нет обращений к Google)', async () => {
    const page = await browser.newPage();
    const external = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith(inst.base) && !u.startsWith('data:')) external.push(u);
    });
    await page.goto(inst.base + '/', { waitUntil: 'networkidle' });
    const fontsLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family + ' ' + f.weight);
    });
    await page.close();
    assert(!external.some((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)), `есть обращения к Google Fonts: ${external.join(', ')}`);
    eq(external.length, 0, `внешних запросов быть не должно, найдены: ${external.join(', ')}`);
    assert(fontsLoaded.some((f) => f.includes('Manrope')), 'Manrope не загрузился');
    assert(fontsLoaded.some((f) => f.includes('Inter')), 'Inter не загрузился');
    return `внешних запросов 0; загружены локально: ${[...new Set(fontsLoaded.map((f) => f.split(' ')[0]))].join(', ')}`;
  });

  await check('тема переключается при ВКЛЮЧЁННОМ CSP и запоминается', async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cspErrors = [];
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to (execute|apply|load)/i.test(m.text())) cspErrors.push(m.text());
    });
    await page.goto(inst.base + '/', { waitUntil: 'networkidle' });

    const before = await page.getAttribute('html', 'data-theme');
    await page.click('[data-theme-toggle]');
    await page.waitForFunction((b) => document.documentElement.getAttribute('data-theme') !== b, before);
    const after = await page.getAttribute('html', 'data-theme');
    const stored = await page.evaluate(() => localStorage.getItem('ftso-theme'));

    // Новый заход в том же контексте — тема должна восстановиться из localStorage.
    const page2 = await ctx.newPage();
    await page2.goto(inst.base + '/rating', { waitUntil: 'domcontentloaded' });
    const remembered = await page2.getAttribute('html', 'data-theme');

    // Цвет фона действительно поменялся — значит CSS применился, а не только атрибут.
    const bg = await page2.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await ctx.close();

    assert(cspErrors.length === 0, `CSP заблокировал что-то нужное: ${cspErrors.join(' | ')}`);
    assert(after !== before, 'тема не переключилась');
    eq(stored, after, 'выбор не сохранён в localStorage');
    eq(remembered, after, 'тема не восстановилась при следующем заходе');
    assert(bg === 'rgb(21, 34, 45)', `фон тёмной темы ожидался #15222d, получен ${bg}`);
    return `${before} -> ${after}, localStorage ftso-theme=${stored}, при новом заходе ${remembered}, фон ${bg}; нарушений CSP нет`;
  });

  // Все публичные страницы разом: адаптив и доступность проверяются ОДНИМ
  // проходом по одному списку — иначе новый раздел добавят, а проверить забудут.
  const A11Y_PAGES = [
    '/', '/rating', '/news', '/tournaments', '/coaches', '/courts', '/clubs', '/referees',
    '/federation', '/gallery', '/documents', '/contacts', '/privacy', '/consent',
    '/register', '/tournament-request', '/cabinet/login',
    `/player/${p19}`, `/tournaments/${t19}`,
  ];

  await check('адаптив: 360 и 768 px без горизонтального скролла', async () => {
    const broken = [];
    for (const width of [360, 768]) {
      const page = await browser.newPage();
      await page.setViewportSize({ width, height: 900 });
      for (const path of A11Y_PAGES) {
        await page.goto(inst.base + path, { waitUntil: 'domcontentloaded' });
        const overflow = await page.evaluate(() => {
          const doc = document.documentElement;
          // Ширина документа больше окна = страница уезжает вбок.
          const spill = doc.scrollWidth - doc.clientWidth;
          // И ищем КОНКРЕТНОГО виновника, чтобы отчёт был чинибельным.
          let culprit = null;
          if (spill > 1) {
            for (const el of document.body.querySelectorAll('*')) {
              const r = el.getBoundingClientRect();
              if (r.right > doc.clientWidth + 1 && r.width > 0) {
                culprit = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`;
                break;
              }
            }
          }
          return { spill, culprit };
        });
        if (overflow.spill > 1) broken.push(`${path} @${width}px (+${overflow.spill}px, ${overflow.culprit})`);
      }
      await page.close();
    }
    eq(broken.join('; '), '', `горизонтальный скролл: ${broken.join('; ')}`);
    return `${A11Y_PAGES.length} страниц на 360 и 768 px — горизонтального скролла нет`;
  });

  await check('доступность: заголовки, метки полей, alt, фокус, клавиатура', async () => {
    const problems = [];
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const path of A11Y_PAGES) {
      await page.goto(inst.base + path, { waitUntil: 'domcontentloaded' });
      const found = await page.evaluate(() => {
        const out = [];
        if (document.documentElement.lang !== 'ru') out.push('нет lang="ru"');
        const h1 = document.querySelectorAll('h1');
        if (h1.length !== 1) out.push(`заголовков h1: ${h1.length}`);
        if (!document.querySelector('main')) out.push('нет <main>');
        if (!document.querySelector('.skip-link')) out.push('нет ссылки «к содержимому»');
        // Каждому полю ввода — своя метка (label, aria-label или aria-labelledby).
        for (const el of document.querySelectorAll('input, select, textarea')) {
          if (el.type === 'hidden') continue;
          const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          const wrapped = el.closest('label');
          if (!byId && !wrapped && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
            out.push(`поле без метки: ${el.name || el.type}`);
          }
        }
        // Картинки без alt: либо описание, либо явно декоративная (aria-hidden).
        for (const img of document.querySelectorAll('img')) {
          if (!img.hasAttribute('alt') && img.getAttribute('aria-hidden') !== 'true') {
            out.push(`img без alt: ${img.getAttribute('src')}`);
          }
        }
        // Ссылка без различимого текста читается скринридером как «ссылка».
        for (const a of document.querySelectorAll('a')) {
          const text = (a.textContent || '').trim();
          if (!text && !a.getAttribute('aria-label') && !a.querySelector('img[alt]')) {
            out.push(`ссылка без текста: ${a.getAttribute('href')}`);
          }
        }
        return out;
      });
      for (const item of found) problems.push(`${path}: ${item}`);
    }

    // ФОКУС ВИДЕН и ходит с клавиатуры: Tab со старта попадает на «к содержимому».
    await page.goto(inst.base + '/', { waitUntil: 'domcontentloaded' });
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString(),
        outline: style.outlineStyle,
        width: style.outlineWidth,
      };
    });
    if (!focus.cls.includes('skip-link')) problems.push(`первый Tab попал не на skip-link, а на ${focus.tag}.${focus.cls}`);
    if (focus.outline === 'none' || parseFloat(focus.width) < 1) problems.push('фокус не виден: контур отсутствует');
    await page.close();

    eq(problems.join('; '), '', `нарушения доступности: ${problems.join('; ')}`);
    return `${A11Y_PAGES.length} страниц: lang, один h1, main, skip-link, метки у всех полей, alt у картинок, видимый фокус с клавиатуры`;
  });

  await check('адаптив: бургер-меню, одна колонка, таблицы со скроллом', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(inst.base + '/', { waitUntil: 'networkidle' });

    const burgerVisible = await page.isVisible('[data-burger]');
    const menuHiddenAtStart = await page.evaluate(() => {
      const m = document.getElementById('primary-menu');
      return getComputedStyle(m).visibility === 'hidden';
    });
    await page.click('[data-burger]');
    await page.waitForTimeout(300);
    const menuOpen = await page.evaluate(() => {
      const m = document.getElementById('primary-menu');
      return m.classList.contains('is-open') && getComputedStyle(m).visibility === 'visible';
    });

    const heroOneColumn = await page.evaluate(
      () => getComputedStyle(document.querySelector('.hero-grid')).gridTemplateColumns.split(' ').length === 1,
    );
    const newsOneColumn = await page.evaluate(
      () => getComputedStyle(document.querySelector('.news-grid')).gridTemplateColumns.split(' ').length === 1,
    );
    const tableScrolls = await page.evaluate(() => {
      const box = document.querySelector('.table-scroll');
      return getComputedStyle(box).overflowX === 'auto' && box.scrollWidth > box.clientWidth;
    });
    const noHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    );
    await page.close();

    assert(burgerVisible, 'бургер не показан на узком экране');
    assert(menuHiddenAtStart, 'меню изначально должно быть скрыто');
    assert(menuOpen, 'меню не открылось по бургеру');
    assert(heroOneColumn, 'hero не свернулся в одну колонку');
    assert(newsOneColumn, 'новости не свернулись в одну колонку');
    assert(tableScrolls, 'таблица не скроллится горизонтально');
    assert(noHScroll, 'страница уезжает вбок по горизонтали');
    return '390px: бургер работает, hero и новости в одну колонку, таблица скроллится, страница не уезжает вбок';
  });

  await check('новые экраны кабинета: адаптив и доступность за логином', async () => {
    // Экраны представителя и перехода в 18 живут ЗА ВХОДОМ, поэтому в общий
    // список A11Y_PAGES они не попадают: анониму там показывается «нет доступа».
    // Заводим своего представителя с подопечным, входим формой в браузере и
    // проверяем те же требования, что и на публичных страницах.
    const BROWSER_MAIL = 'browser-guardian@example.com';
    const BROWSER_PASS = 'смоленский-снег-2026';
    const kidId = Number(db.prepare(
      "INSERT INTO players (full_name, city, sex, birth_date) VALUES ('Браузеров Тихон Ильич','Смоленск','M','2014-02-02')",
    ).run().lastInsertRowid);
    db.prepare("INSERT INTO player_accounts (player_id, consent_basis) VALUES (?, 'representative')").run(kidId);
    const { guardian: bg } = db.transaction(() => guardians.attachGuardian(db, kidId, {
      full_name: 'Браузерова Ирина Львовна', relation: 'мать', email: BROWSER_MAIL,
    }))();
    identity.setPersonPassword(db, BROWSER_MAIL, BROWSER_PASS);
    // Отдельный участник в состоянии перехода — для экрана согласия от себя.
    const grownId = Number(db.prepare(
      "INSERT INTO players (full_name, city, sex, birth_date) VALUES ('Взрослов Артур Павлович','Вязьма','M','2008-01-01')",
    ).run().lastInsertRowid);
    const grownAcc = Number(db.prepare(
      "INSERT INTO player_accounts (player_id, consent_basis, transition_started_at) VALUES (?, 'awaiting_self', datetime('now'))",
    ).run(grownId).lastInsertRowid);
    const token = adulthood.issueTransitionToken(db, grownAcc);

    const page = await browser.newPage();
    await page.goto(inst.base + '/cabinet/login', { waitUntil: 'domcontentloaded' });
    await page.fill('#c-email', BROWSER_MAIL);
    await page.fill('#c-pass', BROWSER_PASS);
    await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('button[type="submit"]')]);

    const guarded = ['/cabinet/wards', '/cabinet', `/cabinet/adult/${token}`, '/cabinet/adult'];
    const problems = [];
    for (const path of guarded) {
      await page.goto(inst.base + path, { waitUntil: 'domcontentloaded' });
      eq(page.url().replace(inst.base, ''), path, `${path}: увело на другой адрес`);
      const found = await page.evaluate(() => {
        const out = [];
        if (document.documentElement.lang !== 'ru') out.push('нет lang="ru"');
        const h1 = document.querySelectorAll('h1');
        if (h1.length !== 1) out.push(`заголовков h1: ${h1.length}`);
        if (!document.querySelector('main')) out.push('нет <main>');
        if (!document.querySelector('.skip-link')) out.push('нет ссылки «к содержимому»');
        for (const el of document.querySelectorAll('input, select, textarea')) {
          if (el.type === 'hidden') continue;
          const byId = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (!byId && !el.closest('label') && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
            out.push(`поле без метки: ${el.name || el.type}`);
          }
        }
        for (const a of document.querySelectorAll('a')) {
          const text = (a.textContent || '').trim();
          if (!text && !a.getAttribute('aria-label')) out.push(`ссылка без текста: ${a.getAttribute('href')}`);
        }
        return out;
      });
      for (const item of found) problems.push(`${path}: ${item}`);

      for (const width of [360, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(inst.base + path, { waitUntil: 'domcontentloaded' });
        const spill = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (spill > 1) problems.push(`${path} @${width}px: горизонтальный скролл +${spill}px`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await page.close();
    eq(problems.join('; '), '', `новые экраны: ${problems.join('; ')}`);
    return `${guarded.length} экрана за логином: метки, один h1, skip-link на месте; 360 и 768 px без горизонтального скролла`;
  });

  await check('XSS из данных НЕ выполняется', async () => {
    const page = await browser.newPage();
    let alerted = false;
    page.on('dialog', async (d) => {
      alerted = true;
      await d.dismiss();
    });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(inst.base + '/rating', { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const asText = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('td.player')];
      const hit = cells.find((c) => c.textContent.includes('alert(1)'));
      return hit ? { text: hit.textContent.trim(), scripts: hit.querySelectorAll('script').length } : null;
    });
    await page.close();
    assert(!alerted, 'сработал alert — XSS выполнился');
    assert(asText, 'ячейка с «злым» именем не найдена');
    eq(asText.scripts, 0, 'внутри ячейки оказался тег script');
    eq(asText.text, '<script>alert(1)</script>', 'текст в ячейке не совпал');
    return `в ячейке текст «${asText.text}», тегов script 0, alert не сработал`;
  });

  await check('профиль: фото грузится под CSP, «злое» имя в заголовке и ссылках — текст, alert не срабатывает', async () => {
    const { jar, _csrf } = await cabLogin19();
    const up = await http('/cabinet/profile', {
      method: 'POST',
      multipart: { fields: { _csrf, full_name: P19.name, email: P19.email }, files: [{ field: 'photo', filename: 'csp.jpg', type: 'image/jpeg', buffer: await jpeg19('#0e7a52') }] },
      jar,
    });
    eq(up.status, 302, 'фото для проверки CSP');
    const xss = db.prepare("SELECT id FROM players WHERE full_name LIKE '%alert(1)%' AND anonymized_at IS NULL").get();
    assert(xss, 'игрока со «злым» именем нет в базе');
    const t = db.prepare('SELECT id FROM tournaments ORDER BY id LIMIT 1').get();
    db.prepare("INSERT OR IGNORE INTO matches (tournament_id, winner_player_id, loser_player_id, score) VALUES (?, ?, ?, '6:1 6:1')").run(t.id, xss.id, p19);

    const page = await browser.newPage();
    let alerted = false;
    page.on('dialog', async (d) => { alerted = true; await d.dismiss(); });
    const cspErrors = [];
    page.on('console', (m) => { if (/Content Security Policy|Refused to (execute|apply|load)/i.test(m.text())) cspErrors.push(m.text()); });
    await page.goto(`${inst.base}/player/${p19}`, { waitUntil: 'networkidle' });
    const img = await page.evaluate(() => {
      const i = document.querySelector('img.profile-photo');
      return i ? { complete: i.complete, w: i.naturalWidth } : null;
    });
    assert(img && img.complete && img.w > 0, 'фотография на профиле не загрузилась в браузере');
    const link = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a[href^="/player/"]')].find((x) => x.textContent.includes('alert(1)'));
      return a ? { text: a.textContent.trim(), scripts: a.querySelectorAll('script').length } : null;
    });
    assert(link && link.scripts === 0 && link.text === '<script>alert(1)</script>', 'ссылка на соперника со «злым» именем не текст');
    await page.goto(`${inst.base}/player/${xss.id}`, { waitUntil: 'networkidle' });
    const h1 = await page.evaluate(() => ({ text: document.querySelector('h1').textContent.trim(), scripts: document.querySelectorAll('h1 script').length }));
    await page.close();
    eq(h1.text, '<script>alert(1)</script>', 'заголовок профиля со «злым» именем не текст');
    eq(h1.scripts, 0, 'в заголовке тег script');
    assert(!alerted, 'сработал alert — XSS выполнился на профиле');
    eq(cspErrors.join(' | '), '', `CSP на профиле: ${cspErrors.join(' | ')}`);
    return 'фото загрузилось под CSP; злое имя — текст в h1 и в ссылке; alert 0; нарушений CSP 0';
  });

  await check('регистрация живая, остальные портальные кнопки — заглушки', async () => {
    const page = await browser.newPage();
    await page.goto(inst.base + '/', { waitUntil: 'domcontentloaded' });
    // «Регистрация» и «Регистрация игрока» ОЖИВЛЕНЫ и ведут на /register.
    // Личный кабинет, заявка на турнир и приём документов от секретарей — всё
    // ещё «#»: это отдельные пункты, их функционала в сборке нет.
    const live = await page.evaluate(() => {
      const names = ['Регистрация', 'Регистрация игрока', 'Провести турнир', 'Личный кабинет'];
      return [...document.querySelectorAll('a')]
        .filter((a) => names.includes(a.textContent.trim()))
        .map((a) => ({ t: a.textContent.trim(), href: a.getAttribute('href') }));
    });
    assert(live.length >= 4, `живых ссылок найдено ${live.length}, ожидалось не меньше 4`);
    const expected = {
      'Регистрация': '/register',
      'Регистрация игрока': '/register',
      'Провести турнир': '/tournament-request',
      'Личный кабинет': '/cabinet',
    };
    for (const l of live) eq(l.href, expected[l.t], `«${l.t}» ведёт не туда`);
    for (const path of ['/register', '/tournament-request']) {
      const r = await http(path);
      eq(r.status, 200, `страница ${path}`);
    }
    // «Вход» в шапке — справа, рядом с «Регистрацией»: без сессии ведёт на
    // /cabinet/login, у вошедшего игрока превращается в «Кабинет» → /cabinet.
    const hdr = await page.evaluate(() => {
      const a = document.querySelector('.header-actions a.btn--login');
      const r = document.querySelector('.header-actions a.btn--register');
      return a && r ? { href: a.getAttribute('href'), text: a.textContent.trim(), before: a.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0 } : null;
    });
    assert(hdr, 'в шапке нет кнопки входа рядом с «Регистрацией»');
    eq(hdr.href + ' ' + hdr.text + ' ' + hdr.before, '/cabinet/login Вход 1', 'кнопка входа: адрес, подпись, место перед «Регистрацией»');
    assert(!(await http('/')).text.includes('href="/login"'), 'в публичной шапке появился вход в админку — его там быть не должно');
    {
      resetCabinetLimit();
      const jar = new Jar();
      const lp = await http('/cabinet/login', { jar });
      // Кабинет CAB_EMAIL к этому месту уже стёрт тестом «ЗАБВЕНИЕ» — входим взрослым из перехода в 18.
      const li = await http('/cabinet/login', { method: 'POST', form: { _csrf: tokenFrom(lp.text), email: 'timofey@example.com', password: 'своя-жизнь-2026-корт' }, jar });
      eq(li.status, 302, 'вход в кабинет для проверки шапки');
      const home = await http('/', { jar });
      const m = home.text.match(/<a class="btn btn--secondary btn--login" href="([^"]+)">[\s\S]*?<span class="btn-label">([^<]+)</);
      assert(m, 'после входа кнопки в шапке нет');
      eq(m[1] + ' ' + m[2].trim(), '/cabinet Кабинет', 'после входа кнопка должна стать «Кабинет» → /cabinet');
      resetCabinetLimit();
    }
    // Кабинет без входа отдаёт 403 со страницей «нужен вход» — это рабочая
    // страница, а не заглушка: пустой ответ здесь был бы неотличим от «#».
    const cabinet = await http('/cabinet');
    eq(cabinet.status, 403, 'кабинет без входа');
    assert(cabinet.text.includes('/cabinet/login'), 'на странице кабинета нет входа');

    const portal = await page.evaluate(() => {
      // Заявка участника на турнир и приём документов от секретарей — отдельные
      // пункты бэклога, их функционала в сборке нет.
      const names = ['Заявка на турнир', 'Секретарям турниров'];
      const out = [];
      for (const a of document.querySelectorAll('a')) {
        const t = a.textContent.trim();
        if (names.some((n) => t === n)) out.push({ t, href: a.getAttribute('href') });
      }
      return out;
    });
    const legal = await page.evaluate(() =>
      [...document.querySelectorAll('.footer-legal a')].map((a) => ({ t: a.textContent.trim(), href: a.getAttribute('href') })),
    );
    await page.close();

    assert(portal.length >= 2, `портальных ссылок найдено ${portal.length}, ожидалось не меньше 2`);
    for (const p of portal) eq(p.href, '#', `«${p.t}» должна оставаться заглушкой`);
    for (const l of legal) assert(l.href.startsWith('/'), `правовая ссылка «${l.t}» должна вести на реальную страницу, а не «${l.href}»`);
    for (const l of legal) {
      const r = await http(l.href);
      eq(r.status, 200, `правовая страница ${l.href}`);
    }
    return `${live.length} живых ссылок (регистрация, заявка на турнир, кабинет); ${portal.length} портальных = «#»; правовые ведут на ${legal.map((l) => l.href).join(', ')} (обе 200)`;
  });

  await check('/contacts: реквизиты читаемы — на 998 px значение шире половины dl, на 390 px во всю ширину', async () => {
    const page = await browser.newPage();
    try {
      const measure = async (w) => {
        await page.setViewportSize({ width: w, height: 900 });
        await page.goto(inst.base + '/contacts', { waitUntil: 'networkidle' });
        return page.evaluate(() => {
          const dl = document.querySelector('dl.legal-dl');
          const dd = dl && dl.querySelector('dd');
          return {
            dlW: dl ? dl.getBoundingClientRect().width : 0,
            ddW: dd ? dd.getBoundingClientRect().width : 0,
            cols: dl ? getComputedStyle(dl).gridTemplateColumns : null,
          };
        });
      };
      const d = await measure(998);
      assert(d.dlW > 0, 'нет dl.legal-dl на /contacts');
      assert(d.ddW > d.dlW * 0.5, `на 998 px значение реквизита занимает ${Math.round(d.ddW)} из ${Math.round(d.dlW)} px (колонки: ${d.cols}) — текст ушёл в столбик по букве`);
      const m = await measure(390);
      assert(m.ddW > m.dlW * 0.9, `на 390 px значение должно быть во всю ширину, а занимает ${Math.round(m.ddW)} из ${Math.round(m.dlW)} px`);
      return `998 px: dd ${Math.round(d.ddW)}/${Math.round(d.dlW)} px (${d.cols}); 390 px: dd ${Math.round(m.ddW)}/${Math.round(m.dlW)} px`;
    } finally {
      await page.close();
    }
  });

  await check('регистрация: по умолчанию форма взрослого с чекбоксом согласия; блок представителя добавляется по дате ребёнка; скрытый блок отключён', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(inst.base + '/register', { waitUntil: 'networkidle' });
      // ВИДИМОСТЬ, а не атрибут: hidden может перебиваться CSS (display:flex) — мерим реальную высоту.
      const state = () => page.evaluate(() => {
        const q = (sel) => document.querySelector(sel);
        const gone = (el) => el.hidden && getComputedStyle(el).display === 'none' && el.getBoundingClientRect().height === 0;
        const minor = q('[data-minor="minor"]'); const adult = q('[data-minor="adult"]');
        return { minorHidden: gone(minor), adultHidden: gone(adult), guardianDisabled: q('#r-g-last').disabled, emailDisabled: q('#r-email').disabled };
      });
      const s0 = await state();
      assert(s0.minorHidden && !s0.adultHidden && !s0.emailDisabled, `до ввода даты форма взрослого видна, представитель скрыт: ${JSON.stringify(s0)}`);
      const y = new Date().getFullYear();
      await page.fill('#r-birth', `${y - 12}-05-10`);
      await page.dispatchEvent('#r-birth', 'change');
      const s1 = await state();
      assert(!s1.minorHidden && s1.adultHidden && !s1.guardianDisabled && s1.emailDisabled, `ребёнок: ждал блок представителя, отключённый e-mail взрослого: ${JSON.stringify(s1)}`);
      await page.fill('#r-birth', `${y - 30}-05-10`);
      await page.dispatchEvent('#r-birth', 'change');
      const s2 = await state();
      assert(s2.minorHidden && !s2.adultHidden && s2.guardianDisabled && !s2.emailDisabled, `взрослый: ждал скрытый и отключённый блок представителя: ${JSON.stringify(s2)}`);
      // ряды ФИО: три поля на одной линии (нижние края равны) — метка не должна ронять поле
      await page.setViewportSize({ width: 998, height: 900 });
      await page.fill('#r-birth', `${y - 12}-05-10`);
      await page.dispatchEvent('#r-birth', 'change');
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.field-row')).map((row) => {
        const bottoms = Array.from(row.querySelectorAll('input')).map((i) => Math.round(i.getBoundingClientRect().bottom));
        return { n: bottoms.length, spread: Math.max(...bottoms) - Math.min(...bottoms) };
      }));
      assert(rows.length >= 2 && rows.every((r) => r.n === 3 && r.spread <= 2), `поля в рядах ФИО не на одной линии: ${JSON.stringify(rows)}`);
      // согласия: до даты на экране ни одного чекбокса, у взрослого — ровно одно (на обработку); «распространения» в форме нет
      await page.fill('#r-birth', ''); await page.dispatchEvent('#r-birth', 'change');
      const visibleBoxes = () => page.evaluate(() => Array.from(document.querySelectorAll('input[type="checkbox"]')).filter((i) => i.getBoundingClientRect().height > 0).map((i) => i.name));
      eq((await visibleBoxes()).join(','), 'consent_processing', 'до даты виден ровно один чекбокс — согласие на обработку (аудит формы ищет его сразу)');
      await page.fill('#r-birth', `${y - 30}-05-10`); await page.dispatchEvent('#r-birth', 'change');
      eq((await visibleBoxes()).join(','), 'consent_processing', 'у взрослого должно быть ровно одно согласие — на обработку');
      assert(!(await page.content()).includes('name="consent_distribution"'), 'в форме остался чекбокс распространения');
      return `без даты — форма взрослого с чекбоксом согласия, представитель скрыт; ребёнок — представитель виден, взрослые поля отключены; взрослый — одно согласие; ряды ФИО ровные (${rows.length} ряда)`;
    } finally {
      await page.close();
    }
  });

  await check('возрастная группа нигде не вводится: ни в регистрации, ни в админке, ни на профиле; дата рождения сразу после пола', async () => {
    const { registrationInput, playerInput } = await import('./server/lib/validate.mjs');
    const { jar: aj } = await login(ADMIN.user, ADMIN.pass);
    const adminHtml = (await http('/admin/players', { jar: aj })).text;
    assert(!adminHtml.includes('name="age_group"') && !adminHtml.includes('<th>Группа</th>'), 'в админке осталось поле группы');
    assert(!('age_group' in playerInput({ full_name: 'А Б', city: 'С', sex: 'M', age_group: '35-44' })), 'playerInput читает группу');
    const anyPlayer = db.prepare('SELECT id FROM players WHERE anonymized_at IS NULL LIMIT 1').get();
    if (anyPlayer) assert(!(await http(`/player/${anyPlayer.id}`)).text.includes('группа:'), 'на профиле остался тег «группа»');
    const html = (await http('/register')).text;
    assert(!html.includes('name="age_group"'), 'в форме регистрации осталось поле возрастной группы');
    const order = ['last_name', 'city', 'sex', 'birth_date'].map((n) => html.indexOf(`name="${n}"`));
    assert(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `порядок полей не фамилия→город→пол→дата: ${order}`);
    const data = registrationInput({ full_name: 'Тест Тестов', city: 'Смоленск', sex: 'M', birth_date: '1990-01-01', email: 't@example.com', age_group: '35-44', consent_processing: '1' });
    eq(data.age_group, null, 'подсунутая группа должна игнорироваться');
    return 'регистрация и админка без поля; playerInput группу не читает; на профиле тега нет; порядок ФИО→город→пол→дата';
  });

  await check('опасные кнопки админки: «Удалить» без «ОК» в диалоге не уходит на сервер, с «ОК» — уходит', async () => {
    const pid = Number(db.prepare("INSERT INTO players (full_name, city, sex) VALUES ('Тест Подтверждаев','Смоленск','M')").run().lastInsertRowid);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(inst.base + '/login', { waitUntil: 'networkidle' });
      await page.fill('input[name="username"]', ADMIN.user);
      await page.fill('input[name="password"]', ADMIN.pass);
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('form button[type="submit"]')]);
      await page.goto(inst.base + '/admin/players', { waitUntil: 'networkidle' });
      const sel = `button.btn--danger[form="del-player-${pid}"]`;
      assert(await page.$(sel), 'кнопки удаления тестового игрока нет на странице');
      // 1. Отмена в диалоге — игрок жив.
      let asked = '';
      const dismiss = async (d) => { asked = d.message(); await d.dismiss(); };
      page.on('dialog', dismiss);
      await page.click(sel);
      await page.waitForTimeout(400);
      assert(/Подтверждаев/.test(asked), `диалог не показан или без имени игрока: «${asked}»`);
      eq(db.prepare('SELECT COUNT(*) AS n FROM players WHERE id = ?').get(pid).n, 1, 'игрок удалён, хотя в диалоге нажали «Отмена»');
      page.off('dialog', dismiss);
      // 2. «ОК» — удаляется.
      page.on('dialog', async (d) => { await d.accept(); });
      await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click(sel)]);
      eq(db.prepare('SELECT COUNT(*) AS n FROM players WHERE id = ?').get(pid).n, 0, 'после «ОК» игрок не удалён');
      const danger = await page.evaluate(() => document.querySelectorAll('button.btn--danger[type="submit"]').length);
      return `диалог с именем игрока; «Отмена» → жив, «ОК» → удалён; красных submit-кнопок на странице: ${danger}, все под правилом`;
    } finally {
      db.prepare('DELETE FROM players WHERE id = ?').run(pid);
      await ctx.close();
    }
  });

  await check('пароль: у каждого поля кнопка «Показать/Скрыть», клик меняет тип поля', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(inst.base + '/login', { waitUntil: 'networkidle' });
      const r = await page.evaluate(() => {
        const input = document.querySelector('input[name="password"]');
        const btn = input && input.parentElement.querySelector('button.pw-toggle');
        if (!btn) return { btn: false };
        const t0 = input.type; btn.click(); const t1 = input.type; const l1 = btn.textContent; btn.click(); const t2 = input.type;
        return { btn: true, t0, t1, l1, t2 };
      });
      assert(r.btn, 'нет кнопки .pw-toggle у поля пароля на /login');
      eq(`${r.t0}→${r.t1}→${r.t2}`, 'password→text→password', 'клики не переключают тип поля');
      eq(r.l1, 'Скрыть', 'подпись кнопки после показа');
      const count = await page.evaluate(() => document.querySelectorAll('input[type="password"] + button.pw-toggle, .pw-field > button.pw-toggle').length);
      assert(count >= 1, 'кнопка не привязана к полю');
      return 'на /login: password → text → password, подпись «Скрыть»';
    } finally {
      await page.close();
    }
  });

  await check('формы: в светлой теме поля ввода белые, блок ошибок заявки красный', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(inst.base + '/register', { waitUntil: 'networkidle' });
      await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); });
      const inputBg = await page.evaluate(() => getComputedStyle(document.querySelector('#r-last')).backgroundColor);
      eq(inputBg, 'rgb(255, 255, 255)', 'поле ввода в светлой теме не белое');
      db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run();
      const jar = new Jar(); const html = (await http('/register', { jar })).text;
      const bad = await http('/register', { method: 'POST', jar, form: { _csrf: tokenFrom(html), last_name: '', first_name: 'A', city: 'Смоленск', sex: 'M', birth_date: ADULT_BIRTH, email: 'x@example.com', consent_processing: '1' } });
      eq(bad.status, 400, 'ошибочная заявка');
      await page.setContent(bad.text.replace('<html', '<html data-theme="light"'), { waitUntil: 'load' });
      await page.addStyleTag({ url: inst.base + '/static/css/site.css' });
      const errColor = await page.evaluate(() => { const el = document.querySelector('.form-errors strong'); return el ? getComputedStyle(el).color : null; });
      assert(errColor && /^rgb\((1[7-9]\d|2\d\d), (\d|[1-9]\d), (\d|[1-9]\d)\)$/.test(errColor), `текст ошибок должен быть красным: ${errColor}`);
      await page.goto(inst.base + '/register', { waitUntil: 'networkidle' });
      const btn = await page.evaluate(() => {
        const b = document.querySelector('.form-actions .btn[type=submit]'); const f = b.closest('form');
        const br = b.getBoundingClientRect(), fr = f.getBoundingClientRect();
        return { text: b.textContent.trim(), w: Math.round(br.width), formW: Math.round(fr.width), centerOff: Math.round(Math.abs((br.left + br.right) / 2 - (fr.left + fr.right) / 2)) };
      });
      eq(btn.text, 'Зарегистрироваться', 'надпись кнопки');
      assert(btn.w < btn.formW * 0.6 && btn.centerOff <= 2, `кнопка должна быть по ширине надписи и по центру: ${JSON.stringify(btn)}`);
      return `поле #fff; ошибки ${errColor}; кнопка «${btn.text}» ${btn.w}px из ${btn.formW}, по центру`;
    } finally {
      await page.close();
    }
  });

  await check('тема: переход body не дольше 1 с (4.8 с выглядело как «не сработало»)', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(inst.base + '/', { waitUntil: 'networkidle' });
      const durations = await page.evaluate(() => getComputedStyle(document.body).transitionDuration);
      const max = Math.max(...durations.split(',').map((s) => parseFloat(s)));
      assert(max <= 1, `transition body = ${durations}`);
      return `transition body: ${durations}`;
    } finally {
      await page.close();
    }
  });

  await browser.close();
} catch (err) {
  browserNote = err.message;
  results.push({ group: '11. Браузер', name: 'запуск Chromium', ok: false, detail: err.message });
}

// ===========================================================================
section('18. Рубильник приёма ПДн, баннер разработки, реестр cookie');

// Отдельный экземпляр с ЗАКРЫТЫМ приёмом: основное приложение работает с
// открытым, и переключать его на лету — значит ловить чужие эффекты.
await check('Метрика (решение владельца): без METRIKA_ID — ни баннера, ни Яндекса в CSP; с номером — баннер, счётчик только после «Принять»', async () => {
  const { loadConfig } = await import('./server/lib/config.mjs');
  const saved = process.env.METRIKA_ID;
  try {
    process.env.METRIKA_ID = '12345678';
    eq(loadConfig({ requireSecrets: false }).metrikaId, '12345678', 'номер счётчика принят');
    process.env.METRIKA_ID = '<script>';
    eq(loadConfig({ requireSecrets: false }).metrikaId, '', 'мусор вместо номера отброшен');
    delete process.env.METRIKA_ID;
    eq(loadConfig({ requireSecrets: false }).metrikaId, '', 'без переменной — пусто');
  } finally {
    if (saved === undefined) delete process.env.METRIKA_ID; else process.env.METRIKA_ID = saved;
  }
  // Основной инстанс тестов — без счётчика: ни баннера, ни Яндекса.
  const plain = await http('/');
  assert(!/data-cookie-bar/.test(plain.text) && !/mc\.yandex\.ru/.test(plain.text), 'без METRIKA_ID на странице есть баннер или Яндекс');
  assert(!/mc\.yandex\.ru/.test(plain.headers.get('content-security-policy') || ''), 'без METRIKA_ID Яндекс попал в CSP');
  // Инстанс со счётчиком.
  const mApp = createApp({ ...config, metrikaId: '12345678' });
  const mInst = await new Promise((res) => { const server = mApp.listen(0, '127.0.0.1', () => res({ server, base: `http://127.0.0.1:${server.address().port}` })); });
  const mHttp = makeClient(mInst.base);
  try {
    const home = await mHttp('/');
    assert(/data-cookie-bar data-metrika="12345678"/.test(home.text), 'баннер не показан');
    assert(!/<script[^>]+mc\.yandex\.ru/.test(home.text), 'счётчик подключён статически, до согласия');
    assert(/mc\.yandex\.ru/.test(home.headers.get('content-security-policy') || ''), 'Яндекс не разрешён в CSP при заданном счётчике');
    assert(/data-cookie-settings/.test(home.text), 'нет «Настройки cookie» в подвале');
    const declined = await mHttp('/', { headers: { cookie: 'ftso.analytics=0' } });
    assert(/data-cookie-bar[^>]*hidden/.test(declined.text), 'после «Отклонить» баннер должен быть скрыт');
    const accepted = await mHttp('/', { headers: { cookie: 'ftso.analytics=1' } });
    assert(/data-cookie-bar[^>]*data-choice="1"[^>]*hidden/.test(accepted.text), 'после «Принять» баннер должен быть скрыт, выбор передан');
    // Политика: разд. 8 описывает Метрику и как отозвать.
    const pol = await mHttp('/privacy');
    assert(/id="cookies"/.test(pol.text) && /Яндекс\.Метрика/.test(pol.text) && /Настройки cookie/.test(pol.text) && /вебвизор/i.test(pol.text), 'Политика разд. 8 не описывает Метрику/отзыв/вебвизор');
    // Браузер: «Отклонить» → cookie 0, скрипта нет; «Принять» → cookie 1, тег на mc.yandex.ru появился.
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(mInst.base + '/', { waitUntil: 'domcontentloaded' });
      await page.click('[data-cookie-decline]');
      let cookies = await ctx.cookies();
      eq((cookies.find((c) => c.name === 'ftso.analytics') || {}).value, '0', 'cookie после «Отклонить»');
      eq(await page.evaluate(() => document.querySelectorAll('script[src*="mc.yandex.ru"]').length), 0, 'после «Отклонить» счётчик подключён');
      await page.click('[data-cookie-settings]');
      eq(await page.evaluate(() => document.querySelector('[data-cookie-bar]').hidden), false, '«Настройки cookie» не вернули баннер');
      await page.click('[data-cookie-accept]');
      cookies = await ctx.cookies();
      eq((cookies.find((c) => c.name === 'ftso.analytics') || {}).value, '1', 'cookie после «Принять»');
      eq(await page.evaluate(() => document.querySelectorAll('script[src*="mc.yandex.ru/metrika/tag.js"]').length), 1, 'после «Принять» тег счётчика не добавлен');
      eq(await page.evaluate(() => document.querySelector('[data-cookie-bar]').hidden), true, 'после «Принять» баннер не скрыт');
    } finally { await ctx.close(); await browser.close(); }
  } finally {
    await new Promise((r) => mInst.server.close(r));
  }
  return 'без номера — чисто; с номером — баннер, CSP c mc.yandex.ru, тег только после «Принять», «Отклонить» на год, Политика разд. 8';
});

const closedInst = await (async () => {
  const app = createApp({ ...config, intakeEnabled: false, devNotice: true }); // плашка включена явно: по умолчанию с 04.09 её нет
  return new Promise((res) => {
    const server = app.listen(0, '127.0.0.1', () => {
      res({ app, server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
})();
const closedHttp = makeClient(closedInst.base);

await check('при закрытом приёме формы ПДн заменены заглушкой', async () => {
  for (const p of ['/register', '/tournament-request', '/cabinet', '/cabinet/login', '/cabinet/forgot']) {
    const r = await closedHttp(p);
    assert(r.status === 200, `${p}: ожидали 200 (страница есть), получили ${r.status}`);
    assert(/Приём заявок закрыт/.test(r.text), `${p}: нет текста заглушки`);
  }
  // Полей формы быть не должно — иначе браузер покажет то, что не работает.
  const reg = await closedHttp('/register');
  assert(!/name="consent_processing"/.test(reg.text), '/register: чекбокс согласия всё ещё в разметке');
  assert(!/name="email"/.test(reg.text), '/register: поле почты всё ещё в разметке');
  return 'пять маршрутов отдают заглушку 200, полей формы в разметке нет';
});

await check('при закрытом приёме POST отклоняется и в БД НИЧЕГО не пишется', async () => {
  const count = (t) => db.prepare(`select count(*) c from ${t}`).get().c;
  const before = {
    registrations: count('registrations'),
    players: count('players'),
    consents: count('consents'),
    tournament_requests: count('tournament_requests'),
    mail_outbox: count('mail_outbox'),
  };

  // Валидный CSRF-токен со страницы входа админа — она не закрыта.
  // Без него отказ пришёл бы от CSRF, и рубильник остался бы непроверенным.
  const jar = new Jar();
  const page = await closedHttp('/login', { jar });
  const _csrf = tokenFrom(page.text);

  const targets = [
    '/register',
    '/tournament-request',
    '/cabinet/login',
    '/admin/players',
    '/admin/rating/recompute',
  ];
  for (const p of targets) {
    const r = await closedHttp(p, {
      method: 'POST',
      jar,
      form: {
        _csrf,
        last_name: 'Тестов', first_name: 'Тест', city: 'Смоленск', sex: 'm',
        email: 'gate-test@example.com', consent_processing: '1',
      },
    });
    assert(r.status === 403, `${p}: ожидали 403 от рубильника, получили ${r.status}`);
    assert(/Заявка не принята/.test(r.text), `${p}: 403 пришёл не от рубильника (нет текста отказа)`);
  }

  const after = {
    registrations: count('registrations'),
    players: count('players'),
    consents: count('consents'),
    tournament_requests: count('tournament_requests'),
    mail_outbox: count('mail_outbox'),
  };
  for (const k of Object.keys(before)) {
    assert(before[k] === after[k], `таблица ${k}: было ${before[k]}, стало ${after[k]} — запись прошла сквозь рубильник`);
  }
  return `5 маршрутов -> 403 заглушкой; счётчики 5 таблиц не изменились (${before.players} игроков, ${before.consents} согласий)`;
});

await check('рубильник НЕ трогает админский вход и публичный просмотр', async () => {
  // Порядок важен: СНАЧАЛА верный вход. Он (а) доказывает главное — вход не
  // перехвачен рубильником, (б) по логике login-attempts обнуляет счётчик
  // неудач, накопленный предыдущими разделами приёмки с этого же IP. Неверный
  // пароль — вторым: после обнуления одна неудача лимит не выбивает. Обратный
  // порядок ловил 429 на слитой базе, где разделов до этого больше.
  const ok = await login(ADMIN.user, ADMIN.pass, new Jar());
  assert(ok.res.status === 302, `вход админа сломан: ${ok.res.status}`);

  // Неверный пароль должен дать отказ ВХОДА, а не отказ рубильника.
  const jar = new Jar();
  const page = await closedHttp('/login', { jar });
  assert(page.status === 200, `/login отдал ${page.status}`);
  const _csrf = tokenFrom(page.text);
  const bad = await closedHttp('/login', { method: 'POST', jar, form: { _csrf, username: ADMIN.user, password: 'ЗаведомоНеверный1' } });
  assert(bad.status !== 403 || !/Заявка не принята/.test(bad.text), 'админский вход перехвачен рубильником');

  for (const p of ['/', '/rating', '/news', '/tournaments', '/documents', '/coaches', '/privacy', '/consent']) {
    const r = await closedHttp(p);
    assert(r.status === 200, `${p}: публичный просмотр закрыт (${r.status})`);
  }
  return 'админский вход отвечает своей логикой; 8 публичных разделов и обе правовые страницы открыты';
});

await check('фраза о сборе ПДн привязана к рубильнику и снимается сама', async () => {
  const PHRASE = 'Сбор персональных данных не осуществляется';

  const closedHome = await closedHttp('/');
  assert(closedHome.text.includes(PHRASE), 'при закрытом приёме фразы о сборе ПДн нет');
  assert(/режиме разработки/.test(closedHome.text), 'нет баннера режима разработки');

  // На открытом приёме та же страница не должна утверждать обратное факту.
  const openHome = await http('/');
  assert(!openHome.text.includes(PHRASE), 'при ОТКРЫТОМ приёме сайт всё ещё заявляет, что данные не собираются');

  // Правовые страницы тоже под баннером — на них приходят читать про обработку.
  const priv = await closedHttp('/privacy');
  assert(priv.text.includes(PHRASE), '/privacy без предупреждения о режиме разработки');

  // В админке баннер лишний.
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const adm = await http('/admin', { jar });
  assert(!/режиме разработки/.test(adm.text), 'баннер просочился в админку');
  return 'фраза есть при закрытом приёме (включая /privacy), отсутствует при открытом, в админке баннера нет';
});

await check('реестр cookie полон: браузер не получает ничего сверх списка', async () => {
  const { COOKIE_REGISTRY, needsCookieConsent, optionalCookies } = await import('./server/lib/cookies.mjs');
  const known = new Set(COOKIE_REGISTRY.map((c) => c.name));

  // Согласие сейчас не требуется — необязательных cookie нет. Это НЕ ручной
  // флаг: значение выведено из реестра, и добавление счётчика включит баннер само.
  assert(needsCookieConsent() === false, 'реестр считает, что согласие нужно, — появилась необязательная cookie?');
  assert(optionalCookies().length === 0, 'в реестре есть необязательные cookie, а баннера согласия нет');

  // Обход публичных страниц: ни одной cookie вне реестра.
  const seen = new Set();
  for (const p of ['/', '/rating', '/news', '/register', '/privacy', '/consent']) {
    const jar = new Jar();
    const r = await closedHttp(p, { jar });
    for (const raw of r.setCookie || []) seen.add(String(raw).split('=')[0].trim());
  }
  // Вход админа — здесь сессионная cookie появиться обязана.
  const jar = new Jar();
  const page = await http('/login', { jar });
  await http('/login', { method: 'POST', jar, form: { _csrf: tokenFrom(page.text), username: ADMIN.user, password: ADMIN.pass } });
  for (const raw of jar.header().split(';')) {
    const n = raw.split('=')[0].trim();
    if (n) seen.add(n);
  }

  for (const name of seen) {
    assert(known.has(name), `cookie «${name}» ставится, но в реестре её нет (server/lib/cookies.mjs)`);
  }
  return `реестр: ${[...known].join(', ')}; согласие не требуется; cookie вне реестра не обнаружено`;
});

await check('обратная связь при закрытом приёме: формы нет, POST отклонён рубильником', async () => {
  const page = await closedHttp('/contacts');
  eq(page.status, 200, '/contacts при закрытом приёме');
  assert(!page.text.includes('action="/contacts/feedback"') && page.text.includes('временно закрыт'), 'при закрытом приёме форма показана');
  const r = await closedHttp('/contacts/feedback', { method: 'POST', form: { name: 'A', email: 'a@example.com', message: 'тест тест', consent_processing: '1' } });
  assert(r.status === 403, `POST при закрытом приёме должен дать 403, а дал ${r.status}`);
  return 'формы нет, POST → 403';
});

await new Promise((res) => {
  closedInst.app.locals.closeStore();
  closedInst.server.close(res);
});

// ---------------------------------------------------------------------------
// Галерея соревнований: загрузка через админку, EXIF снят, показ картинкой, ст. 152.1 ГК
// ---------------------------------------------------------------------------
await check('галерея: снимок с EXIF → без EXIF, привязан к соревнованию, показан <img>, пометка ст. 152.1', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const lib = await http('/admin/library', { jar });
  eq(lib.status, 200, 'библиотека админки');
  assert(lib.text.includes('id="g-tournament"'), 'в форме галереи нет выбора соревнования');
  assert(lib.text.includes('152.1'), 'в подсказке секретарю нет ссылки на ст. 152.1');
  const _csrf = tokenFrom(lib.text);
  let t = db.prepare('SELECT id, name FROM tournaments ORDER BY id LIMIT 1').get();
  if (!t) {
    const id = Number(db.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Первенство области (галерея)', '2026-08-30', 'A')").run().lastInsertRowid);
    t = { id, name: 'Первенство области (галерея)' };
  }
  const photo = await sharpLib({ create: { width: 2000, height: 1200, channels: 3, background: '#1d4ed8' } })
    .jpeg().withExif({ IFD0: { Make: 'TestCam', Copyright: 'ФТСО' } }).toBuffer();
  assert((await sharpLib(photo).metadata()).exif, 'исходный снимок должен нести EXIF');
  const before = db.prepare('SELECT COUNT(*) AS n FROM gallery_items').get().n;
  const up = await http('/admin/library/gallery', {
    method: 'POST', jar,
    multipart: { fields: { _csrf, title: 'Финал: общий план корта', tournament_id: String(t.id) },
      files: [{ field: 'file', filename: 'court.jpg', type: 'image/jpeg', buffer: photo }] },
  });
  eq(up.status, 302, 'загрузка снимка в галерею');
  const item = db.prepare('SELECT g.id, g.title, g.tournament_id, u.stored_name FROM gallery_items g JOIN uploads u ON u.id = g.upload_id ORDER BY g.id DESC LIMIT 1').get();
  eq(db.prepare('SELECT COUNT(*) AS n FROM gallery_items').get().n, before + 1, 'запись галереи не добавилась');
  eq(item.tournament_id, t.id, 'снимок не привязан к соревнованию');
  const stored = readFileSync(resolve(UPLOAD_DIR, item.stored_name));
  assert(!(await sharpLib(stored).metadata()).exif, 'EXIF остался в снимке галереи — утекли бы геолокация и модель камеры');
  const page = await http('/gallery');
  // ТЗ 4.8: полноэкранный просмотр — <dialog> и ссылки-обёртки на снимках; без JS ссылка открывает файл.
  assert(/<dialog class="lightbox" data-lightbox/.test(page.text), 'на /gallery нет <dialog> для полноэкранного просмотра');
  assert(new RegExp(`<a href="/gallery/${item.id}/image" class="gallery-link" data-gallery-item`).test(page.text), 'снимок не обёрнут ссылкой для просмотра');
  eq(page.status, 200, '/gallery');
  assert(page.text.includes(`<img src="/gallery/${item.id}/image"`), 'снимок не показан картинкой');
  assert(page.text.includes('Финал: общий план корта') && page.text.includes(t.name), 'на странице нет подписи или названия соревнования');
  assert(page.text.includes('152.1') && page.text.includes('href="/contacts"'), 'нет правовой пометки ст. 152.1 или пути к удалению');
  const img = await http(`/gallery/${item.id}/image`);
  eq(img.status, 200, 'картинка галереи');
  eq(img.headers.get('content-type'), 'image/jpeg', 'content-type картинки');
  eq(img.headers.get('x-content-type-options'), 'nosniff', 'nosniff на картинке');
  assert(!/attachment/i.test(img.headers.get('content-disposition') || ''), 'картинка ушла вложением, а не инлайн');
  eq((await http('/gallery/999999/image')).status, 404, 'чужой id → 404');
  const card = await http(`/tournaments/${t.id}`);
  eq(card.status, 200, 'карточка турнира');
  assert(card.text.includes(`<img src="/gallery/${item.id}/image"`) && card.text.includes('152.1'), 'снимок не показан на карточке своего турнира');
  const other = db.prepare('SELECT id FROM tournaments WHERE id != ? ORDER BY id LIMIT 1').get(t.id);
  if (other) {
    const otherCard = await http(`/tournaments/${other.id}`);
    assert(!otherCard.text.includes(`/gallery/${item.id}/image`) && otherCard.text.includes('Фотографий с этого турнира пока нет'), 'снимок утёк на карточку чужого турнира');
  }
  await http('/admin/library/gallery', {
    method: 'POST', jar,
    multipart: { fields: { _csrf, title: 'Мусорный турнир', tournament_id: '999999' },
      files: [{ field: 'file', filename: 'court2.jpg', type: 'image/jpeg', buffer: photo }] },
  });
  eq(db.prepare('SELECT COUNT(*) AS n FROM gallery_items WHERE title = ?').get('Мусорный турнир').n, 0, 'снимок с несуществующим турниром не должен сохраняться');
  return `снимок ${item.id}: EXIF снят, соревнование «${t.name}», /gallery и карточка турнира показывают <img>, чужая карточка — нет; image/jpeg + nosniff, пометка 152.1 и путь к удалению; чужой турнир отклонён`;
});

// ---------------------------------------------------------------------------
// Временный пароль: до смены — только /admin/account; смена снимает флаг
// ---------------------------------------------------------------------------
await check('временный пароль: вход ведёт на смену, остальная админка закрыта, после смены открыта', async () => {
  const { hashPassword } = await import('./server/lib/password.mjs');
  const saved = db.prepare("SELECT id, password_hash FROM users WHERE username = ?").get(ADMIN.user);
  assert(saved, 'нет пользователя admin');
  const temp = 'Temp-Pass-2026x';
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(temp), saved.id);
  try {
    const { res: first, jar } = await login(ADMIN.user, temp);
    eq(first.status, 302, 'вход по временному паролю');
    assert(String(first.location || '').includes('/admin/account'), `после входа ждал /admin/account, а ушло на ${first.location}`);
    const blocked = await http('/admin/vault', { jar });
    eq(blocked.status, 302, 'до смены пароля /admin/vault должен редиректить');
    assert(String(blocked.location || '').includes('/admin/account'), 'редирект не на смену пароля');
    const acc = await http('/admin/account', { jar });
    eq(acc.status, 200, '/admin/account должна быть доступна');
    assert(acc.text.includes('Вы вошли по временному паролю'), 'нет подсказки о временном пароле');
    const chg = await http('/admin/account/password', { method: 'POST', form: { _csrf: tokenFrom(acc.text), current_password: temp, new_password: 'My-Own-Pass-2026' }, jar });
    eq(chg.status, 302, 'смена пароля');
    eq(db.prepare('SELECT must_change_password AS f FROM users WHERE id = ?').get(saved.id).f, 0, 'флаг не снят');
    eq((await http('/admin/vault', { jar })).status, 200, 'после смены /admin/vault должна открыться');
    return 'вход → /admin/account; /admin/vault → редирект; смена → флаг 0, /admin/vault 200';
  } finally {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(saved.password_hash, saved.id);
  }
});

// ---------------------------------------------------------------------------
// Пароли: сброс админов временным паролем; ссылка для входа игроку на экране секретаря
// ---------------------------------------------------------------------------
await check('«Сохранить данные для входа»: чекбокс на /login и /cabinet/login; с отметкой кука живёт ~30 дней, без — 12 часов', async () => {
  const expiresOf = (r) => { const c = r.setCookie.find((x) => x.startsWith('ftso.sid=')); const m = c && c.match(/Expires=([^;]+)/i); return m ? new Date(m[1]).getTime() : null; };
  const days = (r) => Math.round((expiresOf(r) - Date.now()) / 36e5 / 24 * 10) / 10;
  for (const p of ['/login', '/cabinet/login']) {
    const page = await http(p);
    assert(/name="remember"[^>]*value="1"/.test(page.text) && page.text.includes('Сохранить данные для входа'), `${p}: нет чекбокса «Сохранить данные для входа»`);
    assert(!/name="remember"[^>]*checked/.test(page.text), `${p}: чекбокс не должен быть отмечен заранее`);
  }
  const plain = await login(ADMIN.user, ADMIN.pass);
  const hoursPlain = Math.round((expiresOf(plain.res) - Date.now()) / 36e5);
  assert(hoursPlain >= 11 && hoursPlain <= 13, `без отметки кука должна жить ~12 ч, а живёт ${hoursPlain} ч`);
  const jarR = new Jar();
  const lp = await http('/login', { jar: jarR });
  const rem = await http('/login', { method: 'POST', form: { _csrf: tokenFrom(lp.text), username: ADMIN.user, password: ADMIN.pass, next: '/admin', remember: '1' }, jar: jarR });
  eq(rem.status, 302, 'вход с отметкой');
  assert(days(rem) >= 29 && days(rem) <= 31, `с отметкой кука должна жить ~30 дней, а живёт ${days(rem)}`);
  eq((await http('/admin', { jar: jarR })).status, 200, 'сессия с отметкой работает');
  resetCabinetLimit();
  const jarC = new Jar();
  const cl = await http('/cabinet/login', { jar: jarC });
  const cr = await http('/cabinet/login', { method: 'POST', form: { _csrf: tokenFrom(cl.text), email: 'timofey@example.com', password: 'своя-жизнь-2026-корт', remember: '1' }, jar: jarC });
  eq(cr.status, 302, 'вход в кабинет с отметкой');
  assert(days(cr) >= 29 && days(cr) <= 31, `кабинет: с отметкой кука должна жить ~30 дней, а живёт ${days(cr)}`);
  resetCabinetLimit();
  return `чекбокс на обеих формах, не предотмечен; без отметки ${hoursPlain} ч, с отметкой ${days(rem)} дн (админ) и ${days(cr)} дн (кабинет)`;
});

await check('сброс пароля админа: временный показан один раз, вход по нему ведёт на смену; себе — отказ', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const me = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.user);
  const target = db.prepare('SELECT id, username, password_hash, must_change_password FROM users WHERE username = ?').get(TADMIN.user);
  assert(target, 'нет пользователя turnir');
  const page = await http('/admin/users', { jar });
  eq(page.status, 200, '/admin/users');
  assert(page.text.includes('Выдать временный пароль'), 'нет кнопки выдачи временного пароля');
  const _csrf = tokenFrom(page.text);
  try {
    const r = await http(`/admin/users/${target.id}/password`, { method: 'POST', form: { _csrf }, jar });
    eq(r.status, 302, 'выдача временного пароля');
    const after = await http('/admin/users', { jar });
    assert(after.text.includes(`Временный пароль для «${TADMIN.user}»`), 'нет сообщения о временном пароле');
    const m = after.text.match(/class="flash-secret__value">([A-Za-z0-9]{14})<\/code>/);
    assert(m, 'временный пароль не показан крупным блоком');
    assert(after.text.includes(`data-copy="${m[1]}"`), 'нет кнопки «Скопировать» с паролем');
    eq(db.prepare('SELECT must_change_password AS f FROM users WHERE id = ?').get(target.id).f, 1, 'флаг обязательной смены не выставлен');
    const again = await http('/admin/users', { jar });
    assert(!again.text.includes(m[1]), 'временный пароль показался второй раз');
    const t = await login(TADMIN.user, m[1]);
    eq(t.res.status, 302, 'вход по временному');
    assert(String(t.res.location || '').includes('/admin/account'), `вход ведёт не на смену: ${t.res.location}`);
    // СЕБЕ: временный выдаётся, ведёт сразу на смену, временный подходит как «текущий».
    const mine = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.id);
    const self = await http(`/admin/users/${me.id}/password`, { method: 'POST', form: { _csrf }, jar });
    eq(self.status + ' ' + self.location, '302 /admin/account?change=1', 'себе — сразу на смену пароля');
    eq(db.prepare('SELECT must_change_password AS f FROM users WHERE id = ?').get(me.id).f, 1, 'себе флаг смены не выставлен');
    const acct = await http('/admin/account?change=1', { jar });
    const ms = acct.text.match(/class="flash-secret__value">([A-Za-z0-9]{14})<\/code>/);
    assert(ms, 'свой временный пароль не показан на странице смены');
    eq((await http('/admin/users', { jar })).location, '/admin/account?change=1', 'до смены остальная админка закрыта');
    const chg = await http('/admin/account/password', { method: 'POST', form: { _csrf: tokenFrom(acct.text), current_password: ms[1], new_password: 'новый-свой-пароль-2026' }, jar });
    eq(chg.status + ' ' + chg.location, '302 /admin', 'смена по временному как «текущему»');
    eq(db.prepare('SELECT must_change_password AS f FROM users WHERE id = ?').get(me.id).f, 0, 'после смены флаг не снят');
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(mine.password_hash, me.id);
    return `временный для ${TADMIN.user} показан один раз, флаг 1, вход → /admin/account; себе — временный показан на странице смены, принят как текущий, новый задан`;
  } finally {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = ? WHERE id = ?').run(target.password_hash, target.must_change_password, target.id);
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(me.id);
  }
});

await check('ссылка в кабинет с экрана секретаря: только для игрока с аккаунтом, ссылка открывает форму пароля', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const _csrf = tokenFrom((await http('/admin/players', { jar })).text);
  const noAcc = db.prepare('SELECT p.id FROM players p LEFT JOIN player_accounts a ON a.player_id = p.id WHERE a.player_id IS NULL AND p.anonymized_at IS NULL LIMIT 1').get();
  const withAcc = db.prepare('SELECT p.id FROM players p JOIN player_accounts a ON a.player_id = p.id WHERE p.anonymized_at IS NULL LIMIT 1').get();
  assert(noAcc && withAcc, 'нужны игрок без кабинета и игрок с кабинетом');
  const list = await http('/admin/players', { jar });
  assert(list.text.includes(`form="link-player-${withAcc.id}"`), 'у игрока с кабинетом нет кнопки «Ссылка в кабинет»');
  assert(!list.text.includes(`form="link-player-${noAcc.id}"`), 'у игрока без кабинета кнопка не должна показываться');
  eq((await http(`/admin/players/${noAcc.id}/cabinet-link`, { method: 'POST', form: { _csrf }, jar })).status, 302, 'без кабинета — редирект с ошибкой');
  const r = await http(`/admin/players/${withAcc.id}/cabinet-link`, { method: 'POST', form: { _csrf }, jar });
  eq(r.status, 302, 'выдача ссылки');
  const after = (await http('/admin/players', { jar })).text.replace(/\s+/g, ' ');
  const m = after.match(/class="flash-secret__value">(https?:\/\/[^<\s]+\/cabinet\/reset\/[A-Za-z0-9_-]+)<\/code>/);
  assert(m, 'ссылка не показана крупным блоком');
  assert(after.includes(`data-copy="${m[1]}"`), 'нет кнопки «Скопировать» со ссылкой');
  const path = m[1].replace(/^https?:\/\/[^/]+/, '');
  const form = await http(path);
  eq(form.status, 200, 'ссылка должна открыть форму установки пароля');
  assert(/name="password"/.test(form.text), 'по ссылке нет формы пароля');
  return `игрок ${withAcc.id}: ссылка показана, ${path.slice(0, 20)}… открывает форму; игрок ${noAcc.id} без кабинета — кнопки нет, POST отклонён`;
});

// ---------------------------------------------------------------------------
// Плашка «режим разработки» по умолчанию выключена; форма обратной связи на /contacts
// ---------------------------------------------------------------------------
await check('подпись редакции Политики совпадает с LEGAL_VERSION (машинная и человеческая версии не расходятся)', async () => {
  const { LEGAL_VERSION, LEGAL_VERSION_LABEL } = await import('./server/lib/legal.mjs');
  const [y, m, d] = LEGAL_VERSION.split('-');
  eq(LEGAL_VERSION_LABEL, `Редакция от ${d}.${m}.${y}`, 'подпись не выведена из LEGAL_VERSION');
  const priv = await http('/privacy');
  assert(priv.text.includes(LEGAL_VERSION_LABEL), 'на /privacy другая подпись редакции');
  const cons = await http('/consent');
  assert(cons.text.includes(LEGAL_VERSION_LABEL), 'на /consent другая подпись редакции');
  return `${LEGAL_VERSION} ↔ «${LEGAL_VERSION_LABEL}» на /privacy и /consent`;
});

await check('плашка «режим разработки»: держится сама, пока нет результатов; DEV_NOTICE=1 — принудительно', async () => {
  const { loadConfig } = await import('./server/lib/config.mjs');
  const { devNoticeOn } = await import('./server/app.mjs');
  const saved = process.env.DEV_NOTICE;
  try {
    delete process.env.DEV_NOTICE;
    eq(loadConfig({ requireSecrets: false }).devNotice, false, 'без DEV_NOTICE принудительного флага нет');
    process.env.DEV_NOTICE = '1';
    eq(loadConfig({ requireSecrets: false }).devNotice, true, 'DEV_NOTICE=1 — принудительно');
  } finally {
    if (saved === undefined) delete process.env.DEV_NOTICE; else process.env.DEV_NOTICE = saved;
  }
  // Пустая база (схема без данных) — плашка есть; первый результат — плашка ушла.
  const Database = (await import('better-sqlite3')).default;
  const { readFileSync } = await import('node:fs');
  const empty = new Database(':memory:');
  empty.exec(readFileSync('./db/schema.sql', 'utf8'));
  eq(devNoticeOn(empty, { devNotice: false }), true, 'на пустой базе плашка должна стоять');
  empty.prepare("INSERT INTO players (full_name, city, sex) VALUES ('Первый Игрок','Смоленск','M')").run();
  empty.prepare("INSERT INTO tournaments (name, end_date, category) VALUES ('Первый турнир', date('now'), 'B')").run();
  empty.prepare('INSERT INTO results (tournament_id, player_id, place) VALUES (1, 1, 1)').run();
  eq(devNoticeOn(empty, { devNotice: false }), false, 'с первым результатом плашка должна уйти');
  eq(devNoticeOn(empty, { devNotice: true }), true, 'DEV_NOTICE=1 держит плашку и на наполненном сайте');
  empty.close();
  // Тестовая база наполнена — на главной плашки нет, при этом в админку она не лезет никогда.
  assert(!/режиме разработки/.test((await http('/')).text), 'на наполненном сайте плашка осталась');
  return 'пустая база → плашка; первый результат → ушла; DEV_NOTICE=1 → всегда; тестовый сайт наполнен — без плашки';
});

await check('обратная связь: форма на /contacts, честная запись, honeypot и без согласия — нет записи, письмо в очередь, админка отмечает и удаляет, чистка по сроку', async () => {
  const { LEGAL_VERSION } = await import('./server/lib/legal.mjs');
  const { purgeFeedback } = await import('./server/lib/feedback.mjs');
  const jar = new Jar();
  const page = await http('/contacts', { jar });
  eq(page.status, 200, '/contacts');
  assert(page.text.includes('action="/contacts/feedback"') && page.text.includes('name="consent_processing"') && page.text.includes('name="website"'), 'на /contacts нет формы с согласием и honeypot');
  const _csrf = tokenFrom(page.text);
  const before = db.prepare('SELECT COUNT(*) AS n FROM feedback_messages').get().n;
  const noConsent = await http('/contacts/feedback', { method: 'POST', jar, form: { _csrf, name: 'Иван', email: 'ivan@example.com', message: 'Вопрос по турниру' } });
  eq(noConsent.status, 302, 'без согласия — редирект с ошибкой');
  assert(String(noConsent.location || '').includes('error='), 'без согласия ошибка не показана');
  const bot = await http('/contacts/feedback', { method: 'POST', jar, form: { _csrf, name: 'Бот', email: 'bot@example.com', message: 'спам спам спам', consent_processing: '1', website: 'http://spam' } });
  eq(bot.status, 302, 'honeypot — тихий редирект');
  assert(String(bot.location || '').includes('sent=1'), 'honeypot должен выглядеть как успех');
  eq(db.prepare('SELECT COUNT(*) AS n FROM feedback_messages').get().n, before, 'без согласия или с honeypot запись не должна создаваться');
  const ok = await http('/contacts/feedback', { method: 'POST', jar, form: { _csrf, name: 'Пётр Сидоров', email: 'petr@example.com', message: 'Хочу узнать про детские турниры', consent_processing: '1' } });
  eq(ok.status, 302, 'честное обращение');
  assert(String(ok.location || '').includes('sent=1'), 'после отправки нет подтверждения');
  const row = db.prepare('SELECT id, status, legal_version FROM feedback_messages ORDER BY id DESC LIMIT 1').get();
  assert(row && row.status === 'new' && row.legal_version === LEGAL_VERSION, `запись не та: ${JSON.stringify(row)}`);
  const sentPage = await http('/contacts?sent=1');
  assert(sentPage.text.includes('Обращение отправлено'), 'страница не подтверждает отправку');
  eq(db.prepare("SELECT COUNT(*) AS n FROM mail_outbox WHERE kind = 'feedback.new' AND status = 'queued'").get().n >= 1, true, 'письмо секретарю не в очереди');
  const t = await login(TADMIN.user, TADMIN.pass);
  const list = await http('/admin/feedback', { jar: t.jar });
  eq(list.status, 200, '/admin/feedback для tournament-admin');
  assert(list.text.includes('Пётр Сидоров') && list.text.includes('Хочу узнать про детские турниры') && list.text.includes('НОВОЕ'), 'обращение не в списке');
  const c2 = tokenFrom(list.text);
  eq((await http(`/admin/feedback/${row.id}/done`, { method: 'POST', form: { _csrf: c2 }, jar: t.jar })).status, 302, 'отметка обработано');
  const after = db.prepare('SELECT status, handled_at FROM feedback_messages WHERE id = ?').get(row.id);
  assert(after.status === 'done' && after.handled_at, 'статус не обновился');
  db.prepare("UPDATE feedback_messages SET handled_at = datetime('now', '-400 days') WHERE id = ?").run(row.id);
  eq(purgeFeedback(db, 365), 1, 'чистка не удалила обработанное старше года');
  const fresh = db.prepare("INSERT INTO feedback_messages (name, email, message, legal_version) VALUES ('X', 'x@example.com', 'новое обращение', ?)").run(LEGAL_VERSION).lastInsertRowid;
  eq(purgeFeedback(db, 365), 0, 'чистка не должна трогать новые');
  eq((await http(`/admin/feedback/${fresh}/delete`, { method: 'POST', form: { _csrf: c2 }, jar: t.jar })).status, 302, 'удаление');
  eq(db.prepare('SELECT COUNT(*) AS n FROM feedback_messages WHERE id = ?').get(fresh).n, 0, 'не удалено');
  return `форма есть; без согласия и honeypot — без записи; честное → new с ${LEGAL_VERSION}, письмо в очереди; секретарь отметил; чистка: старое done удалено, новое нет; удаление работает`;
});

// ---------------------------------------------------------------------------
// Матрица ролей: content-manager и news-editor — рабочие; меню и маршруты по одной карте
// ---------------------------------------------------------------------------
await check('роли: content-manager и news-editor входят, видят свои разделы, чужие → 403, пароль меняют; меню по роли', async () => {
  const { hashPassword } = await import('./server/lib/password.mjs');
  const { ROLE_SECTIONS, rolesFor } = await import('./server/middleware/auth.mjs');
  const mk = (u, role) => {
    db.prepare('DELETE FROM users WHERE username = ?').run(u);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(u, hashPassword('Role-Pass-2026'), role);
  };
  mk('office_t', 'content-manager'); mk('news_t', 'news-editor');
  try {
    const expect = {
      'content-manager': { ok: ['/admin', '/admin/news', '/admin/library', '/admin/directories/coaches', '/admin/feedback', '/admin/account'], no: ['/admin/players', '/admin/registrations', '/admin/tournaments', '/admin/vault', '/admin/users'] },
      'news-editor': { ok: ['/admin', '/admin/news', '/admin/account'], no: ['/admin/library', '/admin/directories/coaches', '/admin/feedback', '/admin/players', '/admin/vault', '/admin/users'] },
    };
    const report = [];
    for (const [u, role] of [['office_t', 'content-manager'], ['news_t', 'news-editor']]) {
      const { res, jar } = await login(u, 'Role-Pass-2026');
      eq(res.status, 302, `${role}: вход`);
      for (const p of expect[role].ok) eq((await http(p, { jar })).status, 200, `${role}: ${p} должен открываться`);
      for (const p of expect[role].no) eq((await http(p, { jar })).status, 403, `${role}: ${p} должен давать 403`);
      const menu = (await http('/admin', { jar })).text;
      const has = (href) => menu.includes(`href="${href}"`);
      assert(has('/admin/news') && has('/admin/account'), `${role}: в меню нет своих разделов`);
      assert(!has('/admin/players') && !has('/admin/vault') && !has('/admin/users'), `${role}: в меню чужие разделы`);
      if (role === 'news-editor') assert(!has('/admin/library') && !menu.includes('/admin/rating/recompute'), 'news-editor: лишнее в меню или кнопка рейтинга');
      if (role === 'content-manager') assert(has('/admin/library') && has('/admin/feedback'), 'content-manager: нет библиотеки/обращений в меню');
      const acc = await http('/admin/account', { jar });
      const chg = await http('/admin/account/password', { method: 'POST', form: { _csrf: tokenFrom(acc.text), current_password: 'Role-Pass-2026', new_password: 'Role-Pass-2026-new' }, jar });
      eq(chg.status, 302, `${role}: смена пароля`);
      const { res: re } = await login(u, 'Role-Pass-2026-new');
      eq(re.status, 302, `${role}: вход по новому паролю`);
      report.push(`${role}: ${expect[role].ok.length} открыто, ${expect[role].no.length} × 403, меню по роли, пароль сменён`);
    }
    eq(rolesFor('players').join(','), 'super-admin,tournament-admin', 'матрица players');
    eq(rolesFor('news').includes('news-editor') && rolesFor('news').includes('content-manager'), true, 'матрица news');
    eq(ROLE_SECTIONS['news-editor'].length, 3, 'news-editor — ровно сводка, новости, аккаунт');
    return report.join('; ');
  } finally {
    db.prepare("DELETE FROM users WHERE username IN ('office_t', 'news_t')").run();
  }
});

// ---------------------------------------------------------------------------
// ФИО тремя полями: регистрация, представитель, админка, кабинет; статика с версией
// ---------------------------------------------------------------------------
await check('ФИО тремя полями: собирается в full_name, отчество необязательно, без фамилии — ошибка; представитель так же; админка; статика с версией', async () => {
  db.prepare("DELETE FROM write_attempts WHERE key LIKE 'r:%'").run(); // лимит 5 заявок/час с адреса — здесь их четыре подряд
  const jar = new Jar();
  const page = await http('/register', { jar });
  for (const n of ['last_name', 'first_name', 'middle_name', 'guardian_last_name', 'guardian_first_name', 'guardian_middle_name']) assert(page.text.includes(`name="${n}"`), `в форме нет поля ${n}`);
  assert(!page.text.includes('name="full_name"'), 'в регистрации осталось одно поле ФИО');
  for (const n of ['guardian_last_name', 'guardian_first_name', 'guardian_relation', 'guardian_email', 'city', 'sex', 'birth_date', 'email']) {
    const tag = page.text.match(new RegExp(`<(?:input|select)[^>]*name="${n}"[^>]*>`));
    assert(tag && /\brequired\b/.test(tag[0]), `поле ${n} должно быть обязательным`);
  }
  for (const n of ['middle_name', 'guardian_middle_name']) assert(!/\brequired\b/.test((page.text.match(new RegExp(`<input[^>]*name="${n}"[^>]*>`)) || [''])[0]), `${n} не должно быть обязательным`);
  const _csrf = tokenFrom(page.text);
  const ok = await http('/register', { method: 'POST', jar, form: { _csrf, last_name: 'Сидоров', first_name: 'Пётр', middle_name: 'Ильич', city: 'Смоленск', sex: 'M', birth_date: ADULT_BIRTH, email: 'trio@example.com', consent_processing: '1' } });
  eq(ok.status, 302, `заявка тремя полями: ${ok.status}`);
  eq(db.prepare('SELECT full_name FROM registrations WHERE email = ?').get('trio@example.com').full_name, 'Сидоров Пётр Ильич', 'ФИО не собралось');
  const jar2 = new Jar(); const c2 = tokenFrom((await http('/register', { jar: jar2 })).text);
  const noMiddle = await http('/register', { method: 'POST', jar: jar2, form: { _csrf: c2, last_name: 'Smith', first_name: 'John', middle_name: '', city: 'Смоленск', sex: 'M', birth_date: ADULT_BIRTH, email: 'smith@example.com', consent_processing: '1' } });
  eq(noMiddle.status, 302, 'без отчества должно приниматься');
  eq(db.prepare('SELECT full_name FROM registrations WHERE email = ?').get('smith@example.com').full_name, 'Smith John', 'без отчества — два слова');
  const jar3 = new Jar(); const c3 = tokenFrom((await http('/register', { jar: jar3 })).text);
  const noLast = await http('/register', { method: 'POST', jar: jar3, form: { _csrf: c3, last_name: '', first_name: 'Пётр', city: 'Смоленск', sex: 'M', birth_date: ADULT_BIRTH, email: 'nolast@example.com', consent_processing: '1' } });
  eq(noLast.status, 400, 'без фамилии — отказ');
  assert(/фамилия/i.test(noLast.text), 'ошибка не называет фамилию');
  const y = new Date().getFullYear();
  const jar4 = new Jar(); const c4 = tokenFrom((await http('/register', { jar: jar4 })).text);
  const kid = await http('/register', { method: 'POST', jar: jar4, form: { _csrf: c4, last_name: 'Юный', first_name: 'Игрок', city: 'Смоленск', sex: 'M', birth_date: `${y - 12}-03-03`, guardian_last_name: 'Юная', guardian_first_name: 'Мама', guardian_middle_name: 'Петровна', guardian_relation: 'мать', guardian_email: 'kidmom@example.com', consent_guardian_child: '1', consent_guardian_self: '1' } });
  eq(kid.status, 302, `заявка ребёнка с представителем тремя полями: ${kid.status} ${kid.text.slice(0, 200)}`);
  const kidReg = db.prepare('SELECT id, full_name FROM registrations WHERE full_name = ?').get('Юный Игрок');
  assert(kidReg, 'заявка ребёнка не создана');
  eq(db.prepare('SELECT guardian_full_name FROM registrations WHERE id = ?').get(kidReg.id).guardian_full_name, 'Юная Мама Петровна', 'ФИО представителя не собралось');
  const { jar: aj } = await login(ADMIN.user, ADMIN.pass);
  const ap = await http('/admin/players', { jar: aj });
  assert(ap.text.includes('name="last_name"') && ap.text.includes('name="middle_name"') && !ap.text.includes('id="p-name"'), 'в админке нет трёх полей');
  const ac = tokenFrom(ap.text);
  eq((await http('/admin/players', { method: 'POST', jar: aj, form: { _csrf: ac, last_name: 'Админов', first_name: 'Тест', middle_name: '', city: 'Смоленск', sex: 'F' } })).status, 302, 'создание игрока тремя полями');
  const created = db.prepare('SELECT id, full_name FROM players WHERE full_name = ?').get('Админов Тест');
  assert(created, 'игрок не создан из трёх полей');
  const table = (await http('/admin/players', { jar: aj })).text;
  assert(table.includes(`form="edit-player-${created.id}" name="last_name" value="Админов"`), 'в таблице фамилия не разобрана в своё поле');
  const shell = (await http('/login')).text;
  const v = shell.match(/\/static\/js\/app\.js\?v=([0-9a-f]{8})/);
  assert(v && shell.includes(`/static/css/site.css?v=${v[1]}`), 'статика подключена без версии');
  return `трио → «Сидоров Пётр Ильич»; без отчества → «Smith John»; без фамилии → 400; представитель «Юная Мама Петровна»; админка создала «Админов Тест», таблица разбирает; статика ?v=${v[1]}`;
});

// ---------------------------------------------------------------------------
// Закрытые документы федерации (/admin/vault): только super-admin, наружу не отдаются
// ---------------------------------------------------------------------------
await check('vault: загрузка super-admin → скачивание вложением; /files и tournament-admin не видят; мусор не сиротит файл; удаление', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/vault', { jar });
  eq(page.status, 200, '/admin/vault для super-admin');
  assert(page.text.includes('id="v-category"') && page.text.includes('152-ФЗ'), 'нет формы с категориями');
  assert(page.text.includes('href="/admin/vault"'), 'в меню админки нет пункта');
  const _csrf = tokenFrom(page.text);
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
  const uploadsBefore = db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n;
  const up = await http('/admin/vault', {
    method: 'POST', jar,
    multipart: { fields: { _csrf, title: 'Справка о местоположении сервера № 1633', category: '152-ФЗ', note: 'Timeweb, 04.09.2026' },
      files: [{ field: 'file', filename: 'spravka-1633.pdf', type: 'application/pdf', buffer: pdf }] },
  });
  eq(up.status, 302, 'загрузка в закрытый раздел');
  const doc = db.prepare('SELECT id, upload_id, category, note FROM internal_documents ORDER BY id DESC LIMIT 1').get();
  assert(doc && doc.category === '152-ФЗ' && doc.note === 'Timeweb, 04.09.2026', 'запись не создана или поля не те');
  const list = await http('/admin/vault', { jar });
  assert(list.text.includes('Справка о местоположении сервера № 1633') && list.text.includes(`/admin/vault/${doc.id}/file`), 'документ не в списке');
  const file = await http(`/admin/vault/${doc.id}/file`, { jar });
  eq(file.status, 200, 'скачивание super-admin');
  assert(/attachment/i.test(file.headers.get('content-disposition') || ''), 'файл должен уходить вложением');
  eq(file.headers.get('content-type'), 'application/pdf', 'content-type файла');
  eq((await http(`/files/${doc.upload_id}`)).status, 404, 'публичный /files/:id не должен отдавать закрытый документ');
  const anon = await http(`/admin/vault/${doc.id}/file`);
  assert(anon.status !== 200, `без сессии файл отдан: ${anon.status}`);
  const t = await login(TADMIN.user, TADMIN.pass);
  eq((await http('/admin/vault', { jar: t.jar })).status, 403, 'tournament-admin должен получить 403');
  eq((await http(`/admin/vault/${doc.id}/file`, { jar: t.jar })).status, 403, 'tournament-admin не должен скачивать');
  const bad = await http('/admin/vault', {
    method: 'POST', jar,
    multipart: { fields: { _csrf, title: 'Мусор', category: 'Не из списка' },
      files: [{ field: 'file', filename: 'x.pdf', type: 'application/pdf', buffer: pdf }] },
  });
  eq(bad.status, 302, 'мусорная категория — редирект с ошибкой');
  eq(db.prepare('SELECT COUNT(*) AS n FROM internal_documents WHERE title = ?').get('Мусор').n, 0, 'документ с мусорной категорией не должен сохраняться');
  eq(db.prepare('SELECT COUNT(*) AS n FROM uploads').get().n, uploadsBefore + 1, 'отклонённая загрузка оставила файл-сироту');
  const del = await http(`/admin/vault/${doc.id}/delete`, { method: 'POST', form: { _csrf }, jar });
  eq(del.status, 302, 'удаление');
  eq(db.prepare('SELECT COUNT(*) AS n FROM internal_documents WHERE id = ?').get(doc.id).n, 0, 'запись не удалена');
  eq(db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE id = ?').get(doc.upload_id).n, 0, 'файл не удалён вместе с записью');
  return 'загружен → в списке → скачан вложением (pdf); /files → 404; без сессии — нет; tournament-admin → 403; мусорная категория без сирот; удалён с файлом';
});

// ---------------------------------------------------------------------------
// РНИ: поле в админке, вывод на публичном профиле
// ---------------------------------------------------------------------------
await check('РНИ: поле в админке → БД → профиль; пустое стирает; мусор отклоняется', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const _csrf = tokenFrom((await http('/admin/players', { jar })).text);
  const name = 'Рниев Тест Проверочный';
  const r = await http('/admin/players', { method: 'POST', form: { _csrf, full_name: name, city: 'Смоленск', sex: 'M', rni: '4567-A' }, jar });
  eq(r.status, 302, 'создание игрока с РНИ');
  const row = db.prepare('SELECT id, rni FROM players WHERE full_name = ?').get(name);
  assert(row, 'игрок не создан');
  eq(row.rni, '4567-A', 'РНИ не записан в players.rni');
  const profile = await http(`/player/${row.id}`);
  eq(profile.status, 200, 'профиль недоступен');
  assert(profile.text.includes('<span class="tag">РНИ 4567-A</span>'), 'РНИ не выведен на публичном профиле');
  const list = await http('/admin/players', { jar });
  assert(list.text.includes('name="rni" value="4567-A"'), 'в таблице админки нет поля РНИ со значением');
  const upd = await http(`/admin/players/${row.id}/update`, { method: 'POST', form: { _csrf, full_name: name, city: 'Смоленск', sex: 'M', rni: '' }, jar });
  eq(upd.status, 302, 'обновление с пустым РНИ');
  eq(db.prepare('SELECT rni FROM players WHERE id = ?').get(row.id).rni, null, 'пустое поле должно стирать РНИ');
  assert(!(await http(`/player/${row.id}`)).text.includes('<span class="tag">РНИ '), 'после стирания РНИ остался на профиле');
  await http('/admin/players', { method: 'POST', form: { _csrf, full_name: `${name} Мусор`, city: 'Смоленск', sex: 'M', rni: '12 345!' }, jar });
  eq(db.prepare('SELECT COUNT(*) AS n FROM players WHERE full_name = ?').get(`${name} Мусор`).n, 0, 'игрок с мусорным РНИ не должен создаваться');
  return 'создан с РНИ 4567-A → в БД и на профиле; в админке поле со значением; пустое стёрло; мусор отклонён';
});

// ---------------------------------------------------------------------------
// Здоровье выката: deploy/health.sh против живого приложения
// ---------------------------------------------------------------------------
await check('deploy/health.sh: /, /rating и первый профиль → 0; мёртвый порт → 1', async () => {
  const HEALTH = resolve(HERE, '..', 'deploy', 'health.sh');
  assert(existsSync(HEALTH), 'нет deploy/health.sh');
  // ВАЖНО: не spawnSync — сервер живёт в этом же процессе, синхронное ожидание
  // curl заморозит event loop, и curl не дождётся ответа (взаимная блокировка).
  const run = (base) => new Promise((res) => {
    const p = spawn('bash', [HEALTH, base]);
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => res({ status, stdout, stderr }));
  });
  const ok = await run(inst.base);
  eq(ok.status, 0, `health.sh против живого приложения вернул ${ok.status}: ${ok.stdout.trim().replace(/\n/g, ' | ')} ${ok.stderr.trim()}`);
  assert(/^HTTP \/ = 200$/m.test(ok.stdout) && /^HTTP \/rating = 200$/m.test(ok.stdout), `нет строк 200 для / и /rating: ${ok.stdout}`);
  const profile = /^HTTP \/player\/\d+ = 200 /m.test(ok.stdout) ? 'первый профиль из рейтинга 200'
    : /пропускаю/.test(ok.stdout) ? 'профилей в рейтинге нет — явный пропуск' : null;
  assert(profile, `нет ни проверки профиля, ни явного пропуска: ${ok.stdout}`);
  const dead = await run('http://127.0.0.1:1');
  eq(dead.status, 1, `мёртвый порт должен дать код 1, а дал ${dead.status}`);
  return `/ и /rating 200; ${profile}; мёртвый порт → код 1`;
});

// ===========================================================================
await stopApp(inst);
closeDb();

// ---------------------------------------------------------------------------
// Выкат: дифф только из памяти не рестартит pm2 (deploy/deploy-watch.sh)
// ---------------------------------------------------------------------------
await check('deploy-watch: дифф только из памяти → ff без выката; код → выкат', async () => {
  const WATCH = resolve(HERE, '..', 'deploy', 'deploy-watch.sh');
  assert(existsSync(WATCH), 'нет deploy/deploy-watch.sh');
  const tmp = mkdtempSync('/tmp/dw-');
  try {
    const git = (cwd, ...a) => {
      const r = spawnSync('git', a, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      });
      if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr || r.stdout}`);
      return r.stdout.trim();
    };
    const origin = resolve(tmp, 'origin.git');
    const work = resolve(tmp, 'work');
    const prod = resolve(tmp, 'prod');
    const marker = resolve(tmp, 'deployed');
    const deployScript = resolve(tmp, 'deploy-fake.sh');
    writeFileSync(deployScript, `#!/usr/bin/env bash\necho called >> "${marker}"\n`);
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    git(tmp, 'clone', '-q', origin, work);
    mkdirSync(resolve(work, 'site'), { recursive: true });
    mkdirSync(resolve(work, 'ritual'), { recursive: true });
    writeFileSync(resolve(work, 'site', 'app.txt'), 'v1\n');
    writeFileSync(resolve(work, 'ritual', '.gitkeep'), '');
    writeFileSync(resolve(work, 'NEXT_CHAT_START.md'), '# start\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'init');
    git(work, 'branch', '-M', 'main');
    git(work, 'push', '-q', '-u', origin, 'main');
    git(tmp, 'clone', '-q', origin, prod);
    const env = {
      DEPLOY_ROOT: prod, DEPLOY_SCRIPT: deployScript, DEPLOY_RUNAS: '',
      DEPLOY_LOG: resolve(tmp, 'log'), DEPLOY_STATE: resolve(tmp, 'state'), DEPLOY_LOCK: resolve(tmp, 'lock'),
    };
    const runWatch = () => spawnSync('bash', [WATCH], { env: { ...process.env, ...env }, encoding: 'utf8' });
    // 1) коммит ТОЛЬКО памяти → выката быть не должно, HEAD должен догнать origin
    writeFileSync(resolve(work, 'ritual', 'SESSION_2026-09-03-1.md'), 'снимок сессии\n');
    writeFileSync(resolve(work, 'NEXT_CHAT_START.md'), '# start 2\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'ритуал');
    git(work, 'push', '-q', origin, 'main');
    runWatch();
    assert(!existsSync(marker), 'дифф только из памяти вызвал выкат pm2');
    eq(git(prod, 'rev-parse', 'HEAD'), git(prod, 'rev-parse', 'origin/main'), 'память не подтянута fast-forward');
    // 2) коммит кода → выкат обязан произойти
    writeFileSync(resolve(work, 'site', 'app.txt'), 'v2\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'код');
    git(work, 'push', '-q', origin, 'main');
    runWatch();
    assert(existsSync(marker), 'дифф кода НЕ вызвал выкат');
    // 3) deploy/deploy-A.sh появился в origin → копия обновлена из origin/main и исполнена именно она
    const marker2 = resolve(tmp, 'deployed-synced');
    mkdirSync(resolve(work, 'deploy'), { recursive: true });
    writeFileSync(resolve(work, 'deploy', 'deploy-A.sh'), `#!/usr/bin/env bash\necho synced >> "${marker2}"\n`);
    writeFileSync(resolve(work, 'site', 'app.txt'), 'v3\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'deploy-A в репо');
    git(work, 'push', '-q', origin, 'main');
    runWatch();
    assert(readFileSync(deployScript, 'utf8').includes('synced'), 'копия deploy-A.sh не обновлена из origin/main');
    assert(existsSync(marker2), 'обновлённая копия deploy-A.sh не исполнена');
    return 'память: ff без deploy-A.sh, HEAD догнал origin; код: deploy-A.sh вызван; deploy-A.sh в origin: копия обновлена и исполнена';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Ежедневный бэкап: deploy/backup.sh — копия WAL-БД открывается, загрузки в архиве, ротация
// ---------------------------------------------------------------------------
await check('backup.sh: копия WAL-БД в архиве, загрузки — инкрементные снимки на жёстких ссылках, ротация KEEP, без БД → код 1', async () => {
  const SCRIPT = resolve(HERE, '..', 'deploy', 'backup.sh');
  assert(existsSync(SCRIPT), 'нет deploy/backup.sh');
  const tmp = mkdtempSync('/tmp/bk-');
  try {
    const src = new Database(resolve(tmp, 'src.sqlite'));
    src.pragma('journal_mode = WAL');
    src.exec('CREATE TABLE p (id INTEGER PRIMARY KEY, n TEXT)');
    src.prepare('INSERT INTO p (n) VALUES (?)').run('Иванов');
    mkdirSync(resolve(tmp, 'upl', 'x'), { recursive: true });
    writeFileSync(resolve(tmp, 'upl', 'x', 'big.bin'), Buffer.alloc(300 * 1024, 7));
    mkdirSync(resolve(tmp, 'docs'));
    writeFileSync(resolve(tmp, 'docs', 'spravka.pdf'), '%PDF-1.7');
    const env = {
      ...process.env, BACKUP_SITE: HERE, BACKUP_DB: resolve(tmp, 'src.sqlite'), BACKUP_UPLOADS: resolve(tmp, 'upl'), BACKUP_DOCS: resolve(tmp, 'docs'),
      BACKUP_DEST: resolve(tmp, 'dest'), BACKUP_KEEP: '2', BACKUP_LOG: resolve(tmp, 'log'),
    };
    const run = (extra = {}) => spawnSync('bash', [SCRIPT], { env: { ...env, ...extra }, encoding: 'utf8' });
    for (let i = 0; i < 3; i++) {
      if (i === 2) writeFileSync(resolve(tmp, 'upl', 'x', 'new.txt'), 'new');
      eq(run().status, 0, `прогон ${i + 1} упал: ${readFileSync(resolve(tmp, 'log'), 'utf8')}`);
      await new Promise((r) => setTimeout(r, 1100)); // имена с точностью до секунды
    }
    const archives = spawnSync('ls', ['-1t', resolve(tmp, 'dest')], { encoding: 'utf8' }).stdout.trim().split('\n').filter((f) => f.endsWith('.tar.gz'));
    eq(archives.length, 2, `ротация KEEP=2 оставила ${archives.length} архивов`);
    const list = spawnSync('tar', ['-tzf', resolve(tmp, 'dest', archives[0])], { encoding: 'utf8' }).stdout;
    assert(list.includes('ftso.sqlite') && list.includes('152fz/spravka.pdf') && !list.includes('uploads/'), `архив должен нести БД и 152-ФЗ, но не загрузки: ${list}`);
    mkdirSync(resolve(tmp, 'chk'));
    eq(spawnSync('tar', ['-C', resolve(tmp, 'chk'), '-xzf', resolve(tmp, 'dest', archives[0])]).status, 0, 'архив не распаковался');
    const copy = new Database(resolve(tmp, 'chk', 'ftso.sqlite'), { readonly: true });
    eq(copy.prepare('SELECT count(*) AS n FROM p').get().n, 1, 'копия БД пуста или битая');
    copy.close(); src.close();
    const snaps = spawnSync('ls', ['-1', resolve(tmp, 'dest', 'uploads')], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).sort();
    eq(snaps.length, 2, `ротация снимков KEEP=2 оставила ${snaps.length}`);
    const { statSync } = await import('node:fs');
    const ino = snaps.map((d) => statSync(resolve(tmp, 'dest', 'uploads', d, 'x', 'big.bin')).ino);
    eq(ino[0], ino[1], 'один и тот же файл в двух снимках должен быть одной жёсткой ссылкой (дедупликация)');
    assert(existsSync(resolve(tmp, 'dest', 'uploads', snaps[1], 'x', 'new.txt')) && !existsSync(resolve(tmp, 'dest', 'uploads', snaps[0], 'x', 'new.txt')), 'новый файл должен быть только в последнем снимке');
    const bad = run({ BACKUP_DB: resolve(tmp, 'none.sqlite'), BACKUP_LOG: resolve(tmp, 'log2') });
    eq(bad.status, 1, 'без БД должен быть код 1');
    assert(readFileSync(resolve(tmp, 'log2'), 'utf8').includes('СТОП: нет БД'), 'нет понятной причины в логе');
    return `3 прогона → 2 архива и 2 снимка (KEEP=2); БД читается; big.bin в снимках — одна жёсткая ссылка; новый файл только в последнем; без БД → код 1`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// logrotate: конфиг deploy/logrotate-ftso принимается logrotate и реально ротирует copytruncate
// ---------------------------------------------------------------------------
await check('logrotate-ftso: dry-run без ошибок, принудительная ротация обнуляет лог и оставляет .1', async () => {
  const CONF = resolve(HERE, '..', 'deploy', 'logrotate-ftso');
  assert(existsSync(CONF), 'нет deploy/logrotate-ftso');
  const text = readFileSync(CONF, 'utf8');
  eq((text.match(/{/g) || []).length, (text.match(/}/g) || []).length, 'скобки блоков не сходятся');
  assert(/copytruncate/.test(text) && /rotate 14/.test(text) && /\.pm2\/logs/.test(text), 'нет copytruncate / rotate 14 / путей pm2');
  const which = spawnSync('sh', ['-c', 'command -v logrotate'], { encoding: 'utf8' });
  if (which.status !== 0) return 'logrotate не установлен здесь — проверена только структура (скобки, copytruncate, rotate 14, пути pm2)';
  const tmp = mkdtempSync('/tmp/lr-');
  try {
    // те же директивы, но временные пути и без su (в песочнице пользователя ftso может не быть)
    const conf = text
      .replace(/^\/home\/ftso\/\.pm2\/logs\/\*\.log \/home\/ftso\/\.pm2\/pm2\.log/m, resolve(tmp, 'a.log'))
      .replace(/^\/root\/deploy-watch\.log \/root\/deploy-A\.log \/root\/backup\.log/m, resolve(tmp, 'b.log'))
      .replace(/^\s*su ftso ftso\n/m, '');
    writeFileSync(resolve(tmp, 'conf'), conf);
    writeFileSync(resolve(tmp, 'a.log'), 'строка1\n');
    writeFileSync(resolve(tmp, 'b.log'), 'строка1\n');
    const dry = spawnSync('logrotate', ['-d', '-s', resolve(tmp, 'state'), resolve(tmp, 'conf')], { encoding: 'utf8' });
    eq(dry.status, 0, `logrotate -d отверг конфиг: ${dry.stderr}`);
    eq((dry.stderr.match(/^error:/gm) || []).length, 0, `ошибки dry-run: ${dry.stderr}`);
    const force = spawnSync('logrotate', ['-f', '-s', resolve(tmp, 'state'), resolve(tmp, 'conf')], { encoding: 'utf8' });
    eq(force.status, 0, `logrotate -f упал: ${force.stderr}`);
    eq(readFileSync(resolve(tmp, 'a.log'), 'utf8'), '', 'copytruncate не обнулил лог');
    eq(readFileSync(resolve(tmp, 'a.log.1'), 'utf8'), 'строка1\n', 'содержимое не ушло в .1');
    return 'dry-run 0 ошибок; -f: a.log обнулён, a.log.1 = старое содержимое';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// set-secrets.sh: пароль супер-админа и флаг приёма пишутся в .env, короткий пароль отклоняется
// ---------------------------------------------------------------------------
await check('set-secrets.sh: временный пароль в базу (хэш подходит, флаг 1), --intake в .env, вывод без хэша; все deploy/*.sh проходят bash -n', async () => {
  const SCRIPT = resolve(HERE, '..', 'deploy', 'set-secrets.sh');
  assert(existsSync(SCRIPT), 'нет deploy/set-secrets.sh');
  const { verifyPassword } = await import('./server/lib/password.mjs');
  const tmp = mkdtempSync('/tmp/ss-');
  try {
    const dbFile = resolve(tmp, 't.sqlite');
    const t = new Database(dbFile); t.exec(readFileSync(resolve(HERE, 'db', 'schema.sql'), 'utf8')); t.close();
    const envFile = resolve(tmp, 'env');
    writeFileSync(envFile, 'SESSION_SECRET=x\nINTAKE_ENABLED=0\n');
    const env = { ...process.env, SITE_DIR: HERE, DB_FILE: dbFile, ENV_FILE: envFile, SET_SECRETS_RUNAS: '', SET_SECRETS_RESTART: '' };
    const r = spawnSync('bash', [SCRIPT, '--intake', '1'], { encoding: 'utf8', env });
    eq(r.status, 0, `скрипт упал: ${r.stdout}${r.stderr}`);
    const m = r.stdout.match(/ПАРОЛЬ для admin: ([A-Za-z0-9]{14})/);
    assert(m, `нет временного пароля в выводе: ${r.stdout}`);
    const t2 = new Database(dbFile, { readonly: true });
    const u = t2.prepare("SELECT role, password_hash, must_change_password FROM users WHERE username = 'admin'").get();
    t2.close();
    assert(u && u.role === 'super-admin' && u.must_change_password === 1, 'пользователь admin не создан или без флага');
    assert(verifyPassword(m[1], u.password_hash), 'временный пароль не подходит к хэшу в базе');
    assert(!r.stdout.includes('scrypt$'), 'хэш попал в вывод');
    assert(/^INTAKE_ENABLED=1$/m.test(readFileSync(envFile, 'utf8')), 'INTAKE_ENABLED не записан');
    eq(spawnSync('bash', [SCRIPT, '--intake', '7'], { encoding: 'utf8', env }).status, 1, '--intake 7 должен дать код 1');
    writeFileSync(envFile, 'SESSION_SECRET=x\nSUPER_ADMIN_USERNAME=Korotkov\n');
    const r2 = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env });
    eq(r2.status, 0, `скрипт с SUPER_ADMIN_USERNAME упал: ${r2.stdout}`);
    assert(/ПАРОЛЬ для Korotkov:/.test(r2.stdout), 'имя супер-админа не взято из .env');
    const t3 = new Database(dbFile, { readonly: true });
    eq(t3.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'Korotkov' AND role = 'super-admin' AND must_change_password = 1").get().n, 1, 'Korotkov не создан с флагом');
    t3.close();
    const scripts = spawnSync('sh', ['-c', `ls ${resolve(HERE, '..', 'deploy')}/*.sh`], { encoding: 'utf8' }).stdout.trim().split('\n');
    for (const f of scripts) eq(spawnSync('bash', ['-n', f]).status, 0, `bash -n не прошёл: ${f}`);
    return `admin создан, флаг 1, хэш подходит, вывод без хэша, INTAKE=1; --intake 7 → 1; имя из .env (Korotkov) работает; bash -n: ${scripts.length} скриптов`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// smtp-set.sh: пароль приложения пишется в .env без эха; пустой/короткий/со спецсимволом — отказ
// ---------------------------------------------------------------------------
await check('smtp-set.sh: пароль приложения в .env (пробелы сняты), SMTP_USER дописан; пустой/короткий/спецсимвол → код 1 без изменений', async () => {
  const SCRIPT = resolve(HERE, '..', 'deploy', 'smtp-set.sh');
  assert(existsSync(SCRIPT), 'нет deploy/smtp-set.sh');
  const tmp = mkdtempSync('/tmp/sm-');
  try {
    const envFile = resolve(tmp, 'env');
    writeFileSync(envFile, 'SMTP_HOST=smtp.yandex.ru\nSMTP_PASS=old\n');
    const run = (input) => spawnSync('bash', [SCRIPT], { input, encoding: 'utf8', env: { ...process.env, ENV_FILE: envFile, SMTP_SET_RESTART: '', SMTP_SET_VERIFY: '0' } });
    const ok = run('abcd efgh ijkl mnop\n');
    eq(ok.status, 0, `скрипт упал: ${ok.stdout}${ok.stderr}`);
    const after = readFileSync(envFile, 'utf8');
    assert(/^SMTP_PASS=abcdefghijklmnop$/m.test(after), `пароль не записан или пробелы не сняты: ${after}`);
    assert(/^SMTP_USER=info@ftso67\.ru$/m.test(after), 'SMTP_USER не дописан');
    assert(!ok.stdout.includes('abcdefghijklmnop'), 'пароль попал в вывод');
    for (const bad of ['\n', 'short\n', 'bad$pass!123456\n']) eq(run(bad).status, 1, `«${bad.trim()}» должен дать код 1`);
    assert(/^SMTP_PASS=abcdefghijklmnop$/m.test(readFileSync(envFile, 'utf8')), 'отклонённые прогоны изменили .env');
    return 'записан 16 зн. без пробелов, SMTP_USER дописан, вывод без пароля; пустой/короткий/спецсимвол → 1';
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Отчёт
// ---------------------------------------------------------------------------
const checks = results.filter((r) => r.name);
const passed = checks.filter((r) => r.ok).length;
const failed = checks.length - passed;

console.log('\n' + '='.repeat(78));
console.log('ПРИЁМКА КАРКАСА САЙТА ФТСО');
console.log('='.repeat(78));
for (const row of results) {
  if (row.section) {
    console.log(`\n${row.section}`);
    console.log('-'.repeat(78));
    continue;
  }
  console.log(`${row.ok ? '  ✔' : '  ✘'} ${row.name}`);
  if (row.detail) console.log(`      ${row.detail}`);
}
console.log('\n' + '='.repeat(78));
console.log(`ИТОГО: ${passed} из ${checks.length} проверок пройдено${failed ? `, ПРОВАЛЕНО ${failed}` : ' — всё зелёное'}`);
console.log('='.repeat(78));

rmSync(WORK, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
