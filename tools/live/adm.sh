# Сессия админки ФТСО: . adm.sh; aget /path; apost /path k=v ...
. ~/.secrets/ftso-admin.env
J=${FTSO_LIVE_DIR:-$HOME/ftso-live}/jar; mkdir -p "$(dirname $J)"
B=https://ftso67.ru
alogin() { rm -f $J; curl -s -c $J -b $J -m 30 $B/login -o /tmp/al.html; local cs=$(grep -o 'name="_csrf" value="[^"]*"' /tmp/al.html | head -1 | sed 's/.*value="//;s/"$//'); curl -s -c $J -b $J -m 30 -o /dev/null -w "login %{http_code}\n" --data-urlencode "_csrf=$cs" --data-urlencode "username=$FTSO_ADMIN_USER" --data-urlencode "password=$FTSO_ADMIN_PASS" $B/login; }
aget() { curl -s -c $J -b $J -m 60 "$B$1"; }
csrf() { aget "$1" | grep -o 'name="_csrf" value="[^"]*"' | head -1 | sed 's/.*value="//;s/"$//'; }
