// ВЫГРУЗКА СЕТКИ ТУРНИРА В PDF И WORD (решение владельца 05.09.2026): сетка, группы,
// итоговые места — одним файлом на скачивание. PDF — pdfkit со своим шрифтом DejaVu
// (кириллица), Word — пакет docx. Оба чисто JS, без браузера на сервере.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel } from 'docx';
import { xlsxFromRows } from './xlsx.mjs';

const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const FONT = readFileSync(resolve(FONT_DIR, 'DejaVuSans.ttf'));
const FONT_BOLD = readFileSync(resolve(FONT_DIR, 'DejaVuSans-Bold.ttf'));
const KIND_RU = { team: 'Командная встреча', championship: 'Первенство', other: 'Турнир' };

/** Общая «модель листа» из данных турнира: заголовок, группы (таблицы), сетки (по раундам), результаты. */
export function sheetModel({ tournament, groups, brackets, results }) {
  // Счёт с точки зрения ПРОИГРАВШЕЙ стороны: сеты переворачиваются, «w/o» → «-wo».
  const flip = (s) => (s === 'w/o' ? '-wo' : s.split(' ').map((x) => { const m = /^(\d+)[:\-](\d+)(\(\d+\))?$/.exec(x); return m ? `${m[2]}:${m[1]}${m[3] || ''}` : x; }).join(' '));
  const fromA = (score, aWon) => (score === 'w/o' && aWon ? 'wo' : aWon ? score : flip(score));
  return {
    title: tournament.name,
    subtitle: [
      KIND_RU[tournament.kind] || 'Турнир',
      `${tournament.start_date ? tournament.start_date + ' — ' : ''}${tournament.end_date}`,
      tournament.city || null,
      `категория ${tournament.category}`,
      tournament.age_group || null,
    ].filter(Boolean).join(' · '),
    groups: groups.map((g) => ({
      title: `Группа ${g.name} (${g.kind === 'double' ? 'парный' : 'одиночный'})`,
      header: ['#', 'Игрок', ...g.members.map((_, j) => String(j + 1)), 'Поб.', 'Место'],
      rows: g.members.map((r, i) => [
        String(i + 1),
        r.anonymized_at ? 'Игрок удалён' : r.full_name,
        ...g.members.map((c) => {
          if (r.id === c.id) return '—';
          const cell = g.cells[`${r.id}:${c.id}`];
          return cell ? (cell.won ? cell.score : flip(cell.score)) : '';
        }),
        String(g.stats[r.id].wins),
        g.stats[r.id].played ? String(g.stats[r.id].place) : '—',
      ]),
    })),
    brackets: brackets.map((b) => ({
      id: b.id,
      title: `Сетка «${b.name}» на ${b.size} (${b.kind === 'double' ? 'парный' : 'одиночный'})`,
      rounds: b.rounds.map((r) => ({
        name: r.name,
        pairs: r.pairs.map((p) => ({
          a: p.a ? p.a.full_name : '—',
          b: p.b ? p.b.full_name : '—',
          aId: p.aId, bId: p.bId, k: p.k, r: r.r,
          winner: p.winner ? (p.winner === p.aId ? 'a' : 'b') : null,
          score: p.winner ? (p.bye ? 'без игры' : (p.score || '')) : '',
          pending: !p.winner && Boolean(p.aId && p.bId),
        })),
      })),
      champion: b.champion ? b.champion.full_name : null,
    })),
    // МАТЧИ К ЗАПОЛНЕНИЮ (протокол для секретаря → обратная заливка): все ещё не
    // сыгранные пары групп и сеток с техническим ключом g:<group>:<a>:<b> / b:<bracket>:<r>:<k>.
    pending: [
      ...groups.flatMap((g) => g.members.flatMap((r, i) => g.members.slice(i + 1).map((c) => ({
        where: `Группа ${g.name}`, key: `g:${g.id}:${r.id}:${c.id}`, aId: r.id, a: r.full_name, bId: c.id, b: c.full_name,
        score: g.cells[`${r.id}:${c.id}`] ? fromA(g.cells[`${r.id}:${c.id}`].score, g.cells[`${r.id}:${c.id}`].won) : '',
      })))),
      ...brackets.flatMap((b) => b.rounds.flatMap((r) => r.pairs.filter((p) => p.aId && p.bId).map((p) => ({
        where: `Сетка «${b.name}», ${r.name}, пара ${p.k + 1}`, key: `b:${b.id}:${r.r}:${p.k}`, aId: p.aId, a: p.a.full_name, bId: p.bId, b: p.b.full_name,
        score: p.winner ? (p.bye ? 'без игры' : fromA(p.score || '', p.winner === p.aId)) : '',
      })))),
    ],
    results: results.map((r) => [String(r.place), `${r.name}${r.discipline === 'double' ? ' (парный)' : ''}`, r.city || '']),
    footer: `ftso67.ru/tournaments/${tournament.id} · Федерация тенниса Смоленской области · ${new Date().toISOString().slice(0, 10)}`,
  };
}

/** PDF (Buffer). Сетка рисуется столбцами раундов; переносы — по страницам. */
export function tournamentPdf(model) {
  return new Promise((resolveP, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 40, left: 40, right: 40, bottom: 40 }, info: { Title: model.title, Author: 'ФТСО' } });
    doc.registerFont('R', FONT).registerFont('B', FONT_BOLD);
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolveP(Buffer.concat(chunks))); doc.on('error', reject);
    const W = doc.page.width - 80;
    const ensure = (h) => { if (doc.y + h > doc.page.height - 40) doc.addPage(); };
    doc.font('B').fontSize(16).text(model.title);
    doc.font('R').fontSize(9).fillColor('#555').text(model.subtitle).fillColor('#000').moveDown(0.6);

    const table = (title, header, rows, widths) => {
      ensure(40);
      doc.font('B').fontSize(11).text(title).moveDown(0.2);
      const rowH = 16; const x0 = 40;
      const drawRow = (cells, bold) => {
        ensure(rowH + 2);
        let x = x0; const y = doc.y;
        cells.forEach((c, i) => {
          doc.rect(x, y, widths[i], rowH).stroke('#999');
          doc.font(bold ? 'B' : 'R').fontSize(8).text(String(c), x + 3, y + 4, { width: widths[i] - 6, height: rowH, ellipsis: true, lineBreak: false });
          x += widths[i];
        });
        doc.y = y + rowH; doc.x = x0;
      };
      drawRow(header, true); rows.forEach((r) => drawRow(r, false));
      doc.moveDown(0.8);
    };
    for (const g of model.groups) {
      const n = g.header.length; const nameW = 150; const cellW = Math.max(38, Math.min(70, (W - nameW - 24 - 40 - 40) / (n - 4)));
      table(g.title, g.header, g.rows, [24, nameW, ...Array(n - 4).fill(cellW), 40, 40]);
    }
    for (const b of model.brackets) {
      ensure(60);
      doc.font('B').fontSize(11).text(b.title).moveDown(0.3);
      const cols = b.rounds.length + 1; const colW = Math.min(170, W / cols); const pairH = 40; const gap = 6;
      const top = doc.y; const maxPairs = b.rounds[0].pairs.length;
      const totalH = maxPairs * (pairH + gap) + 16;
      if (top + totalH > doc.page.height - 40) { doc.addPage(); }
      const y0 = doc.y + 14;
      b.rounds.forEach((r, ri) => {
        const x = 40 + ri * colW;
        doc.font('B').fontSize(8).text(r.name, x, y0 - 12, { width: colW - 8, lineBreak: false });
        const span = (pairH + gap) * 2 ** ri; // шаг пары в этом раунде
        r.pairs.forEach((p, k) => {
          const y = y0 + k * span + (span - pairH) / 2;
          doc.rect(x, y, colW - 8, pairH).stroke(p.winner ? '#0e7a52' : '#999');
          doc.font(p.winner === 'a' ? 'B' : 'R').fontSize(8).text(p.a, x + 4, y + 4, { width: colW - 16, lineBreak: false, ellipsis: true });
          doc.font(p.winner === 'b' ? 'B' : 'R').fontSize(8).text(p.b, x + 4, y + 16, { width: colW - 16, lineBreak: false, ellipsis: true });
          doc.font('R').fontSize(7).fillColor('#555').text(p.score || (p.pending ? 'счёт: ______________' : ''), x + 4, y + 29, { width: colW - 16, lineBreak: false }).fillColor('#000');
        });
      });
      const xw = 40 + b.rounds.length * colW; const spanW = (pairH + gap) * 2 ** b.rounds.length;
      doc.font('B').fontSize(8).text('Победитель', xw, y0 - 12, { lineBreak: false });
      const yw = y0 + (spanW / 2 - pairH) / 2;
      doc.rect(xw, yw, colW - 8, 22).stroke('#0e7a52');
      doc.font('B').fontSize(8).text(b.champion || '—', xw + 4, yw + 7, { width: colW - 16, lineBreak: false, ellipsis: true });
      doc.x = 40; doc.y = y0 + totalH; doc.moveDown(0.6);
    }
    if (model.results.length) table('Результаты', ['Место', 'Игрок', 'Город'], model.results, [50, 260, 160]);
    doc.font('R').fontSize(7).fillColor('#777').text(model.footer, 40, doc.page.height - 30, { lineBreak: false });
    doc.end();
  });
}

/** Word (Buffer): те же блоки таблицами. */
export async function tournamentDocx(model) {
  const P = (t, o = {}) => new Paragraph({ heading: o.h, alignment: o.align, spacing: { after: o.after ?? 100 }, children: [new TextRun({ text: t, bold: o.bold, size: o.size ?? 20, color: o.color, font: 'Calibri' })] });
  const cell = (t, { bold = false, width } = {}) => new TableCell({ width: width ? { size: width, type: WidthType.DXA } : undefined, children: [new Paragraph({ children: [new TextRun({ text: String(t), bold, size: 18, font: 'Calibri' })] })] });
  const tbl = (header, rows) => new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
    new TableRow({ tableHeader: true, children: header.map((h) => cell(h, { bold: true })) }),
    ...rows.map((r) => new TableRow({ children: r.map((c) => cell(c)) })),
  ] });
  const kids = [P(model.title, { bold: true, size: 32, after: 60 }), P(model.subtitle, { color: '555555', after: 240 })];
  for (const g of model.groups) { kids.push(P(g.title, { bold: true, size: 24, after: 80 }), tbl(g.header, g.rows), P('', { after: 160 })); }
  for (const b of model.brackets) {
    kids.push(P(b.title, { bold: true, size: 24, after: 80 }));
    // Сетка в Word — таблицей: раунды столбцами, каждая пара — три строки (игрок, игрок, счёт).
    const rounds = b.rounds; const maxPairs = rounds[0].pairs.length;
    const header = [...rounds.map((r) => r.name), 'Победитель'];
    const rows = [];
    for (let k = 0; k < maxPairs; k++) {
      const line = (pick) => rounds.map((r) => { const p = r.pairs[Math.floor(k / (r.pairs.length ? maxPairs / r.pairs.length : 1))]; if (!p) return ''; const idx = k % (maxPairs / r.pairs.length); return idx === 0 ? pick(p) : ''; });
      rows.push([...line((p) => (p.winner === 'a' ? '✔ ' : '') + p.a), k === 0 ? (b.champion || '—') : '']);
      rows.push([...line((p) => (p.winner === 'b' ? '✔ ' : '') + p.b), '']);
      rows.push([...line((p) => p.score || (p.pending ? 'счёт: ____________' : '')), '']);
    }
    kids.push(tbl(header, rows), P('', { after: 160 }));
  }
  if (model.results.length) { kids.push(P('Результаты', { bold: true, size: 24, after: 80 }), tbl(['Место', 'Игрок', 'Город'], model.results)); }
  kids.push(P(model.footer, { color: '777777', size: 16 }));
  const doc = new Document({ sections: [{ properties: { page: { size: { orientation: 'landscape' } } }, children: kids }] });
  return Packer.toBuffer(doc);
}

/**
 * ПРОТОКОЛ ДЛЯ ЗАПОЛНЕНИЯ (Excel): все пары групп и сеток одной таблицей; секретарь
 * вписывает счёт в колонку «Счёт (от игрока A)» — «6:3 6:4», «wo», «-wo» — и загружает
 * файл обратно в админку: сайт разносит счёт по группам и сетке. Колонка «Ключ» —
 * техническая, её не трогать.
 */
export function tournamentProtocolXlsx(model) {
  const rows = [
    ['Где', 'Игрок A', 'Игрок B', 'Счёт (от игрока A)', 'Ключ'],
    ...model.pending.map((m) => [m.where, `${m.a} (#${m.aId})`, `${m.b} (#${m.bId})`, m.score, m.key]),
  ];
  if (rows.length === 1) rows.push(['Пар для заполнения нет — посейте сетку или заполните группы', '', '', '', '']);
  return xlsxFromRows(rows, { sheet: 'Протокол' });
}
