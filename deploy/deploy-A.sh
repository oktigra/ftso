#!/usr/bin/env bash
# Выкат раздела A на боевой ftso67: код -> origin/main, зависимости, миграции,
# рестарт pm2, проверка здоровья (/, /rating, первый профиль — deploy/health.sh).
# При любом сбое или не-200 — авто-откат на прежний код.
# Запуск из-под root:  bash /root/deploy-A.sh
# ИСТОЧНИК — deploy/deploy-A.sh в репозитории oktigra/ftso; копию в /root
# обновляет deploy-watch.sh из origin/main перед каждым выкатом. Руками в /root не править.
U=ftso
ROOT=/var/www/ftso
SITE="$ROOT/site"
PORT=3000
LOG=/root/deploy-A.log
: > "$LOG"

say(){ printf '>> %s\n' "$*"; }
# git как ftso (владелец дерева -> без safe.directory)
gf(){ runuser -u "$U" -- git -C "$ROOT" "$@"; }
# npm/pm2 как ftso в ЛОГИН-окружении (грузит PATH/nvm) с явными HOME и PM2_HOME
nf(){ runuser -u "$U" -- env HOME="/home/$U" PM2_HOME="/home/$U/.pm2" bash -lc "cd '$SITE' && $*"; }
http(){ curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/"; }

rollback(){
  say "ОТКАТ на ${OLD:0:7} ..."
  gf reset --hard "$OLD" >>"$LOG" 2>&1
  nf 'npm install' >>"$LOG" 2>&1
  nf 'pm2 restart all' >>"$LOG" 2>&1
  sleep 3
  say "после отката HTTP = $(http) (ждём 200 — прежний код вернулся)"
  say "детали в $LOG"
}

# 0. точка отката + чистота дерева
OLD=$(gf rev-parse HEAD) || { say "СТОП: git недоступен"; exit 1; }
say "откат-точка: ${OLD:0:7}"
DIRTY=$(gf status --porcelain -uno)
if [ -n "$DIRTY" ]; then say "СТОП: есть изменённые отслеживаемые файлы (reset их затрёт), не трогаю:"; echo "$DIRTY"; exit 1; fi

# 1. бэкап БД (если есть)
DB="$SITE/db/ftso.sqlite"
if [ -f "$DB" ]; then
  BK="$DB.predeploy.$(date +%Y%m%d%H%M%S)"
  runuser -u "$U" -- cp -p "$DB" "$BK" && say "БД -> $(basename "$BK")" || { say "СТОП: не смог сделать бэкап БД"; exit 1; }
else
  say "БД-файл $DB не найден — пропускаю бэкап"
fi

# 2. код на origin/main
NEW=$(gf rev-parse --short origin/main)
say "код: ${OLD:0:7} -> $NEW"
gf reset --hard origin/main >>"$LOG" 2>&1 || { say "СТОП: git reset упал (см. $LOG)"; exit 1; }

# 3. зависимости
say "зависимости (npm install, лог в $LOG) ..."
nf 'npm install' >>"$LOG" 2>&1 || { say "npm упал"; rollback; exit 1; }

# 4. миграции
say "миграции (лог в $LOG) ..."
nf 'npm run migrate' >>"$LOG" 2>&1 || { say "migrate упал"; rollback; exit 1; }

# 5. рестарт pm2
say "рестарт pm2 ..."
nf 'pm2 restart all' >>"$LOG" 2>&1 || { say "pm2 restart упал"; rollback; exit 1; }

# 6. проверка здоровья: /, /rating и первый профиль — deploy/health.sh из репо
#    (версионирован вместе с кодом). Файла нет в дереве — прежняя проверка только /.
sleep 3
HEALTH="$ROOT/deploy/health.sh"
if [ -f "$HEALTH" ]; then
  OUT=$(bash "$HEALTH" "http://127.0.0.1:$PORT" 2>&1); RC=$?
  printf '%s\n' "$OUT" | sed 's/^/>> /'
  if [ "$RC" != "0" ]; then say "здоровье выката не подтверждено (см. строки выше)"; rollback; exit 1; fi
else
  CODE=$(http)
  say "HTTP / = $CODE (deploy/health.sh в дереве нет — старая проверка одной двери)"
  if [ "$CODE" != "200" ]; then say "сайт не отвечает 200"; rollback; exit 1; fi
fi

say "ГОТОВО: раздел A ($NEW) на бою, HTTP 200."
say "откат вручную при нужде: runuser -u $U -- git -C $ROOT reset --hard ${OLD:0:7} && рестарт pm2"
