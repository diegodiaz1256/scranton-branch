/**
 * Per-agent anonymization counter and log: which codenames an agent's model
 * calls carried, of what category, and when. NEVER the real values: only the
 * placeholder (what the model saw) is kept, so the log itself is safe to show
 * and to leave in memory.
 *
 * Pure: no electron, no node.
 */
import type { AnonCategory, TermCategory } from './anonymize';

export interface AnonLogRow {
  /** The codename / placeholder the model saw. */
  codename: string;
  category: AnonCategory;
  /** For dictionary terms: its category (person, system…). */
  term?: TermCategory;
  /** Substitutions with it (every request counts: a conversation resends its history). */
  count: number;
  firstAt: number;
  lastAt: number;
}

export interface AnonAgentActivity {
  /** Substitutions in all its requests. */
  total: number;
  /** Requests that had at least one. */
  requests: number;
  lastAt: number | null;
  /** By codename, most recent first. */
  rows: AnonLogRow[];
}

/** What a placeholder family is, for the log. */
export function categoryOfFamily(family: string): { category: AnonCategory; term?: TermCategory } {
  if (family === 'email') return { category: 'email' };
  if (family === 'host') return { category: 'domain' };
  if (family === 'ip') return { category: 'ipv4' };
  if (family === 'ticket') return { category: 'ticket' };
  if (family.startsWith('term:')) return { category: 'term', term: family.slice(5) as TermCategory };
  return { category: 'secret' };
}

const MAX_ROWS = 300;

export class AnonActivityLog {
  private agents = new Map<string, { total: number; requests: number; lastAt: number | null; rows: Map<string, AnonLogRow> }>();

  /** One request's substitutions: family + placeholder for each. */
  record(agentId: string, subs: Array<{ family: string; placeholder: string }>, now = Date.now()): void {
    if (!subs.length) return;
    let a = this.agents.get(agentId);
    if (!a) { a = { total: 0, requests: 0, lastAt: null, rows: new Map() }; this.agents.set(agentId, a); }
    a.total += subs.length;
    a.requests += 1;
    a.lastAt = now;
    for (const s of subs) {
      const row = a.rows.get(s.placeholder);
      if (row) { row.count += 1; row.lastAt = now; continue; }
      const c = categoryOfFamily(s.family);
      a.rows.set(s.placeholder, { codename: s.placeholder, category: c.category, ...(c.term ? { term: c.term } : {}), count: 1, firstAt: now, lastAt: now });
    }
    if (a.rows.size > MAX_ROWS) {
      const keep = [...a.rows.values()].sort((x, y) => y.lastAt - x.lastAt).slice(0, MAX_ROWS);
      a.rows = new Map(keep.map((r) => [r.codename, r]));
    }
  }

  get(agentId: string): AnonAgentActivity {
    const a = this.agents.get(agentId);
    if (!a) return { total: 0, requests: 0, lastAt: null, rows: [] };
    return { total: a.total, requests: a.requests, lastAt: a.lastAt, rows: [...a.rows.values()].sort((x, y) => y.lastAt - x.lastAt).map((r) => ({ ...r })) };
  }
}
