// ЕДИНЫЕ ТРЕБОВАНИЯ К ЗАГРУЗКЕ ФАЙЛОВ — ОДИН слой на все аплоады проекта.
//
// Сюда сядут документы турниров, галерея и /documents. Именно поэтому это
// модуль, а не проверка внутри маршрута: три копии правил разойдутся, и
// разойдутся они молча — в той копии, куда забыли внести исправление.
//
// Правила (шапка бэклога):
//  1) тип по MAGIC BYTES, а не по расширению и не по Content-Type — и то и
//     другое присылает клиент, то есть верить им нельзя;
//  2) исполняемые файлы отбиваются ЯВНО, до всякого разбора;
//  3) лимит размера;
//  4) хранение ВНЕ webroot — файл не должен быть доступен по прямой ссылке
//     как статика, иначе его отдаст веб-сервер мимо всех наших проверок;
//  5) отдача ТОЛЬКО как attachment;
//  6) ресайз изображений.
import sharp from 'sharp';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ValidationError } from './validate.mjs';

// --- распознавание типа ----------------------------------------------------

const startsWith = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/**
 * ИСПОЛНЯЕМОЕ отбиваем первым и отдельным списком — раньше, чем начинаем
 * гадать о полезных типах. Так безопаснее: неизвестный формат просто не
 * пройдёт белый список, но вот exe/elf/скрипт мы обязаны узнать в лицо.
 */
const EXECUTABLE_SIGNATURES = [
  { name: 'PE/EXE (Windows)', bytes: ascii('MZ') },
  { name: 'ELF (Linux)', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'Mach-O', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'Mach-O', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  // CA FE BA BE — и Java class, и «толстый» Mach-O. Оба исполняемые.
  { name: 'Java class / Mach-O fat', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'скрипт с shebang', bytes: ascii('#!') },
  { name: 'Windows-скрипт', bytes: ascii('@echo') },
];

export function looksExecutable(buf) {
  for (const sig of EXECUTABLE_SIGNATURES) {
    if (startsWith(buf, sig.bytes)) return sig.name;
  }
  return null;
}

/**
 * OOXML (docx/xlsx) — это ZIP, но и .jar, и .apk, и просто архив — тоже ZIP.
 * Поэтому мало увидеть «PK\x03\x04»: смотрим ИМЯ ПЕРВОЙ ЗАПИСИ архива. У
 * документов Office это «[Content_Types].xml». Голый zip внутрь не пролезет.
 */
function ooxmlKind(buf) {
  if (!startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return null;
  if (buf.length < 30) return null;
  const nameLength = buf.readUInt16LE(26);
  const name = buf.slice(30, 30 + nameLength).toString('latin1');
  return name === '[Content_Types].xml' ? 'ooxml' : null;
}

/** Тип по содержимому. null — формат не опознан (значит, не пропускаем). */
export function sniffType(buf) {
  if (startsWith(buf, ascii('%PDF-'))) return { kind: 'pdf', mime: 'application/pdf', ext: 'pdf' };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mime: 'image/png', ext: 'png' };
  }
  if (startsWith(buf, ascii('GIF87a')) || startsWith(buf, ascii('GIF89a'))) {
    return { kind: 'image', mime: 'image/gif', ext: 'gif' };
  }
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) {
    return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  }
  if (ooxmlKind(buf)) {
    // docx и xlsx неразличимы по первым байтам — уточняем расширением, но
    // ТОЛЬКО в пределах уже доказанного «это документ Office».
    return { kind: 'document', mime: 'application/vnd.openxmlformats-officedocument', ext: 'docx' };
  }
  // Старые .doc/.xls — контейнер OLE2.
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { kind: 'document', mime: 'application/msword', ext: 'doc' };
  }
  return null;
}

// Наборы разрешённого — по НАЗНАЧЕНИЮ загрузки, а не по маршруту.
export const UPLOAD_PROFILES = {
  // Документы турнира: положение, сетка, протокол.
  'tournament-doc': { kinds: ['pdf', 'document', 'image'], maxBytes: 10 * 1024 * 1024 },
  // Галерея и любые картинки витрины.
  gallery: { kinds: ['image'], maxBytes: 8 * 1024 * 1024 },
  // Раздел «Документы» федерации.
  documents: { kinds: ['pdf', 'document'], maxBytes: 20 * 1024 * 1024 },
  // Закрытые документы федерации (только super-admin): сканы могут быть картинками.
  'internal-doc': { kinds: ['pdf', 'document', 'image'], maxBytes: 20 * 1024 * 1024 },
};

const OOXML_EXTS = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

/**
 * ПРОВЕРКА одного файла. Бросает ValidationError с человеческим текстом —
 * загрузивший должен понимать, что не так, а не видеть «ошибка 400».
 */
export function validateUpload({ buffer, filename = '', profile = 'tournament-doc' }) {
  const rules = UPLOAD_PROFILES[profile];
  if (!rules) throw new Error(`неизвестный профиль загрузки: ${profile}`);

  if (!buffer || buffer.length === 0) throw new ValidationError('Файл пустой.');
  if (buffer.length > rules.maxBytes) {
    throw new ValidationError(
      `Файл больше ${Math.round(rules.maxBytes / 1024 / 1024)} МБ — уменьшите размер.`,
    );
  }

  const exe = looksExecutable(buffer);
  if (exe) throw new ValidationError(`Исполняемые файлы загружать нельзя (распознано: ${exe}).`);

  const sniffed = sniffType(buffer);
  if (!sniffed) {
    throw new ValidationError(
      'Формат файла не распознан. Допустимы PDF, документы Office и изображения (JPEG, PNG, GIF, WebP).',
    );
  }
  if (!rules.kinds.includes(sniffed.kind)) {
    throw new ValidationError(`Такой тип файла в этот раздел загружать нельзя (${sniffed.mime}).`);
  }

  // Расширение НЕ решает, что это за файл, но помогает отличить docx от xlsx
  // внутри уже доказанного OOXML. Всё остальное берётся из содержимого.
  let ext = sniffed.ext;
  const claimed = String(filename).toLowerCase().split('.').pop();
  if (sniffed.kind === 'document' && OOXML_EXTS[claimed]) ext = OOXML_EXTS[claimed];

  return { ...sniffed, ext, size: buffer.length };
}

// --- изображения -----------------------------------------------------------

// Потолок стороны. Фото с телефона — это 4000+ px и несколько мегабайт;
// в галерее и в документах турнира такой размер не нужен никому.
export const IMAGE_MAX_SIDE = 1600;

/**
 * ПЕРЕЗАПИСЬ ИЗОБРАЖЕНИЯ. Ресайз здесь — не про вес картинки, а про ПДн:
 * снимок с телефона несёт EXIF, а в EXIF лежат geolocation и модель камеры.
 * Опубликовать такое фото в открытой галерее значит опубликовать координаты.
 * Полная перекодировка срезает метаданные целиком — sharp по умолчанию их не
 * переносит, а .rotate() до ресайза применяет ориентацию из EXIF, чтобы
 * снимок не лёг на бок вместе с удалением тега.
 *
 * GIF не трогаем: EXIF в нём не бывает, а перекодировка убила бы анимацию.
 */
export async function normalizeImage(buffer, mime, { maxSide = IMAGE_MAX_SIDE } = {}) {
  if (mime === 'image/gif') return { buffer, mime, ext: 'gif', resized: false };

  const pipeline = sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: 'inside', withoutEnlargement: true });

  let out;
  let ext;
  if (mime === 'image/png') {
    out = await pipeline.png({ compressionLevel: 9 }).toBuffer();
    ext = 'png';
  } else if (mime === 'image/webp') {
    out = await pipeline.webp({ quality: 82 }).toBuffer();
    ext = 'webp';
  } else {
    out = await pipeline.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    ext = 'jpg';
    mime = 'image/jpeg';
  }
  return { buffer: out, mime, ext, resized: true };
}

// --- хранение --------------------------------------------------------------

/**
 * Имя на диске задаём САМИ — случайное. Присланное имя не участвует в пути
 * вообще: ни «../», ни «файл.pdf.php», ни юникодные трюки просто некуда
 * применить. Исходное имя хранится в БД и используется только при отдаче.
 */
export function storagePath(dir, storedName) {
  return resolve(dir, storedName);
}

export function ensureStorage(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Безопасное имя для заголовка Content-Disposition. */
export function safeDownloadName(original, ext) {
  const base = String(original || 'file')
    .replace(/[\\/\r\n"]+/g, ' ')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 100);
  const name = base || 'file';
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/**
 * Кладёт файл на диск ВНЕ webroot и заводит запись в БД. Возвращает строку
 * uploads. Дубликаты по sha256 не склеиваются намеренно: у файлов разные
 * владельцы и разные сроки хранения, склейка усложнила бы удаление.
 */
export async function storeUpload(db, { buffer, filename, profile, meta, uploadedBy = null, dir }) {
  const checked = validateUpload({ buffer, filename, profile });

  // Изображение кладём НЕ ТЕМ ЖЕ файлом, что прислали: перезапись срезает EXIF
  // (геолокация, модель камеры) и приводит размер к разумному. Проверка типа
  // уже прошла — перекодируем то, что доказано картинкой.
  let data = buffer;
  let mime = checked.mime;
  let ext = checked.ext;
  if (checked.kind === 'image') {
    const normalized = await normalizeImage(buffer, checked.mime);
    data = normalized.buffer;
    mime = normalized.mime;
    ext = normalized.ext;
  }

  ensureStorage(dir);
  const storedName = `${randomBytes(16).toString('hex')}.${ext}`;
  const sha256 = createHash('sha256').update(data).digest('hex');
  writeFileSync(storagePath(dir, storedName), data, { mode: 0o640 });

  const info = db
    .prepare(
      `INSERT INTO uploads (stored_name, original_name, mime, kind, profile, size_bytes, sha256, uploaded_by, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      storedName,
      safeDownloadName(filename, ext),
      mime,
      checked.kind,
      profile,
      data.length,
      sha256,
      uploadedBy,
      meta ? JSON.stringify(meta) : null,
    );
  return db.prepare('SELECT * FROM uploads WHERE id = ?').get(Number(info.lastInsertRowid));
}

export function uploadById(db, id) {
  return db.prepare('SELECT * FROM uploads WHERE id = ?').get(id);
}

/** Удаление файла вместе с записью: осиротевший файл на диске — тоже утечка. */
export function deleteUpload(db, id, dir) {
  const row = uploadById(db, id);
  if (!row) return false;
  const path = storagePath(dir, row.stored_name);
  if (existsSync(path)) unlinkSync(path);
  db.prepare('DELETE FROM uploads WHERE id = ?').run(id);
  return true;
}

/**
 * ОТДАЧА — всегда attachment и всегда с nosniff. Даже картинка не отдаётся
 * инлайново: браузер, открывающий загруженный посетителем файл в контексте
 * нашего домена, — это готовый XSS через SVG или хитрый HTML.
 */
export function sendUpload(res, row, dir) {
  const path = storagePath(dir, row.stored_name);
  if (!existsSync(path)) return false;
  res.setHeader('Content-Type', row.mime === 'image/svg+xml' ? 'application/octet-stream' : row.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Length', statSync(path).size);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${row.original_name.replace(/[^\x20-\x7e]/g, '_')}"; ` +
      `filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
  );
  res.sendFile(path);
  return true;
}

/**
 * ОТДАЧА ИЗОБРАЖЕНИЯ ВСТРОЕННО — для фотографии на публичном профиле. Отличия от
 * sendUpload: Content-Disposition inline (браузер показывает, а не скачивает),
 * Cache-Control no-cache + ETag по sha256 — прокси и браузер обязаны
 * перепроверять: удалённая в кабинете фотография пропадает с профиля сразу,
 * а не после истечения чужого кэша. Только для картинок; всё прочее — attachment.
 */
export function sendUploadInline(req, res, row, dir) {
  if (row.kind !== 'image' || row.mime === 'image/svg+xml') return sendUpload(res, row, dir);
  const path = storagePath(dir, row.stored_name);
  if (!existsSync(path)) return false;
  const etag = `"${row.sha256.slice(0, 32)}"`;
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', etag);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Length', statSync(path).size);
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(path);
  return true;
}

export { join as joinPath };
