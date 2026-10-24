/**
 * Connections (Pro): credentials for the keyed MCP servers in MCP_CATALOG —
 * GitHub, Database, Web Search, Notion, Sentry.
 *
 * Values go into the SAME encrypted store as the REST integrations
 * (integrations.ts, Electron safeStorage, fail-closed), under `mcp:<server>:<ENV>`.
 * They are never returned to the renderer (only "stored: yes/no") and never
 * reach an agent: the MAIN process runs each keyed server through its MCP
 * gateway (mcpGateway.ts) with the key in that server's environment only, and
 * an agent the server is granted to (consent in `mcpDefaults`, optional
 * per-server agent list in `connectionScopes`) gets a capability token.
 */
import { MCP_CATALOG, mcpCatalogEntry, cleanSecretValue, type McpCatalogEntry } from '../shared/mcpCatalog';
import { readConfig, writeConfig } from './config';
import { getSecret, setSecret, deleteSecret, hasSecret } from './integrations';
import { effectiveAccess, isAccess, DEFAULT_CEILING, type Access } from '../shared/connectionAccess';

export interface ConnectionField {
  env: string;
  label: string;
  help: string;
  placeholder?: string;
  optional?: boolean;
  stored: boolean;
}

export interface ConnectionStatus {
  /** Instance id: the service id for a service's first connection (so
   *  connections made before instances existed keep working), else
   *  `<service>--<slug>`. */
  id: string;
  /** Catalog id of the service this connection is an instance of. */
  service: string;
  serviceLabel: string;
  /** The name you gave it (the service's name for the first one). */
  label: string;
  /** The first connection of its service; it cannot be deleted, only emptied. */
  primary: boolean;
  /** Example requests to make of an agent that has it (the guide). */
  examples: string[];
  description: string;
  docsUrl?: string;
  fields: ConnectionField[];
  /** Switched on (consent in mcpDefaults). */
  enabled: boolean;
  /** Every required field holds a stored value. */
  ready: boolean;
  /** Agent ids it is limited to, or null for every agent. */
  scope: string[] | null;
  /** The most any agent may do with it (a role can only lower this). */
  access: Access;
  /** Whether Test can actually reach the service for this kind. */
  testable: boolean;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Human sentence: who the key belongs to, or what went wrong. */
  message: string;
}

const refFor = (serverId: string, env: string): string => `mcp:${serverId}:${env}`;

function keyed(): McpCatalogEntry[] {
  return MCP_CATALOG.filter((e) => (e.secrets ?? []).length > 0);
}

// ─── instances ───────────────────────────────────────────────────────────────
// Several connections of one service (two GitHub accounts, prod and staging
// databases). Every per-connection setting is already keyed by id — consent in
// mcpDefaults, agents in connectionScopes, keys in the store as mcp:<id>:<ENV> —
// so an instance only needs its id → service mapping and a name.

interface Instance { id: string; service: string; label: string }

function extraInstances(): Instance[] {
  const raw = readConfig().connectionInstances;
  return Array.isArray(raw) ? raw.filter((i) => i && typeof i.id === 'string' && typeof i.service === 'string') : [];
}

/** The service a connection id belongs to (its own id for a primary one). */
export function serviceOf(id: string): string | undefined {
  if (keyed().some((e) => e.id === id)) return id;
  return extraInstances().find((i) => i.id === id)?.service;
}

/** Every connection id of a service, primary first (the hive's view). */
export function instancesOf(service: string): string[] {
  return [service, ...extraInstances().filter((i) => i.service === service).map((i) => i.id)];
}

function field(id: string, env: string): NonNullable<McpCatalogEntry['secrets']>[number] | undefined {
  const service = serviceOf(id);
  return service ? mcpCatalogEntry(service)?.secrets?.find((f) => f.env === env) : undefined;
}

/** The value for one server credential. MAIN-ONLY: read by the MCP gateway
 *  when it starts that server, never handed to an agent. */
export function connectionSecret(serverId: string, env: string): string | undefined {
  const f = field(serverId, env);
  const v = f ? getSecret(refFor(serverId, env)) : undefined;
  // Cleaned on the way out, so a value stored before this check is fixed too.
  return v === undefined ? undefined : cleanSecretValue(f, v);
}

/** Whether a credential is stored, without decrypting it (the hive's check). */
export function connectionKeyStored(serverId: string, env: string): boolean {
  return !!field(serverId, env) && hasSecret(refFor(serverId, env));
}

/** How the MCP gateway launches a keyed server: the catalog spec plus the
 *  decrypted keys, or null when a required key is missing. MAIN-ONLY. */
export function connectionLaunchEnv(serverId: string): Record<string, string> | null {
  const entry = mcpCatalogEntry(serviceOf(serverId) ?? '');
  if (!entry || !(entry.secrets ?? []).length) return null;
  const env: Record<string, string> = {};
  for (const f of entry.secrets ?? []) {
    const v = connectionSecret(serverId, f.env);
    if (v) env[f.env] = v;
    else if (!f.optional) return null;
  }
  return env;
}

export function listConnections(): ConnectionStatus[] {
  const cfg = readConfig();
  const extra = extraInstances();
  return keyed().flatMap((e) => [{ id: e.id, service: e.id, label: e.label }, ...extra.filter((i) => i.service === e.id)].map((inst) => {
    const fields = (e.secrets ?? []).map((f) => ({ ...f, stored: hasSecret(refFor(inst.id, f.env)) }));
    const scope = cfg.connectionScopes?.[inst.id];
    return {
      id: inst.id,
      service: e.id,
      serviceLabel: e.label,
      label: inst.label,
      primary: inst.id === e.id,
      examples: e.examples ?? [],
      description: e.description,
      docsUrl: e.docsUrl,
      fields,
      enabled: cfg.mcpDefaults?.[inst.id]?.enabled === true,
      ready: fields.every((f) => f.optional || f.stored),
      scope: Array.isArray(scope) ? scope : null,
      access: cfg.connectionPolicy?.[inst.id] ?? DEFAULT_CEILING,
      testable: e.id in TESTS
    };
  }));
}

/** Add another connection of a service, e.g. a second GitHub account. */
export function addConnection(service: unknown, label: unknown): { ok: boolean; id?: string; error?: string } {
  const entry = typeof service === 'string' ? keyed().find((e) => e.id === service) : undefined;
  if (!entry) return { ok: false, error: 'unknown service' };
  const name = typeof label === 'string' ? label.trim().slice(0, 40) : '';
  if (!name) return { ok: false, error: 'give it a name' };
  const extra = extraInstances();
  if (extra.length >= 50) return { ok: false, error: 'too many connections' };
  const base = `${entry.id}--${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'more'}`;
  let id = base;
  for (let i = 2; extra.some((x) => x.id === id); i++) id = `${base}-${i}`;
  writeConfig({ connectionInstances: [...extra, { id, service: entry.id, label: name }] });
  return { ok: true, id };
}

export function renameConnection(id: unknown, label: unknown): { ok: boolean; error?: string } {
  const name = typeof label === 'string' ? label.trim().slice(0, 40) : '';
  const extra = extraInstances();
  if (!name || !extra.some((x) => x.id === id)) return { ok: false, error: 'only an added connection can be renamed' };
  writeConfig({ connectionInstances: extra.map((x) => (x.id === id ? { ...x, label: name } : x)) });
  return { ok: true };
}

/** Delete an added connection: its keys, its switch and its agent list go too. */
export function removeConnection(id: unknown): { ok: boolean; error?: string } {
  const extra = extraInstances();
  const inst = extra.find((x) => x.id === id);
  if (!inst) return { ok: false, error: 'only an added connection can be deleted' };
  for (const f of mcpCatalogEntry(inst.service)?.secrets ?? []) deleteSecret(refFor(inst.id, f.env));
  const cfg = readConfig();
  const mcpDefaults = { ...(cfg.mcpDefaults ?? {}) }; delete mcpDefaults[inst.id];
  const connectionScopes = { ...(cfg.connectionScopes ?? {}) }; delete connectionScopes[inst.id];
  const connectionPolicy = { ...(cfg.connectionPolicy ?? {}) }; delete connectionPolicy[inst.id];
  writeConfig({ connectionInstances: extra.filter((x) => x.id !== inst.id), mcpDefaults, connectionScopes, connectionPolicy });
  return { ok: true };
}

/** Store (or, with an empty value, remove) one credential. */
export function setConnectionSecret(serverId: unknown, env: unknown, value: unknown): { ok: boolean; error?: string } {
  if (typeof serverId !== 'string' || typeof env !== 'string' || !field(serverId, env)) {
    return { ok: false, error: 'unknown connection field' };
  }
  if (typeof value !== 'string') return { ok: false, error: 'invalid value' };
  const trimmed = value.trim();
  if (!trimmed) { deleteSecret(refFor(serverId, env)); return { ok: true }; }
  if (trimmed.length > 4096) return { ok: false, error: 'value too long' };
  return setSecret(refFor(serverId, env), trimmed);
}

/** Switch a connection on or off (the same consent the MCP settings toggle writes). */
export function setConnectionEnabled(serverId: unknown, on: unknown): { ok: boolean; error?: string } {
  if (typeof serverId !== 'string' || !serviceOf(serverId)) return { ok: false, error: 'unknown connection' };
  const cfg = readConfig();
  writeConfig({ mcpDefaults: { ...(cfg.mcpDefaults ?? {}), [serverId]: { enabled: on === true } } });
  return { ok: true };
}

/** What one agent may do with one connection: the connection's ceiling, lowered
 *  by what its role grants for that service. MAIN-ONLY (read by the gateway). */
export function connectionAccessFor(agentId: string, connectionId: string): Access {
  const cfg = readConfig();
  const service = serviceOf(connectionId);
  if (!service) return 'none';
  return effectiveAccess(cfg.connectionPolicy?.[connectionId], cfg.agentMcpAccess?.[agentId], service);
}

/** Set the most any agent may do with a connection. */
export function setConnectionAccess(serverId: unknown, access: unknown): { ok: boolean; error?: string } {
  if (typeof serverId !== 'string' || !serviceOf(serverId)) return { ok: false, error: 'unknown connection' };
  if (!isAccess(access)) return { ok: false, error: 'invalid access level' };
  writeConfig({ connectionPolicy: { ...(readConfig().connectionPolicy ?? {}), [serverId]: access } });
  return { ok: true };
}

/** Limit a connection to some agents, or (null) give it to every agent. */
export function setConnectionScope(serverId: unknown, agentIds: unknown): { ok: boolean; error?: string } {
  if (typeof serverId !== 'string' || !serviceOf(serverId)) return { ok: false, error: 'unknown connection' };
  const scopes = { ...(readConfig().connectionScopes ?? {}) };
  if (agentIds === null) {
    delete scopes[serverId];
  } else if (Array.isArray(agentIds) && agentIds.every((a) => typeof a === 'string')) {
    scopes[serverId] = Array.from(new Set((agentIds as string[]).map((a) => a.trim()).filter(Boolean)));
  } else {
    return { ok: false, error: 'invalid agent list' };
  }
  writeConfig({ connectionScopes: scopes });
  return { ok: true };
}

// ─── Test: one cheap, read-only call per service ─────────────────────────────

async function call(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: { 'User-Agent': 'munder-difflin-connections', ...headers }, signal: AbortSignal.timeout(10_000) });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, body };
}

const httpFailure = (status: number): string =>
  status === 401 || status === 403 ? 'The key was rejected (check it and its permissions).' : `The service answered HTTP ${status}.`;

type Tester = (value: (env: string) => string | undefined) => Promise<ConnectionTestResult>;

const TESTS: Record<string, Tester> = {
  'github-token': async (v) => {
    const r = await call('https://api.github.com/user', { Authorization: `Bearer ${v('GITHUB_PERSONAL_ACCESS_TOKEN')}`, Accept: 'application/vnd.github+json' });
    const login = (r.body as { login?: string } | null)?.login;
    return r.status === 200 ? { ok: true, message: `Connected as ${login ?? 'your account'}.` } : { ok: false, message: httpFailure(r.status) };
  },
  'search-with-key': async (v) => {
    const r = await call('https://api.search.brave.com/res/v1/web/search?q=munder%20difflin&count=1', { 'X-Subscription-Token': v('BRAVE_API_KEY') ?? '', Accept: 'application/json' });
    return r.status === 200 ? { ok: true, message: 'Search works with this key.' } : { ok: false, message: httpFailure(r.status) };
  },
  notion: async (v) => {
    const r = await call('https://api.notion.com/v1/users/me', { Authorization: `Bearer ${v('NOTION_TOKEN')}`, 'Notion-Version': '2022-06-28' });
    const name = (r.body as { name?: string; bot?: { workspace_name?: string } } | null);
    return r.status === 200
      ? { ok: true, message: `Connected${name?.bot?.workspace_name ? ` to ${name.bot.workspace_name}` : ''}${name?.name ? ` as ${name.name}` : ''}.` }
      : { ok: false, message: httpFailure(r.status) };
  },
  sentry: async (v) => {
    const host = (v('SENTRY_HOST') || 'sentry.io').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const r = await call(`https://${host}/api/0/organizations/`, { Authorization: `Bearer ${v('SENTRY_ACCESS_TOKEN')}` });
    const orgs = Array.isArray(r.body) ? (r.body as Array<{ slug?: string }>).map((o) => o.slug).filter(Boolean) : [];
    return r.status === 200 ? { ok: true, message: orgs.length ? `Connected to ${orgs.join(', ')}.` : 'Connected (no organisations visible to this token).' } : { ok: false, message: httpFailure(r.status) };
  },
  db: async (v) => {
    // A real query needs a Postgres driver the app does not ship; the server
    // itself connects on first use. Check the shape, which catches most typos.
    const raw = v('DATABASE_URI') ?? '';
    try {
      const u = new URL(raw);
      if (!/^postgres(ql)?:$/.test(u.protocol)) return { ok: false, message: 'Expected a postgresql:// connection string.' };
      if (!u.hostname) return { ok: false, message: 'The connection string has no host.' };
      return { ok: true, message: `Looks right (${u.hostname}${u.pathname}). The agent connects on first use.` };
    } catch {
      return { ok: false, message: 'Not a valid connection string.' };
    }
  }
};

export async function testConnection(serverId: unknown): Promise<ConnectionTestResult> {
  if (typeof serverId !== 'string') return { ok: false, message: 'Unknown connection.' };
  const service = serviceOf(serverId) ?? '';
  const entry = mcpCatalogEntry(service);
  const tester = TESTS[service];
  if (!entry || !tester) return { ok: false, message: 'No test for this connection.' };
  const value = (env: string) => connectionSecret(serverId, env);
  const missing = (entry.secrets ?? []).filter((f) => !f.optional && !value(f.env));
  if (missing.length) return { ok: false, message: `Add the ${missing.map((f) => f.label.toLowerCase()).join(' and ')} first.` };
  try {
    return await tester(value);
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError' ? 'The service did not answer in 10 s.' : 'Could not reach the service (offline or blocked?).';
    return { ok: false, message: msg };
  }
}
