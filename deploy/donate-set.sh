#!/usr/bin/env bash
# donate-set.sh — включить QR пожертвований и взносов на бою: реквизиты федерации в .env,
# рестарт pm2, проверка, что /donate отдаёт 200 и подвал показывает QR.
# Реквизиты — из карточки организации РФСОО «ФТСО» (Альфа-Банк), ключи счетов сверены 19.09.2026.
# Запуск root: bash /tmp/donate-set.sh
set -u
SITE="${SITE_DIR:-/var/www/ftso/site}"
E="${ENV_FILE:-$SITE/.env}"
RESTART="${DONATE_RESTART-runuser -u ftso -- env HOME=/home/ftso PM2_HOME=/home/ftso/.pm2 bash -lc 'pm2 restart all --update-env >/dev/null; sleep 4; pm2 ls | grep -oE \"online|errored\" | sort | uniq -c'}"
CHECK_URL="${DONATE_CHECK_URL:-https://ftso67.ru}"
[ -f "$E" ] || { echo "СТОП: нет $E"; exit 1; }

set_kv() { # ключ значение — заменить строку или дописать; старую копию .env оставляем рядом
  local k="$1" v="$2"
  if grep -qE "^$k=" "$E"; then sed -i "s|^$k=.*|$k=$v|" "$E"; else printf '%s=%s\n' "$k" "$v" >> "$E"; fi
}
cp -p "$E" "$E.bak-donate-$(date +%Y%m%d%H%M%S)"
set_kv DONATE_ACCOUNT 40703810781870000003
set_kv DONATE_BIC     044525593
set_kv DONATE_BANK    'АО «Альфа-Банк»'
set_kv DONATE_CORR    30101810200000000593
# Размер членского взноса федерация ещё не назвала — плательщик вводит сам. Когда назовут:
# bash /tmp/donate-set.sh, предварительно вписав сюда сумму, либо руками DUES_AMOUNT=1500.
grep -qE '^DUES_AMOUNT=' "$E" || printf 'DUES_AMOUNT=\n' >> "$E"
echo "в .env записано:"; grep -E '^(DONATE_|DUES_)' "$E"

echo "рестарт:"; eval "$RESTART"
sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$CHECK_URL/donate")
qr=$(curl -s --max-time 15 "$CHECK_URL/" | grep -c 'footer-donate__qr--donate')
echo "/donate → $code (нужно 200); QR в подвале главной → $qr (нужно 1)"
[ "$code" = "200" ] && [ "$qr" = "1" ] && echo "ГОТОВО: пожертвования и взносы включены" || echo "СТОП: не включилось — пришли этот вывод"
