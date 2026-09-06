// ВЫГРУЗКА СЕТКИ ТУРНИРА В PDF И WORD (решение владельца 05.09.2026): сетка, группы,
// итоговые места — одним файлом на скачивание. PDF — pdfkit со своим шрифтом DejaVu
// (кириллица), Word — пакет docx. Оба чисто JS, без браузера на сервере.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, HeadingLevel } from 'docx';
import { xlsxFromRows } from './xlsx.mjs';
import { scoreFor } from './groups.mjs';

const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/fonts');
const FONT = readFileSync(resolve(FONT_DIR, 'DejaVuSans.ttf'));
const FONT_BOLD = readFileSync(resolve(FONT_DIR, 'DejaVuSans-Bold.ttf'));
const KIND_RU = { team: 'Командная встреча', championship: 'Первенство', other: 'Турнир' };

/** Общая «модель листа» из данных турнира: заголовок, группы (таблицы), сетки (по раундам), результаты. */
export function sheetModel({ tournament, groups, brackets, results }) {
  // Счёт с точки зрения Игрока 1 / строки — единый показ (неявка N, … отказ N).
  const flip = (s) => scoreFor(s, false);
  const fromA = (score, aWon) => scoreFor(score, aWon);
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
        score: p.winner ? (p.bye ? 'без игры' : fromA(p.scoreRaw || '', p.winner === p.aId)) : '',
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
      const rowH = title.startsWith('Группа') ? 22 : 16; const x0 = 40;
      const drawRow = (cells, bold) => {
        ensure(rowH + 2);
        let x = x0; const y = doc.y;
        cells.forEach((c, i) => {
          doc.rect(x, y, widths[i], rowH).stroke('#999');
          doc.font(bold ? 'B' : 'R').fontSize(rowH > 16 ? 9 : 8).text(String(c), x + 3, y + (rowH > 16 ? 6 : 4), { width: widths[i] - 6, height: rowH, ellipsis: true, lineBreak: false });
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
      // СЕТКА ДЛЯ ЗАПОЛНЕНИЯ ОТ РУКИ (замечание владельца 06.09.2026): крупные ячейки,
      // подписи «Игрок» / «Счёт», у пустых слотов — линии под фамилию, победитель обведён.
      const cols = b.rounds.length + 1; const colW = Math.floor(W / cols); const boxW = colW - 10;
      const pairH = 66; const gap = 10; const scoreW = Math.min(96, Math.floor(boxW * 0.42));
      const maxPairs = b.rounds[0].pairs.length;
      const totalH = maxPairs * (pairH + gap) + 30;
      if (doc.y + totalH + 30 > doc.page.height - 40) doc.addPage();
      doc.font('B').fontSize(11).text(b.title);
      doc.font('R').fontSize(7.5).fillColor('#555').text('Заполнение: впишите счёт по сетам (например 6:3 6:4) в поле «Счёт», обведите победителя; в следующем круге впишите его фамилию на линии.').fillColor('#000');
      doc.moveDown(0.4);
      const y0 = doc.y + 14;
      const drawPair = (x, y, p, empty) => {
        doc.rect(x, y, boxW, pairH).lineWidth(0.8).stroke(p && p.winner ? '#0e7a52' : '#666');
        doc.moveTo(x + boxW - scoreW, y).lineTo(x + boxW - scoreW, y + pairH).stroke('#666');
        doc.moveTo(x, y + pairH / 2).lineTo(x + boxW - scoreW, y + pairH / 2).stroke('#bbb');
        doc.font('R').fontSize(6).fillColor('#888').text('Игрок 1', x + 4, y + 3, { lineBreak: false }).text('Игрок 2', x + 4, y + pairH / 2 + 3, { lineBreak: false })
          .text('Счёт', x + boxW - scoreW + 4, y + 3, { lineBreak: false }).fillColor('#000');
        const rowY = [y + 13, y + pairH / 2 + 13];
        [p ? p.a : '—', p ? p.b : '—'].forEach((name, i) => {
          const isWin = p && p.winner === (i === 0 ? 'a' : 'b');
          if (empty || name === '—') { doc.moveTo(x + 6, rowY[i] + 12).lineTo(x + boxW - scoreW - 6, rowY[i] + 12).lineWidth(0.6).stroke('#333'); }
          else doc.font(isWin ? 'B' : 'R').fontSize(10).fillColor('#000').text(name, x + 6, rowY[i], { width: boxW - scoreW - 12, lineBreak: false, ellipsis: true });
        });
        if (p && p.score) doc.font('B').fontSize(9).fillColor('#000').text(p.score, x + boxW - scoreW + 4, y + pairH / 2 - 6, { width: scoreW - 8, lineBreak: false, ellipsis: true });
      };
      b.rounds.forEach((r, ri) => {
        const x = 40 + ri * colW;
        doc.font('B').fontSize(8).fillColor('#000').text(r.name, x, y0 - 12, { width: boxW, lineBreak: false });
        const span = (pairH + gap) * 2 ** ri;
        r.pairs.forEach((p, k) => {
          const y = y0 + k * span + (span - pairH) / 2;
          const empty = !(p.a !== '—' || p.b !== '—');
          drawPair(x, y, empty ? null : p, empty);
          // Соединительная линия к следующему кругу
          if (ri < b.rounds.length) doc.moveTo(x + boxW, y + pairH / 2).lineTo(x + boxW + 10, y + pairH / 2).lineWidth(0.5).stroke('#999');
        });
      });
      const xw = 40 + b.rounds.length * colW;
      doc.font('B').fontSize(8).fillColor('#000').text('Победитель', xw, y0 - 12, { lineBreak: false });
      // Ячейка победителя — на уровне финальной пары.
      const spanFinal = (pairH + gap) * 2 ** (b.rounds.length - 1);
      const yw = y0 + (spanFinal - pairH) / 2 + pairH / 2 - 15;
      doc.rect(xw, yw, boxW, 30).lineWidth(1).stroke('#0e7a52');
      if (b.champion) doc.font('B').fontSize(10).text(b.champion, xw + 6, yw + 10, { width: boxW - 12, lineBreak: false, ellipsis: true });
      else doc.moveTo(xw + 6, yw + 22).lineTo(xw + boxW - 6, yw + 22).lineWidth(0.6).stroke('#333');
      doc.lineWidth(1);
      doc.x = 40; doc.y = y0 + totalH; doc.moveDown(0.4);
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
    // Сетка в Word — таблицей: раунды столбцами, каждая пара — три строки:
    // «Игрок 1: …», «Игрок 2: …», «Счёт: …» (пустое — линия под ручку).
    const rounds = b.rounds; const maxPairs = rounds[0].pairs.length;
    const header = [...rounds.map((r) => r.name), 'Победитель'];
    const rows = [];
    const line = (k, pick) => rounds.map((r) => { const p = r.pairs[Math.floor(k / (maxPairs / r.pairs.length))]; if (!p) return ''; return k % (maxPairs / r.pairs.length) === 0 ? pick(p) : ''; });
    const slot = (name, win) => `${win ? '✔ ' : ''}${name === '—' ? '________________' : name}`;
    for (let k = 0; k < maxPairs; k++) {
      rows.push([...line(k, (p) => `Игрок 1: ${slot(p.a, p.winner === 'a')}`), k === 0 ? (b.champion || '________________') : '']);
      rows.push([...line(k, (p) => `Игрок 2: ${slot(p.b, p.winner === 'b')}`), '']);
      rows.push([...line(k, (p) => `Счёт: ${p.score || '________________'}`), '']);
    }
    kids.push(P('Заполнение: впишите счёт по сетам (например 6:3 6:4), отметьте победителя; в следующем круге впишите его фамилию.', { color: '555555', size: 18, after: 80 }));
    kids.push(tbl(header, rows), P('', { after: 160 }));
  }
  if (model.results.length) { kids.push(P('Результаты', { bold: true, size: 24, after: 80 }), tbl(['Место', 'Игрок', 'Город'], model.results)); }
  kids.push(P(model.footer, { color: '777777', size: 16 }));
  const doc = new Document({ sections: [{ properties: { page: { size: { orientation: 'landscape' } } }, children: kids }] });
  return Packer.toBuffer(doc);
}

/**
 * ПРОТОКОЛ ТУРНИРА (Excel) — в форме, принятой в турнирном теннисе (ред. 06.09.2026):
 * шапка турнира (название, даты, город, категория, разряд/возраст, главный судья,
 * секретарь), затем таблица матчей: № | Этап | Игрок 1 | Игрок 2 | 1-й сет | 2-й сет |
 * 3-й сет | Счёт (итог) | Победитель | Код пары. Секретарь заполняет сеты (6:3) с точки
 * зрения Игрока 1 либо сразу «Счёт (итог)» («6:3 6:4», «wo», «-wo»). «Код пары» —
 * служебный адрес строки для обратной загрузки (сетка/круг/пара или группа/игроки),
 * у каждой строки свой; не менять.
 */
export const PROTOCOL_HEADER = ['№', 'Этап', 'Игрок 1', 'Игрок 2', '1-й сет', '2-й сет', '3-й сет', 'Счёт (итог)', 'Победитель', 'Код пары (не менять)'];

export function protocolKeyLabel(key) {
  const m = /^([gb]):(\d+):(\d+):(\d+)$/.exec(key);
  if (!m) return key;
  return m[1] === 'b' ? `сетка ${m[2]} · круг ${Number(m[3]) + 1} · пара ${Number(m[4]) + 1}` : `группа ${m[2]} · игроки #${m[3]} и #${m[4]}`;
}
export function protocolKeyFromLabel(label) {
  const s = String(label || '').trim();
  let m = /^сетка\s+(\d+)\s*·\s*круг\s+(\d+)\s*·\s*пара\s+(\d+)$/i.exec(s);
  if (m) return `b:${m[1]}:${Number(m[2]) - 1}:${Number(m[3]) - 1}`;
  m = /^группа\s+(\d+)\s*·\s*игроки\s+#(\d+)\s+и\s+#(\d+)$/i.exec(s);
  if (m) return `g:${m[1]}:${m[2]}:${m[3]}`;
  return /^[gb]:\d+:\d+:\d+$/.test(s) ? s : null;
}

export function tournamentProtocolXlsx(model) {
  // Шапка — во 2-й колонке (1-я узкая, под «№»).
  const head = [
    ['', 'ПРОТОКОЛ ТУРНИРА'],
    ['', 'Турнир', model.title],
    ['', 'Сроки, место, категория', model.subtitle],
    ['', 'Организатор', 'Федерация тенниса Смоленской области · ftso67.ru'],
    ['', 'Главный судья', ''],
    ['', 'Секретарь турнира', ''],
    ['', 'Как заполнять', 'Сеты — с точки зрения Игрока 1 (6:3, 7:6(5)); либо сразу «Счёт (итог)»: «6:3 6:4». Неявка — «неявка 2» (не явился Игрок 2) или «неявка 1». Снялся — «6:3 2:1 отказ 2». Пустая строка пропускается. Колонку «Код пары» не менять.'],
    [],
    PROTOCOL_HEADER,
  ];
  const rows = model.pending.map((m, i) => {
    const sets = m.score && !/неявка|отказ|wo/.test(m.score) ? m.score.split(' ') : [];
    return [i + 1, m.where, `${m.a} (#${m.aId})`, `${m.b} (#${m.bId})`, sets[0] || '', sets[1] || '', sets[2] || '', m.score, '', protocolKeyLabel(m.key)];
  });
  if (!rows.length) rows.push(['', 'Пар для заполнения нет — посейте сетку или заполните группы', '', '', '', '', '', '', '', '']);
  const all = [...head, ...rows, [], ['', 'Главный судья: __________________ / подпись', '', 'Секретарь: __________________ / подпись']];
  return xlsxFromRows(all, {
    sheet: 'Протокол',
    widths: [5, 34, 30, 30, 9, 9, 9, 16, 22, 30],
    boldRows: [1, head.length],
    boxRows: [head.length, head.length + rows.length],
  });
}
