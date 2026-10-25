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
import { createHash } from 'node:crypto';
import {
  FRAME, FrameDecoder, MAX_SIGN_PAYLOAD, describeSignPayload, encodeFrame, parsePubKey, parseSignSpec, parseSshArgv, relaySshArgv, sshRelayRefusal, sshSignRefusal,
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
  /** Signing (md-ssh-sign). Without these the office signs nothing. The keys
   *  the human signs with where agents run: their key files and ssh-agent,
   *  and their own user.signingkey. */
  signKeys?: () => Promise<SshKeyInfo[]>;
  /** Sign `payload` in the namespace "git" with that key, outside the sandbox. */
  sign?: (key: { file?: string; pub?: string }, payload: Buffer) => Promise<{ code: number; sig: Buffer; err: string }>;
  askSign?: (agentName: string, what: { kind: string; subject: string; repo?: string; fingerprint: string }) => Promise<boolean>;
}

/** SHA256:… of a public key line (what `ssh-keygen -l` prints). Null if not one. */
export function sshKeyFingerprint(pubLine: string): string | null {
  const k = parsePubKey(pubLine);
  if (!k) return null;
  return `SHA256:${createHash('sha256').update(Buffer.from(k.blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/** At most this many transfers at once per agent; Git LFS on its own count:
 *  it opens a session per worker (8 by default) besides its batch one. */
const MAX_PER_AGENT = 4;
const MAX_LFS_PER_AGENT = 10;

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
    let spec: { argv?: unknown; gitProtocol?: unknown; op?: unknown } = {};
    try {
      const raw = req.headers['x-md-ssh'];
      spec = JSON.parse(Buffer.from(typeof raw === 'string' ? raw : '', 'base64').toString('utf8') || '{}');
    } catch { return refuse(400, 'malformed request'); }
    if (!spec || typeof spec !== 'object') return refuse(400, 'malformed request');
    const name = this.deps.agentName(agentId);
    const base = { ts: Date.now(), agentId, ...(name ? { agentName: name } : {}) };
    if (spec.op === 'sign') { void this.signUpgrade(agentId, name, base, spec as Record<string, unknown>, socket, head, refuse); return; }
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
    const lfs = r.service.startsWith('git-lfs-');
    const slot = lfs ? `${agentId}\0lfs` : agentId;
    const max = lfs ? MAX_LFS_PER_AGENT : MAX_PER_AGENT;
    if ((this.live.get(slot) ?? 0) >= max) {
      this.audit({ ...base, ...what, allowed: false, reason: 'too many at once' });
      return refuse(429, `at most ${max} SSH transfers at once`);
    }
    const keys = grant.keys ?? [];
    void (async () => {
      if (grant.ask) {
        let yes = false;
        try { yes = await (lfs ? this.askLfsOnce(agentId, name, r) : this.deps.ask(name ?? agentId, r)); } catch { yes = false; }
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
      await this.pipe(slot, { ...base, ...what, keys, allowed: true }, r, ids, socket, head);
    })();
  }

  /** Git LFS opens a session per worker for one push or fetch: the human is
   *  asked once for it (the same agent, repository and direction), and the
   *  answer holds while those sessions keep coming, a minute after the last. */
  private lfsAsked = new Map<string, { until: number; answer: Promise<boolean> }>();
  private askLfsOnce(agentId: string, name: string | undefined, r: SshRelayRequest): Promise<boolean> {
    const key = [agentId, r.user ?? '', r.host, r.port ?? '', r.path, r.operation ?? ''].join('\0');
    const now = Date.now();
    const had = this.lfsAsked.get(key);
    if (had && had.until > now) { if (Number.isFinite(had.until)) had.until = now + 60_000; return had.answer; }
    const answer = Promise.resolve().then(() => this.deps.ask(name ?? agentId, r)).catch(() => false);
    const entry = { until: Number.POSITIVE_INFINITY, answer };
    this.lfsAsked.set(key, entry);
    void answer.then((yes) => { if (yes) entry.until = Date.now() + 60_000; else this.lfsAsked.delete(key); });
    return answer;
  }

  private audit(e: SshRelayAuditEntry): void {
    try { this.deps.audit(e); } catch { /* an audit never breaks a call */ }
  }

  /**
   * md-ssh-sign: a git object to sign with the human's key. Checked before
   * the upgrade (namespace, the switch, custodian, sandbox, a key of the
   * human's and one this agent may use); then the payload comes in as stdin
   * frames, must be a commit, tag or push certificate, the human is asked
   * when they want that, and the signature goes back as stdout. The audit
   * has who, which key, where and the subject; never the payload.
   */
  private async signUpgrade(agentId: string, name: string | undefined, base: { ts: number; agentId: string; agentName?: string },
    spec: Record<string, unknown>, socket: Duplex, head: Buffer, refuse: (status: number, message: string) => void): Promise<void> {
    const parsed = parseSignSpec(spec);
    const entry: SshRelayAuditEntry = { ...base, service: 'sign', ...(typeof spec.cwd === 'string' && spec.cwd.length <= 1024 ? { path: spec.cwd } : {}), allowed: false };
    const no = (reason: string, status = 403): void => { this.audit({ ...entry, reason }); refuse(status, reason); };
    if (!parsed.ok) return no(parsed.error);
    const r = parsed.req;
    let grant: SshRelayGrant | null = null;
    let why: string | null;
    try {
      grant = this.deps.grant(agentId);
      why = sshSignRefusal({ grant, custodian: this.deps.custodian(agentId), sandboxed: this.deps.sandboxed(agentId) });
    } catch { why = 'signing through the office cannot be checked right now, so it is refused'; }
    if (why || !grant) return no(why ?? 'off');
    if (!this.deps.signKeys || !this.deps.sign) return no('the office cannot sign on this floor');
    // The key: one of the human's where agents run, found by its public half
    // or by the key file git named (hidden from the agent).
    let keys: SshKeyInfo[] = [];
    try { keys = await this.deps.signKeys(); } catch { keys = []; }
    const fp = r.pub ? sshKeyFingerprint(r.pub) : null;
    const strip = (p: string): string => p.replace(/\.pub$/, '');
    const key = fp ? keys.find((k) => k.fingerprint === fp) : keys.find((k) => k.file && r.keyPath && strip(k.file) === strip(r.keyPath));
    if (!key) return no(`that signing key (${fp ?? r.keyPath}) is not one of the human's SSH keys where agents run`);
    entry.keys = [key.fingerprint];
    if (grant.keys?.length && !grant.keys.includes(key.fingerprint)) return no(`the human did not choose that key (${key.fingerprint}) for you`);
    if ((this.live.get(agentId) ?? 0) >= MAX_PER_AGENT) return no(`at most ${MAX_PER_AGENT} SSH uses at once`, 429);
    if (socket.destroyed) { this.audit({ ...entry, reason: 'the agent stopped waiting' }); return; }
    this.live.set(agentId, (this.live.get(agentId) ?? 0) + 1);
    let done = false;
    const finish = (code: number, out: Buffer | null, err: string, extra: Partial<SshRelayAuditEntry>): void => {
      if (done) return;
      done = true;
      this.live.set(agentId, Math.max(0, (this.live.get(agentId) ?? 1) - 1));
      this.audit({ ...entry, ts: Date.now(), ...extra });
      const c = Buffer.alloc(4);
      c.writeInt32BE(code);
      try {
        if (out) socket.write(Buffer.from(encodeFrame(FRAME.stdout, out)));
        if (err) socket.write(Buffer.from(encodeFrame(FRAME.stderr, Buffer.from(`${err.replace(/\n?$/, '\n')}`))));
        socket.end(Buffer.from(encodeFrame(FRAME.exit, c)));
      } catch { /* gone */ }
    };
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: md-ssh\r\nConnection: Upgrade\r\n\r\n');
    socket.on('error', () => { /* close follows */ });
    socket.on('close', () => { if (!done) finish(255, null, '', { reason: 'the agent stopped waiting' }); });
    const payload = await new Promise<Buffer | null>((resolve) => {
      const dec = new FrameDecoder();
      const parts: Buffer[] = [];
      let size = 0;
      const onData = (d: Buffer): void => {
        let frames: Array<{ type: number; data: Uint8Array }>;
        try { frames = dec.push(d); } catch { socket.off('data', onData); resolve(null); return; }
        for (const f of frames) {
          if (f.type === FRAME.stdin) {
            size += f.data.length;
            if (size > MAX_SIGN_PAYLOAD) { socket.off('data', onData); resolve(null); return; }
            parts.push(Buffer.from(f.data));
          } else if (f.type === FRAME.stdinEnd) { socket.off('data', onData); resolve(Buffer.concat(parts)); return; }
        }
      };
      socket.on('data', onData);
      socket.on('close', () => resolve(null));
      if (head.length) onData(head);
    });
    if (done) return;
    if (!payload) return finish(1, null, 'sign (office): the object to sign was too large or cut off', { reason: 'payload too large or cut off' });
    const what = describeSignPayload(payload.toString('utf8'));
    if (!what) return finish(1, null, 'sign (office): only git commits, tags and push certificates are signed through the office', { reason: 'not a git object' });
    entry.subject = `${what.kind}: ${what.subject}`.slice(0, 200);
    if (grant.ask) {
      let yes = false;
      try { yes = this.deps.askSign ? await this.deps.askSign(name ?? agentId, { kind: what.kind, subject: what.subject, ...(r.repo ? { repo: r.repo } : {}), fingerprint: key.fingerprint }) : false; } catch { yes = false; }
      if (!yes) return finish(1, null, 'sign (office): the human did not allow this use of their SSH key', { reason: 'the human said no' });
    }
    if (done) return;
    let res: { code: number; sig: Buffer; err: string };
    try {
      res = await this.deps.sign(key.file ? { file: key.file } : { pub: key.pub ?? r.pub }, payload);
    } catch (e) { res = { code: 255, sig: Buffer.alloc(0), err: e instanceof Error ? e.message : String(e) }; }
    if (res.code === 0 && res.sig.toString('latin1').startsWith('-----BEGIN SSH SIGNATURE-----')) {
      return finish(0, res.sig, '', { allowed: true, exit: 0 });
    }
    const err = res.err.trim().split('\n').slice(-3).join('\n') || 'no signature came back';
    finish(res.code || 1, null, `sign (office): signing failed: ${err}`, { allowed: true, exit: res.code || 1, reason: err.slice(0, 300) });
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

// ─── signing, outside the sandbox ────────────────────────────────────────────

/** How the human signs where agents run, from their own GLOBAL git config
 *  (never a repository's, which the agent can write): `prog\t<gpg.ssh.program>`
 *  and `key\t<user.signingkey>`. */
export const SSH_SIGNER_SCRIPT = [
  'printf "prog\\t%s\\n" "$(git config --global --get gpg.ssh.program 2>/dev/null)"',
  'printf "key\\t%s\\n" "$(git config --global --get user.signingkey 2>/dev/null)"'
].join('; ');

export function parseSshSigner(out: string): { program: string; signingKey: string } {
  let program = '', signingKey = '';
  for (const line of out.split(/\r?\n/)) {
    const [kind, ...rest] = line.split('\t');
    if (kind === 'prog') program = rest.join('\t').trim();
    else if (kind === 'key') signingKey = rest.join('\t').trim();
  }
  return { program, signingKey };
}

export function readSshSignerRaw(distro: string | null): Promise<string> {
  return new Promise((resolve) => {
    const done = (_e: unknown, out: unknown): void => resolve(String(out ?? ''));
    if (distro) execFile('wsl.exe', ['-d', distro, '--cd', '~', '--exec', 'sh', '-c', SSH_SIGNER_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, done);
    else if (process.platform !== 'win32') execFile('sh', ['-c', SSH_SIGNER_SCRIPT], { encoding: 'utf8', timeout: 30_000 }, done);
    else resolve('');
  });
}

/**
 * Signs the payload on stdin and prints the signature: the human's signing
 * program (their gpg.ssh.program, else ssh-keygen), namespace "git" fixed
 * here, never taken from the agent. The key is a key file's .pub (ssh-keygen
 * finds the private half next to it, or the ssh-agent) or a public key written
 * to a temp file (the ssh-agent, or 1Password's op-ssh-sign, holds the
 * private half). Values come base64 in the env: paths and keys with spaces
 * survive wsl.exe's command line.
 */
export const SSH_SIGN_SCRIPT = [
  'b64() { printf %s "$1" | base64 -d 2>/dev/null || printf %s "$1" | base64 -D; }',
  'd=$(mktemp -d) || exit 1',
  'trap \'rm -rf "$d"\' EXIT',
  'cat > "$d/payload"',
  'P=$(b64 "${MD_SIGN_PROG:-}")',
  'case "$P" in "~/"*) P="$HOME/${P#\\~/}";; "") P=ssh-keygen;; esac',
  'if [ -n "${MD_SIGN_PUB:-}" ]; then b64 "$MD_SIGN_PUB" > "$d/key.pub"; echo >> "$d/key.pub"; k="$d/key.pub"; else k=$(b64 "${MD_SIGN_KEYFILE:-}"); fi',
  '"$P" -Y sign -n git -f "$k" "$d/payload" >/dev/null 2>"$d/err" < /dev/null || { cat "$d/err" >&2; exit 1; }',
  'cat "$d/payload.sig"'
].join('; ');

/** Run SSH_SIGN_SCRIPT where agents run (the WSL floor's distro, or here). */
export function runSshSign(distro: string | null, program: string, key: { file?: string; pub?: string }, payload: Buffer, sock: string): Promise<{ code: number; sig: Buffer; err: string }> {
  const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
  const vars: Record<string, string> = {
    SSH_AUTH_SOCK: sock,
    MD_SIGN_PROG: b64(program),
    ...(key.file ? { MD_SIGN_KEYFILE: b64(key.file) } : { MD_SIGN_PUB: b64(key.pub ?? '') })
  };
  return new Promise((resolve) => {
    let child: ChildProcess;
    if (distro) {
      child = spawn('wsl.exe', ['-d', distro, '--cd', '~', '--exec', '/usr/bin/env', 'PATH=/usr/local/bin:/usr/bin:/bin', ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), 'sh', '-c', SSH_SIGN_SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } else if (process.platform !== 'win32') {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
      child = spawn('sh', ['-c', SSH_SIGN_SCRIPT], { env: { ...env, ...vars }, stdio: ['pipe', 'pipe', 'pipe'] });
    } else { resolve({ code: 1, sig: Buffer.alloc(0), err: 'no signer on a Windows floor' }); return; }
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 120_000);
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 4096) err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 255, sig: Buffer.alloc(0), err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 255, sig: Buffer.concat(out), err }); });
    child.stdin?.on('error', () => { /* it exited first */ });
    child.stdin?.end(payload);
  });
}
