#!/usr/bin/env bash
# rename-user.sh — переименовать пользователя админки на бою (пароль и роль не трогает).
# Запуск root: bash /tmp/rename-user.sh <старый_логин> <новый_логин>
# Если новый логин — супер-админ, имя фиксируется в .env (SUPER_ADMIN_USERNAME) для set-secrets.sh.
set -u
SITE="${SITE_DIR:-/var/www/ftso/site}"; E="${ENV_FILE:-$SITE/.env}"; DB="${DB_FILE:-$SITE/db/ftso.sqlite}"
RUNAS="${RENAME_RUNAS-runuser -u ftso -- env HOME=/home/ftso}"
OLD="${1:-}"; NEW="${2:-}"
[ -n "$OLD" ] && [ -n "$NEW" ] || { echo "использование: rename-user.sh <старый> <новый>"; exit 1; }
case "$NEW" in *[!A-Za-z0-9_.-]*) echo "СТОП: логин — латиница, цифры, _ . -"; exit 1;; esac
[ -f "$DB" ] || { echo "СТОП: нет базы $DB"; exit 1; }
OUT=$($RUNAS bash -c "cd '$SITE' && node -e '
const D = require(process.cwd() + \"/node_modules/better-sqlite3\");
const db = new D(process.argv[1]); const [o, n] = [process.argv[2], process.argv[3]];
if (db.prepare(\"SELECT 1 FROM users WHERE username = ?\").get(n)) { console.log(\"СТОП: логин\", n, \"уже занят\"); process.exit(1); }
const row = db.prepare(\"SELECT role FROM users WHERE username = ?\").get(o);
if (!row) { console.log(\"СТОП: нет пользователя\", o); process.exit(1); }
db.prepare(\"UPDATE users SET username = ? WHERE username = ?\").run(n, o);
console.log(\"переименовано:\", o, \"->\", n, \"(\" + row.role + \")\");
console.log(\"ROLE=\" + row.role);
' '$DB' '$OLD' '$NEW'") || { echo "$OUT"; exit 1; }
echo "$OUT" | grep -v '^ROLE='
if echo "$OUT" | grep -q '^ROLE=super-admin$' && [ -f "$E" ]; then
  if grep -qE '^SUPER_ADMIN_USERNAME=' "$E"; then sed -i -E "s|^SUPER_ADMIN_USERNAME=.*|SUPER_ADMIN_USERNAME=$NEW|" "$E"; else echo "SUPER_ADMIN_USERNAME=$NEW" >> "$E"; fi
  echo ".env: $(grep -E '^SUPER_ADMIN_USERNAME=' "$E")"
fi
exit 0
