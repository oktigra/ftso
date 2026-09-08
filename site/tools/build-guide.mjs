/**
 * Сборка инструкции в Word из командной строки.
 * Текст и вёрстка — в server/lib/guide-docx.mjs (тот же модуль использует кнопка
 * «Скачать в Word» на /admin/guide, чтобы файл и страница не расходились).
 *
 * Запуск:  node tools/build-guide.mjs [путь.docx]
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGuideDocx } from '../server/lib/guide-docx.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || resolve(ROOT, 'ftso-instrukciya.docx');
const { buf, headings, items } = await buildGuideDocx();
writeFileSync(out, buf);
console.log(`${out}: разделов ${headings}, пунктов ${items}, ${buf.length} байт`);
