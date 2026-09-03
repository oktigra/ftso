#!/usr/bin/env node
// РИТУАЛ ЗАКРЫТИЯ СЕССИИ ФТСО ОДНОЙ КОМАНДОЙ — по трафарету WGR (close.sh +
// ritual_pipeline.sh), но без машины с кредами: память ФТСО живёт в этом же
// репозитории, поэтому чат закрывает сессию сам, write-токеном из входного пакета.
//
// ПАЧКА (кладётся в ritual/ до запуска):
//   ritual/SESSION_<ГГГГ-ММ-ДД>-<N>.md   снимок сессии: что сделано (числа), что
//                                        осталось, слепые места, где память
//   ritual/NEXT_START_BLOCK.md           блок входа следующей сессии; первая строка —
//                                        «## ⚡ ВХОД СЛЕДУЮЩЕЙ СЕССИИ — START<N>_V1»
//
// ЧТО ДЕЛАЕТ: проверяет пачку и чистоту клона → вычитывает пачку на секреты и ПДн
// (репозиторий публичный) → ветка ritual/<N> → снимок в sessions/, блок в
// NEXT_CHAT_START.md после маркера RITUAL:BLOCKS (держатся два последних) →
// коммит → ЗАМОК: в диффе только sessions/, ritual/, NEXT_CHAT_START.md, иначе стоп
// → push → PR → merge → печатает URL, sha мержа и md5 снимка из коммита.
//
// ЧЕГО НЕ ДЕЛАЕТ: не трогает site/, rating/, deploy/, BACKLOG.md, COMPLIANCE.md.
// Код на бой этим путём не проходит по устройству, а не по внимательности.
//
// ИСПОЛЬЗОВАНИЕ:  GH_TOKEN=… node tools/ritual.mjs <N> "сообщение коммита"
// ПРОГОН БЕЗ СЕТИ: NOPUSH=1 node tools/ritual.mjs <N> "тест"   (ветка остаётся локально)
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'oktigra/ftso';
const ALLOWED = /^(sessions\/|ritual\/|NEXT_CHAT_START\.md$)/;
const MARKER = '<!-- RITUAL:BLOCKS';
const KEEP_BLOCKS = 2;

const [N, MSG] = process.argv.slice(2);
const NOPUSH = process.env.NOPUSH === '1';
const TOKEN = process.env.GH_TOKEN || '';
const die = (m) => { console.error(`СТОП: ${m}`); process.exit(2); };
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
const md5 = (s) => createHash('md5').update(s).digest('hex').slice(0, 8);

if (!/^\d+$/.test(N || '') || !MSG) die('использование: node tools/ritual.mjs <N> "сообщение"');
if (!NOPUSH && !TOKEN) die('нет GH_TOKEN в окружении (NOPUSH=1 для прогона без сети)');

// 1. КЛОН: main, чисто, равен origin/main.
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') die('ритуал идёт с ветки main');
if (git('status', '--porcelain', '--untracked-files=no')) die('дерево не чистое — сначала PR с кодом, ритуал потом');
if (!NOPUSH) {
  git('fetch', '-q', 'origin', 'main');
  if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) die('main отстал от origin/main — git pull');
}

// 2. ПАЧКА: ровно один снимок с этим N, блок входа, N не занят.
const packDir = resolve(ROOT, 'ritual');
if (!existsSync(packDir)) die('нет каталога ritual/');
const snaps = readdirSync(packDir).filter((f) => new RegExp(`^SESSION_\\d{4}-\\d{2}-\\d{2}-${N}\\.md$`).test(f));
if (snaps.length !== 1) die(`в ritual/ должен быть ровно один SESSION_ГГГГ-ММ-ДД-${N}.md, найдено ${snaps.length}`);
const snapName = snaps[0];
const blockPath = resolve(packDir, 'NEXT_START_BLOCK.md');
if (!existsSync(blockPath)) die('нет ritual/NEXT_START_BLOCK.md');
const sessDir = resolve(ROOT, 'sessions');
if (existsSync(sessDir) && readdirSync(sessDir).some((f) => f.endsWith(`-${N}.md`))) die(`сессия ${N} уже закрыта в sessions/`);
const snap = readFileSync(resolve(packDir, snapName), 'utf8');
const block = readFileSync(blockPath, 'utf8');
const head = `## ⚡ ВХОД СЛЕДУЮЩЕЙ СЕССИИ — START${N}_V1`;
if (!block.startsWith(head)) die(`блок входа должен начинаться строкой «${head}»`);
if (snap.length < 300) die('снимок короче 300 знаков — это не снимок');

// 3. СЕКРЕТЫ И ПДн: репозиторий публичный.
const bad = [
  [/github_pat_[A-Za-z0-9_]+|ghp_[A-Za-z0-9]{20,}/, 'токен GitHub'],
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/, 'адрес почты'],
  [/(SESSION_SECRET|PASSWORD|SMTP_PASS)\s*=\s*\S+/i, 'пароль или секрет из .env'],
  [/\b\+?\d[\d\s()-]{9,}\d\b/, 'похоже на телефон'],
  [/\b\d{4}-\d{2}-\d{2}\b.*дата рождения|дата рождения.*\b\d{4}-\d{2}-\d{2}\b/i, 'дата рождения'],
];
for (const [name, text] of [[snapName, snap], ['NEXT_START_BLOCK.md', block]]) {
  for (const [re, what] of bad) {
    const m = text.match(re);
    if (m) die(`${name}: ${what} — «${m[0].slice(0, 40)}»`);
  }
}

// 4. ВЕТКА И ПЕРЕНОС.
const branch = `ritual/${N}`;
git('checkout', '-q', '-b', branch);
if (!existsSync(sessDir)) execFileSync('mkdir', ['-p', sessDir]);
renameSync(resolve(packDir, snapName), resolve(sessDir, snapName));
const startPath = resolve(ROOT, 'NEXT_CHAT_START.md');
const start = readFileSync(startPath, 'utf8');
const at = start.indexOf(MARKER);
if (at < 0) die('в NEXT_CHAT_START.md нет маркера RITUAL:BLOCKS');
const lineEnd = start.indexOf('\n', at) + 1;
const before = start.slice(0, lineEnd);
const after = start.slice(lineEnd);
const blocks = after.split(/(?=^## ⚡ ВХОД СЛЕДУЮЩЕЙ СЕССИИ — START)/m).filter((b) => b.trim());
const kept = [block.trimEnd() + '\n', ...blocks].slice(0, KEEP_BLOCKS);
writeFileSync(startPath, before + '\n' + kept.join('\n'));
unlinkSync(blockPath);
if (!existsSync(resolve(packDir, '.gitkeep'))) writeFileSync(resolve(packDir, '.gitkeep'), '');

// 5. КОММИТ И ЗАМОК.
git('add', '-A', 'sessions', 'ritual', 'NEXT_CHAT_START.md');
git('-c', 'user.name=Claude (чат)', '-c', 'user.email=claude@ftso67.ru', 'commit', '-q', '-m', `ритуал ${N}: ${MSG}`);
const touched = git('diff', '--name-only', 'main..HEAD').split('\n').filter(Boolean);
const outside = touched.filter((f) => !ALLOWED.test(f));
if (outside.length) {
  git('checkout', '-q', 'main');
  git('branch', '-D', branch);
  die(`в диффе ритуала чужие файлы: ${outside.join(', ')} — ритуал откачен, ветки нет`);
}
const sha = git('rev-parse', '--short=7', 'HEAD');
const committedMd5 = md5(git('show', `HEAD:sessions/${snapName}`));
console.log(`ритуал ${N}: коммит ${sha}, ${touched.length} файла(ов): ${touched.join(', ')}`);
console.log(`md5 снимка в коммите: ${committedMd5}`);
if (NOPUSH) { console.log(`NOPUSH=1: ветка ${branch} осталась локально, main не тронут`); process.exit(0); }

// 6. PUSH → PR → MERGE.
git('push', '-q', '-u', 'origin', branch);
const api = async (path, method, body) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) die(`GitHub ${method} ${path}: ${r.status} ${j.message || ''}`);
  return j;
};
const pr = await api('/pulls', 'POST', { title: `ритуал ${N}: ${MSG}`, head: branch, base: 'main', body: `Снимок \`sessions/${snapName}\` (md5 ${committedMd5}), блок входа START${N}. Только память: ${touched.join(', ')}.` });
const merged = await api(`/pulls/${pr.number}/merge`, 'PUT', { merge_method: 'merge', sha: git('rev-parse', 'HEAD'), commit_title: `Merge pull request #${pr.number} — ритуал ${N}` });
git('checkout', '-q', 'main');
git('pull', '-q', 'origin', 'main');
console.log(`PR #${pr.number} ${pr.html_url} → merged=${merged.merged} ${String(merged.sha).slice(0, 7)}; main = ${git('rev-parse', '--short=7', 'HEAD')}`);
