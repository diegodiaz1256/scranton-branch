/**
 * Your own MCP servers, and the ones already set up for other tools.
 *
 * Scans the MCP configs of Claude Code, Claude Desktop, Cursor, Codex, Gemini
 * CLI / Antigravity and Windsurf (read-only) so a server you already use there
 * can be imported here in one click, and keeps the ones you add by hand.
 *
 * Those configs usually hold API keys in plain text, in each server's env (or,
 * for a remote server, its headers). An imported or added server's secret env
 * values and headers go to the encrypted store (mcp:custom--<id>:<ENV>,
 * mcp:custom--<id>:header:<Name>) and the server is then reached through the
 * MCP gateway: a local one runs inside the app, a remote one is called by the
 * app with its headers added. Agents get a capability token, never the key
 * (mcpGateway.ts). A server with no secrets is handed to agents as is.
 *
 * Electron-free: file reads, config and the secret store are injected.
 */
import { join } from 'node:path';
import { suggestFor, type McpSuggestion } from '../shared/mcpSuggest';

export type McpTransport =
  | { kind: 'stdio'; command: string; args: string[] }
  | { kind: 'http'; url: string };

export interface FoundServer {
  /** Where it was found ("Claude Code", "Cursor"…). */
  source: string;
  /** The config file, for the UI. */
  file: string;
  name: string;
  transport: McpTransport;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Set when an agent's own folder holds it: the agent that can reach it. */
  agent?: string;
}

export interface CustomServer {
  id: string;
  name: string;
  transport: McpTransport;
  /** Non-secret env, kept in config. */
  env: Record<string, string>;
  /** Names of env vars whose values are in the encrypted store. */
  secretEnv: string[];
  /** Remote servers: non-secret headers, kept in config. */
  headers?: Record<string, string>;
  /** Remote servers: names of headers whose values are in the encrypted store. */
  secretHeaders?: string[];
  enabled: boolean;
  /** Agent ids; null = every agent. */
  agents: string[] | null;
  source?: string;
}

export interface McpServersDeps {
  readFile: (path: string) => string | null;
  home: string;
  /** %APPDATA% on Windows, ~/Library/Application Support on macOS, ~/.config on Linux. */
  appData: () => string;
  readCustom: () => CustomServer[];
  writeCustom: (list: CustomServer[]) => void;
  getSecret: (ref: string) => string | undefined;
  setSecret: (ref: string, value: string) => { ok: boolean; error?: string };
  deleteSecret: (ref: string) => void;
  /** Where agents run, so what they set up for themselves is found too. Unset → none. */
  agentPlaces?: () => Array<{ name: string; cwd: string; codexHome?: string }>;
  /** Other home folders whose tool settings agents read (a WSL distro's home). */
  extraHomes?: () => Array<{ label: string; home: string }>;
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL|PAT|PRIVATE)/i;
const SECRET_VALUE = /^(ghp_|gho_|github_pat_|sk-|sk_live_|sk_test_|xox[abp]-|AKIA|AIza|glpat-|ntn_|secret_)/;

/** Does this env var look like it holds a secret? */
export function looksSecret(name: string, value: string): boolean {
  return SECRET_NAME.test(name) || SECRET_VALUE.test(value) || /^(Bearer|Basic) \S+/.test(value) || /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);
}

export const customId = (name: string): string =>
  `custom--${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server'}`;
const secretRef = (id: string, env: string) => `mcp:${id}:${env}`;
const headerRef = (id: string, header: string) => `mcp:${id}:header:${header}`;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Set by the gateway itself or by the agent's own MCP client; never forwarded. */
const RESERVED_HEADERS = new Set(['host', 'content-type', 'content-length', 'accept', 'mcp-session-id', 'mcp-protocol-version']);

function strMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string')) as Record<string, string>;
}

/** One `mcpServers`-shaped object (Claude, Cursor, Gemini, Windsurf…). */
function fromMcpServers(obj: unknown, source: string, file: string): FoundServer[] {
  if (!obj || typeof obj !== 'object') return [];
  const out: FoundServer[] = [];
  for (const [name, raw] of Object.entries(obj as Record<string, unknown>)) {
    const s = raw as Record<string, unknown>;
    if (!s || typeof s !== 'object') continue;
    const url = typeof s.url === 'string' ? s.url : typeof s.serverUrl === 'string' ? s.serverUrl : typeof s.httpUrl === 'string' ? s.httpUrl : null;
    if (typeof s.command === 'string' && s.command.trim()) {
      out.push({ source, file, name, transport: { kind: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args.filter((a): a is string => typeof a === 'string') : [] }, env: strMap(s.env), headers: {} });
    } else if (url) {
      out.push({ source, file, name, transport: { kind: 'http', url }, env: strMap(s.env), headers: strMap(s.headers) });
    }
  }
  return out;
}

/** The [mcp_servers.*] tables of a Codex config.toml — a deliberately small
 *  TOML reader for that shape (strings, string arrays, inline string tables). */
export function parseCodexToml(text: string, file: string): FoundServer[] {
  const servers = new Map<string, { command?: string; args?: string[]; url?: string; env: Record<string, string> }>();
  let current: { name: string; sub?: 'env' } | null = null;
  const str = (v: string): string | null => {
    const m = /^"((?:[^"\\]|\\.)*)"$|^'([^']*)'$/.exec(v.trim());
    return m ? (m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]) : null;
  };
  const arr = (v: string): string[] | null => {
    const t = v.trim();
    if (!t.startsWith('[') || !t.endsWith(']')) return null;
    return (t.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) ?? []).map((x) => str(x) ?? '');
  };
  const inline = (v: string): Record<string, string> | null => {
    const t = v.trim();
    if (!t.startsWith('{') || !t.endsWith('}')) return null;
    const out: Record<string, string> = {};
    for (const m of t.slice(1, -1).matchAll(/([A-Za-z0-9_-]+|"[^"]+")\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g)) out[m[1].replace(/"/g, '')] = str(m[2]) ?? '';
    return out;
  };
  for (const line of text.split(/\r?\n/)) {
    const l = line.replace(/\s+#.*$/, '').trim();
    if (!l || l.startsWith('#')) continue;
    const sec = /^\[\s*mcp_servers\.("?)([^"\].]+)\1(?:\.(env))?\s*\]$/.exec(l);
    if (sec) {
      current = { name: sec[2], sub: sec[3] as 'env' | undefined };
      if (!servers.has(current.name)) servers.set(current.name, { env: {} });
      continue;
    }
    if (l.startsWith('[')) { current = null; continue; }
    if (!current) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(l);
    if (!kv) continue;
    const s = servers.get(current.name)!;
    if (current.sub === 'env') { const v = str(kv[2]); if (v !== null) s.env[kv[1]] = v; continue; }
    if (kv[1] === 'command') s.command = str(kv[2]) ?? undefined;
    else if (kv[1] === 'args') s.args = arr(kv[2]) ?? undefined;
    else if (kv[1] === 'url') s.url = str(kv[2]) ?? undefined;
    else if (kv[1] === 'env') Object.assign(s.env, inline(kv[2]) ?? {});
  }
  const out: FoundServer[] = [];
  for (const [name, s] of servers) {
    if (s.command) out.push({ source: 'Codex', file, name, transport: { kind: 'stdio', command: s.command, args: s.args ?? [] }, env: s.env, headers: {} });
    else if (s.url) out.push({ source: 'Codex', file, name, transport: { kind: 'http', url: s.url }, env: s.env, headers: {} });
  }
  return out;
}

export class McpServers {
  constructor(private readonly deps: McpServersDeps) {}

  private json(path: string): unknown {
    const t = this.deps.readFile(path);
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
  }

  /** Servers configured for other tools on this machine. */
  scan(): FoundServer[] {
    const { home } = this.deps;
    let appData = '';
    try { appData = this.deps.appData(); } catch { /* no app data dir: skip Claude Desktop */ }
    const out: FoundServer[] = [];
    const claudeJson = join(home, '.claude.json');
    const cj = this.json(claudeJson) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } | null;
    if (cj) {
      out.push(...fromMcpServers(cj.mcpServers, 'Claude Code', claudeJson));
      for (const [proj, p] of Object.entries(cj.projects ?? {})) {
        out.push(...fromMcpServers(p?.mcpServers, `Claude Code (${proj.split(/[\\/]/).filter(Boolean).pop() ?? proj})`, claudeJson));
      }
    }
    const desktop = join(appData, 'Claude', 'claude_desktop_config.json');
    if (appData) out.push(...fromMcpServers((this.json(desktop) as { mcpServers?: unknown } | null)?.mcpServers, 'Claude Desktop', desktop));
    const cursor = join(home, '.cursor', 'mcp.json');
    out.push(...fromMcpServers((this.json(cursor) as { mcpServers?: unknown } | null)?.mcpServers, 'Cursor', cursor));
    const gemini = join(home, '.gemini', 'settings.json');
    out.push(...fromMcpServers((this.json(gemini) as { mcpServers?: unknown } | null)?.mcpServers, 'Gemini CLI / Antigravity', gemini));
    const windsurf = join(home, '.codeium', 'windsurf', 'mcp_config.json');
    out.push(...fromMcpServers((this.json(windsurf) as { mcpServers?: unknown } | null)?.mcpServers, 'Windsurf', windsurf));
    const codex = join(home, '.codex', 'config.toml');
    const ct = this.deps.readFile(codex);
    if (ct) out.push(...parseCodexToml(ct, codex));
    // The same tools' settings in another home (a WSL floor's distro).
    for (const { label, home: h } of this.deps.extraHomes?.() ?? []) {
      const cj2 = join(h, '.claude.json');
      const c2 = this.json(cj2) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } | null;
      if (c2) {
        out.push(...fromMcpServers(c2.mcpServers, `Claude Code (${label})`, cj2));
        for (const [proj, p] of Object.entries(c2.projects ?? {})) out.push(...fromMcpServers(p?.mcpServers, `Claude Code (${label}: ${proj.split(/[\\/]/).filter(Boolean).pop() ?? proj})`, cj2));
      }
      for (const [rel, src] of [[['.cursor', 'mcp.json'], 'Cursor'], [['.gemini', 'settings.json'], 'Gemini CLI / Antigravity']] as Array<[string[], string]>) {
        const f = join(h, ...rel);
        out.push(...fromMcpServers((this.json(f) as { mcpServers?: unknown } | null)?.mcpServers, `${src} (${label})`, f));
      }
      const cx = join(h, '.codex', 'config.toml');
      const cxt = this.deps.readFile(cx);
      if (cxt) out.push(...parseCodexToml(cxt, cx).map((f) => ({ ...f, source: `Codex (${label})` })));
    }
    return [...out, ...this.scanAgents()];
  }

  /** What agents set up for themselves: a project `.mcp.json` / Cursor config in
   *  their folder (Claude Code's project scope and friends) and a Codex agent's
   *  own config. Without this an agent could add a server and nobody would see it. */
  scanAgents(): FoundServer[] {
    const out: FoundServer[] = [];
    const seen = new Set<string>();
    for (const place of this.deps.agentPlaces?.() ?? []) {
      const files: Array<[string, string]> = [
        [join(place.cwd, '.mcp.json'), 'mcp'],
        [join(place.cwd, '.cursor', 'mcp.json'), 'mcp'],
        ...(place.codexHome ? [[join(place.codexHome, 'config.toml'), 'codex'] as [string, string]] : [])
      ];
      for (const [file, kind] of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const found = kind === 'codex'
          ? (() => { const t = this.deps.readFile(file); return t ? parseCodexToml(t, file) : []; })()
          : fromMcpServers((this.json(file) as { mcpServers?: unknown } | null)?.mcpServers, `Agent ${place.name}`, file);
        for (const f of found) out.push({ ...f, source: `Agent ${place.name}`, agent: place.name });
      }
    }
    return out;
  }

  /** Found servers for the UI: env values that look secret are hidden, and
   *  each says whether it is already imported. */
  scanForUi(): Array<Omit<FoundServer, 'env' | 'headers'> & { env: Array<{ name: string; secret: boolean; value?: string }>; headers: Array<{ name: string; secret: boolean; value?: string }>; imported: boolean; suggest: McpSuggestion | null }> {
    const mine = new Set(this.deps.readCustom().map((c) => c.id));
    return this.scan().map((f) => ({
      source: f.source, file: f.file, name: f.name, transport: f.transport, ...(f.agent ? { agent: f.agent } : {}),
      env: Object.entries(f.env).map(([name, value]) => looksSecret(name, value) ? { name, secret: true } : { name, secret: false, value }),
      headers: Object.entries(f.headers).map(([name, value]) => looksSecret(name, value) ? { name, secret: true } : { name, secret: false, value }),
      imported: mine.has(customId(f.name)),
      suggest: suggestFor(f.transport, Object.keys(f.env))
    }));
  }

  listCustom(): Array<CustomServer & { headers: Record<string, string>; secretHeaders: string[]; secretsStored: Record<string, boolean>; headersStored: Record<string, boolean> }> {
    return this.deps.readCustom().map((c) => ({
      ...c, headers: c.headers ?? {}, secretHeaders: c.secretHeaders ?? [],
      secretsStored: Object.fromEntries(c.secretEnv.map((e) => [e, !!this.deps.getSecret(secretRef(c.id, e))])),
      headersStored: Object.fromEntries((c.secretHeaders ?? []).map((h) => [h, !!this.deps.getSecret(headerRef(c.id, h))]))
    }));
  }

  /**
   * Import a found server (by source + name). `secretNames` overrides which env
   * vars are treated as secrets (default: the ones that look like one). A remote
   * server's headers that look secret (Authorization, X-API-Key…) go to the
   * store too, and the server is then called through the gateway.
   */
  import(source: string, name: string, secretNames?: string[]): { ok: boolean; id?: string; error?: string } {
    const f = this.scan().find((x) => x.source === source && x.name === name);
    if (!f) return { ok: false, error: 'that server is no longer in its config' };
    const headers = f.transport.kind === 'http' ? f.headers : {};
    return this.save(
      { name: f.name, transport: f.transport, env: f.env, headers, source: f.source },
      secretNames ?? Object.entries(f.env).filter(([k, v]) => looksSecret(k, v)).map(([k]) => k),
      Object.entries(headers).filter(([k, v]) => looksSecret(k, v)).map(([k]) => k)
    );
  }

  /** Add or replace a server. Env values named in `secretNames` and headers
   *  named in `secretHeaderNames` go to the encrypted store; an empty value
   *  keeps the stored one. Headers apply to remote servers only. */
  save(input: { id?: string; name: string; transport: McpTransport; env: Record<string, string>; headers?: Record<string, string>; source?: string; enabled?: boolean; agents?: string[] | null }, secretNames: string[], secretHeaderNames: string[] = []): { ok: boolean; id?: string; error?: string } {
    const name = input.name.trim().slice(0, 60);
    if (!name) return { ok: false, error: 'give it a name' };
    if (input.transport.kind === 'stdio' && !input.transport.command.trim()) return { ok: false, error: 'give it a command' };
    if (input.transport.kind === 'http' && !/^https?:\/\//.test(input.transport.url)) return { ok: false, error: 'the address must start with https://' };
    const id = input.id ?? customId(name);
    const secrets = new Set(secretNames);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (secrets.has(k)) {
        if (v) { const r = this.deps.setSecret(secretRef(id, k), v); if (!r.ok) return { ok: false, error: r.error ?? 'could not store a key securely' }; }
      } else env[k] = v;
    }
    const prev = this.deps.readCustom().find((c) => c.id === id);
    const remote = input.transport.kind === 'http';
    const inHeaders = remote ? input.headers ?? {} : {};
    const secretHeaders = new Set(remote ? secretHeaderNames : []);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(inHeaders)) {
      if (!HEADER_NAME.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) continue;
      if (secretHeaders.has(k)) {
        if (v) { const r = this.deps.setSecret(headerRef(id, k), v); if (!r.ok) return { ok: false, error: r.error ?? 'could not store a key securely' }; }
      } else headers[k] = v;
    }
    for (const old of prev?.secretEnv ?? []) if (!secrets.has(old)) this.deps.deleteSecret(secretRef(id, old));
    for (const old of prev?.secretHeaders ?? []) if (!secretHeaders.has(old)) this.deps.deleteSecret(headerRef(id, old));
    const keptHeaders = [...secretHeaders].filter((h) => HEADER_NAME.test(h) && !RESERVED_HEADERS.has(h.toLowerCase()) && (h in inHeaders || prev?.secretHeaders?.includes(h)));
    const rec: CustomServer = {
      id, name, transport: input.transport, env, secretEnv: [...secrets].filter((s) => s in input.env || prev?.secretEnv.includes(s)),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(keptHeaders.length ? { secretHeaders: keptHeaders } : {}),
      enabled: input.enabled ?? prev?.enabled ?? true, agents: input.agents !== undefined ? input.agents : prev?.agents ?? null,
      ...(input.source ?? prev?.source ? { source: input.source ?? prev?.source } : {})
    };
    this.deps.writeCustom([...this.deps.readCustom().filter((c) => c.id !== id), rec]);
    return { ok: true, id };
  }

  setEnabled(id: string, enabled: boolean): void {
    this.deps.writeCustom(this.deps.readCustom().map((c) => (c.id === id ? { ...c, enabled } : c)));
  }

  setAgents(id: string, agents: string[] | null): void {
    this.deps.writeCustom(this.deps.readCustom().map((c) => (c.id === id ? { ...c, agents } : c)));
  }

  remove(id: string): void {
    const c = this.deps.readCustom().find((x) => x.id === id);
    for (const e of c?.secretEnv ?? []) this.deps.deleteSecret(secretRef(id, e));
    for (const h of c?.secretHeaders ?? []) this.deps.deleteSecret(headerRef(id, h));
    this.deps.writeCustom(this.deps.readCustom().filter((x) => x.id !== id));
  }

  /** What one agent gets: servers with secrets go through the gateway (by id),
   *  the rest are handed over as plain entries. */
  forAgent(agentId: string): { gateway: string[]; plain: Record<string, { command: string; args: string[]; env?: Record<string, string> } | { type: 'http'; url: string; headers: Record<string, string> }> } {
    const gateway: string[] = [];
    const plain: Record<string, { command: string; args: string[]; env?: Record<string, string> } | { type: 'http'; url: string; headers: Record<string, string> }> = {};
    for (const c of this.deps.readCustom()) {
      if (!c.enabled) continue;
      if (c.agents && c.agents.length && !c.agents.includes(agentId)) continue;
      const secretHeaders = c.transport.kind === 'http' ? c.secretHeaders ?? [] : [];
      if (c.secretEnv.length || secretHeaders.length) {
        const stored = c.secretEnv.every((e) => this.deps.getSecret(secretRef(c.id, e))) && secretHeaders.every((h) => this.deps.getSecret(headerRef(c.id, h)));
        if (stored) gateway.push(c.id);
        continue;
      }
      plain[c.id] = c.transport.kind === 'stdio'
        ? { command: c.transport.command, args: c.transport.args, ...(Object.keys(c.env).length ? { env: c.env } : {}) }
        : { type: 'http', url: c.transport.url, headers: { ...(c.headers ?? {}) } };
    }
    return { gateway, plain };
  }

  /** The gateway's launch spec for a custom server, keys included (main only). */
  launchSpec(id: string): { command: string; args: string[]; env: Record<string, string> } | null {
    const c = this.deps.readCustom().find((x) => x.id === id);
    if (!c || c.transport.kind !== 'stdio') return null;
    const env: Record<string, string> = { ...c.env };
    for (const e of c.secretEnv) { const v = this.deps.getSecret(secretRef(c.id, e)); if (!v) return null; env[e] = v; }
    return { command: c.transport.command, args: c.transport.args, env };
  }

  /** The gateway's upstream for a custom remote server, keyed headers included (main only). */
  remoteSpec(id: string): { url: string; headers: Record<string, string> } | null {
    const c = this.deps.readCustom().find((x) => x.id === id);
    if (!c || c.transport.kind !== 'http') return null;
    const headers: Record<string, string> = { ...(c.headers ?? {}) };
    for (const h of c.secretHeaders ?? []) { const v = this.deps.getSecret(headerRef(c.id, h)); if (!v) return null; headers[h] = v; }
    return { url: c.transport.url, headers };
  }
}
