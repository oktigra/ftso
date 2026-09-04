#!/usr/bin/env bash
# backup.sh — ЕЖЕДНЕВНАЯ КОПИЯ ДАННЫХ ФТСО НА САМОМ СЕРВЕРЕ: БД + загрузки.
# Зовётся таймером ftso-backup.timer (03:30 МСК, Persistent). Копия БД — через
# sqlite backup API (better-sqlite3 из site/node_modules): консистентна даже при
# работающем pm2 и WAL. Архив в /var/backups/ftso, хранится KEEP свежих.
# Это первая ступень: защищает от сломанной миграции и удаления руками.
# От потери самого VPS не защищает — офсайт остаётся за владельцем.
# ИСТОЧНИК — deploy/backup.sh в репозитории; копию /root/backup.sh обновляет
# deploy-watch.sh из origin/main. Пути переопределяемы через окружение — для
# приёмки; в бою действуют значения по умолчанию.
set -u
SITE="${BACKUP_SITE:-/var/www/ftso/site}"
DB="${BACKUP_DB:-$SITE/db/ftso.sqlite}"
UPL="${BACKUP_UPLOADS:-$SITE/storage/uploads}"
# Папка документов 152-ФЗ (справки, приказы, уведомления) — вне git и вне webroot; берём, если есть.
DOCS="${BACKUP_DOCS:-/home/ftso/152fz}"
DEST="${BACKUP_DEST:-/var/backups/ftso}"
KEEP="${BACKUP_KEEP:-14}"
LOG="${BACKUP_LOG:-/root/backup.log}"
NODE="${BACKUP_NODE:-node}"
now(){ date '+%Y-%m-%d %H:%M:%S'; }

[ -f "$DB" ] || { echo "$(now) СТОП: нет БД $DB" >>"$LOG"; exit 1; }
mkdir -p "$DEST" && chmod 700 "$DEST"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ftso-backup.XXXXXX"); trap 'rm -rf "$TMP"' EXIT

# 1. консистентная копия БД (backup API, не cp: cp при WAL даёт рваный файл)
"$NODE" -e '
  const D = require(process.argv[1] + "/node_modules/better-sqlite3");
  new D(process.argv[2], { readonly: true }).backup(process.argv[3])
    .then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
' "$SITE" "$DB" "$TMP/ftso.sqlite" 2>>"$LOG" || { echo "$(now) СТОП: копия БД не удалась (см. выше)" >>"$LOG"; exit 1; }

# 2. загрузки
if [ -d "$UPL" ]; then cp -a "$UPL" "$TMP/uploads"; else mkdir "$TMP/uploads"; fi

# 2а. документы 152-ФЗ (если папка заведена)
if [ -d "$DOCS" ]; then cp -a "$DOCS" "$TMP/152fz"; else mkdir "$TMP/152fz"; fi

# 3. архив с датой и временем
STAMP=$(date +%Y-%m-%d_%H%M%S)
OUT="$DEST/ftso-$STAMP.tar.gz"
tar -C "$TMP" -czf "$OUT" ftso.sqlite uploads 152fz && chmod 600 "$OUT" \
  || { echo "$(now) СТОП: архив не собрался" >>"$LOG"; rm -f "$OUT"; exit 1; }

# 4. ротация: оставить KEEP самых свежих
ls -1t "$DEST"/ftso-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$(now) $OUT $(du -h "$OUT" | cut -f1); хранится $(ls -1 "$DEST"/ftso-*.tar.gz | wc -l) из $KEEP" >>"$LOG"
