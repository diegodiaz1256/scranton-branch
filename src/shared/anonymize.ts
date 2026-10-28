/**
 * Anonymization core: pseudonymize sensitive values in model API requests and
 * restore them in the responses (whole bodies and SSE streams).
 *
 * The local proxy between an agent CLI and its model API (phase 2) uses it so
 * the model only ever sees stable placeholders (`user1@example.invalid`,
 * `host1.example.invalid`, `192.0.2.1`, `TICKET-1`, `System S1`, `[SECRET_1]`)
 * while the CLI keeps working with the real values.
 *
 * - Detection is local and conservative: emails, IPv4 (and CIDR), the user's
 *   dictionary (categorised names with aliases and optional own replacement,
 *   internal domains and their subdomains), ticket keys for
 *   the given prefixes, known secret values and credential-shaped strings (the
 *   same patterns as agentSteps' `redact()`). File paths, identifiers, version
 *   numbers, model names and JSON keys are left alone.
 * - The map is deterministic: a value keeps its placeholder for the life of
 *   the map and numbers are never reused, so a conversation's prompt prefix is
 *   byte-identical turn after turn (prompt caching keeps working).
 * - Only string values in text-bearing fields are rewritten; keys, model,
 *   tool schemas, cache_control and unknown fields are untouched.
 *
 * Pure: no electron, no node (TextDecoder is a web/Node global).
 */
import { SECRET_VALUE, SECRET_ASSIGN } from './agentSteps';

// ─── categories and options ─────────────────────────────────────────────────

export type AnonCategory = 'email' | 'ipv4' | 'term' | 'domain' | 'ticket' | 'secret' | 'knownSecret';

export const ANON_CATEGORIES: readonly AnonCategory[] = ['email', 'ipv4', 'term', 'domain', 'ticket', 'secret', 'knownSecret'];

export type TermCategory = 'person' | 'company' | 'customer' | 'system' | 'project' | 'team' | 'product' | 'process-step' | 'domain' | 'other';

export const TERM_CATEGORIES: readonly TermCategory[] = ['person', 'company', 'customer', 'system', 'project', 'team', 'product', 'process-step', 'domain', 'other'];

/** Codename shape per category: "System S1", "Project P2", "Team T1"… */
const CODENAME: Record<Exclude<TermCategory, 'domain'>, [string, string]> = {
  person: ['Person', 'PE'],
  company: ['Company', 'CO'],
  customer: ['Customer', 'CU'],
  system: ['System', 'S'],
  project: ['Project', 'P'],
  team: ['Team', 'T'],
  product: ['Product', 'PR'],
  'process-step': ['Step', 'ST'],
  other: ['Term', 'X']
};

/**
 * One dictionary entry. `term` is the canonical value (what is restored); an
 * array means canonical first, then aliases. All spellings share one codename.
 */
export interface AnonTerm {
  term: string | string[];
  /** More spellings of the same thing ("SAP FI", "sapfi"). */
  aliases?: string[];
  /** Default 'other'. 'domain' (alias 'host') also hides subdomains. */
  category?: TermCategory | 'host';
  /** The user's own replacement ("System S1"). Default: a generated codename
   *  for the category, numbered in order of first sight. */
  as?: string;
}

export interface AnonymizeOptions {
  /** Turn a category off with `false`. All are on by default (the dictionary
   *  ones only do something when their list is given). */
  categories?: Partial<Record<AnonCategory, boolean>>;
  /** The user's dictionary (people, customers, systems, projects, internal
   *  domains…): exact, case-insensitive, whole words. A bare string is an
   *  'other' entry. */
  terms?: Array<string | AnonTerm>;
  /** Internal domains / hostnames: the domain and every subdomain of it
   *  (same as `terms` entries with category 'domain'). */
  domains?: string[];
  /** Ticket key prefixes: `INFOSEC` hides `INFOSEC-123`. */
  ticketPrefixes?: string[];
  /** Known secret values, matched exactly (case-sensitive). */
  secrets?: string[];
}

export type ApiFlavor = 'anthropic' | 'openai-chat' | 'openai-responses';

/** Which API a proxied request path speaks, or null when it is not a model call. */
export function apiForPath(path: string): ApiFlavor | null {
  const p = path.split('?')[0];
  if (/\/messages$/.test(p) && !/count_tokens/.test(p)) return 'anthropic';
  if (/\/chat\/completions$/.test(p)) return 'openai-chat';
  if (/\/responses$/.test(p)) return 'openai-responses';
  return null;
}

// ─── the pseudonym map ──────────────────────────────────────────────────────

/** Placeholder family: decides the placeholder's shape and its counter. */
type Family = 'email' | 'host' | 'ip' | 'ticket' | `token:${string}` | `term:${string}`;

interface Entry {
  family: Family;
  /** The real value as first seen (what is restored). */
  value: string;
  placeholder: string;
}

export interface PseudonymMapJSON {
  v: 1;
  entries: Array<{ family: string; value: string; placeholder: string }>;
  counters: Record<string, number>;
}

const CASE_INSENSITIVE = (f: Family): boolean => f === 'email' || f === 'host' || f.startsWith('term:');

const IP_POOLS = ['192.0.2', '198.51.100', '203.0.113'];

function makePlaceholder(family: Family, n: number): string {
  switch (family) {
    case 'email': return `user${n}@example.invalid`;
    case 'host': return `host${n}.example.invalid`;
    case 'ticket': return `TICKET-${n}`;
    case 'ip': {
      const pool = Math.floor((n - 1) / 254);
      return pool < IP_POOLS.length ? `${IP_POOLS[pool]}.${((n - 1) % 254) + 1}` : `[IP_${n}]`;
    }
    default: {
      if (family.startsWith('term:')) {
        const [word, letter] = CODENAME[family.slice('term:'.length) as keyof typeof CODENAME] ?? CODENAME.other;
        return `${word} ${letter}${n}`;
      }
      return `[${family.slice('token:'.length)}_${n}]`;
    }
  }
}

/**
 * Value <-> placeholder table. Deterministic: the n-th distinct value of a
 * family gets number n, forever. Serializable for persistence.
 */
export class PseudonymMap {
  private byKey = new Map<string, Entry>();
  private byPlaceholder = new Map<string, Entry>();
  private counters: Record<string, number> = {};
  /** Bumped on every new entry (restorers cache their matchers on it). */
  version = 0;

  private static key(family: Family, value: string): string {
    return `${family}\u0000${CASE_INSENSITIVE(family) ? value.toLowerCase() : value}`;
  }

  /** The placeholder for a value, assigning the next number on first sight. */
  placeholderFor(family: Family, value: string, fixed?: string): string {
    const k = PseudonymMap.key(family, value);
    const hit = this.byKey.get(k);
    if (hit) return hit.placeholder;
    let placeholder: string;
    if (fixed && !this.byPlaceholder.has(fixed)) {
      // The user's own replacement: no number consumed.
      placeholder = fixed;
    } else {
      let n = (this.counters[family] ?? 0) + 1;
      placeholder = makePlaceholder(family, n);
      // Never hand out a placeholder already taken (a user's `as` may look like one).
      while (this.byPlaceholder.has(placeholder)) placeholder = makePlaceholder(family, ++n);
      this.counters[family] = n;
    }
    const entry: Entry = { family, value, placeholder };
    this.byKey.set(k, entry);
    this.byPlaceholder.set(placeholder, entry);
    this.version++;
    return placeholder;
  }

  /** The real value behind a placeholder (exact placeholder text). */
  original(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder)?.value;
  }

  get size(): number { return this.byPlaceholder.size; }

  entries(): Array<{ family: string; value: string; placeholder: string }> {
    return [...this.byPlaceholder.values()].map((e) => ({ ...e }));
  }

  toJSON(): PseudonymMapJSON {
    return { v: 1, entries: this.entries(), counters: { ...this.counters } };
  }

  static fromJSON(json: PseudonymMapJSON | string): PseudonymMap {
    const data: PseudonymMapJSON = typeof json === 'string' ? JSON.parse(json) : json;
    const map = new PseudonymMap();
    for (const e of data?.entries ?? []) {
      if (typeof e?.value !== 'string' || typeof e.placeholder !== 'string' || typeof e.family !== 'string') continue;
      const entry: Entry = { family: e.family as Family, value: e.value, placeholder: e.placeholder };
      map.byKey.set(PseudonymMap.key(entry.family, entry.value), entry);
      map.byPlaceholder.set(entry.placeholder, entry);
    }
    for (const [f, n] of Object.entries(data?.counters ?? {})) if (Number.isInteger(n) && n > 0) map.counters[f] = n;
    map.version = map.byPlaceholder.size;
    return map;
  }
}

// ─── detection ──────────────────────────────────────────────────────────────

interface Span {
  start: number; end: number; family: Family; prio: number;
  /** Map under this value instead of the matched text (an alias's canonical term). */
  value?: string;
  /** The user's own replacement. */
  fixed?: string;
}

interface DictEntry { canonical: string; family: Family; as?: string }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![\w-]|\.[A-Za-z0-9])/g;
// Four dotted octets, optional /prefix. Not part of a longer dotted run
// (1.2.3.4.5), not glued to letters/digits (v1.2.3.4, build-1.2.3.4).
const IPV4 = /(?<![\w.-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/\d{1,2})?(?![\w-]|\.\d)/g;
const BEARER = /\b(?:Bearer|Basic) ([A-Za-z0-9._~+/=-]{8,})/g;
const URL_CREDS = /:\/\/[^/\s:@]+:([^/\s@]+)@/g;

/** Our own placeholders (and documentation ranges) are never re-detected. */
const isOwnEmail = (s: string): boolean => /@example\.invalid$/i.test(s);
const isOwnHost = (s: string): boolean => /(?:^|\.)example\.invalid$/i.test(s);
function ipSkipped(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((o) => o > 255)) return true;
  if (a === 127 || a === 0 || (a === 255 && b === 255 && c === 255 && d === 255)) return true;
  if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return true;
  return false;
}

const PRIO: Record<AnonCategory, number> = { knownSecret: 0, secret: 1, email: 2, domain: 3, ipv4: 4, ticket: 5, term: 6 };

const HOST_LABELS = '(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)*';

// ─── restore matcher ────────────────────────────────────────────────────────

const WORD = /[A-Za-z0-9_]/;

interface Matcher {
  version: number;
  re: RegExp | null;
  /** placeholder (or bare token) -> entry */
  lookup: Map<string, Entry>;
  /** Every prefix of every key: a buffer tail in here may still become one. */
  prefixes: Set<string>;
  maxLen: number;
}

/** In JSON-escaped text, is the char at `i` the tail of an escape (`\n`, `é`)? */
function isEscapeTail(s: string, i: number): boolean {
  const slashesBefore = (j: number): number => { let k = 0; while (j - 1 - k >= 0 && s[j - 1 - k] === '\\') k++; return k; };
  if ('nrtbf"/\\'.includes(s[i]) && slashesBefore(i) % 2 === 1) return true;
  // \uXXXX: i is the last hex digit.
  if (i >= 5 && /^u[0-9a-fA-F]{4}$/.test(s.slice(i - 4, i + 1)) && slashesBefore(i - 4) % 2 === 1) return true;
  return false;
}

// ─── the anonymizer ─────────────────────────────────────────────────────────

type Json = unknown;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export class Anonymizer {
  readonly map: PseudonymMap;
  private opts: AnonymizeOptions;
  private termRe: RegExp | null = null;
  private termByAlias = new Map<string, DictEntry>();
  private domainRe: RegExp | null = null;
  private domainByAlias = new Map<string, DictEntry>();
  private ticketRe: RegExp | null = null;
  private knownSecrets: string[] = [];
  private matcher: Matcher | null = null;

  constructor(opts: AnonymizeOptions = {}, map: PseudonymMap = new PseudonymMap()) {
    this.map = map;
    this.opts = opts;
    const B = '(?<![\\p{L}\\p{N}_])';
    const E = '(?![\\p{L}\\p{N}_])';
    const cleanDomain = (d: string): string => d.trim().replace(/^\*?\./, '').replace(/\.$/, '');
    const entries: AnonTerm[] = [
      ...(opts.terms ?? []).map((t) => (typeof t === 'string' ? { term: t } : t)),
      ...(opts.domains ?? []).map((d) => ({ term: d, category: 'domain' as const }))
    ];
    for (const t of entries) {
      if (!t || (typeof t.term !== 'string' && !Array.isArray(t.term))) continue;
      const isDomain = t.category === 'domain' || t.category === 'host';
      const spellings = [...(Array.isArray(t.term) ? t.term : [t.term]), ...(t.aliases ?? [])]
        .filter((s): s is string => typeof s === 'string')
        .map((s) => (isDomain ? cleanDomain(s) : s.trim()))
        .filter((s) => s.length >= 2);
      if (!spellings.length) continue;
      const cat = isDomain ? 'domain' : (t.category && t.category in CODENAME ? t.category : 'other');
      const as = typeof t.as === 'string' && t.as.trim() ? t.as.trim() : undefined;
      const entry: DictEntry = { canonical: spellings[0], family: isDomain ? 'host' : (`term:${cat}` as Family), as };
      const table = isDomain ? this.domainByAlias : this.termByAlias;
      // First definition of a spelling wins.
      for (const s of spellings) if (!table.has(s.toLowerCase())) table.set(s.toLowerCase(), entry);
    }
    const alt = (m: Map<string, DictEntry>): string => [...m.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    if (this.termByAlias.size) this.termRe = new RegExp(`${B}(?:${alt(this.termByAlias)})${E}`, 'giu');
    if (this.domainByAlias.size) {
      this.domainRe = new RegExp(`(?<![\\w.@-])(${HOST_LABELS})(${alt(this.domainByAlias)})(?![\\w-]|\\.[a-z0-9])`, 'gi');
    }
    const prefixes = (opts.ticketPrefixes ?? []).map((p) => p.trim()).filter((p) => /^[A-Za-z][A-Za-z0-9_]*$/.test(p));
    if (prefixes.length) this.ticketRe = new RegExp(`(?<![\\w])(?:${prefixes.map(escapeRe).join('|')})-\\d+(?!\\w)`, 'g');
    this.knownSecrets = [...new Set((opts.secrets ?? []).filter((s) => typeof s === 'string' && s.length >= 4))].sort((a, b) => b.length - a.length);
  }

  private on(c: AnonCategory): boolean { return this.opts.categories?.[c] !== false; }

  // ── pseudonymize ──

  private detect(text: string): Span[] {
    const spans: Span[] = [];
    const add = (start: number, end: number, family: Family, cat: AnonCategory, value?: string, fixed?: string): void => {
      if (end > start) spans.push({ start, end, family, prio: PRIO[cat], value, fixed });
    };
    if (this.on('knownSecret')) {
      for (const s of this.knownSecrets) {
        for (let i = text.indexOf(s); i !== -1; i = text.indexOf(s, i + s.length)) add(i, i + s.length, 'token:SECRET', 'knownSecret');
      }
    }
    if (this.on('secret')) {
      for (const m of text.matchAll(SECRET_VALUE)) add(m.index!, m.index! + m[0].length, 'token:SECRET', 'secret');
      for (const m of text.matchAll(SECRET_ASSIGN)) {
        const start = m.index! + m[1].length + 1;
        const value = m[0].slice(m[1].length + 1);
        // `KEY==x` / `TOKEN=>` are code, not assignments.
        if (/^[=>]/.test(value)) continue;
        add(start, m.index! + m[0].length, 'token:SECRET', 'secret');
      }
      for (const m of text.matchAll(BEARER)) add(m.index! + m[0].length - m[1].length, m.index! + m[0].length, 'token:SECRET', 'secret');
      for (const m of text.matchAll(URL_CREDS)) {
        const end = m.index! + m[0].length - 1;
        add(end - m[1].length, end, 'token:SECRET', 'secret');
      }
    }
    if (this.on('email')) {
      for (const m of text.matchAll(EMAIL)) {
        const local = m[0].slice(0, m[0].indexOf('@'));
        if (isOwnEmail(m[0]) || local.toLowerCase() === 'git') continue;
        add(m.index!, m.index! + m[0].length, 'email', 'email');
      }
    }
    if (this.on('domain') && this.domainRe) {
      for (const m of text.matchAll(this.domainRe)) {
        if (isOwnHost(m[0])) continue;
        const e = this.domainByAlias.get(m[2].toLowerCase());
        if (!e) continue;
        const start = m.index!;
        const end = start + m[0].length;
        if (!m[1]) add(start, end, 'host', 'domain', e.canonical, e.as);
        // A subdomain under a user-named domain keeps its labels: db.<as>.
        else if (e.as) add(start + m[1].length, end, 'host', 'domain', e.canonical, e.as);
        // Otherwise the whole host gets its own hostN (its labels may tell).
        else add(start, end, 'host', 'domain');
      }
    }
    if (this.on('ipv4')) {
      for (const m of text.matchAll(IPV4)) {
        if (ipSkipped(+m[1], +m[2], +m[3], +m[4])) continue;
        const ip = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
        add(m.index!, m.index! + ip.length, 'ip', 'ipv4');
      }
    }
    if (this.on('ticket') && this.ticketRe) {
      for (const m of text.matchAll(this.ticketRe)) add(m.index!, m.index! + m[0].length, 'ticket', 'ticket');
    }
    if (this.on('term') && this.termRe) {
      for (const m of text.matchAll(this.termRe)) {
        const e = this.termByAlias.get(m[0].toLowerCase());
        if (e) add(m.index!, m.index! + m[0].length, e.family, 'term', e.canonical, e.as);
      }
    }
    // Highest priority first, then longest; keep those not overlapping a kept one.
    spans.sort((a, b) => a.prio - b.prio || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
    const kept: Span[] = [];
    for (const s of spans) if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
    return kept.sort((a, b) => a.start - b.start);
  }

  /** Replace every sensitive value in a plain string with its placeholder. */
  pseudonymizeText(text: string): string {
    if (typeof text !== 'string' || !text) return text;
    const spans = this.detect(text);
    if (!spans.length) return text;
    let out = '';
    let at = 0;
    for (const s of spans) {
      out += text.slice(at, s.start) + this.map.placeholderFor(s.family, s.value ?? text.slice(s.start, s.end), s.fixed);
      at = s.end;
    }
    return out + text.slice(at);
  }

  /** Pseudonymize every string VALUE in a JSON value (keys untouched). */
  private deepPseudo(v: Json): Json {
    if (typeof v === 'string') return this.pseudonymizeText(v);
    if (Array.isArray(v)) { let ch = false; const a = v.map((x) => { const y = this.deepPseudo(x); if (y !== x) ch = true; return y; }); return ch ? a : v; }
    if (isObj(v)) {
      let ch = false;
      const o: Obj = {};
      for (const [k, x] of Object.entries(v)) { const y = this.deepPseudo(x); if (y !== x) ch = true; o[k] = y; }
      return ch ? o : v;
    }
    return v;
  }

  /** A JSON-text string (tool arguments): parse, rewrite values, re-serialize.
   *  Unchanged when nothing was found; raw text pass when it isn't JSON. */
  private pseudoJsonText(s: string): string {
    try {
      const parsed = JSON.parse(s);
      const next = this.deepPseudo(parsed);
      return next === parsed ? s : JSON.stringify(next);
    } catch {
      return this.pseudonymizeText(s);
    }
  }

  /**
   * Rewrite a parsed request body for the given API. Returns a new object; the
   * input is not mutated. Only text-bearing string values change.
   */
  rewriteRequest<T>(body: T, api: ApiFlavor): T {
    if (!isObj(body)) return body;
    return this.walkBody(structuredCloneJson(body), api, 'request') as T;
  }

  // ── restore ──

  private getMatcher(): Matcher {
    if (this.matcher && this.matcher.version === this.map.version) return this.matcher;
    const lookup = new Map<string, Entry>();
    for (const e of this.map.entries() as Entry[]) {
      lookup.set(e.placeholder, e);
      // `[ORG_1]` is also restored when the model drops the brackets.
      const bare = /^\[([A-Z][A-Z0-9]*_\d+)\]$/.exec(e.placeholder);
      if (bare && !lookup.has(bare[1])) lookup.set(bare[1], e);
    }
    const keys = [...lookup.keys()].sort((a, b) => b.length - a.length);
    const prefixes = new Set<string>();
    for (const k of keys) for (let i = 1; i <= k.length; i++) prefixes.add(k.slice(0, i));
    this.matcher = {
      version: this.map.version,
      re: keys.length ? new RegExp(keys.map(escapeRe).join('|'), 'g') : null,
      lookup,
      prefixes,
      maxLen: keys.length ? keys[0].length : 0
    };
    return this.matcher;
  }

  /**
   * Restore placeholders in `text`, using `ctx` (text before it) for the left
   * boundary. Matches must end at or before `limit`; one that would cross it
   * pulls `limit` back to its start. Returns the restored text up to `limit`.
   */
  private restoreSegment(ctx: string, text: string, limit: number, escaped: boolean): { out: string; consumed: number } {
    const m = this.getMatcher();
    if (!m.re) return { out: text.slice(0, limit), consumed: limit };
    const full = ctx + text;
    const base = ctx.length;
    const re = new RegExp(m.re.source, 'g');
    const hits: Array<{ s: number; e: number; value: string }> = [];
    let found: RegExpExecArray | null;
    re.lastIndex = base;
    while ((found = re.exec(full))) {
      const s = found.index;
      const e = s + found[0].length;
      const entry = m.lookup.get(found[0])!;
      if (this.boundaryOk(full, s, e, found[0], entry, escaped)) {
        hits.push({ s: s - base, e: e - base, value: entry.value });
        re.lastIndex = e;
      } else {
        re.lastIndex = s + 1;
      }
    }
    let cut = limit;
    for (const h of hits) if (h.s < cut && h.e > cut) cut = h.s;
    let out = '';
    let at = 0;
    for (const h of hits) {
      if (h.e > cut) break;
      out += text.slice(at, h.s) + (escaped ? JSON.stringify(h.value).slice(1, -1) : h.value);
      at = h.e;
    }
    return { out: out + text.slice(at, cut), consumed: cut };
  }

  private boundaryOk(full: string, s: number, e: number, key: string, entry: Entry, escaped: boolean): boolean {
    if (key.startsWith('[')) return true;
    const prev = s > 0 ? full[s - 1] : '';
    if (prev) {
      const strict = entry.family === 'ip' || entry.family === 'email';
      const blocked = WORD.test(prev) || (strict && /[.+-]/.test(prev));
      if (blocked && !(escaped && isEscapeTail(full, s - 1))) return false;
    }
    const next = full[e] ?? '';
    if (next && WORD.test(next)) return false;
    if (entry.family === 'ip' && next === '.' && /\d/.test(full[e + 1] ?? '')) return false;
    return true;
  }

  /** Restore placeholders in a complete string. `jsonEscaped`: the string is
   *  the inside of a JSON text (tool arguments), so values are escaped. */
  restoreText(text: string, opts: { jsonEscaped?: boolean } = {}): string {
    if (typeof text !== 'string' || !text || !this.map.size) return text;
    return this.restoreSegment('', text, text.length, !!opts.jsonEscaped).out;
  }

  /** Restore every string value in a JSON value. */
  private deepRestore(v: Json): Json {
    if (typeof v === 'string') return this.restoreText(v);
    if (Array.isArray(v)) { let ch = false; const a = v.map((x) => { const y = this.deepRestore(x); if (y !== x) ch = true; return y; }); return ch ? a : v; }
    if (isObj(v)) {
      let ch = false;
      const o: Obj = {};
      for (const [k, x] of Object.entries(v)) { const y = this.deepRestore(x); if (y !== x) ch = true; o[k] = y; }
      return ch ? o : v;
    }
    return v;
  }

  /** Restore a parsed (non-streaming) response body. Returns a new object. */
  restoreResponse<T>(body: T, api: ApiFlavor): T {
    if (!isObj(body) || !this.map.size) return body;
    return this.walkBody(structuredCloneJson(body), api, 'response') as T;
  }

  /** A streaming SSE restorer for one response. */
  createStreamRestorer(): SseRestorer {
    return new SseRestorer(this);
  }

  /** @internal A per-content-stream holdback restorer. */
  textStream(escaped: boolean): TextStreamRestorer {
    return new TextStreamRestorer(this, escaped);
  }

  /** @internal Used by TextStreamRestorer. */
  _holdbackStart(text: string): number {
    const m = this.getMatcher();
    for (let s = Math.max(0, text.length - m.maxLen); s < text.length; s++) if (m.prefixes.has(text.slice(s))) return s;
    return text.length;
  }

  /** @internal */
  _restoreSegment(ctx: string, text: string, limit: number, escaped: boolean): { out: string; consumed: number } {
    return this.restoreSegment(ctx, text, limit, escaped);
  }

  // ── body walkers (request: pseudonymize; response: restore) ──

  private walkBody(b: Obj, api: ApiFlavor, dir: 'request' | 'response'): Obj {
    const txt = (s: unknown): unknown => (typeof s !== 'string' ? s : dir === 'request' ? this.pseudonymizeText(s) : this.restoreText(s));
    const jsonText = (s: unknown): unknown => (typeof s !== 'string' ? s : dir === 'request' ? this.pseudoJsonText(s) : this.restoreText(s, { jsonEscaped: true }));
    const deep = (v: unknown): unknown => (dir === 'request' ? this.deepPseudo(v) : this.deepRestore(v));
    // Text parts in a content array (any API): only `text` of text-like parts.
    const parts = (content: unknown): unknown => {
      if (typeof content === 'string') return txt(content);
      if (!Array.isArray(content)) return content;
      for (const p of content) {
        if (!isObj(p)) continue;
        if (typeof p.text === 'string' && (p.type === 'text' || p.type === 'input_text' || p.type === 'output_text')) p.text = txt(p.text);
        else if (p.type === 'tool_use' && 'input' in p) p.input = deep(p.input);
        else if (p.type === 'tool_result' && 'content' in p) p.content = parts(p.content);
      }
      return content;
    };

    if (api === 'anthropic') {
      if (dir === 'request') {
        if ('system' in b) b.system = parts(b.system);
        if (Array.isArray(b.messages)) for (const m of b.messages) if (isObj(m) && 'content' in m) m.content = parts(m.content);
      } else if (Array.isArray(b.content)) {
        parts(b.content);
      }
      return b;
    }

    if (api === 'openai-chat') {
      const msg = (m: unknown): void => {
        if (!isObj(m)) return;
        if ('content' in m) m.content = parts(m.content);
        if (Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) if (isObj(tc) && isObj(tc.function) && 'arguments' in tc.function) tc.function.arguments = jsonText(tc.function.arguments);
        }
      };
      if (dir === 'request') { if (Array.isArray(b.messages)) b.messages.forEach(msg); } else if (Array.isArray(b.choices)) {
        for (const c of b.choices) if (isObj(c)) msg(c.message);
      }
      return b;
    }

    // openai-responses
    const item = (it: unknown): void => {
      if (!isObj(it)) return;
      if ('content' in it && (it.type === 'message' || it.type === undefined)) it.content = parts(it.content);
      if (it.type === 'function_call' && 'arguments' in it) it.arguments = jsonText(it.arguments);
      if (it.type === 'function_call_output' && 'output' in it) it.output = parts(it.output);
    };
    if (dir === 'request') {
      if ('instructions' in b) b.instructions = txt(b.instructions);
      if (typeof b.input === 'string') b.input = txt(b.input);
      else if (Array.isArray(b.input)) b.input.forEach(item);
    } else {
      if (Array.isArray(b.output)) b.output.forEach(item);
      if (typeof b.output_text === 'string') b.output_text = txt(b.output_text);
    }
    return b;
  }

  /** @internal Restore a Responses output item / content part in place. */
  _restoreResponsesPiece(kind: 'item' | 'part' | 'response', v: unknown): void {
    if (!isObj(v)) return;
    if (kind === 'response') { this.walkBody(v, 'openai-responses', 'response'); return; }
    if (kind === 'part') { if (typeof v.text === 'string' && v.type === 'output_text') v.text = this.restoreText(v.text); return; }
    this.walkBody({ output: [v] }, 'openai-responses', 'response');
  }

  /** @internal Restore an Anthropic content block (content_block_start) in place. */
  _restoreAnthropicBlock(block: unknown): void {
    if (isObj(block)) this.walkBody({ content: [block] }, 'anthropic', 'response');
  }
}

function structuredCloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ─── streaming ──────────────────────────────────────────────────────────────

/**
 * One content stream (a text block, a tool call's arguments): restores what
 * is safe and holds back a tail that may still be the start of a placeholder.
 */
export class TextStreamRestorer {
  private buf = '';
  /** Raw text already released, for the left boundary of the next match. */
  private ctx = '';

  constructor(private anon: Anonymizer, private escaped: boolean) {}

  push(piece: string): string {
    this.buf += piece;
    return this.drain(false);
  }

  /** Release everything held (end of the content stream). */
  flush(): string {
    return this.drain(true);
  }

  get held(): string { return this.buf; }

  private drain(final: boolean): string {
    if (!this.buf) return '';
    const limit = final ? this.buf.length : this.anon._holdbackStart(this.buf);
    const { out, consumed } = this.anon._restoreSegment(this.ctx, this.buf, limit, this.escaped);
    this.ctx = (this.ctx + this.buf.slice(0, consumed)).slice(-16);
    this.buf = this.buf.slice(consumed);
    return out;
  }
}

interface StreamState {
  r: TextStreamRestorer;
  /** How to emit a synthetic delta carrying held text. */
  synth: (held: string) => { event?: string; data: Obj };
}

interface SseEvent { lines: string[]; eol: string }

/**
 * Restores placeholders in a Server-Sent Events response, chunk by chunk.
 * Feed raw chunks (Buffer/Uint8Array or string) to `push`, write what it
 * returns; call `end` when upstream ends. Handles chunk boundaries anywhere
 * (inside a line, an event, a UTF-8 sequence or a placeholder).
 *
 * Restores Anthropic text_delta / input_json_delta, OpenAI Chat delta.content
 * and tool_calls arguments, Responses output_text / function_call_arguments
 * deltas (and the full texts in their `done` events). Events it doesn't touch
 * pass through byte for byte; thinking is never touched (it is signed).
 */
export class SseRestorer {
  private decoder = new TextDecoder('utf-8');
  private pending = '';
  private cur: string[] = [];
  private streams = new Map<string, StreamState>();
  private eol = '\n';

  constructor(private anon: Anonymizer) {}

  push(chunk: Uint8Array | string): string {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.consume(text, false);
  }

  end(): string {
    let out = this.consume(this.decoder.decode(), true);
    if (this.cur.length) { out += this.dispatch(this.cur); this.cur = []; }
    out += this.flushStreams(() => true);
    return out;
  }

  private consume(text: string, final: boolean): string {
    this.pending += text;
    let out = '';
    let i = 0;
    const p = this.pending;
    let lineStart = 0;
    while (i < p.length) {
      const ch = p[i];
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 >= p.length && !final) break; // may be \r\n
        const term = ch === '\r' && p[i + 1] === '\n' ? '\r\n' : ch;
        const line = p.slice(lineStart, i);
        this.cur.push(line + term);
        i += term.length;
        lineStart = i;
        if (line === '') { this.eol = term; out += this.dispatch(this.cur); this.cur = []; }
        continue;
      }
      i++;
    }
    this.pending = p.slice(lineStart);
    if (final && this.pending) { this.cur.push(this.pending); this.pending = ''; }
    return out;
  }

  private stream(key: string, escaped: boolean, synth: StreamState['synth']): StreamState {
    let s = this.streams.get(key);
    if (!s) { s = { r: this.anon.textStream(escaped), synth }; this.streams.set(key, s); }
    return s;
  }

  private serialize(ev: { event?: string; data: Obj }): string {
    return (ev.event ? `event: ${ev.event}${this.eol}` : '') + `data: ${JSON.stringify(ev.data)}${this.eol}${this.eol}`;
  }

  /** Synthetic deltas for held text of matching streams (and forget them). */
  private flushStreams(pick: (key: string) => boolean): string {
    let out = '';
    for (const [key, s] of [...this.streams]) {
      if (!pick(key)) continue;
      const held = s.r.flush();
      if (held) out += this.serialize(s.synth(held));
      this.streams.delete(key);
    }
    return out;
  }

  private rebuild(raw: string[], data: Obj): string {
    const kept = raw.filter((l) => !/^data(?::|\r?\n|\r|$)/.test(l));
    const blank = kept.length && /^(\r\n|\n|\r)?$/.test(kept[kept.length - 1]) ? kept.pop()! : '';
    const eol = (raw.find((l) => l.startsWith('data'))?.match(/(\r\n|\n|\r)$/)?.[0]) ?? this.eol;
    return kept.join('') + `data: ${JSON.stringify(data)}${eol}` + blank;
  }

  private dispatch(raw: string[]): string {
    const passthrough = raw.join('');
    let eventName: string | undefined;
    const data: string[] = [];
    for (const l of raw) {
      const line = l.replace(/(\r\n|\n|\r)$/, '');
      if (!line || line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c === -1 ? line : line.slice(0, c);
      let value = c === -1 ? '' : line.slice(c + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') eventName = value;
    }
    if (!data.length) return passthrough;
    const payload = data.join('\n');
    if (payload.trim() === '[DONE]') return this.flushStreams(() => true) + passthrough;
    let obj: unknown;
    try { obj = JSON.parse(payload); } catch { return passthrough; }
    if (!isObj(obj) || !this.anon.map.size) return passthrough;
    const res = this.handle(obj, eventName);
    if (res.drop) return res.before;
    return res.before + (res.changed ? this.rebuild(raw, obj) : passthrough);
  }

  private handle(o: Obj, eventName: string | undefined): { before: string; changed: boolean; drop?: boolean } {
    const type = typeof o.type === 'string' ? o.type : '';

    // ── Anthropic Messages ──
    if (type === 'content_block_delta' && isObj(o.delta)) {
      const d = o.delta;
      const idx = o.index;
      const field = d.type === 'text_delta' ? 'text' : d.type === 'input_json_delta' ? 'partial_json' : null;
      if (!field || typeof d[field] !== 'string') return { before: '', changed: false };
      const dtype = d.type as string;
      const s = this.stream(`a:${idx}`, field === 'partial_json', (held) => ({ event: eventName ?? 'content_block_delta', data: { type: 'content_block_delta', index: idx, delta: { type: dtype, [field]: held } } }));
      const before = d[field] as string;
      const out = s.r.push(before);
      if (out === before) return { before: '', changed: false };
      if (!out) return { before: '', changed: false, drop: true };
      d[field] = out;
      return { before: '', changed: true };
    }
    if (type === 'content_block_stop') return { before: this.flushStreams((k) => k === `a:${o.index}`), changed: false };
    if (type === 'message_stop') return { before: this.flushStreams(() => true), changed: false };
    if (type === 'content_block_start' && isObj(o.content_block)) {
      const was = JSON.stringify(o.content_block);
      this.anon._restoreAnthropicBlock(o.content_block);
      return { before: '', changed: JSON.stringify(o.content_block) !== was };
    }

    // ── OpenAI Responses ──
    if (type.startsWith('response.')) {
      if ((type === 'response.output_text.delta' || type === 'response.function_call_arguments.delta') && typeof o.delta === 'string') {
        const isText = type === 'response.output_text.delta';
        const key = isText ? `r:${o.item_id}:${o.output_index}:${o.content_index}` : `f:${o.item_id}:${o.output_index}`;
        const ids: Obj = {};
        for (const k of ['item_id', 'output_index', 'content_index']) if (k in o) ids[k] = o[k];
        const s = this.stream(key, !isText, (held) => ({ event: eventName ? type : undefined, data: { type, ...ids, delta: held } }));
        const before = o.delta;
        const out = s.r.push(before);
        if (out === before) return { before: '', changed: false };
        o.delta = out;
        return { before: '', changed: true };
      }
      const was = JSON.stringify(o);
      let flushed = '';
      if (type === 'response.output_text.done') {
        flushed = this.flushStreams((k) => k === `r:${o.item_id}:${o.output_index}:${o.content_index}`);
        if (typeof o.text === 'string') o.text = this.anon.restoreText(o.text);
      } else if (type === 'response.function_call_arguments.done') {
        flushed = this.flushStreams((k) => k === `f:${o.item_id}:${o.output_index}`);
        if (typeof o.arguments === 'string') o.arguments = this.anon.restoreText(o.arguments, { jsonEscaped: true });
      } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        flushed = this.flushStreams(() => true);
      }
      if ('part' in o) this.anon._restoreResponsesPiece('part', o.part);
      if ('item' in o) this.anon._restoreResponsesPiece('item', o.item);
      if ('response' in o) this.anon._restoreResponsesPiece('response', o.response);
      return { before: flushed, changed: JSON.stringify(o) !== was };
    }

    // ── OpenAI Chat Completions ──
    if (Array.isArray(o.choices)) {
      let changed = false;
      let before = '';
      for (const c of o.choices) {
        if (!isObj(c)) continue;
        const ci = c.index ?? 0;
        const d = isObj(c.delta) ? c.delta : null;
        const finishing = c.finish_reason != null;
        const touched = new Set<string>();
        const shell = (): Obj => { const t: Obj = {}; for (const [k, v] of Object.entries(o)) if (k !== 'choices' && k !== 'usage') t[k] = v; return t; };
        if (d && typeof d.content === 'string') {
          const key = `c:${ci}`;
          touched.add(key);
          const s = this.stream(key, false, (held) => ({ data: { ...shell(), choices: [{ index: ci, delta: { content: held }, finish_reason: null }] } }));
          const was = d.content;
          let out = s.r.push(was);
          if (finishing) { out += s.r.flush(); this.streams.delete(key); }
          if (out !== was) { d.content = out; changed = true; }
        }
        if (d && Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            if (!isObj(tc) || !isObj(tc.function) || typeof tc.function.arguments !== 'string') continue;
            const ti = tc.index ?? 0;
            const key = `t:${ci}:${ti}`;
            touched.add(key);
            const s = this.stream(key, true, (held) => ({ data: { ...shell(), choices: [{ index: ci, delta: { tool_calls: [{ index: ti, function: { arguments: held } }] }, finish_reason: null }] } }));
            const fn = tc.function;
            const was = fn.arguments as string;
            let out = s.r.push(was);
            if (finishing) { out += s.r.flush(); this.streams.delete(key); }
            if (out !== was) { fn.arguments = out; changed = true; }
          }
        }
        if (finishing) before += this.flushStreams((k) => !touched.has(k) && (k === `c:${ci}` || k.startsWith(`t:${ci}:`)));
        if (isObj(c.message)) {
          const was = JSON.stringify(c.message);
          const restored = this.anon.restoreResponse({ choices: [{ message: c.message }] }, 'openai-chat') as { choices: Array<{ message: unknown }> };
          c.message = restored.choices[0].message;
          if (JSON.stringify(c.message) !== was) changed = true;
        }
      }
      return { before, changed };
    }

    return { before: '', changed: false };
  }
}
