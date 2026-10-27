/**
 * Offices that run inside WSL (Windows only).
 *
 * Where an office lives decides where it runs: a floor at
 * `\\wsl.localhost\<distro>\home\you\offices\x` (or `\\wsl$\…`) is a WSL
 * floor — its agents, git and tools run inside that distro — and a floor at
 * `G:\…` runs on Windows as before. Nothing else records the choice, so a WSL
 * floor opened from "recent" is still a WSL floor.
 *
 * The app itself stays on Windows. It reads the office through the UNC path
 * (main's file IO is unchanged) and starts processes inside the distro through
 * `wsl.exe`, translating paths on the way in.
 *
 * Electron-free and mostly pure, for tests.
 */
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface WslLocation { distro: string; linuxPath: string }

const UNC = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]([^\\/]+)([\\/].*)?$/i;

/** The distro and Linux path of a `\\wsl.localhost\…` / `\\wsl$\…` path, else null. */
export function parseWslPath(p: string | null | undefined): WslLocation | null {
  if (!p) return null;
  const m = UNC.exec(p.trim());
  if (!m) return null;
  const rest = (m[3] ?? '/').replace(/\\/g, '/').replace(/\/+/g, '/');
  const linuxPath = rest.length > 1 ? rest.replace(/\/$/, '') : '/';
  return { distro: m[2], linuxPath };
}

export function isWslPath(p: string | null | undefined): boolean {
  return parseWslPath(p) !== null;
}

/** The Windows (UNC) path of a Linux path inside a distro. */
export function toWslUnc(distro: string, linuxPath: string): string {
  const clean = linuxPath.replace(/\/+$/, '') || '/';
  return `\\\\wsl.localhost\\${distro}${clean === '/' ? '\\' : clean.replace(/\//g, '\\')}`;
}

/**
 * A path as a process inside `distro` sees it: its own UNC paths become Linux
 * paths, Windows drive paths become /mnt/<drive>/…, anything else is returned
 * unchanged. Another distro's UNC path has no Linux equivalent: null.
 */
export function toLinuxPath(p: string, distro: string): string | null {
  const w = parseWslPath(p);
  if (w) return w.distro.toLowerCase() === distro.toLowerCase() ? w.linuxPath : null;
  const d = /^([A-Za-z]):[\\/]?(.*)$/.exec(p);
  if (d) {
    const rest = d[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${d[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
  }
  return p;
}

/**
 * A path an agent INSIDE `distro` wrote (a request file, a hook payload) as
 * the Windows app must open it: `/home/u/x` → `\\wsl.localhost\<distro>\home\u\x`,
 * `~` / `~/x` under the distro user's home, `/mnt/c/x` → `C:\x`. Anything else
 * (already a Windows or UNC path, or relative) is returned unchanged.
 */
export function fromLinuxPath(p: string, distro: string, home?: () => string | null): string {
  const t = p.trim();
  if (t === '~' || t.startsWith('~/')) {
    const h = home?.();
    if (!h) return t;
    return t === '~' ? h : `${h.replace(/[\\/]+$/, '')}\\${t.slice(2).replace(/\//g, '\\')}`;
  }
  const mnt = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(t);
  if (mnt) return `${mnt[1].toUpperCase()}:\\${(mnt[2] ?? '').replace(/\//g, '\\')}`;
  if (t.startsWith('/')) return toWslUnc(distro, t);
  return t;
}

/** Rewrite every UNC path of `distro` inside a string (prompts, settings, env
 *  values), and every Windows drive path to its /mnt/<drive> path: inside the
 *  distro that is the only way to reach it (the app's resources, userData). A
 *  quoted drive path may hold spaces ("C:\Program Files\…"); an unquoted one
 *  ends at the first space. */
export function linuxizeText(text: string, distro: string): string {
  const re = new RegExp(`[\\\\/]{2}(?:wsl\\.localhost|wsl\\$)[\\\\/]${distro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}((?:[\\\\/][^\\s"'\`<>|]*)?)`, 'gi');
  const drive = (d: string, rest: string): string => {
    const r = rest.replace(/\\/g, '/').replace(/\/+$/, '');
    return `/mnt/${d.toLowerCase()}${r ? `/${r}` : ''}`;
  };
  return text
    .replace(re, (_m, rest: string) => (rest ? rest.replace(/\\/g, '/') : '/'))
    .replace(/(["'`])([A-Za-z]):\\([^"'`\r\n]*)\1/g, (_m, q: string, d: string, rest: string) => `${q}${drive(d, rest)}${q}`)
    .replace(/(^|[\s=(:,;])([A-Za-z]):\\([^\s"'`<>|]*)/g, (_m, pre: string, d: string, rest: string) => `${pre}${drive(d, rest)}`);
}

/**
 * A failed wsl.exe call as a sentence a person can act on. `raw` is whatever
 * the failure carried (Error, stderr text or Buffer): wsl.exe writes UTF-16, so
 * NULs are stripped before matching. Unknown failures keep their first line.
 */
export function describeWslError(raw: unknown, distro?: string): string {
  const decode = (b: unknown): string => (Buffer.isBuffer(b) ? (b.includes(0) ? b.toString('utf16le') : b.toString('utf8')) : String(b ?? ''));
  let text: string;
  if (raw instanceof Error) {
    const e = raw as Error & { code?: string; stderr?: unknown };
    text = `${e.code ?? ''} ${decode(e.stderr)} ${e.message}`;
  } else text = decode(raw);
  text = text.replace(/\uFEFF/g, '').replace(/\0/g, '').trim();
  const where = distro ? ` (${distro})` : '';
  if (/ENOENT/.test(text)) return 'wsl.exe was not found. WSL is not installed or is disabled on this computer (Windows features: "Windows Subsystem for Linux").';
  if (/EPERM|EACCES|access is denied|blocked/i.test(text)) return 'Windows refused to start wsl.exe. Security software (EDR/antivirus) or a company policy may be blocking it: ask IT to allow it, then try again.';
  if (/ETIMEDOUT|timed out|did not start/i.test(text)) return `WSL${where} took too long to answer. It may be starting up or slowed by security software: wait a moment and try again, or run "wsl --shutdown" and retry.`;
  if (/WSL_E_DISTRO_NOT_FOUND|no distribution with the supplied name|there is no distribution/i.test(text)) return `The WSL distribution${where || ''} was not found. Check the name with "wsl -l -v".`;
  if (/no installed distributions|has no installed/i.test(text)) return 'WSL has no installed distribution. Install one with "wsl --install -d Ubuntu" from an administrator PowerShell.';
  if (/virtualization|HCS_E|0x80370102|0x80370114|0x8007019e/i.test(text)) return 'WSL could not start: virtualization is off (enable it in the BIOS) or the "Virtual Machine Platform" Windows feature is disabled.';
  if (/not found|command not found/i.test(text) && /node/.test(text)) return `node is not installed inside WSL${where}. Install it there (for example with nvm) and try again.`;
  const first = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return first ? first.slice(0, 300) : 'WSL failed without an error message.';
}

/** Run before every command inside a distro: a login shell already has
 *  ~/.local/bin and npm -g on PATH, but node version managers set themselves up
 *  only in interactive shells (nvm in ~/.bashrc), so load them explicitly. */
const WSL_SETUP = [
  '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1',
  '[ -d "$HOME/.volta/bin" ] && PATH="$HOME/.volta/bin:$PATH"',
  'command -v fnm >/dev/null 2>&1 && eval "$(fnm env)"',
  // A folder that must come first (the office's `ssh` for a sandboxed agent,
  // shared/sshRelay.ts): after the version managers, which prepend too.
  '[ -n "${MD_PATH_PREPEND:-}" ] && PATH="$MD_PATH_PREPEND:$PATH"'
];
export const WSL_PRELUDE = [...WSL_SETUP, 'exec "$@"'].join('; ');

/** Arguments longer than this ride in the environment instead of argv. */
export const WSL_ARG_SPILL = 2000;
/** One variable's share of a spilled argument (Windows caps a variable at 32767). */
const WSL_ARG_CHUNK = 16000;
const SPILL_MARK = '@@md-env-arg:';
/** WSL_PRELUDE that first puts spilled arguments back together: a mark
 *  `@@md-env-arg:NAME:N` becomes the concatenation of NAME_0..NAME_{N-1},
 *  which are then unset so the agent's own processes never see them. */
export const WSL_PRELUDE_SPILLED = [
  ...WSL_SETUP,
  `a=(); for x in "$@"; do case "$x" in "${SPILL_MARK}"*) n="\${x#${SPILL_MARK}}"; v=""; for ((i=0; i<\${n##*:}; i++)); do k="\${n%:*}_$i"; v+="\${!k}"; unset "$k"; done; a+=("$v");; *) a+=("$x");; esac; done`,
  'exec "${a[@]}"'
].join('; ');

/** Long arguments out of argv. wsl.exe's whole command line is capped at
 *  32767 characters by CreateProcess, and node-pty escapes every quote and
 *  newline on top: pi's hive prompt (a positional argument) plus its
 *  bubblewrap sandbox went past it, and the agent never started ("error
 *  206", ERROR_FILENAME_EXCED_RANGE). Each long one becomes a mark in argv
 *  and its text goes in MD_ARG_<i>_<chunk>, handed over through WSLENV, so
 *  the caller must pass the returned env to wslCommand and to the process. */
export function spillLongArgs(args: string[]): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const out = args.map((a, i) => {
    if (a.length <= WSL_ARG_SPILL) return a;
    const name = `MD_ARG_${i}`;
    let n = 0;
    for (let at = 0; at < a.length; at += WSL_ARG_CHUNK) env[`${name}_${n++}`] = a.slice(at, at + WSL_ARG_CHUNK);
    return `${SPILL_MARK}${name}:${n}`;
  });
  return { args: out, env };
}

/**
 * Run a shell `command` inside `distro` with secrets in its environment, for
 * runners (envVault.ts). The values never go on a command line (other
 * processes can read those): they arrive on stdin as NAME=base64 lines ended
 * by a blank one, are exported, and stdin is then closed for the command.
 */
export function wslSecretRun(distro: string, cwd: string, command: string): { file: string; args: string[] } {
  const script = [
    ...WSL_SETUP,
    'while IFS= read -r l && [ -n "$l" ]; do export "${l%%=*}=$(printf %s "${l#*=}" | base64 -d)"; done',
    'exec bash -c "$1" </dev/null'
  ].join('; ');
  return { file: 'wsl.exe', args: ['-d', distro, '--cd', cwd, '--exec', 'bash', '-lc', script, 'bash', command] };
}

/** Where each of `bins` resolves inside `distro` (null when missing), with
 *  the same login shell + version managers agents get. One wsl.exe call. */
export function probeInDistro(distro: string, bins: string[], onError?: (message: string) => void): Promise<Record<string, string | null>> {
  const safe = bins.filter((b) => /^[A-Za-z0-9._-]+$/.test(b));
  const script = [...WSL_SETUP, 'for b in "$@"; do printf "%s\\t%s\\n" "$b" "$(command -v "$b" 2>/dev/null)"; done'].join('; ');
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-d', distro, '--exec', 'bash', '-lc', script, 'bash', ...safe], { timeout: 45000, windowsHide: true }, (err, stdout) => {
      const out: Record<string, string | null> = Object.fromEntries(safe.map((b) => [b, null]));
      if (err) onError?.(describeWslError(err, distro));
      if (!err) for (const line of String(stdout).split(/\r?\n/)) {
        const [b, p] = line.split('\t');
        if (b && b in out) out[b] = p?.trim() || null;
      }
      resolve(out);
    });
  });
}

/** How to install a tool inside a WSL distro (Ubuntu/Debian), when that
 *  differs from the generic Linux hint. Node comes through nvm: installing it
 *  with apt gives an old version, and npm -g then needs sudo. */
export const WSL_INSTALL: Record<string, string> = {
  git: 'sudo apt update && sudo apt install -y git',
  node: 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install --lts',
  uv: 'curl -LsSf https://astral.sh/uv/install.sh | sh',
  bubblewrap: 'sudo apt update && sudo apt install -y bubblewrap socat'
};

const homes = new Map<string, string>();
/** The user's home in `distro` as a Windows UNC path (cached), or null when
 *  WSL does not answer. */
export function distroHomeUnc(distro: string): string | null {
  const cached = homes.get(distro);
  if (cached) return cached;
  try {
    const home = runInDistro(distro, 'sh', ['-c', 'printf %s "$HOME"']);
    if (!home.startsWith('/')) return null;
    const unc = toWslUnc(distro, home);
    homes.set(distro, unc);
    return unc;
  } catch { return null; }
}

/** The stdin wslSecretRun reads its secrets from. */
export function secretStdin(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k, v]) => `${k}=${Buffer.from(v, 'utf8').toString('base64')}\n`).join('') + '\n';
}

/**
 * The `wsl.exe` invocation that runs `file args` inside `distro`, in `cwd`
 * (a Linux path), with `env` set: a login shell plus WSL_PRELUDE, so tools a
 * user installed the usual way (nvm, ~/.local/bin, npm -g) are found.
 *
 * `env` never goes on the command line (process lists, EDR and audit logs
 * record it, and agents carry API keys and broker tokens): the caller puts the
 * returned `env` into the wsl.exe process's environment, and WSLENV, which
 * names them, makes wsl.exe hand them to the distro. Values pass verbatim.
 */
export function wslCommand(
  distro: string,
  cwd: string,
  file: string,
  args: string[],
  env: Record<string, string> = {},
  inherited: string | undefined = process.env.WSLENV
): { file: string; args: string[]; env: Record<string, string> } {
  const vars = Object.fromEntries(Object.entries(env).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)));
  const names = Object.keys(vars);
  // Arguments put through spillLongArgs (whose env the caller passes here) are rebuilt first.
  const prelude = args.some((a) => a.startsWith(SPILL_MARK)) ? WSL_PRELUDE_SPILLED : WSL_PRELUDE;
  return {
    file: 'wsl.exe',
    args: ['-d', distro, '--cd', cwd, '--exec', 'bash', '-lc', prelude, 'bash', file, ...args],
    env: names.length ? { ...vars, WSLENV: [...names, ...(inherited ? [inherited] : [])].join(':') } : {}
  };
}

/** How to run `git args` in `cwd`: inside the distro when cwd is a WSL
 *  floor (absolute path arguments translated), else plain git. Git must run
 *  where the repo lives: a worktree made by Windows git records Windows paths
 *  that git inside Linux cannot follow, and the other way round. */
export function gitInvocation(cwd: string, args: string[]): { file: string; args: string[]; cwd?: string; distro?: string } {
  const w = process.platform === 'win32' ? parseWslPath(cwd) : null;
  if (!w) return { file: 'git', args, cwd };
  const mapped = args.map((a) => (/^[A-Za-z]:[\\/]/.test(a) || isWslPath(a) ? toLinuxPath(a, w.distro) ?? a : a));
  return { ...wslCommand(w.distro, w.linuxPath, 'git', mapped), distro: w.distro };
}

/** `wsl.exe -l -q` prints UTF-16LE with NULs and a BOM: decode and split. */
export function parseDistroList(raw: Buffer | string): string[] {
  const text = typeof raw === 'string' ? raw : raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8');
  return text.replace(/^\uFEFF/, '').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim())
    .filter((s) => s && !/^docker-desktop/i.test(s));
}

/** Installed WSL distros (empty when WSL is missing or broken). */
export function listDistros(): Promise<{ ok: boolean; distros: string[]; error?: string }> {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, distros: [], error: 'WSL is a Windows feature' });
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        const out = Buffer.isBuffer(stderr) && stderr.length ? stderr : Buffer.isBuffer(stdout) && stdout.length ? stdout : null;
        const code = (err as NodeJS.ErrnoException).code;
        resolve({ ok: false, distros: [], error: describeWslError(code && !out ? err : out ?? err) });
        return;
      }
      resolve({ ok: true, distros: parseDistroList(stdout) });
    });
  });
}

/** Run a command inside a distro and return its stdout (throws on failure). */
export function runInDistro(distro: string, cmd: string, args: string[], cwd = '~'): string {
  const c = wslCommand(distro, cwd, cmd, args);
  return execFileSync(c.file, c.args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim();
}

/** runInDistro without blocking: for anything the main process does while
 *  the UI is up (a sync wsl.exe call freezes every window until it returns). */
export function runInDistroAsync(distro: string, cmd: string, args: string[], cwd = '~'): Promise<string> {
  const c = wslCommand(distro, cwd, cmd, args);
  return new Promise((resolve, reject) => {
    execFile(c.file, c.args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout).trim());
    });
  });
}

/**
 * Claude Code keeps its temp files in `${CLAUDE_CODE_TMPDIR:-${TMPDIR:-/tmp}}/claude-<uid>`
 * and refuses to start when that folder is not the user's own with sane
 * permissions ("Temp directory … is not readable … Refusing to use it", or
 * "is owned by uid …"). /tmp is wiped on every WSL restart and shared with
 * every identity in the distro, so a WSL office's agents kept failing until
 * someone fixed /tmp/claude-<uid> by hand. This script makes the folder under
 * the user's own cache instead, persistent and private (700, repaired if it
 * was changed), and prints it on the last line. Claude creates claude-<uid>
 * inside it itself.
 */
export const AGENT_TMP_SCRIPT = 'd="${XDG_CACHE_HOME:-$HOME/.cache}/scranton-branch/tmp"; mkdir -p "$d" && chmod 700 "$d" && printf \'\\n%s\\n\' "$d"';

/** The folder to hand a WSL agent as CLAUDE_CODE_TMPDIR (see AGENT_TMP_SCRIPT),
 *  made and repaired now; null when the distro did not answer (the agent then
 *  falls back to Claude's default). */
export async function wslAgentTmpDir(distro: string): Promise<string | null> {
  try {
    const last = (await runInDistroAsync(distro, 'sh', ['-c', AGENT_TMP_SCRIPT])).split(/\r?\n/).pop()?.trim() ?? '';
    return last.startsWith('/') ? last : null;
  } catch { return null; }
}

/**
 * Create `~/offices/<name>` inside `distro` and return its Windows (UNC) path.
 * The name is reduced to a safe folder name.
 */
export function createWslOffice(distro: string, name: string): { ok: boolean; path?: string; error?: string } {
  const folder = name.trim().replace(/[^A-Za-z0-9 ._-]+/g, '').replace(/\s+/g, '-').slice(0, 60);
  if (!folder || folder.startsWith('.')) return { ok: false, error: 'give the office a name' };
  try {
    const home = runInDistro(distro, 'sh', ['-c', 'printf %s "$HOME"']);
    if (!home.startsWith('/')) return { ok: false, error: `could not find your home folder in ${distro}` };
    const linux = `${home}/offices/${folder}`;
    runInDistro(distro, 'mkdir', ['-p', linux]);
    return { ok: true, path: toWslUnc(distro, linux) };
  } catch (e) {
    return { ok: false, error: `${distro}: ${describeWslError(e, distro)}` };
  }
}

/** Does this .wslconfig text turn on mirrored networking? Quotes and a
 *  trailing comment are allowed, as WSL itself reads them. */
export function wslconfigMirrored(cfg: string): boolean {
  return /^\s*networkingMode\s*=\s*["']?mirrored["']?\s*(?:[#;].*)?$/im.test(cfg);
}

/** Does .wslconfig turn on mirrored networking (agents reach the app on localhost)? */
export function mirroredNetworking(): boolean {
  try {
    return wslconfigMirrored(readFileSync(join(homedir(), '.wslconfig'), 'utf8'));
  } catch {
    return false;
  }
}

/** Is the distro actually running with mirrored networking? .wslconfig is
 *  not the only way to turn it on (the WSL Settings app, a company policy),
 *  and a laptop already mirrored was told "port already in use inside WSL"
 *  on every retry until the line was added to the file. `wslinfo` (WSL 2.0+)
 *  answers from the running distro; when it is missing, .wslconfig decides. */
export async function distroMirrored(distro: string): Promise<boolean> {
  if (mirroredNetworking()) return true;
  try {
    return (await runInDistroAsync(distro, 'wslinfo', ['--networking-mode'])).trim().toLowerCase() === 'mirrored';
  } catch {
    return false;
  }
}
