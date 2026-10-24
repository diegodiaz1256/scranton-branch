/**
 * Deliverables: what agents hand to the human (reports, plans, tables,
 * images…). They live in the office's `research/` folder (the memory already
 * mines it), a task card can point at one in its `deliverable` field, and the
 * files an agent writes during a session are seen from its tool calls. Pure:
 * main lists, the renderer previews.
 */

/** The office folder, under the hive root, where agents put deliverables. */
export const DELIVERABLES_DIR = 'research';

export type PreviewKind = 'markdown' | 'wiki' | 'mermaid' | 'image' | 'csv' | 'json' | 'html' | 'text' | 'pdf' | 'binary';

const EXT: Record<string, PreviewKind> = {
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  // Confluence wiki markup, and Mermaid diagrams.
  wiki: 'wiki', confluence: 'wiki', jira: 'wiki',
  mmd: 'mermaid', mermaid: 'mermaid',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
  csv: 'csv', tsv: 'csv',
  json: 'json', jsonl: 'text',
  html: 'html', htm: 'html',
  pdf: 'pdf',
  txt: 'text', log: 'text', yaml: 'text', yml: 'text', toml: 'text', xml: 'text', ini: 'text',
  ts: 'text', tsx: 'text', js: 'text', jsx: 'text', cjs: 'text', mjs: 'text', py: 'text', go: 'text', rs: 'text', java: 'text',
  rb: 'text', php: 'text', cs: 'text', c: 'text', h: 'text', cpp: 'text', sh: 'text', ps1: 'text', sql: 'text', css: 'text', scss: 'text'
};

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function previewKind(name: string): PreviewKind {
  return EXT[extOf(name)] ?? 'binary';
}

/** Split an absolute path into the folder and the file name (either separator). */
export function splitPath(abs: string): { dir: string; name: string } {
  const i = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'));
  return i < 0 ? { dir: '.', name: abs } : { dir: abs.slice(0, i) || abs.slice(0, 1), name: abs.slice(i + 1) };
}

/**
 * A path as the app (on Windows) can open it, from one an agent inside a WSL
 * distro wrote: /mnt/c/x → C:\\x, any other Linux path → \\\\wsl.localhost\\<distro>\\…
 * Unchanged off a WSL floor (distro null) and for paths that are not Linux ones.
 * Mirrors main/wsl.ts fromLinuxPath (without ~, which only main can resolve).
 */
export function hostPath(p: string, distro: string | null): string {
  if (!distro || !p.startsWith('/')) return p;
  const mnt = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(p);
  if (mnt) return `${mnt[1].toUpperCase()}:\\${(mnt[2] ?? '').replace(/\//g, '\\')}`;
  const clean = p.replace(/\/+$/, '') || '/';
  return `\\\\wsl.localhost\\${distro}${clean === '/' ? '\\' : clean.replace(/\//g, '\\')}`;
}

const isAbs = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');

/**
 * The file paths a task's `deliverable` text names: one or more, absolute or
 * relative to the hive root (`research/report.md`), separated by commas, spaces
 * or new lines. Anything without a file extension is not a path.
 */
export function deliverablePaths(text: string | undefined, hiveRoot: string, distro: string | null = null): string[] {
  if (!text) return [];
  const sep = hiveRoot.includes('\\') && !hiveRoot.includes('/') ? '\\' : '/';
  const out: string[] = [];
  // A whole line is one path when it is one (paths may hold spaces); otherwise
  // its words are tried one by one ("see research/report.md").
  const pieces = text.split(/[\n,;]+/).flatMap((line) => {
    const l = line.trim().replace(/^[`'"(<]+|[`'")>.]+$/g, '');
    return /^([A-Za-z]:[\\/]|\/|\.{0,2}[\\/]|[\w-]+[\\/])\S/.test(l) && /\.[A-Za-z0-9]{1,6}$/.test(l) ? [l] : l.split(/\s+/);
  });
  for (const raw of pieces) {
    const p = raw.trim().replace(/^[`'"(<]+|[`'")>.]+$/g, '');
    if (!p || /^https?:\/\//i.test(p) || !/\.[A-Za-z0-9]{1,6}$/.test(p)) continue;
    // An absolute Linux path from an agent in WSL is opened through the distro.
    const abs = isAbs(p) ? hostPath(p, distro) : `${hiveRoot.replace(/[\\/]+$/, '')}${sep}${p.replace(/^\.?[\\/]/, '')}`;
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** A small CSV/TSV reader for previews: quoted fields, doubled quotes, CRLF. */
export function parseDelimited(text: string, delimiter: string, maxRows = 200): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
      if (rows.length >= maxRows) return rows;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** The files agents wrote or edited, newest first, one entry per file, from
 *  their tool-call events: `files` (any CLI, set by main) or, for an event
 *  without it, a Claude Write/Edit's `detail` (the file path). */
export function writtenFiles(events: Array<{ event: string; tool?: string; detail?: string; files?: string[]; ts?: number; blocked?: boolean }>): Array<{ path: string; ts: number; created: boolean }> {
  const byPath = new Map<string, { path: string; ts: number; created: boolean }>();
  for (const e of events) {
    if ((e.event !== 'PreToolUse' && e.event !== 'PostToolUse') || e.blocked || !e.tool) continue;
    // A Claude Write/Edit's detail is its path; older events carry no `files`.
    const paths = e.files?.length ? e.files : (e.event === 'PreToolUse' && CLAUDE_WRITES.has(e.tool) && e.detail ? [e.detail] : []);
    const created = /^(write|write_file|write_to_file|create_file|create)$/i.test(e.tool);
    for (const path of paths) {
      if (!isAbs(path)) continue;
      const prev = byPath.get(path);
      byPath.set(path, { path, ts: e.ts ?? 0, created: (prev?.created ?? false) || created });
    }
  }
  return [...byPath.values()].sort((a, b) => b.ts - a.ts);
}

const CLAUDE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Kinds of file the human may open in their own app (default program) from
 * Deliverables. An allowlist of documents, never executables, scripts,
 * installers, shortcuts or macro-enabled Office files: the path comes from an
 * agent, and opening one of those would be running it.
 */
const OPEN_EXTERNALLY = new Set([
  'md', 'markdown', 'wiki', 'mmd', 'txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'toml',
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
  'html', 'htm', 'mp4', 'mov', 'webm', 'mp3', 'wav'
]);

export function canOpenExternally(name: string): boolean {
  return OPEN_EXTERNALLY.has(extOf(name));
}

// ─── which task a deliverable belongs to ────────────────────────────────────

export interface DeliverableLink { path: string; taskId: string; agentId: string; ts: number }

/** The task an agent is working on now: its card in "doing" (the most recently
 *  created one if, unusually, it has several). None → the write is not linked. */
export function currentTaskOf(tasks: Array<{ id: string; assignee?: string; status?: string; createdAt?: string }>, agentId: string): string | null {
  const mine = tasks.filter((t) => t.assignee === agentId && t.status === 'doing');
  if (!mine.length) return null;
  mine.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return mine[0].id;
}

const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

/** Is `path` inside `dir` (either separator, any case)? */
export function isInside(path: string, dir: string): boolean {
  const d = normPath(dir).replace(/\/$/, '');
  return normPath(path).startsWith(`${d}/`);
}

/** Record a link, newest wins per path; capped. Returns a new list. */
export function addLink(links: DeliverableLink[], link: DeliverableLink, max = 2000): DeliverableLink[] {
  const key = normPath(link.path);
  const next = [...links.filter((l) => normPath(l.path) !== key), link];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** A file an agent wrote outside research/, kept in the hive so the list still
 *  shows it after a restart (the session's tool calls are gone by then). */
export interface ElsewhereWrite { path: string; agentId: string; name: string; ts: number; created: boolean }

/** Record writes, one entry per path (newest wins; "created" sticks); the
 *  newest `max` kept. Returns the same list when nothing changed. */
export function recordElsewhere(list: ElsewhereWrite[], writes: ElsewhereWrite[], max = 300): ElsewhereWrite[] {
  let next = list;
  for (const w of writes) {
    const key = normPath(w.path);
    const prev = next.find((x) => normPath(x.path) === key);
    if (prev && prev.ts >= w.ts && prev.agentId === w.agentId) continue;
    next = [...next.filter((x) => x !== prev), { ...w, created: w.created || !!prev?.created }];
  }
  if (next === list) return list;
  next.sort((a, b) => a.ts - b.ts);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** The task a file is linked to, if any. */
export function linkFor(links: DeliverableLink[], path: string): DeliverableLink | undefined {
  const key = normPath(path);
  return links.find((l) => normPath(l.path) === key);
}
