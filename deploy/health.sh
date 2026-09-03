#!/usr/bin/env bash
# health.sh — ЗДОРОВЬЕ ВЫКАТА ФТСО. Код 0 — всё отвечает 200, иначе 1.
#
# Проверяет три двери, а не одну:
#   /         — главная;
#   /rating   — витрина рейтинга (падает первой при ошибках в БД/шаблоне);
#   /player/N — первый публичный профиль из таблицы рейтинга (первая ссылка
#               href="/player/N" на /rating). Пока игроков в рейтинге нет —
#               проверка пропускается с явной строкой, это не ошибка.
#
# Зовётся из deploy-A.sh после рестарта pm2 (не-0 → авто-откат) и из приёмки
# (site/acceptance.mjs) против тестового приложения.
# Использование: bash deploy/health.sh [BASE_URL]   по умолчанию http://127.0.0.1:3000
set -u
BASE="${1:-http://127.0.0.1:3000}"
code(){ curl -s -o /dev/null -m 10 -w '%{http_code}' "$BASE$1"; }

rc=0
for p in / /rating; do
  c=$(code "$p"); echo "HTTP $p = $c"
  [ "$c" = "200" ] || rc=1
done
[ "$rc" = 0 ] || exit 1

first=$(curl -s -m 10 "$BASE/rating" | grep -oE 'href="/player/[0-9]+"' | head -1 | grep -oE '/player/[0-9]+')
if [ -n "$first" ]; then
  c=$(code "$first"); echo "HTTP $first = $c (первый профиль из рейтинга)"
  [ "$c" = "200" ] || exit 1
else
  echo "профилей в рейтинге нет — проверку первого профиля пропускаю"
fi
exit 0
