// ПРИЁМКА по ТЗ. Один прогон: npm run accept
//
// Скрипт самодостаточен — поднимает ИЗОЛИРОВАННУЮ базу во временном каталоге,
// применяет миграцию, засевает данные, стартует приложение на случайном порту
// и проверяет каждый пункт раздела «Приёмка» ТЗ. Браузерные пункты (тема при
// включённом CSP, localStorage, адаптив, экранирование XSS, локальные шрифты)
// проверяются реальным Chromium через Playwright.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
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
  return async function req(path, { method = 'GET', form, jar, headers = {}, redirect = 'manual' } = {}) {
    const h = { ...headers };
    if (jar) h.cookie = jar.header();
    let body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
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

await check('заглушки разделов: HTTP 200 и корректный <title>', async () => {
  const paths = ['/federation', '/news', '/tournaments', '/coaches', '/courts', '/clubs', '/referees', '/gallery', '/documents', '/contacts'];
  const seen = [];
  for (const p of paths) {
    const r = await http(p);
    eq(r.status, 200, `GET ${p}`);
    const t = /<title>([^<]+)<\/title>/.exec(r.text);
    assert(t && t[1].trim().length > 0, `${p}: пустой <title>`);
    assert(r.text.includes('Раздел в разработке'), `${p}: нет пометки о разработке`);
    seen.push(`${p} «${t[1]}»`);
  }
  return `${paths.length} разделов, все 200 с title`;
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
    form: { _csrf: _pCsrf, full_name: 'Изменённый Игрок', city: 'Десногорск', sex: 'F', age_group: '35-44' },
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

await check('аплоада файлов в каркасе НЕТ', async () => {
  const pkg = JSON.parse(readFileSync(resolve(HERE, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const bad of ['multer', 'formidable', 'busboy', 'express-fileupload']) {
    assert(!deps[bad], `в зависимостях есть загрузчик файлов: ${bad}`);
  }
  const grep = spawnSync('grep', ['-rniE', 'multipart|multer|formidable|busboy|req\\.files', 'server', 'views', 'db'], {
    cwd: HERE,
    encoding: 'utf8',
  });
  assert(!grep.stdout.trim(), `найдены следы загрузки файлов:\n${grep.stdout}`);
  return 'ни зависимостей, ни маршрутов загрузки';
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
const rowNames = (html) =>
  [...html.matchAll(/<td class="player[^"]*">([^<]*)<\/td>/g)].map((m) => m[1]);

await check('регистрация пишет ДВЕ раздельные записи с одной редакцией', async () => {
  const id = Number(
    db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Тест Согласиев','Смоленск','M','19-34')").run()
      .lastInsertRowid,
  );
  journal.recordRegistrationConsents(db, { playerId: id, distribution: true, source: 'web', ip: '203.0.113.9' });
  const rows = db.prepare('SELECT kind, event, legal_version FROM consents WHERE player_id = ? ORDER BY id').all(id);
  eq(rows.length, 2, 'записей согласия');
  eq(rows[0].kind, 'processing', 'первая запись — обработка');
  eq(rows[1].kind, 'distribution', 'вторая запись — распространение');
  assert(rows.every((r) => r.event === 'granted'), 'обе записи должны быть выдачей');
  eq(rows[0].legal_version, rows[1].legal_version, 'редакция у обеих записей');
  eq(rows[0].legal_version, LEGAL_VERSION, 'редакция = текущая константа');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(id).is_public, 1, 'флаг публикуемости');

  // Отказ от публикации: обработка есть, распространения нет, игрок скрыт.
  const id2 = Number(
    db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Тест Скрытный','Вязьма','F','19-34')").run()
      .lastInsertRowid,
  );
  journal.recordRegistrationConsents(db, { playerId: id2, distribution: false, source: 'web', ip: '203.0.113.9' });
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(id2).n, 1, 'только обработка');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(id2).is_public, 0, 'без согласия — не публикуется');

  db.prepare('DELETE FROM players WHERE id IN (?, ?)').run(id, id2);
  return `две записи, редакция ${LEGAL_VERSION} у обеих; отказ от публикации оставляет только обработку`;
});

await check('отзыв распространения скрывает игрока, СОХРАНЯЯ место', async () => {
  const before = rowNames((await http('/rating')).text);
  const target = before.find((n) => n === 'Сергей Новиков');
  assert(target, 'в таблице нет ожидаемого игрока');
  const idx = before.indexOf(target);
  const player = db.prepare('SELECT id FROM players WHERE full_name = ?').get(target);

  journal.setDistributionConsent(db, player.id, false, { source: 'web', ip: '203.0.113.9' });
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(player.id).is_public, 0, 'флаг снят отзывом');

  const after = rowNames((await http('/rating')).text);
  eq(after.length, before.length, 'число строк не изменилось');
  eq(after[idx], 'Скрыто по заявлению', 'строка обезличена на своём месте');
  for (let i = 0; i < before.length; i++) {
    if (i !== idx) eq(after[i], before[i], `строка ${i + 1} не должна была измениться`);
  }

  // Через поиск и через CSV настоящая фамилия тоже не достаётся.
  // Сверяем СТРОКИ ТАБЛИЦЫ, а не весь HTML: страница честно возвращает запрос
  // в поле поиска, и «Новиков» в разметке — это эхо ввода, а не данные игрока.
  const search = await http(`/rating?q=${encodeURIComponent('Новиков')}`);
  eq(rowNames(search.text).length, 0, 'скрытый игрок находится поиском по фамилии');
  const csv = await http('/rating.csv');
  assert(!csv.text.includes('Новиков'), 'скрытый игрок утекает в CSV');
  assert(csv.text.includes('Скрыто по заявлению'), 'в CSV нет обезличенной строки');

  // Движок продолжает считать по РЕАЛЬНЫМ данным — обезличивание только на выдаче.
  const direct = computeStandings(collectEngineInput(db));
  assert(
    direct.players.some((p) => p.playerName === target),
    'движок не должен видеть обезличивание',
  );

  journal.setDistributionConsent(db, player.id, true, { source: 'offline' });
  const restored = rowNames((await http('/rating')).text);
  eq(restored[idx], target, 'после возврата согласия имя вернулось на своё место');
  return `${target}: отзыв -> «Скрыто по заявлению» на месте ${idx + 1}, места соперников не поехали; движок видит реальные данные`;
});

await check('удалённый игрок в старом снимке -> «Игрок удалён»', async () => {
  const id = Number(
    db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Тест Удалённый','Ярцево','M','19-34')").run()
      .lastInsertRowid,
  );
  journal.recordRegistrationConsents(db, { playerId: id, distribution: true, source: 'offline' });
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

  db.prepare('DELETE FROM tournaments WHERE id = ?').run(t);
  recompute(db, { staleLockMinutes: 5, keepSnapshots: 24 });
  return `удалённый игрок показан как «Игрок удалён»; ${wiped} записи согласий стёрты (ст. 21)`;
});

await check('автоочистка чистит отозванные, действующие не трогает', async () => {
  const id = Number(
    db.prepare("INSERT INTO players (full_name, city, sex, age_group) VALUES ('Тест Ретеншен','Сафоново','M','19-34')").run()
      .lastInsertRowid,
  );
  journal.recordRegistrationConsents(db, { playerId: id, distribution: true, source: 'offline' });
  journal.setDistributionConsent(db, id, false, { source: 'web', ip: '203.0.113.9' });
  eq(db.prepare('SELECT COUNT(*) AS n FROM consents WHERE player_id = ?').get(id).n, 3, 'записей до очистки');

  eq(journal.purgeExpired(db, 1095), 0, 'свежий отзыв чистить рано');
  db.prepare("UPDATE consents SET at = datetime('now','-1200 days') WHERE player_id = ?").run(id);
  const removed = journal.purgeExpired(db, 1095);
  eq(removed, 2, 'удаляется пара «выдано + отозвано» по распространению');
  const left = db.prepare('SELECT kind, event FROM consents WHERE player_id = ?').all(id);
  eq(left.length, 1, 'осталась одна запись');
  eq(left[0].kind, 'processing', 'действующее согласие на обработку не тронуто');

  db.prepare('DELETE FROM players WHERE id = ?').run(id);
  return 'отозванное старше срока удалено (2 записи), действующее согласие на обработку осталось';
});

await check('публикация из админки идёт ЧЕРЕЗ журнал, а не мимо', async () => {
  const { jar } = await login(ADMIN.user, ADMIN.pass);
  const page = await http('/admin/players', { jar });
  const _csrf = tokenFrom(page.text);
  const r = await http('/admin/players', {
    method: 'POST',
    form: { _csrf, full_name: 'Тест Секретарёв', city: 'Смоленск', sex: 'M', age_group: '19-34', is_public: '1' },
    jar,
  });
  eq(r.status, 302, 'создание игрока');
  const created = db.prepare('SELECT id, is_public FROM players WHERE full_name = ?').get('Тест Секретарёв');
  eq(created.is_public, 1, 'флаг публикуемости выставлен');
  const rows = db.prepare('SELECT kind, event, source, ip FROM consents WHERE player_id = ?').all(created.id);
  eq(rows.length, 1, 'ровно одна запись — о распространении');
  eq(rows[0].kind, 'distribution', 'вид записи');
  eq(rows[0].event, 'granted', 'событие');
  eq(rows[0].source, 'offline', 'источник — бумажное согласие');
  eq(rows[0].ip, null, 'для офлайн-согласия IP не пишется');

  // Снятие отметки = ОТЗЫВ, тоже событием.
  const upd = await http(`/admin/players/${created.id}/update`, {
    method: 'POST',
    form: { _csrf, full_name: 'Тест Секретарёв', city: 'Смоленск', sex: 'M', age_group: '19-34', is_public: '0' },
    jar,
  });
  eq(upd.status, 302, 'обновление игрока');
  eq(db.prepare('SELECT is_public FROM players WHERE id = ?').get(created.id).is_public, 0, 'флаг снят');
  const last = db.prepare('SELECT event FROM consents WHERE player_id = ? ORDER BY id DESC LIMIT 1').get(created.id);
  eq(last.event, 'revoked', 'снятие отметки записано отзывом');

  journal.eraseConsents(db, created.id);
  db.prepare('DELETE FROM players WHERE id = ?').run(created.id);
  return 'отметка секретаря пишется событием journal (source=offline, без IP); снятие = отзыв';
});

// ===========================================================================
section('12. Браузер: тема, CSP, адаптив, шрифты, XSS');

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

  await check('портальные кнопки — заглушки, ЛК/заявок/оплаты в сборке нет', async () => {
    const page = await browser.newPage();
    await page.goto(inst.base + '/', { waitUntil: 'domcontentloaded' });
    const portal = await page.evaluate(() => {
      const names = ['Регистрация', 'Создать личный кабинет', 'Регистрация игрока', 'Провести турнир', 'Личный кабинет', 'Заявка на турнир', 'Секретарям турниров'];
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

    assert(portal.length >= 6, `портальных ссылок найдено ${portal.length}, ожидалось не меньше 6`);
    for (const p of portal) eq(p.href, '#', `«${p.t}» должна оставаться заглушкой`);
    for (const l of legal) assert(l.href.startsWith('/'), `правовая ссылка «${l.t}» должна вести на реальную страницу, а не «${l.href}»`);
    for (const l of legal) {
      const r = await http(l.href);
      eq(r.status, 200, `правовая страница ${l.href}`);
    }
    return `${portal.length} портальных ссылок = «#»; правовые ведут на ${legal.map((l) => l.href).join(', ')} (обе 200)`;
  });

  await browser.close();
} catch (err) {
  browserNote = err.message;
  results.push({ group: '11. Браузер', name: 'запуск Chromium', ok: false, detail: err.message });
}

// ===========================================================================
await stopApp(inst);
closeDb();

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
