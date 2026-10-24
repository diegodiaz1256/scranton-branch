/**
 * Usage and activity an agent reports through the HOOK plane, for the engines
 * that never push Claude's OTel telemetry (Pi, OpenCode, the proxy-bridged CLIs).
 *
 * Their bridges post one `CostSample` per model response: an INCREMENT. The cost
 * ledger, though, holds a running TOTAL per (agent, session) — that is what
 * Claude's live path appends and what the lifetime fold in costLifetime.ts reads
 * (a decrease means "the app restarted"). Writing increments made the fold keep
 * only the biggest single response. So increments are summed here per session and
 * the ledger gets the running total, exactly like Claude's rows.
 *
 * The same tracker remembers when each agent last did anything and which tool it
 * last used, from any hook event, so fleet.json has a "last seen" and a "last
 * tool" for every engine with a hook bridge, not only for Claude's OTel spans.
 *
 * Memory only. An app restart starts every counter at zero, which the ledger fold
 * already handles; the lifetime figure lives in the ledger, not here.
 */

export interface HookCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  usd: number;
  model: string;
}

/** Running totals, shaped like a cost-ledger row / AgentUsageSample. */
export interface HookUsageTotals extends HookCost {
  agentId: string;
  sessionId: string;
  ts: number;
}

export interface HookActivity {
  ts: number;
  lastTool: string | null;
}

/** Events that say nothing about the agent doing work: the status-line tick
 *  (it repaints on its own) and the "waiting for you" notification. */
const NOT_ACTIVITY = new Set(['Status', 'Notification', 'Unknown']);

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export class HookUsageTracker {
  /** `agentId \t sessionId` → that session's running totals. */
  private readonly sessions = new Map<string, HookUsageTotals>();
  private readonly activity = new Map<string, HookActivity>();

  /** Add one response's usage; returns the session's running totals (the row
   *  the cost ledger wants). */
  addCost(agentId: string, sessionId: string, c: Partial<HookCost>, ts = Date.now()): HookUsageTotals {
    const key = `${agentId}\t${sessionId}`;
    const t = this.sessions.get(key) ?? {
      agentId, sessionId, ts, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, usd: 0, model: ''
    };
    t.input += num(c.input);
    t.output += num(c.output);
    t.cacheRead += num(c.cacheRead);
    t.cacheCreation += num(c.cacheCreation);
    t.usd += num(c.usd);
    if (c.model) t.model = c.model;
    t.ts = ts;
    this.sessions.set(key, t);
    return { ...t };
  }

  /** Note that a hook event arrived for an agent. */
  noteEvent(agentId: string, event: string, tool?: unknown, ts = Date.now()): void {
    if (NOT_ACTIVITY.has(event)) return;
    const prev = this.activity.get(agentId);
    const isTool = (event === 'PreToolUse' || event === 'PostToolUse') && typeof tool === 'string' && tool;
    this.activity.set(agentId, { ts, lastTool: isTool ? (tool as string) : prev?.lastTool ?? null });
  }

  /** Everything this agent reported since the app started, summed over its
   *  sessions (sessionId/model = the latest). Null when it reported nothing. */
  usageFor(agentId: string): HookUsageTotals | null {
    let out: HookUsageTotals | null = null;
    for (const t of this.sessions.values()) {
      if (t.agentId !== agentId) continue;
      if (!out) { out = { ...t }; continue; }
      out.input += t.input;
      out.output += t.output;
      out.cacheRead += t.cacheRead;
      out.cacheCreation += t.cacheCreation;
      out.usd += t.usd;
      if (t.ts >= out.ts) { out.ts = t.ts; out.sessionId = t.sessionId; out.model = t.model; }
    }
    return out;
  }

  activityFor(agentId: string): HookActivity | null {
    const a = this.activity.get(agentId);
    return a ? { ...a } : null;
  }
}

/** What a fleet.json entry says about an agent's usage. */
export interface FleetUsage {
  /** Tokens since the app started; null when the engine reported none. */
  tokens: number | null;
  /** Lifetime spend (from the ledger), else this run's; null when nothing was reported. */
  usd: number | null;
  sessionUsd: number | null;
  lastTool: string | null;
  lastActiveSecAgo: number | null;
}

type UsageLike = { input: number; output: number; cacheRead: number; cacheCreation: number; usd: number; ts: number };

/**
 * Merge the sources for one fleet.json entry: Claude's live OTel sample (and its
 * tool spans) first, then what the agent's hook bridge reported. `lifetimeUsd` is
 * the ledger's figure, null when the ledger has not been read yet or holds no row
 * for this agent. "Nothing reported" stays null rather than a confident 0, so a
 * reader can tell an engine that reports no usage from one that used none.
 */
export function fleetUsage(i: {
  live?: UsageLike | null;
  hook?: UsageLike | null;
  spanTool?: string | null;
  activity?: HookActivity | null;
  lifetimeUsd: number | null;
  now: number;
}): FleetUsage {
  const u = i.live ?? i.hook ?? null;
  const round = (n: number): number => Number(n.toFixed(4));
  const sessionUsd = u ? round(u.usd) : null;
  const seen = Math.max(u?.ts ?? 0, i.activity?.ts ?? 0);
  return {
    tokens: u ? u.input + u.output + u.cacheRead + u.cacheCreation : null,
    usd: i.lifetimeUsd !== null ? round(i.lifetimeUsd) : sessionUsd,
    sessionUsd,
    lastTool: i.spanTool ?? i.activity?.lastTool ?? null,
    lastActiveSecAgo: seen > 0 ? Math.max(0, Math.round((i.now - seen) / 1000)) : null
  };
}
