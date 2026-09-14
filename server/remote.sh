#!/usr/bin/env bash
# The maintainer's side of the club server, run from the repository in Git Bash
# on the PC. Everything goes over SSH as root with the club's own key.
#
#   server/remote.sh setup  <IP>            prepare a fresh VPS (runs install.sh)
#   server/remote.sh deploy <IP> [--dirty]  upload the committed code and switch to it
#   server/remote.sh data   <IP> <folder>   load export.json and club.env from migrate.mjs
#   server/remote.sh status <IP>            services, health, certificate, backups, disk
#
# SPBFI_SSH_KEY overrides ~/.ssh/spbfi_club_ed25519, SPBFI_DOWNLOADS the folder
# with the Node and Caddy downloads (~/.spbfi-club/downloads).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY="${SPBFI_SSH_KEY:-$HOME/.ssh/spbfi_club_ed25519}"
DOWNLOADS="${SPBFI_DOWNLOADS:-$HOME/.spbfi-club/downloads}"
NODE_VERSION=24.21.0
CADDY_VERSION=2.11.4
# accept-new: the first connection to a fresh VPS remembers its host key,
# and a changed key later is refused.
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new)

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat >&2 <<'EOF'
usage: server/remote.sh setup  <IP>
       server/remote.sh deploy <IP> [--dirty]
       server/remote.sh data   <IP> <folder with export.json and club.env>
       server/remote.sh status <IP>
EOF
  exit 2
}

on() {
  local ip="$1"
  shift
  "${SSH[@]}" "root@$ip" "$@"
}

setup() {
  local ip="$1" file
  local files=("node-v$NODE_VERSION-linux-x64.tar.xz" "node-v$NODE_VERSION-SHASUMS256.txt" "caddy_${CADDY_VERSION}_linux_amd64.tar.gz" "caddy_${CADDY_VERSION}_checksums.txt")
  for file in "${files[@]}"; do
    [[ -f "$DOWNLOADS/$file" ]] || die "missing $DOWNLOADS/$file (from nodejs.org/dist/v$NODE_VERSION or the Caddy v$CADDY_VERSION release on GitHub)"
  done
  # A fresh copy every time, so nothing removed from server/ lingers there.
  echo "uploading server/ and the downloads"
  tar -C "$ROOT" -cf - server | on "$ip" 'rm -rf /root/spbfi-setup && mkdir -p /root/spbfi-setup && tar -xf - --no-same-owner -C /root/spbfi-setup'
  tar -C "$DOWNLOADS" -cf - "${files[@]}" | on "$ip" 'mkdir -p /root/spbfi-setup/downloads && tar -xf - --no-same-owner -C /root/spbfi-setup/downloads'
  on "$ip" "bash /root/spbfi-setup/server/install.sh $ip"
}

deploy() {
  local ip="$1" dirty="$2" changes id path
  changes="$(git -C "$ROOT" status --porcelain -- worker server)"
  if [[ -n "$changes" && "$dirty" != --dirty ]]; then
    die "uncommitted changes in worker/ or server/; commit them or pass --dirty:"$'\n'"$changes"
  fi
  id="$(date -u +%Y%m%d-%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD)"
  if [[ -n "$changes" ]]; then id="$id-dirty"; fi
  # The worker, its package.json (it makes spbfi-reports.js an ES module)
  # and the server's code; tests and configuration stay behind.
  local files=(worker/spbfi-reports.js worker/package.json)
  for path in "$ROOT"/server/*.mjs "$ROOT"/server/*.sh; do
    if [[ "$path" != *.test.mjs ]]; then files+=("server/${path##*/}"); fi
  done
  echo "uploading release $id"
  tar -C "$ROOT" -cf - "${files[@]}" | on "$ip" "mkdir -p /opt/spbfi-club/releases/$id && tar -xf - --no-same-owner -C /opt/spbfi-club/releases/$id"
  on "$ip" "bash /opt/spbfi-club/releases/$id/server/activate.sh $id"
}

data() {
  local ip="$1" dir="$2"
  [[ -f "$dir/export.json" && -f "$dir/club.env" ]] || die "$dir must hold export.json and club.env from: node server/migrate.mjs export"
  # Through tar, not scp: scp takes a Windows path such as C:/... for a host name.
  tar -C "$dir" -cf - export.json club.env | on "$ip" 'umask 077 && rm -rf /root/spbfi-import && install -d -m 700 /root/spbfi-import && tar -xf - --no-same-owner -C /root/spbfi-import && chmod 600 /root/spbfi-import/*'
  on "$ip" 'bash /opt/spbfi-club/current/server/load-data.sh /root/spbfi-import'
}

status() {
  local ip="$1"
  on "$ip" "bash -s -- $ip" <<'EOF'
set -uo pipefail
ip="$1"
echo "== services"
for unit in caddy spbfi-club spbfi-backup.timer; do
  printf '  %-20s %s\n' "$unit" "$(systemctl is-active "$unit")"
done
release="$(readlink /opt/spbfi-club/current 2>/dev/null || true)"
printf '  %-20s %s\n' release "${release##*/}"
echo "== health"
curl -fsS --max-time 5 http://127.0.0.1:8787/club/health || printf '  no answer from the club server'
echo
echo "== certificate"
echo | openssl s_client -connect "$ip:443" 2>/dev/null | openssl x509 -noout -enddate || echo "  no certificate on $ip:443"
echo "== newest backup"
newest="$(ls -1t /var/lib/spbfi/backups 2>/dev/null | head -n 1)"
if [[ -n "$newest" ]]; then
  ls -lh --time-style=long-iso "/var/lib/spbfi/backups/$newest" | awk '{ print "  " $6 " " $7 "  " $5 "  " $8 }'
else
  echo "  none yet"
fi
echo "== disk"
df -h / | awk 'NR == 2 { print "  " $4 " free of " $2 " (" $5 " used)" }'
EOF
}

[[ $# -ge 2 ]] || usage
command="$1"
ip="$2"
[[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "not an IPv4 address: $ip"
[[ -f "$KEY" ]] || die "no SSH key at $KEY (set SPBFI_SSH_KEY)"
case "$command" in
  setup) [[ $# -eq 2 ]] || usage; setup "$ip" ;;
  deploy) [[ $# -eq 2 || ( $# -eq 3 && "$3" == --dirty ) ]] || usage; deploy "$ip" "${3:-}" ;;
  data) [[ $# -eq 3 ]] || usage; data "$ip" "$3" ;;
  status) [[ $# -eq 2 ]] || usage; status "$ip" ;;
  *) usage ;;
esac
