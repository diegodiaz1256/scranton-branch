/**
 * What an agent may DO with a connection. Two levels meet:
 *
 *   ceiling  the human's cap on the connection itself (Connections). No role can
 *            exceed it. Absent = read-only: a connection that nobody configured
 *            can look but never change anything.
 *   role     what the agent's role grants for that service (Capabilities).
 *
 * The effective access is the lower of the two. The MCP gateway enforces it on
 * every tool call, whatever CLI the agent runs.
 */
export type Access = 'none' | 'read' | 'readwrite';

/** Levels a role or a ceiling can be set to by the human. */
export const ACCESS_LEVELS: Access[] = ['none', 'read', 'readwrite'];

const RANK: Record<Access, number> = { none: 0, read: 1, readwrite: 2 };

export const isAccess = (v: unknown): v is Access => v === 'none' || v === 'read' || v === 'readwrite';

export function minAccess(a: Access, b: Access): Access {
  return RANK[a] <= RANK[b] ? a : b;
}

/** A connection nobody set a ceiling on. */
export const DEFAULT_CEILING: Access = 'read';

/** An agent that has no access record (set up before roles carried access, or
 *  never given a role) keeps the connections it had, but read-only. */
export const ROLELESS_ACCESS: Access = 'read';

/**
 * The agent's effective access to one connection.
 * @param ceiling   the connection's cap (undefined → DEFAULT_CEILING)
 * @param record    the agent's access record, service → level (undefined → no record)
 * @param service   the connection's service id
 */
export function effectiveAccess(ceiling: Access | undefined, record: Record<string, Access> | undefined, service: string): Access {
  const cap = ceiling ?? DEFAULT_CEILING;
  const role = record ? (record[service] ?? 'none') : ROLELESS_ACCESS;
  return minAccess(cap, role);
}

/** Validate a service → level map; unknown levels are dropped, not repaired. */
export function cleanAccessMap(raw: unknown, validServices?: Set<string>): Record<string, Access> {
  const out: Record<string, Access> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAccess(v) && (!validServices || validServices.has(k))) out[k] = v;
  }
  return out;
}

// ─── which tools only look ───────────────────────────────────────────────────
// Fail closed: a tool counts as read-only only when we can say so. Anything we
// do not recognise is treated as a write.

interface ToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean }

/** Names that only fetch, shared by every service's server. */
const READ_NAME = /^(get|list|search|read|describe|explain|find|view|fetch|whoami|retrieve)([_-]|$)/i;

/** Per-service read-only tools that do not follow the naming rule. */
const READ_TOOLS: Record<string, RegExp> = {
  // postgres-mcp runs with --access-mode=restricted: execute_sql is read-only there.
  db: /^(execute_sql|explain_query|analyze_[a-z_]+|list_[a-z_]+|get_[a-z_]+)$/i,
  'search-with-key': /^brave_(web|local|news|image|video)_search$/i,
  // Notion's server names its tools API-<verb>-…
  notion: /^API-(get|retrieve|query|list|post-search)([_-]|$)/i
};

export function isReadTool(service: string, name: string, ann?: ToolAnnotations): boolean {
  if (ann?.destructiveHint === true) return false;
  if (ann?.readOnlyHint === true) return true;
  return READ_NAME.test(name) || !!READ_TOOLS[service]?.test(name);
}

/** The tools a `tools/list` result may show at this access level. */
export function filterTools<T extends { name?: unknown; annotations?: ToolAnnotations }>(service: string, tools: T[], access: Access): T[] {
  if (access === 'readwrite') return tools;
  if (access === 'none') return [];
  return tools.filter((t) => typeof t.name === 'string' && isReadTool(service, t.name, t.annotations));
}

// ─── why an agent has (or lacks) a connection ────────────────────────────────

export type MissingReason =
  | 'off'           // the connection is switched off
  | 'noKey'         // a required key is not stored
  | 'notChosen'     // "Choose agents" leaves this agent out
  | 'roleLacks'     // the agent's role does not include the service
  | 'webBlocked'    // Web was taken from the agent (Capabilities)
  | 'ceilingNone'   // the connection's own limit is "nothing"
  | 'critical'      // critical: another agent (or nobody yet) is its custodian
  | 'providerNoMcp';// the agent's CLI does not take MCP servers from the app

export interface ConnectionFacts {
  service: string;
  enabled: boolean;
  ready: boolean;
  /** "Choose agents" list, or null for everyone. */
  scope: string[] | null;
  /** The agent's MCP grant (role servers), or undefined when it has none. */
  grant?: string[];
  webBlocked: boolean;
  ceiling?: Access;
  record?: Record<string, Access>;
  /** The agent's CLI can use the app's MCP servers (Claude Code only, see hive.ensureAgent). */
  mcpCapable: boolean;
  /** Critical connection (criticalConnections.ts): its custodian's agent id
   *  ('' = none chosen). Absent → not critical. */
  custodian?: string;
}

/** What this agent may do with a connection, and if nothing, the first reason why
 *  (the one the human would fix first). Mirrors hive.keyedConnectionsFor. */
export function explainConnection(agentId: string, f: ConnectionFacts): { access: Access; reason?: MissingReason } {
  const none = (reason: MissingReason) => ({ access: 'none' as const, reason });
  if (!f.mcpCapable) return none('providerNoMcp');
  if (!f.enabled) return none('off');
  if (!f.ready) return none('noKey');
  if (f.custodian !== undefined && f.custodian !== agentId) return none('critical');
  if (f.scope && !f.scope.includes(agentId)) return none('notChosen');
  if (f.grant && !f.grant.includes(f.service)) return none('roleLacks');
  if (f.webBlocked) return none('webBlocked');
  const access = effectiveAccess(f.ceiling, f.record, f.service);
  if (access === 'none') return none((f.ceiling ?? DEFAULT_CEILING) === 'none' ? 'ceilingNone' : 'roleLacks');
  return { access };
}

// ─── REST APIs (Connections → REST APIs: Jira, Linear, Notion…) ──────────────
// The same two levels as connections: a ceiling per API (absent = read-only)
// and the agent's role, keyed `api:<integration id>` in its access record. A
// role that does not mention an API leaves it read-only (roles predate APIs
// having access levels, so nothing an agent had is taken away).

export const apiKey = (integrationId: string): string => `api:${integrationId}`;

export function effectiveApiAccess(ceiling: Access | undefined, record: Record<string, Access> | undefined, integrationId: string): Access {
  return minAccess(ceiling ?? DEFAULT_CEILING, record?.[apiKey(integrationId)] ?? ROLELESS_ACCESS);
}

/** Paths whose POST only reads: Jira JQL search, Notion search / database query,
 *  GraphQL endpoints (a query; a mutation is checked in the body). */
const READ_POST_PATH = /(^|\/)(search|query|graphql)(\/|$)|\/search\/jql$|\/jql\/match$/i;

/** Does this request only read? Read-only access lets nothing else through. */
export function isReadRequest(method: string, path: string, body?: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  if (m !== 'POST' || !READ_POST_PATH.test(path.split('?')[0])) return false;
  // GraphQL: a mutation writes, wherever it is.
  if (/graphql/i.test(path) || /"query"\s*:/.test(body ?? '')) {
    let q = '';
    try { const j = JSON.parse(body ?? '{}') as { query?: unknown }; q = typeof j.query === 'string' ? j.query : ''; } catch { q = body ?? ''; }
    return !/^\s*(mutation|subscription)\b/i.test(q.replace(/#[^\n]*\n/g, ''));
  }
  return true;
}
