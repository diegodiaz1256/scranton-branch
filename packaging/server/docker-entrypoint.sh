#!/bin/sh
# Container start: make the office shared with the agent user, then hand over
# to the server (tini reaps the agents' processes).
set -e
# SB_* settings; the MD_* names from before the rename still work.
export SB_DATA_DIR="${SB_DATA_DIR:-${MD_DATA_DIR:-/data}}"
export SB_OFFICE="${SB_OFFICE:-${MD_OFFICE:-/office}}"
export SB_AGENT_UID="${SB_AGENT_UID:-${MD_AGENT_UID:-1001}}"
export SB_AGENT_GID="${SB_AGENT_GID:-${MD_AGENT_GID:-1001}}"
export SB_AGENT_HOME="${SB_AGENT_HOME:-${MD_AGENT_HOME:-/home/agent}}"
export SB_AGENT_USER="${SB_AGENT_USER:-${MD_AGENT_USER:-agent}}"
key_file="${SB_SECRET_KEY_FILE:-$MD_SECRET_KEY_FILE}"
office="$SB_OFFICE"
mkdir -p "$office" "$SB_DATA_DIR"
chmod 700 "$SB_DATA_DIR"
chgrp office "$office" && chmod 2775 "$office"
chown agent:office "$SB_AGENT_HOME"
# The key must be out of the agents' reach: chmod 600 it on the host.
if [ -n "$key_file" ] && su agent -s /bin/sh -c "test -r '$key_file'" 2>/dev/null; then
  echo "WARNING: agents can read $key_file — run: chmod 600 secret.key (on the host)" >&2
fi
exec node /opt/scranton-branch/index.cjs "$@"
