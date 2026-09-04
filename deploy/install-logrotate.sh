#!/usr/bin/env bash
# install-logrotate.sh — ставит /etc/logrotate.d/ftso из origin/main и проверяет
# dry-run самим logrotate. Заодно показывает, ротирует ли nginx свои логи
# (пакетный конфиг) — если его нет, IP посетителей копятся без срока.
set -u
U=ftso; ROOT=/var/www/ftso
gf(){ runuser -u "$U" -- git -C "$ROOT" "$@"; }
gf fetch -q origin main || { echo "СТОП: fetch не удался"; exit 1; }
gf show origin/main:deploy/logrotate-ftso > /tmp/logrotate-ftso 2>/dev/null && [ -s /tmp/logrotate-ftso ] || { echo "СТОП: нет origin/main:deploy/logrotate-ftso"; exit 1; }
logrotate -d /tmp/logrotate-ftso >/tmp/lr.out 2>&1 || { echo "СТОП: logrotate -d отверг конфиг:"; tail -5 /tmp/lr.out; exit 1; }
mv /tmp/logrotate-ftso /etc/logrotate.d/ftso && chmod 644 /etc/logrotate.d/ftso
md5sum /etc/logrotate.d/ftso | cut -c1-8
echo "dry-run: $(grep -c 'considering log' /tmp/lr.out) файлов под наблюдением, ошибок: $(grep -c '^error:' /tmp/lr.out)"
if [ -f /etc/logrotate.d/nginx ]; then echo "nginx: свой конфиг есть — $(grep -oE '^\s*(daily|weekly|rotate [0-9]+)' /etc/logrotate.d/nginx | tr -s ' \n' ' ')"; else echo "nginx: /etc/logrotate.d/nginx НЕТ — логи nginx не ротируются, сообщи в чат"; fi
echo "таймер logrotate: $(systemctl is-active logrotate.timer 2>/dev/null || echo 'нет systemd-таймера, смотри cron.daily')"
rm -f /tmp/lr.out
