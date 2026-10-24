import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { TaskTimeline } from './TaskTimeline';
import { FileTypeBadge } from './FileTypeBadge';
import { deliverablePaths, splitPath } from '@shared/deliverables';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { useRtl } from '@/i18n/useDirection';
import { useProStore } from '@/pro/proStore';
import { SpritePortrait } from './SpritePortrait';
import { formatTaskKey } from '@shared/taskKeys';
import { descendantsOf } from '@shared/taskBoard';
import { isTaskStatus, taskEditPatch, type TaskEdit, type TaskStatus } from '@shared/taskEdit';

/** The ticket people use for a card (DUN-12); the ledger id only when it has none yet. */
export function ticketOf(task: HiveTask & { key?: string }): string {
  return task.key ?? task.id;
}

/** The board with its ticket keys (the same numbering the Pro board shows). */
export async function loadKeyedTasks(): Promise<Array<HiveTask & { key?: string }>> {
  const [raw, keys] = await Promise.all([
    window.cth.hiveTasks(),
    window.cth.hiveTaskKeys().catch(() => ({ prefix: 'md', keys: {} as Record<string, number> }))
  ]);
  // A ticket the human gave the card (a Jira key…) wins over the generated one.
  return parseTasks(raw).map((t) => ({ ...t, key: t.ticket ?? formatTaskKey(keys.prefix, keys.keys[t.id]) }));
}

/** A card on the task kanban. Mirrors HiveTask in the main/preload process —
 *  re-declared locally so the renderer doesn't reach into the preload package
 *  (same convention as store/config.ts). */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  /** Set when the human dismisses the ask from the ASK ME board WITHOUT
   *  answering — the question stays on the card (history is preserved) but
   *  openQuestion() stops returning it, so the card leaves ASK ME. */
  dismissedAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  /** `cancelled`: the human stopped it; it stays on the board, greyed. */
  status: TaskStatus;
  /** The human's own ticket key (shown instead of the generated one). */
  ticket?: string;
  cancelledAt?: string;
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card needs the
   *  human; the ASK ME view fills in {a}. Full history stays on the card. */
  humanQA?: HumanQA[];
  /** Outcome summary the orchestrator wrote when the card was done. */
  result?: string;
  /** Path(s) of what the card produced for the human (Manager → Deliverables). */
  deliverable?: string;
  /** The task this one is a piece of (a subtask), by id. */
  parent?: string;
}

/** The card's currently open question for the human, if any. An entry the human
 *  dismissed (dismissedAt) counts as resolved, same as an answered one. */
export function openQuestion(t: HiveTask): HumanQA | undefined {
  if (!Array.isArray(t.humanQA)) return undefined;
  for (let i = t.humanQA.length - 1; i >= 0; i--) {
    const e = t.humanQA[i];
    if (e && typeof e.q === 'string' && !e.a && !e.dismissedAt) return e;
  }
  return undefined;
}

/** Waiting on the human = blocked with an unanswered question on the card. */
export function waitsOnHuman(t: HiveTask): boolean {
  return t.status === 'blocked' && !!openQuestion(t);
}

type Status = HiveTask['status'];

const COLUMNS: { key: Status; labelKey: string; accent: string }[] = [
  { key: 'backlog', labelKey: 'kanban.colBacklog', accent: 'var(--cth-ink-300)' },
  { key: 'todo',    labelKey: 'kanban.colTodo',    accent: 'var(--cth-sky)' },
  { key: 'doing',   labelKey: 'kanban.colDoing',   accent: 'var(--cth-lemon)' },
  { key: 'blocked', labelKey: 'kanban.colBlocked', accent: 'var(--cth-coral)' },
  { key: 'done',    labelKey: 'kanban.colDone',    accent: 'var(--cth-mint)' }
];
/** Not a column: cancelled cards sit greyed in Done (as factory jobs do). */
const CANCELLED = { key: 'cancelled' as Status, labelKey: 'kanban.colCancelled', accent: 'var(--cth-ink-100)' };
const styleOf = (s: Status) => (s === 'cancelled' ? CANCELLED : COLUMNS.find((c) => c.key === s) ?? COLUMNS[0]);

const POLL_MS = 5000;

/** Deterministic fallback id derived from a task's content (djb2 → base36).
 *  Used for tasks lacking a valid string id so re-parsing tasks.json on every
 *  5s poll yields the SAME id — no React key churn / card remount. Unlike
 *  shortId() (random, for brand-new tasks), this never changes across polls. */
function stableId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Normalize whatever hive:tasks returns into a typed task array. The god
 *  writes this file by hand — every field except the shape itself is optional
 *  in practice, so EVERY consumer must go through this (exported for the
 *  detail overlay; a raw card without dependsOn once crashed it). */
export function parseTasks(raw: unknown): HiveTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => ({
      id: typeof t.id === 'string' && t.id
        ? t.id
        : stableId(`${typeof t.title === 'string' ? t.title : ''}|${typeof t.createdAt === 'string' ? t.createdAt : ''}|${i}`),
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      description: typeof t.description === 'string' ? t.description : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      status: isTaskStatus(t.status) ? t.status : 'todo',
      ticket: typeof t.ticket === 'string' && t.ticket.trim() ? t.ticket.trim() : undefined,
      cancelledAt: typeof t.cancelledAt === 'string' ? t.cancelledAt : undefined,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      priority: typeof t.priority === 'number' ? t.priority : 3,
      deliverable: typeof t.deliverable === 'string' && t.deliverable.trim() ? t.deliverable : undefined,
      parent: typeof t.parent === 'string' && t.parent.trim() ? t.parent.trim() : undefined,
      result: typeof t.result === 'string' && t.result.trim() ? t.result : undefined,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      humanQA: Array.isArray(t.humanQA)
        ? (t.humanQA as unknown[])
          .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as { q?: unknown }).q === 'string')
          .map((e) => ({
            q: e.q as string,
            a: typeof e.a === 'string' ? e.a : undefined,
            askedAt: typeof e.askedAt === 'string' ? e.askedAt : undefined,
            answeredAt: typeof e.answeredAt === 'string' ? e.answeredAt : undefined,
            // Preserve a dismissal across the 5s re-parse, else the card would
            // resurface on the next poll (openQuestion would see it as open).
            dismissedAt: typeof e.dismissedAt === 'string' ? e.dismissedAt : undefined
          }))
        : undefined
    }));
}

/**
 * Task kanban over hive/tasks.json — a READ surface. Polls every 5s; cards
 * carry just the title and open the app-wide detail overlay on click. The god
 * is the ledger's writer: new work enters via the dispatch box (mailed to the
 * god), never by the human inserting cards the orchestrator never heard about.
 */
export function TasksKanban() {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  // Detail view: cards show just the title — clicking one opens the full
  // breakdown as an APP-WIDE overlay over the office floor (see
  // TaskDetailOverlay) — the content grows (contracts, deps, human Q&A), so it
  // gets the big stage instead of the narrow side panel.
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(await loadKeyedTasks()); } catch { /* keep last good */ }
  }, []);

  // Dismiss a card off the board (human-initiated). The kanban is otherwise the
  // god's to write, but a person can clear a card they no longer want tracked.
  // Main removes the named id from its latest on-disk ledger, so a webhook or
  // god card added since this renderer's last poll cannot be lost.
  const dismissTask = useCallback(async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id)); // optimistic
    try {
      const result = await window.cth.hiveDeleteTask(id);
      if (!result.ok) void refresh();
    } catch { /* keep last good; the next poll re-syncs from disk */ }
  }, [refresh]);

  // Drag a card to another column (as in the Manager's board). Moving a card
  // that has subtasks asks whether they go with it.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<Status | null>(null);
  const [ask, setAsk] = useState<{ id: string; status: Status; kids: HiveTask[] } | null>(null);
  const moveCards = async (ids: string[], status: Status) => {
    setTasks((prev) => prev.map((x) => (ids.includes(x.id) ? { ...x, status } : x))); // optimistic
    for (const id of ids) {
      try { await window.cth.hivePatchTask(id, { status }); } catch { /* the poll shows the truth */ }
    }
    void refresh();
  };
  const dropOn = (status: Status) => {
    const id = dragId;
    setDragId(null); setOverCol(null);
    const card = id ? tasks.find((x) => x.id === id) : undefined;
    if (!card || card.status === status) return;
    const kids = descendantsOf(tasks, card.id).filter((k) => k.status !== status && k.status !== 'cancelled');
    if (kids.length) setAsk({ id: card.id, status, kids });
    else void moveCards([card.id], status);
  };

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  const [showCancelled, setShowCancelled] = useState(true);
  const cancelledCount = tasks.filter((x) => x.status === 'cancelled').length;

  const restorableAgents = useStore((s) => s.restorableAgents);
  /** Resolve an assignee id to a display name — falls back to the restorable
   *  roster so a done card keeps its author's name even after that worker's
   *  terminal is gone, then to the raw id. */
  const nameFor = (id?: string): string | undefined =>
    id
      ? (agents.find((a) => a.id === id)?.name
        ?? restorableAgents.find((a) => a.id === id)?.name
        ?? id)
      : undefined;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)', position: 'relative' }}>
      {/* Toolbar — read-only: the god is the ledger's writer. New work enters
          through the dispatch box (which mails the god), not by the human
          inserting cards the orchestrator never heard about. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {t('kanban.count', { count: tasks.length })}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--cth-ink-300)' }}>
          {t('kanban.newWorkHint')}
        </span>
        {cancelledCount > 0 && (
          <PixelButton variant={showCancelled ? 'secondary' : 'ghost'} size="sm"
            title={t('kanban.showCancelledTitle')} onClick={() => setShowCancelled((v) => !v)}>
            {t(showCancelled ? 'kanban.hideCancelled' : 'kanban.showCancelled', { count: cancelledCount })}
          </PixelButton>
        )}
      </div>

      {/* Columns */}
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 10, overflowX: 'auto'
      }}>
        {COLUMNS.map((col) => {
          // Cancelled cards close the Done column, greyed (hidden by the toolbar toggle).
          const cards = [
            ...tasks.filter((t) => t.status === col.key),
            ...(col.key === 'done' && showCancelled ? tasks.filter((t) => t.status === 'cancelled') : [])
          ];
          return (
            <div key={col.key}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverCol(col.key); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOverCol((c) => (c === col.key ? null : c)); }}
              onDrop={(e) => { e.preventDefault(); dropOn(col.key); }}
              style={{
              flex: '1 1 0', minWidth: 170, display: 'flex', flexDirection: 'column',
              background: overCol === col.key && dragId ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
              boxShadow: overCol === col.key && dragId ? 'inset 0 0 0 2px var(--cth-lemon)' : 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 4px',
                background: col.accent, boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)'
              }}>
                {t(col.labelKey)}
                <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}>{cards.length}</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cards.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '8px 0' }}>{t('kanban.emptyColumn')}</div>
                )}
                {cards.map((t) => (
                  // A cancelled card is reopened from its detail (god is told), not dragged.
                  <div key={t.id} draggable={t.status !== 'cancelled'}
                    onDragStart={(e) => { setDragId(t.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); }}
                    onDragEnd={() => { setDragId(null); setOverCol(null); }}
                    style={{ opacity: dragId === t.id ? 0.5 : 1, cursor: t.status === 'cancelled' ? 'pointer' : 'grab' }}>
                  <TaskCard
                    task={t}
                    accent={styleOf(t.status).accent}
                    assigneeName={nameFor(t.assignee)}
                    all={tasks}
                    onOpen={() => openTaskDetail(t.id)}
                    onDismiss={() => dismissTask(t.id)}
                  />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {ask && (() => {
        const parent = tasks.find((x) => x.id === ask.id);
        const to = t(COLUMNS.find((c) => c.key === ask.status)?.labelKey ?? '').toLowerCase();
        return (
          <div role="presentation" onClick={() => setAsk(null)} style={{ position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(26, 19, 32, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div role="dialog" aria-modal="true" aria-labelledby="classic-move-kids" onClick={(e) => e.stopPropagation()}
              style={{ width: 420, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 10, padding: 14, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900), 4px 4px 0 rgba(26, 19, 32, 0.25)' }}>
              <strong id="classic-move-kids" style={{ fontSize: 14 }}>{t('pro.tasks.moveKidsTitle', { key: parent ? ticketOf(parent) : ask.id, to })}</strong>
              <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('pro.tasks.moveKidsBody', { count: ask.kids.length, to })}</span>
              <ul style={{ margin: 0, paddingInlineStart: 18, maxHeight: 150, overflowY: 'auto', fontSize: 12 }}>
                {ask.kids.map((k) => <li key={k.id}><span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)' }}>{ticketOf(k)}</span> {k.title}</li>)}
              </ul>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
                <PixelButton variant="secondary" size="sm" onClick={() => setAsk(null)}>{t('common.cancel')}</PixelButton>
                <PixelButton variant="secondary" size="sm" onClick={() => { void moveCards([ask.id], ask.status); setAsk(null); }}>{t('pro.tasks.moveOnlyThis')}</PixelButton>
                <PixelButton variant="primary" size="sm" onClick={() => { void moveCards([ask.id, ...ask.kids.map((k) => k.id)], ask.status); setAsk(null); }}>{t('pro.tasks.moveWithKids', { count: ask.kids.length })}</PixelButton>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────
// Deliberately minimal — a colored status edge, the task id, the title, a
// whisper of an assignee. Everything else (the full contract, deps, controls)
// lives in the detail view a click away: a kanban card can carry little more
// than a title.

function TaskCard({ task, accent, assigneeName, all, onOpen, onDismiss }: {
  task: HiveTask;
  accent: string;
  assigneeName?: string;
  all: HiveTask[];
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const owner = useStore((s) => (task.assignee ? s.agents.find((a) => a.id === task.assignee) : undefined));
  const parent = task.parent ? all.find((x) => x.id === task.parent) : undefined;
  const kids = all.filter((x) => x.parent === task.id);
  const open = openQuestion(task);
  const cancelled = task.status === 'cancelled';
  return (
    // Cancelled: greyed and struck through, kept on the board as history.
    <div style={{ position: 'relative', display: 'flex', ...(cancelled ? { opacity: 0.55, filter: 'grayscale(1)' } : {}) }}>
      <button
        onClick={onOpen}
        title={t('kanban.openTaskDetails')}
        style={{
          flex: 1, minWidth: 0,
          display: 'flex', alignItems: 'stretch', gap: 0, padding: 0,
          border: 'none', cursor: 'pointer', textAlign: 'left',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
        }}
      >
        <span style={{ width: 4, flexShrink: 0, background: accent, boxShadow: 'inset -1px 0 0 var(--cth-ink-700)' }} />
        <span style={{ flex: 1, minWidth: 0, padding: '6px 18px 6px 7px', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* The id the god writes into tasks.json (bmt-12, or a synthetic
              t-xxxx). Cards get referred to by id in dispatches and in Slack,
              so it has to be readable without opening the detail view. Mono
              because it's an identifier you retype. Sits inside the text
              column, so the 18px right padding keeps it clear of the ✕ and
              the '?' badge. */}
          <span style={{
            fontFamily: 'var(--cth-font-mono)', fontSize: 10,
            color: 'var(--cth-ink-500)'
          }} title={task.id}>{ticketOf(task)}</span>
          {parent && (
            <span style={{ fontSize: 10.5, color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t('kanban.partOf')}>↳ {parent.title}</span>
          )}
          <span style={{
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: '16px',
            color: 'var(--cth-ink-900)', textDecoration: cancelled ? 'line-through' : undefined,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
          }}>{task.title}</span>
          {cancelled && <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>{t('kanban.colCancelled')}</span>}
          {/* What it waits on, in words: the open question for you. */}
          {open && (
            <span title={t('kanban.needsYouTitle')} style={{
              fontSize: 11, lineHeight: '15px', padding: '3px 5px', marginTop: 2,
              background: 'var(--cth-lilac-light)', color: 'var(--cth-ink-900)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden'
            }}><strong>{t('kanban.asksYou')}</strong> {open.q.replace(/[*_`#>]/g, '')}</span>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, flexWrap: 'wrap' }}>
            {owner ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--cth-ink-700)' }}>
                <SpritePortrait character={owner.character} scale={1} />{owner.name}
              </span>
            ) : assigneeName ? (
              <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{assigneeName}</span>
            ) : (
              <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>{t('kanban.unassigned')}</span>
            )}
            {kids.length > 0 && (
              <span style={{ fontSize: 10.5, color: 'var(--cth-ink-500)' }}>
                {t('kanban.subtasksShort', { done: kids.filter((k) => k.status === 'done').length, total: kids.length })}
              </span>
            )}
            {task.deliverable && (() => {
              const first = splitPath(task.deliverable.split(/[\n,;]/)[0].trim()).name;
              return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color: 'var(--cth-ink-500)', minWidth: 0 }} title={task.deliverable}><FileTypeBadge name={first} />{first}</span>;
            })()}
          </span>
        </span>
      </button>
      {/* Dismiss — sibling button (not nested) so it never triggers onOpen. */}
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        title={t('kanban.dismissTitle')}
        aria-label={t('kanban.dismissAria')}
        style={{
          position: 'absolute', top: 0, right: 0, width: 16, height: 16, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
          border: 'none', cursor: 'pointer', background: 'transparent',
          color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)', fontSize: 12
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--cth-coral)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--cth-ink-500)'; }}
      >✕</button>
    </div>
  );
}

// ─── Detail view ─────────────────────────────────────────────────────────────
// The full breakdown of one task: status, assignee, priority, the complete
// description (the god writes 4-part dispatch contracts in there — preserved
// line by line), dependencies resolved to their titles, the human Q&A trail,
// and the move/assign controls that used to crowd every card. Rendered as an
// APP-WIDE overlay (over the office floor) — this content grows, so it gets
// the big stage instead of the narrow side panel. Exported for App's
// TaskDetailOverlay; opened via the store's openTaskDetail from anywhere.

export function TaskDetail({ task, all, assigneeName, onMove, onAssign, onEdit, onClose }: {
  task: HiveTask;
  all: HiveTask[];
  assigneeName?: string;
  onMove: (s: Status) => void;
  onAssign: () => void;
  /** Edit / cancel / reopen cards as the human; resolves to an error code, or null. */
  onEdit: (edits: Array<{ id: string; edit: TaskEdit }>) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const agents = useStore((s) => s.agents);
  // Edit mode: the fields the human may change, as a draft until Save.
  type Draft = { title: string; description: string; assignee: string; ticket: string; parent: string };
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** "Cancel this task?" — with the subtasks that would still be worked on. */
  const [confirmCancel, setConfirmCancel] = useState<HiveTask[] | null>(null);
  const cancelled = task.status === 'cancelled';
  const key = (task as HiveTask & { key?: string }).key;
  // Other cards keep the generated key in view, so a typed ticket can't copy one.
  const keyOf = (id: string) => (all.find((x) => x.id === id) as (HiveTask & { key?: string }) | undefined)?.key;
  useEffect(() => { setDraft(null); setEditError(null); setConfirmCancel(null); }, [task.id]);
  const startEdit = () => {
    setEditError(null);
    setDraft({ title: task.title, description: task.description ?? '', assignee: task.assignee ?? '', ticket: task.ticket ?? '', parent: task.parent ?? '' });
  };
  const run = async (edits: Array<{ id: string; edit: TaskEdit }>): Promise<boolean> => {
    setSaving(true); setEditError(null);
    try {
      const err = await onEdit(edits);
      if (err) { setEditError(err); return false; }
      return true;
    } finally { setSaving(false); }
  };
  const save = async () => {
    if (!draft) return;
    const edit: TaskEdit = {
      title: draft.title, description: draft.description || null, assignee: draft.assignee || null,
      ticket: draft.ticket || null, parent: draft.parent || null
    };
    // Same rules main applies, checked here first so the form says what's wrong.
    const check = taskEditPatch(all, task.id, edit, keyOf);
    if (!check.ok) { setEditError(check.error); return; }
    if (!Object.keys(check.patch).length) { setDraft(null); return; }
    if (await run([{ id: task.id, edit }])) setDraft(null);
  };
  const askCancel = () => {
    setEditError(null);
    setConfirmCancel(descendantsOf(all, task.id).filter((k) => k.status !== 'done' && k.status !== 'cancelled'));
  };
  const cancelCards = async (ids: string[]) => {
    if (await run(ids.map((id) => ({ id, edit: { status: 'cancelled' as const } })))) setConfirmCancel(null);
  };
  // Who a card can go to: everyone on the floor, plus whoever has it now.
  const people = [...agents.map((a) => ({ id: a.id, name: a.name }))];
  if (task.assignee && !people.some((p) => p.id === task.assignee)) people.push({ id: task.assignee, name: assigneeName ?? task.assignee });
  // A card can't hang under itself or under one of its own subtasks.
  const below = new Set(descendantsOf(all, task.id).map((d) => d.id));
  const parents = all.filter((x) => x.id !== task.id && !below.has(x.id));
  // Files an agent wrote into research/ while this card was its task (linked by
  // the app, not the orchestrator) — counted here, listed in Deliverables.
  // Every file this card produced: its deliverable field plus linked files,
  // with who wrote each (the link's agent) and the file's last change.
  const [files, setFiles] = useState<Array<{ path: string; agentId?: string; mtime?: number }>>([]);
  useEffect(() => {
    let alive = true;
    void window.cth.deliverablesList?.().then((d) => {
      if (!alive || !d.root) return;
      const meta = new Map(d.files.map((f) => [f.abs.replace(/\\/g, '/').toLowerCase(), f.mtime]));
      const out: Array<{ path: string; agentId?: string; mtime?: number }> = [];
      const seen = new Set<string>();
      const add = (path: string, agentId?: string) => {
        const k = path.replace(/\\/g, '/').toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ path, agentId, mtime: meta.get(k) });
      };
      for (const p of deliverablePaths(task.deliverable, d.root, d.distro)) add(p, task.assignee);
      for (const l of d.links.filter((x) => x.taskId === task.id)) add(l.path, l.agentId);
      setFiles(out);
    }).catch(() => {});
    return () => { alive = false; };
  }, [task.id, task.deliverable, task.assignee]);
  const agentName = (id?: string) => (id ? (useStore.getState().agents.find((a) => a.id === id)?.name ?? id) : '');
  const openInDeliverables = () => {
    const pro = useProStore.getState();
    pro.setLayout('pro');
    pro.setFocusTask(task.id);
    pro.setView({ kind: 'section', section: 'deliverables' });
    onClose();
  };
  const col = styleOf(task.status);
  // Belt + suspenders: parseTasks normalizes these, but the ledger is a
  // hand-written file — never trust a card's shape at the point of use.
  const deps = (task.dependsOn ?? [])
    .map((id) => all.find((t) => t.id === id))
    .filter((t): t is HiveTask => !!t);
  const created = new Date(task.createdAt);
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 280,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 720, maxWidth: '94vw', maxHeight: '90vh', display: 'flex' }}>
        <PixelPanel variant="dialog" title={t('kanban.taskTitle')} noPadding style={{ display: 'flex', flexDirection: 'column', width: '100%', minHeight: 0 }}>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' }}>
            {/* Title under a status-colored bar */}
            <div style={{ borderLeft: `4px solid ${col.accent}`, paddingLeft: 8 }}>
              {draft ? (
                <input aria-label={t('kanban.editTitle')} value={draft.title} autoFocus
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={{ ...inputStyle, fontSize: 15, lineHeight: '20px' }} />
              ) : (
                <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 15, lineHeight: '20px', color: cancelled ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)', textDecoration: cancelled ? 'line-through' : undefined }}>
                  {task.title}
                </div>
              )}
            </div>

            {cancelled && (
              <div style={{ padding: '5px 8px', background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                {task.cancelledAt ? t('kanban.cancelledOn', { when: new Date(task.cancelledAt).toLocaleString() }) : t('kanban.cancelledNote')}
              </div>
            )}

            {/* The fields Edit can change besides title and description. */}
            {draft && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={labelStyle}>{t('kanban.editAssignee')}</span>
                  <select value={draft.assignee} onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} style={selectStyle}>
                    <option value="">{t('kanban.unassigned')}</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={labelStyle}>{t('kanban.editTicket')}</span>
                  <input value={draft.ticket} placeholder={task.ticket ? '' : key ?? ''} onChange={(e) => setDraft({ ...draft, ticket: e.target.value })} style={inputStyle} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={labelStyle}>{t('kanban.editParent')}</span>
                  <select value={draft.parent} onChange={(e) => setDraft({ ...draft, parent: e.target.value })} style={selectStyle}>
                    <option value="">{t('kanban.noParent')}</option>
                    {parents.map((p) => <option key={p.id} value={p.id}>{ticketOf(p)} · {p.title}</option>)}
                  </select>
                </label>
              </div>
            )}

            {/* Fact row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {/* The id leads the row for the same reason it leads on the card:
                  it is the handle every dispatch and every message uses to name
                  this task, so it should be the first thing here too. */}
              <span style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)'
              }} title={task.id}>{ticketOf(task)}</span>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 8, padding: '2px 6px 1px',
                background: col.accent, color: 'var(--cth-ink-900)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>{t(col.labelKey)}</span>
              {assigneeName
                ? <PixelBadge status="working" label={assigneeName} />
                : <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>{t('kanban.unassigned')}</span>}
              <PriorityDots level={Math.max(1, Math.min(5, task.priority))} />
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)' }}>
                {isNaN(created.getTime()) ? '' : created.toLocaleString()}
              </span>
            </div>

            {/* The contract — preserved line by line */}
            {draft ? (
              <textarea aria-label={t('kanban.editDescription')} value={draft.description} rows={8}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', lineHeight: '18px', resize: 'vertical' }} dir={rtl ? 'auto' : undefined} />
            ) : (
            <div style={{
              padding: 10, background: 'var(--cth-paper-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '18px',
              color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }} dir={rtl ? 'auto' : undefined}>
              {task.description?.trim() || <span style={{ color: 'var(--cth-ink-300)' }}>{t('kanban.noDescription')}</span>}
            </div>
            )}

            {/* Where it comes from and what it was split into (subtasks). */}
            {(() => {
              const parent = task.parent ? all.find((x) => x.id === task.parent) : undefined;
              const kids = all.filter((x) => x.parent === task.id);
              if (!parent && !kids.length) return null;
              const row = (x: HiveTask) => {
                const c = styleOf(x.status);
                return (
                  <button key={x.id} onClick={() => useStore.getState().openTaskDetail(x.id)}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 7px', border: 'none', cursor: 'pointer', textAlign: 'start', font: 'inherit',
                      background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontSize: 12, color: 'var(--cth-ink-900)' }}>
                    <span style={{ width: 8, height: 8, background: c.accent, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.title}</span>
                    <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>{t(c.labelKey)}</span>
                  </button>
                );
              };
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {parent && <>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>{t('kanban.partOf')}</div>
                    {row(parent)}
                  </>}
                  {kids.length > 0 && <>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                      {t('kanban.subtasks', { done: kids.filter((k) => k.status === 'done').length, total: kids.length })}
                    </div>
                    {kids.map(row)}
                  </>}
                </div>
              );
            })()}

            {/* What the card produced, one row per file: type, name, who, when. */}
            {files.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)', flex: 1 }}>{t('kanban.deliverable')} · {files.length}</span>
                  <PixelButton variant="secondary" size="sm" onClick={openInDeliverables}>{t('kanban.openDeliverable')}</PixelButton>
                </div>
                {files.map((f) => (
                  <button key={f.path} onClick={openInDeliverables} title={f.path}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', border: 'none', cursor: 'pointer', textAlign: 'start',
                      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', font: 'inherit', color: 'var(--cth-ink-900)' }}>
                    <FileTypeBadge name={f.path} />
                    <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{splitPath(f.path).name}</span>
                    <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
                      {[agentName(f.agentId), f.mtime ? new Date(f.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                ))}
              </div>
            )}

            {/* The human Q&A trail — every decision documented on the card.
                Rendered as markdown (card variant), matching the ASK ME tab the
                "view earlier answers" link arrives from. */}
            {(task.humanQA?.length ?? 0) > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  {t('kanban.humanQA')}
                </div>
                {task.humanQA!.map((e, i) => (
                  <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{
                      display: 'flex', gap: 6, padding: '5px 7px',
                      background: 'var(--cth-lilac-light, #ece2f5)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                    }}>
                      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, flexShrink: 0, marginTop: 2 }}>Q</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <MarkdownPreview source={e.q} variant="card" />
                      </div>
                    </div>
                    {e.a ? (
                      <div style={{
                        display: 'flex', gap: 6, padding: '5px 7px',
                        background: 'var(--cth-mint-light, #d9eed9)',
                        boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                        fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)'
                      }}>
                        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, flexShrink: 0, marginTop: 2 }}>A</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <MarkdownPreview source={e.a} variant="card" />
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: 'var(--cth-coral)', fontFamily: 'var(--cth-font-display)' }}>
                        {t('kanban.awaitingAnswer')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* What happened to it, and the messages that name it. */}
            <TaskTimeline taskId={task.id} taskKey={(task as HiveTask & { key?: string }).key} />

            {/* Dependencies, resolved to titles */}
            {deps.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>
                  {t('kanban.dependsOn')}
                </div>
                {deps.map((d) => {
                  const dc = styleOf(d.status);
                  return (
                    <div key={d.id} style={{
                      display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px',
                      background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      fontSize: 12, color: 'var(--cth-ink-700)'
                    }}>
                      <span style={{ width: 8, height: 8, background: dc.accent, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.title}</span>
                    </div>
                  );
                })}
              </div>
            )}

            {editError && (
              <div role="alert" style={{ fontSize: 12, color: 'var(--cth-coral)' }}>
                {t(`kanban.editError_${editError}`, { defaultValue: t('kanban.editError_failed') })}
              </div>
            )}

            {/* Controls */}
            {draft ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <span style={{ flex: 1, fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('kanban.editHint')}</span>
                <PixelButton variant="ghost" size="sm" onClick={() => { setDraft(null); setEditError(null); }}>{t('kanban.editDiscard')}</PixelButton>
                <PixelButton variant="primary" size="sm" disabled={saving || !draft.title.trim()} onClick={() => void save()}>{t('kanban.editSave')}</PixelButton>
              </div>
            ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {/* A cancelled card leaves "cancelled" only through Reopen (god is told). */}
              <select
                value={task.status}
                disabled={cancelled}
                onChange={(e) => onMove(e.target.value as Status)}
                style={{
                  flex: 1, minWidth: 120, padding: '4px 6px', background: 'var(--cth-paper-100)', border: 'none',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)',
                  fontSize: 12, color: 'var(--cth-ink-900)', cursor: cancelled ? 'default' : 'pointer'
                }}
              >
                {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{t(c.labelKey).toLowerCase()}</option>))}
                {cancelled && <option value="cancelled">{t(CANCELLED.labelKey).toLowerCase()}</option>}
              </select>
              <PixelButton variant="secondary" size="sm" onClick={startEdit}>{t('kanban.edit')}</PixelButton>
              {cancelled
                ? <PixelButton variant="secondary" size="sm" disabled={saving} onClick={() => void run([{ id: task.id, edit: { status: 'todo' } }])}>{t('kanban.reopen')}</PixelButton>
                : <PixelButton variant="destructive" size="sm" onClick={askCancel}>{t('kanban.cancelTask')}</PixelButton>}
              <PixelButton variant="secondary" size="sm" onClick={onAssign}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Icon name="arrow-right" /> {t('kanban.assign')}
                </span>
              </PixelButton>
              <PixelButton variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</PixelButton>
            </div>
            )}

            {/* Cancel: who is told, and the subtasks that would go on without it. */}
            {confirmCancel && (
              <div role="alertdialog" aria-labelledby="task-cancel-title"
                style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 2px var(--cth-coral)' }}>
                <strong id="task-cancel-title" style={{ fontSize: 13 }}>{t('kanban.cancelTitle', { key: ticketOf(task) })}</strong>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>
                  {assigneeName ? t('kanban.cancelBody', { name: assigneeName }) : t('kanban.cancelBodyNoOwner')}
                </span>
                {confirmCancel.length > 0 && <>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>{t('kanban.cancelKidsBody', { count: confirmCancel.length })}</span>
                  <ul style={{ margin: 0, paddingInlineStart: 18, maxHeight: 120, overflowY: 'auto', fontSize: 12 }}>
                    {confirmCancel.map((k) => <li key={k.id}><span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 10, color: 'var(--cth-ink-500)' }}>{ticketOf(k)}</span> {k.title}</li>)}
                  </ul>
                </>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
                  <PixelButton variant="secondary" size="sm" onClick={() => setConfirmCancel(null)}>{t('kanban.cancelKeep')}</PixelButton>
                  {confirmCancel.length > 0 ? <>
                    <PixelButton variant="secondary" size="sm" disabled={saving} onClick={() => void cancelCards([task.id])}>{t('kanban.cancelOnlyThis')}</PixelButton>
                    <PixelButton variant="destructive" size="sm" disabled={saving} onClick={() => void cancelCards([task.id, ...confirmCancel.map((k) => k.id)])}>{t('kanban.cancelWithKids', { count: confirmCancel.length })}</PixelButton>
                  </> : <PixelButton variant="destructive" size="sm" disabled={saving} onClick={() => void cancelCards([task.id])}>{t('kanban.cancelTask')}</PixelButton>}
                </div>
              </div>
            )}
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function PriorityDots({ level }: { level: number }) {
  const { t } = useTranslation();
  // 1 = lowest, 5 = highest. Warmer fill as priority climbs.
  const color = level >= 4 ? 'var(--cth-coral)' : level === 3 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  return (
    <span title={t('kanban.priority', { level })} style={{ display: 'inline-flex', gap: 1, flexShrink: 0, marginTop: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{
          width: 4, height: 8,
          background: i <= level ? color : 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

const selectStyle: React.CSSProperties = {
  padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)'
};
