/**
 * "Allow Docker": a per-agent switch only the human can turn on.
 *
 * Off by default. A sandboxed agent's shell cannot reach the Docker daemon's
 * socket: Claude Code's sandbox blocks Unix sockets, and the app's bubblewrap
 * (pi, agy) hides the socket (bwrapSandbox.ts `hideFiles`; before that, its
 * read-only root still let `docker ps` through). On, Claude Code's sandbox
 * lets it connect (withDockerSockets) and bubblewrap leaves the socket visible.
 *
 * Docker is root on the machine (or the WSL distro): `docker run -v /:/host`
 * reads and writes anything, so an agent with Docker can leave its sandbox.
 * Hence the same rules as the cloud logins (cloudCredentials.ts): only the
 * dedicated IPC (docker:set) writes it, the generic config write drops it, a
 * critical connection's custodian never gets it, and every change goes to the
 * hive's log. It applies at the agent's next start.
 *
 * Pure: no electron, no node.
 */

import { cleanCriticalMap, isCustodian } from './criticalConnections';

/** Agent id → true when the human allowed Docker. Absent → off. */
export type DockerGrantMap = Record<string, true>;

/** The map from config, cleaned: only agents with `true`. */
export function cleanDockerMap(raw: unknown): DockerGrantMap {
  const out: DockerGrantMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [agentId, on] of Object.entries(raw as Record<string, unknown>)) {
    if (agentId && on === true) out[agentId] = true;
  }
  return out;
}

/** Whether this agent starts with Docker: granted, and not a custodian (a
 *  custodian never gets it, whatever the map says). */
export function dockerGranted(map: unknown, critical: unknown, agentId: string | undefined): boolean {
  if (!agentId || !cleanDockerMap(map)[agentId]) return false;
  return !isCustodian(cleanCriticalMap(critical), agentId);
}

/** The rootful daemon's socket (/var/run is a link to /run on current distros). */
export const DOCKER_SYSTEM_SOCKETS: readonly string[] = ['/var/run/docker.sock', '/run/docker.sock'];

/**
 * The Docker socket paths where the agent runs (Linux paths): the system
 * daemon's, rootless Docker's ($XDG_RUNTIME_DIR/docker.sock, or
 * /run/user/<uid>/docker.sock), and the one DOCKER_HOST names when it is a
 * unix:// URL. Only absolute paths; nothing over TCP (that is the network's).
 */
export function dockerSocketPaths(env: { DOCKER_HOST?: string; XDG_RUNTIME_DIR?: string; uid?: number | string } = {}): string[] {
  const out = [...DOCKER_SYSTEM_SOCKETS];
  const runtime = typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR.startsWith('/')
    ? env.XDG_RUNTIME_DIR.replace(/\/+$/, '')
    : /^\d+$/.test(String(env.uid ?? '')) ? `/run/user/${env.uid}` : '';
  if (runtime) out.push(`${runtime}/docker.sock`);
  const host = typeof env.DOCKER_HOST === 'string' ? env.DOCKER_HOST.trim() : '';
  const m = /^unix:\/\/(\/.+)$/.exec(host);
  if (m) out.push(m[1]);
  return [...new Set(out.filter((p) => p.startsWith('/') && !p.includes('\0') && !p.includes('..')))];
}

/**
 * Claude Code's settings for an agent with Docker. `sandbox.network.
 * allowUnixSockets` gets the socket paths (merged with what the network block
 * already holds, such as the broker's host): that is what macOS honours. On
 * Linux (and a WSL floor's distro) Claude Code ignores that list, since its
 * seccomp filter cannot tell one socket path from another (verified on claude
 * 2.1.311: with only the list, `docker ps` still gets "permission denied"), so
 * there it also sets `allowAllUnixSockets`. That opens every Unix socket the
 * shell can see, which adds nothing to what Docker already gives (root).
 *
 * Left as is when there is no enabled sandbox to open, no socket, or the
 * network is a custodian's (strictAllowlist): a custodian never reaches Docker.
 */
export function withDockerSockets<T>(settings: T, sockets: readonly string[], opts: { linux: boolean }): T {
  const s = settings as unknown as { sandbox?: { enabled?: boolean; network?: { strictAllowlist?: boolean; allowUnixSockets?: unknown } } };
  const sb = s?.sandbox;
  if (!sb || sb.enabled !== true || !sockets.length) return settings;
  if (sb.network?.strictAllowlist) return settings;
  const had = Array.isArray(sb.network?.allowUnixSockets) ? (sb.network!.allowUnixSockets as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return {
    ...s,
    sandbox: {
      ...sb,
      network: {
        ...(sb.network ?? {}),
        allowUnixSockets: [...new Set([...had, ...sockets])],
        ...(opts.linux ? { allowAllUnixSockets: true } : {})
      }
    }
  } as unknown as T;
}
