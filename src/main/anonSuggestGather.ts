/**
 * Gathers the facts for anonymization suggestions (shared/anonSuggest.ts),
 * locally and on the human's request: git remotes and emails from the
 * office's repos' .git/config and the user's ~/.gitconfig, config files in
 * the repos' roots (and config/), .env variable names, ticket keys on the
 * office's tasks, and Jira projects / Confluence spaces through the office's
 * own connections (the same auth path as "Test connection"; no model call).
 *
 * Secret values are never returned: an .env variable whose name looks secret
 * is reported by name; envSecretValue reads it only when the human accepts it.
 *
 * Electron-free: the connections' auth is injected.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, isAbsolute } from 'node:path';
import { envValue, parseEnvFile, type SuggestSources } from '../shared/anonSuggest';

export interface GatherConnection {
  label: string;
  baseUrl: string;
  /** The auth headers for it (built in main from the encrypted secret). */
  headers: () => Record<string, string>;
}

export interface GatherDeps {
  repos: string[];
  home: string;
  connections: GatherConnection[];
  ticketKeys: string[];
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

const MAX_FILE = 256 * 1024;
const CONFIG_FILE = /^(?:.*\.(?:json|ya?ml|toml|ini|properties|conf|cfg|xml)|docker-compose.*|Dockerfile|\.npmrc|\.pypirc|\.gitmodules|nginx\.conf)$/i;
const SKIP_FILE = /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|tsconfig.*\.json|\.eslintrc.*|\.prettierrc.*)$/i;
const ENV_FILE = /^\.env(?:\..+)?$/;

function readSmall(p: string): string | null {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    return readFileSync(p, 'utf8');
  } catch { return null; }
}

/** The repo's git config file (a worktree's .git is a file pointing elsewhere). */
function gitConfigPath(repo: string): string | null {
  const dotGit = join(repo, '.git');
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return join(dotGit, 'config');
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : join(repo, m[1].trim());
    const common = readSmall(join(gitdir, 'commondir'));
    return join(common ? (isAbsolute(common.trim()) ? common.trim() : join(gitdir, common.trim())) : gitdir, 'config');
  } catch { return null; }
}

/** `url = …` and `email = …` values of a git config file. */
export function parseGitConfig(text: string): { urls: string[]; emails: string[] } {
  const urls: string[] = [];
  const emails: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(url|pushurl|email)\s*=\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === 'email') emails.push(m[2]); else urls.push(m[2]);
  }
  return { urls, emails };
}

async function defaultFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, { headers: { accept: 'application/json', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) { void r.body?.cancel().catch(() => undefined); throw new Error(`HTTP ${r.status}`); }
  return r.json();
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});

export async function gatherSuggestSources(d: GatherDeps): Promise<{ sources: SuggestSources; envFiles: Record<string, string>; notes: string[] }> {
  const notes: string[] = [];
  const gitRemotes = new Set<string>();
  const emails = new Set<string>();
  const configTexts: Array<{ file: string; text: string }> = [];
  const envVars: NonNullable<SuggestSources['envVars']> = [];
  /** Suggestion file label → absolute path, for reading a value on accept. */
  const envFiles: Record<string, string> = {};

  const home = readSmall(join(d.home, '.gitconfig'));
  if (home) for (const e of parseGitConfig(home).emails) emails.add(e);

  for (const repo of [...new Set(d.repos)].slice(0, 40)) {
    const cfg = gitConfigPath(repo);
    const text = cfg ? readSmall(cfg) : null;
    if (text) { const g = parseGitConfig(text); g.urls.forEach((u) => gitRemotes.add(u)); g.emails.forEach((e) => emails.add(e)); }
    const label = basename(repo);
    for (const dir of [repo, join(repo, 'config')]) {
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names.slice(0, 300)) {
        const p = join(dir, name);
        const rel = `${label}/${dir === repo ? '' : 'config/'}${name}`;
        if (ENV_FILE.test(name)) {
          const t = readSmall(p);
          if (t === null) continue;
          envFiles[rel] = p;
          for (const v of parseEnvFile(t)) envVars.push({ file: rel, name: v.name, hosts: v.hosts });
        } else if (CONFIG_FILE.test(name) && !SKIP_FILE.test(name) && configTexts.length < 80) {
          const t = readSmall(p);
          if (t !== null) configTexts.push({ file: rel, text: t });
        }
      }
    }
  }

  // Jira projects and Confluence spaces through the office's own connections.
  const fetchJson = d.fetchJson ?? defaultFetchJson;
  const jiraProjects: NonNullable<SuggestSources['jiraProjects']> = [];
  const confluenceSpaces: NonNullable<SuggestSources['confluenceSpaces']> = [];
  for (const c of d.connections) {
    let url: URL;
    try { url = new URL(c.baseUrl); } catch { continue; }
    if (/your-domain/i.test(url.hostname)) continue;
    const base = c.baseUrl.replace(/\/+$/, '');
    const isJira = /\/rest\/api\/[23]$/.test(base) && !/\/wiki\//.test(base);
    const isConfluence = /\/wiki\/api\/v2$/.test(base) || (/\/rest\/api$/.test(base) && /confluence|wiki/i.test(`${c.label} ${url.hostname}`));
    if (!isJira && !isConfluence) continue;
    try {
      if (isJira) {
        const cloud = base.endsWith('/3');
        const j = await fetchJson(`${base}/${cloud ? 'project/search?maxResults=100' : 'project'}`, c.headers());
        const list = cloud ? asArray(obj(j).values) : asArray(j);
        for (const p of list) { const o = obj(p); if (typeof o.key === 'string') jiraProjects.push({ key: o.key, name: typeof o.name === 'string' ? o.name : undefined, site: url.hostname }); }
      } else {
        const v2 = base.endsWith('/v2');
        const j = await fetchJson(`${base}/${v2 ? 'spaces?limit=100' : 'space?limit=100'}`, c.headers());
        for (const s of asArray(v2 ? obj(j).results : obj(j).results)) { const o = obj(s); if (typeof o.name === 'string') confluenceSpaces.push({ name: o.name, key: typeof o.key === 'string' ? o.key : undefined, site: url.hostname }); }
      }
    } catch (e) {
      notes.push(`${c.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    sources: {
      gitRemotes: [...gitRemotes],
      emails: [...emails],
      configTexts,
      envVars,
      ticketKeys: d.ticketKeys,
      connectionUrls: d.connections.map((c) => c.baseUrl),
      jiraProjects,
      confluenceSpaces
    },
    envFiles,
    notes
  };
}

/** The value of one .env variable, read when the human accepts it as a known secret. */
export function envSecretValue(path: string, name: string): string | undefined {
  const t = readSmall(path);
  return t === null ? undefined : envValue(t, name);
}

