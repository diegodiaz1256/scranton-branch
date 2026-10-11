/**
 * Fortress (github.com/tiliondev/fortress) as the office browser's engine: a
 * Chromium build whose fingerprint reads as an ordinary Chrome, so the pages
 * agents read through the office browser are not refused as a bot as often.
 * Opt-in (Settings → Prerequisites), and the built-in Electron engine stays
 * the fallback whenever Fortress is off, missing or fails to start.
 *
 * Installed like the app's other prerequisites, but by the app itself: the
 * PINNED release is downloaded into the app's data folder and checked against
 * that release's own SHA256SUMS before anything is extracted or run. A
 * mismatch or a missing entry aborts; "latest" is never used.
 *
 * The v3 engine needs the user's own account: activation is Fortress's device
 * flow (`activate --headless`), which prints a link the user approves in their
 * browser with their own account and then saves the key to
 * ~/.tilion/license.jwt. The app runs Fortress's pinned CLI through uv (another
 * prerequisite; the release archives carry no activator) and never sees or
 * stores the key. Without activation the engine still runs, on Fortress's
 * first-generation engine.
 *
 * Privacy: Fortress's launcher looks the machine's IP up on ipapi.co/ipinfo.io
 * at every start to pick a timezone and country. The app passes the local
 * timezone instead (TILION_TZ), which skips that lookup.
 *
 * Electron-free: paths and logging are injected, so this is testable in Node.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const FORTRESS_TAG = 'v153.0.8010.36';
export const FORTRESS_CHROMIUM = '153.0.8010.36';
/** Fortress's CLI pinned to the same release (activation and license status). */
export const FORTRESS_CLI_SPEC = 'tilion-fortress==153.0.8010.36.post1';
const RELEASE = `https://github.com/tiliondev/fortress/releases/download/${FORTRESS_TAG}`;

/** The release archive for a platform/arch, or null where Fortress ships none. */
export function fortressAsset(platform: string, arch: string): string | null {
  if (platform === 'linux') {
    const a = ({ x64: 'x64', arm64: 'arm64', ia32: 'x86', arm: 'armhf' } as Record<string, string>)[arch];
    return a ? `fortress-v153-linux-${a}.tar.gz` : null;
  }
  if (platform === 'win32') return arch === 'x64' ? 'fortress-v153-win-x64.zip' : null;
  if (platform === 'darwin') return arch === 'arm64' ? 'fortress-v153-mac-arm64.tar.gz' : null;
  return null;
}

/** One file's digest from a SHA256SUMS body ("<sha>  <file>" or "<sha> *<file>"). */
export function sha256For(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m && (m[2] === file || m[2].endsWith(`/${file}`))) return m[1].toLowerCase();
  }
  return null;
}

/** The first https link in activator output (the device-approval page). */
export function approvalUrlIn(text: string): string | null {
  const m = /https:\/\/[^\s"'<>)]+/.exec(text);
  return m ? m[0].replace(/[.,;]+$/, '') : null;
}

export interface FortressLicense { licensed: boolean; mode?: string; exp?: number | string; source?: string }

export interface FortressStatus {
  supported: boolean;
  installed: boolean;
  launcher: string | null;
  /** How Fortress's CLI runs here: a `tilion` already on PATH, the pinned
   *  one through uv, or null when neither exists. */
  activator: 'tilion' | 'uv' | null;
  license: FortressLicense | null;
  activation: { state: 'idle' | 'waiting' | 'failed'; url?: string; error?: string };
  installing: { state: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'failed'; percent?: number; error?: string };
  running: boolean;
  cdpPort: number | null;
  error?: string;
}

export interface FortressDeps {
  /** <userData>/fortress */
  baseDir: string;
  /** uv's absolute path, if installed. */
  uvPath: () => string | null;
  /** A `tilion` CLI the user installed themselves, if on PATH. */
  tilionPath?: () => string | null;
  /** Child environment (the app's PATH etc.). */
  env: () => NodeJS.ProcessEnv;
  log?: (m: string) => void;
  platform?: string;
  arch?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** argv to run `cmd` on this platform. Node refuses to run a Windows .cmd/.bat
 *  without a shell, so those go through cmd.exe, quoted verbatim (the same
 *  pattern as openTerminal.ts). */
export function commandLine(platform: string, cmd: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    const q = (a: string) => `"${a.replace(/"/g, '""')}"`;
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${[cmd, ...args].map(q).join(' ')}"`], verbatim: true };
  }
  return { file: cmd, args, verbatim: false };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export class Fortress {
  private installing: FortressStatus['installing'] = { state: 'idle' };
  private activation: FortressStatus['activation'] = { state: 'idle' };
  private activator: ChildProcess | null = null;
  private engine: ChildProcess | null = null;
  private port: number | null = null;
  private starting: Promise<number> | null = null;
  private lastError: string | undefined;
  private licenseCache: { at: number; value: FortressLicense | null } | null = null;

  constructor(private readonly deps: FortressDeps) {}

  private get platform(): string { return this.deps.platform ?? process.platform; }
  private get arch(): string { return this.deps.arch ?? process.arch; }
  private get installDir(): string { return join(this.deps.baseDir, FORTRESS_TAG); }
  private get profileDir(): string { return join(this.deps.baseDir, 'profile'); }
  private get logDir(): string { return join(this.deps.baseDir, 'logs'); }
  private get marker(): string { return join(this.installDir, '.verified'); }

  // Settings asks for the status every few seconds. Walking the 600 MB bundle
  // for the launcher and a sync `where uv` / `where tilion` each time froze the
  // main process for 200-370 ms per ask (freezes.jsonl: ipc fortress:status).
  private launcherCache: string | null = null;
  private lookups = new Map<string, { path: string | null; at: number }>();

  /** A CLI lookup kept while the file exists; a missing one is retried every 30 s. */
  private cachedLookup(name: string, find: (() => string | null) | undefined): string | null {
    if (!find) return null;
    const c = this.lookups.get(name);
    if (c && (c.path ? existsSync(c.path) : Date.now() - c.at < 30_000)) return c.path;
    const path = find();
    this.lookups.set(name, { path, at: Date.now() });
    return path;
  }

  /** The engine's launcher in the extracted bundle (`tilion`, or `tillion.cmd` on Windows). */
  launcherPath(): string | null {
    if (!existsSync(this.marker)) { this.launcherCache = null; return null; }
    if (this.launcherCache && existsSync(this.launcherCache)) return this.launcherCache;
    this.launcherCache = this.findLauncher();
    return this.launcherCache;
  }

  private findLauncher(): string | null {
    const want = this.platform === 'win32' ? 'tillion.cmd' : 'tilion';
    const walk = (dir: string, depth: number): string | null => {
      if (depth > 4) return null;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return null; }
      if (entries.includes(want)) return join(dir, want);
      for (const e of entries) {
        const p = join(dir, e);
        try { if (lstatSync(p).isDirectory() && !e.startsWith('.')) { const hit = walk(p, depth + 1); if (hit) return hit; } } catch { /* skip */ }
      }
      return null;
    };
    return walk(this.installDir, 0);
  }

  /** argv for Fortress's CLI: the user's own `tilion` when installed, else the
   *  one pinned to this release through uv (where it is named tilion-fortress). */
  private cli(args: string[]): { cmd: string; args: string[]; via: 'tilion' | 'uv' } | null {
    const own = this.cachedLookup('tilion', this.deps.tilionPath);
    if (own) return { cmd: own, args, via: 'tilion' };
    const uv = this.cachedLookup('uv', this.deps.uvPath);
    if (uv) return { cmd: uv, args: ['tool', 'run', '--from', FORTRESS_CLI_SPEC, 'tilion-fortress', ...args], via: 'uv' };
    return null;
  }

  async status(): Promise<FortressStatus> {
    const supported = !!fortressAsset(this.platform, this.arch);
    const launcher = this.launcherPath();
    const cli = launcher ? this.cli([]) : null;
    return {
      supported,
      installed: !!launcher,
      launcher,
      activator: cli?.via ?? null,
      license: launcher ? await this.license() : null,
      activation: this.activation,
      installing: this.installing,
      running: !!this.engine && this.engine.exitCode === null && this.port !== null,
      cdpPort: this.port,
      ...(this.lastError ? { error: this.lastError } : {})
    };
  }

  /** `license status --json`, cached for a few seconds (it spawns a process). */
  async license(force = false): Promise<FortressLicense | null> {
    if (!force && this.licenseCache && Date.now() - this.licenseCache.at < 5000) return this.licenseCache.value;
    const cli = this.cli(['license', 'status', '--json']);
    if (!cli) return null;
    const value = await new Promise<FortressLicense | null>((resolve) => {
      const c = commandLine(this.platform, cli.cmd, cli.args);
      execFile(c.file, c.args, { env: { ...this.deps.env(), PYTHONUNBUFFERED: '1' }, timeout: 120_000, windowsHide: true, windowsVerbatimArguments: c.verbatim }, (_err, stdout) => {
        try {
          const j = JSON.parse(String(stdout).trim().split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '{}') as FortressLicense;
          resolve(typeof j.licensed === 'boolean' ? j : null);
        } catch { resolve(null); }
      });
    });
    this.licenseCache = { at: Date.now(), value };
    return value;
  }

  /** Download the pinned release, verify it against its SHA256SUMS, extract it. */
  async install(): Promise<{ ok: boolean; error?: string }> {
    if (this.installing.state === 'downloading' || this.installing.state === 'verifying' || this.installing.state === 'extracting') {
      return { ok: false, error: 'already installing' };
    }
    const asset = fortressAsset(this.platform, this.arch);
    if (!asset) return { ok: false, error: `Fortress ships no build for ${this.platform}-${this.arch}` };
    const fail = (error: string) => { this.installing = { state: 'failed', error }; this.deps.log?.(`install failed: ${error}`); return { ok: false, error }; };
    try {
      mkdirSync(this.deps.baseDir, { recursive: true });
      this.installing = { state: 'downloading', percent: 0 };
      const sumsRes = await fetch(`${RELEASE}/SHA256SUMS`, { signal: AbortSignal.timeout(15_000) });
      if (!sumsRes.ok) return fail(`could not fetch SHA256SUMS (HTTP ${sumsRes.status})`);
      const expected = sha256For(await sumsRes.text(), asset);
      if (!expected) return fail(`SHA256SUMS has no entry for ${asset}`);

      const archive = join(this.deps.baseDir, `${asset}.part`);
      // No overall deadline (a big download on a slow line is fine), but a
      // download that stops moving for a minute is abandoned.
      const stalled = new AbortController();
      let stallTimer = setTimeout(() => stalled.abort(), 60_000);
      const res = await fetch(`${RELEASE}/${asset}`, { signal: stalled.signal });
      if (!res.ok || !res.body) { clearTimeout(stallTimer); return fail(`download failed (HTTP ${res.status})`); }
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const hash = createHash('sha256');
      const body = Readable.fromWeb(res.body as never);
      body.on('data', (c: Buffer) => {
        got += c.length;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => stalled.abort(), 60_000);
        hash.update(c);
        if (total) this.installing = { state: 'downloading', percent: Math.floor((got / total) * 100) };
      });
      try { await pipeline(body, createWriteStream(archive)); } finally { clearTimeout(stallTimer); }

      this.installing = { state: 'verifying' };
      const actual = hash.digest('hex');
      if (actual !== expected) { rmSync(archive, { force: true }); return fail(`checksum mismatch for ${asset}: expected ${expected}, got ${actual}`); }

      this.installing = { state: 'extracting' };
      rmSync(this.installDir, { recursive: true, force: true });
      mkdirSync(this.installDir, { recursive: true });
      // System tar handles .tar.gz everywhere and .zip on Windows 10+ (bsdtar).
      const tarArgs = asset.endsWith('.zip') ? ['-xf', archive, '-C', this.installDir] : ['-xzf', archive, '-C', this.installDir];
      await new Promise<void>((resolve, reject) => {
        execFile('tar', tarArgs, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve()));
      });
      rmSync(archive, { force: true });
      writeFileSync(this.marker, JSON.stringify({ asset, sha256: actual, at: new Date().toISOString() }));
      if (!this.launcherPath()) { rmSync(this.marker, { force: true }); return fail('the archive has no launcher where expected'); }
      // A macOS download is quarantined; this verified bundle is what the release documents clearing.
      if (this.platform === 'darwin') execFile('xattr', ['-dr', 'com.apple.quarantine', this.installDir], () => {});
      this.installing = { state: 'idle' };
      this.licenseCache = null;
      return { ok: true };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** Start Fortress's device flow. Resolves the approval link once the
   *  activator prints it; the process keeps polling and saves the key itself. */
  async activate(): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (this.activator && this.activator.exitCode === null && this.activation.url) return { ok: true, url: this.activation.url };
    const cli = this.cli(['activate', '--headless']);
    if (!cli) return { ok: false, error: this.platform === 'win32' ? 'signing in needs uv on Windows itself (Fortress runs beside the app, not inside WSL)' : 'signing in needs uv (install it from this list)' };
    this.activation = { state: 'waiting' };
    const c = commandLine(this.platform, cli.cmd, cli.args);
    const child = spawn(c.file, c.args, { env: { ...this.deps.env(), PYTHONUNBUFFERED: '1' }, windowsHide: true, windowsVerbatimArguments: c.verbatim, stdio: ['ignore', 'pipe', 'pipe'] });
    this.activator = child;
    let out = '';
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: { ok: boolean; url?: string; error?: string }) => { if (!settled) { settled = true; resolve(r); } };
      const onData = (b: Buffer) => {
        out += b.toString();
        const url = approvalUrlIn(out);
        if (url && !this.activation.url) { this.activation = { state: 'waiting', url }; done({ ok: true, url }); }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => { this.activation = { state: 'failed', error: e.message }; done({ ok: false, error: e.message }); });
      child.on('exit', (code) => {
        this.activator = null;
        this.licenseCache = null;
        if (code === 0) this.activation = { state: 'idle' };
        else {
          const error = out.trim().split('\n').slice(-3).join(' ') || `activator exited with ${code}`;
          this.activation = { state: 'failed', error };
          done({ ok: false, error });
        }
      });
      setTimeout(() => { if (!settled) done({ ok: false, error: 'the activator printed no link within 2 minutes' }); }, 120_000);
    });
  }

  /** `license refresh` (re-issue before expiry) or `license logout` (remove
   *  the saved key; the engine drops back to v1). */
  async licenseCommand(which: 'refresh' | 'logout'): Promise<{ ok: boolean; error?: string }> {
    const cli = this.cli(['license', which]);
    if (!cli) return { ok: false, error: 'needs uv (install it from this list)' };
    const r = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const c = commandLine(this.platform, cli.cmd, cli.args);
      execFile(c.file, c.args, { env: { ...this.deps.env(), PYTHONUNBUFFERED: '1' }, timeout: 120_000, windowsHide: true, windowsVerbatimArguments: c.verbatim }, (err, stdout, stderr) => {
        resolve(err ? { ok: false, error: (String(stderr) || String(stdout)).trim().split('\n').slice(-2).join(' ') || err.message } : { ok: true });
      });
    });
    this.licenseCache = null;
    // A running engine read the key at start: restart it on the next page.
    if (r.ok) this.stopEngine();
    return r;
  }

  /** The engine's CDP port, starting it if needed (one engine, shared). */
  async ensureEngine(): Promise<number> {
    if (this.engine && this.engine.exitCode === null && this.port !== null) return this.port;
    if (this.starting) return this.starting;
    this.starting = this.startEngine().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async startEngine(): Promise<number> {
    const launcher = this.launcherPath();
    if (!launcher) throw new Error('Fortress is not installed');
    mkdirSync(this.profileDir, { recursive: true });
    mkdirSync(this.logDir, { recursive: true });
    const port = await freePort();
    const flags = ['--headless=new', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, `--user-data-dir=${this.profileDir}`];
    const log = createWriteStream(join(this.logDir, 'engine.log'), { flags: 'a' });
    // The local timezone, so the launcher does not ask a geo-IP service.
    const env = { ...this.deps.env(), TILION_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
    // The Windows launcher is a .cmd (tillion.cmd): commandLine runs it through cmd.exe.
    const c = commandLine(this.platform, launcher, flags);
    const child = spawn(c.file, c.args, { windowsVerbatimArguments: c.verbatim, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    this.engine = child;
    child.on('exit', (code) => {
      if (this.engine === child) { this.engine = null; this.port = null; }
      this.deps.log?.(`engine exited (${code})`);
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json() as { Browser?: string; webSocketDebuggerUrl?: string };
        if (v.webSocketDebuggerUrl && (v.Browser ?? '').includes(FORTRESS_CHROMIUM)) {
          this.port = port;
          this.lastError = undefined;
          return port;
        }
      } catch { /* not up yet */ }
      await sleep(200);
    }
    this.stop();
    this.lastError = 'the engine did not come up (see logs/engine.log in the Fortress folder)';
    throw new Error(this.lastError);
  }

  stop(): void {
    const a = this.activator;
    if (a && a.exitCode === null) {
      if (this.platform === 'win32' && a.pid) execFile('taskkill', ['/pid', String(a.pid), '/t', '/f'], () => {});
      else try { a.kill(); } catch { /* gone */ }
    }
    this.stopEngine();
  }

  private stopEngine(): void {
    const e = this.engine;
    this.engine = null;
    this.port = null;
    if (!e || e.exitCode !== null) return;
    if (this.platform === 'win32' && e.pid) execFile('taskkill', ['/pid', String(e.pid), '/t', '/f'], () => {});
    else try { e.kill(); } catch { /* gone */ }
  }

  /** Remove the downloaded engine and its profile (the license stays: it is the user's). */
  uninstall(): void {
    this.stop();
    rmSync(this.deps.baseDir, { recursive: true, force: true });
    this.installing = { state: 'idle' };
    this.licenseCache = null;
  }

  /** Bytes the download takes on disk, for the settings row. */
  diskUsage(): number {
    let n = 0;
    const walk = (d: string, depth: number) => {
      if (depth > 6) return;
      let es: string[] = [];
      try { es = readdirSync(d); } catch { return; }
      for (const e of es) {
        const p = join(d, e);
        try { const s = lstatSync(p); if (s.isDirectory()) walk(p, depth + 1); else n += s.size; } catch { /* skip */ }
      }
    };
    if (existsSync(this.installDir)) walk(this.installDir, 0);
    return n;
  }
}

/** Verify a file on disk against a hex SHA-256 (used by tests). */
export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

