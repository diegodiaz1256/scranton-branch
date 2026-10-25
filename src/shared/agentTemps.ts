/**
 * Temps started by any lasting agent, not only the orchestrator.
 *
 * A lasting agent writes a spawn request into its OWN folder
 * (`agents/<id>/spawn-requests/`), the same file shape the orchestrator writes
 * into the hive root. Main starts the temp if the human gave that agent temps
 * ("Temps per agent", 0-4, default 0 = off) and the office has a free desk
 * ("Max temps at once"); the temp's done, failures and refusals go back to the
 * agent that asked. The temp never gets more than its parent: the parent's own
 * restrictions are copied onto it, and the grants that widen an agent (roam,
 * no sandbox, SSH, cloud logins, a critical connection) are never copied.
 *
 * The triggers' "who answers" pickers can also name a temp: `temp` (a plain
 * one) or `temp:<agent id>` (a temp cloned from that agent: its engine, role
 * and access, one job, archived when done).
 *
 * Pure: main applies the decisions, tests exercise them here.
 */
import type { Access } from './connectionAccess';

/** The most temps the human can give one agent at once. */
export const TEMP_QUOTA_MAX = 4;
/** "Max temps at once" for the office, as Settings and voice bound it. */
export const MAX_TEMPS_AT_ONCE = 16;
/** Default "Max temps at once" (config.maxConcurrentWorkers). */
export const DEFAULT_TEMPS_AT_ONCE = 4;

/** A per-agent quota as stored: an integer 0..TEMP_QUOTA_MAX, anything else 0. */
export function clampTempQuota(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(TEMP_QUOTA_MAX, Math.floor(n));
}

/** How many temps `agentId` may have at once (0 = it may not start any). */
export function tempQuotaOf(quotas: Record<string, number> | undefined, agentId: string): number {
  return clampTempQuota(quotas?.[agentId]);
}

/** The office cap as stored (config.maxConcurrentWorkers), clamped. */
export function tempsAtOnce(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : DEFAULT_TEMPS_AT_ONCE;
  return Math.max(1, Math.min(MAX_TEMPS_AT_ONCE, n));
}

/** What the decision needs to know about the agent asking. */
export interface TempRequester {
  id: string;
  /** Not in the registry at all. */
  missing?: boolean;
  isGod?: boolean;
  archived?: boolean;
  /** It is a temp itself. */
  temp?: boolean;
  /** It holds a critical connection (shared/criticalConnections.ts). */
  custodian?: boolean;
}

/**
 * Why `who` may not start a temp now, or null when it may. Every reason is
 * written to the agent itself: it lands in its inbox as the refusal.
 */
export function agentTempProblem(who: TempRequester, quota: number, mineRunning: number, officeRunning: number, officeMax: number): string | null {
  if (who.missing) return `there is no agent "${who.id}" in this office`;
  if (who.isGod) return 'the orchestrator starts temps through the hive\'s spawn-requests/ folder, not its own';
  if (who.archived) return 'you are archived';
  if (who.temp) return 'a temp cannot start temps of its own: send what you need to the agent that started you';
  if (who.custodian) return 'you hold a critical connection, and a custodian never starts temps (nothing it holds may leave through one)';
  if (quota <= 0) return 'the human has not allowed you to start temps (your "Temps per agent" is 0, in Settings → Autonomy & limits). Ask the human, or do the work yourself';
  if (mineRunning >= quota) return `you already have ${mineRunning} temp${mineRunning === 1 ? '' : 's'} running and your limit is ${quota} at once. Wait for one to send its done, or archive one you no longer need`;
  if (officeRunning >= officeMax) return `every temp desk in the office is taken (${officeRunning} of ${officeMax} at once). Try again once one finishes, or do the work yourself`;
  return null;
}

// ─── "Who answers": a temp as a trigger's target ────────────────────────────

/** A plain temp answers. */
export const TEMP_TARGET = 'temp';
/** `temp:<agent id>`: a temp cloned from that agent answers. */
export const TEMP_CLONE_PREFIX = 'temp:';

export type Answerer =
  | { kind: 'temp' }
  | { kind: 'clone'; of: string }
  | { kind: 'agent'; id: string };

export function cloneTarget(agentId: string): string {
  return `${TEMP_CLONE_PREFIX}${agentId}`;
}

/** Read a stored target ('god', an agent id, 'broadcast', 'temp', 'temp:<id>'). */
export function parseAnswerer(to: string | undefined | null): Answerer {
  const v = typeof to === 'string' ? to.trim() : '';
  if (v === TEMP_TARGET) return { kind: 'temp' };
  if (v.startsWith(TEMP_CLONE_PREFIX) && v.length > TEMP_CLONE_PREFIX.length) return { kind: 'clone', of: v.slice(TEMP_CLONE_PREFIX.length) };
  return { kind: 'agent', id: v || 'god' };
}

export function isTempTarget(to: string | undefined | null): boolean {
  return parseAnswerer(to).kind !== 'agent';
}

/** Why agent `a` cannot be cloned into a temp, or null when it can. */
export function cloneProblem(a: { id: string; isGod?: boolean; temp?: unknown } | undefined, custodian: boolean): string | null {
  if (!a) return 'that agent is no longer in the office';
  if (a.isGod) return 'the orchestrator cannot be cloned into a temp';
  if (a.temp) return 'a temp cannot be cloned';
  if (custodian) return `${a.id} holds a critical connection, and a custodian is never cloned`;
  return null;
}

// ─── A temp gets at most its parent's access ────────────────────────────────

/** The per-agent parts of the config that decide what an agent may reach. */
export interface AccessConfig {
  agentMcpGrants?: Record<string, string[]>;
  agentMcpAccess?: Record<string, Record<string, Access>>;
  agentToolBlocks?: Record<string, string[]>;
  connectionScopes?: Record<string, string[]>;
  integrationScopes?: Record<string, string[]>;
  envVars?: Array<{ agents?: string[] | null } & Record<string, unknown>>;
  customMcp?: Array<{ agents: string[] | null } & Record<string, unknown>>;
  agentRoam?: string[];
  agentUnsandboxed?: string[];
  agentSshRelay?: Record<string, unknown>;
  agentCloudCredentials?: Record<string, string[]>;
  criticalCustodians?: Record<string, string>;
}

const withId = (list: string[], id: string): string[] => (list.includes(id) ? list : [...list, id]);
const withoutId = (list: string[], id: string): string[] => list.filter((x) => x !== id);

/**
 * The config patch that gives temp `tempId` the parent's restrictions:
 * its MCP grant, access levels and blocked tools are copied, and it joins every
 * "only these agents" list the parent is on (and no other). Absent entries mean
 * the default, which the parent has too. Never copied: writing outside its
 * folders, running without a sandbox, SSH keys, cloud logins and custodianship.
 * Any of those already naming `tempId` (a reused id) is taken away.
 */
export function inheritedAccess(cfg: AccessConfig, parentId: string, tempId: string): AccessConfig {
  const patch: AccessConfig = withoutAccess(cfg, tempId);
  const grants = { ...(patch.agentMcpGrants ?? cfg.agentMcpGrants ?? {}) };
  if (cfg.agentMcpGrants?.[parentId]) grants[tempId] = [...cfg.agentMcpGrants[parentId]];
  const access = { ...(patch.agentMcpAccess ?? cfg.agentMcpAccess ?? {}) };
  if (cfg.agentMcpAccess?.[parentId]) access[tempId] = { ...cfg.agentMcpAccess[parentId] };
  const blocks = { ...(patch.agentToolBlocks ?? cfg.agentToolBlocks ?? {}) };
  if (cfg.agentToolBlocks?.[parentId]) blocks[tempId] = [...cfg.agentToolBlocks[parentId]];
  const scoped = (m: Record<string, string[]> | undefined): Record<string, string[]> =>
    Object.fromEntries(Object.entries(m ?? {}).map(([k, ids]) => [k, ids.includes(parentId) ? withId(ids, tempId) : ids]));
  patch.agentMcpGrants = grants;
  patch.agentMcpAccess = access;
  patch.agentToolBlocks = blocks;
  patch.connectionScopes = scoped(patch.connectionScopes ?? cfg.connectionScopes);
  patch.integrationScopes = scoped(patch.integrationScopes ?? cfg.integrationScopes);
  patch.envVars = (patch.envVars ?? cfg.envVars ?? []).map((v) => (Array.isArray(v.agents) && v.agents.includes(parentId) ? { ...v, agents: withId(v.agents, tempId) } : v));
  patch.customMcp = (patch.customMcp ?? cfg.customMcp ?? []).map((m) => (Array.isArray(m.agents) && m.agents.includes(parentId) ? { ...m, agents: withId(m.agents, tempId) } : m));
  return patch;
}

/** Only the keys of `patch` that differ from `cfg` (absent and empty count as
 *  the same), so applying a no-op leaves the config file alone. */
export function changedAccess(cfg: AccessConfig, patch: AccessConfig): AccessConfig {
  const out: AccessConfig = {};
  const empty = (v: unknown): boolean => v === undefined || (Array.isArray(v) ? v.length === 0 : typeof v === 'object' && v !== null && Object.keys(v).length === 0);
  for (const k of Object.keys(patch) as Array<keyof AccessConfig>) {
    const a = cfg[k];
    const b = patch[k];
    if ((empty(a) && empty(b)) || JSON.stringify(a) === JSON.stringify(b)) continue;
    (out as Record<string, unknown>)[k] = b;
  }
  return out;
}

/** The config patch that forgets every per-agent entry for `id` (a finished
 *  temp), including any grant that would widen it. */
export function withoutAccess(cfg: AccessConfig, id: string): AccessConfig {
  const drop = <T>(m: Record<string, T> | undefined): Record<string, T> => {
    const out = { ...(m ?? {}) };
    delete out[id];
    return out;
  };
  return {
    agentMcpGrants: drop(cfg.agentMcpGrants),
    agentMcpAccess: drop(cfg.agentMcpAccess),
    agentToolBlocks: drop(cfg.agentToolBlocks),
    connectionScopes: Object.fromEntries(Object.entries(cfg.connectionScopes ?? {}).map(([k, ids]) => [k, withoutId(ids, id)])),
    integrationScopes: Object.fromEntries(Object.entries(cfg.integrationScopes ?? {}).map(([k, ids]) => [k, withoutId(ids, id)])),
    envVars: (cfg.envVars ?? []).map((v) => (Array.isArray(v.agents) && v.agents.includes(id) ? { ...v, agents: withoutId(v.agents, id) } : v)),
    customMcp: (cfg.customMcp ?? []).map((m) => (Array.isArray(m.agents) && m.agents.includes(id) ? { ...m, agents: withoutId(m.agents, id) } : m)),
    agentRoam: withoutId(cfg.agentRoam ?? [], id),
    agentUnsandboxed: withoutId(cfg.agentUnsandboxed ?? [], id),
    agentSshRelay: drop(cfg.agentSshRelay),
    agentCloudCredentials: drop(cfg.agentCloudCredentials),
    criticalCustodians: Object.fromEntries(Object.entries(cfg.criticalCustodians ?? {}).map(([k, who]) => [k, who === id ? '' : who]))
  };
}
