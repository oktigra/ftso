// OPEN — БАЗА ШАГА 0 ДЛЯ ФТСО. Одна команда, все числа: из клона и с боя.
//
// Зачем: память чата базой не является. Индекс, редакция, состояние приёма —
// всё это печатает ЭТОТ файл, а не вспоминает чат. Нет числа здесь — его нет.
//
// Запуск из каталога site:   node OPEN.mjs            (без приёмки, ~2 с)
//                            node OPEN.mjs --accept   (плюс acceptance.mjs, ~2 мин)
//
// Сторож закрыт по умолчанию: то, что не удалось замерить, печатается как
// «НЕ ЗАМЕРЕНО» и даёт код выхода 1. Зелёный вывод при сломанном замере —
// ложь, которую этот файл печатать не имеет права.
import { execFileSync, spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SITE_URL = 'https://ftso67.ru';
const WITH_ACCEPT = process.argv.includes('--accept');

let failed = 0;
const say = (k, v) => console.log(`${k.padEnd(28)} ${v}`);
const miss = (k, why) => { failed += 1; say(k, `НЕ ЗАМЕРЕНО — ${why}`); };

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

async function page(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(SITE_URL + path, { signal: ctl.signal, redirect: 'follow' });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, text: '', err: e.name === 'AbortError' ? 'таймаут 15 с' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

console.log(`OPEN ФТСО · ${hostname()} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
console.log('— клон —');

const head = git('rev-parse', '--short=7', 'HEAD');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (head) say('HEAD', `${head} (${branch})`); else miss('HEAD', 'git недоступен');

const dirty = git('status', '--porcelain', '-uno');
if (dirty === null) miss('дерево', 'git status упал');
else say('дерево', dirty ? `ГРЯЗНОЕ: ${dirty.split('\n').length} изменённых отслеживаемых` : 'чистое (отслеживаемые)');

const remote = git('ls-remote', 'origin', 'refs/heads/main');
const remoteSha = remote ? remote.slice(0, 7) : null;
if (remoteSha) say('origin/main на GitHub', `${remoteSha}${head === remoteSha ? ' = HEAD' : ' ≠ HEAD'}`);
else miss('origin/main на GitHub', 'ls-remote не ответил (сеть?)');

let legal = null;
try {
  legal = await import('./server/lib/legal.mjs');
  say('LEGAL_VERSION', `${legal.LEGAL_VERSION} · ${legal.LEGAL_VERSION_LABEL}`);
  say('OPERATOR.address', legal.OPERATOR.address);
  say('OPERATOR ИНН/ОГРН', `${legal.OPERATOR.inn} / ${legal.OPERATOR.ogrn}`);
} catch (e) {
  miss('legal.mjs', e.message);
}

console.log('— бой —');

const priv = await page('/privacy');
if (priv.status !== 200) miss('/privacy', priv.err || `HTTP ${priv.status}`);
else {
  const labels = [...new Set(priv.text.match(/Редакция от \d{2}\.\d{2}\.\d{4}/g) || [])];
  const live = labels[0] || null;
  if (!live) miss('/privacy редакция', 'подпись «Редакция от …» на странице не найдена');
  else {
    const same = legal && live === legal.LEGAL_VERSION_LABEL;
    say('/privacy редакция', `${live}${legal ? (same ? ' = клон' : ` ≠ клон (${legal.LEGAL_VERSION_LABEL})`) : ''}`);
    if (labels.length > 1) say('/privacy подписей', `${labels.length} РАЗНЫХ: ${labels.join(' | ')}`);
  }
}

const reg = await page('/register');
if (reg.status !== 200) miss('/register', reg.err || `HTTP ${reg.status}`);
else if (/Приём заявок временно закрыт/.test(reg.text)) say('/register приём', 'ЗАКРЫТ (INTAKE_ENABLED=0)');
else if (/consent_processing/.test(reg.text)) say('/register приём', 'ОТКРЫТ — форма с согласиями на месте');
else miss('/register приём', 'ни баннера «закрыт», ни формы — страница не распознана');

const rating = await page('/rating');
if (rating.status !== 200) miss('/rating', rating.err || `HTTP ${rating.status}`);
else say('/rating строк таблицы', String((rating.text.match(/<tr\b/g) || []).length));

console.log('— приёмка —');
if (!WITH_ACCEPT) say('acceptance.mjs', 'не запускалась (добавь --accept, ~2 мин)');
else {
  const r = spawnSync(process.execPath, ['acceptance.mjs'], { cwd: HERE, encoding: 'utf8' });
  const total = (r.stdout.match(/ИТОГО:[^\n]*/g) || []).pop();
  if (!total) miss('acceptance.mjs', `строки ИТОГО нет, код ${r.status}; хвост: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  else say('acceptance.mjs', `${total}${r.status === 0 ? '' : ` (код выхода ${r.status})`}`);
  if (r.status !== 0) failed += 1;
}

console.log(failed ? `ИТОГ: ${failed} не замерено — база НЕ снята` : 'ИТОГ: база снята полностью');
process.exit(failed ? 1 : 0);
