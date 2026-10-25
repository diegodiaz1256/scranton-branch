/**
 * Agent files on disk (shared/agentFile.ts has the format and the rules).
 * Reading one is bounded before it is parsed; writing an imported skill's
 * files stays inside that skill's new folder, checked again here after the
 * schema already refused anything path-like.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { AGENT_FILE_MAX_BYTES, isSafeSkillPath, parseAgentFile, type AgentFile, type AgentFileSkillFile } from '../shared/agentFile';

/** Read and validate an agent file. Errors name the file, never its folder. */
export function readAgentFile(path: string): { ok: true; file: AgentFile } | { ok: false; error: string } {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, error: 'not a file' };
    if (st.size > AGENT_FILE_MAX_BYTES) return { ok: false, error: 'the file is too large' };
    const v = parseAgentFile(readFileSync(path, 'utf8'));
    return v.ok && v.file ? { ok: true, file: v.file } : { ok: false, error: v.errors.join('; ') };
  } catch {
    return { ok: false, error: 'could not read the file' };
  }
}

/** A skill's text files for an export: plain files only (no links, no hidden
 *  ones, no binaries), paths with '/', within the format's limits. */
export function readSkillFiles(dir: string, limits = { files: 64, bytes: 200 * 1024 }): AgentFileSkillFile[] {
  const out: AgentFileSkillFile[] = [];
  const walk = (d: string, rel: string[]) => {
    let names: string[] = [];
    try { names = readdirSync(d).sort(); } catch { return; }
    for (const n of names) {
      if (out.length >= limits.files) return;
      if (n.startsWith('.')) continue;
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      const parts = [...rel, n];
      if (st.isDirectory()) { if (parts.length < 6) walk(p, parts); continue; }
      if (!st.isFile() || st.size > limits.bytes) continue;
      const path = parts.join('/');
      if (!isSafeSkillPath(path)) continue;
      const buf = readFileSync(p);
      if (buf.includes(0)) continue;
      out.push({ path, content: buf.toString('utf8') });
    }
  };
  walk(dir, []);
  return out;
}

/** Write an imported skill's files into `<store>/<dir>`, which must not exist
 *  yet. Every target is resolved and checked to sit inside it. */
export function writeSkillFiles(store: string, dir: string, files: AgentFileSkillFile[]): { ok: boolean; error?: string } {
  const root = resolve(store, dir);
  const rel = relative(resolve(store), root);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) return { ok: false, error: 'bad skill folder' };
  if (existsSync(root)) return { ok: false, error: 'a skill with that name is already installed' };
  for (const f of files) {
    if (!isSafeSkillPath(f.path)) return { ok: false, error: 'bad skill file path' };
    const target = resolve(root, ...f.path.split('/'));
    const r = relative(root, target);
    if (!r || r.startsWith('..') || isAbsolute(r)) return { ok: false, error: 'bad skill file path' };
  }
  mkdirSync(root, { recursive: true });
  for (const f of files) {
    const target = resolve(root, ...f.path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.content, { encoding: 'utf8', flag: 'wx' });
  }
  return { ok: true };
}
