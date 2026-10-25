# Scranton Branch server

An office with no GUI, for an Ubuntu server or a container. It is the same
app: `src/main` runs unchanged on plain Node (Electron's API is replaced by
`src/server/electronShim.ts`) and the floor's orchestration — the
orchestrator's boot, inbox wake-ups, queue delivery, context rules, revive —
is the renderer's own code, run without a DOM (`src/server/engine.tsx`). No
Chromium: the whole thing is a ~3.5 MB script plus two native modules.

You talk to it from your desktop through **Team**: the server's orchestrator is
one of your teammates.

## Ubuntu (systemd)

Needs Node.js 20+ and git.

```sh
tar xzf scranton-branch-server-<version>-linux-x64.tar.gz
cd scranton-branch-server-<version>-linux-x64
sudo ./install.sh
```

Then edit `/etc/scranton-branch/server.env`:

| Variable | |
|---|---|
| `SB_OFFICE` | the office directory (default `/srv/office`) |
| `SB_NAME` | its name on Team |
| `SB_TEAM_JOIN` | an invite from your desktop (Manager → Team → Invite). Used once, then remembered |
| `SB_MAX_WORKERS` | how many workers may run at once |
| `SB_RELAY_TOKEN` | `<relay>=<token>` for a relay that needs one (see below) |
| `ANTHROPIC_API_KEY` | optional: agents use it instead of a login |

and `sudo systemctl restart scranton-branch`. Logs: `journalctl -u scranton-branch -f`.

Agents run as the `agent` user. Log their CLI in once:
`sudo -u agent -H claude` (then `/login`).

Every flag has a variable and the other way round: `--office`, `--name`,
`--team-join`, `--max-workers`.

The variables were named `MD_*` before the rename to Scranton Branch. Those names
still work as deprecated aliases (an `SB_*` variable wins when both are set), so an
older `server.env` or compose file needs no change. The one exception: the unit now
sets `SB_DATA_DIR`, so a `server.env` that moved the data dir with `MD_DATA_DIR`
should rename it.

## Docker

```sh
openssl rand -hex 32 > packaging/server/secret.key && chmod 600 packaging/server/secret.key
docker compose -f packaging/server/docker-compose.yml up -d
docker compose -f packaging/server/docker-compose.yml exec -u agent office claude   # log in once
```

`AGENT_CLIS` (build arg) picks the agent CLIs baked into the image. CPU, memory
and process limits are in the compose file and apply to the whole office.

## Secrets

Connection keys are stored encrypted, as on a desktop. The key that encrypts
them is the server's alone:

- **systemd**: `/etc/scranton-branch/secret.key` (root, 0600), handed to the
  service as a credential.
- **Docker**: a compose secret (`SB_SECRET_KEY_FILE`). Keep the host file 0600;
  the container warns if agents could read it.
- Otherwise `SB_SECRET_KEY` (removed from the environment once read) or a
  generated `<data dir>/secret.key`.

Agents never see it: they run as another user (`SB_AGENT_UID`/`SB_AGENT_GID`),
so neither the key nor the server's environment is readable to them. Back the
key up — stored keys are unreadable without it.

## Relays

Team needs no server of ours: messages go through a relay, sealed end to end
(X25519 + ML-KEM-768 post-quantum hybrid, Ed25519 signatures), so the relay
only ever sees a random mailbox and opaque bytes. Each team picks its own:

| Relay | | |
|---|---|---|
| `mqtts://broker.emqx.io:8883` (default) | public MQTT | sub-second, no daily cap; keeps messages for an offline teammate while the broker keeps the session (not guaranteed for long) |
| `wss://broker.hivemq.com:8884/mqtt` | public MQTT over WebSocket | same, for networks that only allow HTTPS ports |
| `https://ntfy.sh` | public ntfy | keeps messages 12 h; **250 messages a day per IP**, a long message counts once per part |
| your own | `docker run -p 80:80 binwiederhier/ntfy serve`, or any MQTT broker with TLS | no limits but yours |

A relay that needs credentials takes them in the team's Edit form on a desktop
(MQTT `user:password`, or an ntfy token), and in
`SB_RELAY_TOKEN=<relay>=<token>` (comma-separated for several) on a server.
They are kept in the encrypted store, sent only to their relay, and never
reach agents. Only TLS relays are accepted (`https`, `mqtts`, `wss`).

## Not on a server

Voice, dictation, the in-app updater (update the package or the image) and
anything that opens a window or a dialog.
