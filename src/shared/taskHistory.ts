/**
 * What happened to each task, as events. The orchestrator owns tasks.json and
 * rewrites it whole, so nothing recorded who moved a card where or when: the
 * board showed the present and nothing else. Main compares each read of the
 * ledger with the last one and appends the difference to the hive's
 * taskHistory.jsonl (main-only). Pure: no I/O here.
 */

export interface TaskSnapshot {
  id: string;
  title?: string;
  status?: string;
  assignee?: string;
  result?: string;
  /** '' when the card has none: an old snapshot without the key compares as
   *  unknown, so the upgrade itself doesn't read as every card edited. */
  description?: string;
  parent?: string;
  ticket?: string;
  humanQA?: Array<{ q?: string; a?: string; dismissedAt?: string }>;
}

export type TaskEvent = { ts: string; taskId: string; title: string } & (
  | { kind: 'created'; status?: string; assignee?: string }
  | { kind: 'status'; from?: string; to?: string }
  | { kind: 'assigned'; from?: string; to?: string }
  | { kind: 'asked'; q: string }
  | { kind: 'answered'; q: string; a: string }
  | { kind: 'dismissed'; q: string }
  | { kind: 'result'; text: string }
  | { kind: 'edited'; fields: string[] }
  | { kind: 'removed' }
);

const clip = (s: string, n = 400) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Events turning `prev` into `next`. `prev` null = the first read ever: the
 *  existing cards are recorded as created now, so history starts somewhere. */
export function diffTasks(prev: readonly TaskSnapshot[] | null, next: readonly TaskSnapshot[], ts: string): TaskEvent[] {
  const out: TaskEvent[] = [];
  const before = new Map((prev ?? []).map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (const t of next) {
    if (!t || typeof t.id !== 'string') continue;
    seen.add(t.id);
    const title = clip(t.title ?? t.id, 200);
    const p = before.get(t.id);
    if (!p) {
      out.push({ ts, taskId: t.id, title, kind: 'created', status: t.status, assignee: t.assignee });
      for (const qa of t.humanQA ?? []) pushQa(out, ts, t.id, title, undefined, qa);
      if (t.result) out.push({ ts, taskId: t.id, title, kind: 'result', text: clip(t.result) });
      continue;
    }
    if ((p.assignee ?? '') !== (t.assignee ?? '')) out.push({ ts, taskId: t.id, title, kind: 'assigned', from: p.assignee, to: t.assignee });
    if ((p.status ?? '') !== (t.status ?? '')) out.push({ ts, taskId: t.id, title, kind: 'status', from: p.status, to: t.status });
    const fields = (['title', 'description', 'ticket', 'parent'] as const)
      .filter((k) => typeof p[k] === 'string' && typeof t[k] === 'string' && p[k] !== t[k]);
    if (fields.length) out.push({ ts, taskId: t.id, title, kind: 'edited', fields });
    const oldQa = p.humanQA ?? [];
    (t.humanQA ?? []).forEach((qa, i) => pushQa(out, ts, t.id, title, oldQa.find((o) => o.q === qa.q) ?? oldQa[i], qa));
    if (t.result && t.result !== p.result) out.push({ ts, taskId: t.id, title, kind: 'result', text: clip(t.result) });
  }
  if (prev) {
    for (const p of prev) {
      if (!seen.has(p.id)) out.push({ ts, taskId: p.id, title: clip(p.title ?? p.id, 200), kind: 'removed' });
    }
  }
  return out;
}

function pushQa(out: TaskEvent[], ts: string, taskId: string, title: string,
  old: { q?: string; a?: string; dismissedAt?: string } | undefined, qa: { q?: string; a?: string; dismissedAt?: string }): void {
  if (typeof qa?.q !== 'string') return;
  const q = clip(qa.q);
  if (!old || old.q !== qa.q) out.push({ ts, taskId, title, kind: 'asked', q });
  if (qa.a && (!old || old.q !== qa.q || !old.a)) out.push({ ts, taskId, title, kind: 'answered', q, a: clip(qa.a) });
  else if (qa.dismissedAt && (!old || old.q !== qa.q || !old.dismissedAt)) out.push({ ts, taskId, title, kind: 'dismissed', q });
}

/** The snapshot fields worth comparing, from a raw ledger entry. */
export function snapshotOf(raw: unknown): TaskSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    id: t.id,
    title: str(t.title),
    status: str(t.status),
    assignee: str(t.assignee),
    result: str(t.result),
    description: str(t.description) ?? '',
    parent: str(t.parent) ?? '',
    ticket: str(t.ticket) ?? '',
    humanQA: Array.isArray(t.humanQA)
      ? t.humanQA.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => ({ q: str(e.q), a: str(e.a), dismissedAt: str(e.dismissedAt) }))
      : undefined
  };
}

/** When each task entered its current status (the latest status/creation
 *  event), for "doing for 2h" on a card. */
export function statusSince(events: readonly TaskEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) if (e.kind === 'status' || e.kind === 'created') m.set(e.taskId, e.ts);
  return m;
}
