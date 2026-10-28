/**
 * An agent's steps, readable: what it ran, read, edited, searched and called,
 * with the thing it did it to, instead of a terminal scrolling past. Built from
 * the lifecycle hooks every provider's shim already sends, so it works for any
 * CLI that reports tool use. Pure: main summarises each event, the renderer
 * folds them into steps.
 */
import { mcpCatalogEntry } from './mcpCatalog';

export type StepGroup = 'shell' | 'files' | 'web' | 'connections' | 'agents' | 'other';
export type StepStatus = 'running' | 'ok' | 'failed' | 'blocked';

/** The slice of a hook event the steps need (a subset of HookEvent). */
export interface StepEvent {
  event: string;
  tool?: string;
  /** Short, redacted description of what the tool was asked to do. */
  detail?: string;
  message?: string;
  blocked?: boolean;
  ts?: number;
}

export interface AgentStep {
  id: number;
  ts: number;
  kind: 'tool' | 'prompt' | 'note' | 'stop';
  tool?: string;
  group: StepGroup;
  /** What it did, in words: "Ran a command", "GitHub · create issue". */
  label: string;
  detail?: string;
  status: StepStatus;
  durationMs?: number;
}

/** Events worth keeping for the timeline; the rest (status lines, compaction…) are noise here. */
export const STEP_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Notification', 'Stop']);

const MAX_STEPS = 400;
const DETAIL_MAX = 400;

// ─── words for a tool ────────────────────────────────────────────────────────

const BUILTIN: Record<string, { label: string; group: StepGroup }> = {
  Bash: { label: 'Ran a command', group: 'shell' },
  BashOutput: { label: 'Checked command output', group: 'shell' },
  KillShell: { label: 'Stopped a command', group: 'shell' },
  Read: { label: 'Read a file', group: 'files' },
  Write: { label: 'Wrote a file', group: 'files' },
  Edit: { label: 'Edited a file', group: 'files' },
  MultiEdit: { label: 'Edited a file', group: 'files' },
  NotebookEdit: { label: 'Edited a notebook', group: 'files' },
  Glob: { label: 'Looked for files', group: 'files' },
  Grep: { label: 'Searched the code', group: 'files' },
  LS: { label: 'Listed a folder', group: 'files' },
  WebFetch: { label: 'Fetched a page', group: 'web' },
  WebSearch: { label: 'Searched the web', group: 'web' },
  Task: { label: 'Handed work to a sub-agent', group: 'agents' },
  Agent: { label: 'Handed work to a sub-agent', group: 'agents' },
  TodoWrite: { label: 'Updated its plan', group: 'other' }
};

/** Other CLIs' tools, by lowercase name → the same words as Claude's. */
const ALIASES: Record<string, string> = {
  write: 'Write', write_file: 'Write', write_to_file: 'Write', create_file: 'Write', create: 'Write',
  edit: 'Edit', edit_file: 'Edit', replace: 'Edit', str_replace: 'Edit', replace_file_content: 'Edit', multi_replace_file_content: 'MultiEdit',
  apply_patch: 'Edit', patch: 'Edit', str_replace_editor: 'Edit', str_replace_based_edit_tool: 'Edit',
  read: 'Read', read_file: 'Read', view_file: 'Read', read_many_files: 'Read',
  bash: 'Bash', shell: 'Bash', exec_command: 'Bash', run_command: 'Bash', run_shell_command: 'Bash', local_shell: 'Bash',
  grep: 'Grep', grep_search: 'Grep', search_file_content: 'Grep', codebase_search: 'Grep',
  glob: 'Glob', find_by_name: 'Glob', list: 'LS', ls: 'LS', list_dir: 'LS', list_directory: 'LS',
  webfetch: 'WebFetch', web_fetch: 'WebFetch', read_url_content: 'WebFetch', websearch: 'WebSearch', web_search: 'WebSearch', google_web_search: 'WebSearch',
  task: 'Task', todowrite: 'TodoWrite', update_plan: 'TodoWrite'
};

/** The Claude tool name another CLI's tool means, or the name as it is. */
export function canonicalTool(tool: string): string {
  return BUILTIN[tool] ? tool : ALIASES[tool.toLowerCase()] ?? tool;
}

/** `mcp__munder-github-token--work__create_issue` → server + tool. */
export function parseMcpTool(tool: string): { server: string; name: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? { server: m[1].replace(/^munder-/, ''), name: m[2] } : null;
}

/** A connection or server id as a person says it: "GitHub", "GitHub (work)". */
export function serverLabel(id: string): string {
  const [service, ...rest] = id.split('--');
  const label = mcpCatalogEntry(service)?.label ?? service.replace(/-/g, ' ');
  return rest.length ? `${label} (${rest.join(' ').replace(/-/g, ' ')})` : label;
}

export function describeTool(tool: string): { label: string; group: StepGroup } {
  const mcp = parseMcpTool(tool);
  if (mcp) return { label: `${serverLabel(mcp.server)} · ${mcp.name.replace(/[_-]+/g, ' ')}`, group: 'connections' };
  return BUILTIN[canonicalTool(tool)] ?? { label: tool, group: 'other' };
}

// ─── which files a call writes, for any CLI ─────────────────────────────────
// Each CLI names its file tools its own way: Claude Write/Edit, Codex and
// OpenCode apply_patch/patch (paths inside the patch text), Antigravity
// write_to_file/replace_file_content (TargetFile), Gemini CLI write_file/replace,
// OpenCode and Pi write/edit (filePath / path).

/** Tools that write a file, by name (lowercase, any CLI). */
const WRITE_TOOL_NAMES = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'create',
  'write_file', 'edit_file', 'create_file', 'replace', 'str_replace', 'insert',
  'write_to_file', 'replace_file_content', 'multi_replace_file_content',
  'str_replace_editor', 'str_replace_based_edit_tool',
  'apply_patch', 'patch'
]);
/** Where those tools put the path (Path: Antigravity 1.4's write_file/edit_file). */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'Path', 'TargetFile', 'targetFile', 'target_file', 'AbsolutePath', 'absolutePath', 'absolute_path', 'notebook_path', 'filename', 'file'];
/** Patch text (Codex apply_patch, OpenCode patch): the files it adds, changes or moves to. */
const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+?)\s*$/gm;

function patchPaths(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 3 || value == null) return;
  if (typeof value === 'string') {
    if (!value.includes('*** ')) return;
    for (const m of value.matchAll(PATCH_FILE)) out.add(m[1].trim());
    return;
  }
  if (Array.isArray(value)) { for (const v of value) patchPaths(v, out, depth + 1); return; }
  if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) patchPaths(v, out, depth + 1);
}

/**
 * The files one tool call writes (as the CLI gave them: absolute, or relative to
 * its folder). Empty for reads, shell commands without a patch, and a connection's
 * tools (an MCP `create_issue` is not a file).
 */
export function writtenPathsOf(tool: string | undefined, input: unknown): string[] {
  if (!tool || parseMcpTool(tool) || !input || typeof input !== 'object') return [];
  const name = tool.toLowerCase();
  const out = new Set<string>();
  // A patch anywhere in the input (also a shell command running apply_patch).
  patchPaths(input, out);
  if (WRITE_TOOL_NAMES.has(name)) {
    const i = input as Record<string, unknown>;
    // str_replace_editor's "view" only reads.
    if (!(typeof i.command === 'string' && i.command === 'view')) {
      for (const k of PATH_KEYS) if (typeof i[k] === 'string' && i[k]) { out.add((i[k] as string).trim()); break; }
    }
  }
  return [...out].filter((p) => p.length > 0 && p.length < 1024 && !p.includes('\n'));
}

// ─── what it was asked to do ────────────────────────────────────────────────

export const SECRET_VALUE = /\b(?:ghp_|gho_|ghs_|github_pat_|sk-|sk_live_|sk_test_|xox[abp]-|AKIA|AIza|glpat-|ntn_|secret_)[A-Za-z0-9_-]{8,}/g;
export const SECRET_ASSIGN = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)=\S+/g;
const SECRET_FIELD = /(key|token|secret|password|passwd|auth|credential)/i;

/** Hide anything that looks like a credential before it is shown or kept. */
export function redact(text: string): string {
  return text
    .replace(/\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{8,}/g, '$1 ***')
    .replace(SECRET_VALUE, '***')
    .replace(SECRET_ASSIGN, '$1=***')
    .replace(/:\/\/([^/\s:@]+):[^/\s@]+@/g, '://$1:***@');
}

const clip = (s: string, n = DETAIL_MAX): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A readable one-liner for what a tool call was asked to do. Empty when there is nothing to say. */
export function summarizeToolInput(tool: string | undefined, input: unknown): string {
  if (!tool || !input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  let out = '';
  // A file written by any CLI's tool: say which file(s), not the content.
  const written = BUILTIN[tool] ? [] : writtenPathsOf(tool, input);
  if (written.length) return clip(redact(written.join(', ')));
  switch (canonicalTool(tool)) {
    case 'Bash': out = str(i.command) || (Array.isArray(i.command) ? (i.command as unknown[]).filter((x) => typeof x === 'string').join(' ') : '') || str(i.cmd) || str(i.CommandLine); break;
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': out = str(i.file_path) || str(i.notebook_path); break;
    case 'Glob': out = [str(i.pattern), str(i.path)].filter(Boolean).join('  in  '); break;
    case 'Grep': out = [str(i.pattern), str(i.path)].filter(Boolean).join('  in  '); break;
    case 'LS': out = str(i.path); break;
    case 'WebFetch': out = str(i.url); break;
    case 'WebSearch': out = str(i.query); break;
    case 'Task': case 'Agent': out = str(i.description) || str(i.prompt); break;
    case 'TodoWrite': out = Array.isArray(i.todos) ? `${i.todos.length} items` : ''; break;
    default: {
      // A connection or another tool: its simple arguments, key=value.
      out = Object.entries(i)
        .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
        .map(([k, v]) => `${k}=${SECRET_FIELD.test(k) ? '***' : String(v)}`)
        .join('  ');
    }
  }
  return clip(redact(out.replace(/\s+/g, ' ').trim()));
}

// ─── folding events into steps ──────────────────────────────────────────────

export function stepFromEvent(ev: StepEvent, id: number, now: number): AgentStep | null {
  const ts = ev.ts ?? now;
  switch (ev.event) {
    case 'PreToolUse': {
      if (!ev.tool) return null;
      const d = describeTool(ev.tool);
      return { id, ts, kind: 'tool', tool: ev.tool, group: d.group, label: d.label, detail: ev.detail || undefined, status: ev.blocked ? 'blocked' : 'running' };
    }
    case 'UserPromptSubmit':
      return { id, ts, kind: 'prompt', group: 'other', label: 'Received a message', detail: ev.detail ? clip(redact(ev.detail)) : undefined, status: 'ok' };
    case 'Notification':
      return ev.message ? { id, ts, kind: 'note', group: 'other', label: ev.message, status: 'ok' } : null;
    case 'Stop':
      return { id, ts, kind: 'stop', group: 'other', label: 'Finished its turn', status: 'ok' };
    default:
      return null;
  }
}

/**
 * Apply one hook event to a step list (returns a new list). A tool's Pre and
 * Post meet in one step: it starts "running" and ends "ok" or "failed" with its
 * duration. A Post with no Pre (started before we listened) becomes its own step.
 */
export function foldStep(steps: AgentStep[], ev: StepEvent, now = Date.now()): AgentStep[] {
  if (!STEP_EVENTS.has(ev.event)) return steps;
  const nextId = (steps[steps.length - 1]?.id ?? 0) + 1;
  let out = steps;
  if (ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure') {
    const failed = ev.event === 'PostToolUseFailure';
    const ts = ev.ts ?? now;
    // The oldest still-running step of that tool: tools can overlap.
    const idx = steps.findIndex((s) => s.kind === 'tool' && s.status === 'running' && s.tool === ev.tool);
    if (idx >= 0) {
      out = steps.slice();
      out[idx] = { ...steps[idx], status: failed ? 'failed' : 'ok', durationMs: Math.max(0, ts - steps[idx].ts) };
    } else if (ev.tool) {
      const d = describeTool(ev.tool);
      out = [...steps, { id: nextId, ts, kind: 'tool', tool: ev.tool, group: d.group, label: d.label, detail: ev.detail || undefined, status: failed ? 'failed' : 'ok' }];
    }
  } else {
    const s = stepFromEvent(ev, nextId, now);
    if (!s) return steps;
    // A turn ending finishes whatever was still marked running (a missed Post).
    out = ev.event === 'Stop' ? steps.map((x) => (x.status === 'running' ? { ...x, status: 'ok' as const } : x)) : steps;
    out = [...out, s];
  }
  return out.length > MAX_STEPS ? out.slice(out.length - MAX_STEPS) : out;
}

export function foldSteps(events: StepEvent[], now = Date.now()): AgentStep[] {
  return events.reduce<AgentStep[]>((acc, ev) => foldStep(acc, ev, now), []);
}
