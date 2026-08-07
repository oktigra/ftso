// САМОХОСТ ШРИФТОВ. В дизайне Manrope/Inter грузятся с Google Fonts — на проде
// внешних вызовов быть не должно (замок чистой передачи + доставляемость в РФ).
// Скрипт разово скачивает woff2 в public/fonts и генерирует public/css/fonts.css
// с локальными @font-face и font-display: swap.
//
// Запуск: npm run fonts   (файлы шрифтов коммитятся, рантайм ничего не тянет)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = resolve(ROOT, 'public/fonts');
const CSS_OUT = resolve(ROOT, 'public/css/fonts.css');

// UA современного браузера — иначе Google отдаёт ttf вместо woff2.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FAMILIES = [
  { name: 'Manrope', weights: [500, 600, 700, 800] },
  { name: 'Inter', weights: [400, 500, 600, 700] },
];

// Кириллица обязательна, латиница — для цифр/латинских вкраплений.
const KEEP_SUBSETS = new Set(['cyrillic', 'cyrillic-ext', 'latin', 'latin-ext']);

async function fetchCss(family, weights) {
  const url =
    'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(family) +
    ':wght@' +
    weights.join(';') +
    '&display=swap';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${family}: HTTP ${res.status}`);
  return res.text();
}

/** Google ставит перед каждым @font-face комментарий с именем сабсета. */
function parseFaces(css) {
  const faces = [];
  const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const [, subset, body] = m;
    const pick = (prop) => {
      const hit = new RegExp(`${prop}:\\s*([^;]+);`).exec(body);
      return hit ? hit[1].trim() : null;
    };
    const src = pick('src');
    const urlHit = src && /url\((https:[^)]+\.woff2)\)/.exec(src);
    if (!urlHit) continue;
    faces.push({
      subset,
      family: (pick('font-family') || '').replace(/['"]/g, ''),
      style: pick('font-style') || 'normal',
      weight: pick('font-weight') || '400',
      unicodeRange: pick('unicode-range'),
      url: urlHit[1],
    });
  }
  return faces;
}

async function main() {
  mkdirSync(FONT_DIR, { recursive: true });
  mkdirSync(dirname(CSS_OUT), { recursive: true });

  const blocks = [
    '/* Локальные шрифты. Сгенерировано tools/fetch-fonts.mjs — не править руками.',
    '   Внешних вызовов к fonts.googleapis.com / fonts.gstatic.com в рантайме НЕТ. */',
    '',
  ];
  let saved = 0;

  for (const { name, weights } of FAMILIES) {
    const faces = parseFaces(await fetchCss(name, weights));
    for (const face of faces) {
      if (!KEEP_SUBSETS.has(face.subset)) continue;
      const file = `${name.toLowerCase()}-${face.weight}-${face.subset}.woff2`;
      const bin = await fetch(face.url, { headers: { 'User-Agent': UA } });
      if (!bin.ok) throw new Error(`${file}: HTTP ${bin.status}`);
      writeFileSync(resolve(FONT_DIR, file), Buffer.from(await bin.arrayBuffer()));
      saved += 1;
      blocks.push(
        '@font-face{',
        `  font-family:'${face.family}';`,
        `  font-style:${face.style};`,
        `  font-weight:${face.weight};`,
        // swap — иначе невидимый текст при медленной загрузке
        '  font-display:swap;',
        `  src:url('/static/fonts/${file}') format('woff2');`,
        face.unicodeRange ? `  unicode-range:${face.unicodeRange};` : '',
        '}',
        '',
      );
    }
  }

  writeFileSync(CSS_OUT, blocks.filter((l) => l !== '').join('\n') + '\n', 'utf8');
  console.log(`[fonts] сохранено файлов: ${saved}; сгенерирован ${CSS_OUT}`);
}

main().catch((err) => {
  console.error('[fonts] не удалось:', err.message);
  process.exit(1);
});
