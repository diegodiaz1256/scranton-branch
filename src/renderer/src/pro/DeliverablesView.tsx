import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { MermaidDiagram } from '@/markdown/MermaidDiagram';
import { confluenceToMarkdown } from '@shared/confluenceWiki';
import { DELIVERABLE_SORTS, compareDeliverables, ticketQuery, type DeliverableSort } from '@shared/deliverableSort';
import { DELIVERABLE_VIEWS, bundleAssets, isDeliverableLike, folderTree, groupByAgent, groupByTask, taskOfFolder, type DeliverableView, type FolderNode, type OrgEntry, type OrgGroup, type TaskInfo } from '@shared/deliverableOrganize';
import { canOpenExternally, deliverablePaths, parseDelimited, previewKind, splitPath, extOf } from '@shared/deliverables';
import { PREVIEW_BUDGET, headOf, piecesWithin, splitMarkdown } from '@shared/previewChunks';
import { useStore, type Agent } from '@/store/store';
import type { KeyedTask } from './data';
import { useProStore } from './proStore';
import { FileTypeBadge } from '@/components/FileTypeBadge';
import { AuthorAvatars } from './AuthorAvatars';
import { PdfPreview } from './PdfPreview';

/**
 * Deliverables — what the agents made for you, in one place: the office's
 * research/ folder, files linked from task cards, and documents agents wrote
 * elsewhere. One way of organising at a time (shared/deliverableOrganize.ts):
 * newest first, by task, by agent, or the folder tree. Pick one to read it here
 * (Markdown rendered, tables as tables, images shown); anything else opens in
 * your file browser.
 */

type Listing = Awaited<ReturnType<typeof window.cth.deliverablesList>>;
interface Item {
  abs: string;
  name: string;
  /** Its path under research/, none for a file elsewhere. */
  rel?: string;
  /** Folder under research/ (or the full folder for a file elsewhere). */
  folder: string;
  ts?: number;
  size?: number;
  /** Who last wrote it, and whether that write created it. */
  by?: string;
  created?: boolean;
  /** Everyone who changed it, from its git history, most recent first. */
  authors: string[];
  taskIds: string[];
  hidden?: boolean;
}
interface Task extends TaskInfo { title: string; label: string; ownerName?: string }

const readLs = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try { const s = window.localStorage.getItem(key) as T | null; return s && allowed.includes(s) ? s : fallback; } catch { return fallback; }
};
const writeLs = (key: string, value: string): void => { try { window.localStorage.setItem(key, value); } catch { /* noop */ } };
const LS_SORT = 'cth.dlv.sort';
const LS_VIEW = 'cth.dlv.view';
const LS_COLLAPSED = 'cth.dlv.collapsed';
const readCollapsed = (): Record<string, boolean> => {
  try { return JSON.parse(window.localStorage.getItem(LS_COLLAPSED) ?? '{}') as Record<string, boolean>; } catch { return {}; }
};

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtWhen = (ts: number): string => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pathKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

/** The same value while `sig` is the same: the board and the roster are polled
 *  and arrive as new arrays every few seconds, and a new array would rebuild
 *  the whole list (and, with it, re-render the open document) for nothing. */
function useStable<T>(value: T, sig: string): T {
  const ref = useRef<{ sig: string; value: T } | null>(null);
  if (!ref.current || ref.current.sig !== sig) ref.current = { sig, value };
  return ref.current.value;
}

export function DeliverablesView({ tasks: rawTasks, roster: rawRoster }: { tasks: KeyedTask[]; roster: Agent[] }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Listing | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((n) => n + 1);
  // Arriving from a task's "Open": show that task's deliverables only.
  const focusTask = useProStore((s) => s.focusTask);
  const setFocusTask = useProStore((s) => s.setFocusTask);
  // Arriving from a path clicked in a terminal: open that file.
  const focusDeliverable = useProStore((s) => s.focusDeliverable);
  const setFocusDeliverable = useProStore((s) => s.setFocusDeliverable);

  useEffect(() => {
    let alive = true;
    let soon: ReturnType<typeof setTimeout> | undefined;
    const load = () => { void window.cth.deliverablesList().then((d) => {
      if (!alive) return;
      setData(d);
      // The list came before its authors (a first git log): fetch them shortly.
      clearTimeout(soon);
      if (d.authorsPending) soon = setTimeout(load, 1500);
    }).catch(() => {}); };
    load();
    // Not faster: on a WSL floor every listing crosses \\wsl.localhost.
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); clearTimeout(soon); };
  }, [reloadTick]);

  // Names by agent id. The orchestrator is not in every roster list: fall back to the whole floor.
  const agents = useStore((s) => s.agents);
  const names = useStable(
    new Map([...agents, ...rawRoster].map((a) => [a.id, a.name])),
    [...agents, ...rawRoster].map((a) => `${a.id}=${a.name}`).join('|')
  );
  const who = (id?: string): string => (id ? names.get(id) ?? id : '');
  const tasks = useStable(rawTasks, rawTasks.map((x) => [x.id, x.key, x.title, x.status, x.assignee, x.deliverable].join('')).join(''));
  const taskInfo = useMemo(() => new Map(tasks.map((x): [string, Task] => [x.id, {
    id: x.id, key: x.key, title: x.title, status: x.status, assignee: x.assignee,
    label: [x.key, x.title].filter(Boolean).join(' · '), ownerName: x.assignee ? names.get(x.assignee) ?? x.assignee : undefined
  }])), [tasks, names]);

  const hidden = useMemo(() => new Set((data?.hidden ?? []).map(pathKey)), [data]);

  /** Every deliverable once: research/ files, files task cards point at, and
   *  documents agents wrote elsewhere; each with its tasks and its authors. */
  const items = useMemo<Item[]>(() => {
    if (!data?.root) return [];
    const root = data.root;
    // Who last wrote each path: this session's tool calls, else the agent its task link records.
    const lastWrite = new Map<string, { name: string; created: boolean; ts: number }>();
    for (const w of [...(data.elsewhere ?? []), ...data.written]) {
      const k = pathKey(w.path);
      const prev = lastWrite.get(k);
      if (!prev || w.ts > prev.ts) lastWrite.set(k, { name: w.name, created: w.created, ts: w.ts });
    }
    const taskIds = new Map<string, Set<string>>();
    const owner = new Map<string, string>();
    const link = (abs: string, taskId: string, agentId?: string): void => {
      const k = pathKey(abs);
      taskIds.set(k, (taskIds.get(k) ?? new Set()).add(taskId));
      if (agentId && !owner.has(k)) owner.set(k, agentId);
    };
    for (const l of data.links) link(l.path, l.taskId, l.agentId);
    const fromCards: string[] = [];
    for (const task of tasks) {
      for (const abs of deliverablePaths(task.deliverable, root, data.distro)) { link(abs, task.id); fromCards.push(abs); }
    }
    const out: Item[] = [];
    const seen = new Set<string>();
    const add = (abs: string, base: { name: string; rel?: string; folder: string; ts?: number; size?: number }): void => {
      const k = pathKey(abs);
      if (seen.has(k)) return;
      seen.add(k);
      const w = lastWrite.get(k);
      const hist = base.rel ? data.authors?.[`research/${base.rel}`] : undefined;
      const ids = [...(taskIds.get(k) ?? [])];
      // The latest writer: this session's tool call, else the git history, else
      // the task link, else (nobody recorded) the task's owner.
      const cardOwner = ids.map((id) => tasks.find((x) => x.id === id)?.assignee).find(Boolean);
      const by = w?.name ?? hist?.last ?? (owner.has(k) ? who(owner.get(k)) : cardOwner ? who(cardOwner) : undefined);
      const authors = [...new Set([by, ...(hist?.authors ?? [])].filter((x): x is string => !!x))];
      out.push({ abs, ...base, ts: Math.max(base.ts ?? 0, w?.ts ?? 0) || undefined, by, created: w?.created, authors, taskIds: ids, hidden: hidden.has(k) || undefined });
    };
    for (const f of data.files) {
      const byFolder = taskOfFolder(f.rel, tasks);
      if (byFolder) link(f.abs, byFolder);
      const parts = f.rel.split('/');
      add(f.abs, { name: parts[parts.length - 1], rel: f.rel, folder: parts.slice(0, -1).join('/'), ts: f.mtime, size: f.size });
    }
    for (const w of data.elsewhere ?? []) { const sp = splitPath(w.path); add(w.path, { name: sp.name, folder: sp.dir, ts: w.mtime, size: w.size }); }
    for (const abs of [...fromCards, ...data.links.map((l) => l.path)]) {
      // A linked file the walk did not return (deleted, or outside research/).
      if (seen.has(pathKey(abs))) continue;
      const sp = splitPath(abs);
      add(abs, { name: sp.name, folder: sp.dir });
    }
    return out;
    // `who` reads `names`.
  }, [data, tasks, names, hidden]);

  // Filters: by kind of file and by who wrote it.
  const [typeFilter, setTypeFilter] = useState('');
  const [byFilter, setByFilter] = useState('');
  const types = useMemo(() => [...new Set(items.map((i) => extOf(i.name) || 'file'))].sort(), [items]);
  const writers = useMemo(() => [...new Set(items.flatMap((i) => i.authors))].sort(), [items]);
  const [view, setViewState] = useState<DeliverableView>(() => readLs(LS_VIEW, DELIVERABLE_VIEWS, 'recent'));
  const setView = (v: DeliverableView) => { setViewState(v); writeLs(LS_VIEW, v); };
  const [sort, setSortState] = useState<DeliverableSort>(() => readLs(LS_SORT, DELIVERABLE_SORTS, 'recent'));
  const setSort = (s: DeliverableSort) => { setSortState(s); writeLs(LS_SORT, s); };
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  // The file a terminal link opened: its sections open (even ones closed
  // before) and its row scrolls into view, until a section is toggled.
  const [reveal, setReveal] = useState<string | null>(null);
  const setOpen = (key: string, open: boolean) => { setReveal(null); setCollapsed((c) => {
    const next = { ...c, [key]: !open };
    writeLs(LS_COLLAPSED, JSON.stringify(next));
    return next;
  }); };
  // Assets shown under their document: for this visit only.
  const [openAssets, setOpenAssets] = useState<Record<string, boolean>>({});

  // A file just written may not be in the listing in hand: ask for a fresh one
  // and wait for it before giving up on the file.
  const askedWith = useRef<Listing | null | undefined>(undefined);
  useEffect(() => { if (focusDeliverable) { askedWith.current = data; reload(); } }, [focusDeliverable]);
  useEffect(() => {
    if (!focusDeliverable || !data) return;
    const k = pathKey(focusDeliverable);
    const hit = items.find((i) => pathKey(i.abs) === k);
    if (!hit && data === askedWith.current) return;
    setFocusDeliverable(null);
    if (!hit) return;
    // Nothing may hide it: no search, filter or task focus.
    setQuery(''); setTypeFilter(''); setByFilter(''); setFocusTask(null);
    if (hit.hidden) setShowHidden(true);
    setSelected(hit.abs);
    setReveal(hit.abs);
  }, [focusDeliverable, data, items]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    const id = requestAnimationFrame(() => {
      const el = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-dlv-row]') ?? [])].find((x) => x.dataset.dlvRow === reveal);
      el?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(id);
  }, [reveal, view]);

  const q = query.trim().toLowerCase();
  // "DUN-12" in the search: that ticket's deliverables, not DUN-120's too.
  const ticket = ticketQuery(q);
  const filtering = !!(q || typeFilter || byFilter);
  // research/ also holds what agents left on the way (logs, json, scripts):
  // listed only on request, or when that kind of file is the filter.
  const isClutter = (i: Item): boolean => !!i.rel && !isDeliverableLike(i.name) && !i.taskIds.length;
  const clutter = useMemo(() => items.filter((i) => isClutter(i) && (showHidden || !i.hidden)).length, [items, showHidden]);
  const shownItems = useMemo(() => items.filter((i) =>
    (showHidden || !i.hidden)
    && (showAllFiles || !!typeFilter || !isClutter(i))
    && (!focusTask || i.taskIds.includes(focusTask))
    && (!ticket || i.taskIds.some((id) => (taskInfo.get(id)?.key ?? id).toLowerCase() === ticket))
    && (!q || ticket || `${i.name} ${i.folder} ${i.by ?? ''} ${i.abs} ${i.taskIds.map((id) => taskInfo.get(id)?.label ?? '').join(' ')}`.toLowerCase().includes(q))
    && (!typeFilter || (extOf(i.name) || 'file') === typeFilter)
    && (!byFilter || i.authors.includes(byFilter))
  ), [items, showHidden, showAllFiles, focusTask, ticket, q, typeFilter, byFilter, taskInfo]);
  const cmp = useMemo(() => compareDeliverables(sort), [sort]);
  const entries = useMemo(() => bundleAssets(shownItems, cmp), [shownItems, cmp]);
  const current = selected && shownItems.some((i) => i.abs === selected) ? selected : entries[0]?.item.abs ?? null;
  const currentItem = useMemo(() => shownItems.find((i) => i.abs === current), [shownItems, current]);
  const currentTasks = useMemo(() => (currentItem?.taskIds ?? []).map((id) => ({ id, label: taskInfo.get(id)?.label ?? id })), [currentItem, taskInfo]);
  const focused = focusTask ? taskInfo.get(focusTask) : undefined;
  const [folderError, setFolderError] = useState<string | null>(null);
  const officeDir = data?.dir ? pathKey(data.dir).replace(/\/$/, '') + '/' : null;
  // Searching or filtering opens every section that has a match.
  const isOpen = (key: string, byDefault: boolean, holdsCurrent = false): boolean =>
    filtering || !!focusTask || (holdsCurrent && !!reveal && reveal === current) || (key in collapsed ? !collapsed[key] : byDefault || holdsCurrent);

  const row = (i: Item, depth: number, entry?: OrgEntry<Item>, showTasks = true) => {
    const assetsOpen = !!entry?.assets.length && (filtering || openAssets[i.abs] || entry.assets.some((a) => a.abs === current));
    return (
      <div key={i.abs}>
        <FileRow item={i} depth={depth} selected={current === i.abs} onSelect={setSelected}
          tickets={showTasks ? (entry?.taskIds ?? i.taskIds).map((id) => taskInfo.get(id)?.key ?? '').filter(Boolean) : []}
          assets={entry?.assets.length ?? 0} assetsOpen={assetsOpen}
          onToggleAssets={() => setOpenAssets((o) => ({ ...o, [i.abs]: !assetsOpen }))} />
        {assetsOpen && entry!.assets.map((a) => (
          <FileRow key={a.abs} item={a} depth={depth + 1} selected={current === a.abs} onSelect={setSelected} tickets={[]} assets={0} assetsOpen={false} onToggleAssets={() => {}} />
        ))}
      </div>
    );
  };

  const section = (key: string, label: string, count: number, open: boolean, body: () => ReactNode, opts: { sub?: string; strong?: boolean; path?: boolean; depth?: number } = {}) => (
    <section key={key}>
      <button onClick={() => setOpen(key, !open)} aria-expanded={open}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: `8px 12px 8px ${12 + (opts.depth ?? 0) * 14}px`, border: 'none', borderBottom: '1px solid var(--pro-line)', cursor: 'pointer', textAlign: 'start', font: 'inherit', color: 'inherit',
          background: opts.strong ? 'var(--cth-cream-100)' : 'transparent', ...(opts.depth ? {} : { position: 'sticky', top: 0, zIndex: 1 }) }}>
        <span style={{ width: 10, flexShrink: 0, fontSize: 10, color: 'var(--pro-muted)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span className={opts.path ? 'pro-mono' : undefined} style={opts.strong ? { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : opts.path ? { fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : { fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--pro-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>{label}</span>
          {opts.sub && <span className="pro-sub" style={{ fontSize: 11 }}>{opts.sub}</span>}
        </span>
        <span className="pro-chip" style={{ flexShrink: 0 }}>{count}</span>
      </button>
      {open && body()}
    </section>
  );

  const taskSection = (g: OrgGroup<Item>, depth = 0) => {
    const task = g.task ? taskInfo.get(g.task.id) : undefined;
    const holds = g.entries.some((e) => e.item.abs === current || e.assets.some((a) => a.abs === current));
    return section(g.key, task?.label ?? g.key, g.entries.length, isOpen(g.key, true, holds), () => g.entries.map((e) => row(e.item, depth + 1, e, false)), {
      strong: true, depth,
      sub: [task?.ownerName, task?.status && t(`taskHistory.status_${task.status}`, { defaultValue: task.status })].filter(Boolean).join(' · ')
    });
  };

  const folderSection = (n: FolderNode<Item>, depth: number, label: string): ReactNode => {
    const holds = n.files.some((f) => f.abs === current) || (!!currentItem?.rel && (n.key === 'dir:' || currentItem.rel.startsWith(`${n.key.slice(4)}/`)));
    return section(n.key, label, n.count, isOpen(n.key, depth === 0, holds), () => [
      ...n.folders.map((f) => folderSection(f, depth + 1, `${f.name}/`)),
      ...n.files.map((f) => row(f, depth + 1))
    ], { depth, path: true });
  };

  let list: ReactNode;
  if (view === 'task') {
    const g = groupByTask(entries, tasks.filter((x) => taskInfo.has(x.id)).map((x) => taskInfo.get(x.id)!), cmp);
    const archivedOpen = isOpen('archived', false, g.archived.some((a) => a.entries.some((e) => e.item.abs === current || e.assets.some((x) => x.abs === current))));
    list = <>
      {g.active.map((x) => taskSection(x))}
      {g.archived.length > 0 && section('archived', t('pro.dlv.group_archived'), g.archived.length, archivedOpen, () => g.archived.map((x) => taskSection(x, 1)))}
      {g.loose.length > 0 && section('notask', t('pro.dlv.group_noTask'), g.loose.length, isOpen('notask', true), () => g.loose.map((e) => row(e.item, 1, e)))}
    </>;
  } else if (view === 'agent') {
    list = groupByAgent(entries, cmp).map((g) => section(g.key, g.agent || t('pro.dlv.group_noAuthor'), g.entries.length,
      isOpen(g.key, true, g.entries.some((e) => e.item.abs === current || e.assets.some((a) => a.abs === current))),
      () => g.entries.map((e) => row(e.item, 1, e)), { strong: !!g.agent }));
  } else if (view === 'folder') {
    const tree = folderTree(shownItems, (i) => i.folder, cmp);
    list = <>
      {tree.research.count > 0 && folderSection(tree.research, 0, `${data?.dir ? splitPath(data.dir).name : 'research'}/`)}
      {tree.elsewhere.length > 0 && section('elsewhere', t('pro.dlv.group_elsewhere'), tree.elsewhere.reduce((s, n) => s + n.count, 0), isOpen('elsewhere', true, tree.elsewhere.some((n) => n.files.some((f) => f.abs === current))),
        () => tree.elsewhere.map((n) => section(n.key, n.name, n.count, isOpen(n.key, true, n.files.some((f) => f.abs === current)), () => n.files.map((f) => row(f, 2)), { depth: 1, path: true })))}
    </>;
  } else {
    list = entries.map((e) => row(e.item, 0, e));
  }

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.nav.deliverables')}</h2>
        <span className="pro-sub">{t('pro.dlv.sub')}</span>
        {data?.dir && (
          <div className="pro-head-end" style={{ gap: 6, flexWrap: 'wrap' }}>
            {(clutter > 0 || showAllFiles) && (
              <button className="pro-btn" aria-pressed={showAllFiles} onClick={() => setShowAllFiles((v) => !v)}>
                {showAllFiles ? t('pro.dlv.documentsOnly') : t('pro.dlv.showAllFiles', { count: clutter })}
              </button>
            )}
            {(hidden.size > 0 || showHidden) && (
              <button className="pro-btn" aria-pressed={showHidden} onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? t('pro.dlv.hideHidden') : t('pro.dlv.showHidden', { count: hidden.size })}
              </button>
            )}
            <button className="pro-btn" onClick={() => { setFolderError(null); void window.cth.revealPath(data.dir!).then((r) => { if (!r.ok) setFolderError(r.error ?? t('pro.dlv.openFailed')); }); }}>{t('pro.dlv.openFolder')}</button>
          </div>
        )}
        {folderError && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12, flexBasis: '100%' }}>{folderError}</span>}
      </div>

      {!data?.root ? <p className="pro-sub">{t('pro.dlv.noOffice')}</p> : (
        // Wraps when the window is narrow: the list goes on top at full width
        // and the preview gets the whole width below it, instead of both
        // squeezing side by side.
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <aside style={{ flex: '1 1 260px', maxWidth: 340, minWidth: 0, maxHeight: '100%', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 220 }}>
            <div className="pro-switch" role="group" aria-label={t('pro.dlv.organise')} style={{ alignSelf: 'flex-start', flexWrap: 'wrap' }}>
              {DELIVERABLE_VIEWS.map((v) => <button key={v} aria-pressed={view === v} onClick={() => setView(v)}>{t(`pro.dlv.view_${v}`)}</button>)}
            </div>
            <input className="pro-input" placeholder={t('pro.dlv.searchTicket')} value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="pro-row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <select className="pro-input" style={{ flex: '1 1 90px', minWidth: 0 }} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label={t('pro.dlv.filterType')}>
                <option value="">{t('pro.dlv.allTypes')}</option>
                {types.map((x) => <option key={x} value={x}>{x.toUpperCase()}</option>)}
              </select>
              <select className="pro-input" style={{ flex: '1 1 110px', minWidth: 0 }} value={byFilter} onChange={(e) => setByFilter(e.target.value)} aria-label={t('pro.dlv.filterBy')}>
                <option value="">{t('pro.dlv.everyone')}</option>
                {writers.map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
              <select className="pro-input" style={{ flex: '1 1 90px', minWidth: 0 }} value={sort} onChange={(e) => setSort(e.target.value as DeliverableSort)} aria-label={t('pro.dlv.sortBy')}>
                {DELIVERABLE_SORTS.map((s) => <option key={s} value={s}>{t(`pro.dlv.sort_${s}`)}</option>)}
              </select>
            </div>
            {focusTask && (
              <div className="pro-row" style={{ gap: 6 }}>
                <span className="pro-chip pro-chip-on" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 250 }}>{focused?.label ?? focusTask}</span>
                <button className="pro-btn" style={{ padding: '2px 8px' }} onClick={() => setFocusTask(null)}>{t('pro.dlv.showAll')}</button>
              </div>
            )}
            <div ref={listRef} className="pro-card" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 0 }}>
              {shownItems.length === 0 && <p className="pro-sub" style={{ margin: 0, padding: 14, fontSize: 12.5 }}>{t(focusTask ? 'pro.dlv.noneForTask' : 'pro.dlv.empty', { dir: data.dir })}</p>}
              {list}
              {data.truncated && <p className="pro-sub" style={{ margin: 0, padding: '8px 12px', fontSize: 11 }}>{t('pro.dlv.truncated', { shown: data.files.length, total: data.total ?? data.files.length })}</p>}
            </div>
          </aside>
          <div style={{ flex: '999 1 360px', minWidth: 0, minHeight: 360, maxHeight: '100%', display: 'flex' }}>
            {current ? <Preview key={current} abs={current}
              meta={currentItem}
              tasks={currentTasks}
              hidden={hidden.has(pathKey(current))}
              deletable={!!officeDir && pathKey(current).startsWith(officeDir)}
              onChanged={reload} /> : <div className="pro-card" style={{ flex: 1 }}><p className="pro-sub" style={{ margin: 0 }}>{t('pro.dlv.pick')}</p></div>}
          </div>
        </div>
      )}
    </div>
  );
}

const sameItem = (a: Item, b: Item): boolean => a === b || (a.abs === b.abs && a.ts === b.ts && a.size === b.size && a.by === b.by
  && a.created === b.created && a.hidden === b.hidden && a.folder === b.folder && a.authors.join() === b.authors.join());

/** One file in the list. Memoised: the list re-renders on every poll, and a
 *  file whose listing did not change keeps its row. */
const FileRow = memo(function FileRow({ item: i, depth, selected, onSelect, tickets, assets, assetsOpen, onToggleAssets }: {
  item: Item; depth: number; selected: boolean; onSelect: (abs: string) => void; tickets: string[];
  assets: number; assetsOpen: boolean; onToggleAssets: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div data-dlv-row={i.abs} style={{ borderBottom: '1px solid var(--pro-line)', background: selected ? 'var(--cth-lemon-light)' : 'transparent', opacity: i.hidden ? 0.55 : 1 }}>
      <button onClick={() => onSelect(i.abs)} aria-current={selected}
        style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'start', padding: `7px 12px ${assets > 0 ? 2 : 7}px ${12 + depth * 14}px`, border: 'none', cursor: 'pointer', background: 'transparent', font: 'inherit', color: 'inherit' }}>
        <FileTypeBadge name={i.name} />
        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.name}{i.hidden ? ` · ${t('pro.dlv.hiddenTag')}` : ''}</span>
          {i.folder && <span className="pro-sub pro-mono" style={{ fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.abs}>{i.folder}/</span>}
          <span className="pro-sub" style={{ fontSize: 11 }}>
            {[i.by && t(i.created ? 'pro.dlv.createdBy' : 'pro.dlv.editedBy', { name: i.by }), i.ts && fmtWhen(i.ts), i.size !== undefined && fmtSize(i.size)].filter(Boolean).join(' · ')}
          </span>
          {tickets.length > 0 && (
            <span className="pro-row" style={{ gap: 4, flexWrap: 'wrap' }}>
              {tickets.map((k) => <span key={k} className="pro-chip" style={{ fontSize: 10 }}>{k}</span>)}
            </span>
          )}
        </span>
        {i.authors.length
          ? <AuthorAvatars names={i.authors} size={20} />
          : <span title={t('pro.dlv.noAuthor')} style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--pro-muted)', boxShadow: 'inset 0 0 0 1px var(--pro-line)' }}>?</span>}
      </button>
      {assets > 0 && (
        <button className="pro-chip" onClick={onToggleAssets} aria-expanded={assetsOpen} title={t('pro.dlv.assetsTip')}
          style={{ marginInlineStart: 12 + depth * 14 + 52, marginBottom: 7, cursor: 'pointer', fontSize: 10.5 }}>
          {assetsOpen ? '▾' : '▸'} {t('pro.dlv.assets', { count: assets })}
        </button>
      )}
    </div>
  );
// The callbacks are new each render but act on the props compared here.
}, (a, b) => sameItem(a.item, b.item) && a.depth === b.depth && a.selected === b.selected && a.assets === b.assets
  && a.assetsOpen === b.assetsOpen && a.tickets.join() === b.tickets.join());

type Loaded =
  | { state: 'loading' }
  | { state: 'text'; text: string }
  | { state: 'image'; url: string }
  | { state: 'pdf'; bytes: Uint8Array }
  | { state: 'html'; url: string }
  | { state: 'large'; size: number }
  | { state: 'none'; reason: string };

/** Text files the app reads to show (main's fs.ts reads up to 2 MB). A bigger
 *  one is listed and says so, with "Open in its app"; HTML renders at any size. */
const TEXT_READ_MAX = 2 * 1024 * 1024;

type PreviewProps = { abs: string; meta?: Item; tasks: Array<{ id: string; label: string }>; hidden: boolean; deletable: boolean; onChanged: () => void };

/**
 * The open document. Memoised: the list polls every few seconds, and a new
 * listing (or board, or roster) must not render a 1 MB report again when
 * nothing about this file changed.
 */
const Preview = memo(PreviewBody, (a, b) => a.abs === b.abs && a.hidden === b.hidden && a.deletable === b.deletable
  && a.meta?.ts === b.meta?.ts && a.meta?.size === b.meta?.size && a.meta?.by === b.meta?.by && a.meta?.created === b.meta?.created
  && (a.meta?.authors ?? []).join() === (b.meta?.authors ?? []).join()
  && a.tasks.map((x) => x.id + x.label).join() === b.tasks.map((x) => x.id + x.label).join());

function PreviewBody({ abs, meta, tasks, hidden, deletable, onChanged }: PreviewProps) {
  const { t } = useTranslation();
  const { dir, name } = splitPath(abs);
  const kind = previewKind(name);
  const size = meta?.size;
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [copied, setCopied] = useState(false);
  // Markdown and tables: as rendered, or the file as it is.
  const [source, setSource] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  // History: the file's committed versions, and one picked to read.
  const [history, setHistory] = useState<Array<{ hash: string; ts: string; author: string; subject: string }> | null>(null);
  const [version, setVersion] = useState<{ hash: string; ts: string; author: string; text: string } | null>(null);
  // What one version changed (its diff against the version before).
  const [diff, setDiff] = useState<{ hash: string; ts: string; author: string; text: string } | null>(null);
  const showDiff = async (v: { hash: string; ts: string; author: string }) => {
    if (diff?.hash === v.hash) { setDiff(null); return; }
    const r = await window.cth.deliverablesDiff(abs, v.hash);
    if (r.ok && r.diff !== undefined) setDiff({ ...v, text: r.diff }); else setOpenError(r.error ?? t('pro.dlv.actionFailed'));
  };
  const toggleHistory = async () => {
    if (history) { setHistory(null); setVersion(null); setDiff(null); return; }
    setHistory(await window.cth.deliverablesHistory(abs));
  };
  const pickVersion = async (v: { hash: string; ts: string; author: string }, i: number) => {
    // The newest version is the file as it is now.
    if (i === 0) { setVersion(null); return; }
    if (kind === 'image' || kind === 'pdf' || kind === 'binary') { setOpenError(t('pro.dlv.cannotPreview')); return; }
    const r = await window.cth.deliverablesVersion(abs, v.hash);
    if (r.ok && r.text !== undefined) setVersion({ ...v, text: r.text });
    else setOpenError(r.error ?? t('pro.dlv.actionFailed'));
  };
  const external = canOpenExternally(name);

  /** To the trash; if this system has none (a WSL path, a bare Linux desktop),
   *  offer to delete it for good with a second, explicit confirmation. */
  const remove = async () => {
    setOpenError(null);
    if (!(await window.cth.confirm(t('pro.dlv.deleteConfirm', { name }), { detail: t('pro.dlv.deleteDetail'), ok: t('pro.dlv.delete') }))) return;
    let r = await window.cth.deliverablesDelete(abs);
    if (!r.ok && r.noTrash) {
      if (!(await window.cth.confirm(t('pro.dlv.deleteNoTrash', { name }), { detail: r.error, ok: t('pro.dlv.deleteForGood') }))) return;
      r = await window.cth.deliverablesDelete(abs, true);
    }
    if (r.ok) onChanged(); else setOpenError(r.error ?? t('pro.dlv.actionFailed'));
  };

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    if (kind === 'image') {
      void window.cth.readBinary(dir, name).then((r) => {
        if (!alive) return;
        if (!r.ok) { setLoaded({ state: 'none', reason: r.error }); return; }
        url = URL.createObjectURL(new Blob([r.bytes], { type: extOf(name) === 'svg' ? 'image/svg+xml' : r.mime }));
        setLoaded({ state: 'image', url });
      });
    } else if (kind === 'pdf') {
      // Drawn by the app itself (PdfPreview, pdf.js).
      void window.cth.readBinary(dir, name).then((r) => {
        if (!alive) return;
        if (!r.ok) { setLoaded({ state: 'none', reason: r.error }); return; }
        setLoaded({ state: 'pdf', bytes: new Uint8Array(r.bytes) });
      });
    } else if (kind === 'binary') {
      setLoaded({ state: 'none', reason: t('pro.dlv.cannotPreview') });
    } else if (kind === 'html' && !source) {
      // Rendered for real, in a sandboxed frame that loads it from disk.
      void window.cth.deliverablesFileUrl(abs).then((u) => {
        if (alive) setLoaded(u ? { state: 'html', url: u } : { state: 'none', reason: t('pro.dlv.openFailed') });
      });
    } else if ((size ?? 0) > TEXT_READ_MAX) {
      setLoaded({ state: 'large', size: size! });
    } else {
      void window.cth.readFile(dir, name).then((r) => {
        if (!alive) return;
        setLoaded(r.ok ? { state: 'text', text: r.content } : { state: 'none', reason: r.error });
      });
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
    // `source` only changes what an HTML file loads.
  }, [abs, dir, name, kind, t, size, kind === 'html' && source]);

  return (
    // maxHeight: the row wraps on narrow windows, and a wrapping flex line grows
    // to its content; without a cap the whole page scrolled, title and list too,
    // instead of just the document.
    <section className="pro-card" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 0, minHeight: 0, maxHeight: '100%' }}>
      <div className="pro-row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--pro-line)', gap: 8, flexWrap: 'wrap' }}>
        <FileTypeBadge name={name} />
        <strong style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{name}</strong>
        <span className="pro-sub pro-mono" style={{ fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={abs}>{abs}</span>
        <button className="pro-btn" onClick={() => { void navigator.clipboard.writeText(abs).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>{copied ? t('pro.conn.copied') : t('pro.dlv.copyPath')}</button>
        {((kind === 'markdown' || kind === 'wiki' || kind === 'mermaid' || kind === 'csv' || kind === 'json') && loaded.state === 'text' || kind === 'html' && (loaded.state === 'html' || loaded.state === 'text')) && (
          <div className="pro-switch" role="group" aria-label={t('pro.dlv.view')}>
            <button aria-pressed={!source} onClick={() => setSource(false)}>{t('pro.dlv.rendered')}</button>
            <button aria-pressed={source} onClick={() => setSource(true)}>{t('pro.dlv.source')}</button>
          </div>
        )}
        <button className="pro-btn" onClick={() => { setOpenError(null); void window.cth.revealPath(abs).then((r) => { if (!r.ok) setOpenError(r.error ?? t('pro.dlv.openFailed')); }); }}>{t('pro.dlv.showInFolder')}</button>
        <button className="pro-btn" title={t('pro.dlv.hideTip')} onClick={() => { setOpenError(null); void window.cth.deliverablesSetHidden(abs, !hidden).then((r) => { if (r.ok) onChanged(); else setOpenError(r.error ?? t('pro.dlv.actionFailed')); }); }}>
          {hidden ? t('pro.dlv.unhide') : t('pro.dlv.hide')}
        </button>
        {deletable && <button className="pro-btn" aria-pressed={!!history} onClick={() => void toggleHistory()}>{t('pro.dlv.history')}</button>}
        {deletable && <button className="pro-btn" onClick={() => void remove()}>{t('pro.dlv.delete')}</button>}
        <button className="pro-btn pro-btn-primary" disabled={!external}
          title={external ? t('pro.dlv.openOutsideTip') : t('pro.dlv.openOutsideNo')}
          onClick={() => { setOpenError(null); void window.cth.deliverablesOpenExternal(abs).then((r) => { if (!r.ok) setOpenError(r.error ?? t('pro.dlv.openFailed')); }); }}>
          {t('pro.dlv.openOutside')}
        </button>
        {(tasks.length > 0 || meta?.by || meta?.ts) && (
          <div className="pro-row" style={{ flexBasis: '100%', gap: 6, flexWrap: 'wrap', fontSize: 11.5 }}>
            {meta && meta.authors.length > 0 && <AuthorAvatars names={meta.authors} max={5} />}
            {tasks.map((x) => (
              <button key={x.id} className="pro-chip" style={{ cursor: 'pointer' }} title={t('pro.dlv.openTask')}
                onClick={() => useStore.getState().openTaskDetail(x.id)}>{x.label} ↗</button>
            ))}
            <span className="pro-sub" style={{ fontSize: 11.5 }}>
              {[meta?.by && t(meta.created ? 'pro.dlv.createdBy' : 'pro.dlv.editedBy', { name: meta.by }), meta?.ts && fmtWhen(meta.ts), meta?.size !== undefined && fmtSize(meta.size)].filter(Boolean).join(' · ')}
            </span>
          </div>
        )}
        {openError && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12, flexBasis: '100%' }}>{openError}</span>}
      </div>
      {history && (
        <div style={{ borderBottom: '1px solid var(--pro-line)', maxHeight: 220, overflowY: 'auto', padding: '6px 14px' }}>
          {history.length === 0 && <p className="pro-sub" style={{ margin: 0, fontSize: 12 }}>{t('pro.dlv.noHistory')}</p>}
          {history.map((v, i) => {
            const active = version ? version.hash === v.hash : i === 0;
            return (
              <button key={v.hash} onClick={() => void pickVersion(v, i)} aria-current={active}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '4px 6px', border: 'none', borderRadius: 6, cursor: 'pointer', textAlign: 'start', font: 'inherit', fontSize: 12, color: 'inherit',
                  background: active ? 'var(--cth-lemon-light)' : 'transparent' }}>
                <AuthorAvatars names={[v.author === 'Hive' ? t('pro.dlv.app') : v.author]} size={18} />
                <span style={{ fontWeight: 600, flexShrink: 0 }}>{v.author === 'Hive' ? t('pro.dlv.app') : v.author}</span>
                <span className="pro-sub" style={{ fontSize: 11.5, flexShrink: 0 }}>{fmtWhen(new Date(v.ts).getTime())}</span>
                <span className="pro-mono pro-sub" style={{ fontSize: 10.5, flexShrink: 0 }}>{v.hash.slice(0, 7)}</span>
                {i === 0 && <span className="pro-chip" style={{ fontSize: 10 }}>{t('pro.dlv.current')}</span>}
                <span style={{ flex: 1 }} />
                {/* A span: the row is already a button. */}
                <span role="button" tabIndex={0} className="pro-chip" aria-pressed={diff?.hash === v.hash}
                  style={{ fontSize: 10.5, cursor: 'pointer', ...(diff?.hash === v.hash ? { background: 'var(--cth-lemon-light)' } : {}) }}
                  onClick={(e) => { e.stopPropagation(); void showDiff(v); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void showDiff(v); } }}>{t('pro.dlv.changes')}</span>
              </button>
            );
          })}
        </div>
      )}
      {version && (
        <div className="pro-row" style={{ gap: 8, padding: '6px 14px', background: 'var(--cth-lemon-light)', fontSize: 12 }}>
          <span style={{ flex: 1 }}>{t('pro.dlv.viewingVersion', { who: version.author === 'Hive' ? t('pro.dlv.app') : version.author, when: fmtWhen(new Date(version.ts).getTime()) })}</span>
          <button className="pro-btn" style={{ padding: '1px 8px' }} onClick={() => setVersion(null)}>{t('pro.dlv.backToCurrent')}</button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: loaded.state === 'html' && !diff && !version ? 0 : '4px 18px 18px', ...((loaded.state === 'pdf' || loaded.state === 'html') && !diff && !version ? { display: 'flex', flexDirection: 'column' } : {}) }}>
        {diff ? <DiffView text={diff.text} label={t('pro.dlv.changesBy', { who: diff.author === 'Hive' ? t('pro.dlv.app') : diff.author, when: fmtWhen(new Date(diff.ts).getTime()) })} onClose={() => setDiff(null)} />
        : version ? <TextPreview kind={source ? 'text' : kind} text={version.text} dir={dir} name={name} /> : <>
        {loaded.state === 'loading' && <p className="pro-sub">{t('pro.dlv.loading')}</p>}
        {loaded.state === 'none' && <p className="pro-sub">{loaded.reason}</p>}
        {loaded.state === 'image' && <img src={loaded.url} alt={name} style={{ maxWidth: '100%', imageRendering: 'auto' }} />}
        {loaded.state === 'pdf' && <PdfPreview bytes={loaded.bytes} name={name} />}
        {/* No scripts, its own opaque origin (no window.cth, no app storage),
            no top navigation, no forms; links to the web open in the browser
            (main's will-frame-navigate and window-open handlers). */}
        {loaded.state === 'html' && <iframe key={loaded.url} src={loaded.url} title={name} sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer" style={{ flex: 1, width: '100%', minHeight: 0, border: 'none', background: 'var(--cth-page)', borderEndStartRadius: 'inherit', borderEndEndRadius: 'inherit' }} />}
        {loaded.state === 'large' && (
          <div style={{ marginTop: 12 }}>
            <p className="pro-sub">{t('pro.dlv.tooLarge', { size: fmtSize(loaded.size) })}</p>
            {external && (
              <button className="pro-btn pro-btn-primary" onClick={() => { setOpenError(null); void window.cth.deliverablesOpenExternal(abs).then((r) => { if (!r.ok) setOpenError(r.error ?? t('pro.dlv.openFailed')); }); }}>
                {t('pro.dlv.openOutside')}
              </button>
            )}
          </div>
        )}
        {loaded.state === 'text' && <TextPreview kind={source ? 'text' : kind} text={loaded.text} dir={dir} name={name} />}
        </>}
      </div>
    </section>
  );
}

/** A unified diff, added lines green and removed ones red. */
function DiffView({ text, label, onClose }: { text: string; label: string; onClose: () => void }) {
  const { t } = useTranslation();
  // Drop git's file header; keep the hunks.
  const lines = text.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to)|\\ No newline)/.test(l));
  return (
    <div style={{ marginTop: 8 }}>
      <div className="pro-row" style={{ gap: 8, fontSize: 12, marginBottom: 6 }}>
        <span style={{ flex: 1 }}>{label}</span>
        <button className="pro-btn" style={{ padding: '1px 8px' }} onClick={onClose}>{t('pro.dlv.backToCurrent')}</button>
      </div>
      {!lines.some((l) => /^[+-]/.test(l)) ? <p className="pro-sub" style={{ fontSize: 12 }}>{t('pro.dlv.noChanges')}</p> : (
        <pre className="pro-mono" style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {lines.map((l, i) => (
            <div key={i} style={l.startsWith('+') ? { background: 'var(--cth-mint-light)' } : l.startsWith('-') ? { background: 'var(--cth-coral-light)' } : l.startsWith('@@') ? { color: 'var(--pro-muted)' } : undefined}>{l || ' '}</div>
          ))}
        </pre>
      )}
    </div>
  );
}

export const TextPreview = memo(function TextPreview({ kind, text, dir, name }: { kind: ReturnType<typeof previewKind>; text: string; dir: string; name: string }) {
  const { t } = useTranslation();
  const wiki = useMemo(() => (kind === 'wiki' ? confluenceToMarkdown(text) : ''), [kind, text]);
  if (kind === 'markdown') return <PiecedMarkdown source={text} root={dir} baseRel={name} />;
  if (kind === 'wiki') return <PiecedMarkdown source={wiki} root={dir} baseRel={name} />;
  if (kind === 'mermaid') return <MermaidDiagram source={text} />;
  if (kind === 'csv') {
    const rows = parseDelimited(text, extOf(name) === 'tsv' ? '\t' : ',');
    if (!rows.length) return <p className="pro-sub">{t('pro.dlv.emptyFile')}</p>;
    const [head, ...body] = rows;
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 12.5, marginTop: 10 }}>
          <thead><tr>{head.map((h, i) => <th key={i} style={{ textAlign: 'start', padding: '6px 10px', borderBottom: '2px solid var(--pro-line)', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
          <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} style={{ padding: '5px 10px', borderBottom: '1px solid var(--pro-line)', verticalAlign: 'top' }}>{c}</td>)}</tr>)}</tbody>
        </table>
        {rows.length >= 200 && <p className="pro-sub" style={{ fontSize: 11 }}>{t('pro.dlv.firstRows')}</p>}
      </div>
    );
  }
  return <PlainText text={text} json={kind === 'json'} />;
});

/** A file as text; a long one shows its start until asked for all of it (a
 *  multi-MB <pre> takes seconds to lay out, every time it is shown). */
function PlainText({ text, json }: { text: string; json: boolean }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const body = useMemo(() => {
    if (!json) return text;
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }, [text, json]);
  const { head, cut } = useMemo(() => (all ? { head: body, cut: false } : headOf(body)), [body, all]);
  return (
    <>
      <pre className="pro-mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '10px 0 0' }}>{head}</pre>
      {cut && <ShowRest shown={head.length} total={body.length} onClick={() => setAll(true)} label={t('pro.dlv.showRest', { size: fmtSize(body.length - head.length) })} />}
    </>
  );
}

/**
 * Markdown in pieces, one per frame: a long report fills in while the window
 * keeps answering, instead of freezing it until the whole document is built.
 * Past PREVIEW_BUDGET it waits for "Show the rest".
 */
function PiecedMarkdown({ source, root, baseRel }: { source: string; root: string; baseRel: string }) {
  const { t } = useTranslation();
  const pieces = useMemo(() => splitMarkdown(source, 16 * 1024), [source]);
  const [limit, setLimit] = useState(() => piecesWithin(pieces, PREVIEW_BUDGET));
  const [shown, setShown] = useState(1);
  useEffect(() => {
    if (shown >= Math.min(limit, pieces.length)) return;
    const id = setTimeout(() => setShown((n) => n + 1), 0);
    return () => clearTimeout(id);
  }, [shown, limit, pieces.length]);
  if (pieces.length === 1) return <MarkdownPreview source={source} root={root} baseRel={baseRel} />;
  const rest = pieces.slice(limit).reduce((n, p) => n + p.length, 0);
  return (
    <div className="pro-md-pieces">
      {pieces.slice(0, shown).map((p, i) => <MarkdownPreview key={i} source={p} root={root} baseRel={baseRel} />)}
      {shown >= limit && limit < pieces.length && (
        <ShowRest shown={source.length - rest} total={source.length} onClick={() => setLimit(pieces.length)} label={t('pro.dlv.showRest', { size: fmtSize(rest) })} />
      )}
    </div>
  );
}

function ShowRest({ shown, total, label, onClick }: { shown: number; total: number; label: string; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="pro-row" style={{ gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
      <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.dlv.shownOf', { shown: fmtSize(shown), total: fmtSize(total) })}</span>
      <button className="pro-btn" onClick={onClick}>{label}</button>
    </div>
  );
}
