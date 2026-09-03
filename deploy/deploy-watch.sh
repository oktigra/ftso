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
#  - дифф только из памяти (закрытие сессии ритуалом: sessions/, ritual/,
#    NEXT_CHAT_START.md) — код НЕ менялся: подтягиваем fast-forward и НЕ трогаем
#    pm2, иначе каждый ритуал давал бы пустой рестарт боевого процесса;
#  - выкат SHA упал и откатился — тот же SHA второй раз НЕ пробуем (иначе петля
#    рестартов каждые 2 минуты); ждём нового коммита в main;
#  - два запуска разом невозможны (flock).
#
# Ставится ОДИН раз: файлы из /var/www/ftso/deploy — в /root и /etc/systemd/system,
# затем systemctl enable --now ftso-deploy.timer. Дальше люди в выкате не участвуют.
# Пути и запуск переопределяемы через окружение — только чтобы приёмка могла
# прогнать логику на временном репозитории; в бою действуют значения по умолчанию.
set -u
U="${DEPLOY_USER:-ftso}"
ROOT="${DEPLOY_ROOT:-/var/www/ftso}"
DEPLOY="${DEPLOY_SCRIPT:-/root/deploy-A.sh}"
LOG="${DEPLOY_LOG:-/root/deploy-watch.log}"
STATE="${DEPLOY_STATE:-/root/deploy-watch.last}"
LOCK="${DEPLOY_LOCK:-/root/deploy-watch.lock}"
# В бою git идёт от пользователя ftso; в приёмке DEPLOY_RUNAS="" отключает runuser.
RUNAS="${DEPLOY_RUNAS-runuser -u $U --}"
# Пути памяти: их дифф не требует рестарта pm2 (расширяемо через DEPLOY_MEM_RE).
MEM_RE="${DEPLOY_MEM_RE:-^(sessions/|ritual/|NEXT_CHAT_START\.md$)}"

exec 9>"$LOCK"
flock -n 9 || exit 0

gf(){ $RUNAS git -C "$ROOT" "$@"; }
now(){ date '+%Y-%m-%d %H:%M:%S'; }

if ! gf fetch -q origin main 2>>"$LOG"; then
  echo "$(now) fetch не удался — жду следующего тика" >>"$LOG"; exit 0
fi
NEW=$(gf rev-parse --short=7 origin/main) || exit 0
CUR=$(gf rev-parse --short=7 HEAD) || exit 0
[ "$NEW" = "$CUR" ] && exit 0

# Только память? Весь дифф CUR..NEW попадает в MEM_RE — код не тронут: ff без pm2.
CHANGED=$(gf diff --name-only "$CUR" "$NEW" 2>>"$LOG")
if [ -n "$CHANGED" ] && ! printf '%s\n' "$CHANGED" | grep -qvE "$MEM_RE"; then
  if gf merge --ff-only origin/main >>"$LOG" 2>&1; then
    echo "$(now) $CUR -> $NEW: только память ($(printf '%s' "$CHANGED" | tr '\n' ' ')), pm2 не трогаю" >>"$LOG"
  else
    echo "$(now) $CUR -> $NEW: только память, но ff не удался — оставляю следующему тику" >>"$LOG"
  fi
  exit 0
fi

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
