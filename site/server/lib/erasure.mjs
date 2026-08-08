// ПРАВО НА ЗАБВЕНИЕ (ст. 21 152-ФЗ) — самый тонкий стык проекта.
//
// Здесь сталкиваются два требования, и оба обязательны:
//
//  1) УДАЛЕНИЕ ДОЛЖНО БЫТЬ НЕОБРАТИМЫМ. После обращения субъекта его ФИО не
//     должно восстанавливаться НИОТКУДА: ни из строки игрока, ни из снимков
//     рейтинга, ни из журнала действий, ни из очереди писем. Иначе это не
//     удаление, а скрытие из интерфейса.
//
//  2) РЕЙТИНГ СОПЕРНИКОВ ДОЛЖЕН ОСТАТЬСЯ ТЕМ ЖЕ. Матчи удалённого игрока —
//     это чужие победы и поражения. Снести их значит переписать места и очки
//     людям, которые ничего не просили.
//
// Отсюда решение: это НЕ `DELETE FROM players` (каскад унёс бы матчи и
// перекроил чужой рейтинг) и НЕ отрисовочное обезличивание (там данные живы в
// БД, что для забвения недопустимо). Это РАЗРУШЕНИЕ ЛИЧНЫХ ДАННЫХ В ЗАПИСИ при
// сохранении игрока как анонимной вершины графа матчей.
//
// Что затирается: ФИО, город, возрастная группа, фото, аккаунт с почтой и
// хэшем пароля, записи согласий, заявки, письма, имя в снимках рейтинга,
// личные значения в журнале действий.
// Что остаётся: id игрока, пол (сам по себе никого не определяет), результаты
// и матчи — то, без чего рейтинг соперников поедет.
import { ERASED_LABEL } from './rating-service.mjs';
import { deleteUpload } from './uploads.mjs';

const REDACTED = '[удалено]';
// Город NOT NULL с CHECK на длину — пустую строку схема не примет, поэтому
// прочерк. Это не данные, это заполнитель обязательного поля.
const ERASED_CITY = '—';

/** Литеральная замена подстроки — без регулярок, чтобы имя с точками не сломало шаблон. */
function replaceAll(text, needle, replacement) {
  if (!needle) return text;
  return String(text).split(needle).join(replacement);
}

/**
 * Имя игрока живёт ещё и в СНИМКАХ РЕЙТИНГА (rating_cache.standings_json).
 * Снимок — это копия ФИО, и без её чистки удаление обратимо: имя достаётся из
 * прошлого снимка. Правим ТОЛЬКО имя и город, ранги и очки не трогаем — иначе
 * поедет история чужих мест.
 */
function scrubSnapshots(db, playerId) {
  const rows = db.prepare('SELECT id, standings_json FROM rating_cache').all();
  const update = db.prepare('UPDATE rating_cache SET standings_json = ? WHERE id = ?');
  let touched = 0;
  for (const row of rows) {
    let data;
    try {
      data = JSON.parse(row.standings_json);
    } catch {
      continue;
    }
    let changed = false;
    for (const p of data.players || []) {
      if (p.playerId === playerId) {
        p.playerName = ERASED_LABEL;
        p.city = '';
        p.ageGroup = null;
        changed = true;
      }
    }
    if (changed) {
      update.run(JSON.stringify(data), row.id);
      touched += 1;
    }
  }
  return touched;
}

/**
 * ЖУРНАЛ ДЕЙСТВИЙ не удаляем: он подтверждает правомерность обработки, и
 * дыра в аудите — самостоятельная проблема. Но ФИО и почта из него уходят:
 * событие, автор и время остаются, личные значения заменяются на «[удалено]».
 */
function redactActionLog(db, playerId, secrets) {
  const rows = db.prepare('SELECT id, action FROM action_log').all();
  const update = db.prepare('UPDATE action_log SET action = ? WHERE id = ?');
  let touched = 0;
  for (const row of rows) {
    let text = row.action;
    const before = text;
    for (const secret of secrets) text = replaceAll(text, secret, REDACTED);
    if (text !== before) {
      update.run(text, row.id);
      touched += 1;
    }
  }
  return touched;
}

/**
 * СЕССИИ. Имя субъекта оседает не только в таблицах: оно попадает во
 * флеш-сообщения («Заявка одобрена, игрок «Иванов» заведён») и в черновики
 * форм, а те лежат в sessions.data. Пропустить это значит оставить ФИО в базе
 * при формально «удалённом» игроке.
 *
 * Сессии САМОГО игрока удаляем целиком — входить больше некуда. В чужих
 * сессиях (например, у секретаря) правим только текст: администратора не
 * выкидывает из админки, а имени в его сессии не остаётся.
 */
function scrubSessions(db, playerId, secrets) {
  const own = db
    .prepare('DELETE FROM sessions WHERE data LIKE ?')
    .run(`%"playerId":${Number(playerId)}%`).changes;
  const rows = db.prepare('SELECT sid, data FROM sessions').all();
  const update = db.prepare('UPDATE sessions SET data = ? WHERE sid = ?');
  let redacted = 0;
  for (const row of rows) {
    let text = row.data;
    const before = text;
    for (const secret of secrets) text = replaceAll(text, secret, REDACTED);
    if (text !== before) {
      update.run(text, row.sid);
      redacted += 1;
    }
  }
  return { own, redacted };
}

/**
 * Обезличивание игрока. Возвращает отчёт — что именно было затронуто; он идёт
 * в журнал действий, чтобы факт исполнения обращения был доказуем.
 *
 * VACUUM выполняется ПОСЛЕ транзакции и не просто для порядка: без него
 * затёртые строки остаются в свободных страницах файла БД, то есть физически
 * читаются из дампа. Для «необратимо» этого мало.
 */
export function erasePlayer(db, playerId, { uploadDir, actorUserId = null } = {}) {
  const player = db.prepare('SELECT * FROM players WHERE id = ?').get(playerId);
  if (!player) throw new Error('Игрок не найден');
  if (player.anonymized_at) return { alreadyErased: true };

  const account = db.prepare('SELECT * FROM player_accounts WHERE player_id = ?').get(playerId);
  // Всё, что нужно вычистить из текстов: имя и адреса, которыми субъект
  // фигурирует в журналах и письмах.
  const secrets = [player.full_name, account ? account.email : null].filter(Boolean);
  const registrationEmails = db
    .prepare('SELECT DISTINCT email FROM registrations WHERE player_id = ?')
    .all(playerId)
    .map((r) => r.email);
  for (const mail of registrationEmails) if (!secrets.includes(mail)) secrets.push(mail);

  const photoId = player.photo_upload_id;
  const report = { playerId, matchesKept: 0, resultsKept: 0 };

  const tx = db.transaction(() => {
    report.matchesKept = db
      .prepare('SELECT COUNT(*) AS n FROM matches WHERE winner_player_id = ? OR loser_player_id = ?')
      .get(playerId, playerId).n;
    report.resultsKept = db.prepare('SELECT COUNT(*) AS n FROM results WHERE player_id = ?').get(playerId).n;

    // 1. Личные поля в строке игрока — затираем. Пол оставляем: без имени,
    //    города и группы он никого не определяет, а схема требует M/F.
    db.prepare(
      `UPDATE players
          SET full_name = ?, city = ?, age_group = NULL, photo_upload_id = NULL,
              is_public = 0, anonymized_at = datetime('now')
        WHERE id = ?`,
    ).run(ERASED_LABEL, ERASED_CITY, playerId);

    // 2. Аккаунт: почта и хэш пароля уходят целиком — входа больше нет.
    report.accountRemoved = db.prepare('DELETE FROM player_accounts WHERE player_id = ?').run(playerId).changes;

    // 3. Записи согласий (ст. 21) и заявки — там лежат ФИО и почта.
    report.consentsRemoved = db.prepare('DELETE FROM consents WHERE player_id = ?').run(playerId).changes;
    report.registrationsRemoved = db.prepare('DELETE FROM registrations WHERE player_id = ?').run(playerId).changes;

    // 4. Очередь писем: в телах писем стоят имя и адрес.
    let mailRemoved = 0;
    for (const mail of registrationEmails.concat(account ? [account.email] : [])) {
      mailRemoved += db.prepare('DELETE FROM mail_outbox WHERE to_email = ?').run(mail).changes;
    }
    report.mailRemoved = mailRemoved;

    // 5. Снимки рейтинга, журнал действий и сессии.
    report.snapshotsScrubbed = scrubSnapshots(db, playerId);
    report.logEntriesRedacted = redactActionLog(db, playerId, secrets);
    const sessions = scrubSessions(db, playerId, secrets);
    report.sessionsRemoved = sessions.own;
    report.sessionsRedacted = sessions.redacted;
  });
  tx();

  // 6. Фото — файл с диска. Вне транзакции: файловая система в неё не входит.
  if (photoId && uploadDir) {
    try {
      report.photoRemoved = deleteUpload(db, photoId, uploadDir);
    } catch (err) {
      console.error('[забвение] не удалось удалить фото профиля', err);
      report.photoRemoved = false;
    }
  }

  // 7. VACUUM — обязателен: иначе затёртые строки остаются в свободных
  //    страницах файла и читаются из дампа. Внутри транзакции недопустим.
  try {
    db.exec('VACUUM');
    report.vacuumed = true;
  } catch (err) {
    console.error('[забвение] VACUUM не выполнен — старые страницы БД не освобождены', err);
    report.vacuumed = false;
  }

  // 8. ЧЕКПОЙНТ WAL С УСЕЧЕНИЕМ. Одного VACUUM мало: база работает в режиме WAL,
  //    и журнал упреждающей записи хранит ОБРАЗЫ СТРАНИЦ ДО правки — то есть
  //    затёртое имя продолжает лежать в файле .sqlite-wal и читается оттуда
  //    обычным grep. TRUNCATE переносит содержимое в основной файл и обнуляет
  //    журнал. Без этого «необратимо» — это только про SELECT, а не про диск.
  try {
    const [row] = db.pragma('wal_checkpoint(TRUNCATE)');
    report.walTruncated = Boolean(row) && row.busy === 0;
    if (!report.walTruncated) {
      console.error('[забвение] WAL не усечён: журнал занят, старые страницы остались в .sqlite-wal');
    }
  } catch (err) {
    console.error('[забвение] чекпойнт WAL не выполнен', err);
    report.walTruncated = false;
  }

  report.actorUserId = actorUserId;
  return report;
}

/**
 * Отзыв ВСЕХ сессий игрока, кроме текущей. Нужен при смене пароля: иначе тот,
 * кто уже сидит в кабинете с угнанной сессией, останется там и после того, как
 * владелец сменил пароль именно из-за этого.
 */
export function revokePlayerSessions(db, playerId, keepSid = null) {
  return db
    .prepare('DELETE FROM sessions WHERE sid IS NOT ? AND data LIKE ?')
    .run(keepSid, `%"playerId":${Number(playerId)}%`).changes;
}
