#!/usr/bin/env bash
# set-secrets.sh — смена пароля супер-админа (ввод без эха, в лог не пишется) и флага
# приёма ПДн на бою. Запуск root: bash /tmp/set-secrets.sh [--intake 0|1]
# Пароль читается с терминала, поэтому запускать ФАЙЛОМ, не через pipe.
set -u
E="${ENV_FILE:-/var/www/ftso/site/.env}"; INTAKE=""
RESTART="${SET_SECRETS_RESTART-runuser -u ftso -- env HOME=/home/ftso PM2_HOME=/home/ftso/.pm2 bash -lc 'pm2 restart all >/dev/null; sleep 3; pm2 ls | grep -oE \"online|errored\" | sort | uniq -c'}"
while [ $# -gt 0 ]; do case "$1" in --intake) INTAKE="$2"; shift 2;; *) echo "неизвестный аргумент: $1"; exit 1;; esac; done
[ -f "$E" ] || { echo "СТОП: нет $E"; exit 1; }
case "$INTAKE" in ""|0|1) ;; *) echo "СТОП: --intake только 0 или 1"; exit 1;; esac
read -rsp 'новый пароль супер-админа, от 12 знаков (ввод скрыт): ' P; echo
case "$P" in
  *[!A-Za-z0-9_.@#%^*+=-]*) echo "СТОП: допустимы буквы, цифры и _ . @ # % ^ * + = -"; exit 1;;
  ?????????????*) ;;
  *) echo "СТОП: короче 12 знаков"; exit 1;;
esac
if grep -qE '^SUPER_ADMIN_PASSWORD=' "$E"; then sed -i -E "s|^SUPER_ADMIN_PASSWORD=.*|SUPER_ADMIN_PASSWORD=$P|" "$E"; else echo "SUPER_ADMIN_PASSWORD=$P" >> "$E"; fi
echo "пароль записан: ${#P} зн."; unset P
if [ -n "$INTAKE" ]; then
  if grep -qE '^INTAKE_ENABLED=' "$E"; then sed -i -E "s|^INTAKE_ENABLED=.*|INTAKE_ENABLED=$INTAKE|" "$E"; else echo "INTAKE_ENABLED=$INTAKE" >> "$E"; fi
  echo "INTAKE_ENABLED=$(grep -oE '^INTAKE_ENABLED=.*' "$E" | cut -d= -f2-)"
fi
[ -n "$RESTART" ] && bash -c "$RESTART"
exit 0
