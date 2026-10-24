#!/usr/bin/env bash
# Install (or upgrade) the Scranton Branch server on Ubuntu / Debian.
#
#   sudo ./install.sh            from an unpacked scranton-branch-server tarball
#
# Installs to /opt/scranton-branch, data in /var/lib/scranton-branch, settings in
# /etc/scranton-branch, a systemd unit, and an `agent` user that agents run as.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
dest=/opt/scranton-branch
etc=/etc/scranton-branch

need() { command -v "$1" >/dev/null 2>&1; }
if ! need node || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Node.js 20 or newer is required (https://nodejs.org or: apt install nodejs from NodeSource)"; exit 1
fi
need git || apt-get install -y --no-install-recommends git

# Agents' user and the group they share with the server over the office.
getent group office >/dev/null || groupadd --system office
id agent >/dev/null 2>&1 || useradd --create-home --gid office --shell /bin/bash agent

# The app. Native modules come prebuilt for this platform; if this Node's ABI
# differs, rebuild them (needs build-essential and python3).
mkdir -p "$dest"
cp -a "$here/." "$dest/"
if ! (cd "$dest" && node -e "require('better-sqlite3'); require('node-pty')" 2>/dev/null); then
  echo "rebuilding native modules for Node $(node -v)…"
  apt-get install -y --no-install-recommends build-essential python3
  (cd "$dest" && npm rebuild --omit=dev)
fi

# Settings and the secret-store key (readable by root only; systemd hands it
# to the service as a credential, never to agents).
mkdir -p "$etc" /var/lib/scranton-branch
chmod 700 /var/lib/scranton-branch
if [ ! -f "$etc/secret.key" ]; then
  (umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$etc/secret.key"; echo >> "$etc/secret.key")
  echo "generated $etc/secret.key — back it up: stored Connection keys are unreadable without it"
fi
chmod 600 "$etc/secret.key"
if [ ! -f "$etc/server.env" ]; then
  sed -e "s/^SB_AGENT_UID=$/SB_AGENT_UID=$(id -u agent)/" \
      -e "s/^SB_AGENT_GID=$/SB_AGENT_GID=$(getent group office | cut -d: -f3)/" \
      "$here/packaging/server.env.example" > "$etc/server.env"
  chmod 600 "$etc/server.env"
  echo "wrote $etc/server.env — set SB_OFFICE / SB_NAME / SB_TEAM_JOIN there"
fi

# The office: group office, setgid so everything created in it stays shared.
office="$(. "$etc/server.env"; echo "${SB_OFFICE:-${MD_OFFICE:-/srv/office}}")"
mkdir -p "$office"
chgrp office "$office" && chmod 2775 "$office"
git config --system --get-all safe.directory | grep -qx '\*' || git config --system --add safe.directory '*'

install -m 644 "$here/packaging/scranton-branch.service" /etc/systemd/system/scranton-branch.service
systemctl daemon-reload
systemctl enable scranton-branch >/dev/null
systemctl restart scranton-branch
echo
echo "running. logs: journalctl -u scranton-branch -f"
echo "agents need a login once:  sudo -u agent -H claude   (or ANTHROPIC_API_KEY in $etc/server.env)"
