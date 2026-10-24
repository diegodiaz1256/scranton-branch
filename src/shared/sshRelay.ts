/**
 * "SSH through the office": git over SSH for an agent that never sees the
 * user's keys.
 *
 * Agents in an OS sandbox cannot read ~/.ssh (hive.ts hookSettings for Claude
 * Code, bwrapSandbox.ts for pi). The `ssh` they find first on their PATH is
 * the office's (<hive>/bin/ssh/ssh → md-ssh.cjs), which sends what git asked
 * for to the app; the app checks it here and, when the human switched this on
 * for that agent, runs the real `ssh` OUTSIDE the sandbox (in the WSL floor's
 * distro, or on the host), where the user's keys and ssh-agent are, and pipes
 * the git transfer back:
 *
 *   git ─▶ ssh (md-ssh, sandboxed) ══ broker (/ssh upgrade) ══▶ app ─▶ ssh git@host git-upload-pack '…'
 *
 * Why not relay the ssh-agent protocol itself: Claude Code's Linux sandbox
 * refuses every Unix socket (seccomp), so ssh inside it cannot talk to any
 * agent socket. Relaying the git transfer also gives the agent less: it can
 * only run git's three transfer commands, never a shell on a host the key
 * opens, and it never gets a signature it could replay.
 *
 * Pure: no electron, no node.
 */

/** The remote commands git runs over SSH; nothing else goes through. */
export const GIT_SSH_SERVICES = ['git-upload-pack', 'git-receive-pack', 'git-upload-archive'] as const;
export type GitSshService = (typeof GIT_SSH_SERVICES)[number];

/** What the human set for one agent (Capabilities). Absent → off. */
export interface SshRelayGrant {
  /** Key fingerprints (SHA256:…) it may use; empty → the keys ssh would try. */
  keys?: string[];
  /** Ask the human before each use. */
  ask?: boolean;
}
export type SshRelayMap = Record<string, SshRelayGrant>;

/** A request md-ssh made, once checked. */
export interface SshRelayRequest {
  host: string;
  user?: string;
  port?: number;
  service: GitSshService;
  /** The repository path, unquoted. */
  path: string;
  /** GIT_PROTOCOL (version=2), forwarded with SendEnv. */
  gitProtocol?: string;
}

/** One line of the audit (never the transfer itself). */
export interface SshRelayAuditEntry {
  ts: number;
  agentId: string;
  agentName?: string;
  host?: string;
  user?: string;
  service?: string;
  path?: string;
  /** The keys it was limited to (fingerprints); empty → any. */
  keys?: string[];
  allowed: boolean;
  /** Why it was refused. */
  reason?: string;
  /** ssh's exit code, once known. */
  exit?: number | null;
}

const HOST_RE = /^[A-Za-z0-9_](?:[A-Za-z0-9._-]{0,252})$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const PROTO_RE = /^[A-Za-z0-9=:._-]{1,64}$/;

/** ssh options git or Claude Code's sandbox put on the command line that the
 *  relay can drop: they shape the sandbox's own connection (its proxy), not
 *  what the app runs. */
const DROPPED_O = new Set(['controlmaster', 'controlpath', 'controlpersist', 'proxycommand', 'batchmode', 'serveraliveinterval', 'serveralivecountmax', 'connecttimeout', 'loglevel']);
/** Flags with no value the relay ignores (verbosity, no tty, no forwarding). */
const DROPPED_FLAGS = new Set(['-4', '-6', '-T', '-x', '-a', '-q', '-v', '-vv', '-vvv', '-n', '-C']);

/** A grant map from config, cleaned: agent ids → {keys, ask}. */
export function cleanSshRelayMap(raw: unknown): SshRelayMap {
  const out: SshRelayMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || id.length > 200 || !v || typeof v !== 'object' || Array.isArray(v)) continue;
    const g = v as { keys?: unknown; ask?: unknown };
    const keys = Array.isArray(g.keys) ? [...new Set(g.keys.filter((k): k is string => typeof k === 'string' && FP_RE.test(k)))] : [];
    out[id] = { ...(keys.length ? { keys } : {}), ...(g.ask === true ? { ask: true } : {}) };
  }
  return out;
}

/** Undo git's sq_quote: '…' with each ' written as '\''. Null if not that shape. */
export function unquoteSq(s: string): string | null {
  const m = /^'((?:[^']|'\\'')*)'$/.exec(s);
  if (!m) return null;
  return m[1].replace(/'\\''/g, "'");
}

/** git's sq_quote. */
export function quoteSq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Read the argv md-ssh was run with (what git hands `ssh`, plus the options
 * Claude Code's sandbox adds) into a request, or say why it is refused.
 * Only git's transfer commands pass; any other remote command, an
 * interactive session, port forwarding or a config file of the agent's own
 * is refused.
 */
export function parseSshArgv(argv: string[], gitProtocol?: string): { ok: true; req: SshRelayRequest } | { ok: false; error: string } {
  if (!Array.isArray(argv) || argv.length > 64 || argv.some((a) => typeof a !== 'string' || a.length > 4096 || a.includes('\0'))) {
    return { ok: false, error: 'malformed request' };
  }
  let port: number | undefined;
  let user: string | undefined;
  let sendProto = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (!a.startsWith('-') || a === '-') break;
    if (DROPPED_FLAGS.has(a)) continue;
    // -oKey=value or -o Key=value; -p22 or -p 22; -lgit or -l git.
    const opt = a.slice(0, 2);
    if (opt === '-o' || opt === '-p' || opt === '-l') {
      const val = a.length > 2 ? a.slice(2) : argv[++i];
      if (val === undefined) return { ok: false, error: `${opt} needs a value` };
      if (opt === '-p') {
        if (!/^\d{1,5}$/.test(val) || +val < 1 || +val > 65535) return { ok: false, error: `bad port ${val}` };
        port = +val;
      } else if (opt === '-l') {
        if (!USER_RE.test(val)) return { ok: false, error: 'bad user name' };
        user = val;
      } else {
        const eq = val.search(/[= ]/);
        const key = (eq === -1 ? val : val.slice(0, eq)).toLowerCase();
        const value = eq === -1 ? '' : val.slice(eq + 1).trim();
        if (key === 'sendenv' && value === 'GIT_PROTOCOL') sendProto = true;
        else if (key === 'port' && /^\d{1,5}$/.test(value) && +value >= 1 && +value <= 65535) port = +value;
        else if (key === 'user' && USER_RE.test(value)) user = value;
        else if (!DROPPED_O.has(key)) return { ok: false, error: `the ssh option ${key || val} is not passed through the office` };
      }
      continue;
    }
    return { ok: false, error: `the ssh option ${a} is not passed through the office` };
  }
  let dest = argv[i++];
  if (!dest) return { ok: false, error: 'no host given' };
  // ssh://[user@]host[:port] as well as [user@]host.
  const url = /^ssh:\/\/(?:([^@/]+)@)?([^:/]+)(?::(\d{1,5}))?\/?$/.exec(dest);
  if (url) {
    if (url[1]) user = url[1];
    if (url[3]) port = +url[3];
    dest = url[2];
  } else {
    const at = dest.lastIndexOf('@');
    if (at !== -1) { user = dest.slice(0, at); dest = dest.slice(at + 1); }
  }
  if (!HOST_RE.test(dest)) return { ok: false, error: 'bad host name' };
  if (user !== undefined && !USER_RE.test(user)) return { ok: false, error: 'bad user name' };
  if (port !== undefined && (port < 1 || port > 65535)) return { ok: false, error: 'bad port' };
  // ssh joins the remaining words with spaces into the remote command.
  const command = argv.slice(i).join(' ').trim();
  if (!command) return { ok: false, error: 'only git transfers go through the office: no interactive sessions' };
  const sp = command.indexOf(' ');
  const service = (sp === -1 ? command : command.slice(0, sp)) as GitSshService;
  if (!GIT_SSH_SERVICES.includes(service)) return { ok: false, error: `only git transfers go through the office (git-upload-pack, git-receive-pack, git-upload-archive), not "${command.slice(0, 60)}"` };
  const rest = sp === -1 ? '' : command.slice(sp + 1).trim();
  const path = rest.startsWith("'") ? unquoteSq(rest) : (/^[A-Za-z0-9_./~+-]+$/.test(rest) ? rest : null);
  if (!path || path.length > 1024 || /[\0\r\n]/.test(path)) return { ok: false, error: 'bad repository path' };
  const proto = sendProto && gitProtocol && PROTO_RE.test(gitProtocol) ? gitProtocol : undefined;
  return { ok: true, req: { host: dest, ...(user ? { user } : {}), ...(port ? { port } : {}), service, path, ...(proto ? { gitProtocol: proto } : {}) } };
}

/**
 * The argv for the real `ssh` the app runs outside the sandbox. Everything
 * that could do more than this one git transfer is switched off on the
 * command line, which wins over the user's ~/.ssh/config: no tty, no agent or
 * X11 forwarding, no port forwards, no local commands, no prompts. `identities`
 * are key files (private, or a public key whose private half is in the
 * ssh-agent) the human limited this agent to.
 */
export function relaySshArgv(req: SshRelayRequest, identities: string[] = []): string[] {
  const args = [
    '-T', '-x', '-a',
    '-o', 'BatchMode=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'PermitLocalCommand=no',
    '-o', 'RequestTTY=no',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none'
  ];
  if (identities.length) {
    args.push('-o', 'IdentitiesOnly=yes');
    for (const f of identities) args.push('-i', f);
  }
  if (req.gitProtocol) args.push('-o', 'SendEnv=GIT_PROTOCOL');
  if (req.port) args.push('-p', String(req.port));
  if (req.user) args.push('-l', req.user);
  args.push('--', req.host, `${req.service} ${quoteSq(req.path)}`);
  return args;
}

/** Why an agent may not use the relay right now, or null. */
export function sshRelayRefusal(opts: { granted: boolean; custodian: boolean; sandboxed: boolean }): string | null {
  if (opts.custodian) return 'the custodian of a critical connection never uses the human\'s SSH keys';
  if (!opts.sandboxed) return 'this agent does not run in an OS sandbox here, so the office cannot keep its keys from it (a Windows floor): use HTTPS';
  if (!opts.granted) return 'SSH keys are hidden from agents in this office. Use an HTTPS remote, or ask the human to switch on "Use my SSH keys through the office" for you in Capabilities (it applies at once)';
  return null;
}

// ─── framing ─────────────────────────────────────────────────────────────────
// After the upgrade, both ends speak frames: [type u8][length u32 BE][bytes].
// app → md-ssh: 1 stdout, 2 stderr, 3 exit (i32 code). md-ssh → app: 0 stdin,
// 4 stdin closed. Frames, not a raw pipe, because a half-closed TCP stream
// does not survive the sandbox proxy and the WSL bridge.
export const FRAME = { stdin: 0, stdout: 1, stderr: 2, exit: 3, stdinEnd: 4 } as const;
export const MAX_FRAME = 1 << 20;

export function encodeFrame(type: number, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(5 + data.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, data.length);
  out.set(data, 5);
  return out;
}

/** Collects bytes and hands back whole frames. Throws on a frame too big. */
export class FrameDecoder {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): Array<{ type: number; data: Uint8Array }> {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
    const frames: Array<{ type: number; data: Uint8Array }> = [];
    while (this.buf.length >= 5) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1);
      if (len > MAX_FRAME) throw new Error('frame too large');
      if (this.buf.length < 5 + len) break;
      frames.push({ type: this.buf[0], data: this.buf.slice(5, 5 + len) });
      this.buf = this.buf.slice(5 + len);
    }
    return frames;
  }
}
