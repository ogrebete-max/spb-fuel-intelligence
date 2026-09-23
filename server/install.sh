#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 VPS for the club server: Node, Caddy, the
# system users and folders, the systemd units, a firewall and SSH by key only.
# Runs on the server as root from /root/spbfi-setup, which
# `server/remote.sh setup` fills with server/ and downloads/. Every step looks
# before it changes anything, so running it again is safe.
#
#   bash /root/spbfi-setup/server/install.sh 203.0.113.10
set -euo pipefail

NODE_VERSION=24.21.0
CADDY_VERSION=2.11.4
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOWNLOADS="$(dirname "$HERE")/downloads"
IP="${1:-}"

say() { printf '\n== %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# 1. The right machine.
[[ "$IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "usage: install.sh <server IPv4 address>"
[[ $EUID -eq 0 ]] || die "run as root"
[[ "$(uname -m)" == x86_64 ]] || die "made for x86_64, this machine is $(uname -m)"
system="$(. /etc/os-release && echo "${ID:-} ${VERSION_ID:-}")"
[[ "$system" == "ubuntu 24.04" ]] || warn "made for Ubuntu 24.04, this is ${system:-an unknown system}"

# 2. Packages. On the first boot cloud-init may still hold the apt lock, so
# wait for it instead of failing.
say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update
apt-get -o DPkg::Lock::Timeout=600 install -y ufw unattended-upgrades xz-utils ca-certificates curl
# Security updates install themselves (what `dpkg-reconfigure unattended-upgrades` writes).
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# 3. Node, from the official tarball, checked against the published checksums.
say "node $NODE_VERSION"
if [[ "$(/usr/local/bin/node --version 2>/dev/null || true)" == "v$NODE_VERSION" ]]; then
  echo "already installed"
else
  tarball="node-v$NODE_VERSION-linux-x64.tar.xz"
  (cd "$DOWNLOADS" && awk -v name="$tarball" '$2 == name' "node-v$NODE_VERSION-SHASUMS256.txt" | sha256sum --check --strict -)
  tar -xJf "$DOWNLOADS/$tarball" -C /opt
  ln -sfn "/opt/node-v$NODE_VERSION-linux-x64/bin/node" /usr/local/bin/node
fi

# 4. Caddy, the same way.
say "caddy $CADDY_VERSION"
if [[ "$(/usr/local/bin/caddy version 2>/dev/null | awk '{ print $1 }' || true)" == "v$CADDY_VERSION" ]]; then
  echo "already installed"
else
  tarball="caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  (cd "$DOWNLOADS" && awk -v name="$tarball" '$2 == name' "caddy_${CADDY_VERSION}_checksums.txt" | sha512sum --check --strict -)
  unpacked="$(mktemp -d)"
  tar -xzf "$DOWNLOADS/$tarball" -C "$unpacked" caddy
  install -m 755 "$unpacked/caddy" /usr/local/bin/caddy
  rm -rf "$unpacked"
fi

# 5. System users: neither can log in, and each owns only its own folders.
say "users"
id -u spbfi >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/spbfi --no-create-home --shell /usr/sbin/nologin spbfi
id -u caddy >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/caddy --no-create-home --shell /usr/sbin/nologin caddy

# 6. Folders. The database and its copies are for spbfi alone; the env file
# with the hashes is for root alone (systemd reads it before dropping to spbfi).
say "folders"
install -d -o spbfi -g spbfi -m 750 /var/lib/spbfi
install -d -o spbfi -g spbfi -m 700 /var/lib/spbfi/backups
install -d -o root -g root -m 700 /etc/spbfi
[[ -e /etc/spbfi/env ]] || install -o root -g root -m 600 /dev/null /etc/spbfi/env
chown root:root /etc/spbfi/env
chmod 600 /etc/spbfi/env
install -d -o root -g root -m 755 /opt/spbfi-club /opt/spbfi-club/releases
install -d -o root -g root -m 755 /etc/caddy
install -d -o caddy -g caddy -m 750 /var/lib/caddy
# The Ladoga fishing map is served from here (its own deploy script fills it).
install -d -o root -g root -m 755 /var/www /var/www/ladoga /var/www/ladoga/releases

# 7. Swap and clock. A small VPS comes without swap, and there the kernel kills
# Node instead of letting it slow down. Certificates and passes need true time.
say "swap and clock"
if [[ -n "$(swapon --show --noheadings 2>/dev/null || true)" ]]; then
  echo "swap is on"
else
  if [[ ! -f /swapfile ]]; then
    fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  if swapon /swapfile; then
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    warn "could not turn swap on (a container VPS may not allow it)"
  fi
fi
timedatectl set-ntp true || warn "could not turn on time synchronisation"

# 8. Caddy's configuration and the services.
say "caddy configuration and services"
sed "s/@IP@/$IP/g" "$HERE/Caddyfile" > /etc/caddy/Caddyfile.new
for unit in caddy.service spbfi-club.service spbfi-backup.service spbfi-backup.timer; do
  install -m 644 "$HERE/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
# Checked before it replaces a configuration that works.
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile
install -m 644 /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
rm -f /etc/caddy/Caddyfile.new
systemctl enable caddy
systemctl restart caddy
systemctl enable --now spbfi-backup.timer
systemctl enable spbfi-club
if [[ -e /opt/spbfi-club/current ]]; then
  systemctl restart spbfi-club
else
  echo "no release yet: the club server starts with the first deploy"
fi

# 9. Firewall: SSH, and 80 and 443 for Caddy. The club server itself listens
# on 127.0.0.1 and is not reachable from outside anyway.
say "firewall"
ssh_port="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)"
ssh_port="${ssh_port:-22}"
ufw default deny incoming
ufw default allow outgoing
ufw allow "$ssh_port/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 10. SSH by key only, and only once a key is in place, so this can never lock
# everyone out. The drop-in sorts before cloud-init's 50-cloud-init.conf, and
# sshd keeps the first value it reads for each setting.
say "ssh"
dropin=/etc/ssh/sshd_config.d/10-spbfi.conf
if [[ -s /root/.ssh/authorized_keys ]]; then
  cat > "$dropin" <<'EOF'
# Written by the spbfi installer: log in with a key, never a password.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  # sshd -t wants the privilege separation folder that the running service would have made.
  mkdir -p /run/sshd
  if sshd -t; then
    systemctl reload-or-restart ssh
  else
    rm -f "$dropin"
    warn "sshd did not accept the settings; password login was left as it was"
  fi
else
  warn "/root/.ssh/authorized_keys is empty, so password login stays on; add a key and run this again"
fi

# 11. What next.
say "done"
cat <<EOF
The server is ready for the club. From the repository on the PC:
  server/remote.sh deploy $IP     upload the code and start the club server
  server/remote.sh status $IP     services, health, certificate, backups
Then open https://$IP/club/health (the first certificate may take a minute)
and move the data as docs/club-server.md describes.
EOF
