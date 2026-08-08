// РАЗБОР multipart/form-data (формы с файлами).
//
// Express сам multipart не разбирает. Взят busboy — потоковый: при превышении
// лимита он ОБРЫВАЕТ поток, а не набирает присланное в память целиком. Свой
// разбор границ и обрывов писать не стали: это код, чья ошибка не видна до
// эксплуатации.
//
// CSRF ПРОВЕРЯЕТСЯ ЗДЕСЬ. Общий csrfMiddleware читает req.body, а для multipart
// тела на тот момент ещё нет — значит для таких запросов он пропускает проверку
// и передаёт её сюда. Чтобы это нельзя было забыть в маршруте, проверка сидит
// ВНУТРИ парсера: получить поля формы, не сверив токен, попросту нечем.
import Busboy from 'busboy';
import { ValidationError } from './validate.mjs';
import { csrfMatches } from './csrf.mjs';

export function isMultipart(req) {
  return /^multipart\/form-data/i.test(req.headers['content-type'] || '');
}

/**
 * Возвращает {fields, files}. files: [{field, filename, declaredType, buffer}].
 * declaredType — то, что СКАЗАЛ клиент: хранится для журнала, но тип файла
 * определяется по содержимому в lib/uploads.mjs.
 */
export function parseMultipart(req, { maxFileBytes = 10 * 1024 * 1024, maxFiles = 3, maxFields = 30, maxFieldBytes = 8 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!isMultipart(req)) {
      return reject(new ValidationError('Форма отправлена в неверном формате. Обновите страницу и повторите.'));
    }

    let bb;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: { fileSize: maxFileBytes, files: maxFiles, fields: maxFields, fieldSize: maxFieldBytes },
      });
    } catch {
      return reject(new ValidationError('Форма отправлена в неверном формате. Обновите страницу и повторите.'));
    }

    const fields = Object.create(null);
    const files = [];
    let failed = null;

    const fail = (err) => {
      if (failed) return;
      failed = err;
      req.unpipe(bb);
      bb.destroy();
      reject(err);
    };

    bb.on('field', (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) {
        return fail(new ValidationError('Одно из полей формы слишком длинное.'));
      }
      fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      const chunks = [];
      let truncated = false;
      stream.on('data', (chunk) => chunks.push(chunk));
      // Сработал лимит — busboy оборвал чтение. Файл НЕ берём даже частично:
      // обрезанный документ хуже отсутствующего, его никто не заметит.
      stream.on('limit', () => { truncated = true; });
      stream.on('close', () => {
        if (truncated) {
          return fail(
            new ValidationError(
              `Файл «${info.filename}» больше ${Math.round(maxFileBytes / 1024 / 1024)} МБ — уменьшите размер.`,
            ),
          );
        }
        const buffer = Buffer.concat(chunks);
        // Пустое поле файла (человек ничего не выбрал) — это не ошибка.
        if (buffer.length > 0) {
          files.push({ field: name, filename: info.filename || 'file', declaredType: info.mimeType, buffer });
        }
      });
    });

    bb.on('filesLimit', () => fail(new ValidationError(`Слишком много файлов, максимум ${maxFiles}.`)));
    bb.on('fieldsLimit', () => fail(new ValidationError('Слишком много полей в форме.')));
    bb.on('error', () => fail(new ValidationError('Не удалось разобрать форму. Обновите страницу и повторите.')));

    bb.on('close', () => {
      if (failed) return;
      // CSRF — последним, но обязательно: до этого места токен ещё не был разобран.
      if (!csrfMatches(req, fields._csrf)) {
        const err = new Error('CSRF-токен отсутствует или неверен');
        err.status = 403;
        err.publicMessage = 'Форма устарела или отправлена не с этого сайта. Обновите страницу и повторите.';
        return reject(err);
      }
      resolve({ fields, files });
    });

    req.pipe(bb);
  });
}
