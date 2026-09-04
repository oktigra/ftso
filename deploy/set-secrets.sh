#!/usr/bin/env bash
# set-secrets.sh — ВРЕМЕННЫЙ пароль супер-админа и флаг приёма ПДн на бою.
# Пароль генерируется здесь, печатается ОДИН раз и пишется в базу (users.password_hash,
# must_change_password=1): при первом входе сайт пускает только на смену пароля.
# .env для пароля не трогаем — сайт читает пароли из базы, .env нужен лишь seed'у.
# Запуск root: bash /tmp/set-secrets.sh [--intake 0|1]
set -u
SITE="${SITE_DIR:-/var/www/ftso/site}"
E="${ENV_FILE:-$SITE/.env}"
DB="${DB_FILE:-$SITE/db/ftso.sqlite}"
ADMIN="${ADMIN_USERNAME:-admin}"
RUNAS="${SET_SECRETS_RUNAS-runuser -u ftso -- env HOME=/home/ftso}"
RESTART="${SET_SECRETS_RESTART-runuser -u ftso -- env HOME=/home/ftso PM2_HOME=/home/ftso/.pm2 bash -lc 'pm2 restart all >/dev/null; sleep 3; pm2 ls | grep -oE \"online|errored\" | sort | uniq -c'}"
INTAKE=""
while [ $# -gt 0 ]; do case "$1" in --intake) INTAKE="$2"; shift 2;; *) echo "неизвестный аргумент: $1"; exit 1;; esac; done
case "$INTAKE" in ""|0|1) ;; *) echo "СТОП: --intake только 0 или 1"; exit 1;; esac
[ -f "$DB" ] || { echo "СТОП: нет базы $DB"; exit 1; }
[ -f "$E" ] || { echo "СТОП: нет $E"; exit 1; }

P=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 14)
[ ${#P} -eq 14 ] || { echo "СТОП: не удалось сгенерировать пароль"; exit 1; }

# В базу — под пользователем сайта, чтобы WAL-файлы не стали root'овыми.
$RUNAS bash -c "cd '$SITE' && node -e '
const D = require(process.cwd() + \"/node_modules/better-sqlite3\");
import(process.cwd() + \"/server/lib/password.mjs\").then(({ hashPassword }) => {
  const db = new D(process.argv[1]);
  const cols = db.prepare(\"PRAGMA table_info(users)\").all().map((c) => c.name);
  if (!cols.includes(\"must_change_password\")) { console.log(\"СТОП: в базе нет колонки must_change_password — дождись выката миграции\"); process.exit(2); }
  const u = process.argv[2], h = hashPassword(process.argv[3]);
  const ex = db.prepare(\"SELECT id FROM users WHERE username = ?\").get(u);
  const role = process.argv[4];
  if (ex) db.prepare(\"UPDATE users SET password_hash = ?, role = ?, must_change_password = 1 WHERE id = ?\").run(h, role, ex.id);
  else db.prepare(\"INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)\").run(u, h, role);
  console.log(\"пользователь\", u, ex ? \"обновлён\" : \"создан\", \"(super-admin, временный пароль)\");
}).catch((e) => { console.log(\"СТОП:\", e.message); process.exit(1); });
' '$DB' '$ADMIN' '$P' super-admin" || exit 1

if [ -n "$INTAKE" ]; then
  if grep -qE '^INTAKE_ENABLED=' "$E"; then sed -i -E "s|^INTAKE_ENABLED=.*|INTAKE_ENABLED=$INTAKE|" "$E"; else echo "INTAKE_ENABLED=$INTAKE" >> "$E"; fi
  echo "INTAKE_ENABLED=$(grep -oE '^INTAKE_ENABLED=.*' "$E" | cut -d= -f2-)"
fi
[ -n "$RESTART" ] && bash -c "$RESTART"
echo
echo "ВРЕМЕННЫЙ ПАРОЛЬ для $ADMIN: $P"
echo "вход: /login → при первом входе сайт потребует придумать свой пароль (от 10 знаков)"
exit 0
