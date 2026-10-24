import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { MermaidDiagram } from '@/markdown/MermaidDiagram';
import { confluenceToMarkdown } from '@shared/confluenceWiki';
import { DELIVERABLE_SORTS, sortDeliverables, ticketQuery, type DeliverableSort } from '@shared/deliverableSort';
import { canOpenExternally, deliverablePaths, parseDelimited, previewKind, splitPath, extOf } from '@shared/deliverables';
import { useStore, type Agent } from '@/store/store';
import type { KeyedTask } from './data';
import { useProStore } from './proStore';
import { FileTypeBadge } from '@/components/FileTypeBadge';
import { AuthorAvatars } from './AuthorAvatars';
import { PdfPreview } from './PdfPreview';

/**
 * Deliverables — what the agents made for you, in one place: files linked from
 * task cards, the office's research/ folder, and what each agent wrote this
 * session. Pick one to read it here (Markdown rendered, tables as tables,
 * images shown); anything else opens in your file browser.
 */

type Listing = Awaited<ReturnType<typeof window.cth.deliverablesList>>;
interface Item {
  abs: string;
  name: string;
  /** Folder under research/ (or the full folder for a file elsewhere). */
  folder: string;
  ts?: number;
  size?: number;
  /** Who last wrote it, and whether that write created it. */
  by?: string;
  created?: boolean;
  /** Everyone who changed it, from its git history, most recent first. */
  authors: string[];
  hidden?: boolean;
}
interface Group { key: string; label: string; kind: 'task' | 'office' | 'agents'; ticket?: string; status?: string; owner?: string; items: Item[] }

const LS_SORT = 'cth.dlv.sort';
const readSort = (): DeliverableSort => {
  try { const s = window.localStorage.getItem(LS_SORT) as DeliverableSort | null; return s && DELIVERABLE_SORTS.includes(s) ? s : 'recent'; } catch { return 'recent'; }
};

const LS_COLLAPSED = 'cth.dlv.collapsed';
const readCollapsed = (): Record<string, boolean> => {
  try { return JSON.parse(window.localStorage.getItem(LS_COLLAPSED) ?? '{}') as Record<string, boolean>; } catch { return {}; }
};

const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fmtWhen = (ts: number): string => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const pathKey = (p: string): string => p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();

export function DeliverablesView({ tasks, roster }: { tasks: KeyedTask[]; roster: Agent[] }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Listing | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const reload = () => setReloadTick((n) => n + 1);
  // Arriving from a task's "Open": show that task's deliverables only.
  const focusTask = useProStore((s) => s.focusTask);
  const setFocusTask = useProStore((s) => s.setFocusTask);

  useEffect(() => {
    let alive = true;
    const load = () => { void window.cth.deliverablesList().then((d) => { if (alive) setData(d); }).catch(() => {}); };
    load();
    // Not faster: on a WSL floor every listing crosses \\wsl.localhost.
    const id = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [reloadTick]);

  const hidden = useMemo(() => new Set((data?.hidden ?? []).map(pathKey)), [data]);

  /** One group per task that has deliverables (from its card's field or linked
   *  automatically when its agent wrote into research/), then research/ files
   *  with no task, then what agents wrote elsewhere this session. */
  const groups = useMemo<Group[]>(() => {
    if (!data?.root) return [];
    // The orchestrator is not in every roster list: fall back to the whole floor.
    const who = (id?: string) => (roster.find((a) => a.id === id) ?? useStore.getState().agents.find((a) => a.id === id))?.name ?? id ?? '';
    const office = new Map(data.files.map((f) => [pathKey(f.abs), f]));
    // Who last wrote each path: this session's tool calls, else the agent its
    // task link records.
    const lastWrite = new Map<string, { name: string; created: boolean; ts: number }>();
    for (const w of data.written) {
      const k = pathKey(w.path);
      const prev = lastWrite.get(k);
      if (!prev || w.ts > prev.ts) lastWrite.set(k, { name: w.name, created: w.created, ts: w.ts });
    }
    const linkBy = new Map(data.links.map((l) => [pathKey(l.path), l.agentId]));
    const placed = new Set<string>();
    const describe = (abs: string): Item => {
      const k = pathKey(abs);
      const f = office.get(k);
      const w = lastWrite.get(k);
      const hist = f ? data.authors?.[`research/${f.rel}`] : undefined;
      // The latest writer: this session's tool call, else the git history, else the task link.
      const by = w?.name ?? hist?.last ?? (linkBy.get(k) ? who(linkBy.get(k)) : undefined);
      const authors = [...new Set([by, ...(hist?.authors ?? [])].filter((x): x is string => !!x))];
      if (f) {
        const parts = f.rel.split('/');
        return { abs: f.abs, name: parts[parts.length - 1], folder: parts.slice(0, -1).join('/'), ts: Math.max(f.mtime, w?.ts ?? 0), size: f.size, by, created: w?.created, authors };
      }
      const sp = splitPath(abs);
      return { abs, name: sp.name, folder: sp.dir, ts: w?.ts, by, created: w?.created, authors };
    };
    const out: Group[] = [];
    // Hidden items stay out of every group (and out of "placed", so they do not
    // fall through into another group either) unless the human asks to see them.
    const keep = (items: Item[]): Item[] => items
      .map((i) => (hidden.has(pathKey(i.abs)) ? { ...i, hidden: true } : i))
      .filter((i) => showHidden || !i.hidden);
    for (const task of tasks) {
      const paths = [...deliverablePaths(task.deliverable, data.root!, data.distro), ...data.links.filter((l) => l.taskId === task.id).map((l) => l.path)];
      const items: Item[] = [];
      for (const abs of paths) {
        const k = pathKey(abs);
        if (items.some((i) => pathKey(i.abs) === k)) continue;
        const item = describe(abs);
        // Nobody recorded as writing it: the task's owner made it.
        if (!item.authors.length && task.assignee) {
          const owner = who(task.assignee);
          item.authors = [owner];
          item.by = item.by ?? owner;
        }
        items.push(item);
        placed.add(k);
      }
      const visible = keep(items);
      if (visible.length) out.push({ key: `task:${task.id}`, kind: 'task', ticket: (task.key ?? task.id).toLowerCase(), label: [task.key, task.title].filter(Boolean).join(' · '), status: task.status, owner: task.assignee && who(task.assignee), items: visible });
    }
    // The rest of research/, one section per top folder (handoffs/, reports/…).
    const byFolder = new Map<string, Item[]>();
    for (const f of data.files) {
      if (placed.has(pathKey(f.abs))) continue;
      const top = f.rel.includes('/') ? f.rel.split('/')[0] : '';
      byFolder.set(top, [...(byFolder.get(top) ?? []), describe(f.abs)]);
    }
    for (const [folder, items] of [...byFolder.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))) {
      const visible = keep(items);
      if (visible.length) out.push({ key: `office:${folder}`, kind: 'office', label: folder ? `${t('pro.dlv.group_office')} · ${folder}/` : t('pro.dlv.group_office'), items: visible });
    }
    const elsewhere = keep(data.written.filter((w) => !office.has(pathKey(w.path)) && !placed.has(pathKey(w.path)))
      .filter((w, i, all) => all.findIndex((x) => pathKey(x.path) === pathKey(w.path)) === i)
      .map((w) => describe(w.path)));
    if (elsewhere.length) out.push({ key: 'agents', kind: 'agents', label: t('pro.dlv.group_agents'), items: elsewhere });
    for (const g of out) g.items.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
    return out;
  }, [data, tasks, roster, t, hidden, showHidden]);

  // Filters: by kind of file and by who wrote it.
  const [typeFilter, setTypeFilter] = useState('');
  const [byFilter, setByFilter] = useState('');
  const types = useMemo(() => [...new Set(groups.flatMap((g) => g.items.map((i) => extOf(i.name) || 'file')))].sort(), [groups]);
  const writers = useMemo(() => [...new Set(groups.flatMap((g) => g.items.flatMap((i) => i.authors)))].sort(), [groups]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  // `open` is the section's state now: clicking closes an open one, opens a closed one.
  const toggle = (key: string, open: boolean) => setCollapsed((c) => {
    const next = { ...c, [key]: open };
    try { window.localStorage.setItem(LS_COLLAPSED, JSON.stringify(next)); } catch { /* noop */ }
    return next;
  });
  // An accordion: with more than a few sections they start closed, except the
  // one holding the file being read; one opened or closed by hand stays so.
  const isOpen = (g: Group) => (g.key in collapsed ? !collapsed[g.key]
    : groups.length <= 3 || (!!current && g.items.some((i) => i.abs === current)));
  const [sort, setSortState] = useState<DeliverableSort>(readSort);
  const setSort = (s: DeliverableSort) => { setSortState(s); try { window.localStorage.setItem(LS_SORT, s); } catch { /* noop */ } };
  const setAll = (open: boolean) => {
    const next = Object.fromEntries(groups.map((g) => [g.key, !open]));
    setCollapsed(next);
    try { window.localStorage.setItem(LS_COLLAPSED, JSON.stringify(next)); } catch { /* noop */ }
  };

  const q = query.trim().toLowerCase();
  // "DUN-12" in the search: that ticket's deliverables, not DUN-120's too.
  const ticket = ticketQuery(q);
  const filtering = !!(q || typeFilter || byFilter);
  const shown = sortDeliverables(groups, sort)
    .filter((g) => !focusTask || g.key === `task:${focusTask}`)
    .filter((g) => !ticket || g.ticket === ticket)
    .map((g) => ({ ...g, items: g.items.filter((i) =>
      (!q || ticket || `${g.label} ${i.name} ${i.folder} ${i.by ?? ''} ${i.abs}`.toLowerCase().includes(q))
      && (!typeFilter || (extOf(i.name) || 'file') === typeFilter)
      && (!byFilter || i.authors.includes(byFilter))) }))
    .filter((g) => g.items.length);
  const all = shown.flatMap((g) => g.items);
  const current = selected && all.some((i) => i.abs === selected) ? selected : all[0]?.abs ?? null;
  const focused = focusTask ? tasks.find((x) => x.id === focusTask) : undefined;
  const [folderError, setFolderError] = useState<string | null>(null);
  const officeDir = data?.dir ? pathKey(data.dir).replace(/\/$/, '') + '/' : null;

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.nav.deliverables')}</h2>
        <span className="pro-sub">{t('pro.dlv.sub')}</span>
        {data?.dir && (
          <div className="pro-head-end" style={{ gap: 6, flexWrap: 'wrap' }}>
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
              <select className="pro-input" style={{ flex: '1 1 110px', minWidth: 0 }} value={sort} onChange={(e) => setSort(e.target.value as DeliverableSort)} aria-label={t('pro.dlv.sortBy')}>
                {DELIVERABLE_SORTS.map((s) => <option key={s} value={s}>{t(`pro.dlv.sort_${s}`)}</option>)}
              </select>
              <button className="pro-btn" style={{ padding: '2px 8px' }} onClick={() => setAll(shown.some((g) => !isOpen(g)))}>
                {shown.some((g) => !isOpen(g)) ? t('pro.dlv.expandAll') : t('pro.dlv.collapseAll')}
              </button>
            </div>
            {focusTask && (
              <div className="pro-row" style={{ gap: 6 }}>
                <span className="pro-chip pro-chip-on" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 250 }}>{focused ? [focused.key, focused.title].filter(Boolean).join(' · ') : focusTask}</span>
                <button className="pro-btn" style={{ padding: '2px 8px' }} onClick={() => setFocusTask(null)}>{t('pro.dlv.showAll')}</button>
              </div>
            )}
            <div className="pro-card" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 0 }}>
              {all.length === 0 && <p className="pro-sub" style={{ margin: 0, padding: 14, fontSize: 12.5 }}>{t(focusTask ? 'pro.dlv.noneForTask' : 'pro.dlv.empty', { dir: data.dir })}</p>}
              {shown.map((g) => {
                // Searching or filtering opens every section that has a match.
                const open = filtering || !!focusTask || isOpen(g);
                return (
                  <section key={g.key}>
                    <button onClick={() => toggle(g.key, open)} aria-expanded={open}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 12px', border: 'none', borderBottom: '1px solid var(--pro-line)', cursor: 'pointer', textAlign: 'start', font: 'inherit', color: 'inherit',
                        background: g.kind === 'task' ? 'var(--cth-cream-100)' : 'transparent', position: 'sticky', top: 0, zIndex: 1 }}>
                      <span style={{ width: 10, flexShrink: 0, fontSize: 10, color: 'var(--pro-muted)' }}>{open ? '▾' : '▸'}</span>
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span style={g.kind === 'task' ? { fontSize: 12.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : { fontSize: 10.5, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--pro-muted)' }}>{g.label}</span>
                        {g.kind === 'task' && (g.owner || g.status) && (
                          <span className="pro-sub" style={{ fontSize: 11 }}>{[g.owner, g.status && t(`taskHistory.status_${g.status}`, { defaultValue: g.status })].filter(Boolean).join(' · ')}</span>
                        )}
                      </span>
                      <span className="pro-chip" style={{ flexShrink: 0 }}>{g.items.length}</span>
                    </button>
                    {open && g.items.map((i) => (
                      <button key={`${g.key}:${i.abs}`} onClick={() => setSelected(i.abs)} aria-current={current === i.abs}
                        style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%', textAlign: 'start', padding: '7px 12px 7px 30px', border: 'none', borderBottom: '1px solid var(--pro-line)', cursor: 'pointer',
                          background: current === i.abs ? 'var(--cth-lemon-light)' : 'transparent', font: 'inherit', color: 'inherit', opacity: i.hidden ? 0.55 : 1 }}>
                        <FileTypeBadge name={i.name} />
                        <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, overflowWrap: 'anywhere' }}>{i.name}{i.hidden ? ` · ${t('pro.dlv.hiddenTag')}` : ''}</span>
                          {i.folder && <span className="pro-sub pro-mono" style={{ fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.abs}>{i.folder}/</span>}
                          <span className="pro-sub" style={{ fontSize: 11 }}>
                            {[i.by && t(i.created ? 'pro.dlv.createdBy' : 'pro.dlv.editedBy', { name: i.by }), i.ts && fmtWhen(i.ts), i.size !== undefined && fmtSize(i.size)].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        {i.authors.length
                          ? <AuthorAvatars names={i.authors} size={20} />
                          : <span title={t('pro.dlv.noAuthor')} style={{ width: 20, height: 20, borderRadius: '50%', flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--pro-muted)', boxShadow: 'inset 0 0 0 1px var(--pro-line)' }}>?</span>}
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
          </aside>
          <div style={{ flex: '999 1 360px', minWidth: 0, minHeight: 360, maxHeight: '100%', display: 'flex' }}>
            {current ? <Preview key={current} abs={current}
              meta={all.find((i) => i.abs === current)}
              tasks={shown.filter((g) => g.kind === 'task' && g.items.some((i) => i.abs === current)).map((g) => ({ id: g.key.slice('task:'.length), label: g.label }))}
              hidden={hidden.has(pathKey(current))}
              deletable={!!officeDir && pathKey(current).startsWith(officeDir)}
              onChanged={reload} /> : <div className="pro-card" style={{ flex: 1 }}><p className="pro-sub" style={{ margin: 0 }}>{t('pro.dlv.pick')}</p></div>}
          </div>
        </div>
      )}
    </div>
  );
}

type Loaded =
  | { state: 'loading' }
  | { state: 'text'; text: string }
  | { state: 'image'; url: string }
  | { state: 'pdf'; bytes: Uint8Array }
  | { state: 'none'; reason: string };

function Preview({ abs, meta, tasks, hidden, deletable, onChanged }: { abs: string; meta?: Item; tasks: Array<{ id: string; label: string }>; hidden: boolean; deletable: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const { dir, name } = splitPath(abs);
  const kind = previewKind(name);
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
    } else {
      void window.cth.readFile(dir, name).then((r) => {
        if (!alive) return;
        setLoaded(r.ok ? { state: 'text', text: r.content } : { state: 'none', reason: r.error });
      });
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [abs, dir, name, kind, t]);

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
        {(kind === 'markdown' || kind === 'wiki' || kind === 'mermaid' || kind === 'csv' || kind === 'json') && loaded.state === 'text' && (
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
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 18px 18px', ...(loaded.state === 'pdf' && !diff && !version ? { display: 'flex', flexDirection: 'column' } : {}) }}>
        {diff ? <DiffView text={diff.text} label={t('pro.dlv.changesBy', { who: diff.author === 'Hive' ? t('pro.dlv.app') : diff.author, when: fmtWhen(new Date(diff.ts).getTime()) })} onClose={() => setDiff(null)} />
        : version ? <TextPreview kind={source ? 'text' : kind} text={version.text} dir={dir} name={name} /> : <>
        {loaded.state === 'loading' && <p className="pro-sub">{t('pro.dlv.loading')}</p>}
        {loaded.state === 'none' && <p className="pro-sub">{loaded.reason}</p>}
        {loaded.state === 'image' && <img src={loaded.url} alt={name} style={{ maxWidth: '100%', imageRendering: 'auto' }} />}
        {loaded.state === 'pdf' && <PdfPreview bytes={loaded.bytes} name={name} />}
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

export function TextPreview({ kind, text, dir, name }: { kind: ReturnType<typeof previewKind>; text: string; dir: string; name: string }) {
  const { t } = useTranslation();
  if (kind === 'markdown') return <MarkdownPreview source={text} root={dir} baseRel={name} />;
  if (kind === 'wiki') return <MarkdownPreview source={confluenceToMarkdown(text)} root={dir} baseRel={name} />;
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
  let body = text;
  if (kind === 'json') { try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show as is */ } }
  return (
    <>
      {kind === 'html' && <p className="pro-sub" style={{ fontSize: 11 }}>{t('pro.dlv.htmlSource')}</p>}
      <pre className="pro-mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '10px 0 0' }}>{body}</pre>
    </>
  );
}
