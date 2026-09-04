#!/usr/bin/env bash
# backup.sh — ЕЖЕДНЕВНАЯ КОПИЯ ДАННЫХ ФТСО НА САМОМ СЕРВЕРЕ.
#   БД        — sqlite backup API (better-sqlite3 из site/node_modules): консистентно при WAL и
#               работающем pm2; вместе с папкой 152-ФЗ уходит в tar.gz с датой, хранится KEEP.
#   Загрузки  — ИНКРЕМЕНТНЫЕ снимки: $DEST/uploads/<дата>/ через rsync --link-dest (жёсткие
#               ссылки на предыдущий снимок): 14 снимков занимают место одной копии + новые файлы.
#               Файлы загрузок не меняются после записи, поэтому это точная полная копия на любую
#               дату. Без rsync — cp -al + cp -a (тот же эффект). Хранится KEEP снимков.
# Восстановление: tar.gz → ftso.sqlite и 152fz/; загрузки — целиком из $DEST/uploads/<дата>/.
# Первая ступень: от сломанной миграции и рук. От потери VPS — «Аварийная копия» Timeweb.
# ИСТОЧНИК — deploy/backup.sh в репозитории; копию /root/backup.sh обновляет deploy-watch.sh.
# Пути переопределяемы через окружение — для приёмки; в бою значения по умолчанию.
set -u
SITE="${BACKUP_SITE:-/var/www/ftso/site}"
DB="${BACKUP_DB:-$SITE/db/ftso.sqlite}"
UPL="${BACKUP_UPLOADS:-$SITE/storage/uploads}"
DOCS="${BACKUP_DOCS:-/home/ftso/152fz}"
DEST="${BACKUP_DEST:-/var/backups/ftso}"
KEEP="${BACKUP_KEEP:-14}"
LOG="${BACKUP_LOG:-/root/backup.log}"
NODE="${BACKUP_NODE:-node}"
now(){ date '+%Y-%m-%d %H:%M:%S'; }

[ -f "$DB" ] || { echo "$(now) СТОП: нет БД $DB" >>"$LOG"; exit 1; }
mkdir -p "$DEST/uploads" && chmod 700 "$DEST" "$DEST/uploads"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/ftso-backup.XXXXXX"); trap 'rm -rf "$TMP"' EXIT
STAMP=$(date +%Y-%m-%d_%H%M%S)

# 1. консистентная копия БД (backup API, не cp: cp при WAL даёт рваный файл)
"$NODE" -e '
  const D = require(process.argv[1] + "/node_modules/better-sqlite3");
  new D(process.argv[2], { readonly: true }).backup(process.argv[3])
    .then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
' "$SITE" "$DB" "$TMP/ftso.sqlite" 2>>"$LOG" || { echo "$(now) СТОП: копия БД не удалась (см. выше)" >>"$LOG"; exit 1; }

# 2. документы 152-ФЗ (мелкие) — в тот же архив
if [ -d "$DOCS" ]; then cp -a "$DOCS" "$TMP/152fz"; else mkdir "$TMP/152fz"; fi

# 3. архив БД + документы
OUT="$DEST/ftso-$STAMP.tar.gz"
tar -C "$TMP" -czf "$OUT" ftso.sqlite 152fz && chmod 600 "$OUT" \
  || { echo "$(now) СТОП: архив не собрался" >>"$LOG"; rm -f "$OUT"; exit 1; }

# 4. загрузки — инкрементный снимок на жёстких ссылках
SNAP="$DEST/uploads/$STAMP"
PREV=$(ls -1d "$DEST"/uploads/*/ 2>/dev/null | sort | tail -1)
if [ -d "$UPL" ]; then
  if command -v rsync >/dev/null 2>&1; then
    if [ -n "$PREV" ]; then rsync -a --link-dest="$PREV" "$UPL/" "$SNAP/"; else rsync -a "$UPL/" "$SNAP/"; fi \
      || { echo "$(now) СТОП: снимок загрузок (rsync) не удался" >>"$LOG"; rm -rf "$SNAP"; exit 1; }
  else
    if [ -n "$PREV" ]; then cp -al "$PREV" "$SNAP"; else mkdir -p "$SNAP"; fi
    # -u: файл с той же датой не перезаписывается — жёсткие ссылки на прошлый снимок сохраняются
    cp -au "$UPL/." "$SNAP/" || { echo "$(now) СТОП: снимок загрузок (cp) не удался" >>"$LOG"; rm -rf "$SNAP"; exit 1; }
  fi
else
  mkdir -p "$SNAP"
fi
chmod 700 "$SNAP"

# 5. ротация: KEEP архивов и KEEP снимков
ls -1t "$DEST"/ftso-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1d "$DEST"/uploads/*/ 2>/dev/null | sort | head -n -"$KEEP" | xargs -r rm -rf
FILES=$(find "$SNAP" -type f | wc -l); USED=$(du -sh "$DEST" | cut -f1)
echo "$(now) $OUT $(du -h "$OUT" | cut -f1); загрузки: снимок $STAMP, файлов $FILES; всего $DEST занимает $USED; хранится $(ls -1 "$DEST"/ftso-*.tar.gz | wc -l) архивов и $(ls -1d "$DEST"/uploads/*/ | wc -l) снимков из $KEEP" >>"$LOG"
