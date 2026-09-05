// МИНИМАЛЬНЫЙ XLSX БЕЗ ЗАВИСИМОСТЕЙ (ТЗ 4.4: «экспорт в PDF или Excel»).
// .xlsx — это zip с несколькими XML. Здесь ровно столько, сколько нужно, чтобы
// Excel/LibreOffice/Numbers открыли одну таблицу: строки-ячейки inlineStr для
// текста и n для чисел. Своя сборка zip (deflate из zlib + CRC32), чтобы не
// тащить пакет ради одной кнопки.
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zip из {name: Buffer|string}; все записи deflate. */
export function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const dosTime = 0; const dosDate = (1 << 5) | 1; // 1980-01-01 00:00 — воспроизводимый архив
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** rows: массив массивов (строки → ячейки); числа пишутся числами, остальное — текстом. */
export function xlsxFromRows(rows, { sheet = 'Лист1' } = {}) {
  const body = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      const ref = `${col(ci)}${ri + 1}`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      if (v === null || v === undefined || v === '') return '';
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheetXml,
  });
}

// ---------------------------------------------------------------------------
// ЧТЕНИЕ (импорт протокола, ускорение ввода п. 2). Ровно столько, чтобы
// вытащить строки первого листа: zip (stored/deflate), sharedStrings, inlineStr,
// числа. Стили, формулы, объединения — не нужны, игнорируются.
import { inflateRawSync } from 'node:zlib';

/** zip → { имя: Buffer } по central directory (переживает data descriptor). */
export function unzip(buf) {
  const out = {};
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('не zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28); const elen = buf.readUInt16LE(off + 30); const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(lho + 26); const lelen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const data = buf.slice(start, start + csize);
    out[name] = method === 8 ? inflateRawSync(data) : method === 0 ? Buffer.from(data) : null;
    off += 46 + nlen + elen + clen;
  }
  return out;
}

const unesc = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** Первый лист книги → массив строк (массивов строковых ячеек). */
export function rowsFromXlsx(buf) {
  const parts = unzip(buf);
  const shared = [];
  if (parts['xl/sharedStrings.xml']) {
    for (const m of parts['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      shared.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
    }
  }
  // Первый лист — по workbook.xml.rels (имя файла листа может быть не sheet1).
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = parts['xl/workbook.xml'] && parts['xl/workbook.xml'].toString('utf8');
  const rels = parts['xl/_rels/workbook.xml.rels'] && parts['xl/_rels/workbook.xml.rels'].toString('utf8');
  if (wb && rels) {
    const rid = (/<sheet [^>]*r:id="([^"]+)"/.exec(wb) || [])[1];
    const target = rid && (new RegExp(`<Relationship [^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels) || [])[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  const xml = parts[sheetPath];
  if (!xml) throw new Error('в файле нет листа');
  const rows = [];
  for (const rm of xml.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const idx = colIndex(cm[1]);
      const attrs = cm[2] || ''; const inner = cm[3] || '';
      let val = '';
      const t = (/ t="([^"]+)"/.exec(attrs) || [])[1];
      if (t === 's') { const v = (/<v>([^<]*)<\/v>/.exec(inner) || [])[1]; val = shared[Number(v)] || ''; }
      else if (t === 'inlineStr') { val = unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')); }
      else { const v = (/<v>([^<]*)<\/v>/.exec(inner) || [])[1]; val = v === undefined ? '' : unesc(v); }
      cells[idx] = val.trim();
    }
    rows.push(Array.from(cells, (c) => c || ''));
  }
  return rows;
}

/** CSV (; или , или таб; кавычки; BOM) → строки. */
export function rowsFromCsv(buf) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const first = text.split(/\r?\n/)[0] || '';
  const sep = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? (first.includes('\t') && !first.includes(';') ? '\t' : ';') : ',';
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === sep) { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

/**
 * Строки таблицы → текст протокола для checkBulkResults: «место игрок».
 * Колонки ищутся по заголовку («место», «игрок/фио/фамилия»), иначе — первые две.
 */
export function protocolTextFromRows(rows) {
  if (!rows.length) return '';
  const head = rows[0].map((c) => c.toLowerCase());
  let iPlace = head.findIndex((c) => /^(место|place|№|#)/.test(c));
  let iName = head.findIndex((c) => /(игрок|фио|фамилия|участник|player|name)/.test(c));
  const hasHeader = iPlace >= 0 || iName >= 0;
  if (iPlace < 0) iPlace = 0;
  if (iName < 0) iName = iPlace === 0 ? 1 : 0;
  return rows
    .slice(hasHeader ? 1 : 0)
    .filter((r) => (r[iPlace] || '').trim() || (r[iName] || '').trim())
    .map((r) => `${(r[iPlace] || '').trim()} ${(r[iName] || '').trim()}`.trim())
    .join('\n');
}
