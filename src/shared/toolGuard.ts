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
  /** Folders the agent may neither read nor write, whatever else allows it:
   *  another agent's confidential vault (criticalConnections.ts). Any tool
   *  call or command that names a path in one is refused. */
  deny?: string[];
  /** Said instead of the usual "you work in…" when a write is refused (a
   *  custodian is told how its things leave: through the human's sign-off). */
  fenceHint?: string;
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
  return splitShell(cmd).map((c) => c.words);
}

/** splitCommands, with how deep in `( … )` / `$( … )` each command sits: a
 *  `cd` inside a subshell does not move the commands after it. */
function splitShell(cmd: string): Array<{ words: string[]; depth: number }> {
  const out: Array<{ words: string[]; depth: number }> = [];
  let words: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let hasWord = false;
  let depth = 0;
  const endWord = () => { if (hasWord) words.push(cur); cur = ''; hasWord = false; };
  const endCmd = () => { endWord(); if (words.length) out.push({ words, depth }); words = []; };
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
    if (ch === '(') { endCmd(); depth++; continue; }
    if (ch === ')') { endCmd(); depth = Math.max(0, depth - 1); continue; }
    if (ch === '{' || ch === '}') { endWord(); continue; }
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
/** Code that starts a program: a call (`system(`, `exec "…"`), not the word
 *  in prose ("the system uses git" ran nothing and was refused). */
const CODE_RUNS = /\b(?:subprocess|child_process)\b|\b(?:os\.system|os\.popen|popen|execSync|execFileSync|spawnSync|exec|execFile|spawn|system|Command|Bun\.spawn(?:Sync)?|shell_exec|passthru|proc_open|qx|%x)\s*[({]|\b(?:system|exec)\s+['"]/;
/** Interpreters where a backtick string runs a command (in JS it is a template). */
const BACKTICK_RUNS = new Set(['perl', 'ruby', 'php']);
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

/** Commands in WRITES that change no file's content (folders, permissions). */
const NOT_CONTENT = new Set(['mkdir', 'md', 'rmdir', 'rd', 'chmod', 'chown']);

/**
 * The files a shell command line writes, as spelled (relative ones joined
 * onto a `cd` before them): redirects, tee, copies and moves, touch, deletes,
 * `sed -i`, and the same inside `bash -c` or a heredoc fed to a shell. For the
 * Deliverables' history: a report appended with `echo … >> research/x.md` is
 * that agent's change. Variables and sinks (/dev/null) are left out.
 */
export function shellWrittenPaths(cmd: string, depth = 0): string[] {
  if (depth > 3 || !cmd) return [];
  const out: string[] = [];
  for (const h of heredocs(cmd)) {
    if (SHELLS.has(h.program)) out.push(...shellWrittenPaths(h.body, depth + 1));
    cmd = cmd.replace(h.body, '');
  }
  let dir = '';
  const at = (p: string): string => {
    const raw = p.trim().replace(/^["']|["']$/g, '');
    if (!dir || /^(?:[A-Za-z]:[\\/]|[\\/]|~)/.test(raw)) return raw;
    return `${dir.replace(/[\\/]+$/, '')}/${raw}`;
  };
  // A `cd` inside `( … )` moves only the rest of that subshell.
  const outer: string[] = [];
  let level = 0;
  for (const { words, depth: sub } of splitShell(cmd)) {
    for (; level < sub; level++) outer.push(dir);
    for (; level > sub; level--) dir = outer.pop() ?? dir;
    const prog = programOf(words);
    if (!prog) continue;
    if (MOVES.has(prog.name)) {
      const t = prog.args.find((a) => !a.startsWith('-'));
      dir = t ? at(t) : '~';
      continue;
    }
    if (SHELLS.has(prog.name)) {
      const inner = nestedCommand(prog.name, prog.args);
      if (inner) out.push(...shellWrittenPaths(inner, depth + 1).map(at));
    }
    if (WRITES.has(prog.name) && !NOT_CONTENT.has(prog.name)) out.push(...writtenPaths(prog.name, prog.args).map(at));
    // `sed -i 's/a/b/' f`, `perl -i -pe '…' f`: the script comes first.
    if ((prog.name === 'sed' || prog.name === 'perl') && prog.args.some((a) => /^-[a-z]*i/.test(a) || a.startsWith('--in-place'))) {
      out.push(...pathArgs(prog.args).slice(1).map(at));
    }
    out.push(...redirectTargets(words).map(at));
  }
  return [...new Set(out)].filter((p) => !!p && !p.startsWith('&') && !SINKS.has(p.toLowerCase()) && !/^\$|%[A-Za-z_]+%/.test(p));
}

/**
 * Every file one tool call writes, made absolute against the folder it ran in:
 * a write tool's path (any CLI) and, for a shell, what its command line writes.
 * An agent inside WSL reports a Linux folder: its relative writes join with '/'
 * and stay Linux paths (main maps them to \\wsl.localhost later); joined the
 * Windows way they became `\home\…` and were lost. `~` and unknown folders drop.
 */
export function callWrittenFiles(tool: string | undefined, input: unknown, cwd?: string): string[] {
  if (!tool || !input || typeof input !== 'object') return [];
  const paths = writtenPathsOf(tool, input);
  if (SHELL_TOOLS.has(tool)) {
    const inp = input as Record<string, unknown>;
    const cmd = typeof inp.command === 'string' ? inp.command : Array.isArray(inp.command) ? (inp.command as unknown[]).join(' ') : typeof inp.cmd === 'string' ? inp.cmd : '';
    paths.push(...shellWrittenPaths(cmd));
  }
  const base = cwd?.trim().replace(/[\\/]+$/, '') ?? '';
  const abs = (f: string): string | null => {
    if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(f)) return f;
    if (!base || f.startsWith('~')) return null;
    const posix = base.startsWith('/');
    const parts = [...base.split(posix ? '/' : /[\\/]/), ...f.split(/[\\/]/)];
    const out: string[] = [];
    for (const [i, part] of parts.entries()) {
      if (part === '.' || (!part && i > 0 && !(base.startsWith('\\\\') && i < 2))) continue;
      if (part === '..') { if (out.length > 1) out.pop(); continue; }
      out.push(part);
    }
    return out.join(posix ? '/' : '\\');
  };
  return [...new Set(paths.map(abs).filter((f): f is string => !!f))].slice(0, 50);
}

/** Heredoc bodies fed to a program on the command line (`python - <<'EOF' … EOF`). */
function heredocs(cmd: string): Array<{ program: string; body: string }> {
  const out: Array<{ program: string; body: string }> = [];
  // The end marker may close a `$( … )` on its own line (`EOF)`).
  const re = /(?:^|[\s;&|(])([\w./\\-]+)[^\n]*?<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*(?=\n|$|\))/g;
  for (const m of cmd.matchAll(re)) {
    const program = (m[1].replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '');
    out.push({ program, body: m[4] });
  }
  return out;
}

const gitOff: GuardVerdict = { deny: true, reason: 'Refused: git is switched off for you (Capabilities). Leave git to an agent that has it, or tell the human.' };

/** Why a call is refused, or null. `home` resolves `~` (the policy's own home wins).
 *  `cwd` is where the agent's shell is now, as its hook reports it (on a WSL
 *  floor a Linux path in the distro): relative paths resolve against it, not
 *  against the folder the agent was started in. From hive/agents/god/inbox,
 *  `cd ../..` is hive/agents, inside its folders. */
export function guardToolCall(tool: string | undefined, input: unknown, policy: GuardPolicy, home = '', cwd?: string): GuardVerdict | null {
  if (!tool) return null;
  if (policy.home) home = policy.home;
  const start = cwd && isAbsolute(cwd.trim()) ? cwd.trim() : policy.cwd;
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  /** Where `p` points from `base`, or null for a variable or substitution
   *  (cannot know where it points). */
  const resolve = (p: string, base: string): string | null => {
    const raw = p.trim().replace(/^["']|["']$/g, '');
    if (/^\$|%[A-Za-z_]+%/.test(raw) && !/^\$(?:HOME|env:USERPROFILE)\b/i.test(raw)) return null;
    return resolveFor(raw.replace(/^\$(?:HOME|env:USERPROFILE)/i, '~'), base, home);
  };
  const outside = (p: string, base = start): boolean => {
    const raw = p.trim().replace(/^["']|["']$/g, '');
    if (!raw || SINKS.has(raw.toLowerCase())) return false;
    const abs = resolve(raw, base);
    return abs !== null && !policy.roots.some((r) => within(abs, r));
  };
  // A denied folder (another agent's confidential vault): reading counts too.
  if (policy.deny?.length) {
    const hit = deniedPath(tool, inp, policy, home);
    if (hit) return { deny: true, reason: `Refused: ${hit} is confidential material only its custodian agent and the human may open. Ask the custodian through the hive (your outbox) for what you need.` };
  }
  const fenceReason = (p: string) => (policy.fenceHint
    ? `Refused: ${p} is outside your folders. ${policy.fenceHint}`
    : `Refused: ${p} is outside your folders. You work in ${policy.cwd} (and your hive folder); if the job needs another place, say so to the orchestrator or the human.`);

  // Files a tool writes, in every CLI's spelling (Write/Edit, write_to_file,
  // apply_patch...): the same reading the Deliverables use.
  if (policy.contained) for (const p of writtenPathsOf(tool, inp)) if (outside(p)) return { deny: true, reason: fenceReason(p) };

  if (!SHELL_TOOLS.has(tool)) return null;
  const cmd = typeof inp.command === 'string' ? inp.command : Array.isArray(inp.command) ? (inp.command as unknown[]).join(' ') : typeof inp.cmd === 'string' ? inp.cmd : '';
  if (!cmd) return null;
  return checkShell(cmd, 0, start);

  /** Inline code run by `program`, from `base`: git when git is off, or a
   *  write to a path outside. */
  function checkCode(code: string, base: string, program: string): GuardVerdict | null {
    const runs = CODE_RUNS.test(code) || (BACKTICK_RUNS.has(program) && code.includes('`'));
    if (!policy.git && runs && CODE_GIT.test(code)) return gitOff;
    if (!policy.contained || !CODE_WRITES.test(code)) return null;
    for (const p of codePaths(code)) if (outside(p, base)) return { deny: true, reason: fenceReason(p) };
    return null;
  }

  /** A command line run from `base`, and whatever it hands to another shell or
   *  interpreter. A `cd`/`pushd` moves the commands after it (`cd hive/research
   *  && echo x >> ../board.md` writes hive/board.md), except out of a subshell. */
  function checkShell(line: string, depth: number, base: string): GuardVerdict | null {
  if (depth > 3) return null;
  for (const h of heredocs(line)) {
    const v = SHELLS.has(h.program) ? checkShell(h.body, depth + 1, base) : INLINE_FLAGS[h.program] ? checkCode(h.body, base, h.program) : null;
    if (v) return v;
    // Its lines are code or input, not commands of this shell.
    line = line.replace(h.body, '');
  }
  let here = base;
  let level = 0;
  const outer: string[] = [];
  const pushed: string[] = [];
  for (const { words, depth: sub } of splitShell(line)) {
    for (; level < sub; level++) outer.push(here);
    for (; level > sub; level--) here = outer.pop() ?? here;
    const prog = programOf(words);
    if (!prog) continue;
    if (!policy.git && prog.name === 'git') return gitOff;
    if (SHELLS.has(prog.name)) {
      const inner = nestedCommand(prog.name, prog.args);
      const v = inner ? checkShell(inner, depth + 1, here) : null;
      if (v) return v;
    }
    const code = inlineCode(prog.name, prog.args);
    if (code !== null) { const v = checkCode(code, here, prog.name); if (v) return v; }
    if (!policy.contained) continue;
    if (MOVES.has(prog.name)) {
      // cmd's `cd /d D:\x`: /d is a switch, not a folder.
      const args = prog.args[0]?.toLowerCase() === '/d' ? prog.args.slice(1) : prog.args;
      const target = args.find((a) => !/^-/.test(a));
      if (target && target !== '-' && outside(target, here)) return { deny: true, reason: fenceReason(target) };
      const to = target === undefined ? (home || null) : target === '-' ? null : resolve(target, here);
      if (prog.name === 'pushd' || prog.name === 'push-location') pushed.push(here);
      if (to) here = to;
    } else if (prog.name === 'popd' || prog.name === 'pop-location') {
      here = pushed.pop() ?? here;
    }
    if (prog.name === 'git') {
      const c = prog.args.indexOf('-C');
      if (c >= 0 && prog.args[c + 1] && outside(prog.args[c + 1], here)) return { deny: true, reason: fenceReason(prog.args[c + 1]) };
    }
    if (WRITES.has(prog.name)) {
      for (const a of writtenPaths(prog.name, prog.args)) if (outside(a, here)) return { deny: true, reason: fenceReason(a) };
    }
    for (const t of redirectTargets(words)) if (outside(t, here)) return { deny: true, reason: fenceReason(t) };
  }
  return null;
  }
}

/** Keys that name a file or folder a tool reads or writes, across CLIs. */
const PATH_INPUT_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'absolute_path', 'dir_path', 'directory', 'target_file', 'target_directory', 'cwd', 'pattern', 'glob'];

/** The first path in a denied folder that this call names, or null. Reads the
 *  tool's path arguments, what it writes, and every word of a shell command
 *  (plus the command text itself, so `cat "$V"/x` with V spelled out, or a
 *  path glued to other text, is caught). A fence for the honest mistake and
 *  the obvious attempt; the OS sandbox's denyRead is the wall. */
export function deniedPath(tool: string, input: Record<string, unknown>, policy: GuardPolicy, home = ''): string | null {
  const deny = (policy.deny ?? []).filter(Boolean);
  if (!deny.length) return null;
  const hits = (p: string): boolean => {
    const raw = p.trim().replace(/^["']|["']$/g, '');
    if (!raw || /^\$|%[A-Za-z_]+%/.test(raw)) return false;
    const abs = resolveFor(raw, policy.cwd, home || policy.home || '');
    return deny.some((d) => within(abs, d));
  };
  const named: string[] = [];
  for (const k of PATH_INPUT_KEYS) {
    const v = input[k];
    if (typeof v === 'string') named.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') named.push(x);
  }
  if (Array.isArray(input.paths)) for (const x of input.paths) if (typeof x === 'string') named.push(x);
  named.push(...writtenPathsOf(tool, input));
  for (const p of named) if (hits(p)) return p;
  const cmd = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? (input.command as unknown[]).join(' ') : typeof input.cmd === 'string' ? input.cmd : '';
  if (!cmd) return null;
  for (const words of splitCommands(cmd)) for (const w of words) for (const part of w.split(/[=,;]/)) if (hits(part)) return part;
  // The folder spelled inside the text (quotes, globs, another shell's syntax).
  const flat = cmd.replace(/\\/g, '/').toLowerCase();
  for (const d of deny) {
    const n = normPath(d).toLowerCase();
    const tail = n.split('/').slice(-2).join('/');
    if (flat.includes(n) || (tail.includes('/') && flat.includes(tail))) return d;
  }
  return null;
}
