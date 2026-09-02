#!/usr/bin/env bash
# install.sh — одноразовая установка выката без человека на боевой ФТСО.
# Берёт три файла из origin/main:deploy/ (fetch уже сделан вызывающей командой),
# кладёт в /root и /etc/systemd/system, сверяет md5, включает таймер.
# Ничего не включает, если хоть один файл не приехал (сторож закрыт).
set -u
U=ftso; ROOT=/var/www/ftso; SYS=/etc/systemd/system
gf(){ runuser -u "$U" -- git -C "$ROOT" "$@"; }
for f in deploy-watch.sh ftso-deploy.service ftso-deploy.timer; do
  gf show "origin/main:deploy/$f" > "/tmp/$f" 2>/dev/null && [ -s "/tmp/$f" ] || { echo "СТОП: нет origin/main:deploy/$f — ничего не ставлю"; exit 1; }
done
bash -n /tmp/deploy-watch.sh || { echo "СТОП: deploy-watch.sh не проходит bash -n"; exit 1; }
[ -f /root/deploy-A.sh ] || { echo "СТОП: нет /root/deploy-A.sh — таймеру нечего звать"; exit 1; }
mv /tmp/deploy-watch.sh /root/deploy-watch.sh
mv /tmp/ftso-deploy.service /tmp/ftso-deploy.timer "$SYS/"
chmod 700 /root/deploy-watch.sh
md5sum /root/deploy-watch.sh "$SYS/ftso-deploy.service" "$SYS/ftso-deploy.timer" | cut -c1-8,33-
systemctl daemon-reload && systemctl enable -q --now ftso-deploy.timer || { echo "СТОП: таймер не включился"; exit 1; }
echo "таймер: $(systemctl is-active ftso-deploy.timer); первый тик — сразу, дальше каждые 2 мин; лог: /root/deploy-watch.log"
