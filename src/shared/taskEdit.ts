/**
 * The human edits or cancels a task card, and whoever was on it is told.
 *
 * tasks.json is the orchestrator's file, so a change made from the app has to
 * reach two readers: the agent the card is (or was) assigned to, who must stop
 * or pick up the new contract, and the orchestrator, who would otherwise
 * rewrite the card from its own stale picture. Both hear it through the hive
 * inbox (never typed into a terminal: see docs/message-queue.md).
 *
 * Pure: main applies the patch and sends the notices (hive.editTasks), the
 * renderer validates with the same rules before it asks.
 */

import { descendantsOf } from './taskBoard';

/** Every status a card can have. `cancelled` is the human's "stop following
 *  this": the card stays on the board and in its history, nobody works on it. */
export const TASK_STATUSES = ['backlog', 'todo', 'doing', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** Statuses in which the assignee is on the card (or it is its next job). */
export function isActiveStatus(status: unknown): boolean {
  return status === 'todo' || status === 'doing' || status === 'blocked';
}

/** What the human may change on a card. `null` clears a field. */
export interface TaskEdit {
  title?: string;
  description?: string | null;
  assignee?: string | null;
  /** The card's ticket key shown instead of the generated one (e.g. a Jira key). */
  ticket?: string | null;
  parent?: string | null;
  status?: TaskStatus;
}

export type TaskEditError =
  | 'notFound' | 'emptyTitle' | 'badStatus' | 'badTicket' | 'ticketTaken'
  | 'parentMissing' | 'parentSelf' | 'parentLoop';

type RawTask = Record<string, unknown>;

const TICKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const asList = (raw: unknown): RawTask[] =>
  (Array.isArray(raw) ? raw : []).filter((t): t is RawTask => !!t && typeof t === 'object' && typeof (t as RawTask).id === 'string');

/**
 * The ledger patch for `edit` on card `id`: only the fields that change, with
 * `null` for a field being cleared. `keyOf` gives a card's shown ticket, so a
 * new ticket can't take one another card already shows.
 */
export function taskEditPatch(
  rawTasks: unknown,
  id: string,
  edit: TaskEdit,
  keyOf: (id: string) => string | undefined = () => undefined,
  now: string = new Date().toISOString()
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: TaskEditError } {
  const list = asList(rawTasks);
  const card = list.find((t) => t.id === id);
  if (!card) return { ok: false, error: 'notFound' };
  const patch: Record<string, unknown> = {};
  const set = (key: string, value: string | null | undefined) => {
    const next = value === undefined ? undefined : value === null ? null : value;
    if (next === undefined) return;
    const prev = str(card[key]) ?? null;
    if ((next ?? null) !== prev) patch[key] = next;
  };

  if (edit.title !== undefined) {
    const title = edit.title.trim();
    if (!title) return { ok: false, error: 'emptyTitle' };
    set('title', title);
  }
  if (edit.description !== undefined) set('description', edit.description?.trim() ? edit.description.trim() : null);
  if (edit.assignee !== undefined) set('assignee', edit.assignee?.trim() ? edit.assignee.trim() : null);

  if (edit.ticket !== undefined) {
    const ticket = edit.ticket?.trim() ?? '';
    if (ticket) {
      if (!TICKET_RE.test(ticket)) return { ok: false, error: 'badTicket' };
      const lower = ticket.toLowerCase();
      const taken = list.some((t) => t.id !== id && ((str(t.ticket) ?? keyOf(t.id as string) ?? '').toLowerCase() === lower));
      if (taken) return { ok: false, error: 'ticketTaken' };
    }
    set('ticket', ticket || null);
  }

  if (edit.parent !== undefined) {
    const parent = edit.parent?.trim() ?? '';
    if (parent) {
      if (parent === id) return { ok: false, error: 'parentSelf' };
      if (!list.some((t) => t.id === parent)) return { ok: false, error: 'parentMissing' };
      const cards = list.map((t) => ({ id: t.id as string, parent: str(t.parent) }));
      if (descendantsOf(cards, id).some((d) => d.id === parent)) return { ok: false, error: 'parentLoop' };
    }
    set('parent', parent || null);
  }

  if (edit.status !== undefined) {
    if (!isTaskStatus(edit.status)) return { ok: false, error: 'badStatus' };
    if (edit.status !== card.status) {
      patch.status = edit.status;
      // When it was stopped, for the agents reading the card; reopening clears it.
      if (edit.status === 'cancelled') patch.cancelledAt = now;
      else if (card.status === 'cancelled') patch.cancelledAt = null;
    }
  }
  return { ok: true, patch };
}

/** One inbox notice about a changed card. */
export interface TaskNotice { to: string; subject: string; body: string }

const quote = (s: unknown) => `"${String(s ?? '').replace(/\s+/g, ' ').trim()}"`;

/**
 * Who has to hear about the change from `before` to `after`, and what to say.
 *
 * - The assignee (when the card was its job: todo / doing / blocked) is told
 *   to STOP when the card is cancelled or handed to someone else, and gets the
 *   new contract when its title or description changed.
 * - The orchestrator always hears what the human changed, so it doesn't
 *   rewrite the card from its own picture; on a reassignment it hands the card
 *   to the new owner (dispatch stays its job).
 */
export function taskEditNotices(
  before: RawTask,
  after: RawTask,
  ctx: { godId: string; ticket?: string; name?: (id: string) => string }
): TaskNotice[] {
  const id = String(after.id);
  const name = ctx.name ?? ((x: string) => x);
  const handle = ctx.ticket && ctx.ticket !== id ? `${ctx.ticket} (id ${id})` : id;
  const title = quote(after.title ?? before.title ?? id);
  const label = `${ctx.ticket ?? id} ${title}`;
  const owner = str(before.assignee);
  const newOwner = str(after.assignee);
  const wasActive = isActiveStatus(before.status);
  const cancelled = after.status === 'cancelled' && before.status !== 'cancelled';
  const reopened = before.status === 'cancelled' && after.status !== 'cancelled';
  const reassigned = owner !== newOwner;
  const changed = (['title', 'description', 'parent', 'ticket'] as const)
    .filter((k) => (str(before[k]) ?? '') !== (str(after[k]) ?? ''));
  const contractChanged = changed.includes('title') || changed.includes('description');

  const out: TaskNotice[] = [];
  const godLines: string[] = [];
  const stop = 'Stop working on it now: do not start or continue anything for it. If you have unfinished changes for it, leave them as they are and say so in your next message to god. No reply needed.';

  if (cancelled) {
    if (owner && owner !== ctx.godId && wasActive) {
      out.push({
        to: owner,
        subject: `Task cancelled: ${label}`,
        body: `The human cancelled task ${handle} ${title}. ${stop} Do not move the card out of "cancelled".`
      });
    }
    godLines.push(`The human cancelled task ${handle} ${title}${owner ? ` (assigned to ${name(owner)}${owner !== ctx.godId && wasActive ? ', who has been told to stop' : ''})` : ''}. Keep the card in "cancelled" and do not dispatch it again; it stays on the board as history.`
      + (owner === ctx.godId ? ' It was yours: stop working on it.' : ''));
  } else if (reopened) {
    godLines.push(`The human reopened the cancelled task ${handle} ${title}: it is "${String(after.status)}" again.${newOwner ? ` Owner: ${name(newOwner)}; dispatch it to them again if it needs work.` : ' It has no owner; pick one if it needs work.'}`);
  }

  if (reassigned && !cancelled) {
    if (owner && owner !== ctx.godId && wasActive) {
      out.push({
        to: owner,
        subject: `Task reassigned: ${label}`,
        body: `The human reassigned task ${handle} ${title} ${newOwner ? `to ${name(newOwner)}` : 'away from you (it has no owner now)'}. It is no longer yours. ${stop}`
      });
    }
    godLines.push(newOwner
      ? `The human reassigned task ${handle} ${title} from ${owner ? name(owner) : 'nobody'} to ${name(newOwner)}.${newOwner === ctx.godId ? ' It is yours now.' : ' Dispatch it to them with the card as the brief.'}`
        + (owner && owner !== ctx.godId && wasActive ? ` ${name(owner)} has been told to stop.` : '')
      : `The human unassigned task ${handle} ${title}${owner ? ` (it was ${name(owner)}'s${owner !== ctx.godId && wasActive ? ', who has been told to stop' : ''})` : ''}. It waits for an owner.`);
  }

  if (changed.length && !cancelled) {
    const what = changed.map((k) => (k === 'ticket' ? `ticket: ${str(after.ticket) ?? '(generated key)'}` : k === 'parent' ? `parent: ${str(after.parent) ?? '(none)'}` : k)).join(', ');
    // The owner gets the new contract (the old one may be what it is building).
    // A new owner hears it from god's dispatch instead.
    if (contractChanged && !reassigned && owner && owner !== ctx.godId && isActiveStatus(after.status)) {
      out.push({
        to: owner,
        subject: `Task changed: ${label}`,
        body: `The human edited task ${handle}, which is yours. Follow the card as it is now:\n\nTitle: ${String(after.title ?? '')}\n\nDescription:\n${str(after.description) ?? '(none)'}\n\nNo reply needed unless the change stops you.`
      });
    }
    godLines.push(`The human edited task ${handle} ${title} (${what}). Keep these changes when you write tasks.json.`);
  }

  if (godLines.length) out.push({ to: ctx.godId, subject: `Task changed by the human: ${label}`, body: godLines.join('\n') });
  return out;
}

/** One notice per recipient: several changes to one agent (a parent cancelled
 *  with its subtasks) arrive as one message, not a burst. */
export function mergeTaskNotices(notices: readonly TaskNotice[]): TaskNotice[] {
  const by = new Map<string, TaskNotice[]>();
  for (const n of notices) by.set(n.to, [...(by.get(n.to) ?? []), n]);
  return [...by.entries()].map(([to, list]) => (list.length === 1 ? list[0] : {
    to,
    subject: `${list.length} task changes from the human: ${list.map((n) => n.subject.replace(/^[^:]*:\s*/, '').split(' ')[0]).join(', ')}`,
    body: list.map((n) => `## ${n.subject}\n${n.body}`).join('\n\n')
  }));
}
