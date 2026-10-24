/**
 * Getting a skill's files onto disk, from a GitHub archive or a local folder.
 *
 * A skill used to be fetched one directory listing and one file at a time
 * through the GitHub contents API. That allows 60 unauthenticated calls an
 * hour, so the installer capped a skill at 60 files and 2 MB, and every skill
 * that ships data or scripts (ui-ux-pro-max: 80 files, 3 MB) was refused. Now
 * the repository comes down as ONE tarball from codeload.github.com (not the
 * API, no rate limit) and only the skill's folder is taken out of it.
 *
 * The archive is untrusted, so the reader below is deliberately small and
 * strict instead of a general-purpose tar library:
 *   - only regular files and directories are written; symlinks, hardlinks,
 *     devices and FIFOs are skipped and reported, never created;
 *   - every path is checked before anything is written (no absolute paths,
 *     no `..`, no backslashes or drive colons, no names Windows cannot hold)
 *     and re-checked after resolution against the destination folder;
 *   - the skill's unpacked size and file count are summed from the headers
 *     BEFORE extraction, so an oversized skill is refused with its real size
 *     and nothing touches the skills folder;
 *   - files are written into a staging folder next to the destination and
 *     moved into place only when all of them landed.
 *
 * Electron-free, for tests.
 */
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readSync, openSync, closeSync, renameSync, rmSync } from 'node:fs';
import { open as openFile, mkdir } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, resolve, sep, posix } from 'node:path';
import { parseWslPath, runInDistroAsync } from './wsl';

export interface TarEntry {
  /** As stored in the archive (pax/GNU long names applied), not yet checked. */
  path: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mode: number;
}

/** Where an entry's body goes; null skips it. */
export interface BodySink { write(chunk: Buffer): Promise<void>; close(): Promise<void> }
export type OnEntry = (e: TarEntry) => Promise<BodySink | null> | BodySink | null;

/** pax / GNU long-name records are a few hundred bytes; anything bigger is not one. */
const META_MAX = 1024 * 1024;
const BLOCK = 512;

function cstr(b: Buffer, off: number, len: number): string {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z < 0 ? s : s.subarray(0, z)).toString('utf8');
}

function octal(b: Buffer, off: number, len: number): number {
  // GNU base-256 for values that do not fit in octal: a file over 8 GB, which
  // no skill is. Read it anyway so the size check (not a parse error) refuses it.
  if (b[off] & 0x80) {
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + b[i];
    return v;
  }
  const s = cstr(b, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
  return sum === octal(h, 148, 8);
}

/** `<len> key=value\n` records; only `path` and `size` matter here. */
function parsePax(buf: Buffer): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {};
  let pos = 0;
  while (pos < buf.length) {
    const sp = buf.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(pos, sp).toString('ascii'), 10);
    if (!len || pos + len > buf.length) break;
    const rec = buf.subarray(sp + 1, pos + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) {
      const k = rec.slice(0, eq);
      const v = rec.slice(eq + 1);
      if (k === 'path') out.path = v;
      else if (k === 'size' && /^\d+$/.test(v)) out.size = Number(v);
    }
    pos += len;
  }
  return out;
}

/**
 * A streaming ustar/pax reader. Feed it the decompressed archive; it calls
 * `onEntry` once per member and pipes the member's body to the returned sink.
 * Bodies are awaited, so a slow destination (a WSL share) applies backpressure
 * instead of buffering the archive in memory.
 */
export class TarReader extends Writable {
  private buf: Buffer = Buffer.alloc(0);
  private state: 'header' | 'data' | 'meta' | 'pad' = 'header';
  private remaining = 0;
  private pad = 0;
  private sink: BodySink | null = null;
  private metaKind = '';
  private meta: Buffer[] = [];
  private pending: { path?: string; size?: number } = {};

  constructor(private readonly onEntry: OnEntry) { super(); }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void): void {
    this.consume(chunk).then(() => cb(), (e) => cb(e instanceof Error ? e : new Error(String(e))));
  }

  override _final(cb: (e?: Error | null) => void): void {
    const open = this.state === 'data' || this.state === 'meta';
    const close = this.sink ? this.sink.close() : Promise.resolve();
    this.sink = null;
    close.then(() => cb(open ? new Error('the archive is truncated') : null), (e) => cb(e));
  }

  override _destroy(err: Error | null, cb: (e?: Error | null) => void): void {
    // A failed install must not leave a file handle open on the staging folder.
    const s = this.sink;
    this.sink = null;
    (s ? s.close().catch(() => undefined) : Promise.resolve()).then(() => cb(err));
  }

  private async consume(chunk: Buffer): Promise<void> {
    let data = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.buf = Buffer.alloc(0);
    while (data.length) {
      if (this.state === 'header') {
        if (data.length < BLOCK) { this.buf = Buffer.from(data); return; }
        const h = data.subarray(0, BLOCK);
        data = data.subarray(BLOCK);
        if (h.every((b) => b === 0)) continue; // end-of-archive padding
        await this.header(h);
      } else if (this.state === 'pad') {
        const n = Math.min(this.pad, data.length);
        this.pad -= n;
        data = data.subarray(n);
        if (this.pad === 0) this.state = 'header';
      } else {
        const n = Math.min(this.remaining, data.length);
        const part = data.subarray(0, n);
        data = data.subarray(n);
        this.remaining -= n;
        if (this.state === 'meta') this.meta.push(Buffer.from(part));
        else if (this.sink) await this.sink.write(part);
        if (this.remaining === 0) await this.endBody();
      }
    }
  }

  private async endBody(): Promise<void> {
    if (this.state === 'meta') {
      const body = Buffer.concat(this.meta);
      this.meta = [];
      if (this.metaKind === 'x') this.pending = { ...this.pending, ...parsePax(body) };
      else if (this.metaKind === 'L') this.pending.path = cstr(body, 0, body.length);
      // 'g' (global pax: GitHub's commit id) and 'K' (long link target) are not needed.
    } else if (this.sink) {
      const s = this.sink;
      this.sink = null;
      await s.close();
    }
    this.state = this.pad ? 'pad' : 'header';
  }

  private async header(h: Buffer): Promise<void> {
    if (!checksumOk(h)) throw new Error('that download is not a valid archive');
    const flag = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    let size = octal(h, 124, 12);
    if ('xgLK'.includes(flag)) {
      if (size > META_MAX) throw new Error('that archive has an oversized header record');
      this.metaKind = flag;
      this.meta = [];
      this.remaining = size;
      this.pad = (BLOCK - (size % BLOCK)) % BLOCK;
      this.state = 'meta';
      if (size === 0) await this.endBody();
      return;
    }
    const magic = cstr(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? cstr(h, 345, 155) : '';
    const name = cstr(h, 0, 100);
    const path = this.pending.path ?? (prefix ? `${prefix}/${name}` : name);
    if (this.pending.size !== undefined) size = this.pending.size;
    this.pending = {};
    const type: TarEntry['type'] =
      flag === '0' || flag === '7' ? 'file'
      : flag === '5' ? 'dir'
      : flag === '1' || flag === '2' ? 'link'
      : 'other';
    const sink = await this.onEntry({ path, type, size, mode: octal(h, 100, 8) });
    this.sink = type === 'file' ? sink : null;
    this.remaining = size;
    this.pad = (BLOCK - (size % BLOCK)) % BLOCK;
    this.state = 'data';
    if (size === 0) await this.endBody();
  }
}

/** Read a .tar.gz file through `onEntry`. */
export async function readTarGz(file: string, onEntry: OnEntry): Promise<void> {
  await pipeline(createReadStream(file), createGunzip(), new TarReader(onEntry));
}

const WIN_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * A relative path from an archive (or a folder) we are willing to create, as
 * forward-slash segments, or null. Refused rather than repaired: a skill whose
 * archive carries `../`, an absolute path or a drive colon is not a skill this
 * app should be installing at all.
 */
export function safeRelPath(rel: string): string | null {
  if (!rel || rel.includes('\0') || rel.includes('\\') || rel.includes(':')) return null;
  if (rel.startsWith('/')) return null;
  const segs = rel.split('/').filter((s) => s !== '');
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === '.' || s === '..') return null;
    // Names Windows cannot hold: a skill must install on every platform alike.
    if (WIN_RESERVED.test(s) || /[<>"|?*\x00-\x1f]/.test(s) || /[ .]$/.test(s)) return null;
  }
  return segs.join('/');
}

/** A GitHub archive's members sit under one `<repo>-<sha>/` folder: drop it. */
export function stripArchiveRoot(p: string): string {
  const i = p.indexOf('/');
  return i < 0 ? '' : p.slice(i + 1).replace(/\/+$/, '');
}

/** Every member of the archive, root folder stripped, without writing anything. */
export async function indexArchive(file: string): Promise<TarEntry[]> {
  const out: TarEntry[] = [];
  await readTarGz(file, (e) => { out.push({ ...e, path: stripArchiveRoot(e.path) }); return null; });
  return out;
}

/** Direct children of `dir` in an archive index, shaped like a GitHub contents
 *  listing, so the repo-root resolver works on the archive with no API calls.
 *  An unknown non-root dir throws, like the API's 404. */
export function listArchiveDir(entries: readonly TarEntry[], dir: string): Array<{ name: string; path: string; type: string }> {
  const prefix = dir ? `${dir}/` : '';
  const seen = new Map<string, string>();
  for (const e of entries) {
    if (!e.path || (prefix && !e.path.startsWith(prefix))) continue;
    const rest = e.path.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash < 0 ? rest : rest.slice(0, slash);
    if (!name) continue;
    const type = slash >= 0 || e.type === 'dir' ? 'dir' : e.type === 'file' ? 'file' : e.type;
    if (!seen.has(name) || type === 'dir') seen.set(name, type);
  }
  if (dir && !seen.size) throw new Error('Not Found (404)');
  return [...seen].map(([name, type]) => ({ name, path: prefix + name, type }));
}

export interface SkillLimits { maxBytes: number; maxFiles: number }

export interface SkillContents {
  files: number;
  bytes: number;
  /** Members that are not regular files or folders (links, devices), skipped. */
  skipped: string[];
}

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;

/** "that skill is 63.2 MB unpacked; the limit is 50 MB": the real numbers, so
 *  the user knows whether it is a little over or nowhere close. */
export function overLimitMessage(c: { files: number; bytes: number }, limits: SkillLimits): string | null {
  if (c.bytes > limits.maxBytes) return `that skill is ${mb(c.bytes)} unpacked (${c.files} files); the limit is ${mb(limits.maxBytes)}`;
  if (c.files > limits.maxFiles) return `that skill has ${c.files} files; the limit is ${limits.maxFiles}`;
  return null;
}

/**
 * What extracting `skillPath` would write, from the index alone: refuses an
 * unsafe path or a folder with no SKILL.md, and totals the size.
 */
export function planArchiveSkill(entries: readonly TarEntry[], skillPath: string): SkillContents | { error: string } {
  const prefix = skillPath ? `${skillPath}/` : '';
  let files = 0;
  let bytes = 0;
  let hasSkillMd = false;
  const skipped: string[] = [];
  for (const e of entries) {
    if (!e.path || (prefix && !e.path.startsWith(prefix))) continue;
    const raw = e.path.slice(prefix.length);
    if (!raw) continue;
    const rel = safeRelPath(raw);
    if (!rel) return { error: `refusing an unsafe path in that archive: ${raw}` };
    if (e.type === 'file') {
      files++;
      bytes += e.size;
      if (rel === 'SKILL.md') hasSkillMd = true;
    } else if (e.type !== 'dir') {
      skipped.push(rel);
    }
  }
  if (!hasSkillMd) return { error: `no SKILL.md in ${skillPath || 'the repository root'}` };
  return { files, bytes, skipped };
}

/** Inside `dest` after resolution, or throw: the check that survives any path. */
function contained(dest: string, rel: string): string {
  const target = resolve(dest, ...rel.split('/'));
  if (target === dest || !target.startsWith(dest + sep)) throw new Error(`refusing to write outside the skill folder: ${rel}`);
  return target;
}

/** POSIX mode for a new file: executable only when the source was. */
const fileMode = (exec: boolean) => (exec ? 0o755 : 0o644);

function fileSink(target: string, mode: number): Promise<BodySink> {
  return openFile(target, 'w', mode).then((fh) => ({
    write: async (c: Buffer) => { await fh.write(c); },
    close: () => fh.close()
  }));
}

/**
 * Write the members under `skillPath` into `dest` (a fresh staging folder).
 * Returns the files whose source mode was executable, relative to `dest`.
 */
export async function extractArchiveSkill(file: string, skillPath: string, dest: string, limits: SkillLimits): Promise<{ executables: string[] }> {
  const prefix = skillPath ? `${skillPath}/` : '';
  const executables: string[] = [];
  let files = 0;
  let bytes = 0;
  mkdirSync(dest, { recursive: true });
  await readTarGz(file, async (e) => {
    const p = stripArchiveRoot(e.path);
    if (!p || (prefix && !p.startsWith(prefix))) return null;
    const raw = p.slice(prefix.length);
    if (!raw) return null;
    const rel = safeRelPath(raw);
    if (!rel) throw new Error(`refusing an unsafe path in that archive: ${raw}`);
    if (e.type === 'dir') { await mkdir(contained(dest, rel), { recursive: true }); return null; }
    if (e.type !== 'file') return null;
    // The plan already checked these; checked again because this is the pass that writes.
    files++;
    bytes += e.size;
    const over = overLimitMessage({ files, bytes }, limits);
    if (over) throw new Error(over);
    const target = contained(dest, rel);
    await mkdir(join(target, '..'), { recursive: true });
    const exec = (e.mode & 0o111) !== 0;
    if (exec) executables.push(rel);
    return fileSink(target, fileMode(exec));
  });
  return { executables };
}

/** Does this file start with `#!`? On Windows the only sign a script was meant
 *  to run: NTFS has no executable bit to copy. */
function hasShebang(file: string): boolean {
  let fd = -1;
  try {
    fd = openSync(file, 'r');
    const b = Buffer.alloc(2);
    return readSync(fd, b, 0, 2, 0) === 2 && b.toString('latin1') === '#!';
  } catch { return false; } finally { if (fd >= 0) try { closeSync(fd); } catch { /* noop */ } }
}

/**
 * Walk a local skill folder: regular files and folders only (a symlink is
 * skipped, never followed, so a skill cannot pull in ~/.ssh), every name
 * through the same checks as an archive member.
 */
export function planFolderSkill(src: string, limits: { maxDepth: number }): (SkillContents & { list: Array<{ rel: string; dir: boolean; exec: boolean }> }) | { error: string } {
  const list: Array<{ rel: string; dir: boolean; exec: boolean }> = [];
  const skipped: string[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (abs: string, rel: string, depth: number): string | null => {
    if (depth > limits.maxDepth) return 'that folder nests deeper than this installer will follow';
    for (const name of readdirSync(abs)) {
      const childRel = rel ? `${rel}/${name}` : name;
      const safe = safeRelPath(childRel);
      if (!safe) return `refusing a file name this app will not copy: ${childRel}`;
      const st = lstatSync(join(abs, name));
      if (st.isDirectory()) {
        list.push({ rel: safe, dir: true, exec: false });
        const err = walk(join(abs, name), safe, depth + 1);
        if (err) return err;
      } else if (st.isFile()) {
        files++;
        bytes += st.size;
        const exec = process.platform === 'win32' ? hasShebang(join(abs, name)) : (st.mode & 0o111) !== 0;
        list.push({ rel: safe, dir: false, exec });
      } else {
        skipped.push(safe);
      }
    }
    return null;
  };
  try {
    const err = walk(src, '', 0);
    if (err) return { error: err };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!list.some((f) => f.rel === 'SKILL.md' && !f.dir)) return { error: 'That folder has no SKILL.md.' };
  return { files, bytes, skipped, list };
}

/** Copy a planned folder into `dest` (a fresh staging folder). */
export async function copyFolderSkill(src: string, list: ReadonlyArray<{ rel: string; dir: boolean; exec: boolean }>, dest: string): Promise<{ executables: string[] }> {
  mkdirSync(dest, { recursive: true });
  const executables: string[] = [];
  for (const f of list) {
    const target = contained(dest, f.rel);
    if (f.dir) { await mkdir(target, { recursive: true }); continue; }
    await mkdir(join(target, '..'), { recursive: true });
    const from = join(src, ...f.rel.split('/'));
    // Re-checked at copy time: a file swapped for a symlink since the plan is skipped.
    if (!lstatSync(from).isFile()) continue;
    const sink = await fileSink(target, fileMode(f.exec));
    try {
      for await (const chunk of createReadStream(from)) await sink.write(chunk as Buffer);
    } finally { await sink.close(); }
    if (f.exec) executables.push(f.rel);
  }
  return { executables };
}

/**
 * Restore executable bits on a skill that landed in a WSL distro. Windows
 * writes through \\wsl.localhost cannot set a Linux mode (chmod there only
 * toggles read-only), so every file arrives 0644 and a skill's scripts would
 * not run for the Linux agent. One `chmod +x` inside the distro fixes that.
 * On macOS/Linux the mode was set when the file was created; on a Windows
 * folder there is no bit to set.
 */
export async function restoreExecBits(
  dest: string,
  rels: readonly string[],
  run: (distro: string, cmd: string, args: string[]) => Promise<string> = runInDistroAsync
): Promise<void> {
  if (!rels.length) return;
  const w = process.platform === 'win32' ? parseWslPath(dest) : null;
  if (!w) return;
  for (let i = 0; i < rels.length; i += 100) {
    await run(w.distro, 'chmod', ['+x', '--', ...rels.slice(i, i + 100).map((r) => posix.join(w.linuxPath, r))]);
  }
}

/** A staging folder next to `root` (same filesystem, so the final move is a
 *  rename) and outside it (so no CLI ever loads a half-written skill). */
export function stagingDir(root: string): string {
  const parent = resolve(root, '..');
  mkdirSync(root, { recursive: true });
  return join(parent, `.skill-install-${process.pid}-${Date.now().toString(36)}`);
}

/** Move the finished staging folder into place. */
export function commitStaging(staging: string, dest: string): void {
  if (existsSync(dest)) throw new Error(`Already installed at ${dest}`);
  renameSync(staging, dest);
}

export function discard(path: string | null): void {
  if (!path) return;
  try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
}
