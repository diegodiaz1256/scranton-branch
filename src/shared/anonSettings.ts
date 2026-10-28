/**
 * Anonymization settings and decisions (the proxy is src/main/anonProxy.ts,
 * the detection core src/shared/anonymize.ts).
 *
 * - Settings (config.json `anonymize`): office on/off (default off), a
 *   per-agent override, and which categories are on. Not secret, but
 *   human-only: the generic config write drops them (stripHumanOnly).
 * - The dictionary (terms, ticket prefixes, known secrets) is NOT in
 *   config.json: it is kept encrypted in the app's data folder (anonStore.ts),
 *   never in a repo or anywhere an agent is told about.
 * - Coverage: which CLIs the proxy can really sit in front of. Anything else
 *   is shown as "not covered", never silently claimed.
 * - Fail closed: anonymization on + a covered CLI + no proxy = not started.
 *
 * Pure: no electron, no node.
 */
import type { AnonCategory, AnonTerm, AnonymizeOptions, TermCategory } from './anonymize';
import { ANON_CATEGORIES, TERM_CATEGORIES } from './anonymize';

export interface AnonSettings {
  /** Office-wide switch. Default off. */
  enabled?: boolean;
  /** Category switches; missing ones take DEFAULT_ANON_CATEGORIES. */
  categories?: Partial<Record<AnonCategory, boolean>>;
  /** Per-agent override: true/false wins over the office switch. */
  agents?: Record<string, boolean>;
  /** Refuse to start an agent whose CLI anonymization cannot cover (default
   *  false: it starts, marked "not covered"). */
  refuseUncovered?: boolean;
}

/**
 * Dictionary-driven categories are on (they only act on what the human
 * listed: terms, internal domains, ticket prefixes, known secrets), and so
 * are credential-shaped strings. Emails and IPs (detected anywhere) are off
 * until the human turns them on.
 */
export const DEFAULT_ANON_CATEGORIES: Readonly<Record<AnonCategory, boolean>> = {
  term: true,
  domain: true,
  ticket: true,
  secret: true,
  knownSecret: true,
  email: false,
  ipv4: false
};

export interface AnonDictionaryEntry {
  /** Canonical spelling (what the CLI and you see). */
  term: string;
  aliases?: string[];
  category?: TermCategory;
  /** Your own codename; empty = generated ("System S1"). */
  as?: string;
}

export interface AnonDictionary {
  terms: AnonDictionaryEntry[];
  /** `INFOSEC` hides INFOSEC-123. */
  ticketPrefixes: string[];
  /** Exact values (passwords, tokens) to hide wherever they appear. */
  secrets: string[];
}

export const EMPTY_DICTIONARY: AnonDictionary = { terms: [], ticketPrefixes: [], secrets: [] };

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown, max: number, len = 200): string[] =>
  Array.isArray(v) ? [...new Set(v.map((x) => str(x, len)).filter(Boolean))].slice(0, max) : [];

export function cleanAnonSettings(raw: unknown): AnonSettings {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const out: AnonSettings = { enabled: r.enabled === true };
  const cats = r.categories && typeof r.categories === 'object' ? r.categories as Record<string, unknown> : {};
  const c: Partial<Record<AnonCategory, boolean>> = {};
  for (const k of ANON_CATEGORIES) if (typeof cats[k] === 'boolean') c[k] = cats[k] as boolean;
  if (Object.keys(c).length) out.categories = c;
  const agents = r.agents && typeof r.agents === 'object' ? r.agents as Record<string, unknown> : {};
  const a: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(agents)) if (id && id.length <= 200 && typeof v === 'boolean') a[id] = v;
  if (Object.keys(a).length) out.agents = a;
  if (r.refuseUncovered === true) out.refuseUncovered = true;
  return out;
}

export function cleanDictionary(raw: unknown): AnonDictionary {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const terms: AnonDictionaryEntry[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(r.terms) ? r.terms.slice(0, 2000) : []) {
    const e = t && typeof t === 'object' ? t as Record<string, unknown> : {};
    const term = str(e.term);
    if (term.length < 2 || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const category = TERM_CATEGORIES.includes(e.category as TermCategory) ? e.category as TermCategory : 'other';
    const aliases = strList(e.aliases, 20).filter((a) => a.length >= 2 && a.toLowerCase() !== term.toLowerCase());
    const as = str(e.as, 80);
    terms.push({ term, category, ...(aliases.length ? { aliases } : {}), ...(as ? { as } : {}) });
  }
  const ticketPrefixes = strList(r.ticketPrefixes, 200, 40).map((p) => p.toUpperCase()).filter((p) => /^[A-Z][A-Z0-9_]*$/.test(p));
  // Secrets keep their exact bytes (no trim): a value is matched exactly.
  const secrets = Array.isArray(r.secrets)
    ? [...new Set(r.secrets.filter((s): s is string => typeof s === 'string' && s.length >= 4 && s.length <= 4096))].slice(0, 500)
    : [];
  return { terms, ticketPrefixes: [...new Set(ticketPrefixes)], secrets };
}

/** The effective category switches. */
export function anonCategories(s: AnonSettings): Record<AnonCategory, boolean> {
  return { ...DEFAULT_ANON_CATEGORIES, ...(s.categories ?? {}) };
}

/** Is anonymization on for this agent? Its own override wins. */
export function anonEnabledFor(s: AnonSettings, agentId: string | undefined): boolean {
  const own = agentId ? s.agents?.[agentId] : undefined;
  return typeof own === 'boolean' ? own : s.enabled === true;
}

/** What the Anonymizer is built with. */
export function anonOptions(s: AnonSettings, d: AnonDictionary): AnonymizeOptions {
  const terms: AnonTerm[] = d.terms.map((t) => ({
    term: t.term,
    ...(t.aliases?.length ? { aliases: t.aliases } : {}),
    category: t.category ?? 'other',
    ...(t.as ? { as: t.as } : {})
  }));
  return { categories: anonCategories(s), terms, ticketPrefixes: d.ticketPrefixes, secrets: d.secrets };
}

// ─── human-only config fields ───────────────────────────────────────────────

/**
 * Config fields only the human sets, each through its own handler (with its
 * confirmation and audit line). The generic config write (config:set, which
 * other code paths and agent-driven actions reach) drops them.
 */
export const HUMAN_ONLY_CONFIG_KEYS = ['agentUnsandboxed', 'agentSshRelay', 'agentCloudCredentials', 'agentDocker', 'anonymize'] as const;

export function stripHumanOnly<T extends Record<string, unknown>>(patch: T | null | undefined): Partial<T> {
  const out: Record<string, unknown> = { ...(patch ?? {}) };
  for (const k of HUMAN_ONLY_CONFIG_KEYS) delete out[k];
  return out as Partial<T>;
}

// ─── coverage ───────────────────────────────────────────────────────────────

/**
 * How the proxy gets in front of a CLI:
 *   base-url    the CLI's own base-URL env var (Claude Code: ANTHROPIC_BASE_URL)
 *   hive-proxy  chained behind the hive's proxy bridge (qwen, crush)
 *   config      the per-agent config the app writes (opencode, pi: only for
 *               your own OpenAI-compatible providers, whose base URL it sets)
 */
export type AnonRoute = 'base-url' | 'hive-proxy' | 'config';

export type AnonCoverage =
  | { covered: true; route: AnonRoute }
  /** The model is on this machine: nothing leaves it, nothing to hide. */
  | { covered: 'local' }
  | { covered: false; reason: AnonUncoveredReason };

export type AnonUncoveredReason =
  /** The CLI talks to an endpoint the app cannot redirect (its own login/cloud). */
  | 'endpoint-fixed'
  /** Claude Code on Bedrock / Vertex / Foundry. */
  | 'cloud-platform'
  /** opencode / pi with a model the app does not configure. */
  | 'model-provider'
  /** A custom command: unknown CLI. */
  | 'unknown-cli';

/** Providers the proxy can cover at all (subject to the per-spawn checks). */
export const ANON_COVERABLE = ['claude', 'qwen', 'crush', 'opencode', 'pi'] as const;

const CLOUD_PLATFORM_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

/** Is this URL on this machine (loopback)? */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || /^127\./.test(h) || h.endsWith('.localhost');
  } catch { return false; }
}

export interface CoverageContext {
  /** The agent's env (Claude Code: a Bedrock/Vertex switch means not covered). */
  env?: Record<string, string | undefined>;
  /** Where its model calls go (to tell a local model). */
  upstream?: string;
  /** opencode/pi: the provider prefix of its model ('local', a custom id…). */
  modelProvider?: string;
  /** opencode/pi: the providers whose base URL the app writes. */
  configurableProviders?: string[];
}

/** Can the proxy cover this agent? Static facts per CLI plus this spawn's. */
export function anonCoverage(provider: string | undefined, ctx: CoverageContext = {}): AnonCoverage {
  const p = provider ?? 'custom';
  if (!(ANON_COVERABLE as readonly string[]).includes(p)) return { covered: false, reason: p === 'custom' ? 'unknown-cli' : 'endpoint-fixed' };
  if (p === 'claude' && CLOUD_PLATFORM_ENV.some((k) => { const v = ctx.env?.[k]; return !!v && v !== '0' && v.toLowerCase() !== 'false'; })) {
    return { covered: false, reason: 'cloud-platform' };
  }
  if (p === 'opencode' || p === 'pi') {
    const mp = ctx.modelProvider ?? '';
    if (!mp || !(ctx.configurableProviders ?? []).includes(mp)) return { covered: false, reason: 'model-provider' };
  }
  if (isLoopbackUrl(ctx.upstream)) return { covered: 'local' };
  return { covered: true, route: p === 'claude' ? 'base-url' : p === 'qwen' || p === 'crush' ? 'hive-proxy' : 'config' };
}

// ─── the spawn decision (fail closed) ───────────────────────────────────────

export type AnonSpawnDecision =
  | { action: 'off' }
  | { action: 'local' }
  | { action: 'proxy'; route: AnonRoute }
  | { action: 'uncovered'; reason: AnonUncoveredReason }
  | { action: 'refuse'; why: 'proxy-down' | 'uncovered'; reason?: AnonUncoveredReason };

/**
 * What a spawn does about anonymization. `proxyUp`: the proxy is listening
 * (or was just started). Anonymization on and covered but no proxy: the agent
 * does NOT start (unlike the hive proxy, which falls back to direct).
 */
export function anonSpawnDecision(input: { enabled: boolean; coverage: AnonCoverage; proxyUp: boolean; refuseUncovered?: boolean }): AnonSpawnDecision {
  if (!input.enabled) return { action: 'off' };
  const c = input.coverage;
  if (c.covered === 'local') return { action: 'local' };
  if (c.covered === false) {
    return input.refuseUncovered ? { action: 'refuse', why: 'uncovered', reason: c.reason } : { action: 'uncovered', reason: c.reason };
  }
  if (!input.proxyUp) return { action: 'refuse', why: 'proxy-down' };
  return { action: 'proxy', route: c.route };
}

/** The status an agent shows (agent panel, Privacy view). */
export type AnonAgentStatus = 'off' | 'on' | 'local' | 'not-covered';

/** What the Privacy view gets from main (anon:get). No secret values. */
export interface AnonState {
  settings: AnonSettings;
  dictionary: { terms: AnonDictionaryEntry[]; ticketPrefixes: string[]; secretCount: number };
  dictionaryError: string | null;
  /** The OS key store encrypts the dictionary and maps. */
  encrypted: boolean;
  proxy: 'running' | 'stopped';
  /** Each agent's anonymization at its last start. */
  statuses: Record<string, { status: AnonAgentStatus; reason?: AnonUncoveredReason; at: number }>;
}

export function anonStatusOf(d: AnonSpawnDecision): AnonAgentStatus {
  switch (d.action) {
    case 'off': return 'off';
    case 'local': return 'local';
    case 'proxy': return 'on';
    default: return 'not-covered';
  }
}
