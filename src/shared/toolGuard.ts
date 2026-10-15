/**
 * What an agent may do with its tools beyond what the CLI itself allows,
 * checked at PreToolUse for every CLI whose hook can refuse a call.
 *
 * - Git off (Capabilities → Who has what): taking the Git server away left
 *   the agent running `git` in its shell, so "no git" did nothing. With Git
 *   off, a shell command that runs git is refused too.
 * - Its folders: an agent writes in its own folders (its workspace, its hive
 *   folder, the hive, the temp dir), not anywhere on the disk. Bypass mode
 *   lets Edit/Write reach any path, and on Windows there is no OS sandbox for
 *   the shell. A file tool writing outside, or a shell command that moves
 *   into, writes to or deletes from a folder outside, is refused. Reading
 *   elsewhere stays allowed. The check reads the command line, so it catches
 *   the plain ways out (cd, redirects, rm/mv/cp/Remove-Item…), the same inside
 *   `bash -c`, `cmd /c`, `powershell -Command` (encoded too) and `wsl`, and
 *   one-liners in python/node/perl/ruby/php (`-c`/`-e`, heredocs) that write
 *   to or delete a path outside, or start git when git is off.
 *   What it cannot read is a script in a file (`python build.py`) or a path
 *   built at run time: it is a fence, not a jail.
 */

import { writtenPathsOf } from './agentSteps';

export interface GuardPolicy {
  /** Folders the agent may write in (absolute; any spelling: C:\, /c/, /mnt/c/). */
  roots: string[];
  /** The agent's working folder: relative paths resolve against it. */
  cwd: string;
  /** False: no git at all (the Git capability is off). */
  git: boolean;
  /** False: the agent may write anywhere (the human let it out). */
  contained: boolean;
  /** Where `~` points for this agent (on a WSL floor, the distro user's home,
   *  not the Windows one the app runs as). Absent: the caller's home. */
  home?: string;
}

export interface GuardVerdict { deny: true; reason: string }

/** Comparable form of a path: forward slashes, drive letters as `/c/…`,
 *  WSL `/mnt/c/` and Cygwin `/cygdrive/c/` folded in, lower case for drive
 *  paths (Windows is case-insensitive), no trailing slash.
 *
 *  A WSL share (`\\wsl.localhost\<distro>\x`, `\\wsl$\<distro>\x`) is the
 *  same place as `/x` inside the distro. On a WSL floor the app runs on
 *  Windows and records an agent's folders in the share form, while the agent,
 *  inside the distro, names them `/home/…`: without this fold every write to
 *  its own folders (outbox, tasks.json, research/) was refused. */
export function normPath(p: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  s = s.replace(/^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(?=\/|$)/i, '') || '/';
  const drive = /^([a-zA-Z]):(\/|$)/.exec(s);
  if (drive) s = `/${drive[1].toLowerCase()}/${s.slice(drive[0].length)}`;
  s = s.replace(/^\/(?:mnt|cygdrive)\/([a-zA-Z])(\/|$)/, (_m, d: string, sl: string) => `/${d.toLowerCase()}${sl}`);
  const isDrive = /^\/[a-z](\/|$)/.test(s);
  const out: string[] = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  const joined = (s.startsWith('//') ? '//' : '/') + out.join('/');
  return isDrive ? joined.toLowerCase() : joined;
}

/** Absolute: /x, C:\x, C:/x, ~/x, \\server\x. */
function isAbsolute(p: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|[\\/]|~(?:[\\/]|$))/.test(p);
}

/** `p` as an absolute comparable path (relative ones against `cwd`; `~` against `home`). */
export function resolveFor(p: string, cwd: string, home = ''): string {
  const raw = p.trim().replace(/^["']|["']$/g, '');
  if (/^~(?:[\\/]|$)/.test(raw)) return normPath(home + raw.slice(1));
  if (isAbsolute(raw)) return normPath(raw);
  return normPath(`${cwd}/${raw}`);
}

/** True when `p` is `root` or inside it. */
export function within(p: string, root: string): boolean {
  const a = normPath(p);
  const b = normPath(root);
  if (b === '/') return true;
  const ci = /^\/[a-z](\/|$)/.test(b);
  const x = ci ? a.toLowerCase() : a;
  const y = ci ? b.toLowerCase() : b;
  return x === y || x.startsWith(y.endsWith('/') ? y : `${y}/`);
}

/** Paths a write may always reach: the null devices. */
const SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'nul', '$null']);


const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'bash', 'shell', 'run_shell_command', 'exec_command', 'local_shell']);

/** Commands that move the shell somewhere else. */
const MOVES = new Set(['cd', 'pushd', 'chdir', 'set-location', 'sl', 'push-location']);
/** Commands whose path arguments are written, moved or deleted. */
const WRITES = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'tee', 'chmod', 'chown', 'install', 'rsync', 'truncate', 'dd', 'unlink', 'shred',
  'del', 'erase', 'rd', 'move', 'copy', 'ren', 'rename', 'xcopy', 'robocopy', 'md',
  'remove-item', 'ri', 'new-item', 'ni', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'copy-item', 'cpi', 'move-item', 'mi',
  'rename-item', 'rni', 'clear-content', 'clc', 'expand-archive', 'compress-archive'
]);
/** Wrappers before the real command. */
const PREFIXES = new Set(['sudo', 'command', 'env', 'time', 'nohup', 'exec', 'builtin', 'xargs', '&', '.', 'call', 'start']);

/** Split a command line into simple commands (on && || ; | & and newlines),
 *  keeping quoted text together. Good enough to read what each one runs. */
export function splitCommands(cmd: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let hasWord = false;
  const endWord = () => { if (hasWord) words.push(cur); cur = ''; hasWord = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasWord = true; continue; }
    if (ch === '\n' || ch === ';') { endCmd(); continue; }
    if (ch === '&' || ch === '|') {
      // `2>&1` and `&>` are redirects, not separators.
      if (ch === '&' && (cmd[i - 1] === '>' || cmd[i + 1] === '>')) { cur += ch; hasWord = true; continue; }
      endCmd();
      if (cmd[i + 1] === ch) i++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === '{' || ch === '}') { endWord(); continue; }
    if (/\s/.test(ch)) { endWord(); continue; }
    cur += ch; hasWord = true;
  }
  endCmd();
  return out;
}

/** The program a simple command runs, lower case, without folder or .exe. */
function programOf(words: string[]): { name: string; args: string[] } | null {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || PREFIXES.has(words[i].toLowerCase()))) i++;
  if (i >= words.length) return null;
  const base = words[i].replace(/\\/g, '/').split('/').pop() ?? '';
  return { name: base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, ''), args: words.slice(i + 1) };
}

/** Redirect targets in a simple command (`> f`, `>>f`, `2> f`, `&> f`, `| Out-File f` is a WRITES command). */
function redirectTargets(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^(?:\d|&)?>>?(.*)$/.exec(words[i]);
    if (!m) continue;
    const t = m[1] || words[i + 1];
    if (t && !t.startsWith('&')) out.push(t);
  }
  return out;
}

/** Copies read their sources: only where they write counts (the last path;
 *  robocopy's second). */
const COPIES = new Set(['cp', 'copy', 'copy-item', 'cpi', 'xcopy', 'rsync', 'install', 'ln']);

/** Arguments that look like paths (not flags, not redirect operators). */
function pathArgs(args: string[]): string[] {
  return args.filter((a) => a && !a.startsWith('-') && !/^(?:\d|&)?>/.test(a));
}

/** The paths a write command changes. */
function writtenPaths(name: string, args: string[]): string[] {
  if (name === 'dd') return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
  const paths = pathArgs(args);
  if (name === 'robocopy') return paths.slice(1, 2);
  if (COPIES.has(name)) return paths.slice(-1);
  return paths;
}

/** Shells that run a command line given as an argument. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'wsl']);
/** Interpreters and the flag that takes inline code. */
const INLINE_FLAGS: Record<string, string[]> = {
  python: ['-c'], python3: ['-c'], py: ['-c'], node: ['-e', '--eval', '-p', '--print'], deno: ['eval'], bun: ['-e', '--eval'],
  perl: ['-e', '-E'], ruby: ['-e'], php: ['-r']
};

/** The command line a shell is asked to run, or null. */
function nestedCommand(name: string, args: string[]): string | null {
  if (name === 'cmd') {
    const i = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return i >= 0 ? args.slice(i + 1).join(' ') : null;
  }
  if (name === 'powershell' || name === 'pwsh') {
    const enc = args.findIndex((a) => /^-(?:e|ec|encodedcommand)$/i.test(a));
    if (enc >= 0 && args[enc + 1]) {
      // Base64 of UTF-16LE (shared code: no Buffer here).
      try {
        const bin = atob(args[enc + 1]);
        let s = '';
        for (let k = 0; k + 1 < bin.length; k += 2) s += String.fromCharCode(bin.charCodeAt(k) | (bin.charCodeAt(k + 1) << 8));
        return s;
      } catch { return null; }
    }
    const i = args.findIndex((a) => /^-(?:c|command)$/i.test(a));
    return i >= 0 ? args.slice(i + 1).join(' ') : null;
  }
  if (name === 'wsl') {
    const i = args.findIndex((a) => a === '-e' || a === '--exec' || a === '--');
    if (i >= 0) return args.slice(i + 1).join(' ') || null;
    // `wsl -d Ubuntu rm -rf /x`: skip wsl's own options and their values.
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) j += /^-(?:d|u|-distribution|-user|-cd)$/.test(args[j]) ? 2 : 1;
    return args.slice(j).join(' ') || null;
  }
  const i = args.findIndex((a) => /^-[a-z]*c$/.test(a));
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
}

/** Inline code an interpreter is asked to run, or null. */
function inlineCode(name: string, args: string[]): string | null {
  const flags = INLINE_FLAGS[name];
  if (!flags) return null;
  const i = args.findIndex((a) => flags.includes(a));
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
}

/** Calls that change files, across python/node/perl/ruby/php. */
const CODE_WRITES = new RegExp([
  String.raw`open\s*\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]`,
  String.raw`\.(?:write_text|write_bytes|unlink|rmdir|mkdir|touch|rename|replace|symlink_to)\s*\(`,
  String.raw`\bos\.(?:remove|unlink|rename|replace|makedirs|mkdir|rmdir|removedirs|chmod|symlink|link)\b`,
  String.raw`\bshutil\.`,
  String.raw`\b(?:writeFileSync|appendFileSync|unlinkSync|renameSync|mkdirSync|copyFileSync|cpSync|rmSync|rmdirSync|truncateSync|writeFile|appendFile|unlink|rename|mkdir|copyFile|cp|rm|rmdir|symlink|truncate|createWriteStream|writeTextFile|remove)\s*\(`,
  String.raw`\bFile\.(?:write|delete|rename|open)\b`,
  String.raw`\bFileUtils\.`,
  String.raw`\bfile_put_contents\b`,
  String.raw`\b(?:unlink|rmtree)\b`,
  String.raw`\bopen\s*\(?\s*\w*\s*,\s*['"]?[>+]`
].join('|'));
/** Code that starts a program. */
const CODE_RUNS = /\b(?:subprocess|os\.system|os\.popen|popen|execSync|execFileSync|spawnSync|exec|execFile|spawn|system|Command|Bun\.spawn|shell_exec|passthru)\b|`/;
/** "git" as a program name inside code: a string or argv item of its own. */
const CODE_GIT = /(?:^|["'`\s[(,])git(?:\.exe)?(?=["'`\s,\])]|$)/;

/** String literals in code that look like paths (absolute, ~, or climbing out). */
function codePaths(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
    const s = m[2].replace(/\\\\/g, '\\');
    if (/^(?:[a-zA-Z]:[\\/]|\/|~[\\/]|\.\.[\\/])/.test(s)) out.push(s);
  }
  return out;
}

/** Heredoc bodies fed to a program on the command line (`python - <<'EOF' … EOF`). */
function heredocs(cmd: string): Array<{ program: string; body: string }> {
  const out: Array<{ program: string; body: string }> = [];
  const re = /(?:^|[\s;&|(])([\w./\\-]+)[^\n]*?<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*(?=\n|$)/g;
  for (const m of cmd.matchAll(re)) {
    const program = (m[1].replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '');
    out.push({ program, body: m[4] });
  }
  return out;
}

const gitOff: GuardVerdict = { deny: true, reason: 'Refused: git is switched off for you (Capabilities). Leave git to an agent that has it, or tell the human.' };

/** Why a call is refused, or null. `home` resolves `~` (the policy's own home wins). */
export function guardToolCall(tool: string | undefined, input: unknown, policy: GuardPolicy, home = ''): GuardVerdict | null {
  if (!tool) return null;
  if (policy.home) home = policy.home;
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const outside = (p: string): boolean => {
    const raw = p.trim().replace(/^["']|["']$/g, '');
    if (!raw || SINKS.has(raw.toLowerCase())) return false;
    // A variable or command substitution: cannot know where it points.
    if (/^\$|%[A-Za-z_]+%/.test(raw) && !/^\$(?:HOME|env:USERPROFILE)\b/i.test(raw)) return false;
    const abs = resolveFor(raw.replace(/^\$(?:HOME|env:USERPROFILE)/i, '~'), policy.cwd, home);
    return !policy.roots.some((r) => within(abs, r));
  };
  const fenceReason = (p: string) =>
    `Refused: ${p} is outside your folders. You work in ${policy.cwd} (and your hive folder); if the job needs another place, say so to the orchestrator or the human.`;

  // Files a tool writes, in every CLI's spelling (Write/Edit, write_to_file,
  // apply_patch...): the same reading the Deliverables use.
  if (policy.contained) for (const p of writtenPathsOf(tool, inp)) if (outside(p)) return { deny: true, reason: fenceReason(p) };

  if (!SHELL_TOOLS.has(tool)) return null;
  const cmd = typeof inp.command === 'string' ? inp.command : Array.isArray(inp.command) ? (inp.command as unknown[]).join(' ') : typeof inp.cmd === 'string' ? inp.cmd : '';
  if (!cmd) return null;
  return checkShell(cmd, 0);

  /** Inline code: git when git is off, or a write to a path outside. */
  function checkCode(code: string): GuardVerdict | null {
    if (!policy.git && CODE_RUNS.test(code) && CODE_GIT.test(code)) return gitOff;
    if (!policy.contained || !CODE_WRITES.test(code)) return null;
    for (const p of codePaths(code)) if (outside(p)) return { deny: true, reason: fenceReason(p) };
    return null;
  }

  /** A command line, and whatever it hands to another shell or interpreter. */
  function checkShell(line: string, depth: number): GuardVerdict | null {
  if (depth > 3) return null;
  for (const h of heredocs(line)) {
    const v = SHELLS.has(h.program) ? checkShell(h.body, depth + 1) : INLINE_FLAGS[h.program] ? checkCode(h.body) : null;
    if (v) return v;
    // Its lines are code or input, not commands of this shell.
    line = line.replace(h.body, '');
  }
  for (const words of splitCommands(line)) {
    const prog = programOf(words);
    if (!prog) continue;
    if (!policy.git && prog.name === 'git') return gitOff;
    if (SHELLS.has(prog.name)) {
      const inner = nestedCommand(prog.name, prog.args);
      const v = inner ? checkShell(inner, depth + 1) : null;
      if (v) return v;
    }
    const code = inlineCode(prog.name, prog.args);
    if (code !== null) { const v = checkCode(code); if (v) return v; }
    if (!policy.contained) continue;
    if (MOVES.has(prog.name)) {
      const target = prog.args.find((a) => !/^-/.test(a));
      if (target && target !== '-' && outside(target)) return { deny: true, reason: fenceReason(target) };
    }
    if (prog.name === 'git') {
      const c = prog.args.indexOf('-C');
      if (c >= 0 && prog.args[c + 1] && outside(prog.args[c + 1])) return { deny: true, reason: fenceReason(prog.args[c + 1]) };
    }
    if (WRITES.has(prog.name)) {
      for (const a of writtenPaths(prog.name, prog.args)) if (outside(a)) return { deny: true, reason: fenceReason(a) };
    }
    for (const t of redirectTargets(words)) if (outside(t)) return { deny: true, reason: fenceReason(t) };
  }
  return null;
  }
}
