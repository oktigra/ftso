#!/usr/bin/env bash
# smtp-set.sh — вписать пароль ПРИЛОЖЕНИЯ Яндекса для отправки писем сайтом.
# Пароль ящика не трогает: пароль приложения — отдельный ключ рядом с обычным.
# Читается с терминала без эха, в вывод и в лог не попадает. После записи —
# рестарт pm2, проверка авторизации у почтового сервера и размер очереди писем.
# Запуск root: bash /tmp/smtp-set.sh          — спросить пароль, записать, перезапустить, проверить
#              bash /tmp/smtp-set.sh --check  — только проверить авторизацию и очередь (пароль не спрашивает)
set -u
SITE="${SITE_DIR:-/var/www/ftso/site}"; E="${ENV_FILE:-$SITE/.env}"
RUNAS="${SMTP_SET_RUNAS-runuser -u ftso -- env HOME=/home/ftso}"
RESTART="${SMTP_SET_RESTART-runuser -u ftso -- env HOME=/home/ftso PM2_HOME=/home/ftso/.pm2 bash -lc 'pm2 restart all >/dev/null; sleep 4'}"
VERIFY="${SMTP_SET_VERIFY-1}"
CHECK_ONLY=0; [ "${1:-}" = "--check" ] && CHECK_ONLY=1
[ -f "$E" ] || { echo "СТОП: нет $E"; exit 1; }
if [ "$CHECK_ONLY" = 0 ]; then
read -rsp 'пароль приложения Яндекса для info@ (ввод скрыт): ' P; echo
P=$(printf '%s' "$P" | tr -d ' \r')
case "$P" in "") echo "СТОП: пусто"; exit 1;; *[!A-Za-z0-9]*) echo "СТОП: пароль приложения — только латинские буквы и цифры"; exit 1;; esac
[ ${#P} -ge 12 ] || { echo "СТОП: короче 12 знаков — это не пароль приложения (у Яндекса 16)"; exit 1; }
if grep -qE '^SMTP_PASS=' "$E"; then sed -i -E "s|^SMTP_PASS=.*|SMTP_PASS=$P|" "$E"; else echo "SMTP_PASS=$P" >> "$E"; fi
grep -qE '^SMTP_USER=' "$E" || echo "SMTP_USER=info@ftso67.ru" >> "$E"
echo "записано: SMTP_USER=$(grep -oE '^SMTP_USER=.*' "$E" | cut -d= -f2-), пароль ${#P} зн."
unset P
[ -n "$RESTART" ] && bash -c "$RESTART"
fi
[ "$VERIFY" = 1 ] || exit 0
$RUNAS bash -c "cd '$SITE' && node -e '
import(process.cwd() + \"/server/lib/config.mjs\").then(async (c) => {
  c.loadEnvFile(); const s = c.loadConfig({ requireSecrets: false }).smtp;
  const n = (await import(\"nodemailer\")).default;
  const t = n.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: { user: s.user, pass: s.pass }, connectionTimeout: 15000, greetingTimeout: 15000 });
  try { await t.verify(); console.log(\"SMTP \" + s.user + \" через \" + s.host + \":\" + s.port + \": авторизация OK\"); }
  catch (e) { console.log(\"SMTP \" + s.user + \": \" + (e.responseCode ? e.responseCode + \" \" : \"\") + e.message); process.exit(1); }
  const D = require(process.cwd() + \"/node_modules/better-sqlite3\");
  const db = new D(process.cwd() + \"/db/ftso.sqlite\", { readonly: true });
  const q = db.prepare(\"SELECT status, COUNT(*) n FROM mail_outbox GROUP BY status\").all();
  console.log(\"очередь писем:\", q.length ? q.map((r) => r.status + \"=\" + r.n).join(\", \") : \"пусто\", \"— queued уйдут сами в ближайшие минуты\");
}).catch((e) => { console.log(\"ошибка проверки:\", e.message); process.exit(1); });
'"
