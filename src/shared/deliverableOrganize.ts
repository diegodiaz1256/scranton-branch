/**
 * How the Deliverables list is organised. Pure, so node:test can load it.
 *
 * One axis at a time: a flat list by date ("recent"), by task, by agent, or the
 * real folder tree. In every view but the tree, a folder's main document (the
 * report, the proposal) is one entry and the files beside it (images, tables,
 * renders) are nested under it instead of listed one by one.
 */
import { extOf } from './deliverables';

export type DeliverableView = 'recent' | 'task' | 'agent' | 'folder';
export const DELIVERABLE_VIEWS: DeliverableView[] = ['recent', 'task', 'agent', 'folder'];

export interface OrgItem {
  abs: string;
  name: string;
  /** Its path under research/ ('/' separated), or none for a file elsewhere. */
  rel?: string;
  ts?: number;
  /** Who last wrote it, and everyone who did. */
  by?: string;
  authors: string[];
  /** The tasks it belongs to (the card's field or a recorded link). */
  taskIds: string[];
}

/** A file and what belongs to it (none for a lone file). */
export interface OrgEntry<I extends OrgItem> {
  item: I;
  assets: I[];
  /** The newest of the file and its assets. */
  ts: number;
  taskIds: string[];
}

export interface TaskInfo { id: string; key?: string; title?: string; status?: string; assignee?: string }

export interface OrgGroup<I extends OrgItem> {
  key: string;
  entries: Array<OrgEntry<I>>;
  ts: number;
  task?: TaskInfo;
  /** The agent's name, '' for files nobody is recorded as writing. */
  agent?: string;
}

export interface FolderNode<I extends OrgItem> {
  key: string;
  name: string;
  folders: Array<FolderNode<I>>;
  files: I[];
  /** Files in it and below. */
  count: number;
  ts: number;
}

type Cmp = (a: { name: string; ts?: number }, b: { name: string; ts?: number }) => number;
const newestFirst: Cmp = (a, b) => (b.ts ?? 0) - (a.ts ?? 0);

/** The kinds of file a folder is about: the rest beside it are its assets. */
const DOCUMENTS = new Set(['html', 'htm', 'md', 'markdown', 'mdx', 'pdf', 'docx', 'pptx', 'odt', 'odp', 'rtf', 'wiki']);
export const isDocument = (name: string): boolean => DOCUMENTS.has(extOf(name));

/** Files worth listing when an agent wrote them outside research/: documents,
 *  tables and pictures, not the code and config it edited on the way. */
const DELIVERABLE_LIKE = new Set([...DOCUMENTS, 'mmd', 'mermaid', 'csv', 'tsv', 'xlsx', 'ods', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mov', 'mp3', 'wav']);
export const isDeliverableLike = (name: string): boolean => DELIVERABLE_LIKE.has(extOf(name));

const dirOf = (rel: string): string => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
const stem = (name: string): string => { const i = name.lastIndexOf('.'); return (i > 0 ? name.slice(0, i) : name).toLowerCase(); };
// html first: it is what a proposal or report is usually written to be read as.
const docRank = (name: string): number => { const e = extOf(name); return e === 'html' || e === 'htm' ? 0 : e === 'md' || e === 'markdown' || e === 'mdx' ? 1 : e === 'pdf' ? 2 : 3; };

/**
 * One entry per file, except that inside a folder of research/ (not its root,
 * which holds unrelated files) the main document takes the other files of its
 * folder and of the folders below it as assets: images, csv, renders, and a
 * copy of itself in another format (report.pdf beside report.md). A folder
 * with several documents keeps each one; the assets go to the main one.
 */
export function bundleAssets<I extends OrgItem>(items: I[], cmp: Cmp = newestFirst): Array<OrgEntry<I>> {
  const docsByDir = new Map<string, I[]>();
  for (const i of items) {
    if (!i.rel || !i.rel.includes('/') || !isDocument(i.name)) continue;
    const d = dirOf(i.rel);
    docsByDir.set(d, [...(docsByDir.get(d) ?? []), i]);
  }
  const main = new Map<string, I>();
  for (const [d, docs] of docsByDir) {
    main.set(d, [...docs].sort((a, b) => docRank(a.name) - docRank(b.name) || (b.ts ?? 0) - (a.ts ?? 0) || a.name.localeCompare(b.name))[0]);
  }
  const assetsOf = new Map<I, I[]>();
  const owned = new Set<I>();
  for (const i of items) {
    if (!i.rel || !i.rel.includes('/')) continue;
    const own = dirOf(i.rel);
    let owner: I | undefined;
    if (isDocument(i.name)) {
      const m = main.get(own);
      // Another format of the main document is one of its renders.
      if (m && m !== i && stem(m.name) === stem(i.name)) owner = m;
    } else {
      for (let d = own; d && !owner; d = dirOf(d)) owner = main.get(d);
    }
    if (!owner) continue;
    assetsOf.set(owner, [...(assetsOf.get(owner) ?? []), i]);
    owned.add(i);
  }
  const out: Array<OrgEntry<I>> = [];
  for (const i of items) {
    if (owned.has(i)) continue;
    const assets = [...(assetsOf.get(i) ?? [])].sort(cmp);
    out.push({
      item: i,
      assets,
      ts: Math.max(i.ts ?? 0, ...assets.map((a) => a.ts ?? 0)),
      taskIds: [...new Set([...i.taskIds, ...assets.flatMap((a) => a.taskIds)])]
    });
  }
  return sortEntries(out, cmp);
}

/** Entries in the picked order; for "newest", by the newest file in the entry. */
export function sortEntries<I extends OrgItem>(entries: Array<OrgEntry<I>>, cmp: Cmp = newestFirst): Array<OrgEntry<I>> {
  return [...entries].sort((a, b) => cmp({ name: a.item.name, ts: a.ts }, { name: b.item.name, ts: b.ts }));
}

/** The task a research/ path belongs to by where it is: agents are told to
 *  write a task's deliverables in research/<ticket>/ (research/DUN-12/…). */
export function taskOfFolder(rel: string, tasks: Array<{ id: string; key?: string }>): string | null {
  const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')).toLowerCase() : '';
  if (!top) return null;
  return tasks.find((t) => t.key && t.key.toLowerCase() === top)?.id ?? null;
}

/** Work in progress first: doing, then blocked, waiting, backlog. */
const STATUS_RANK: Record<string, number> = { doing: 0, blocked: 1, todo: 2, backlog: 3 };
export const isArchivedStatus = (status?: string): boolean => status === 'done' || status === 'cancelled' || status === 'closed';

/**
 * One group per task. Active tasks first (by status, then the newest file);
 * done ones go to `archived`, newest first. Files of no task are `loose`.
 * A file of two tasks shows in both.
 */
export function groupByTask<I extends OrgItem>(entries: Array<OrgEntry<I>>, tasks: TaskInfo[], cmp: Cmp = newestFirst): {
  active: Array<OrgGroup<I>>; archived: Array<OrgGroup<I>>; loose: Array<OrgEntry<I>>;
} {
  const byTask = new Map<string, Array<OrgEntry<I>>>();
  const loose: Array<OrgEntry<I>> = [];
  const known = new Map(tasks.map((t) => [t.id, t]));
  for (const e of entries) {
    const ids = e.taskIds.filter((id) => known.has(id));
    if (!ids.length) { loose.push(e); continue; }
    for (const id of ids) byTask.set(id, [...(byTask.get(id) ?? []), e]);
  }
  const groups = [...byTask.entries()].map(([id, es]): OrgGroup<I> => ({
    key: `task:${id}`, task: known.get(id), entries: sortEntries(es, cmp), ts: Math.max(0, ...es.map((e) => e.ts))
  }));
  const rank = (g: OrgGroup<I>): number => STATUS_RANK[g.task?.status ?? ''] ?? 4;
  return {
    active: groups.filter((g) => !isArchivedStatus(g.task?.status)).sort((a, b) => rank(a) - rank(b) || b.ts - a.ts),
    archived: groups.filter((g) => isArchivedStatus(g.task?.status)).sort((a, b) => b.ts - a.ts),
    loose: sortEntries(loose, cmp)
  };
}

/** One group per agent (the last one to write the file), the most recently
 *  active first; files nobody is recorded as writing last. */
export function groupByAgent<I extends OrgItem>(entries: Array<OrgEntry<I>>, cmp: Cmp = newestFirst): Array<OrgGroup<I>> {
  const by = new Map<string, Array<OrgEntry<I>>>();
  for (const e of entries) {
    const who = e.item.by ?? e.item.authors[0] ?? '';
    by.set(who, [...(by.get(who) ?? []), e]);
  }
  return [...by.entries()]
    .map(([agent, es]): OrgGroup<I> => ({ key: `agent:${agent}`, agent, entries: sortEntries(es, cmp), ts: Math.max(0, ...es.map((e) => e.ts)) }))
    .sort((a, b) => (a.agent === '' ? 1 : 0) - (b.agent === '' ? 1 : 0) || b.ts - a.ts);
}

/**
 * The real tree of research/, every level, folders first (by name) then files;
 * and the files written elsewhere, one node per folder they are in (`dirOf`
 * names that folder for a file with no `rel`).
 */
export function folderTree<I extends OrgItem>(items: I[], dirOfAbs: (i: I) => string, cmp: Cmp = newestFirst): {
  research: FolderNode<I>; elsewhere: Array<FolderNode<I>>;
} {
  const node = (key: string, name: string): FolderNode<I> => ({ key, name, folders: [], files: [], count: 0, ts: 0 });
  const research = node('dir:', '');
  const index = new Map<string, FolderNode<I>>([['', research]]);
  const elsewhere = new Map<string, FolderNode<I>>();
  for (const i of items) {
    if (i.rel === undefined) {
      const d = dirOfAbs(i);
      let n = elsewhere.get(d);
      if (!n) { n = node(`else:${d}`, d); elsewhere.set(d, n); }
      n.files.push(i); n.count++; n.ts = Math.max(n.ts, i.ts ?? 0);
      continue;
    }
    const parts = i.rel.split('/');
    let cur = research;
    cur.count++; cur.ts = Math.max(cur.ts, i.ts ?? 0);
    for (let k = 0; k < parts.length - 1; k++) {
      const path = parts.slice(0, k + 1).join('/');
      let next = index.get(path);
      if (!next) { next = node(`dir:${path}`, parts[k]); index.set(path, next); cur.folders.push(next); }
      cur = next;
      cur.count++; cur.ts = Math.max(cur.ts, i.ts ?? 0);
    }
    cur.files.push(i);
  }
  const tidy = (n: FolderNode<I>): void => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.files.sort(cmp);
    n.folders.forEach(tidy);
  };
  tidy(research);
  const rest = [...elsewhere.values()].sort((a, b) => b.ts - a.ts);
  for (const n of rest) n.files.sort(cmp);
  return { research, elsewhere: rest };
}
