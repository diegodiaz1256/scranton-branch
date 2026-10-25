import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { messageBody } from '../shared/messageBody';
import type { Registry, TempHiring } from './hive';

/** When a message counts as authored, for the done scan — or null when it can't
 *  be shown to postdate `since`.
 *
 *  `created_at` is written by the agent, with the agent's clock and in whatever
 *  shape its tool produced. On a WSL floor that is a Linux clock in the distro's
 *  timezone: a stamp without an offset (`2026-10-24T09:00:00`) is read by main in
 *  the WINDOWS timezone, and a distro clock that drifted after sleep lags the
 *  host. Either puts a fresh done "before" the worker spawned, and the worker
 *  was never released (seen live: a finished temp stayed on the roster 3 days).
 *  So a `created_at` that is missing, unparseable OR older than `since` falls
 *  back to the file's mtime, which the filesystem stamps (and a rename into
 *  outbox/.sent keeps). A done left by a PRIOR worker under a reused id is old
 *  by both measures, so the stale-done guard still holds. */
export function authoredAfter(createdAt: unknown, mtimeMs: number, since: number): number | null {
  const ts = Date.parse(typeof createdAt === 'string' ? createdAt : '');
  if (Number.isFinite(ts) && ts > since) return ts;
  if (Number.isFinite(mtimeMs) && mtimeMs > since) return mtimeMs;
  return null;
}

/** The newest `act:"done"` in an agent's outbox (and outbox/.sent, where the
 *  router archives delivered mail) authored after `since`, or null. */
export function latestDone(agentDir: string, since: number): { at: number; text: string; to: string } | null {
  const base = join(agentDir, 'outbox');
  let best: { at: number; text: string; to: string } | null = null;
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>;
        if (msg.act !== 'done') continue;
        let mtime = NaN;
        try { mtime = statSync(fp).mtimeMs; } catch { /* keep NaN */ }
        const at = authoredAfter(msg.created_at, mtime, since);
        if (at === null || (best && at <= best.at)) continue;
        best = { at, text: messageBody(msg) || (typeof msg.subject === 'string' ? msg.subject : ''), to: typeof msg.to === 'string' ? msg.to : '' };
      } catch { /* skip unreadable/partial */ }
    }
  }
  return best;
}

/** Why `requester` may NOT archive agent `id` through archive-requests, or
 *  null when it may: only a temp it started itself. `requester` unset is the
 *  orchestrator (the hive's archive-requests/), which owns the temps it hired
 *  and the ones a trigger started for it; any other agent (its own
 *  archive-requests/) owns only the temps it started. Permanent staff, the
 *  requester itself, a temp the human hired and anyone else's temp are refused. */
export function archiveRequestProblem(reg: Registry, id: string, requester?: string): string | null {
  if (!id) return 'missing "id"';
  const a = reg.agents[id];
  if (!a) return `there is no agent "${id}"`;
  if (requester ? id === requester : (id === reg.godId || a.isGod)) return 'you cannot archive yourself';
  if (!a.temp) return `"${id}" is not a temp: only a temp you started through spawn-requests can be archived this way (ask the human about anyone else)`;
  if (a.temp.hiredBy === 'human') return `"${id}" was hired by the human, so it is theirs to stop`;
  const parent = a.temp.hiredBy === 'agent' ? a.temp.parent : undefined;
  if (requester) return parent === requester ? null : `"${id}" was not started by you: you may archive only the temps you started`;
  if (parent) return `"${id}" was started by ${reg.agents[parent]?.name ?? parent}, so it is theirs to archive`;
  return null;
}

/** Hirings for temps started before the hiring was persisted: an app restart
 *  turned those into permanent agents nothing ever released. Their spawn-request
 *  is still filed under spawn-requests/.done/, so rebuild each `worker-<reqId>`
 *  not yet marked from it. The request file was written just before the spawn,
 *  so its mtime stands in for the hiring time (a done written after it counts).
 *  Human hires (Temps) carry a `temp-` request id. */
export function legacyTemps(reg: Registry, doneDir: string): Record<string, TempHiring> {
  const out: Record<string, TempHiring> = {};
  let files: string[] = [];
  try { files = readdirSync(doneDir).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const fp = join(doneDir, f);
    try {
      const raw = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>;
      // Same id rule as processSpawnRequest.
      const reqId = (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : f.replace(/\.json$/i, ''))
        .replace(/[^A-Za-z0-9._-]/g, '-');
      const id = `worker-${reqId}`;
      const agent = reg.agents[id];
      if (!agent || agent.temp || agent.isGod) continue;
      const spawnedAt = statSync(fp).mtimeMs;
      if (out[id] && out[id].spawnedAt >= spawnedAt) continue; // newest hiring wins
      const slack = raw.slack as { channel?: unknown; thread_ts?: unknown } | undefined;
      out[id] = {
        reqId,
        spawnedAt,
        baseBranch: 'main',
        objective: typeof raw.objective === 'string' ? raw.objective.trim() : undefined,
        tokenCap: typeof raw.tokenCap === 'number' && raw.tokenCap > 0 ? raw.tokenCap : undefined,
        slack: slack && typeof slack.channel === 'string' && typeof slack.thread_ts === 'string'
          ? { channel: slack.channel, thread_ts: slack.thread_ts } : undefined,
        hiredBy: reqId.startsWith('temp-') ? 'human' : 'orchestrator'
      };
    } catch { /* unreadable request: leave that agent as it is */ }
  }
  return out;
}
