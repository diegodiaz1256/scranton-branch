/**
 * The walk behind the Deliverables list: every file under the office's
 * research/ folder, newest first. No Electron, so node:test can run it.
 *
 * Every file is stat'ed before anything is cut: a cap applied in readdir order
 * dropped the newest files of a busy folder (a 7.5 MB proposal in a subfolder
 * after 700 old notes never showed). Size never hides a file: big ones are
 * listed and the viewer says it cannot preview them.
 */
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * A check for "is this file in a git work tree" (a project repo, an agent's
 * worktree), looking for `.git` in the folders above it, each folder asked
 * once. It stops at `stopAt` (the home folders): a home kept in git for its
 * dotfiles must not make every file in it look like project code.
 */
export function repoCheck(stopAt: string[], exists: (p: string) => boolean = existsSync): (file: string) => boolean {
  const key = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const stops = new Set(stopAt.filter(Boolean).map(key));
  const cache = new Map<string, boolean>();
  return (file) => {
    const seen: string[] = [];
    let found = false;
    for (let d = dirname(file); ; d = dirname(d)) {
      const k = key(d);
      const known = cache.get(k);
      if (known !== undefined) { found = known; break; }
      if (stops.has(k)) break;
      seen.push(k);
      if (exists(join(d, '.git'))) { found = true; break; }
      if (dirname(d) === d) break;
    }
    for (const k of seen) cache.set(k, found);
    return found;
  };
}

export interface ScannedFile { rel: string; abs: string; size: number; mtime: number }

export interface ScanOptions {
  /** Folders below research/ to go into. */
  maxDepth?: number;
  /** Files to stat at most (a runaway folder must not stall the list). */
  maxScan?: number;
  /** Files to return, the newest. */
  maxFiles?: number;
  /** Top-level folders that are not deliverables. */
  skipTop?: string[];
}

/** Stats in batches: a folder of thousands over \\wsl.localhost must not open them all at once. */
const BATCH = 64;

/** `find` arguments for the same walk run inside a WSL distro: one process
 *  instead of a stat per file across \\wsl.localhost, which on a laptop with
 *  security software made the first open of Deliverables crawl. */
export function findArgs(linuxDir: string, opts: ScanOptions = {}): string[] {
  const { maxDepth = 8, skipTop = [] } = opts;
  const dir = linuxDir.replace(/\/+$/, '');
  const prune = ['-name', '.*', ...skipTop.flatMap((t) => ['-o', '-path', `${dir}/${t}`])];
  return [dir, '-mindepth', '1', '-maxdepth', String(maxDepth + 1), '(', ...prune, ')', '-prune', '-o', '-type', 'f', '-printf', '%P\\t%s\\t%T@\\n'];
}

/** findArgs' output as scanDeliverables returns it, under `hostDir` (the
 *  \\wsl.localhost path the app opens files through). */
export function parseFindListing(out: string, hostDir: string, opts: ScanOptions = {}): { files: ScannedFile[]; total: number; truncated: boolean } {
  const { maxScan = 5000, maxFiles = 2000 } = opts;
  const files: ScannedFile[] = [];
  const lines = out.split('\n');
  for (const line of lines) {
    if (files.length >= maxScan) break;
    const m = /^(.+)\t(\d+)\t(\d+(?:\.\d+)?)$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    files.push({ rel: m[1], abs: join(hostDir, ...m[1].split('/')), size: Number(m[2]), mtime: Math.round(Number(m[3]) * 1000) });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const cut = lines.filter((l) => l.trim()).length > maxScan;
  return { files: files.slice(0, maxFiles), total: files.length, truncated: cut || files.length > maxFiles };
}

export async function scanDeliverables(dir: string, opts: ScanOptions = {}): Promise<{ files: ScannedFile[]; total: number; truncated: boolean }> {
  const { maxDepth = 8, maxScan = 5000, maxFiles = 2000, skipTop = [] } = opts;
  const files: ScannedFile[] = [];
  let scanned = 0;
  let cut = false;
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
    const dirs: Array<[string, string]> = [];
    const plain: Array<[string, string]> = [];
    for (const e of entries) {
      if (e.name.startsWith('.') || (depth === 0 && skipTop.includes(e.name))) continue;
      const a = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) dirs.push([a, r]);
      else if (e.isFile()) plain.push([a, r]);
    }
    for (let i = 0; i < plain.length; i += BATCH) {
      const room = maxScan - scanned;
      if (room <= 0) { cut = true; return; }
      const batch = plain.slice(i, i + Math.min(BATCH, room));
      scanned += batch.length;
      const stats = await Promise.all(batch.map(([a]) => stat(a).catch(() => null)));
      stats.forEach((s, k) => { if (s) files.push({ rel: batch[k][1], abs: batch[k][0], size: s.size, mtime: s.mtimeMs }); });
    }
    for (const [a, r] of dirs) await walk(a, r, depth + 1);
  };
  await walk(dir, '', 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return { files: files.slice(0, maxFiles), total: files.length, truncated: cut || files.length > maxFiles };
}
