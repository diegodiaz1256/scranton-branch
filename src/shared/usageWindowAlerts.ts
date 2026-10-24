import { untilReset, type RateLimits } from './rateLimits';

/**
 * Telling agents that a subscription usage window is nearly spent.
 *
 * The windows come from the agents' status line (shared/rateLimits.ts). When
 * the 5-hour window passes its threshold (95% by default) or the week passes
 * its own (98%), every live agent on that account gets ONE inbox notice, and
 * the orchestrator is also told to stop dispatching. Hitting 100% earns a
 * second notice. After that the window stays quiet until it resets (its
 * `resetsAt` passes or a new window starts) or its use drops back under the
 * threshold by REARM_MARGIN points, so a reading that wobbles around the line
 * does not notify on every tick. The marks are persisted by the caller, so a
 * restart does not repeat a notice either.
 */

export type AlertWindow = 'fiveHour' | 'sevenDay';
export type AlertLevel = 'near' | 'limit';

export interface UsageAlertThresholds { fiveHourPct: number; weeklyPct: number }
export const DEFAULT_USAGE_ALERT_THRESHOLDS: UsageAlertThresholds = { fiveHourPct: 95, weeklyPct: 98 };

/** Points under the threshold a window must fall to before it can notify again. */
export const REARM_MARGIN = 3;
/** Two readings whose reset times differ by more than this are different windows. */
export const NEW_WINDOW_SLACK_MS = 30 * 60_000;

/** What was already said about one window. */
export interface WindowAlertMark { level: AlertLevel; pct: number; resetsAt?: number; at: number }
export type AlertMarks = Partial<Record<AlertWindow, WindowAlertMark>>;

/** A window currently over its threshold, for the title-bar chip. */
export interface ActiveUsageAlert { provider: string; window: AlertWindow; level: AlertLevel; pct: number; resetsAt?: number }

export interface UsageNotice { window: AlertWindow; level: AlertLevel; pct: number; threshold: number; resetsAt?: number }

const WINDOWS: AlertWindow[] = ['fiveHour', 'sevenDay'];

/** Thresholds from config: whole percents from 1 to 100, defaults when unset or invalid. */
export function normalizeThresholds(raw?: Partial<UsageAlertThresholds> | null): UsageAlertThresholds {
  const pick = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(100, Math.max(1, Math.round(v))) : d;
  return {
    fiveHourPct: pick(raw?.fiveHourPct, DEFAULT_USAGE_ALERT_THRESHOLDS.fiveHourPct),
    weeklyPct: pick(raw?.weeklyPct, DEFAULT_USAGE_ALERT_THRESHOLDS.weeklyPct)
  };
}

export function thresholdFor(w: AlertWindow, th: UsageAlertThresholds): number {
  return w === 'fiveHour' ? th.fiveHourPct : th.weeklyPct;
}

/** Marks whose window has reset by `now` are dropped. */
export function liveMarks(marks: AlertMarks, now: number): AlertMarks {
  const out: AlertMarks = {};
  for (const w of WINDOWS) {
    const m = marks[w];
    if (m && !(m.resetsAt && m.resetsAt <= now)) out[w] = m;
  }
  return out;
}

/**
 * The notices one reading calls for, and the marks to keep afterwards.
 * `changed` is true when the marks differ from the ones passed in (so the
 * caller only writes its file when it has to).
 */
export function decideUsageAlerts(
  rl: RateLimits,
  marks: AlertMarks,
  th: UsageAlertThresholds,
  now: number
): { notices: UsageNotice[]; marks: AlertMarks; changed: boolean } {
  const notices: UsageNotice[] = [];
  const next: AlertMarks = {};
  let changed = false;
  for (const w of WINDOWS) {
    let mark = marks[w];
    const data = rl[w];
    const threshold = thresholdFor(w, th);
    // The window this mark was for has reset.
    if (mark?.resetsAt && mark.resetsAt <= now) mark = undefined;
    if (mark && data) {
      // A new window started (its reset time moved on).
      if (data.resetsAt && mark.resetsAt && Math.abs(data.resetsAt - mark.resetsAt) > NEW_WINDOW_SLACK_MS) mark = undefined;
      // Use fell well back under the line (a raised threshold, or a correction).
      else if (data.pct < threshold - REARM_MARGIN) mark = undefined;
    }
    if (data) {
      const level: AlertLevel | null = data.pct >= 100 ? 'limit' : data.pct >= threshold ? 'near' : null;
      if (level && (!mark || (level === 'limit' && mark.level === 'near'))) {
        const resetsAt = data.resetsAt ?? mark?.resetsAt;
        notices.push({ window: w, level, pct: data.pct, threshold, ...(resetsAt ? { resetsAt } : {}) });
        mark = { level, pct: data.pct, ...(resetsAt ? { resetsAt } : {}), at: now };
      }
    }
    if (mark) next[w] = mark;
    if (mark !== marks[w]) changed = true;
  }
  return { notices, marks: next, changed };
}

const WINDOW_NAME: Record<AlertWindow, string> = { fiveHour: '5-hour', sevenDay: 'weekly' };

/** The inbox subject for a notice. */
export function usageNoticeSubject(n: UsageNotice, account: string): string {
  const pct = Math.round(n.pct);
  return n.level === 'limit'
    ? `Usage limit reached: ${account} ${WINDOW_NAME[n.window]} window at ${pct}%`
    : `Usage window nearly spent: ${account} ${WINDOW_NAME[n.window]} window at ${pct}%`;
}

/** The inbox body for a notice; the orchestrator's carries the dispatch advice. */
export function usageNoticeBody(n: UsageNotice, opts: { account: string; orchestrator: boolean; now: number }): string {
  const pct = Math.round(n.pct);
  const name = WINDOW_NAME[n.window];
  const reset = n.resetsAt
    ? `It resets at ${new Date(n.resetsAt).toISOString()} (in ${untilReset(n.resetsAt, opts.now)}).`
    : 'Its reset time was not reported.';
  const lines = [
    n.level === 'limit'
      ? `The ${opts.account} subscription has used ${pct}% of its ${name} usage window: the limit is reached, and requests may be refused until it resets.`
      : `The ${opts.account} subscription has used ${pct}% of its ${name} usage window (this office warns at ${n.threshold}%).`,
    reset,
    '',
    'What to do now:',
    '- Finish the step you are on; do not start large new tasks.',
    '- Commit or save your work, and write partial results to files so nothing is lost if you are cut off.',
    '- Write a short handoff note (in your memory.md or the task card): what is done, what is left, where the files are.',
    '- Prefer cheap actions: short replies, no broad searches or re-reading large files.'
  ];
  if (opts.orchestrator) {
    lines.push(
      '',
      'You are the orchestrator, so also:',
      '- Stop dispatching new workers and temps on this account until the window resets.',
      '- Pause non-urgent work; keep only what is urgent moving, and tell the human if a deadline is at risk.'
    );
  }
  lines.push('', 'This is an automatic notice (protocol/usage-windows.md). No reply is needed.');
  return lines.join('\n');
}
