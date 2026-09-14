#!/usr/bin/env bash
# Loads the club's data from the old server into this one: the documents in
# export.json and the settings with hashes in club.env, both written by
# `node server/migrate.mjs export`. Runs on the server as root;
# `server/remote.sh data` uploads the folder and calls this. The database is
# copied first, so a load can be undone from /var/lib/spbfi/backups.
#
#   bash /opt/spbfi-club/current/server/load-data.sh /root/spbfi-import
set -euo pipefail

DIR="${1:-}"
APP=/opt/spbfi-club/current
DB=/var/lib/spbfi/club.sqlite
BACKUPS=/var/lib/spbfi/backups
IMPORT=/var/lib/spbfi/import.json
HEALTH=http://127.0.0.1:8787/club/health
NODE=(/usr/local/bin/node --disable-warning=ExperimentalWarning)

[[ -n "$DIR" && -f "$DIR/export.json" && -f "$DIR/club.env" ]] || { echo "usage: load-data.sh <folder with export.json and club.env>" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ -f "$APP/server/import.mjs" ]] || { echo "no release in $APP yet: run server/remote.sh deploy first" >&2; exit 1; }
DIR="$(cd "$DIR" && pwd)"
# spbfi cannot enter root's folders; start its commands from somewhere it can.
cd /

# 1. Stopped: nothing writes during the load, and the server forgets the VAPID
# key and club secret it had read.
systemctl stop spbfi-club

# 2. Whatever is there now is copied first.
if [[ -f "$DB" ]]; then
  runuser -u spbfi -- env SPBFI_DB="$DB" SPBFI_BACKUPS="$BACKUPS" "${NODE[@]}" "$APP/server/backup.mjs" --label before-import
fi

# 3. The settings for root's eyes; the export for spbfi, who imports it. The
# copy holds every member and the club secret, so it goes whatever happens.
install -o root -g root -m 600 "$DIR/club.env" /etc/spbfi/env
trap 'shred -u "$IMPORT" 2>/dev/null || true' EXIT
install -o spbfi -g spbfi -m 600 "$DIR/export.json" "$IMPORT"

# 4. One transaction: if it fails, the database is as it was.
runuser -u spbfi -- env SPBFI_DB="$DB" "${NODE[@]}" "$APP/server/import.mjs" "$IMPORT"
shred -u "$IMPORT" "$DIR/export.json" "$DIR/club.env"
rmdir "$DIR" 2>/dev/null || true

# 5. Up again with the new data and settings.
systemctl start spbfi-club
for _ in $(seq 20); do
  if health="$(curl -fsS --max-time 2 "$HEALTH")"; then
    echo "club server is up: $health"
    exit 0
  fi
  sleep 1
done
echo "the club server did not answer $HEALTH within 20 s" >&2
journalctl -u spbfi-club -n 20 --no-pager >&2 || true
exit 1
