/**
 * "SSH through the office" (shared/sshRelay.ts), the app's side: md-ssh
 * reaches the key broker with an `Upgrade: md-ssh` request; this checks it,
 * asks the human when they want that, runs the real `ssh` outside the
 * sandbox and pipes the git transfer back in frames. Every request is
 * audited (who, host, repository, which keys, allowed or why not, exit code);
 * the transfer itself never is.
 *
 * No electron: everything the app knows (grants, custodians, the floor, the
 * dialog, the audit file) is injected, so it runs under plain node in tests.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import {
  FRAME, FrameDecoder, encodeFrame, parseSshArgv, relaySshArgv, sshRelayRefusal,
  type SshRelayAuditEntry, type SshRelayGrant, type SshRelayRequest
} from '../shared/sshRelay';

/** A key the human can choose (Capabilities). */
export interface SshKeyInfo {
  /** SHA256:… */
  fingerprint: string;
  /** "ED25519 you@laptop", for the picker. */
  label: string;
  source: 'file' | 'agent';
  /** A key file: the .pub path where ssh runs. */
  file?: string;
  /** An ssh-agent key: its public key line. */
  pub?: string;
}

export interface SshRelayDeps {
  /** The agent's grant right now (Capabilities), or null when off. */
  grant: (agentId: string) => SshRelayGrant | null;
  custodian: (agentId: string) => boolean;
  /** Whether this agent's shell is in an OS sandbox (its keys hidden from it). */
  sandboxed: (agentId: string) => boolean;
  agentName: (agentId: string) => string | undefined;
  /** Key files to pass with -i for these fingerprints (where ssh runs). */
  identities: (fingerprints: string[]) => Promise<string[]>;
  /** Start the real ssh outside the sandbox. */
  run: (argv: string[], env: Record<string, string>) => Promise<ChildProcess>;
  /** Ask the human (the agent's grant says to). */
  ask: (agentName: string, req: SshRelayRequest) => Promise<boolean>;
  audit: (e: SshRelayAuditEntry) => void;
}

/** At most this many transfers at once per agent. */
const MAX_PER_AGENT = 4;

export class SshRelay {
  private live = new Map<string, number>();
  constructor(private readonly deps: SshRelayDeps) {}

  /** Answer an upgrade the broker authenticated for `agentId`. */
  upgrade(agentId: string | undefined, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const refuse = (status: number, message: string): void => {
      const body = JSON.stringify({ error: message });
      try {
        socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      } catch { /* gone */ }
    };
    if (!agentId) return refuse(403, 'only an office agent can use SSH through the office');
    let spec: { argv?: unknown; gitProtocol?: unknown } = {};
    try {
      const raw = req.headers['x-md-ssh'];
      spec = JSON.parse(Buffer.from(typeof raw === 'string' ? raw : '', 'base64').toString('utf8') || '{}');
    } catch { return refuse(400, 'malformed request'); }
    const name = this.deps.agentName(agentId);
    const base = { ts: Date.now(), agentId, ...(name ? { agentName: name } : {}) };
    const parsed = parseSshArgv(Array.isArray(spec.argv) ? spec.argv as string[] : [], typeof spec.gitProtocol === 'string' ? spec.gitProtocol : undefined);
    if (!parsed.ok) {
      this.audit({ ...base, allowed: false, reason: parsed.error });
      return refuse(403, parsed.error);
    }
    const r = parsed.req;
    const what = { host: r.host, ...(r.user ? { user: r.user } : {}), service: r.service, path: r.path };
    let grant: SshRelayGrant | null = null;
    let why: string | null;
    try {
      grant = this.deps.grant(agentId);
      why = sshRelayRefusal({ granted: !!grant, custodian: this.deps.custodian(agentId), sandboxed: this.deps.sandboxed(agentId) });
    } catch { why = 'SSH through the office cannot be checked right now, so it is refused'; }
    if (why || !grant) {
      this.audit({ ...base, ...what, allowed: false, reason: why ?? 'off' });
      return refuse(403, why ?? 'off');
    }
    if ((this.live.get(agentId) ?? 0) >= MAX_PER_AGENT) {
      this.audit({ ...base, ...what, allowed: false, reason: 'too many at once' });
      return refuse(429, `at most ${MAX_PER_AGENT} SSH transfers at once`);
    }
    const keys = grant.keys ?? [];
    void (async () => {
      if (grant.ask) {
        let yes = false;
        try { yes = await this.deps.ask(name ?? agentId, r); } catch { yes = false; }
        if (!yes) {
          this.audit({ ...base, ...what, keys, allowed: false, reason: 'the human said no' });
          return refuse(403, 'the human did not allow this use of their SSH keys');
        }
      }
      let ids: string[] = [];
      if (keys.length) {
        try { ids = await this.deps.identities(keys); } catch { ids = []; }
        // Limited to keys that are no longer there: refuse rather than let ssh
        // fall back to every key it has.
        if (!ids.length) {
          this.audit({ ...base, ...what, keys, allowed: false, reason: 'the chosen keys were not found' });
          return refuse(403, 'the SSH keys the human chose for you were not found: ask them to choose again in Capabilities');
        }
      }
      await this.pipe(agentId, { ...base, ...what, keys, allowed: true }, r, ids, socket, head);
    })();
  }

  private audit(e: SshRelayAuditEntry): void {
    try { this.deps.audit(e); } catch { /* an audit never breaks a call */ }
  }

  private async pipe(agentId: string, entry: SshRelayAuditEntry, r: SshRelayRequest, ids: string[], socket: Duplex, head: Buffer): Promise<void> {
    // md-ssh gave up while the human was asked: nothing to run for.
    if (socket.destroyed) { this.audit({ ...entry, allowed: false, reason: 'the agent stopped waiting' }); return; }
    let child: ChildProcess;
    try {
      child = await this.deps.run(relaySshArgv(r, ids), r.gitProtocol ? { GIT_PROTOCOL: r.gitProtocol } : {});
    } catch (e) {
      this.audit({ ...entry, allowed: false, reason: `ssh did not start: ${e instanceof Error ? e.message : String(e)}` });
      try { socket.end('HTTP/1.1 500 Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); } catch { /* gone */ }
      return;
    }
    if (socket.destroyed) { try { child.kill(); } catch { /* gone */ } this.audit({ ...entry, allowed: false, reason: 'the agent stopped waiting' }); return; }
    this.live.set(agentId, (this.live.get(agentId) ?? 0) + 1);
    let done = false;
    const finish = (code: number | null): void => {
      if (done) return;
      done = true;
      this.live.set(agentId, Math.max(0, (this.live.get(agentId) ?? 1) - 1));
      this.audit({ ...entry, ts: Date.now(), allowed: true, exit: code });
      const c = Buffer.alloc(4);
      c.writeInt32BE(code ?? 255);
      try { socket.end(Buffer.from(encodeFrame(FRAME.exit, c))); } catch { /* gone */ }
    };
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: md-ssh\r\nConnection: Upgrade\r\n\r\n');
    const send = (type: number, src: NodeJS.ReadableStream | null): void => {
      src?.on('data', (d: Buffer) => {
        if (!socket.write(Buffer.from(encodeFrame(type, d)))) {
          src.pause();
          socket.once('drain', () => src.resume());
        }
      });
    };
    send(FRAME.stdout, child.stdout);
    send(FRAME.stderr, child.stderr);
    const dec = new FrameDecoder();
    const onData = (d: Buffer): void => {
      let frames: Array<{ type: number; data: Uint8Array }>;
      try { frames = dec.push(d); } catch { child.kill(); socket.destroy(); return; }
      for (const f of frames) {
        if (f.type === FRAME.stdin) {
          if (child.stdin && !child.stdin.destroyed && !child.stdin.write(Buffer.from(f.data))) {
            socket.pause();
            child.stdin.once('drain', () => socket.resume());
          }
        } else if (f.type === FRAME.stdinEnd) child.stdin?.end();
      }
    };
    child.stdin?.on('error', () => { /* ssh exited first */ });
    socket.on('data', onData);
    if (head.length) onData(head);
    // md-ssh gone (git killed): stop ssh.
    socket.on('close', () => { if (!done) { try { child.kill(); } catch { /* gone */ } } });
    socket.on('error', () => { /* close follows */ });
    child.on('error', (e) => {
      try { socket.write(Buffer.from(encodeFrame(FRAME.stderr, Buffer.from(`ssh (office): ssh did not start: ${e.message}\n`)))); } catch { /* gone */ }
      finish(255);
    });
    child.on('close', (code) => finish(code));
  }
}

/**
 * Lists the keys where ssh runs and the ssh-agent socket it should use:
 * `$SSH_AUTH_SOCK` (or 1Password's usual one in a WSL distro), every
 * ~/.ssh/*.pub, and the agent's keys. Output lines: `sock\t<path>`,
 * `file\t<pub path>\t<ssh-keygen -l line>`, `agentfp\t<line>`, `agentpub\t<key>`.
 */
export const SSH_KEYS_SCRIPT = [
  'S="${SSH_AUTH_SOCK:-}"',
  '[ -z "$S" ] && [ -S "$HOME/.1password/agent.sock" ] && S="$HOME/.1password/agent.sock"',
  'printf "sock\\t%s\\n" "$S"',
  'for f in "$HOME"/.ssh/*.pub; do [ -f "$f" ] || continue; l=$(ssh-keygen -lf "$f" 2>/dev/null) || continue; printf "file\\t%s\\t%s\\n" "$f" "$l"; done',
  'if [ -n "$S" ] && [ -S "$S" ]; then t=$(mktemp); if SSH_AUTH_SOCK="$S" timeout 10 ssh-add -L > "$t" 2>/dev/null; then ssh-keygen -lf "$t" 2>/dev/null | while IFS= read -r l; do printf "agentfp\\t%s\\n" "$l"; done; while IFS= read -r p; do printf "agentpub\\t%s\\n" "$p"; done < "$t"; fi; rm -f "$t"; fi',
  'true'
].join('; ');

/** SSH_KEYS_SCRIPT's output as keys (a key in a file and the agent once). */
export function parseSshKeys(out: string): { sock: string; keys: SshKeyInfo[] } {
  let sock = '';
  const keys: SshKeyInfo[] = [];
  const fps: Array<{ fp: string; label: string }> = [];
  const pubs: string[] = [];
  const keygen = (l: string): { fp: string; label: string } | null => {
    // "256 SHA256:abc… comment words (ED25519)"
    const m = /^\d+\s+(SHA256:[A-Za-z0-9+/]{43})\s*(.*?)\s*\(([A-Z0-9-]+)\)\s*$/.exec(l.trim());
    return m ? { fp: m[1], label: `${m[3]}${m[2] && m[2] !== 'no comment' ? ` ${m[2]}` : ''}` } : null;
  };
  for (const line of out.split(/\r?\n/)) {
    const [kind, ...rest] = line.split('\t');
    if (kind === 'sock') sock = rest.join('\t').trim();
    else if (kind === 'file' && rest.length >= 2) {
      const k = keygen(rest.slice(1).join('\t'));
      const file = rest[0].trim();
      if (k && file.endsWith('.pub') && !keys.some((x) => x.fingerprint === k.fp)) keys.push({ fingerprint: k.fp, label: k.label, source: 'file', file });
    } else if (kind === 'agentfp') { const k = keygen(rest.join('\t')); if (k) fps.push(k); }
    else if (kind === 'agentpub') pubs.push(rest.join('\t').trim());
  }
  fps.forEach((k, i) => {
    if (!keys.some((x) => x.fingerprint === k.fp) && pubs[i]) keys.push({ fingerprint: k.fp, label: k.label, source: 'agent', pub: pubs[i] });
  });
  return { sock, keys };
}

/** Run SSH_KEYS_SCRIPT where the agents run (a WSL distro, or here). */
export function listSshKeysRaw(distro: string | null): Promise<string> {
  return new Promise((resolve) => {
    const done = (_e: unknown, out: unknown): void => resolve(String(out ?? ''));
    if (distro) execFile('wsl.exe', ['-d', distro, '--cd', '~', '--exec', 'sh', '-c', SSH_KEYS_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, done);
    else if (process.platform !== 'win32') execFile('sh', ['-c', SSH_KEYS_SCRIPT], { encoding: 'utf8', timeout: 30_000 }, done);
    else resolve('');
  });
}

/** Start the real ssh: inside the distro for a WSL floor (no login shell:
 *  its rc files are not the office's to run), else on this machine. */
export function spawnRelaySsh(distro: string | null, argv: string[], env: Record<string, string>, sock: string): ChildProcess {
  const vars = { ...env, SSH_AUTH_SOCK: sock };
  if (distro) {
    const assigns = Object.entries(vars).filter(([k]) => /^[A-Z_]+$/.test(k)).map(([k, v]) => `${k}=${v}`);
    return spawn('wsl.exe', ['-d', distro, '--cd', '~', '--exec', '/usr/bin/env', 'PATH=/usr/local/bin:/usr/bin:/bin', ...assigns, 'ssh', ...argv], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') childEnv[k] = v;
  return spawn('ssh', argv, { env: { ...childEnv, ...vars }, stdio: ['pipe', 'pipe', 'pipe'] });
}
