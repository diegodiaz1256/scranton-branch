/**
 * An OS sandbox the app builds itself, for CLIs that have none of their own
 * that holds (pi, agy): bubblewrap on Linux and inside a WSL floor's distro.
 *
 * It mirrors what Claude Code's own sandbox gives an agent in this app:
 *   - the whole filesystem read-only, except the agent's writable set (the
 *     same list Claude gets in sandbox.filesystem.allowWrite: its hive folder,
 *     the hive, the project or worktree, extra dirs such as the palace), plus a
 *     private /tmp of its own; inside the hive, the other agents' folders stay
 *     read-only (what the app's path guard enforces for Claude);
 *   - the user's keys (~/.ssh…) hidden, and the cloud CLIs' logins unless
 *     the human exposed them to this agent (shared/cloudCredentials.ts);
 *   - folders it may not read at all (another agent's confidential vault)
 *     hidden the same way;
 *   - network: the host's (the agent needs its model API, and the app's
 *     services on loopback through the WSL bridge), or none.
 *
 * Paths are the ones the agent sees (Linux paths). Mount points must exist,
 * so the caller passes only paths that do (`exists`); a writable folder that
 * does not exist yet is skipped by bwrap itself (--bind-try).
 *
 * Pure: no electron, no node.
 */

import { hiddenCredentialPaths } from './cloudCredentials';

export interface BwrapProfile {
  /** Folders the agent may write (Linux paths). */
  writable: string[];
  /** Files the agent may write outside them (a token file it refreshes). */
  writableFiles?: string[];
  /** Folders inside a writable one that stay read-only (the other agents'
   *  folders inside the hive); a writable folder inside one of these (the
   *  agent's own) is opened again. */
  readOnly?: string[];
  /** The office's control files and folders (the hive's bin/, agents'
   *  settings and hook configs): read-only even inside a writable folder. */
  controls?: string[];
  /** Folders hidden from the agent: an empty tmpfs over each. */
  hide?: string[];
  /** The agent's home (for the credential folders). */
  home: string;
  /** Cloud CLI logins this agent may read (shared/cloudCredentials.ts ids);
   *  every other one is hidden. */
  exposeCredentials?: string[];
  /** 'host' (default): the host network; 'none': no network at all. */
  network?: 'host' | 'none';
}

/** The human's own keys and their agents' sockets: SSH and GPG keys, and
 *  1Password's SSH agent socket (a WSL bridge puts it in ~/.1password).
 *  Hidden from every sandboxed agent, Claude Code's too (hive.ts); git over
 *  SSH goes through the office instead (shared/sshRelay.ts). */
export const KEY_HOME_DIRS: readonly string[] = ['.ssh', '.gnupg', '.1password'];

/** Credential folders under $HOME no agent ever reads. The cloud CLIs'
 *  logins are hidden too, unless exposed to the agent (cloudCredentials.ts). */
export const SECRET_HOME_DIRS: readonly string[] = [...KEY_HOME_DIRS, '.password-store'];

/** What to hide under `home` for this profile: folders (a tmpfs over each)
 *  and single files (/dev/null over each). */
function hiddenHome(p: BwrapProfile): { dirs: string[]; files: string[] } {
  const home = p.home.replace(/\/+$/, '');
  const creds = hiddenCredentialPaths(p.exposeCredentials);
  return { dirs: [...SECRET_HOME_DIRS, ...creds.dirs].map((d) => `${home}/${d}`), files: creds.files.map((f) => `${home}/${f}`) };
}

/** WSL's interop sockets: through them a command in the distro starts Windows
 *  programs as the user, outside any Linux sandbox (ssh.exe with the Windows
 *  ssh-agent, cmd.exe). Hidden, with WSL_INTEROP unset, so nothing in the
 *  sandbox can start one. Absent on plain Linux. */
export const WSL_INTEROP_DIR = '/run/WSL';

/** CLIs the app sandboxes itself. agy has a `--sandbox` of its own, but it
 *  leaves /home and /tmp writable and only the project read-only (agy 1.4.7,
 *  tried on WSL), so it confines nothing an agent's folders would need. */
export type AppSandboxedCli = 'pi' | 'agy';

/**
 * The CLI's own state under $HOME: what it has to write to work at all, and
 * the parts of it that stay read-only (the office's hook config, and programs
 * a later run outside the sandbox would execute).
 *   - pi: only its login (its settings live in the agent's own folder);
 *   - agy: ~/.gemini/antigravity-cli (conversations, logs, login, trusted
 *     folders) and its cache; ~/.gemini/config (hooks, plugins, MCP, skills)
 *     stays read-only like the rest of $HOME.
 */
export function cliStateMounts(cli: AppSandboxedCli, home: string): { writable: string[]; writableFiles: string[]; controls: string[] } {
  const h = home.replace(/\/+$/, '');
  if (cli === 'agy') {
    const state = `${h}/.gemini/antigravity-cli`;
    // bin/ itself stays writable: agy rewrites bin/agentapi before every shell
    // command (read-only, each run_command fails). What it installed there
    // and its built-in skills are only written by an install or update.
    return { writable: [state, `${h}/.cache/antigravity`], writableFiles: [], controls: [`${state}/hooks.json`, `${state}/bin/webm_encoder`, `${state}/builtin`] };
  }
  return { writable: [], writableFiles: [`${h}/.pi/agent/auth.json`], controls: [] };
}

/** The paths a profile mounts over (for the caller's existence check). */
export function mountPoints(p: BwrapProfile): string[] {
  const h = hiddenHome(p);
  return [...h.dirs, ...h.files, WSL_INTEROP_DIR, ...(p.hide ?? []), ...(p.writableFiles ?? [])];
}

const clean = (xs: string[] | undefined): string[] => [...new Set((xs ?? []).filter((x) => typeof x === 'string' && x.startsWith('/') && !x.includes('\0')).map((x) => x.replace(/\/+$/, '') || '/'))];

/**
 * The bwrap argv (without the program) for a profile. `exists` says whether a
 * path exists where the agent runs; only existing mount points are used.
 */
export function bwrapArgs(p: BwrapProfile, exists: (path: string) => boolean): string[] {
  const args = [
    '--die-with-parent',
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    // Its own /tmp: nothing it leaves there is shared with other agents.
    '--tmpfs', '/tmp',
    // No Windows programs from inside (WSL interop, WSL_INTEROP_DIR below).
    '--unsetenv', 'WSL_INTEROP'
  ];
  if (p.network === 'none') args.push('--unshare-net');
  // Writable folders over the read-only root (a missing one is skipped).
  const writable = clean(p.writable).filter((w) => w !== '/' && w !== '/tmp');
  for (const w of writable) args.push('--bind-try', w, w);
  const ro = clean(p.readOnly);
  for (const r of ro) args.push('--ro-bind-try', r, r);
  for (const w of writable) if (ro.some((r) => w.startsWith(`${r}/`))) args.push('--bind-try', w, w);
  for (const f of clean(p.writableFiles)) if (exists(f)) args.push('--bind', f, f);
  // Over every writable bind, so nothing reopens them.
  for (const c of clean(p.controls)) args.push('--ro-bind-try', c, c);
  // Hidden last, so a writable parent cannot uncover them.
  const home = hiddenHome(p);
  const hidden = clean([...home.dirs, WSL_INTEROP_DIR, ...(p.hide ?? [])]);
  for (const h of hidden) if (exists(h)) args.push('--tmpfs', h);
  for (const f of clean(home.files)) if (exists(f)) args.push('--ro-bind', '/dev/null', f);
  return args;
}
