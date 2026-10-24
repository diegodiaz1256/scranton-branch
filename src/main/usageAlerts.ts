import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { RateLimits } from '../shared/rateLimits';
import {
  decideUsageAlerts,
  liveMarks,
  usageNoticeBody,
  usageNoticeSubject,
  type ActiveUsageAlert,
  type AlertMarks,
  type AlertWindow,
  type UsageAlertThresholds
} from '../shared/usageWindowAlerts';

/**
 * The usage-window notices (shared/usageWindowAlerts.ts) wired to an office:
 * which agents hear them, how they are sent, and the file that remembers what
 * was already said (`usage-alerts.json` in the hive root, gitignored), so a
 * restart does not repeat a notice for the same window.
 *
 * Keyed by provider: the app has one account per engine in an office (every
 * Claude agent of a floor runs on the same login), and only the engines whose
 * status line reports windows (Claude today) ever feed it.
 */

export const USAGE_ALERTS_FILE = 'usage-alerts.json';

export interface UsageAlertTarget { id: string; orchestrator: boolean }

export interface UsageAlertDeps {
  root: () => string | null;
  thresholds: () => UsageAlertThresholds;
  /** Live agents on this provider's account, plus the orchestrator (always). */
  targets: (provider: string) => UsageAlertTarget[];
  /** The account's display name ("Claude Code"). */
  accountName: (provider: string) => string;
  send: (to: string, subject: string, body: string) => void;
  onChange?: (alerts: ActiveUsageAlert[]) => void;
}

type MarkFile = Record<string, AlertMarks>;

export class UsageAlertMonitor {
  private loadedFor: string | null = null;
  private marks: MarkFile = {};

  constructor(private deps: UsageAlertDeps) {}

  private file(root: string): string { return join(root, USAGE_ALERTS_FILE); }

  /** The marks of the office now open (re-read when the office changes). */
  private load(): string | null {
    const root = this.deps.root();
    if (!root) return null;
    if (this.loadedFor !== root) {
      this.loadedFor = root;
      this.marks = {};
      try {
        const fp = this.file(root);
        if (existsSync(fp)) {
          const raw = JSON.parse(readFileSync(fp, 'utf8')) as unknown;
          if (raw && typeof raw === 'object') this.marks = raw as MarkFile;
        }
      } catch { /* unreadable: start clean */ }
    }
    return root;
  }

  private save(root: string): void {
    try { writeFileSync(this.file(root), JSON.stringify(this.marks, null, 2), 'utf8'); } catch (e) {
      console.error('[usage-alerts] could not save marks:', e);
    }
  }

  /** A status reading from an agent on `provider`: notify on a crossing. */
  observe(provider: string, rl: RateLimits, now = Date.now()): void {
    const root = this.load();
    if (!root) return;
    const { notices, marks, changed } = decideUsageAlerts(rl, this.marks[provider] ?? {}, this.deps.thresholds(), now);
    if (!changed) return;
    this.marks[provider] = marks;
    // Saved before sending: a crash mid-send must not repeat the notice later.
    this.save(root);
    if (notices.length) {
      const account = this.deps.accountName(provider);
      for (const t of this.deps.targets(provider)) {
        for (const n of notices) {
          try {
            this.deps.send(t.id, usageNoticeSubject(n, account), usageNoticeBody(n, { account, orchestrator: t.orchestrator, now }));
          } catch (e) { console.error('[usage-alerts] send failed:', e); }
        }
      }
    }
    this.deps.onChange?.(this.active(now));
  }

  /** The windows over their threshold right now, across providers. */
  active(now = Date.now()): ActiveUsageAlert[] {
    if (!this.load()) return [];
    const out: ActiveUsageAlert[] = [];
    for (const [provider, m] of Object.entries(this.marks)) {
      const live = liveMarks(m ?? {}, now);
      for (const w of ['fiveHour', 'sevenDay'] as AlertWindow[]) {
        const mark = live[w];
        if (mark) out.push({ provider, window: w, level: mark.level, pct: mark.pct, ...(mark.resetsAt ? { resetsAt: mark.resetsAt } : {}) });
      }
    }
    return out;
  }
}
