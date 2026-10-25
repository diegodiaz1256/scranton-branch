/**
 * Agent files: one agent exported to a file and hired into another office.
 * Spec `scranton-agent@1`, saved as `<name>.sbagent.json`.
 *
 * WHAT A FILE CARRIES (each part only when the human ticks it): the agent's
 * name, role and look; its standing goal (the text added to its every prompt);
 * its engine (provider, model, effort); its capabilities (routing tags, the
 * MCP grant, access levels, the tool groups taken from it, the role bundle the
 * grant came from); its skills BY REFERENCE (catalog name and publisher, plus
 * the skill's files only when the human ticks that); the MCP servers it uses
 * (catalog ids, and the human's own servers as definitions with the env and
 * header NAMES only); the connections it uses (service and name); the env var
 * NAMES it expects; optionally its memory.md; and hire metadata.
 *
 * WHAT IT NEVER CARRIES: a secret value of any kind (env values, MCP env and
 * header values, connection keys, secretRefs, the broker token), who is the
 * custodian of a critical connection, a vault, sandbox or roam switches, and
 * the human's paths (they become {{PROJECT}}, {{OFFICE}}, {{HOME}}). Values
 * are left out by construction (only names are read); free text on top is
 * scrubbed of the office's known secret values and anything that looks like a
 * credential (agentSteps.redact).
 *
 * IMPORTING ONE IS UNTRUSTED INPUT, the hire manifest's model (hire.ts and the
 * "hire manifest as untrusted input" note):
 *   - strict schema: unknown fields, wrong types, oversize text, control
 *     characters, path-like names and file paths that leave their folder
 *     reject the whole file;
 *   - no executable: the spawn command is built from the LOCAL provider preset
 *     ('custom' is refused) and the model must pass the hire's MODEL_RE;
 *   - nothing privileged by default: the import plan grants only catalog
 *     servers this office knows, capped by the office's own ceilings; write
 *     and keyed servers still need the office's consent; the human's own MCP
 *     servers are listed for setting up by hand, never added; skills install
 *     only from this office's catalog (by name, never from a URL in the file);
 *     no critical connection, no unsandboxed run, no roam;
 *   - import never spawns: the human reviews the preview and clicks Hire.
 *
 * Pure: no electron, no node. Main reads and writes the files.
 */
import { isAgentProvider, type AgentProvider } from './agentProvider';
import { MCP_CATALOG, mcpCatalogEntry } from './mcpCatalog';
import { MODEL_RE } from './hire';
import { isEffort, type Effort } from './roleModels';
import { BUNDLE_ICONS, allRoleBundles, cleanServerList, type BundleIcon, type RoleBundle } from './roleBundles';
import { DEFAULT_CEILING, isAccess, minAccess, type Access } from './connectionAccess';
import { cleanToolBlocks } from './nativeTools';
import { MAX_AGENT_TOKEN_CAP } from './tokenCaps';
import { redact } from './agentSteps';

export const AGENT_FILE_SPEC = 'scranton-agent@1';
export const AGENT_FILE_EXT = '.sbagent.json';
/** The most a file may weigh on disk (skill files included). */
export const AGENT_FILE_MAX_BYTES = 1024 * 1024;

export const PLACEHOLDER = { project: '{{PROJECT}}', office: '{{OFFICE}}', home: '{{HOME}}' } as const;

export const EXPORT_PARTS = [
  'identity', 'prompt', 'engine', 'capabilities', 'skills', 'skillFiles',
  'mcp', 'connections', 'envNames', 'memory', 'hire'
] as const;
export type ExportPart = typeof EXPORT_PARTS[number];
export type ExportParts = Record<ExportPart, boolean>;
/** Memory and skill files are off until the human ticks them. */
export const DEFAULT_EXPORT_PARTS: ExportParts = {
  identity: true, prompt: true, engine: true, capabilities: true, skills: true, skillFiles: false,
  mcp: true, connections: true, envNames: true, memory: false, hire: true
};

export interface AgentFileSkillFile { path: string; content: string }
export interface AgentFileSkill {
  /** Catalog name; also the folder it is installed in. */
  name: string;
  /** Publisher in the catalog (e.g. "anthropics"). */
  owner?: string;
  /** Where it came from (https). Shown only: install goes by name. */
  source?: string;
  files?: AgentFileSkillFile[];
}
export type AgentFileMcp =
  | { kind: 'catalog'; id: string }
  | { kind: 'stdio'; name: string; command: string; args: string[]; envNames: string[] }
  | { kind: 'http'; name: string; url: string; headerNames: string[] };

export interface AgentFileBundle { id: string; label: string; icon: BundleIcon; servers: string[]; access?: Record<string, Access> }

export interface AgentFile {
  spec: typeof AGENT_FILE_SPEC;
  exportedAt?: string;
  identity?: { name: string; role?: string; character?: string; accent?: string };
  prompt?: { goal: string };
  engine?: { provider: AgentProvider; model?: string; effort?: Effort };
  capabilities?: {
    tags?: string[];
    /** Its own MCP grant (catalog ids). Absent: it ran on the office defaults. */
    servers?: string[];
    access?: Record<string, Access>;
    toolBlocks?: string[];
    bundle?: AgentFileBundle;
  };
  skills?: AgentFileSkill[];
  mcpServers?: AgentFileMcp[];
  connections?: Array<{ service: string; label: string }>;
  envNames?: string[];
  memory?: string;
  hire?: { isolate?: boolean; tokenCap?: number; author?: string };
}

// ─── limits ─────────────────────────────────────────────────────────────────

const MAX = {
  name: 40, role: 200, goal: 4000, look: 24, tag: 40, tags: 12, servers: 32, label: 60,
  skills: 32, skillFiles: 64, skillPath: 200, skillContent: 200 * 1024, mcp: 24, command: 300,
  args: 32, arg: 300, url: 500, names: 64, connections: 32, memory: 64 * 1024, author: 80
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SERVICE_RE = /^(?:api:)?[a-z0-9][a-z0-9-]{0,63}$/;
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const LOOK_RE = /^[a-z0-9-]{1,24}$/;
const TAG_RE = /^[\w .:/+-]{1,40}$/;
/** Control characters other than tab and newlines. */
const CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const WIN_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/** A skill file's path: relative, '/'-separated, every segment a plain name
 *  (no '..', no hidden or drive-like segment, nothing Windows refuses). */
export function isSafeSkillPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > MAX.skillPath) return false;
  const parts = p.split('/');
  if (parts.length > 6) return false;
  return parts.every((s) => /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}$/.test(s) && !/[. ]$/.test(s) && !WIN_RESERVED.test(s));
}

// ─── validation (untrusted input) ───────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface AgentFileValidation { ok: boolean; file?: AgentFile; errors: string[] }

/** Validate a parsed JSON value as an agent file. Every field is checked;
 *  anything unknown or out of shape rejects the file. Pure; no I/O. */
export function validateAgentFile(raw: unknown): AgentFileValidation {
  const errors: string[] = [];
  const err = (m: string) => { if (errors.length < 40) errors.push(m); };
  if (!isObj(raw)) return { ok: false, errors: ['the file must hold one JSON object'] };
  if (raw.spec !== AGENT_FILE_SPEC) {
    return { ok: false, errors: [`unsupported spec ${JSON.stringify(String(raw.spec).slice(0, 40))} (expected "${AGENT_FILE_SPEC}")`] };
  }
  const only = (o: Obj, allowed: readonly string[], where: string) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${where}: unknown field ${JSON.stringify(k.slice(0, 40))}`);
  };
  /** A string field: type, length, control characters, optional shape. */
  const text = (v: unknown, max: number, where: string, o: { required?: boolean; multiline?: boolean; re?: RegExp } = {}): string | undefined => {
    if (v === undefined) { if (o.required) err(`${where} is required`); return undefined; }
    if (typeof v !== 'string') { err(`${where} must be text`); return undefined; }
    if (v.length > max) { err(`${where} is longer than ${max} characters`); return undefined; }
    if (CTRL_RE.test(v) || (!o.multiline && /[\r\n]/.test(v))) { err(`${where} has characters that are not allowed`); return undefined; }
    if (o.required && !v.trim()) { err(`${where} must not be empty`); return undefined; }
    if (o.re && !o.re.test(v)) { err(`${where} is not in the expected form`); return undefined; }
    return v;
  };
  const list = <T>(v: unknown, max: number, where: string, each: (x: unknown, w: string) => T | undefined): T[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) { err(`${where} must be a list`); return undefined; }
    if (v.length > max) { err(`${where} has more than ${max} entries`); return undefined; }
    const out: T[] = [];
    v.forEach((x, i) => { const r = each(x, `${where}[${i}]`); if (r !== undefined) out.push(r); });
    return out;
  };
  const obj = (v: unknown, where: string): Obj | undefined => {
    if (v === undefined) return undefined;
    if (!isObj(v)) { err(`${where} must be an object`); return undefined; }
    return v;
  };
  const accessMap = (v: unknown, where: string): Record<string, Access> | undefined => {
    const o = obj(v, where);
    if (!o) return undefined;
    const keys = Object.keys(o);
    if (keys.length > MAX.servers * 2) { err(`${where} has too many entries`); return undefined; }
    const out: Record<string, Access> = {};
    for (const k of keys) {
      if (!SERVICE_RE.test(k)) { err(`${where}: ${JSON.stringify(k.slice(0, 40))} is not a service id`); continue; }
      if (!isAccess(o[k])) { err(`${where}.${k} must be none, read or readwrite`); continue; }
      out[k] = o[k] as Access;
    }
    return out;
  };

  only(raw, ['spec', 'exportedAt', 'identity', 'prompt', 'engine', 'capabilities', 'skills', 'mcpServers', 'connections', 'envNames', 'memory', 'hire'], 'file');
  const file: AgentFile = { spec: AGENT_FILE_SPEC };
  const exportedAt = text(raw.exportedAt, 40, 'exportedAt', { re: /^[0-9T:.+Z-]+$/ });
  if (exportedAt) file.exportedAt = exportedAt;

  const id = obj(raw.identity, 'identity');
  if (id) {
    only(id, ['name', 'role', 'character', 'accent'], 'identity');
    const name = text(id.name, MAX.name, 'identity.name', { required: true });
    if (name) {
      file.identity = { name: name.trim() };
      const role = text(id.role, MAX.role, 'identity.role');
      if (role) file.identity.role = role;
      const character = text(id.character, MAX.look, 'identity.character', { re: LOOK_RE });
      if (character) file.identity.character = character;
      const accent = text(id.accent, MAX.look, 'identity.accent', { re: LOOK_RE });
      if (accent) file.identity.accent = accent;
    }
  }

  const pr = obj(raw.prompt, 'prompt');
  if (pr) {
    only(pr, ['goal'], 'prompt');
    const goal = text(pr.goal, MAX.goal, 'prompt.goal', { multiline: true, required: true });
    if (goal) file.prompt = { goal };
  }

  const en = obj(raw.engine, 'engine');
  if (en) {
    only(en, ['provider', 'model', 'effort'], 'engine');
    // 'custom' names a local binary of the human's: a file can never pick one.
    if (!isAgentProvider(en.provider) || en.provider === 'custom') err('engine.provider must be one of the app\'s engines (not "custom")');
    else {
      file.engine = { provider: en.provider };
      const model = text(en.model, 80, 'engine.model', { re: MODEL_RE });
      if (model) file.engine.model = model;
      if (en.effort !== undefined) {
        if (isEffort(en.effort)) file.engine.effort = en.effort;
        else err('engine.effort must be low, medium, high, xhigh or max');
      }
    }
  }

  const cap = obj(raw.capabilities, 'capabilities');
  if (cap) {
    only(cap, ['tags', 'servers', 'access', 'toolBlocks', 'bundle'], 'capabilities');
    const c: NonNullable<AgentFile['capabilities']> = {};
    const tags = list(cap.tags, MAX.tags, 'capabilities.tags', (x, w) => text(x, MAX.tag, w, { re: TAG_RE }));
    if (tags?.length) c.tags = tags;
    const servers = list(cap.servers, MAX.servers, 'capabilities.servers', (x, w) => text(x, 64, w, { re: SLUG_RE }));
    if (servers) c.servers = servers;
    const access = accessMap(cap.access, 'capabilities.access');
    if (access && Object.keys(access).length) c.access = access;
    const blocks = list(cap.toolBlocks, 8, 'capabilities.toolBlocks', (x, w) => text(x, 40, w, { re: SLUG_RE }));
    if (blocks) {
      const known = cleanToolBlocks(blocks);
      if (known.length !== blocks.length) err('capabilities.toolBlocks names a tool group this app does not have');
      if (known.length) c.toolBlocks = known;
    }
    const b = obj(cap.bundle, 'capabilities.bundle');
    if (b) {
      only(b, ['id', 'label', 'icon', 'servers', 'access'], 'capabilities.bundle');
      const bid = text(b.id, 48, 'capabilities.bundle.id', { required: true, re: SLUG_RE });
      const label = text(b.label, 40, 'capabilities.bundle.label', { required: true });
      const icon = (BUNDLE_ICONS as readonly unknown[]).includes(b.icon) ? (b.icon as BundleIcon) : undefined;
      if (!icon) err('capabilities.bundle.icon is not a known icon');
      const bs = list(b.servers, MAX.servers, 'capabilities.bundle.servers', (x, w) => text(x, 64, w, { re: SLUG_RE }));
      const ba = accessMap(b.access, 'capabilities.bundle.access');
      if (bid && label && icon && bs) c.bundle = { id: bid, label: label.trim(), icon, servers: bs, ...(ba && Object.keys(ba).length ? { access: ba } : {}) };
    }
    file.capabilities = c;
  }

  let total = 0;
  const skills = list(raw.skills, MAX.skills, 'skills', (x, w): AgentFileSkill | undefined => {
    const s = obj(x, w);
    if (!s) return undefined;
    only(s, ['name', 'owner', 'source', 'files'], w);
    const name = text(s.name, 64, `${w}.name`, { required: true, re: SKILL_NAME_RE });
    if (!name || name.includes('..')) { if (name) err(`${w}.name is not a plain name`); return undefined; }
    const out: AgentFileSkill = { name };
    const owner = text(s.owner, 60, `${w}.owner`, { re: OWNER_RE });
    if (owner) out.owner = owner;
    const source = text(s.source, MAX.url, `${w}.source`);
    if (source !== undefined) {
      let okUrl = false;
      try { okUrl = new URL(source).protocol === 'https:'; } catch { okUrl = false; }
      if (okUrl) out.source = source; else err(`${w}.source must be an https link`);
    }
    const files = list(s.files, MAX.skillFiles, `${w}.files`, (f, fw): AgentFileSkillFile | undefined => {
      const fo = obj(f, fw);
      if (!fo) return undefined;
      only(fo, ['path', 'content'], fw);
      if (!isSafeSkillPath(fo.path)) { err(`${fw}.path must be a relative path inside the skill folder`); return undefined; }
      const content = text(fo.content, MAX.skillContent, `${fw}.content`, { multiline: true });
      if (content === undefined) { if (fo.content === undefined) err(`${fw}.content is required`); return undefined; }
      total += content.length;
      return { path: fo.path, content };
    });
    if (files) {
      const seen = new Set<string>();
      for (const f of files) {
        const k = f.path.toLowerCase();
        if (seen.has(k)) err(`${w}.files lists ${JSON.stringify(f.path)} twice`);
        seen.add(k);
      }
      if (files.length) out.files = files;
    }
    return out;
  });
  if (total > AGENT_FILE_MAX_BYTES) err('the skill files are too large');
  if (skills?.length) {
    const names = new Set<string>();
    for (const s of skills) {
      if (names.has(s.name.toLowerCase())) err(`skills lists ${JSON.stringify(s.name)} twice`);
      names.add(s.name.toLowerCase());
    }
    file.skills = skills;
  }

  const mcp = list(raw.mcpServers, MAX.mcp, 'mcpServers', (x, w): AgentFileMcp | undefined => {
    const m = obj(x, w);
    if (!m) return undefined;
    if (m.kind === 'catalog') {
      only(m, ['kind', 'id'], w);
      const cid = text(m.id, 64, `${w}.id`, { required: true, re: SLUG_RE });
      return cid ? { kind: 'catalog', id: cid } : undefined;
    }
    if (m.kind === 'stdio') {
      only(m, ['kind', 'name', 'command', 'args', 'envNames'], w);
      const name = text(m.name, MAX.label, `${w}.name`, { required: true });
      const command = text(m.command, MAX.command, `${w}.command`, { required: true });
      const args = list(m.args, MAX.args, `${w}.args`, (a, aw) => text(a, MAX.arg, aw)) ?? [];
      const envNames = list(m.envNames, MAX.names, `${w}.envNames`, (a, aw) => text(a, 128, aw, { re: ENV_NAME_RE })) ?? [];
      return name && command ? { kind: 'stdio', name, command, args, envNames } : undefined;
    }
    if (m.kind === 'http') {
      only(m, ['kind', 'name', 'url', 'headerNames'], w);
      const name = text(m.name, MAX.label, `${w}.name`, { required: true });
      const url = text(m.url, MAX.url, `${w}.url`, { required: true });
      let okUrl = false;
      try { const u = new URL(url ?? ''); okUrl = (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password; } catch { okUrl = false; }
      if (url && !okUrl) err(`${w}.url must be an http(s) link without credentials`);
      const headerNames = list(m.headerNames, MAX.names, `${w}.headerNames`, (a, aw) => text(a, 128, aw, { re: HEADER_NAME_RE })) ?? [];
      return name && url && okUrl ? { kind: 'http', name, url, headerNames } : undefined;
    }
    err(`${w}.kind must be catalog, stdio or http`);
    return undefined;
  });
  if (mcp?.length) file.mcpServers = mcp;

  const conns = list(raw.connections, MAX.connections, 'connections', (x, w) => {
    const c = obj(x, w);
    if (!c) return undefined;
    only(c, ['service', 'label'], w);
    const service = text(c.service, 70, `${w}.service`, { required: true, re: SERVICE_RE });
    const label = text(c.label, MAX.label, `${w}.label`, { required: true });
    return service && label ? { service, label } : undefined;
  });
  if (conns?.length) file.connections = conns;

  const envNames = list(raw.envNames, MAX.names, 'envNames', (x, w) => text(x, 128, w, { re: ENV_NAME_RE }));
  if (envNames?.length) file.envNames = [...new Set(envNames)];

  const memory = text(raw.memory, MAX.memory, 'memory', { multiline: true });
  if (memory !== undefined) file.memory = memory;

  const h = obj(raw.hire, 'hire');
  if (h) {
    only(h, ['isolate', 'tokenCap', 'author'], 'hire');
    const hire: NonNullable<AgentFile['hire']> = {};
    if (h.isolate !== undefined) { if (typeof h.isolate === 'boolean') hire.isolate = h.isolate; else err('hire.isolate must be true or false'); }
    if (h.tokenCap !== undefined) {
      if (typeof h.tokenCap === 'number' && Number.isInteger(h.tokenCap) && h.tokenCap > 0 && h.tokenCap <= MAX_AGENT_TOKEN_CAP) hire.tokenCap = h.tokenCap;
      else err('hire.tokenCap must be a positive whole number');
    }
    const author = text(h.author, MAX.author, 'hire.author');
    if (author) hire.author = author;
    file.hire = hire;
  }

  if (!file.identity) err('identity.name is required');
  if (errors.length) return { ok: false, errors };
  return { ok: true, file, errors: [] };
}

/** Parse the text of a file, size first. */
export function parseAgentFile(text: string): AgentFileValidation {
  if (text.length > AGENT_FILE_MAX_BYTES) return { ok: false, errors: ['the file is too large'] };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, errors: ['the file is not valid JSON'] }; }
  return validateAgentFile(raw);
}

// ─── export ─────────────────────────────────────────────────────────────────

/** The office settings an export reads. Values are present in the real
 *  config; the builder reads names only. */
export interface AgentExportConfig {
  harnessHome?: string | null;
  registeredRepos?: string[];
  mcpDefaults?: Record<string, { enabled: boolean }>;
  agentMcpGrants?: Record<string, string[]>;
  agentMcpAccess?: Record<string, Record<string, Access>>;
  agentToolBlocks?: Record<string, string[]>;
  customRoleBundles?: unknown;
  customMcp?: Array<{
    id: string; name: string; enabled: boolean; agents: string[] | null;
    transport: { kind: 'stdio'; command: string; args: string[] } | { kind: 'http'; url: string };
    env?: Record<string, string>; secretEnv?: string[]; headers?: Record<string, string>; secretHeaders?: string[];
  }>;
  envVars?: Array<{ name: string; agents?: string[] | null }>;
  integrations?: Array<{ id: string; label: string }>;
  integrationScopes?: Record<string, string[]>;
  roleEffort?: Partial<Record<'god' | 'agent' | 'temp', string>>;
  agentTokenCaps?: Record<string, number>;
}

export interface AgentExportSource {
  agent: {
    id: string; name: string; description?: string; goal?: string; character?: string; accent?: string;
    provider?: string; model?: string; command?: string; cwd?: string; worktreePath?: string;
  };
  /** The registry's capability tags. */
  tags?: string[];
  config: AgentExportConfig;
  /** Office skills that reach this agent, with their files when asked for. */
  skills?: Array<{ name: string; owner?: string; url?: string; files?: AgentFileSkillFile[] }>;
  /** Keyed connections this agent can call (service id + the connection's name). */
  connections?: Array<{ service: string; label: string }>;
  memory?: string;
  /** The human's home folder(s): become {{HOME}}. */
  homes?: string[];
  /** Every secret value the office holds that main could read: never written. */
  secrets?: string[];
  now?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SECRET_NAME = /(key|token|secret|password|passwd|auth|credential|cookie|session)/i;

/** Put placeholders where the human's folders were. Longest first, either
 *  slash, case-insensitive (Windows paths); then any other home folder
 *  (C:\Users\x, /Users/x, /home/x, \\wsl.localhost\<distro>\home\x). */
export function scrubPaths(s: string, roots: Array<{ path: string; token: string }>): string {
  let out = s;
  const sorted = roots.filter((r) => r.path && r.path.length >= 3).sort((a, b) => b.path.length - a.path.length);
  for (const r of sorted) {
    const p = r.path.replace(/[\\/]+$/, '');
    const variants = new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')]);
    for (const v of variants) out = out.replace(new RegExp(escapeRe(v), 'gi'), r.token);
  }
  out = out.replace(/\\\\wsl(?:\.localhost|\$)\\[^\\\s"'`]+\\home\\[^\\/\s"'`<>|]+/gi, PLACEHOLDER.home);
  out = out.replace(/(?<![\w.:/\\-])(?:[A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/\s"'`<>|{}]+/g, PLACEHOLDER.home);
  return out;
}

/** Free text out of the office: known secret values, then anything that looks
 *  like a credential (the app's shared scrubber), then the human's paths. */
function cleanText(s: string, ctx: { secrets: string[]; roots: Array<{ path: string; token: string }> }): string {
  let out = s;
  for (const v of ctx.secrets) if (v.length >= 6) out = out.split(v).join('[REDACTED]');
  return scrubPaths(redact(out), ctx.roots);
}

/** Command-line arguments: the value of anything named like a secret goes. */
function cleanArgs(args: string[], ctx: { secrets: string[]; roots: Array<{ path: string; token: string }> }): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const a of args.slice(0, MAX.args)) {
    if (hideNext && !a.startsWith('-')) { out.push('[REDACTED]'); hideNext = false; continue; }
    hideNext = false;
    const eq = /^(-{1,2}[\w.-]+|[A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a);
    if (eq && SECRET_NAME.test(eq[1])) { out.push(`${eq[1]}=[REDACTED]`); continue; }
    if (/^-{1,2}[\w.-]+$/.test(a) && SECRET_NAME.test(a)) hideNext = true;
    out.push(clip(cleanText(a, ctx), MAX.arg));
  }
  return out;
}

/** A URL without its credentials, query or fragment (keys ride in those). */
function cleanUrl(raw: string, ctx: { secrets: string[]; roots: Array<{ path: string; token: string }> }): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const out = cleanText(`${u.protocol}//${u.host}${u.pathname}`, ctx);
    return out.length <= MAX.url ? out : null;
  } catch { return null; }
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The effort an agent runs with: its own --effort, else the office's for agents. */
export function effortOf(command: string | undefined, roleEffort: string | undefined): Effort | undefined {
  const m = /(?:^|\s)--effort(?:=|\s+)(\S+)/.exec(command ?? '');
  const v = m ? m[1].replace(/^["']|["']$/g, '') : roleEffort;
  return isEffort(v) ? v : undefined;
}

/** The catalog servers an agent gets: its grant, else the office defaults. */
export function serversOf(cfg: AgentExportConfig, agentId: string): string[] {
  const grant = cfg.agentMcpGrants?.[agentId];
  if (grant) return cleanServerList(grant);
  return MCP_CATALOG.filter((e) => cfg.mcpDefaults?.[e.id]?.enabled ?? e.defaultEnabled).map((e) => e.id);
}

/**
 * Build the file for one agent from what the office knows about it, with only
 * the parts the human ticked. Reads names, never values; scrubs free text.
 * The result always passes validateAgentFile.
 */
export function buildAgentFile(src: AgentExportSource, parts: ExportParts): AgentFile {
  const { agent, config: cfg } = src;
  const roots: Array<{ path: string; token: string }> = [];
  for (const p of [agent.worktreePath, agent.cwd, ...(cfg.registeredRepos ?? [])]) if (p) roots.push({ path: p, token: PLACEHOLDER.project });
  if (cfg.harnessHome) roots.push({ path: cfg.harnessHome, token: PLACEHOLDER.office });
  for (const h of src.homes ?? []) if (h) roots.push({ path: h, token: PLACEHOLDER.home });
  const ctx = { secrets: [...new Set((src.secrets ?? []).filter((s) => typeof s === 'string' && s.length >= 6))].sort((a, b) => b.length - a.length), roots };
  const line = (s: string, n: number) => clip(cleanText(s, ctx).replace(/[\r\n\t]+/g, ' ').replace(CTRL_RE, '').trim(), n);
  const body = (s: string, n: number) => clip(cleanText(s, ctx).replace(CTRL_RE, ''), n);

  const file: AgentFile = { spec: AGENT_FILE_SPEC, exportedAt: src.now ?? new Date().toISOString() };
  // The name is always there: a file without one cannot be hired.
  file.identity = { name: line(agent.name, MAX.name) || 'Agent' };
  if (parts.identity) {
    if (agent.description?.trim()) file.identity.role = line(agent.description, MAX.role);
    if (agent.character && LOOK_RE.test(agent.character)) file.identity.character = agent.character;
    if (agent.accent && LOOK_RE.test(agent.accent)) file.identity.accent = agent.accent;
  }
  if (parts.prompt && agent.goal?.trim()) file.prompt = { goal: body(agent.goal, MAX.goal) };
  if (parts.engine) {
    const provider = isAgentProvider(agent.provider) ? agent.provider : 'claude';
    if (provider !== 'custom') {
      file.engine = { provider };
      if (agent.model && MODEL_RE.test(agent.model)) file.engine.model = agent.model;
      // --effort is Claude Code's.
      const effort = provider === 'claude' ? effortOf(agent.command, cfg.roleEffort?.agent) : undefined;
      if (effort) file.engine.effort = effort;
    }
  }
  const grant = cfg.agentMcpGrants?.[agent.id];
  if (parts.capabilities) {
    const c: NonNullable<AgentFile['capabilities']> = {};
    const tags = (src.tags ?? []).map((t) => line(t, MAX.tag)).filter((t) => TAG_RE.test(t)).slice(0, MAX.tags);
    if (tags.length) c.tags = tags;
    if (grant) c.servers = cleanServerList(grant);
    const access = cfg.agentMcpAccess?.[agent.id];
    if (access) {
      const a = Object.fromEntries(Object.entries(access).filter(([k, v]) => SERVICE_RE.test(k) && isAccess(v)));
      if (Object.keys(a).length) c.access = a as Record<string, Access>;
    }
    const blocks = cleanToolBlocks(cfg.agentToolBlocks?.[agent.id]);
    if (blocks.length) c.toolBlocks = blocks;
    if (grant) {
      const servers = cleanServerList(grant);
      const b = allRoleBundles(cfg.customRoleBundles).find((x) => sameSet(x.servers, servers));
      if (b) c.bundle = { id: b.id, label: b.label, icon: b.icon, servers: [...b.servers], ...(b.access ? { access: { ...b.access } } : {}) };
    }
    file.capabilities = c;
  }
  if (parts.skills && src.skills?.length) {
    const out: AgentFileSkill[] = [];
    let total = 0;
    for (const s of src.skills) {
      if (out.length >= MAX.skills || !SKILL_NAME_RE.test(s.name) || s.name.includes('..')) continue;
      if (out.some((o) => o.name.toLowerCase() === s.name.toLowerCase())) continue;
      const sk: AgentFileSkill = { name: s.name };
      if (s.owner && OWNER_RE.test(s.owner)) sk.owner = s.owner;
      if (s.url && /^https:\/\//.test(s.url) && s.url.length <= MAX.url) { const u = cleanUrl(s.url, ctx); if (u?.startsWith('https://')) sk.source = u; }
      if (parts.skillFiles && s.files?.length) {
        const files: AgentFileSkillFile[] = [];
        for (const f of s.files) {
          if (files.length >= MAX.skillFiles || !isSafeSkillPath(f.path) || typeof f.content !== 'string') continue;
          const content = body(f.content, MAX.skillContent);
          if (total + content.length > AGENT_FILE_MAX_BYTES / 2) continue;
          total += content.length;
          files.push({ path: f.path, content });
        }
        if (files.length) sk.files = files;
      }
      out.push(sk);
    }
    if (out.length) file.skills = out;
  }
  if (parts.mcp) {
    const out: AgentFileMcp[] = serversOf(cfg, agent.id).map((id) => ({ kind: 'catalog' as const, id }));
    for (const c of cfg.customMcp ?? []) {
      if (out.length >= MAX.mcp) break;
      if (!c.enabled || (c.agents && c.agents.length && !c.agents.includes(agent.id))) continue;
      const name = line(c.name || c.id, MAX.label) || 'server';
      if (c.transport.kind === 'stdio') {
        const envNames = [...new Set([...Object.keys(c.env ?? {}), ...(c.secretEnv ?? [])])].filter((n) => ENV_NAME_RE.test(n)).slice(0, MAX.names);
        const command = line(c.transport.command, MAX.command);
        if (command) out.push({ kind: 'stdio', name, command, args: cleanArgs(c.transport.args ?? [], ctx).map((a) => a.replace(/[\r\n]+/g, ' ').replace(CTRL_RE, '')), envNames });
      } else {
        const url = cleanUrl(c.transport.url, ctx);
        const headerNames = [...new Set([...Object.keys(c.headers ?? {}), ...(c.secretHeaders ?? [])])].filter((n) => HEADER_NAME_RE.test(n)).slice(0, MAX.names);
        if (url) out.push({ kind: 'http', name, url, headerNames });
      }
    }
    if (out.length) file.mcpServers = out.slice(0, MAX.mcp);
  }
  if (parts.connections) {
    const out: Array<{ service: string; label: string }> = [];
    for (const c of src.connections ?? []) if (SERVICE_RE.test(c.service)) out.push({ service: c.service, label: line(c.label, MAX.label) || c.service });
    for (const i of cfg.integrations ?? []) {
      const scope = cfg.integrationScopes?.[i.id];
      if (Array.isArray(scope) && !scope.includes(agent.id)) continue;
      const service = `api:${i.id}`;
      if (SERVICE_RE.test(service)) out.push({ service, label: line(i.label || i.id, MAX.label) || i.id });
    }
    if (out.length) file.connections = out.slice(0, MAX.connections);
  }
  if (parts.envNames) {
    const names = (cfg.envVars ?? []).filter((v) => !v.agents || v.agents.includes(agent.id)).map((v) => v.name).filter((n) => ENV_NAME_RE.test(n));
    if (names.length) file.envNames = [...new Set(names)].slice(0, MAX.names);
  }
  if (parts.memory && src.memory?.trim()) file.memory = body(src.memory, MAX.memory);
  if (parts.hire) {
    const hire: NonNullable<AgentFile['hire']> = {};
    if (agent.worktreePath) hire.isolate = true;
    const cap = cfg.agentTokenCaps?.[agent.id];
    if (typeof cap === 'number' && Number.isInteger(cap) && cap > 0 && cap <= MAX_AGENT_TOKEN_CAP) hire.tokenCap = cap;
    if (Object.keys(hire).length) file.hire = hire;
  }
  const v = validateAgentFile(JSON.parse(JSON.stringify(file)));
  if (!v.ok || !v.file) throw new Error(`export produced an invalid file: ${v.errors.join('; ')}`);
  return v.file;
}

/** A file name for the export: the agent's name as a slug. */
export function agentFileName(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'}${AGENT_FILE_EXT}`;
}

// ─── import ─────────────────────────────────────────────────────────────────

/** What this office has, for the import preview. */
export interface ImportLocal {
  /** The skills catalog (name + publisher). */
  catalogSkills: Array<{ name: string; owner: string }>;
  /** Office skills already installed (names). */
  officeSkills: string[];
  /** Catalog id → switched on in this office. */
  mcpEnabled: Record<string, boolean>;
  /** Keyed connections: service id, name, key stored, switched on. */
  connections: Array<{ service: string; label: string; ready: boolean; enabled: boolean }>;
  /** REST APIs (integration ids). */
  integrations: string[];
  /** The human's own MCP servers (names). */
  customMcpNames: string[];
  /** Env var names the office defines. */
  envNames: string[];
  /** The office's custom role bundles (config.customRoleBundles). */
  customBundles?: unknown;
  /** connectionPolicy + integrationPolicy (as api:<id>): the most any agent may do. */
  ceilings?: Record<string, Access>;
}

export interface ImportPlan {
  name: string;
  role?: string;
  goal?: string;
  character?: string;
  accent?: string;
  provider?: AgentProvider;
  model?: string;
  effort?: Effort;
  tags: string[];
  isolate: boolean;
  tokenCap?: number;
  /** The grant to apply (catalog ids this office knows). Absent: the office defaults. */
  grant?: string[];
  /** Access per service, capped by this office's ceilings. */
  access?: Record<string, Access>;
  toolBlocks: string[];
  /** Catalog ids this app does not know: dropped. */
  unknownServers: string[];
  /** Write or keyed servers this office has not switched on: they stay off. */
  needsConsent: string[];
  skills: {
    /** In this office's catalog, not installed yet. */
    install: Array<{ name: string; owner: string }>;
    present: string[];
    /** Neither installed nor in the catalog (their files may be in the file). */
    unavailable: string[];
    /** Skills the file carries files for. */
    withFiles: string[];
  };
  /** The human's own servers from the other office: set up by hand. */
  mcpManual: Array<{ name: string; kind: 'stdio' | 'http'; detail: string; secretNames: string[] }>;
  connections: { ready: Array<{ service: string; label: string }>; missing: Array<{ service: string; label: string }> };
  envMissing: string[];
  envPresent: string[];
  bundle?: { bundle: AgentFileBundle; exists: boolean };
  memory: boolean;
}

/** What hiring this file would do here, and what is missing. Grants nothing:
 *  the result is what the human confirms. */
export function planAgentImport(file: AgentFile, local: ImportLocal): ImportPlan {
  const known = new Set(MCP_CATALOG.map((e) => e.id));
  const cap = file.capabilities ?? {};
  const fromMcp = (file.mcpServers ?? []).filter((m): m is { kind: 'catalog'; id: string } => m.kind === 'catalog').map((m) => m.id);
  const asked = [...new Set([...(cap.servers ?? []), ...fromMcp])];
  const unknownServers = asked.filter((id) => !known.has(id));
  const grant = cap.servers ? cleanServerList(cap.servers) : undefined;
  const wanted = grant ?? cleanServerList(fromMcp);
  const needsConsent = wanted.filter((id) => {
    const e = mcpCatalogEntry(id);
    return !!e && (e.tier !== 'safe-readonly' || (e.secrets ?? []).length > 0) && local.mcpEnabled[id] !== true;
  });

  let access: Record<string, Access> | undefined;
  if (cap.access) {
    access = {};
    for (const [k, v] of Object.entries(cap.access)) {
      const isApi = k.startsWith('api:');
      if (isApi ? !local.integrations.includes(k.slice(4)) : !(grant ?? wanted).includes(k)) continue;
      access[k] = minAccess(v, local.ceilings?.[k] ?? DEFAULT_CEILING);
    }
  }

  const office = new Set(local.officeSkills.map((s) => s.toLowerCase()));
  const skills: ImportPlan['skills'] = { install: [], present: [], unavailable: [], withFiles: [] };
  for (const s of file.skills ?? []) {
    if (s.files?.length) skills.withFiles.push(s.name);
    if (office.has(s.name.toLowerCase())) { skills.present.push(s.name); continue; }
    const n = s.name.toLowerCase();
    const hits = local.catalogSkills.filter((c) => c.name.toLowerCase() === n);
    const hit = hits.find((c) => c.owner === s.owner) ?? hits[0];
    if (hit) skills.install.push({ name: hit.name, owner: hit.owner });
    else skills.unavailable.push(s.name);
  }

  const customNames = new Set(local.customMcpNames.map((n) => n.toLowerCase()));
  const mcpManual: ImportPlan['mcpManual'] = [];
  for (const m of file.mcpServers ?? []) {
    if (m.kind === 'catalog' || customNames.has(m.name.toLowerCase())) continue;
    mcpManual.push(m.kind === 'stdio'
      ? { name: m.name, kind: 'stdio', detail: [m.command, ...m.args].join(' '), secretNames: m.envNames }
      : { name: m.name, kind: 'http', detail: m.url, secretNames: m.headerNames });
  }

  const connections: ImportPlan['connections'] = { ready: [], missing: [] };
  for (const c of file.connections ?? []) {
    const ok = c.service.startsWith('api:')
      ? local.integrations.includes(c.service.slice(4))
      : local.connections.some((l) => l.service === c.service && l.ready && l.enabled);
    (ok ? connections.ready : connections.missing).push(c);
  }

  const envHere = new Set(local.envNames);
  const envNames = file.envNames ?? [];

  let bundle: ImportPlan['bundle'];
  if (cap.bundle) {
    const servers = cleanServerList(cap.bundle.servers);
    const exists = allRoleBundles(local.customBundles).some((b: RoleBundle) => sameSet(b.servers, servers));
    bundle = { bundle: { ...cap.bundle, servers }, exists };
  }

  return {
    name: file.identity?.name ?? 'Agent',
    role: file.identity?.role,
    goal: file.prompt?.goal,
    character: file.identity?.character,
    accent: file.identity?.accent,
    provider: file.engine?.provider,
    model: file.engine?.model,
    effort: file.engine?.effort,
    tags: cap.tags ?? [],
    isolate: file.hire?.isolate === true,
    tokenCap: file.hire?.tokenCap,
    ...(grant ? { grant } : {}),
    ...(access ? { access } : {}),
    toolBlocks: cap.toolBlocks ?? [],
    unknownServers,
    needsConsent,
    skills,
    mcpManual,
    connections,
    envMissing: envNames.filter((n) => !envHere.has(n)),
    envPresent: envNames.filter((n) => envHere.has(n)),
    ...(bundle ? { bundle } : {}),
    memory: !!file.memory?.trim()
  };
}

/** {{PROJECT}} in imported text becomes the folder the human picked. */
export function fillPlaceholders(text: string, project: string): string {
  return project ? text.split(PLACEHOLDER.project).join(project) : text;
}
