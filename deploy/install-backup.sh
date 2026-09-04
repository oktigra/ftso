#!/usr/bin/env bash
# install-backup.sh — одноразовая установка ежедневного бэкапа на боевой ФТСО.
# Берёт три файла из origin/main:deploy/ (fetch делает сама), кладёт в /root и
# /etc/systemd/system, сверяет md5, делает ПЕРВУЮ копию сразу и включает таймер.
# Дальше /root/backup.sh обновляет deploy-watch.sh из origin/main.
set -u
U=ftso; ROOT=/var/www/ftso; SYS=/etc/systemd/system
gf(){ runuser -u "$U" -- git -C "$ROOT" "$@"; }
gf fetch -q origin main || { echo "СТОП: fetch не удался"; exit 1; }
for f in backup.sh ftso-backup.service ftso-backup.timer; do
  gf show "origin/main:deploy/$f" > "/tmp/$f" 2>/dev/null && [ -s "/tmp/$f" ] || { echo "СТОП: нет origin/main:deploy/$f — ничего не ставлю"; exit 1; }
done
bash -n /tmp/backup.sh || { echo "СТОП: backup.sh не проходит bash -n"; exit 1; }
mv /tmp/backup.sh /root/backup.sh && chmod 700 /root/backup.sh
mv /tmp/ftso-backup.service /tmp/ftso-backup.timer "$SYS/"
md5sum /root/backup.sh "$SYS/ftso-backup.service" "$SYS/ftso-backup.timer" | cut -c1-8,33-
bash /root/backup.sh || { echo "СТОП: первая копия не удалась — см. /root/backup.log"; exit 1; }
tail -1 /root/backup.log
systemctl daemon-reload && systemctl enable -q --now ftso-backup.timer || { echo "СТОП: таймер не включился"; exit 1; }
echo "таймер: $(systemctl is-active ftso-backup.timer); следующий запуск: $(systemctl show ftso-backup.timer -p NextElapseUSecRealtime --value)"
