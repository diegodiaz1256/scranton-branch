/**
 * Easy mode's readable thread: the conversation between the human and the
 * orchestrator as the main line, with everything else folded so it can be
 * followed by someone who never opens a terminal.
 *
 *  - What the human said, and what came back to the human, is the thread.
 *  - Messages the agents sent each other fold into one "exchange" per run,
 *    opened on demand.
 *  - Each agent's tool work becomes one line per burst ("read 3 files and ran
 *    2 commands"), from the lifecycle hooks every provider's shim reports.
 *  - "Where we are": what was asked, who is on what, what is left and what
 *    waits on the human, read from tasks, delegations and messages. No model.
 *
 * Pure and provider-neutral: tools are mapped through canonicalTool(), so
 * every CLI's names read the same. Items carry counts and kinds; the renderer
 * words them through i18n (with plurals).
 */
import { canonicalTool, parseMcpTool, serverLabel } from './agentSteps';
import { parseAnswerMail, SYSTEM_SENDERS, type ThreadMessage, type ThreadTask } from './inboxThreads';
import type { Delegation } from './delegations';

// ─── tool work, in bursts ───────────────────────────────────────────────────

/** What a tool call did, as a person would count it. */
export type WorkKind = 'read' | 'searched' | 'browsed' | 'webSearched' | 'edited' | 'wrote' | 'ran' | 'connection' | 'delegated' | 'planned' | 'other';

/** The order the parts of a sentence are told in: looking, then changing, then the rest. */
const ORDER: WorkKind[] = ['read', 'searched', 'browsed', 'webSearched', 'edited', 'wrote', 'ran', 'connection', 'delegated', 'planned', 'other'];

const KIND_OF: Record<string, WorkKind> = {
  Read: 'read',
  Glob: 'searched', Grep: 'searched', LS: 'searched',
  WebFetch: 'browsed', WebSearch: 'webSearched',
  Edit: 'edited', MultiEdit: 'edited', NotebookEdit: 'edited',
  Write: 'wrote',
  Bash: 'ran', BashOutput: 'ran', KillShell: 'ran',
  Task: 'delegated', Agent: 'delegated',
  TodoWrite: 'planned'
};

/** The kind of one tool call (any CLI), and for a connection which service. */
export function workKindOf(tool: string): { kind: WorkKind; service?: string } {
  const mcp = parseMcpTool(tool);
  if (mcp) return { kind: 'connection', service: serverLabel(mcp.server) };
  return { kind: KIND_OF[canonicalTool(tool)] ?? 'other' };
}

/** One part of a work sentence: "read 3 files", "used GitHub 2 times". */
export interface WorkPart {
  kind: WorkKind;
  count: number;
  service?: string;
}

/** A hook event, as much of it as the thread needs (a subset of HookEvent). */
export interface ThreadHookEvent {
  agentId?: string;
  event: string;
  tool?: string;
  ts?: number;
  /** Stop: the agent's last words of the turn, when the CLI reports them. */
  reply?: string;
}

/** One agent's run of tool calls, told as one line. */
export interface WorkBurst {
  agentId: string;
  start: number;
  end: number;
  /** Tool calls in it. */
  calls: number;
  parts: WorkPart[];
}

/** Gaps longer than this split a burst even without a turn ending. */
export const BURST_GAP_MS = 3 * 60_000;
/** A sentence names this many parts at most; the rest are "N other things". */
export const MAX_PARTS = 3;

/** Count tool calls into sentence parts, in telling order. More than
 *  `maxParts` kinds: the least-told ones fold into one "other" part. */
export function summarizeWork(tools: readonly string[], maxParts = MAX_PARTS): WorkPart[] {
  const parts = new Map<string, WorkPart>();
  for (const tool of tools) {
    const { kind, service } = workKindOf(tool);
    const k = service ? `${kind}:${service}` : kind;
    const p = parts.get(k);
    if (p) p.count++;
    else parts.set(k, { kind, count: 1, ...(service ? { service } : {}) });
  }
  return foldParts([...parts.values()], maxParts);
}

/** Parts in telling order, kept short: planning is only told when it is all
 *  there was, and past `maxParts` the least-told kinds become "other". */
function foldParts(parts: WorkPart[], maxParts = MAX_PARTS): WorkPart[] {
  const sorted = parts.slice().sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const told = sorted.length > 1 ? sorted.filter((p) => p.kind !== 'planned') : sorted;
  if (told.length <= maxParts) return told;
  const keep = told.filter((p) => p.kind !== 'other').slice(0, maxParts - 1);
  const rest = told.filter((p) => !keep.includes(p)).reduce((n, p) => n + p.count, 0);
  return [...keep, { kind: 'other', count: rest }];
}

/**
 * Every agent's tool calls in bursts: a burst ends when the agent's turn ends
 * (Stop), a new prompt arrives, or it goes quiet for `gapMs`. A tool reported
 * only after it ran (no PreToolUse) still counts once.
 */
export function workBursts(events: readonly ThreadHookEvent[], gapMs = BURST_GAP_MS): WorkBurst[] {
  const byAgent = new Map<string, ThreadHookEvent[]>();
  for (const e of events) {
    if (!e.agentId || typeof e.ts !== 'number') continue;
    const list = byAgent.get(e.agentId) ?? [];
    list.push(e);
    byAgent.set(e.agentId, list);
  }
  const out: WorkBurst[] = [];
  for (const [agentId, list] of byAgent) {
    const sorted = list.slice().sort((a, b) => (a.ts as number) - (b.ts as number));
    let tools: string[] = [];
    let start = 0;
    let end = 0;
    let running = new Map<string, number>();
    const flush = (): void => {
      if (tools.length) out.push({ agentId, start, end, calls: tools.length, parts: summarizeWork(tools) });
      tools = [];
      running = new Map();
    };
    for (const e of sorted) {
      const ts = e.ts as number;
      if (e.event === 'Stop' || e.event === 'UserPromptSubmit') { flush(); continue; }
      if (!e.tool) continue;
      const post = e.event === 'PostToolUse' || e.event === 'PostToolUseFailure';
      if (!post && e.event !== 'PreToolUse') continue;
      // The end of a call already counted: it only stretches the burst.
      const n = running.get(e.tool) ?? 0;
      if (post && n > 0) { running.set(e.tool, n - 1); end = Math.max(end, ts); continue; }
      if (tools.length && ts - end > gapMs) flush();
      if (!post) running.set(e.tool, (running.get(e.tool) ?? 0) + 1);
      if (!tools.length) start = ts;
      tools.push(e.tool);
      end = ts;
    }
    flush();
  }
  return out.sort((a, b) => a.start - b.start);
}

/** "a", "a and b", "a, b and c" — `and` is the translated word. */
export function joinPhrases(list: readonly string[], and: string): string {
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} ${and} ${list[list.length - 1]}`;
}

// ─── the thread ─────────────────────────────────────────────────────────────

/** A message to or from the human, or the orchestrator's words at the end of a turn. */
export interface SaidEntry {
  kind: 'said';
  ts: number;
  id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type EasyEntry =
  | SaidEntry
  /** A question the human already answered (open ones are pinned, not here). */
  | { kind: 'answered'; ts: number; taskId: string; taskLabel: string; q: string; a: string; askedBy?: string }
  /** A run of messages between agents, folded. */
  | { kind: 'exchange'; ts: number; endTs: number; messages: ThreadMessage[]; people: string[] }
  | { kind: 'work'; ts: number; burst: WorkBurst };

export interface EasyThreadInput {
  messages: readonly ThreadMessage[];
  tasks: readonly ThreadTask[];
  /** Hook events of every agent (for the work lines and the orchestrator's replies). */
  events?: readonly ThreadHookEvent[];
  godId?: string;
  gapMs?: number;
}

const ms = (iso: string | undefined): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(n) ? 0 : n;
};

/** The orchestrator is also addressed as "god". */
const isGodId = (id: string, godId?: string): boolean => id === 'god' || (!!godId && id === godId);

/** True when the human is one end of the message. */
export function humanFacing(m: Pick<ThreadMessage, 'from' | 'to'>): boolean {
  return m.from === 'human' || m.to === 'human';
}

/**
 * The whole office's story, oldest first: what the human said and what came
 * back, answered questions, folded exchanges between agents, and work lines.
 * Consecutive work lines of one agent merge into one.
 */
export function buildEasyThread(input: EasyThreadInput): EasyEntry[] {
  const { messages, tasks, events = [], godId } = input;
  const base: EasyEntry[] = [];
  const answered = new Set<string>();
  const labelOf = (task: ThreadTask): string => [task.key, task.title].filter(Boolean).join(' · ');

  for (const task of tasks) {
    for (const qa of task.humanQA ?? []) {
      if (!qa.a) continue;
      answered.add(`${task.id}\n${qa.q.trim()}`);
      base.push({ kind: 'answered', ts: ms(qa.answeredAt || qa.askedAt), taskId: task.id, taskLabel: labelOf(task), q: qa.q, a: qa.a, askedBy: godId });
    }
  }

  const seen = new Set<string>();
  const internal: ThreadMessage[] = [];
  for (const m of messages) {
    if (SYSTEM_SENDERS.has(m.from) || seen.has(m.id)) continue;
    seen.add(m.id);
    const mail = parseAnswerMail(m);
    if (mail) {
      if (answered.has(`${mail.taskId}\n${mail.q}`)) continue;
      const task = tasks.find((x) => x.id === mail.taskId);
      base.push({ kind: 'answered', ts: ms(m.created_at), taskId: mail.taskId, taskLabel: task ? labelOf(task) : mail.title, q: mail.q, a: mail.a, askedBy: godId });
      continue;
    }
    if (humanFacing(m)) {
      base.push({ kind: 'said', ts: ms(m.created_at), id: m.id, from: m.from, to: m.to, subject: m.subject, text: m.body });
    } else {
      internal.push(m);
    }
  }

  // The orchestrator's last words of each turn: it talks to the human in its
  // terminal, and this is that talk without the terminal.
  for (const e of events) {
    if (e.event !== 'Stop' || !e.agentId || !isGodId(e.agentId, godId) || !e.reply?.trim() || typeof e.ts !== 'number') continue;
    base.push({ kind: 'said', ts: e.ts, id: `stop:${e.agentId}:${e.ts}`, from: e.agentId, to: 'human', subject: '', text: e.reply.trim() });
  }

  const ordered = sortStable(base);
  const sortedInternal = internal.slice().sort((a, b) => ms(a.created_at) - ms(b.created_at));

  // Exchanges: the internal messages between two human-facing entries.
  const withExchanges: EasyEntry[] = [];
  let i = 0;
  const takeUntil = (limit: number): void => {
    const run: ThreadMessage[] = [];
    while (i < sortedInternal.length && ms(sortedInternal[i].created_at) <= limit) run.push(sortedInternal[i++]);
    if (!run.length) return;
    const people = [...new Set(run.flatMap((m) => [m.from, m.to]))].filter((p) => p !== 'broadcast');
    withExchanges.push({ kind: 'exchange', ts: ms(run[0].created_at), endTs: ms(run[run.length - 1].created_at), messages: run, people });
  };
  for (const e of ordered) {
    takeUntil(e.ts - 1);
    withExchanges.push(e);
  }
  takeUntil(Number.POSITIVE_INFINITY);

  // Work lines go in by time; one agent's lines in a row merge.
  const work: EasyEntry[] = workBursts(events, input.gapMs).map((burst) => ({ kind: 'work', ts: burst.start, burst }));
  const all = sortStable([...withExchanges, ...work]);
  const out: EasyEntry[] = [];
  for (const e of all) {
    const prev = out[out.length - 1];
    if (e.kind === 'work' && prev?.kind === 'work' && prev.burst.agentId === e.burst.agentId) {
      out[out.length - 1] = { kind: 'work', ts: prev.ts, burst: mergeBursts(prev.burst, e.burst) };
      continue;
    }
    out.push(e);
  }
  return out;
}

function mergeBursts(a: WorkBurst, b: WorkBurst): WorkBurst {
  const parts = new Map<string, WorkPart>();
  for (const p of [...a.parts, ...b.parts]) {
    const k = p.service ? `${p.kind}:${p.service}` : p.kind;
    const q = parts.get(k);
    if (q) q.count += p.count; else parts.set(k, { ...p });
  }
  return { agentId: a.agentId, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), calls: a.calls + b.calls, parts: foldParts([...parts.values()]) };
}

/** Sort by time; equal times keep their order (a question before its answer). */
function sortStable(list: EasyEntry[]): EasyEntry[] {
  return list.map((e, i) => ({ e, i })).sort((x, y) => (x.e.ts === y.e.ts ? x.i - y.i : x.e.ts - y.e.ts)).map(({ e }) => e);
}

// ─── questions waiting for the human ───────────────────────────────────────

export interface PendingQuestion {
  taskId: string;
  taskLabel: string;
  q: string;
  assignee?: string;
  askedAt: number;
}

/** The open question of every card blocked on the human (the same rule as the
 *  Ask me board: blocked, with its latest question neither answered nor
 *  dismissed), newest first. */
export function pendingQuestions(tasks: readonly ThreadTask[]): PendingQuestion[] {
  const out: PendingQuestion[] = [];
  for (const task of tasks) {
    if (task.status !== 'blocked') continue;
    const qa = [...(task.humanQA ?? [])].reverse().find((e) => e && typeof e.q === 'string' && !e.a && !e.dismissedAt);
    if (!qa) continue;
    out.push({ taskId: task.id, taskLabel: [task.key, task.title].filter(Boolean).join(' · '), q: qa.q, assignee: task.assignee, askedAt: ms(qa.askedAt) });
  }
  return out.sort((a, b) => b.askedAt - a.askedAt);
}

// ─── where we are ──────────────────────────────────────────────────────────

export interface WhereWeAre {
  /** The human's latest request, first line; undefined before the first one. */
  asked?: string;
  askedAt?: number;
  /** Who is on what right now: a card in progress, else an open delegation. */
  working: Array<{ agentId: string; what: string }>;
  /** Questions waiting for the human. */
  waitingOnYou: number;
  /** Cards still to do (backlog, to do, or blocked on something other than you). */
  left: number;
  /** Cards done. */
  done: number;
}

const firstLine = (s: string, max = 160): string => {
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * The 2-3 line summary at the top of the thread, from what the app already
 * has: the human's own messages, the task cards and the orchestrator's open
 * delegations. Answer mails are not requests.
 */
export function whereWeAre(input: { messages: readonly ThreadMessage[]; tasks: readonly ThreadTask[]; delegations?: readonly Delegation[] }): WhereWeAre {
  const { messages, tasks, delegations = [] } = input;
  let asked: string | undefined;
  let askedAt: number | undefined;
  for (const m of messages) {
    if (m.from !== 'human' || parseAnswerMail(m)) continue;
    const text = firstLine(m.body) || firstLine(m.subject);
    const at = ms(m.created_at);
    if (text && (askedAt === undefined || at >= askedAt)) { asked = text; askedAt = at; }
  }
  const working: WhereWeAre['working'] = [];
  const busy = new Set<string>();
  for (const task of tasks) {
    if (task.status !== 'doing' || !task.assignee || busy.has(task.assignee)) continue;
    busy.add(task.assignee);
    working.push({ agentId: task.assignee, what: task.title });
  }
  for (const d of delegations) {
    if (d.phase === 'returned' || busy.has(d.agentId)) continue;
    busy.add(d.agentId);
    working.push({ agentId: d.agentId, what: d.subject });
  }
  const waitingOnYou = pendingQuestions(tasks).length;
  const waitingIds = new Set(pendingQuestions(tasks).map((q) => q.taskId));
  const left = tasks.filter((t) => (t.status === 'backlog' || t.status === 'todo' || t.status === 'blocked') && !waitingIds.has(t.id)).length;
  const done = tasks.filter((t) => t.status === 'done').length;
  return { ...(asked !== undefined ? { asked, askedAt } : {}), working, waitingOnYou, left, done };
}

// ─── plain text ────────────────────────────────────────────────────────────

/** Markdown as plain text for someone who does not read markdown: no #, **,
 *  backticks or link syntax; lists become bullets; paragraphs stay. */
export function plainText(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
