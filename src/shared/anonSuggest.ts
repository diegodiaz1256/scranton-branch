/**
 * Dictionary suggestions for anonymization, found locally: no model is ever
 * asked. Main gathers the raw facts (anonSuggestGather in index.ts) and this
 * turns them into proposed entries with a category and a codename already
 * filled in; the human ticks the ones to keep.
 *
 * Sources: Jira project keys and names, Confluence spaces (through the
 * office's own connections), git remotes of the office's repos (org/repo,
 * self-hosted git hosts), the human's email domains, internal hostnames in
 * the office's config files, and ticket keys on the office's tasks. Secret
 * VALUES are never part of a suggestion: an .env variable that looks secret is
 * offered by file and name only, and main reads its value only when the human
 * accepts it as a known secret.
 *
 * Pure: no electron, no node.
 */
import type { TermCategory } from './anonymize';
import type { AnonDictionary, AnonDictionaryEntry } from './anonSettings';

export interface SuggestSources {
  jiraProjects?: Array<{ key: string; name?: string; site?: string }>;
  confluenceSpaces?: Array<{ key?: string; name: string; site?: string }>;
  /** Base URLs of the office's connections (REST APIs, MCP servers). */
  connectionUrls?: string[];
  /** Remote URLs of the office's repos (`git@host:org/repo.git`, https…). */
  gitRemotes?: string[];
  /** The human's email addresses (git user.email…). */
  emails?: string[];
  /** Text of the office's config files (no .env: see envNames). */
  configTexts?: Array<{ file: string; text: string }>;
  /** .env variables: file and name, and the hosts in non-secret values. */
  envVars?: Array<{ file: string; name: string; hosts: string[] }>;
  /** Ticket keys on the office's tasks. */
  ticketKeys?: string[];
}

export type SuggestionSource = 'jira' | 'confluence' | 'git' | 'email' | 'config' | 'env' | 'tasks' | 'connection';

export type AnonSuggestion =
  | { id: string; kind: 'term'; entry: AnonDictionaryEntry; source: SuggestionSource; from: string }
  | { id: string; kind: 'ticketPrefix'; prefix: string; source: SuggestionSource; from: string }
  /** A secret-looking .env variable: name and file only, never its value. */
  | { id: string; kind: 'envSecret'; file: string; name: string; source: 'env'; from: string };

/** Hosts nobody needs hidden: public code hosts, mail providers, registries. */
const PUBLIC_DOMAINS = new Set([
  'github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com', 'visualstudio.com', 'azure.com', 'codeberg.org', 'sourceforge.net',
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'aol.com', 'gmx.com', 'gmx.de', 'gmx.es', 'yandex.com', 'mail.com', 'zoho.com', 'hey.com', 'fastmail.com',
  'noreply.github.com', 'users.noreply.github.com',
  'atlassian.net', 'atlassian.com', 'jira.com', 'slack.com', 'notion.so', 'linear.app',
  'npmjs.org', 'npmjs.com', 'yarnpkg.com', 'pypi.org', 'pythonhosted.org', 'docker.com', 'docker.io', 'googleapis.com', 'google.com', 'gstatic.com',
  'microsoft.com', 'windows.net', 'amazonaws.com', 'cloudfront.net', 'cloudflare.com', 'heroku.com', 'herokuapp.com', 'vercel.app', 'netlify.app',
  'anthropic.com', 'openai.com', 'example.com', 'example.org', 'example.net', 'localhost', 'schema.org', 'w3.org', 'json-schema.org', 'mozilla.org',
  'apache.org', 'nodejs.org', 'reactjs.org', 'jsdelivr.net', 'unpkg.com', 'cdnjs.com', 'sentry.io', 'datadoghq.com', 'stripe.com', 'twilio.com'
]);
const PUBLIC_GIT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com', 'ssh.dev.azure.com', 'vs-ssh.visualstudio.com', 'codeberg.org']);
/** TLDs only an internal network uses. */
const INTERNAL_TLDS = new Set(['local', 'internal', 'corp', 'lan', 'intranet', 'private', 'localdomain', 'home', 'test', 'priv']);
/** Second-level labels under a country code (acme.co.uk → three labels). */
const SLD = new Set(['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'gob', 'or', 'ne']);
/** Variable names whose value is a secret. */
export const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PASS|CREDENTIAL|PRIVATE|AUTH|COOKIE|SESSION|SIGNATURE|SALT|DSN)/i;

const NATO = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima', 'Mike',
  'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu'];
const WORD: Record<TermCategory, string> = {
  person: 'Person', company: 'Company', customer: 'Customer', system: 'System', project: 'Project', team: 'Team',
  product: 'Product', 'process-step': 'Step', domain: 'domain', other: 'Term'
};

/** The registrable part of a host ("db.eu.acme.co.uk" → "acme.co.uk"). */
export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const n = labels.length;
  const take = labels[n - 1].length === 2 && SLD.has(labels[n - 2]) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const isPublic = (host: string): boolean => {
  const h = host.toLowerCase();
  if (PUBLIC_DOMAINS.has(h)) return true;
  for (const d of PUBLIC_DOMAINS) if (h.endsWith(`.${d}`)) return true;
  return false;
};

const isIp = (h: string): boolean => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(':');

/** Host of a git remote (scp-like, ssh://, https://). */
export function parseGitRemote(url: string): { host: string; path: string[] } | null {
  const u = url.trim();
  let host = '';
  let path = '';
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { const p = new URL(u); host = p.hostname; path = p.pathname; } catch { return null; }
  } else if (scp) { host = scp[1]; path = scp[2]; } else return null;
  const parts = path.replace(/\.git$/, '').split('/').filter(Boolean);
  // Azure DevOps: v3/<org>/<project>/<repo> (ssh) or <org>/<project>/_git/<repo>.
  const clean = parts.filter((p) => p !== '_git' && p !== 'v3');
  return host ? { host: host.toLowerCase(), path: clean } : null;
}

/** Hostnames in a text (URLs, host: values, bare FQDNs). */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  const re = /(?<![\w.@-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62})(?![\w-]|\.[a-z0-9])/gi;
  for (const m of text.matchAll(re)) {
    const h = m[1].toLowerCase();
    // File names and code (package.json, index.ts, foo.bar.baz()) are not hosts.
    if (/\.(?:json|ya?ml|toml|ini|js|ts|tsx|jsx|mjs|cjs|py|rb|go|rs|java|kt|cs|md|txt|lock|html?|css|scss|png|jpe?g|svg|gif|sh|ps1|cfg|conf|env|xml|properties|log|exe|dll|so)$/.test(h)) continue;
    out.add(h);
  }
  return [...out];
}

const titleCase = (s: string): string => s.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The suggestions from what main found, minus what the dictionary already
 * has. Codenames are "<Category> <NATO word>", distinct from each other, from
 * the dictionary's own and from the generated "<Category> <letter><n>" ones.
 */
export function suggestEntries(src: SuggestSources, dict: AnonDictionary): AnonSuggestion[] {
  const known = new Set<string>();
  for (const t of dict.terms) { known.add(t.term.toLowerCase()); for (const a of t.aliases ?? []) known.add(a.toLowerCase()); }
  const knownPrefixes = new Set(dict.ticketPrefixes.map((p) => p.toUpperCase()));
  const usedAs = new Set(dict.terms.map((t) => (t.as ?? '').toLowerCase()).filter(Boolean));
  const counters: Partial<Record<TermCategory, number>> = {};
  const codename = (cat: TermCategory): string | undefined => {
    if (cat === 'domain') return undefined;
    for (;;) {
      const n = counters[cat] ?? 0;
      counters[cat] = n + 1;
      const word = NATO[n % NATO.length] + (n >= NATO.length ? ` ${Math.floor(n / NATO.length) + 1}` : '');
      const name = `${WORD[cat]} ${word}`;
      if (!usedAs.has(name.toLowerCase())) { usedAs.add(name.toLowerCase()); return name; }
    }
  };
  const out: AnonSuggestion[] = [];
  const seen = new Set<string>();
  const term = (value: string, category: TermCategory, source: SuggestionSource, from: string, aliases: string[] = []): void => {
    const v = value.trim();
    if (v.length < 3 || v.length > 120) return;
    const key = v.toLowerCase();
    if (known.has(key) || seen.has(key)) return;
    seen.add(key);
    const al = [...new Set(aliases.map((a) => a.trim()).filter((a) => a.length >= 3 && a.toLowerCase() !== key && !known.has(a.toLowerCase()) && !seen.has(a.toLowerCase())))];
    for (const a of al) seen.add(a.toLowerCase());
    const as = codename(category);
    out.push({ id: `term:${category}:${key}`, kind: 'term', entry: { term: v, category, ...(al.length ? { aliases: al } : {}), ...(as ? { as } : {}) }, source, from });
  };
  const prefix = (p: string, source: SuggestionSource, from: string): void => {
    const up = p.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,19}$/.test(up) || knownPrefixes.has(up) || seen.has(`prefix:${up}`)) return;
    seen.add(`prefix:${up}`);
    out.push({ id: `prefix:${up}`, kind: 'ticketPrefix', prefix: up, source, from });
  };
  const domain = (host: string, source: SuggestionSource, from: string): void => {
    const h = host.toLowerCase();
    if (!h.includes('.') || isIp(h) || isPublic(h)) return;
    const tld = h.split('.').pop()!;
    term(INTERNAL_TLDS.has(tld) ? h.split('.').slice(-2).join('.') : registrableDomain(h), 'domain', source, from);
  };

  // The organisation's own domains: email, self-hosted git, connections.
  const ownDomains = new Set<string>();
  for (const e of src.emails ?? []) {
    const d = e.split('@')[1]?.trim().toLowerCase();
    if (d && d.includes('.') && !isPublic(d)) { ownDomains.add(registrableDomain(d)); domain(d, 'email', e.replace(/^[^@]*/, '…')); }
  }
  for (const r of src.gitRemotes ?? []) {
    const g = parseGitRemote(r);
    if (!g) continue;
    const from = `${g.host}/${g.path.join('/')}`;
    if (!PUBLIC_GIT_HOSTS.has(g.host)) { ownDomains.add(registrableDomain(g.host)); domain(g.host, 'git', from); }
    if (g.path.length >= 2) {
      term(g.path[0], 'company', 'git', from, [titleCase(g.path[0])]);
      term(g.path[g.path.length - 1], 'project', 'git', from, [titleCase(g.path[g.path.length - 1])]);
    }
  }
  for (const u of src.connectionUrls ?? []) {
    let host = '';
    try { host = new URL(u).hostname.toLowerCase(); } catch { continue; }
    // <site>.atlassian.net: the site is the organisation's name.
    const site = /^([a-z0-9-]+)\.(?:atlassian\.net|jira\.com|slack\.com|zendesk\.com|freshdesk\.com|service-now\.com|sharepoint\.com|my\.salesforce\.com)$/.exec(host);
    if (site && site[1] !== 'your-domain') { term(site[1], 'company', 'connection', host, [titleCase(site[1])]); term(host, 'domain', 'connection', host); continue; }
    if (!isPublic(host) && !isIp(host)) { ownDomains.add(registrableDomain(host)); domain(host, 'connection', host); }
  }
  for (const p of src.jiraProjects ?? []) {
    const from = p.site ? `${p.site} ${p.key}` : p.key;
    prefix(p.key, 'jira', from);
    if (p.name) term(p.name, 'project', 'jira', from);
  }
  for (const s of src.confluenceSpaces ?? []) {
    // Personal spaces are named after people ("~jdoe"): skip.
    if (s.key?.startsWith('~')) continue;
    term(s.name, 'project', 'confluence', s.site ? `${s.site} ${s.key ?? ''}`.trim() : s.key ?? s.name, s.key && s.key.length >= 3 ? [s.key] : []);
  }
  for (const k of src.ticketKeys ?? []) {
    const m = /^([A-Z][A-Z0-9_]+)-\d+$/.exec(k.trim());
    if (m) prefix(m[1], 'tasks', k.trim());
  }
  // Internal hosts in config: an internal TLD, or under one of the organisation's own domains.
  const internal = (h: string): boolean => {
    if (!h.includes('.') || isIp(h) || isPublic(h)) return false;
    const tld = h.split('.').pop()!;
    return INTERNAL_TLDS.has(tld) || ownDomains.has(registrableDomain(h));
  };
  for (const c of src.configTexts ?? []) for (const h of hostsIn(c.text)) if (internal(h)) domain(h, 'config', c.file);
  for (const v of src.envVars ?? []) {
    for (const h of v.hosts) if (internal(h)) domain(h, 'env', `${v.file} ${v.name}`);
    if (SECRET_NAME.test(v.name)) {
      const id = `env:${v.file}:${v.name}`;
      if (!seen.has(id)) { seen.add(id); out.push({ id, kind: 'envSecret', file: v.file, name: v.name, source: 'env', from: v.file }); }
    }
  }
  return out;
}

/** An .env file's variables: names, and the hosts of values whose name is
 *  not secret-looking. A secret-looking variable's value is not looked at. */
export function parseEnvFile(text: string): Array<{ name: string; hosts: string[] }> {
  const out: Array<{ name: string; hosts: string[] }> = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (SECRET_NAME.test(name)) { out.push({ name, hosts: [] }); continue; }
    // Credentials inside a URL are dropped before looking for hosts.
    const value = m[2].replace(/:\/\/[^@\s/]*@/g, '://');
    out.push({ name, hosts: hostsIn(value) });
  }
  return out;
}

/** The value of one variable in an .env file (main, on the human's accept). */
export function envValue(text: string, name: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    return v || undefined;
  }
  return undefined;
}
