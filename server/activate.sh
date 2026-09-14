#!/usr/bin/env bash
# Switches the club server to an uploaded release and checks that it answers.
# A release that is not healthy within 20 s is replaced by the one before it.
# Runs on the server as root; `server/remote.sh deploy` uploads the release
# and calls this. Activating the live release again just restarts it.
#
#   bash /opt/spbfi-club/releases/<id>/server/activate.sh <id>
set -euo pipefail

APP=/opt/spbfi-club
HEALTH=http://127.0.0.1:8787/club/health
ID="${1:-}"

[[ "$ID" =~ ^[A-Za-z0-9._-]+$ && -d "$APP/releases/$ID" ]] || { echo "usage: activate.sh <release-id>, a folder in $APP/releases" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }

# A new link is renamed over the old one, so `current` never goes missing.
point() {
  ln -sfn "$1" "$APP/current.next"
  mv -T "$APP/current.next" "$APP/current"
}

healthy() {
  local deadline=$((SECONDS + 20))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 2 "$HEALTH" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

previous="$(readlink "$APP/current" 2>/dev/null || true)"
point "$APP/releases/$ID"
systemctl restart spbfi-club

if ! healthy; then
  echo "release $ID did not answer $HEALTH within 20 s" >&2
  journalctl -u spbfi-club -n 20 --no-pager >&2 || true
  if [[ -n "$previous" && -d "$previous" && "$previous" != "$APP/releases/$ID" ]]; then
    point "$previous"
    systemctl restart spbfi-club
    echo "rolled back to ${previous##*/}" >&2
  fi
  exit 1
fi
echo "release $ID is live: $(curl -fsS --max-time 2 "$HEALTH")"

# Keep the five newest releases. Their ids begin with the UTC time, so name
# order is age order; the live one stays whatever its age.
live="$(readlink -f "$APP/current")"
find "$APP/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | tail -n +6 | while read -r old; do
  if [[ "$(readlink -f "$APP/releases/$old")" != "$live" ]]; then
    rm -rf -- "${APP:?}/releases/$old"
  fi
done
