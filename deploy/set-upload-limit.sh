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
echo "готово; проверка:"
grep -nE "client_max_body_size" "$FILE"
