/**
 * Clear on a switch of work — the pure half (main/workSwitch.ts drives it).
 *
 * The signal is the task ledger. The orchestrator is told to set a card's
 * `assignee` the moment it dispatches the work and to keep `status` current, so
 * "this agent moved on to a different card" is visible in tasks.json without
 * reading anyone's mail: the card the agent is on (`doing`) changes, or a card
 * is newly handed to it once its previous one has stopped being `doing`.
 *
 * Deliberately conservative, because the action at the end is a clear:
 *   - an agent still `doing` its previous card has not switched (it may hold two),
 *   - a parent and its own subtask are the same work, not a switch,
 *   - the first reading of the ledger only learns where everyone is.
 *
 * No I/O here.
 */
import type { TaskSnapshot } from './taskHistory';

export interface WorkSwitch {
  agentId: string;
  /** The card the agent was on. */
  from: string;
  /** The card it moved to. */
  to: string;
}

/** `doing` as the orchestrator spells it on a hand-written ledger. */
export function isDoingStatus(status: unknown): boolean {
  return typeof status === 'string' && /^(doing|in[ _-]?progress|active|wip)$/i.test(status.trim());
}

function isTodoStatus(status: unknown): boolean {
  return typeof status === 'string' && /^(todo|to[ _-]?do|queued|assigned)$/i.test(status.trim());
}

/** Two cards are the same piece of work when one is the other's subtask. */
function related(a: TaskSnapshot | undefined, b: TaskSnapshot | undefined): boolean {
  if (!a || !b) return false;
  return (!!a.parent && a.parent === b.id) || (!!b.parent && b.parent === a.id);
}

/**
 * Compare two readings of the ledger and say who switched work.
 *
 * `current` is what this function returned last time (agent id → the card it is
 * on); an agent missing from it starts from the card it was `doing` in `prev`.
 * `assigneeOf` turns a card's `assignee` into an agent id (the orchestrator may
 * write a name); unknown assignees return null and are ignored.
 *
 * Returns the new `current` map and the switches to act on.
 */
export function detectWorkSwitches(
  current: Readonly<Record<string, string>>,
  prev: readonly TaskSnapshot[] | null,
  next: readonly TaskSnapshot[],
  assigneeOf: (assignee: string) => string | null = (a) => a
): { current: Record<string, string>; switches: WorkSwitch[] } {
  const out: Record<string, string> = { ...current };
  const switches: WorkSwitch[] = [];
  const owner = (t: TaskSnapshot): string | null => (t.assignee ? assigneeOf(t.assignee) : null);
  const prevById = new Map((prev ?? []).map((t) => [t.id, t]));
  const nextById = new Map(next.map((t) => [t.id, t]));

  // Who is on what before, and after.
  const doingBefore = new Map<string, string[]>();
  for (const t of prev ?? []) {
    const who = owner(t);
    if (who && isDoingStatus(t.status)) doingBefore.set(who, [...(doingBefore.get(who) ?? []), t.id]);
  }
  const agents = new Set<string>([...Object.keys(out), ...doingBefore.keys()]);
  for (const t of next) { const who = owner(t); if (who) agents.add(who); }

  for (const agent of agents) {
    const last = out[agent] ?? doingBefore.get(agent)?.[0];
    const mine = next.filter((t) => owner(t) === agent);
    const doingNow = mine.filter((t) => isDoingStatus(t.status));
    // Still on the card it was on: nothing to do, whatever else it picked up.
    if (last && doingNow.some((t) => t.id === last)) { out[agent] = last; continue; }
    // What it moved to: a card it is now `doing` that it was not before, else a
    // card just handed to it (new, or newly its own) as its next job.
    const wasMineDoing = (id: string): boolean => {
      const p = prevById.get(id);
      return !!p && owner(p) === agent && isDoingStatus(p.status);
    };
    const wasMine = (id: string): boolean => {
      const p = prevById.get(id);
      return !!p && owner(p) === agent;
    };
    const target = doingNow.find((t) => !wasMineDoing(t.id))
      ?? (prev ? mine.find((t) => isTodoStatus(t.status) && !wasMine(t.id)) : undefined);
    if (!target) {
      // Its previous card ended while it was already on another: it held both,
      // so that one is simply what it is on now, not new work.
      if (doingNow[0]) out[agent] = doingNow[0].id;
      else if (last) out[agent] = last;
      continue;
    }
    out[agent] = target.id;
    // The first reading only learns where everyone is.
    if (!prev || !last || last === target.id) continue;
    if (related(nextById.get(last) ?? prevById.get(last), target)) continue;
    switches.push({ agentId: agent, from: last, to: target.id });
  }
  return { current: out, switches };
}

/** The 60-minute rule: a session younger than the rule's minimum is not worth
 *  clearing (its context is small, and it is the context of the work it is on). */
export function sessionOldEnough(startedAt: number | undefined, now: number, minSessionMs: number): boolean {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return false;
  return now - startedAt >= minSessionMs;
}

/** The marker every message of this flow starts with, so the queue (and a human
 *  reading it) can tell it apart from mail and from a person's message. */
export const WORK_SWITCH_HEAD = '[work switch]';

export function isWorkSwitchMessage(text: string): boolean {
  return text.trim().startsWith(WORK_SWITCH_HEAD);
}

/** What the agent is asked to write before its context is cleared. Paths are
 *  the agent's own (a WSL floor's agent gets Linux paths). */
export function handoffPrompt(handoffPath: string, fromTitle: string, toTitle: string): string {
  return [
    `${WORK_SWITCH_HEAD} You are moving from "${fromTitle}" to "${toTitle}", and your context will be cleared so the new work starts fresh.`,
    `Before that, overwrite ${handoffPath} with a short handoff note (under 40 lines, Markdown): what you were doing, where it stands, next steps, open questions, and the files you touched.`,
    'Write only the note in this turn: do not start the new work and do not move mail out of your inbox. The app clears your context once the note is written, and your next session starts from it.'
  ].join(' ');
}

/** The first message of the new session. `standingPath` is set for engines that
 *  got their hive instructions as the first prompt, which a clear discards. */
export function resumePrompt(opts: {
  handoffPath: string;
  inboxPath: string;
  toTitle: string;
  standingPath?: string;
  /** Mail the agent filed while switching (it may hold the new work order). */
  recentlyFiled?: string[];
}): string {
  const parts = [`${WORK_SWITCH_HEAD} Your context was cleared because you moved to new work ("${opts.toTitle}").`];
  if (opts.standingPath) parts.push(`First read ${opts.standingPath}: your standing instructions for this office.`);
  parts.push(`Read ${opts.handoffPath}: your own note from the previous session.`);
  parts.push(`Then read your inbox (${opts.inboxPath}) and carry on with your current task.`);
  const filed = (opts.recentlyFiled ?? []).slice(0, 8);
  if (filed.length) parts.push(`Mail you filed just before the switch, which may hold that task's work order: ${filed.join(', ')}.`);
  return parts.join(' ');
}

/** The note the app writes when the agent cannot (no hooks to tell when it is
 *  done, or it did not write one in time): from the ledger, the task's history
 *  and the end of its terminal. Honest about where it came from. */
export function fallbackHandoff(opts: {
  agentName: string;
  from: TaskSnapshot | undefined;
  fromId: string;
  to: TaskSnapshot | undefined;
  toId: string;
  history: string[];
  terminalTail: string;
  at: Date;
  reason: 'no-hooks' | 'timeout';
}): string {
  const title = (t: TaskSnapshot | undefined, id: string) => (t?.title?.trim() || id);
  const lines = [
    `# Handoff: ${title(opts.from, opts.fromId)}`,
    '',
    `_Written by the app on ${opts.at.toISOString()} for ${opts.agentName}: ${opts.reason === 'timeout'
      ? 'the agent did not write its own note in time'
      : 'this engine cannot be asked to write one'}. It is built from the task board and the terminal, so check it against the files._`,
    '',
    '## What it was doing',
    `- Task \`${opts.fromId}\`: ${title(opts.from, opts.fromId)}${opts.from?.status ? ` (now ${opts.from.status})` : ''}`
  ];
  const desc = opts.from?.description?.trim();
  if (desc) lines.push('', desc.length > 1200 ? `${desc.slice(0, 1199)}…` : desc);
  if (opts.from?.result?.trim()) lines.push('', '## Result so far', opts.from.result.trim());
  if (opts.history.length) lines.push('', '## History of the task', ...opts.history.slice(-15).map((h) => `- ${h}`));
  if (opts.terminalTail.trim()) lines.push('', '## Last lines of the terminal', '```', opts.terminalTail.trim(), '```');
  lines.push('', '## Next', `- Moved to task \`${opts.toId}\`: ${title(opts.to, opts.toId)}`, '');
  return lines.join('\n');
}
