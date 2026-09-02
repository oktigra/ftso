#!/usr/bin/env bash
# deploy-watch.sh — ВЫКАТ ФТСО БЕЗ ЧЕЛОВЕКА. Аналог pull_deploy.sh у WGR.
#
# Раз в 2 минуты (systemd-таймер ftso-deploy.timer) делает git fetch и сравнивает
# origin/main с HEAD боевого клона. Разошлись — зовёт /root/deploy-A.sh (у него
# бэкап БД, npm install, миграции, рестарт pm2, авто-откат при не-200).
# Токенов не ест — обычный git, как orch-bridge на BG-VPS.
#
# Сторож закрыт:
#  - fetch не удался (сеть) — запись в лог и выход, следующий тик попробует снова;
#  - выкат SHA упал и откатился — тот же SHA второй раз НЕ пробуем (иначе петля
#    рестартов каждые 2 минуты); ждём нового коммита в main;
#  - два запуска разом невозможны (flock).
#
# Ставится ОДИН раз: файлы из /var/www/ftso/deploy — в /root и /etc/systemd/system,
# затем systemctl enable --now ftso-deploy.timer. Дальше люди в выкате не участвуют.
set -u
U=ftso
ROOT=/var/www/ftso
DEPLOY=/root/deploy-A.sh
LOG=/root/deploy-watch.log
STATE=/root/deploy-watch.last

exec 9>/root/deploy-watch.lock
flock -n 9 || exit 0

gf(){ runuser -u "$U" -- git -C "$ROOT" "$@"; }
now(){ date '+%Y-%m-%d %H:%M:%S'; }

if ! gf fetch -q origin main 2>>"$LOG"; then
  echo "$(now) fetch не удался — жду следующего тика" >>"$LOG"; exit 0
fi
NEW=$(gf rev-parse --short=7 origin/main) || exit 0
CUR=$(gf rev-parse --short=7 HEAD) || exit 0
[ "$NEW" = "$CUR" ] && exit 0

LAST=$(cat "$STATE" 2>/dev/null || true)
if [ "$NEW" = "$LAST" ]; then
  exit 0   # этот SHA уже пробовали, он не встал — молчим до нового коммита
fi
echo "$NEW" >"$STATE"

[ -f "$DEPLOY" ] || { echo "$(now) СТОП: нет $DEPLOY" >>"$LOG"; exit 0; }
echo "$(now) $CUR -> $NEW: выкат" >>"$LOG"
sed -i 's/\r$//' "$DEPLOY"
bash "$DEPLOY" >>"$LOG" 2>&1
RC=$?
echo "$(now) deploy-A.sh код $RC; HEAD теперь $(gf rev-parse --short=7 HEAD)" >>"$LOG"
