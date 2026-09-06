// АВТОПОСТ В КАНАЛ MAX (06.09.2026): бот федерации публикует пост в канал при публикации
// турнира, новости и при записи мест. API: POST https://platform-api2.max.ru/messages
// ?chat_id=… с заголовком Authorization: <token> (dev.max.ru/docs-api). Без токена и id
// канала — тихо ничего не делает. Отправка не блокирует ответ пользователю и не роняет
// сайт: ошибка пишется в журнал действий.
import { logAction } from './action-log.mjs';

export const MAX_API = 'https://platform-api2.max.ru';

export function maxEnabled(config) {
  return Boolean(config.maxBotToken && config.maxChatId);
}

/** Отправка поста. Возвращает { ok, status, error } — сам никогда не бросает. */
export async function postToMax(config, { text, url, button = 'Открыть на сайте' }, fetchImpl = globalThis.fetch) {
  if (!maxEnabled(config)) return { ok: false, status: 0, error: 'MAX не настроен' };
  const body = { text, format: 'markdown' };
  if (url) body.attachments = [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'link', text: button, url }]] } }];
  try {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetchImpl(`${MAX_API}/messages?chat_id=${encodeURIComponent(config.maxChatId)}`, {
      method: 'POST', headers: { Authorization: config.maxBotToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status, error: res.ok ? null : (await res.text()).slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err.message || err).slice(0, 200) };
  }
}

/** Кто бот (GET /me) — для проверки токена в админке. */
export async function maxWhoAmI(config, fetchImpl = globalThis.fetch) {
  if (!config.maxBotToken) return { ok: false, error: 'нет токена' };
  try {
    const res = await fetchImpl(`${MAX_API}/me`, { headers: { Authorization: config.maxBotToken } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const j = await res.json();
    return { ok: true, name: j.name, username: j.username };
  } catch (err) { return { ok: false, error: String(err.message || err).slice(0, 200) }; }
}

/** Найти канал, куда добавлен бот: GET /updates → события bot_added / bot_started с chat_id. */
export async function maxFindChats(config, fetchImpl = globalThis.fetch) {
  if (!config.maxBotToken) return { ok: false, error: 'нет токена', chats: [] };
  try {
    const res = await fetchImpl(`${MAX_API}/updates?limit=100`, { headers: { Authorization: config.maxBotToken } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, chats: [] };
    const j = await res.json();
    const chats = new Map();
    for (const u of j.updates || []) {
      const id = u.chat_id ?? u.chat?.chat_id ?? u.message?.recipient?.chat_id;
      if (id) chats.set(id, { chatId: id, title: u.chat?.title || u.message?.recipient?.chat_type || u.update_type });
    }
    return { ok: true, chats: [...chats.values()] };
  } catch (err) { return { ok: false, error: String(err.message || err).slice(0, 200), chats: [] }; }
}

/** Пост «в фоне»: результат — в журнал, вызывающему ждать не нужно. */
export function postInBackground(db, config, userId, kind, message, fetchImpl) {
  if (!maxEnabled(config)) return;
  postToMax(config, message, fetchImpl).then((r) => {
    logAction(db, userId, r.ok ? 'max.post' : 'max.post.failed', null, { kind, status: r.status, error: r.error, text: message.text.slice(0, 120) });
  }).catch(() => {});
}
