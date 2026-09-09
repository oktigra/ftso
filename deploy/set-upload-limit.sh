#!/usr/bin/env bash
# set-upload-limit.sh — поднимает client_max_body_size в серверном блоке ftso67.ru.
# Зачем: nginx по умолчанию режет тело на 1 МБ (замер 09.09.2026: 1048576 проходит,
# 1100000 → 413), а форма галереи принимает до десяти кадров за раз. Пачка из шести
# снимков на 2,5 МБ отлетала с 413 ДО приложения — секретарь видел ошибку nginx.
# Идемпотентен: повторный запуск ничего не портит. Ничего не перезапускает, кроме
# reload nginx, и только после nginx -t.
set -u
LIMIT=${LIMIT:-64m}
NGDIR=${NGDIR:-/etc/nginx/sites-enabled}
BAKDIR=${BAKDIR:-/var/backups}
[ -d "$NGDIR" ] || { echo "СТОП: нет $NGDIR — не тот сервер?"; exit 1; }

# Ищем конфиг, где упомянут домен: правим ровно его, а не все подряд.
# -R идёт по симлинкам (в sites-enabled лежат они), .bak исключаем — иначе повторный
# запуск найдёт собственный бэкап и начнёт править его (поймано на стенде 09.09.2026).
FILE=$(grep -Rl "ftso67\.ru" "$NGDIR"/ 2>/dev/null | grep -v "\.bak" | head -1)
[ -n "$FILE" ] || { echo "СТОП: не нашёл конфиг с ftso67.ru в $NGDIR"; exit 1; }
FILE=$(readlink -f "$FILE")
echo "конфиг: $FILE"

if grep -qE "^[[:space:]]*client_max_body_size" "$FILE"; then
  CUR=$(grep -oE "client_max_body_size[[:space:]]+[^;]+" "$FILE" | head -1 | awk '{print $2}')
  if [ "$CUR" = "$LIMIT" ]; then echo "уже стоит $LIMIT — менять нечего"; nginx -t && exit 0; fi
  cp -a "$FILE" "$BAKDIR/$(basename "$FILE").bak-$(date +%Y%m%d-%H%M%S)"
  sed -i -E "s/^([[:space:]]*)client_max_body_size[[:space:]]+[^;]+;/\1client_max_body_size $LIMIT;/" "$FILE"
  echo "заменено: $CUR -> $LIMIT"
else
  cp -a "$FILE" "$BAKDIR/$(basename "$FILE").bak-$(date +%Y%m%d-%H%M%S)"
  # Вставляем первой строкой внутрь ПЕРВОГО server{} — там же, где живёт домен.
  awk -v lim="$LIMIT" 'BEGIN{done=0} {print} /^[[:space:]]*server[[:space:]]*\{/ && !done {print "    client_max_body_size " lim ";"; done=1}' "$FILE" > /tmp/ftso-nginx.new
  grep -q "client_max_body_size $LIMIT;" /tmp/ftso-nginx.new || { echo "СТОП: строка не вставилась, конфиг не тронут"; exit 1; }
  cat /tmp/ftso-nginx.new > "$FILE"
  echo "добавлено: client_max_body_size $LIMIT"
fi

nginx -t || { echo "СТОП: nginx -t недоволен — верни файл из $BAKDIR и сообщи в чат"; exit 1; }
systemctl reload nginx || { echo "СТОП: reload не прошёл"; exit 1; }

# Приложение должно знать тот же потолок: форма галереи печатает его в подсказке и
# не даёт отправить пачку крупнее. Иначе секретарь упирается в сырую страницу 413.
ENV_FILE=${ENV_FILE:-/var/www/ftso/site/.env}
MB=${LIMIT%m}
if [ -f "$ENV_FILE" ] && [ -n "$MB" ] && [ "$MB" -eq "$MB" ] 2>/dev/null; then
  # Запас 4 МБ: nginx считает всё тело, а в нём ещё границы и поля формы.
  APP_MB=$(( MB > 4 ? MB - 4 : MB ))
  if grep -qE "^UPLOAD_MAX_MB=" "$ENV_FILE"; then
    sed -i -E "s/^UPLOAD_MAX_MB=.*/UPLOAD_MAX_MB=$APP_MB/" "$ENV_FILE"
  else
    printf 'UPLOAD_MAX_MB=%s\n' "$APP_MB" >> "$ENV_FILE"
  fi
  echo "в $ENV_FILE: UPLOAD_MAX_MB=$APP_MB"
  if [ "${RESTART_APP:-1}" = "1" ]; then
    runuser -u ftso -- env HOME=/home/ftso PM2_HOME=/home/ftso/.pm2 bash -lc 'pm2 restart all' >/dev/null 2>&1 \
      && echo "приложение перезапущено (pm2)" || echo "ВНИМАНИЕ: pm2 restart не прошёл — подсказка в форме останется старой"
  fi
else
  echo "ВНИМАНИЕ: $ENV_FILE не найден — UPLOAD_MAX_MB не записан, форма продолжит обещать прежний потолок"
fi

echo "готово; проверка:"
grep -nE "client_max_body_size" "$FILE"
