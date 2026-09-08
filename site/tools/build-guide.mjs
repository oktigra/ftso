/**
 * СБОРКА ИНСТРУКЦИИ В WORD (ТЗ п. 11, «руководство администратора» к акту).
 *
 * Единственный источник текста — views/admin/guide.ejs: инструкция в админке и
 * документ для заказчика не должны расходиться. Здесь шаблон рендерится с полным
 * набором прав (супер-администратор видит все двенадцать разделов), из HTML
 * достаётся только содержимое инструкции и раскладывается в .docx.
 *
 * Запуск:  node tools/build-guide.mjs            → /home/.../ftso-instrukciya.docx
 *          node tools/build-guide.mjs путь.docx  → в указанный файл
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || resolve(ROOT, 'ftso-instrukciya.docx');

// Шаблон подключает head/header/footer и обращается к десяткам локалей вёрстки.
// Нам нужен только текст инструкции, поэтому include-и подменяются заглушками,
// а недостающие переменные — пустыми значениями.
const guideSrc = readFileSync(resolve(ROOT, 'views/admin/guide.ejs'), 'utf8')
  .replace(/<%-\s*include\([^)]*\)\s*%>/g, '');

const SECTIONS = ['players', 'registrations', 'tournaments', 'rating', 'news', 'directories', 'library', 'feedback'];
const html = ejs.render(guideSrc, {
  user: { role: 'super-admin' },
  sections: SECTIONS,
  csrfToken: '',
  flash: null,
});

// Из HTML в плоский список: заголовки h1/h2 и пункты li. Разметка внутри пунктов
// (<strong>, <code>) снимается — в документе она не нужна, важен текст.
const clean = (s) => s
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
  .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&times;/g, '×')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ')
  .trim();

const blocks = [];
const re = /<(h1|h2|li|p)\b[^>]*>([\s\S]*?)<\/\1>/g;
let m;
while ((m = re.exec(html))) {
  const text = clean(m[2]);
  if (text) blocks.push({ tag: m[1], text });
}

const today = new Date().toISOString().slice(0, 10);
const children = [
  new Paragraph({ text: 'Инструкция по администрированию сайта ftso67.ru', heading: HeadingLevel.TITLE }),
  new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({
      text: `РФСОО «Федерация тенниса Смоленской области». Приложение к акту сдачи-приёмки по договору № 1/2026-ФТСО. Редакция от ${today}.`,
      italics: true, size: 20,
    })],
  }),
  new Paragraph({ text: '' }),
];

for (const b of blocks) {
  if (b.tag === 'h1') continue; // заголовок уже вынесен в титул
  // Служебная строка админки «Ваша роль: …» в документе не нужна: он собирается
  // с полными правами и описывает ВСЕ разделы, а не роль конкретного сотрудника.
  if (b.tag === 'p' && /Ваша роль/.test(b.text)) continue;
  if (b.tag === 'h2') {
    children.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_1, spacing: { before: 280, after: 120 } }));
  } else if (b.tag === 'li') {
    children.push(new Paragraph({ text: b.text, bullet: { level: 0 }, spacing: { after: 80 } }));
  } else {
    children.push(new Paragraph({ children: [new TextRun({ text: b.text, size: 20, italics: true })], spacing: { after: 160 } }));
  }
}

const doc = new Document({
  creator: 'ИП Коротков О. А.',
  title: 'Инструкция по администрированию сайта ftso67.ru',
  description: 'Приложение к акту сдачи-приёмки по договору № 1/2026-ФТСО',
  styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
  sections: [{ children }],
});

const buf = await Packer.toBuffer(doc);
writeFileSync(OUT, buf);
const headings = blocks.filter((b) => b.tag === 'h2').length;
const items = blocks.filter((b) => b.tag === 'li').length;
console.log(`${OUT}: разделов ${headings}, пунктов ${items}, ${buf.length} байт`);
