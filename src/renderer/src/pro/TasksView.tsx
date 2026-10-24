import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { openQuestion, waitsOnHuman } from '@/components/TasksKanban';
import { describeTaskEvent, useAgentName } from '@/components/TaskTimeline';
import { statusSince, type TaskEvent } from '@shared/taskHistory';
import { columnRoots, descendantsOf, subtasksIn } from '@shared/taskBoard';
import { deliverablePaths, splitPath } from '@shared/deliverables';
import { FileTypeBadge } from '@/components/FileTypeBadge';
import { ProIcon } from './ProIcon';
import { useProStore } from './proStore';
import { Avatar, usePoll, type KeyedTask } from './data';

const LS_LAYOUT = 'cth.tasks.layout';
const LS_RECENT = 'cth.tasks.recentOpen';

/** "5m", "3h", "2d": how long ago, short. */
function ago(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return '<1m';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

type Filter = 'all' | 'asks' | 'unassigned' | 'cancelled';

/** Board columns; their names are `pro.tasks.col_<status>`. */
const COLUMNS: { status: KeyedTask['status']; color: string }[] = [
  { status: 'backlog', color: 'var(--cth-ink-300)' },
  { status: 'todo', color: 'var(--cth-sky)' },
  { status: 'doing', color: 'var(--cth-mint)' },
  { status: 'blocked', color: 'var(--cth-coral)' },
  { status: 'done', color: 'var(--cth-status-idle)' }
];

/**
 * Tasks — every job as a card with an owner and a key. A read surface over
 * tasks.json like the Classic kanban: the orchestrator writes the ledger, so
 * "New task" goes to him through his queue instead of inserting a card he
 * never heard about.
 */
export function TasksView({ tasks: ledger, roster }: { tasks: KeyedTask[]; roster: Agent[] }) {
  const { t: tr } = useTranslation();
  // Cards moved here show in their new column at once; the ledger poll
  // catches up within seconds (and an override it already agrees with is moot).
  const [moved, setMoved] = useState<Map<string, KeyedTask['status']>>(new Map());
  const tasks = useMemo(() => ledger.map((t) => (moved.has(t.id) ? { ...t, status: moved.get(t.id)! } : t)), [ledger, moved]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<KeyedTask['status'] | null>(null);
  /** A parent dropped on another column, waiting for "its subtasks too?". */
  const [ask, setAsk] = useState<{ id: string; status: KeyedTask['status']; kids: KeyedTask[] } | null>(null);
  const moveCards = async (ids: string[], status: KeyedTask['status']) => {
    setMoved((m) => { const n = new Map(m); for (const id of ids) n.set(id, status); return n; });
    for (const id of ids) {
      // One field per card, on the raw ledger (as the task detail does).
      try { await window.cth.hivePatchTask(id, { status }); } catch { /* the poll shows the truth */ }
    }
    setTimeout(() => setMoved((m) => { const n = new Map(m); for (const id of ids) n.delete(id); return n; }), 8000);
  };
  const dropOn = (status: KeyedTask['status']) => {
    const id = dragId;
    setDragId(null); setOverCol(null);
    const card = id ? tasks.find((x) => x.id === id) : undefined;
    if (!card || card.status === status) return;
    const kids = descendantsOf(tasks, card.id).filter((k) => k.status !== status && k.status !== 'cancelled');
    if (kids.length) setAsk({ id: card.id, status, kids });
    else void moveCards([card.id], status);
  };
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const god = roster.find((a) => a.isGod);
  const byId = new Map(roster.map((a) => [a.id, a]));
  const name = useAgentName();
  // What happened lately, and since when each card is in its column.
  const history = usePoll(() => window.cth.hiveTaskHistory?.(undefined, 400) ?? Promise.resolve([] as TaskEvent[]), 5000, [] as TaskEvent[]);
  const since = useMemo(() => statusSince(history), [history]);
  const recent = history.slice(-12).reverse();
  const keyOf = new Map(tasks.map((x) => [x.id, x.key ?? x.id]));
  const now = Date.now();
  const [showDone, setShowDone] = useState(false);
  // What each card produced: its deliverable field plus files linked to it.
  const listing = usePoll(() => window.cth.deliverablesList(), 15_000, null as Awaited<ReturnType<typeof window.cth.deliverablesList>> | null);
  const filesOf = (t: KeyedTask): string[] => {
    if (!listing?.root) return [];
    const seen = new Set<string>();
    return [...deliverablePaths(t.deliverable, listing.root, listing.distro), ...listing.links.filter((l) => l.taskId === t.id).map((l) => l.path)]
      .filter((p) => { const k = p.replace(/\\/g, '/').toLowerCase(); return seen.has(k) ? false : (seen.add(k), true); });
  };
  // Subtasks: a card's "parent" links it to the request it is a piece of.
  const byTask = new Map(tasks.map((x) => [x.id, x]));
  const childrenOf = useMemo(() => {
    const m = new Map<string, KeyedTask[]>();
    for (const x of tasks) if (x.parent && x.parent !== x.id) m.set(x.parent, [...(m.get(x.parent) ?? []), x]);
    return m;
  }, [tasks]);
  const [layout, setLayout] = useState<'board' | 'tree'>(() => {
    try { return window.localStorage.getItem(LS_LAYOUT) === 'tree' ? 'tree' : 'board'; } catch { return 'board'; }
  });
  const pickLayout = (l: 'board' | 'tree') => { setLayout(l); try { window.localStorage.setItem(LS_LAYOUT, l); } catch { /* noop */ } };
  const [recentOpen, setRecentOpen] = useState<boolean>(() => {
    // Folded by default: one line with the latest event until opened.
    try { return window.localStorage.getItem(LS_RECENT) === '1'; } catch { return false; }
  });
  const toggleRecent = () => setRecentOpen((v) => { try { window.localStorage.setItem(LS_RECENT, v ? '0' : '1'); } catch { /* noop */ } return !v; });

  const openDeliverables = (taskId: string) => {
    const pro = useProStore.getState();
    pro.setFocusTask(taskId);
    pro.setView({ kind: 'section', section: 'deliverables' });
  };

  /** One task card (the board and the request tree share it). */
  const renderCard = (t: KeyedTask, nested = false) => {
    const owner = t.assignee ? byId.get(t.assignee) : undefined;
    // Cancelled: greyed in Done, kept as history; reopened from its detail, not dragged.
    const cancelled = t.status === 'cancelled';
    return (
      <button key={t.id} className={`pro-card pro-task-card${cancelled ? ' pro-task-cancelled' : ''}`} style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, ...(nested ? { width: '100%' } : {}), ...(dragId === t.id ? { opacity: 0.5 } : {}) }}
        draggable={layout === 'board' && !cancelled} title={layout === 'board' && !cancelled ? tr('pro.tasks.dragHint') : undefined}
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); setDragId(t.id); }}
        onDragEnd={() => { setDragId(null); setOverCol(null); }}
        onClick={() => useStore.getState().openTaskDetail(t.id)}>
        <span className="pro-row" style={{ justifyContent: 'space-between', gap: 6 }}>
          <span className="pro-ticket">{t.key ?? t.id}</span>
          {since.get(t.id) && <span className="pro-sub" style={{ fontSize: 11 }} title={new Date(since.get(t.id)!).toLocaleString()}>{tr('pro.tasks.since', { time: ago(since.get(t.id), now) })}</span>}
        </span>
        {!nested && t.parent && byTask.get(t.parent) && (
      <span className="pro-sub pro-row" style={{ fontSize: 11, gap: 4, minWidth: 0 }} title={tr('pro.tasks.subtaskOf')}>
        ↳ <span className="pro-ticket">{byTask.get(t.parent)!.key ?? t.parent}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{byTask.get(t.parent)!.title}</span>
      </span>
    )}
    <span className="pro-task-title" title={t.title}>{t.title}</span>
    {(childrenOf.get(t.id)?.length ?? 0) > 0 && (() => {
      const kids = childrenOf.get(t.id)!;
      const done = kids.filter((k) => k.status === 'done').length;
      return (
        <span className="pro-row" style={{ gap: 6, fontSize: 11 }} title={kids.map((k) => `${k.key ?? k.id} ${k.title}`).join('\n')}>
          <span className="pro-sub">{tr('pro.tasks.subtasks', { done, total: kids.length })}</span>
          <span style={{ flex: 1, height: 4, borderRadius: 2, background: 'var(--cth-cream-200)', overflow: 'hidden' }}>
            <span style={{ display: 'block', height: '100%', width: `${(done / kids.length) * 100}%`, background: 'var(--cth-mint)' }} />
          </span>
        </span>
      );
    })()}
        {t.description && t.status !== 'done' && !cancelled && (
          <span className="pro-sub" style={{ fontSize: 12, lineHeight: '16px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.description}</span>
        )}
        {waitsOnHuman(t) && openQuestion(t) && (
          // Padding on the box, the 3-line clamp on the text inside: on one element a
          // fourth line showed half-cut in the padding. Markdown markers are not shown.
          <span style={{ padding: '4px 6px', borderRadius: 6, background: 'var(--cth-peach-light)', minWidth: 0 }}>
            <span style={{ fontSize: 12, lineHeight: '16px', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{openQuestion(t)!.q.replace(/\*\*|__|`/g, '')}</span>
          </span>
        )}
        {(() => {
          const files = filesOf(t);
          if (!files.length) return null;
          const first = splitPath(files[0]).name;
          return (
            // A span, not a nested button: the card itself is a button.
            <span role="link" tabIndex={0} title={files.map((f) => splitPath(f).name).join('\n')}
              onClick={(e) => { e.stopPropagation(); openDeliverables(t.id); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); openDeliverables(t.id); } }}
              className="pro-row" style={{ gap: 6, fontSize: 12, padding: '3px 6px', borderRadius: 6, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--pro-line)', cursor: 'pointer', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', overflow: 'hidden' }}>
              {/* Held to the card's width: only the name shrinks, ending in "…". */}
              <span style={{ display: 'inline-flex', flexShrink: 0 }}><ProIcon name="deliverables" /></span>
              <span style={{ display: 'inline-flex', flexShrink: 0 }}><FileTypeBadge name={first} /></span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{first}</span>
              {files.length > 1 && <span className="pro-sub" style={{ fontSize: 11 }}>+{files.length - 1}</span>}
            </span>
          );
        })()}
        {t.status === 'done' && t.result && (
          <span className="pro-sub" style={{ fontSize: 12, lineHeight: '16px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{t.result}</span>
        )}
        <span className="pro-row" style={{ justifyContent: 'space-between' }}>
          {waitsOnHuman(t)
            ? <span className="pro-badge" style={{ background: 'var(--cth-peach-light)' }}>{tr('pro.tasks.asksYou')}</span>
            : t.status === 'done' ? <span className="pro-badge" style={{ background: 'var(--cth-mint-light)' }}>{tr('pro.state.done')}</span>
            : cancelled ? <span className="pro-badge" style={{ background: 'var(--cth-cream-200)' }}>{tr('pro.tasks.col_cancelled')}</span> : <span />}
          {/* Parked: nobody is on it, so no face on the card (the owner stays in the ledger). */}
          {t.status === 'backlog' ? <span className="pro-sub" style={{ fontSize: 11 }} title={owner?.name ?? t.assignee}>{tr('pro.tasks.parked')}</span>
            : owner ? <span className="pro-row" style={{ gap: 4, fontSize: 11, minWidth: 0 }} title={owner.name}><Avatar agent={owner} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{owner.name}</span></span>
            : <span className="pro-sub" style={{ fontSize: 11 }}>{t.assignee ?? tr('pro.tasks.unassigned')}</span>}
        </span>
      </button>
    );
  };

  /** A card with the subtasks that sit in the same column hanging under it
   *  (the others keep their "↳ parent" line in their own column). */
  const renderTree = (t: KeyedTask, pool: KeyedTask[], depth = 0): JSX.Element => {
    const kids = depth < 4 ? subtasksIn(pool, t.id) : [];
    if (!kids.length) return renderCard(t, depth > 0);
    return (
      <div key={t.id} className="pro-task-group">
        {renderCard(t, depth > 0)}
        <div className="pro-task-kids">{kids.map((k) => renderTree(k, pool, depth + 1))}</div>
      </div>
    );
  };

  const needle = q.trim().toLowerCase();
  const shown = tasks.filter((t) =>
    (filter === 'all' || (filter === 'cancelled' ? t.status === 'cancelled' : filter === 'asks' ? waitsOnHuman(t) : !t.assignee))
    && (!needle || `${t.key ?? ''} ${t.title} ${t.description ?? ''}`.toLowerCase().includes(needle))
  );
  const doing = tasks.filter((t) => t.status === 'doing').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;

  const send = () => {
    const text = draft?.trim();
    if (!text || !god) return;
    useStore.getState().enqueueMessage(god.id, `New task from the human: ${text}\nAdd it to tasks.json, pick an owner and dispatch it.`);
    setDraft(null);
  };

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{tr('pro.nav.tasks')}</h2>
        <span className="pro-sub">{tr('pro.tasks.summary', { doing, blocked })}</span>
        <div className="pro-head-end">
          <div className="pro-tabs" role="tablist">
            {(['all', 'asks', 'unassigned', 'cancelled'] as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                {tr(`pro.tasks.filter_${f}`)}
              </button>
            ))}
          </div>
          <div className="pro-switch" role="group" aria-label={tr('pro.tasks.layout')}>
            <button aria-pressed={layout === 'board'} onClick={() => pickLayout('board')}>{tr('pro.tasks.layout_board')}</button>
            <button aria-pressed={layout === 'tree'} onClick={() => pickLayout('tree')}>{tr('pro.tasks.layout_tree')}</button>
          </div>
          <input className="pro-input" placeholder={tr('pro.tasks.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="pro-btn pro-btn-primary" disabled={!god} onClick={() => setDraft('')}>{tr('pro.tasks.new')}</button>
        </div>
      </div>

      {draft !== null && (
        <div className="pro-card pro-row">
          <input
            className="pro-input" style={{ flex: 1 }} autoFocus
            placeholder={tr('pro.tasks.describe', { name: god?.name ?? tr('pro.nav.orchestrator') })}
            value={draft} onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) send(); if (e.key === 'Escape') setDraft(null); }}
          />
          <button className="pro-btn pro-btn-primary" onClick={send} disabled={!draft.trim()}>{tr('pro.tasks.sendTo', { name: god?.name ?? tr('pro.nav.orchestrator') })}</button>
          <button className="pro-btn" onClick={() => setDraft(null)}>{tr('common.cancel')}</button>
        </div>
      )}

      {recent.length > 0 && (
        <section className="pro-card" style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
          <button onClick={toggleRecent} aria-expanded={recentOpen}
            style={{ display: 'flex', alignItems: 'center', gap: 6, border: 'none', background: 'transparent', padding: '2px 0', font: 'inherit', color: 'var(--pro-muted)', cursor: 'pointer', textAlign: 'start' }}>
            <span style={{ width: 10, fontSize: 10 }}>{recentOpen ? '▾' : '▸'}</span>
            <span style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' }}>{tr('pro.tasks.recent')}</span>
            {!recentOpen && recent[0] && (
              <span style={{ fontSize: 12, textTransform: 'none', letterSpacing: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                · {ago(recent[0].ts, now)} {keyOf.get(recent[0].taskId) ?? recent[0].taskId} {describeTaskEvent(recent[0], name, tr)}
              </span>
            )}
          </button>
          {recentOpen && recent.map((e, i) => (
            <button key={i} onClick={() => useStore.getState().openTaskDetail(e.taskId)}
              style={{ display: 'flex', gap: 8, alignItems: 'baseline', border: 'none', background: 'transparent', padding: '2px 0', font: 'inherit', fontSize: 12.5, color: 'inherit', cursor: 'pointer', textAlign: 'start', minWidth: 0 }}>
              <span className="pro-sub" style={{ fontSize: 11, width: 34, flexShrink: 0 }}>{ago(e.ts, now)}</span>
              <span className="pro-ticket" style={{ flexShrink: 0 }}>{keyOf.get(e.taskId) ?? e.taskId}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
                <strong style={{ fontWeight: 600 }}>{e.title}</strong> · {describeTaskEvent(e, name, tr)}
              </span>
            </button>
          ))}
        </section>
      )}

      {layout === 'tree' ? (
        // By request: each top-level card with its subtasks under it, newest first.
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {shown.filter((t) => !t.parent || !byTask.has(t.parent))
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((t) => (
              <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {renderCard(t, true)}
                {(childrenOf.get(t.id) ?? []).length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingInlineStart: 22, borderInlineStart: '2px solid var(--pro-line)', marginInlineStart: 10 }}>
                    {(childrenOf.get(t.id) ?? []).map((k) => renderCard(k, true))}
                  </div>
                )}
              </div>
            ))}
        </div>
      ) : (
      <div className="pro-board">
        {COLUMNS.map((col) => {
          // Cancelled cards close the Done column, after the done ones.
          const all = shown.filter((t) => t.status === col.status || (col.status === 'done' && t.status === 'cancelled'))
            .sort((a, b) => Number(a.status === 'cancelled') - Number(b.status === 'cancelled') || a.priority - b.priority || b.createdAt.localeCompare(a.createdAt));
          const roots = columnRoots(all);
          // Done piles up and buries the board: the latest few, the rest on demand.
          const cards = col.status === 'done' && !showDone ? roots.slice(0, 8) : roots;
          return (
            <section key={col.status} className={`pro-col${overCol === col.status && dragId ? ' pro-col-drop' : ''}`} aria-label={tr(`pro.tasks.col_${col.status}`)}
              onDragOver={(e) => { if (!dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overCol !== col.status) setOverCol(col.status); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol(null); }}
              onDrop={(e) => { e.preventDefault(); dropOn(col.status); }}>
              <div className="pro-col-head"><span className="pro-dot" style={{ background: col.color }} />{tr(`pro.tasks.col_${col.status}`)}<span className="pro-sub">{all.length}</span></div>
              {cards.map((t) => renderTree(t, all))}
              {col.status === 'done' && roots.length > 8 && (
                <button className="pro-btn" style={{ alignSelf: 'center' }} onClick={() => setShowDone((v) => !v)}>
                  {showDone ? tr('pro.tasks.fewerDone') : tr('pro.tasks.allDone', { count: all.length })}
                </button>
              )}
            </section>
          );
        })}
      </div>
      )}

      {ask && (() => {
        const parent = tasks.find((x) => x.id === ask.id);
        const to = tr(`pro.tasks.col_${ask.status}`);
        return (
          <div className="pro-modal-back" role="presentation" onClick={() => setAsk(null)}>
            <div className="pro-card pro-modal" role="dialog" aria-modal="true" aria-labelledby="move-kids-title" onClick={(e) => e.stopPropagation()}>
              <strong id="move-kids-title" style={{ fontSize: 15 }}>{tr('pro.tasks.moveKidsTitle', { key: parent?.key ?? ask.id, to })}</strong>
              <span className="pro-sub" style={{ fontSize: 13 }}>{tr('pro.tasks.moveKidsBody', { count: ask.kids.length, to })}</span>
              <ul style={{ margin: 0, paddingInlineStart: 18, maxHeight: 160, overflowY: 'auto', fontSize: 13 }}>
                {ask.kids.map((k) => <li key={k.id}><span className="pro-ticket">{k.key ?? k.id}</span> {k.title} <span className="pro-sub">· {tr(`pro.tasks.col_${k.status}`)}</span></li>)}
              </ul>
              <div className="pro-row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                <button className="pro-btn" onClick={() => setAsk(null)}>{tr('common.cancel')}</button>
                <button className="pro-btn" onClick={() => { void moveCards([ask.id], ask.status); setAsk(null); }}>{tr('pro.tasks.moveOnlyThis')}</button>
                <button className="pro-btn pro-btn-primary" autoFocus onClick={() => { void moveCards([ask.id, ...ask.kids.map((k) => k.id)], ask.status); setAsk(null); }}>{tr('pro.tasks.moveWithKids', { count: ask.kids.length })}</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
