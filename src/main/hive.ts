/**
 * The Hive — the on-disk multi-agent coordination layer.
 *
 * Lives under `<harnessHome>/hive/` as a single git repo that ONLY this main
 * process commits to (agents never call git — they just write files). See
 * HIVE.md for the full design. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - hive identity (registry.json: id/role/cwd/session — what agents read),
 *     separate from the UI floor roster (`<harnessHome>/roster.json`)
 *   - shared blackboard (board.md), task ledger, and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). The hive keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the floor.
 *   - single-committer git with retry/backoff + stale-lock recovery
 *
 * Everything here runs in the Electron main process.
 */
import { messageBody } from '../shared/messageBody';
import { mkdir as mkdirAsync, readdir as readdirAsync, readFile as readFileAsync, stat as statAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { gitInvocation, linuxizeText, parseWslPath, runInDistro, runInDistroAsync, toWslUnc, type WslLocation, distroHomeUnc } from './wsl';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, lstatSync, realpathSync, rmSync, appendFileSync,
  symlinkSync, unlinkSync, copyFileSync, cpSync, chmodSync, openSync, readSync, closeSync, fstatSync
} from 'node:fs';
import { join, dirname, basename, isAbsolute, relative, resolve, posix } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile, spawnSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import type { AgentUsageSample } from './usage';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
import {
  isClaudeProvider,
  isHiveAwareProvider,
  canReceiveInbox,
  providerPreset,
  bridgeOf,
  type AgentProvider
} from '../shared/agentProvider';
import { MCP_CATALOG } from '../shared/mcpCatalog';
import { GENERATED_DOC_NOTICE, PROTOCOL_DIR, protocolFiles } from './protocolDocs';
import { connectionsPromptLine, envPromptLine, type PromptConnection } from '../shared/agentConnections';
import type { Access } from '../shared/connectionAccess';
import { confidentialityPromptLine, criticalAllows, heldIds, isCustodian, VAULT_ROOT, type CriticalMap } from '../shared/criticalConnections';
import { custodianWriteRoots, signoffPromptLine } from '../shared/criticalSignoff';
import { selectBroadcastTargets } from '../shared/broadcast';
import { preferredAgentRole } from '../shared/agentRole';
import { mergeTaskLedger, patchTaskInLedger } from '../shared/taskLedger';
import { mergeTaskNotices, taskEditNotices, taskEditPatch, type TaskEdit, type TaskEditError, type TaskStatus } from '../shared/taskEdit';
import { expandTilde } from './fs';
import { resolveGodName } from '../shared/godIdentity';
import { assignTaskKeys, formatTaskKey, normalizeTaskKeyLedger, taskKeyPrefix } from '../shared/taskKeys';
import { cleanServerList } from '../shared/roleBundles';
import { detectProjectType, memoryInstruction, memoryTemplate, parseMemory, type ProjectType } from '../shared/memorySections';
import { listsInstruction, parseList } from '../shared/lists';
import { blockedMcpServers, cleanToolBlocks, disallowedTools } from '../shared/nativeTools';
import { bwrapArgs, mountPoints } from '../shared/bwrapSandbox';
import { within, type GuardPolicy } from '../shared/toolGuard';
import { MD_SKILLS } from './skillsCli';
import { copySkillTreeSync, restoreExecBits } from './skillArchive';
import { readOfficeSkills, skillReaches, type OfficeSkills, type SkillPolicy } from '../shared/skillRequests';
import { MD_BROWSE } from './browseCli';
import { BROKER_CLIENT_JS } from './brokerClient';
import { MD_LISTS_MCP } from './listsMcp';
import { liveNamesakes, similarLive, supersededArchived } from './namesakes';

/** The subset of HarnessConfig the hive consumes for the default-MCP merge.
 *  Kept as a local shape so hive.ts never imports the foundation-owned config
 *  module just for a type. */
type McpDefaultsMap = { [id: string]: { enabled: boolean } } | undefined;

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

/** What `settleInbox` did to a released worker's mailbox. */
export interface SettledInbox {
  /** Unread messages filed under inbox/.done. */
  moved: number;
  /** Unread messages left pending because they arrived after the cut-off. */
  kept: number;
  /** The filed messages that asked for something — their sender never gets
   *  an answer, and deserves to hear so instead of waiting on a dead worker.
   *  `conversation` lets the caller tell the worker's own work order (which
   *  it just completed) from a genuinely unanswered request. */
  unanswered: Array<{ id: string; act: MessageAct; from: string; subject: string; conversation: string }>;
}

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** One hive message reshaped for the voice read-layer (`hive:messages`): the
 *  operator-briefing view of an inbox/outbox message. `subject` and `body` are
 *  REDACTED main-side (see {@link redactSecrets}) before this ever leaves the
 *  main process — the renderer/voice layer never sees a raw body, and never a
 *  secret. PII-free + secret-free by construction. */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: MessageAct;
  /** REDACTED subject line. */
  subject: string;
  /** REDACTED message body. */
  body: string;
  requires_reply: boolean;
  /** The message this one answers, if any (an id, never content). */
  in_reply_to?: string | null;
  /** Which mailbox folder this copy was read from, relative to `owner`. */
  direction: 'inbox' | 'outbox';
  /** The agent whose mailbox this copy lives in. */
  owner: string;
  /** True when read from an archived/handled subfolder (inbox/.done, outbox/.sent). */
  archived: boolean;
  created_at: string;
}

/** One question→answer exchange with the human, recorded ON the task card so
 *  the decision trail stays with the work it unblocked. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  /** `cancelled`: the human stopped it (shared/taskEdit.ts). */
  status: TaskStatus;
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** The ticket key the human gave the card (e.g. a Jira key), shown instead
   *  of the generated one. */
  ticket?: string;
  /** When the human cancelled it. */
  cancelledAt?: string;
  /** First-class human feedback: the god appends {q} when a card can only
   *  proceed with the human's input (status goes blocked); the harness UI
   *  fills in {a}. The full history stays on the card forever. */
  humanQA?: HumanQA[];
  /** Outcome summary, surfaced by the Slack done-notifier when this card reaches
   *  'done'. Optional; the notifier falls back to description/title. */
  result?: string;
  /** The task this card is a piece of (a subtask), by id. */
  parent?: string;
  /** Set when this task originated from a Slack message — the thread the
   *  done-summary reply is posted back into. Consumed OUTBOUND only; populating
   *  it is the inbound/kanban side's job and does not affect routing. */
  slack?: { channel: string; thread_ts: string };
  /** Set when this task originated from a generic webhook POST. Stores the SHA-256
   *  of the capability token (never the raw token — that's returned to the caller
   *  once and never persisted), so a GET status lookup can match by hashing the
   *  presented token. Read-only capability: it never widens routing or exposure. */
  webhook?: { tokenHash: string };
}

export interface AgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on. Defaults to 'claude' when unset (legacy). */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — enriches prompts and forwards them to Michael.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** The human has this agent 1:1 and Michael must leave it alone until they
   *  flip it back. Held agents stay ACTIVE and keep their terminal — this is
   *  "do not dispatch to them", not "they are gone", which is why it is its own
   *  flag rather than a reuse of `archived` or a breaker level. */
  onHold?: boolean;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
  /** Whether `cwd` is actually usable for a (re)spawn — i.e. an ABSOLUTE path
   *  that exists as a directory. Computed + persisted at spawn so the roster
   *  reliably exposes each worker's environment validity. A non-absolute fragment
   *  (e.g. "ClaudeTerminalHarness") spawns into a nonexistent dir and fails; this
   *  flag makes that visible instead of letting it slip through silently. */
  cwdValid?: boolean;
  /** Set on an ARCHIVED agent once a single live agent with the same name has
   *  replaced it (a re-hire under a new id): the id to use instead. The entry
   *  and its folder are kept as history; readers of the roster skip it. Cleared
   *  when this agent itself is respawned. */
  supersededBy?: string;
  /** Set while the agent is a temp the orchestrator started through
   *  spawn-requests. Persisted (not just main's in-memory worker map) so a temp
   *  brought back by Restore team after an app restart is still a temp: it is
   *  tracked again, released on its done signal, and a finished one is not
   *  respawned at all. ensureAgent keeps it across respawns. */
  temp?: TempHiring;
}

/** What main needs to keep treating a temp as a temp across an app restart. */
export interface TempHiring {
  reqId: string;
  /** Epoch ms of the hiring: only a done authored after it counts. */
  spawnedAt: number;
  baseBranch: string;
  tokenCap?: number;
  objective?: string;
  slack?: { channel: string; thread_ts: string };
  /** Who asked for it: the orchestrator (spawn-requests) or the human (Temps). */
  hiredBy?: 'orchestrator' | 'human';
}

/** One entry of an agent's MCP config: a stdio server it runs itself, or a
 *  keyed server it reaches through main's gateway. */
export type McpServerEntry =
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> };

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** Build env + extra spawn args that make an agent process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  /** The hive-protocol seed to TYPE into the TUI after boot rather than pass on
   *  argv — set only for `seedDelivery:'type-into-tui'` providers (Crush), whose
   *  bare TUI rejects a positional seed. The renderer types it through the same
   *  per-pty write-chain as the inbox-wake nudge. (ondev-b) */
  seedPrompt?: string;
  /** Set when the agent spawned in a DEGRADED posture the user should know about
   *  (today: the proxy-bridge sidecar never bound after retries, so a proxy-tier
   *  agent such as Crush runs without hive events). Human-readable, one line. */
  degraded?: string;
  /** An OS sandbox the app wraps the CLI in (bubblewrap, for pi on Linux and
   *  WSL floors): run `bwrap <wrap…> -- <command> <args…>` instead of the
   *  command. Absent: the CLI runs as is. */
  wrap?: string[];
  /** Whether the agent runs in an OS sandbox: its CLI's own, the app's, or
   *  none (pi on native Windows, or bubblewrap missing). */
  osSandbox?: 'cli' | 'app' | 'none';
}

/** Longest path a Unix socket can be bound at, with room to spare (sun_path is
 *  104 bytes on macOS, 108 on Linux, NUL included). */
const MAX_SOCK_PATH = 100;

/**
 * Where the hook socket goes for a hive `root` (POSIX). Normally
 * `<root>/hooks.sock`; when that path is too long to bind (an office deep in
 * the home folder, iCloud Drive…) every bind failed and the floor ran with
 * hooks allowed and no cost recorded. Then: a short per-user path, named by a
 * hash of the root so two offices never share it — in $XDG_RUNTIME_DIR (a
 * private per-user folder) when there is one, else a 0700 folder in the temp dir.
 */
export function hookSockPath(root: string, env: { runtimeDir?: string; tmp: string; uid?: number }): string {
  // POSIX only (Windows uses a named pipe, see sockPath), so POSIX joins: the
  // same answer whatever OS computes it.
  const join = posix.join;
  const normal = join(root, 'hooks.sock');
  if (Buffer.byteLength(normal) <= MAX_SOCK_PATH) return normal;
  const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const base = env.runtimeDir && env.runtimeDir.trim() ? env.runtimeDir : join(env.tmp, `scranton-branch-${env.uid ?? 'u'}`);
  return join(base, `md-hooks-${id}.sock`);
}

/** `git log --format=%x1e%an%x1f%aI --name-only` → who changed each file (the
 *  newest author first; the app's own "Hive" commits are not people). */
export function parseFileAuthors(out: string): Record<string, { authors: string[]; last: string; lastTs: string }> {
  const map: Record<string, { authors: string[]; last: string; lastTs: string }> = {};
  for (const chunk of out.split('\x1e').filter(Boolean)) {
    const [headLine, ...files] = chunk.split(/\r?\n/);
    const [author, ts] = headLine.split('\x1f');
    if (!author || author === 'Hive') continue;
    for (const f of files.map((x) => x.trim()).filter(Boolean)) {
      const e = map[f] ?? (map[f] = { authors: [], last: author, lastTs: ts });
      if (!e.authors.includes(author)) e.authors.push(author);
    }
  }
  return map;
}

/** A message id / agent id usable as a file or folder name: no separators, no `..`. */
const SAFE_MSG_ID = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;
const HOP_CAP = 12;

/** The author line and message of an agent's deliverable commit. */
function deliverableCommitIdentity(rels: string[], author: { id: string; name: string }): { who: string; msg: string } {
  const clean = (x: string) => x.replace(/[<>\n\r]/g, '').trim().slice(0, 60) || 'agent';
  return {
    who: `${clean(author.name)} <${clean(author.id).replace(/[^A-Za-z0-9._-]/g, '-')}@hive.local>`,
    msg: `deliverable: ${rels.join(', ').slice(0, 300)} (${clean(author.name)})`
  };
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** Non-memory files `mempalace mine` must not ingest (Claude Code hooks config,
 *  cursor, raw inbox/outbox JSON). `mempalace mine` honors .gitignore, so we drop
 *  one in each agent dir; written on birth here and refreshed by the mine loop.
 *
 *  `.codex/` is here for a second reason as well, and it is the load-bearing one:
 *  a Codex worker's CODEX_HOME lives INSIDE its agent dir (see installCodexHooks —
 *  Codex can only be given hooks through a config.toml in its own home, so it
 *  cannot share the user's ~/.codex). Codex then fills that folder with full
 *  session transcripts, an 80MB+ logs sqlite and a plugin cache, and the hive's
 *  git repo was faithfully versioning every revision of all of it. Twenty Codex
 *  agents took the hive's .git to 7.5GB, at which point git's own auto-gc tried to
 *  repack it and took 22GB of RAM doing so — the machine swapped, the app stopped
 *  responding. None of it was ever wanted in history: it is Codex's private
 *  scratch state, and it stays on disk (so resume still works) either way. */
/** Proxy-bridge sidecar bind attempts per spawn, and the pause before each retry. */
const PROXY_BIND_ATTEMPTS = 3;
const PROXY_BIND_BACKOFF_MS = [250, 750];

const MINE_IGNORE_LINES = ['settings.json', 'cursor.json', 'inbox/', 'outbox/', '.codex/'];

/** Idempotently ensure `<agentDir>/.gitignore` excludes the non-memory files.
 *  Append-only: writes only the missing lines, leaving any existing entries. */
/** The git work tree `dir` is in (where `.git` is, walking up), or null. */
export function enclosingGitRepo(dir: string): string | null {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return null;
}

function ensureMineIgnore(agentDir: string): void {
  const path = join(agentDir, '.gitignore');
  let existing = '';
  try { if (existsSync(path)) existing = readFileSync(path, 'utf8'); } catch { return; }
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = MINE_IGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  try { writeFileSync(path, prefix + missing.join('\n') + '\n', 'utf8'); } catch { /* best-effort */ }
}

/**
 * Strip secret-shaped substrings out of free text before it leaves the main
 * process toward the voice / renderer layer. This is the MAIN-SIDE privacy gate
 * for the voice read-layer's message-content path (`hive:messages`): a message
 * body can quote a key, paste a token, or echo a credential, so every body and
 * subject is run through this before it crosses IPC. The renderer holds ZERO
 * redaction policy — it only ever receives the already-cleaned string.
 *
 * Deliberately CONSERVATIVE: it matches known credential SHAPES (provider key
 * prefixes, JWTs, PEM private keys, bearer tokens) and sensitive key=value /
 * key: value assignments, then replaces the secret with `[redacted]`. It does
 * NOT blanket-redact on entropy, so operator-meaningful content the briefing
 * needs — git SHAs, agent ids, file paths, ordinary prose — survives intact.
 * Over-redaction (e.g. a non-secret `apikey:openai` ref) is acceptable; leaking
 * a real secret is not.
 *
 * LOCKSTEP: the regex battery below is mirrored character-identically in
 * test/voice-messages.test.cjs (a .cjs test cannot import this TS module). If
 * you change a pattern here, mirror it there — the test is what PROVES a
 * secret-shaped value is stripped.
 */
export function redactSecrets(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let s = text;
  // 1. PEM private-key blocks (RSA/EC/OPENSSH/PGP — header through footer).
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]');
  // 2. JSON Web Tokens — three base64url segments separated by dots.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
  // 3. Known credential prefixes: OpenAI/Anthropic (sk-, sk-ant-), Slack
  //    (xoxb/xoxp/xoxa/xoxr/xoxs-, xapp-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  //    github_pat_), AWS access-key ids (AKIA…), Google API keys (AIza…).
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    '[redacted]'
  );
  // 4. Bearer tokens — keep the label, drop the credential.
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  // 5. Sensitive key = value / key: value — keep the key name, drop the value.
  //    An optional namespace prefix (aws_, gcp_, …) is folded into the captured
  //    key so a LABELED secret survives the \b boundary: `aws_secret_access_key`
  //    is all word chars, so a bare `\b(secret)\b` never sees it. Listing
  //    secret_access_key / private_key alone is not enough — the prefix run is
  //    what lets `aws_secret_access_key=…` (no AKIA shape on the value) redact.
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`
  );
  return s;
}

// ─── HiveManager ────────────────────────────────────────────────────────────

/**
 * Repair only literal CR/LF characters that occur inside JSON strings.
 *
 * Agents normally publish outbox messages through JSON.stringify, but a manual
 * shell write can put real line-break bytes in a multi-line body. JSON rejects
 * those bytes inside a string even though the intended value is unambiguous.
 * Keep this lexical and deliberately narrow: JSON.parse remains the acceptance
 * gate, and every other malformed shape is left for quarantine.
 */
function repairLiteralLineBreaksInJsonStrings(raw: string): { text: string; changed: boolean } {
  let text = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (const ch of raw) {
    if (!inString) {
      text += ch;
      if (ch === '"') inString = true;
      continue;
    }

    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      text += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      text += ch;
      inString = false;
      continue;
    }

    if (ch === '\n') {
      text += '\\n';
      changed = true;
      continue;
    }

    if (ch === '\r') {
      text += '\\r';
      changed = true;
      continue;
    }

    text += ch;
  }

  return { text, changed };
}

/** Keep the crash directory bounded.
 *
 *  One file per abnormal exit, 8 KB each, is fine until the failure being
 *  diagnosed is a crash loop -- which is the case this exists for. A provider
 *  that dies during startup and gets relaunched writes a file per attempt, so
 *  the scenario that most needs the diagnostic also produces the most files.
 *
 *  Filenames begin with an ISO timestamp, so a lexicographic sort is already
 *  chronological and no stat() is needed to find the oldest.
 *
 *  Best-effort throughout: a diagnostic that breaks teardown is worse than one
 *  that keeps a few extra files. */
const MAX_CRASH_LOGS = 50;

function pruneCrashLogs(dir: string): void {
  try {
    const logs = readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    for (const stale of logs.slice(0, Math.max(0, logs.length - MAX_CRASH_LOGS))) {
      try { unlinkSync(join(dir, stale)); } catch { /* already gone, or not ours */ }
    }
  } catch { /* unreadable directory is not worth failing an exit path over */ }
}

/**
 * The last `n` lines of a file, reading it backwards in chunks instead of
 * whole. log.jsonl only grows, and the app reads its tail every couple of
 * seconds (the Now feed, the delegation map): a whole-file synchronous read
 * blocked the main thread for longer and longer, worst on a WSL office.
 */
export function tailLines(path: string, n: number): string[] {
  if (n <= 0) return [];
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    let pos = fstatSync(fd).size;
    const CHUNK = 64 * 1024;
    let text = '';
    let count = 0;
    while (pos > 0 && count <= n) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const chunk = buf.toString('utf8');
      for (let i = 0; i < chunk.length; i++) if (chunk.charCodeAt(i) === 10) count++;
      text = chunk + text;
    }
    const lines = text.split('\n').filter(Boolean);
    // A chunk can start mid-line (or mid-character): drop that partial first line.
    if (pos > 0) lines.shift();
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}

export class HiveManager {
  /**
   * @param getHome  Lazily resolve harnessHome so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to animate routed
   *                 messages on the office floor; a no-op in tests/headless.
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => boolean | void
  ) {}

  private routerTimer: NodeJS.Timeout | null = null;

  /** The embedded OTLP collector's loopback URL, set by the main process once the
   *  collector is bound (telemetry.ts). null = telemetry off → no OTel env is
   *  injected at spawn (the transcript reconciler remains the cost source). */
  private _otelEndpoint: string | null = null;
  /** Point newly-spawned agents at the live telemetry collector. Call after the
   *  collector starts; only affects spawns made afterwards. */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** The collector URL agents are pointed at, or null when telemetry is off. */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  /** What the app running this hive actually IS: its version, and whether it is a
   *  packaged build or a local dev run.
   *
   *  Agents could not see this before, and it cost real time. A multi-agent
   *  investigation into anomalous file modes ran for hours before the explanation
   *  turned out to be that the operator had quit a downloaded build and started a
   *  local one, which inherits the launching shell's umask instead of Finder's
   *  022. No agent could observe that, several published conclusions had to be
   *  withdrawn, and log.jsonl carried no app-start marker to notice the switch
   *  from either. */
  private _runtime: { version: string; packaged: boolean; appPath?: string } | null = null;
  setRuntimeInfo(info: { version: string; packaged: boolean; appPath?: string } | null): void {
    this._runtime = info;
  }
  runtimeInfo(): { version: string; packaged: boolean; appPath?: string } | null {
    return this._runtime;
  }

  /** Whether config.orchestratorMaySpawn is on, mirrored here so the prompt
   *  builder can decide whether to tell god the spawn queue is available. Set at
   *  bootstrap and on every config write; hive.ts deliberately does not import
   *  the config module. */
  private _maySpawn = false;
  setOrchestratorMaySpawn(on: boolean): void {
    this._maySpawn = on;
  }
  orchestratorMaySpawn(): boolean {
    return this._maySpawn;
  }

  // — paths —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** IPC endpoint the cth-hook shim talks to (Phase 1 autonomy).
   *  On POSIX this is a Unix-domain socket file under the hive root. On Windows,
   *  Node's `net` IPC uses named pipes (a flat `\\.\pipe\` namespace, not the
   *  filesystem), so a raw file path fails to bind with EACCES — derive a stable,
   *  per-root pipe name instead. Both the server (`listen`) and the shim
   *  (`createConnection`) read this same value, so they stay in sync. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\munder-difflin-${id}`;
    }
    const sock = hookSockPath(root, { runtimeDir: process.env.XDG_RUNTIME_DIR, tmp: tmpdir(), uid: process.getuid?.() });
    // The short fallback lives in a folder only this user can open (the hook
    // server takes no password: who can reach the socket can speak for agents).
    if (sock !== join(root, 'hooks.sock')) {
      try {
        mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
        // Someone else's folder (made first in a shared /tmp), or one others
        // can open, is never used: keep the normal path, whose bind failure is
        // reported, rather than a socket another user could take over.
        const st = lstatSync(dirname(sock));
        const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
        if (!st.isDirectory() || !mine || (st.mode & 0o077) !== 0) return join(root, 'hooks.sock');
      } catch { return join(root, 'hooks.sock'); }
    }
    return sock;
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }
  /** The proxy-bridge sidecar (qwen). Pure-Node loopback reverse-proxy that
   *  observes a hookless CLI's LLM traffic and synthesizes the same HIVE_SOCK
   *  payloads the hook shims emit. Written in ensureHive alongside cth-hook.cjs. */
  private proxyShimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'hive-proxy.cjs') : null;
  }

  /**
   * The BUNDLED-NODE launcher: `<root>/bin/hive-node` (POSIX) / `hive-node.cmd`
   * (Windows). Every `.cjs` shim in the hive is executed through it.
   *
   * Why it exists: hooks are run by the agent CLI through a plain
   * `/bin/sh -c` with a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A user whose
   * node comes from nvm (PATH set only by an interactive login shell) has NO node
   * there, so a hook written as `node "<shim>"` exits **127 — command not found**
   * and every payload is silently lost: no live status, no Stop→inbox drain, no
   * session ids. Electron's own binary IS a full Node runtime under
   * `ELECTRON_RUN_AS_NODE=1`, and it is guaranteed present (it is us).
   *
   * A wrapper SCRIPT rather than an inline `ELECTRON_RUN_AS_NODE=1 "<exe>" …`
   * prefix because that prefix is POSIX-sh syntax — it is a hard error under
   * cmd.exe, which is what runs hook commands on Windows. The wrapper also gives
   * agents a `$HIVE_NODE` they can invoke directly (running the Electron binary
   * WITHOUT the env var would launch a second app window, not a script).
   *
   * Rewritten on every bootstrap, so an app update/move re-bakes execPath.
   */
  private nodeLauncherPath(): string | null {
    const root = this.root();
    if (!root) return null;
    return join(root, 'bin', process.platform === 'win32' ? 'hive-node.cmd' : 'hive-node');
  }

  /** Write the launcher described above. Best-effort: on failure callers fall
   *  back to bare `node`, i.e. exactly the pre-fix behavior. */
  private writeNodeLauncher(): void {
    const p = this.nodeLauncherPath();
    if (!p) return;
    try {
      if (process.platform === 'win32') {
        writeFileSync(p, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`, 'utf8');
      } else {
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeNodeLauncher failed:', e);
    }
  }

  /** The launcher path if it is actually on disk, else null (→ callers fall back
   *  to bare `node`, i.e. exactly the pre-fix behavior — never worse than before). */
  private nodeLauncher(): string | null {
    const p = this.nodeLauncherPath();
    return p && existsSync(p) ? p : null;
  }

  /** The ABSOLUTE bundled-node command to BAKE into any text an agent is expected
   *  to run (`<launcher> <script> …`), falling back to bare `node`.
   *
   *  Exactly the value of the agent's `HIVE_NODE` env var — but agent-facing text
   *  must never spell it as `$HIVE_NODE`: that is POSIX shell syntax. A Windows
   *  agent runs its commands through cmd.exe/PowerShell, where `$HIVE_NODE`
   *  expands to NOTHING (cmd) or to an undefined variable (PowerShell), so every
   *  such instruction is dead on arrival there. The absolute path is correct on
   *  every platform and needs no expansion at all. */
  nodeCommand(): string {
    // A WSL floor's agents run in the distro, where the launcher (a Windows
    // .cmd starting electron.exe) cannot run: their own node does.
    if (this.wslRoot()) return 'node';
    return this.nodeLauncher() ?? 'node';
  }

  /**
   * `<root>/bin/runtime` — the same bundled-node trick as `hive-node`, but the
   * wrapper is NAMED `node`, so anything that resolves `node` off PATH finds one.
   *
   * `hive-node` only covers commands WE generate. It does nothing for node that
   * the agent's own work needs at runtime: an MCP server declared as
   * `node ./server.js`, a provider CLI that shells out to node, a `.cjs` helper an
   * agent wrote itself. On a machine with no system node those all die with 127
   * exactly like the hooks did.
   *
   * This dir is APPENDED to the agent's PATH (see pty.spawn), never prepended: a
   * user who has their own node keeps their own version — we are strictly the
   * fallback. Prepending would silently swap every agent's node for Electron's
   * (20.18.1 as of Electron 32.3.3) underneath the user's own projects.
   *
   * NOTE: `node` only — deliberately no `npm`/`npx`. Electron bundles the Node
   * RUNTIME, not the npm CLI (which is ~12MB of JS we do not ship), so an `npm`
   * wrapper here could only be a stub that fails confusingly. A missing `npm` is
   * the honest signal; the install ladder (main/cliInstall.ts) detects it and
   * installs a REAL system Node — which brings npm with it. This shim is only the
   * last resort for when that install could not run (offline, or a platform with
   * no official installer).
   */
  runtimeBinDir(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'runtime') : null;
  }

  /** Write the `node` shim described above. Best-effort: on failure the dir is
   *  simply absent from PATH and behavior is exactly as before. */
  private writeRuntimeShims(): void {
    const dir = this.runtimeBinDir();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'node.cmd'),
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8'
        );
      } else {
        const p = join(dir, 'node');
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeRuntimeShims failed:', e);
    }
  }

  /** Build a hook command string that runs `script` under the guaranteed node,
   *  DOUBLE-QUOTED (safe for paths with spaces). */
  private nodeRun(script: string, ...args: string[]): string {
    // A WSL floor's agents run inside the distro: Linux node, Linux paths.
    if (this.wslRoot()) return ['node', `"${this.forAgent(script)}"`, ...args].join(' ');
    const launcher = this.nodeLauncher();
    return [launcher ? `"${launcher}"` : 'node', `"${script}"`, ...args].join(' ');
  }

  // ─── WSL floors (main/wsl.ts) ───────────────────────────────────────────────
  // A floor that lives in a distro runs its agents there. Main still reads and
  // writes the hive through the \\wsl.localhost path; anything an AGENT reads
  // (hook commands, settings, mcp.json, identity) carries Linux paths, and
  // provider configs go to the distro's home, not the Windows profile.

  /** The distro and Linux path of a WSL floor, else null. */
  wslRoot(): WslLocation | null {
    return process.platform === 'win32' ? parseWslPath(this.root()) : null;
  }

  /** Do this floor's agents run on Windows (cmd.exe hook commands, .cmd
   *  launchers)? False on POSIX and on a WSL floor. */
  private winAgents(): boolean {
    return process.platform === 'win32' && !this.wslRoot();
  }

  /** Text an agent will read, with this floor's UNC paths as Linux paths. */
  forAgent(text: string): string {
    const w = this.wslRoot();
    return w ? linuxizeText(text, w.distro) : text;
  }

  /** Every string in a JSON-able value through forAgent (settings, mcp.json). */
  private forAgentJson<T>(value: T): T {
    if (!this.wslRoot()) return value;
    const walk = (v: unknown): unknown =>
      typeof v === 'string' ? this.forAgent(v)
        : Array.isArray(v) ? v.map(walk)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
        : v;
    return walk(value) as T;
  }

  /** Link `link` → `target`. On a WSL floor, when both live in the floor's
   *  distro, Linux makes the link: a Windows junction cannot point into
   *  \\wsl.localhost, and a copy of auth.json goes stale on token refresh. */
  private linkPath(target: string, link: string, dir: boolean): void {
    const w = this.wslRoot();
    const t = w ? parseWslPath(target) : null;
    const l = w ? parseWslPath(link) : null;
    if (w && t && l && t.distro.toLowerCase() === w.distro.toLowerCase() && l.distro.toLowerCase() === w.distro.toLowerCase()) {
      runInDistro(w.distro, 'ln', ['-s', '--', t.linuxPath, l.linuxPath]);
      return;
    }
    symlinkSync(target, link, dir ? (process.platform === 'win32' ? 'junction' : 'dir') : undefined);
  }

  /** The loopback port of each agent's proxy sidecar (bridged into WSL). */
  private proxyPorts = new Map<string, number>();
  /** What each agent may do beyond its CLI's own rules (git, its folders),
   *  set at spawn and read by the hook server at PreToolUse (toolGuard.ts). */
  private guardPolicies = new Map<string, GuardPolicy>();
  proxyPortFor(agentId: string): number | undefined { return this.proxyPorts.get(agentId); }

  private distroHomes = new Map<string, string>();
  /** The home folder the agents' CLIs use: the Windows profile, or the
   *  distro user's home (as a \\wsl.localhost path) on a WSL floor. */
  private userHome(): string {
    const w = this.wslRoot();
    if (!w) return homedir();
    let h = this.distroHomes.get(w.distro);
    if (!h) {
      try { h = runInDistro(w.distro, 'sh', ['-c', 'printf %s "$HOME"']); } catch { h = ''; }
      if (!h.startsWith('/')) h = '/root';
      this.distroHomes.set(w.distro, h);
    }
    return toWslUnc(w.distro, h);
  }

  /** A hook command for a CLI that runs it through cmd.exe on Windows (agy,
   *  Gemini, Codex). Those CLIs cannot be handed quotes: they escape embedded
   *  quotes the C-runtime way (`\"`), which cmd.exe does not understand (#350).
   *  But unquoted, a hive under a path with a space (`D:\Dunder Mifflin\…`)
   *  splits at the space and every hook dies, so the agent never reports a
   *  state again.
   *
   *  So the command carries no path at all once a path has a space in it: a
   *  `<name>.cmd` wrapper (which may quote freely — it is a batch file, not an
   *  argument) goes into `bin/runtime`, which pty.spawn appends to every hive
   *  agent's PATH, and the hook command is just the wrapper's name. Short 8.3
   *  names would be the other way out, but volumes routinely have them turned
   *  off. Without a space nothing changes. */
  private windowsHookCommand(name: string, script: string, ...args: string[]): string {
    if (this.wslRoot()) return this.nodeRun(script, ...args);
    const launcher = this.nodeLauncher() ?? 'node';
    if (!/\s/.test(launcher) && !/\s/.test(script)) return [launcher, script, ...args].join(' ');
    const dir = this.runtimeBinDir();
    if (dir) {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${name}.cmd`), `@echo off
"${launcher}" "${script}" %*
`, 'utf8');
        return [name, ...args].join(' ');
      } catch (e) {
        console.error('[hive] could not write hook wrapper:', e);
      }
    }
    return [launcher, script, ...args].join(' ');
  }

  /** The hook command for Claude Code. On Windows it runs hooks through Git
   *  Bash, and bash hands a `.cmd` to cmd.exe: a quoted batch path with a space
   *  followed by a quoted argument arrives mangled ("…\Dunder" is not
   *  recognized), so under an office path with a space every hook died (no
   *  Stop → inbox drain, no live status). A quoted wrapper path with no quoted
   *  argument survives, so then the shim is baked into a wrapper in
   *  `bin/runtime`. Without a space nothing changes. */
  private claudeHookCommand(shim: string): string {
    if (process.platform !== 'win32' || this.wslRoot()) return this.nodeRun(shim);
    const launcher = this.nodeLauncher() ?? 'node';
    if (!/\s/.test(launcher) && !/\s/.test(shim)) return this.nodeRun(shim);
    const dir = this.runtimeBinDir();
    if (!dir) return this.nodeRun(shim);
    try {
      mkdirSync(dir, { recursive: true });
      const wrapper = join(dir, `md-claude-${basename(shim).replace(/\.c?js$/, '').replace(/[^A-Za-z0-9_-]/g, '-')}.cmd`);
      writeFileSync(wrapper, `@echo off\r\n"${launcher}" "${shim}" %*\r\n`, 'utf8');
      return `"${wrapper}"`;
    } catch (e) {
      console.error('[hive] could not write the Claude hook wrapper:', e);
      return this.nodeRun(shim);
    }
  }

  /** One proxy sidecar per live proxy-tier agent, keyed by agentId. Spawned in
   *  ensureAgent, killed on PTY exit / removeAgent / app quit (index.ts) — so a
   *  dead agent never leaks an orphan loopback listener. */
  private proxyChildren = new Map<string, ChildProcess>();

  // — bootstrap —

  /** Create the hive skeleton + git repo if missing. Idempotent. */
  private hiveEnsuredFor: string | null = null;
  /** ensureHive once per office per run: every spawn and every task write
   *  re-checked a dozen protocol docs and the hive's own files (~25 file
   *  operations, slow under an antivirus). The boot path still runs the full
   *  ensureHive, which also restores anything deleted since. */
  private ensureHiveOnce(root: string): void {
    if (this.hiveEnsuredFor === root && existsSync(join(root, 'registry.json'))) return;
    this.ensureHive();
    this.hiveEnsuredFor = root;
  }

  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    for (const { filename, contents } of GENERATED_HIVE_DOCS) {
      const path = join(root, filename);
      if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents, 'utf8'); }
    }

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const userCodexHome = join(this.userHome(), '.codex');
    for (const [id, agent] of Object.entries(this.registry().agents)) {
      const codexHome = join(root, 'agents', id, '.codex');
      if (agent.provider === 'codex' && existsSync(codexHome)) {
        this.exposeCodexDataDirs(codexHome, userCodexHome, id);
      }
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // Keep the churny/ephemeral live files out of the hive git repo.
    const gitignore = join(root, '.gitignore');
    // `crashes/` holds raw PTY output from abnormal agent exits. It is
    // DELIBERATELY ignored: that output is whatever the provider printed, which
    // can include tokens, paths and prompt fragments, and the hive repo is
    // committed on every change — a secret written there would be permanent.
    // log.jsonl gets the structured, non-sensitive fields; the dump stays local.
    // usage-alerts.json: which usage-window notices were sent (usageAlerts.ts).
    const want = ['fleet.json', 'hooks.sock', 'cost-ledger.jsonl', 'crashes/', '.DS_Store', '.mcp.json', 'usage-alerts.json'];
    let lines: string[] = [];
    if (existsSync(gitignore)) { try { lines = readFileSync(gitignore, 'utf8').split('\n'); } catch { lines = []; } }
    const missing = want.filter((w) => !lines.includes(w));
    if (missing.length) writeFileSync(gitignore, [...lines.filter(Boolean), ...missing].join('\n') + '\n', 'utf8');

    // A real, empty .mcp.json in the hive root. Claude Code's sandbox protects
    // that file in every folder a sandboxed command may write: when it is
    // missing, each sandboxed Bash call creates an empty placeholder there and
    // removes it afterwards. Every agent may write the hive root, so one
    // agent's cleanup deleted the file another agent's bubblewrap was about to
    // mount ("bwrap: Can't get type of source …/hive/.mcp.json"). With the file
    // in place the sandbox mounts it read-only and never creates or removes it.
    // It declares no servers; agents get theirs through --mcp-config.
    const mcpJson = join(root, '.mcp.json');
    // An empty one is a placeholder a sandbox left behind: fill it in.
    let mcpSize = -1;
    try { mcpSize = statSync(mcpJson).size; } catch { /* missing */ }
    if (mcpSize <= 0) { try { writeFileSync(mcpJson, '{ "mcpServers": {} }\n', 'utf8'); } catch { /* next bootstrap */ } }

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. Refreshed
    // on every bootstrap so it tracks code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    // Written only when this build's versions differ from what is on disk (a
    // stamp of their contents), or one is missing. Rewriting all of them on
    // every launch cost seconds of blocked main thread on a WSL office, where
    // each write crosses \\wsl.localhost.
    const binFiles: Array<[string, string]> = [
      [this.shimPath()!, HOOK_SHIM],
      // The proxy-bridge sidecar for hookless CLIs (qwen).
      [this.proxyShimPath()!, PROXY_BRIDGE_SHIM],
      // md-api: an agent's door to the REST integrations behind the key broker.
      [join(root, 'bin', 'md-api.cjs'), MD_API_CLI],
      // md-run: ask the app to run a runner (a command with secrets the agent never sees).
      [join(root, 'bin', 'md-run.cjs'), MD_RUN_CLI],
      // munder-lists: the human's lists as MCP tools (listsMcp.ts).
      [join(root, 'bin', 'md-lists.cjs'), MD_LISTS_MCP],
      // md-browse: the office browser (browser.ts), as a command and an MCP server.
      [join(root, 'bin', 'md-browse.cjs'), MD_BROWSE],
      // md-skills: the orchestrator's search of the skills catalog (skillsCli.ts).
      [join(root, 'bin', 'md-skills.cjs'), MD_SKILLS]
    ];
    const stampPath = join(root, 'bin', '.generated');
    const stamp = createHash('sha1').update(binFiles.map(([p, c]) => `${p}\0${c}`).join('\0')).digest('hex');
    let current = '';
    try { current = readFileSync(stampPath, 'utf8').trim(); } catch { /* first run */ }
    if (current !== stamp || binFiles.some(([p]) => !existsSync(p))) {
      for (const [p, c] of binFiles) writeFileSync(p, c, 'utf8');
      try { writeFileSync(stampPath, stamp, 'utf8'); } catch { /* next launch rewrites */ }
    }
    // The bundled-node launcher every shim above is invoked through — MUST be
    // written before any hook installer runs (they probe for it).
    this.writeNodeLauncher();
    // …and the PATH-visible `node` fallback for the agent's OWN subprocesses.
    this.writeRuntimeShims();

    if (!existsSync(join(root, '.git'))) {
      this.git(['init', '-q'], root);
      this.commit('hive: init');
    }
  }

  /** Deliberately replace generated hive docs with the bundled versions. */
  /** refreshGeneratedDocs() off the main thread, writing only the docs whose
   *  text changed (the boot path: ~190 ms of sync writes under an antivirus). */
  async refreshGeneratedDocsAsync(): Promise<void> {
    const root = this.root();
    if (!root) return;
    const dirs = new Set<string>();
    for (const { filename, contents } of GENERATED_HIVE_DOCS) {
      const path = join(root, filename);
      try {
        if (await readFileAsync(path, 'utf8') === contents) continue;
      } catch { /* missing: write it */ }
      const dir = dirname(path);
      if (!dirs.has(dir)) { await mkdirAsync(dir, { recursive: true }); dirs.add(dir); }
      await writeFileAsync(path, contents, 'utf8');
    }
  }

  refreshGeneratedDocs(): void {
    const root = this.root();
    if (!root) return;
    for (const { filename, contents } of GENERATED_HIVE_DOCS) {
      const path = join(root, filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents, 'utf8');
    }
  }

  /** Validate an agent's cwd the way a spawn does — it must be an ABSOLUTE path
   *  that exists as a directory. Surfaced as `cwdValid` on the registry entry so
   *  the roster reliably exposes whether a worker's working directory is usable.
   *  Best-effort; never throws (a stat error degrades to invalid). */
  private cwdValidity(cwd: string | undefined): { valid: boolean; issue: string | null } {
    if (!cwd || typeof cwd !== 'string') return { valid: false, issue: 'missing' };
    // Defense-in-depth: a `~/…` cwd from an older registry entry (written before
    // ingestion-time expansion) would read as 'not-absolute' forever. Expand first
    // so the roster reports the truth about the directory the spawn would use.
    cwd = expandTilde(cwd);
    if (!isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
    try {
      return statSync(cwd).isDirectory()
        ? { valid: true, issue: null }
        : { valid: false, issue: 'not-a-directory' };
    } catch {
      return { valid: false, issue: 'missing-dir' };
    }
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (provider-specific args + env) that makes the process hive-aware.
   */
  async ensureAgent(
    meta: AgentMeta,
    opts: {
      semanticMemory?: boolean;
      knowledgeGraph?: boolean;
      /** ABSOLUTE path to the Knowledge-Graph CLI (`knowledge.env().KG_CLI`), baked
       *  into the agent's prompt instead of a `$KG_CLI` shell reference — `$VAR` is
       *  POSIX-only and expands to nothing under cmd.exe/PowerShell, so the KG
       *  instructions were unusable on Windows. Optional: undefined degrades to the
       *  old env-var spelling. */
      kgCliPath?: string;
      /** Proxy-tier CLIs: the endpoint their sidecar forwards to (the user's
       *  base URL for that engine). Passed here, never through process.env,
       *  which every later agent would inherit. */
      proxyUpstream?: string;
      /** TLS for the proxy sidecar's upstream (the app's CA bundle, and
       *  verification off only when the user chose it). */
      tls?: { caFile?: string; insecure?: boolean };
      /** REST integrations this agent may call through the key broker (its
       *  MD_BROKER_TOKEN is granted for exactly these). Listed in its prompt with
       *  the md-api command; empty/undefined → no line. */
      integrations?: Array<{ id: string; label: string }>;
      /** Runners this agent may ask for (envVault.ts): names only, never values. */
      runners?: Array<{ id: string; name: string; description?: string; secrets: string[] }>;
      /** Keyed connections this agent can really call (keyedConnectionsFor),
       *  described for its prompt so it uses them by default. */
      connections?: PromptConnection[];
      /** Names of the plain variables in this agent's environment. */
      envNames?: string[];
      /** The critical connections this agent is the custodian of (labels), for
       *  its CONFIDENTIALITY block. Empty/undefined → not a custodian. */
      critical?: string[];
      /** A custodian's confidential vaults (one per critical connection it
       *  holds): writable for it, named in its prompt. Pass them in
       *  extraWritableDirs too. */
      vaults?: string[];
      /** Folders this agent may not even read: other agents' confidential
       *  vaults. Refused by the path guard, hidden by the OS sandbox
       *  (denyRead) and by Claude Code's permission rules. */
      denyDirs?: string[];
      /** The custodian of a critical connection, locked down: it writes only
       *  its own hive folder and its vaults (path guard and OS sandbox), its
       *  shell reaches no network, its folder stays out of the hive's history,
       *  and everything it sends out waits for the human's sign-off. `outgoing`
       *  is where it puts files meant for research/. */
      lockdown?: { outgoing: string };
      theme?: 'light' | 'dark';
      /** Consent state for the default-MCP bundle (W3). Threaded from the live
       *  HarnessConfig by the caller; undefined → catalog defaults apply. */
      mcpDefaults?: { [id: string]: { enabled: boolean } };
      /** This agent's own MCP grant (Pro Capabilities), catalog ids. When set it
       *  REPLACES the default set for this agent; write/secret servers in it still
       *  need the user's consent in mcpDefaults. Undefined → the defaults. */
      mcpGrant?: string[];
      /** Claude Code tool groups taken from this agent (shared/nativeTools.ts). */
      toolBlocks?: string[];
      /** Per-server agent lists (Manager → Connections "Choose agents"): a server
       *  listed here reaches only these agent ids. Absent → everyone it would
       *  otherwise reach. */
      mcpScopes?: Record<string, string[]>;
      /** Claude Code loads only the servers the app hands it (--strict-mcp-config), not
       *  the user's own ~/.claude.json, a project's .mcp.json or ones the agent adds.
       *  Default on: agents reach only what is managed. */
      mcpOnlyManaged?: boolean;
      /** App-resources `skills/` source dir (W3). The bundled read-only skills are
       *  copied into the agent's `.claude/skills/` per spawn; undefined or missing
       *  is a no-op (tolerated until Kevin populates the resource dir). */
      skillsDir?: string;
      /** Extra directories the agent's sandbox may write (e.g. the shared
       *  MemPalace dir, which `mempalace` mutates). Absolute paths; ignored
       *  for providers without a sandbox. */
      extraWritableDirs?: string[];
      /** More folders this agent may write in (the orchestrator: the office's
       *  registered repos). */
      writableRoots?: string[];
      /** The human let this agent write outside its folders (Capabilities). */
      roam?: boolean;
      /** The key broker this agent was handed (MD_BROKER_URL): its sandbox may
       *  reach that one loopback port (hookSettings). */
      brokerUrl?: string;
    } = {}
  ): Promise<SpawnInjection> {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHiveOnce(root);

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });

    // Resolve role BEFORE writing identity.md. A restart passes the floor
    // roster's `description`, which can be a status caption ("on standby").
    // identity.md and registry.role are the durable job from the hire.
    const reg = this.registry();
    const prev = reg.agents[meta.id];
    if (meta.cwd) meta = { ...meta, cwd: expandTilde(meta.cwd) };
    const role = preferredAgentRole(meta.role, prev?.role, !!meta.isGod);
    meta = { ...meta, role };

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.forAgent(this.identityText(meta)), 'utf8'); // refresh on each spawn

    // W3 — bundled read-only skills: refresh the agent's .claude/skills/ from the
    // app-resources skills/ dir on every spawn (same policy as identity.md), so an
    // agent always rides with the shipped safe skill set. Tolerant: a missing or
    // partial source dir is a no-op (Kevin populates the resource dir in lp-manifest).
    if (opts.skillsDir) this.copyBundledSkills(opts.skillsDir, join(dir, '.claude', 'skills'));
    // Skills the orchestrator gave this agent (office.json).
    this.syncOfficeSkills(meta.id);

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      // Sections the Memory screen shows per project (shared/memorySections.ts).
      writeFileSync(memory, memoryTemplate(meta.name, meta.id, this.projectTypeOf(meta.cwd)), 'utf8');
    }
    ensureMineIgnore(dir); // keep settings.json / cursor / messages out of mempalace's index
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry — spread the PRIOR entry first so a respawn preserves
    // fields the spawn `meta` doesn't carry, above all `sessionId`. Without this,
    // ensureAgent (which runs before the resume lookup in the pty:spawn handler)
    // would wipe the recorded session id, so `lastSession()` returns undefined and
    // `--resume` is never attached — i.e. every restart starts a fresh thread.
    // Validate the working directory at the source so a bad value is visible on
    // the roster (cwdValid) rather than silently spawning into a nonexistent dir.
    // Store the EXPANDED cwd, never the raw `~/…` the user typed — the registry is
    // read by hooks, the roster and the worker watcher, none of which run a shell.
    const cwd = this.cwdValidity(meta.cwd);
    reg.agents[meta.id] = {
      ...prev,
      ...meta,
      capabilities: meta.capabilities ?? prev?.capabilities ?? [],
      role,
      status: 'idle',
      cwdValid: cwd.valid,
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      archived: false,
      // Back on the floor, so no longer replaced by anyone.
      supersededBy: undefined,
      lastSeen: Date.now()
    };
    if (meta.isGod) reg.godId = meta.id;
    // A respawn can make this agent the one live successor of archived
    // namesakes: flag them in the same write.
    this.flagSuperseded(reg);
    this.atomicWriteJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    // Only logs on an invalid cwd (rare) — not a per-spawn line, so no log spam.
    if (!cwd.valid) {
      this.appendLog({ kind: 'cwd_invalid', agentId: meta.id, cwd: meta.cwd, issue: cwd.issue });
    }
    this.commit(`hive: register ${meta.id}`);

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir
    };
    // The bundled-node launcher, so an agent can run the hive's .cjs helpers (KG
    // CLI, Slack reply helper) even when `node` is not on its PATH. Invoking the
    // Electron binary directly would open a second app window, so this must stay
    // the wrapper path and never process.execPath.
    //
    // Kept as an env var for agent CONVENIENCE and for anything that reads it
    // programmatically — but agent-facing TEXT no longer references it by name:
    // `$HIVE_NODE` is POSIX-only syntax and expands to nothing under cmd.exe /
    // PowerShell, so every such instruction was dead on a Windows floor. Commands
    // we write for an agent to run bake `nodeCommand()`'s absolute path instead.
    env.HIVE_NODE = this.nodeCommand();
    // Generic light/dark hint for TUIs that paint their own background. The app
    // defaults to light but every agent CLI assumed a dark terminal, so Crush and
    // OpenCode looked pasted into a light window. COLORFGBG is the classic
    // "fg;bg" convention (rxvt/konsole) that lipgloss/termenv fall back to when
    // an OSC 11 query gets no answer. Claude Code gets the same hint through its
    // per-session settings.json (hookSettings); Crush and OpenCode through their
    // per-agent config dirs below. A running TUI does not re-read this: new
    // agents pick up the current theme, running ones keep the one they started with.
    if (opts.theme) env.COLORFGBG = opts.theme === 'dark' ? '15;0' : '0;15';

    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');

    // Git and its folders, enforced at PreToolUse (hooks.ts -> toolGuard.ts).
    // A WSL floor's agents run in the distro: `~`, the temp dir and Claude's
    // projects folder are the distro's, not the Windows ones the app runs with.
    const wslFloor = this.wslRoot();
    const wslHome = wslFloor ? distroHomeUnc(wslFloor.distro) : null;
    const agentPlaces = wslFloor
      ? ['/tmp', ...(wslHome ? [join(wslHome, '.claude', 'projects')] : [])]
      : [tmpdir(), '/tmp', join(homedir(), '.claude', 'projects')];
    this.guardPolicies.set(meta.id, {
      cwd: meta.cwd || dir,
      roots: opts.lockdown
        ? custodianWriteRoots(dir, opts.vaults ?? [])
        : [...new Set([meta.cwd, ...this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs), ...(opts.writableRoots ?? []),
          ...agentPlaces].filter((d): d is string => typeof d === 'string' && d.length > 0))],
      git: opts.lockdown ? false : gitAllowed(opts.mcpDefaults, opts.mcpGrant),
      contained: opts.lockdown ? true : !opts.roam,
      ...(opts.lockdown ? { fenceHint: `As the custodian of a critical connection you write only in your own folder (${this.forAgent(dir)}) and your confidential vault. Mail goes through your outbox and files for research/ through ${this.forAgent(opts.lockdown.outgoing)}; the human signs both off before anything leaves.` } : {}),
      ...(opts.denyDirs?.length ? { deny: opts.denyDirs } : {}),
      ...(wslHome ? { home: wslHome } : {})
    });

    // Non-hive-aware providers (for example Antigravity, Codex, Grok and Pi) don't
    // understand Claude Code's flags (no `--append-system-prompt`, no telemetry,
    // no `--settings`). Instead: (1) the hive identity+protocol rides in as the
    // session's INITIAL prompt — the closest thing to `--append-system-prompt`
    // these CLIs offer (after the first turn the session continues normally); and
    // (2) lifecycle hooks are wired via the preset's `hookBridge` below. Together
    // that makes a Gemini/Codex worker a full hive citizen — live status +
    // Stop→inbox-drain — without Claude installed at all.
    //
    // How the prompt rides in differs by CLI:
    //  - agy takes it under a flag (`agy -i "<prompt>"`) → push [flag, prompt].
    //  - codex/grok/pi take it POSITIONALLY (`codex|grok|pi "<prompt>"`) → push the
    //    bare prompt as a trailing arg (node-pty passes argv literally, so it
    //    arrives as one positional argument after codex's own flags).
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag = preset.initialPromptFlag;
      const prompt = this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, opts.integrations, opts.runners, opts.connections, opts.envNames, cleanToolBlocks(opts.toolBlocks).includes('web'), opts.critical, opts.vaults, opts.lockdown?.outgoing);
      // agy, codex, and grok expose a Claude-style lifecycle-hook surface, so each
      // gets the SAME live status + Stop→inbox-drain Claude does — selected by the
      // preset's `hookBridge`. agy needs a translating shim (its hook stdin/stdout
      // shape differs from Claude's); codex reuses the Claude `cth-hook` shim
      // verbatim (its hook payload + response contract are already Claude-shaped)
      // and is isolated to a per-agent CODEX_HOME so the user's global Codex
      // configuration is never mutated. Both share the HIVE_SOCK wiring below.
      const preArgs: string[] = [];
      let degraded: string | undefined;
      let piWrap: string[] | null | undefined;
      // Dispatch on the structured bridge descriptor (the foundation's `bridgeOf`
      // derives {kind:'hooks'} from the legacy `hookBridge` for agy/codex, and
      // returns the explicit {kind:'proxy'} for qwen). Two ways a hookless CLI
      // becomes a hive citizen:
      //   - 'hooks' → install a config-file hook shim (agy translator / codex verbatim).
      //   - 'proxy' → spawn a loopback reverse-proxy sidecar that observes the CLI's
      //               LLM traffic and SYNTHESIZES the same HIVE_SOCK payloads.
      const desc = bridgeOf(meta.provider);
      const sock = this.sockPath();
      if (desc && sock) {
        env.HIVE_SOCK = sock;
        try {
          if (desc.kind === 'hooks') {
            if (desc.shim === 'agy') this.installAgyHooks();
            else if (desc.shim === 'codex') {
              env.CODEX_HOME = this.installCodexHooks(dir, meta.id);
              // Codex refuses to run hooks from a config dir without persisted
              // "hook trust" (normally an interactive gate). Our hooks.json is
              // hive-authored inside an isolated CODEX_HOME, so we bypass that gate
              // for this automated spawn — the flag's documented use ("automation
              // that already vets hook sources"). Without it the hooks silently
              // never fire. Must precede the positional prompt.
              preArgs.push('--dangerously-bypass-hook-trust');
              // Auto mode keeps codex's OS sandbox (`-a never -s workspace-write`,
              // agentProvider.ts). workspace-write only covers cwd, so the agent
              // folder (inbox/.done, memory.md, outbox) and the shared hive root
              // (research deliverables, the board for god) are added as extra
              // writable roots. Harmless outside auto mode.
              for (const d of this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs)) preArgs.push('--add-dir', d);
            }
            else if (desc.shim === 'pi') {
              // Pi (earendil-works) has a rich pi.on(event) lifecycle. We drop a
              // bundled extension into a PER-AGENT PI_CODING_AGENT_DIR (so the user's
              // global ~/.pi is never touched) that posts cth-hook-shaped payloads to
              // HIVE_SOCK on tool_call/agent_end and auto-approves tools when the floor
              // is in auto mode. HIVE_AUTO_APPROVE (set in spawnAgentCore from
              // config.autoMode) gates the auto-allow — Pam guardrail #5.
              // Verified live on Pi 1.0.4 (WSL, local model): the extension loads from
              // PI_CODING_AGENT_DIR and posts the session id, tool calls, per-response
              // usage and agent_end. The renderer idle inbox-wake nudge stays the backstop.
              env.PI_CODING_AGENT_DIR = this.installPiHooks(dir);
              // Pi has no sandbox of its own: where bubblewrap runs (Linux, a
              // WSL floor's distro), the app builds one like Claude Code's.
              piWrap = await this.piSandbox(meta, dir, root, opts, sock);
            }
            else if (desc.shim === 'opencode') {
              // OpenCode (anomalyco/opencode) has no Claude-shaped Stop hook, but its
              // plugin API exposes a real session.idle event (god Decision 1). We drop
              // a bundled plugin into a PER-AGENT OPENCODE config dir that posts
              // HIVE_SOCK payloads on tool.execute.before/after + session.idle — the
              // same Stop→drain semantics, provider-agnostic, no traffic interception.
              // LIVE-UNVERIFIED (plugin auto-load + session.idle firing); the renderer
              // idle inbox-wake nudge is the guaranteed drain fallback.
              env.OPENCODE_CONFIG_DIR = this.installOpenCodePlugin(dir, opts.theme);
            }
            else if (desc.shim === 'gemini') {
              // Point only this worker at a per-agent system settings file so
              // the bridge is trusted and ~/.gemini/settings.json stays untouched.
              env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = this.installGeminiHooks(dir);
            }
            else if (desc.shim === 'grok') this.installGrokHooks();
          } else if (desc.kind === 'proxy') {
            // Stable per-spawn session id, stamped on every synthesized payload so
            // recordSession (registry resume key) and the cost ledger persist.
            const spawnTs = String(Date.now());
            const sessionId = `proxy-${meta.id}-${createHash('sha1').update(root + meta.id + spawnTs).digest('hex').slice(0, 12)}`;
            env.HIVE_PROXY_SESSION = sessionId;
            // The CLI normally reads its upstream base URL from `baseUrlEnv`; capture
            // the user's configured value as the sidecar's UPSTREAM, then point the
            // CLI at the loopback proxy instead. Fall back to the cloud default if
            // the user hasn't set one.
            const upstream = opts.proxyUpstream || process.env[desc.baseUrlEnv]
              || (desc.api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
            // A loopback bind on port 0 fails only transiently (a busy moment, a
            // slow sidecar start past the 4s ceiling), so try a few times before
            // giving up: without this ONE bad moment at spawn cost the agent its
            // hive events for the whole session.
            const port = await this.startProxyBridgeWithRetry(meta.id, { sock, sessionId, api: desc.api, upstream, caFile: opts.tls?.caFile, insecure: opts.tls?.insecure });
            if (port > 0) this.proxyPorts.set(meta.id, port); else this.proxyPorts.delete(meta.id);
            // Only redirect the CLI through the proxy if the sidecar actually bound a
            // port. On failure leave routing untouched → the CLI talks to its real
            // upstream directly (degraded: no synthesized hive events, but it still
            // runs). Deliberate degradation is fine; SILENT degradation is not, so
            // the failure goes to log.jsonl, the renderer and the spawn result.
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
              if (meta.provider === 'crush') {
                // Crush has NO base-URL env override, so the generic env-rewrite is a
                // no-op for it. Route it instead via a per-agent CRUSH_GLOBAL_CONFIG
                // whose chosen provider's base_url points at the loopback proxy
                // (installCrushConfig — sibling of installCodexHooks). `upstream`
                // (captured above from the inert sentinel env or cloud default) is the
                // proxy's real target. Per-agent CRUSH_GLOBAL_DATA isolates session
                // state from the user's global ~/.config/crush.
                const crush = this.installCrushConfig(dir, loopback, desc.api, opts.theme);
                env.CRUSH_GLOBAL_CONFIG = dir;
                env.CRUSH_GLOBAL_DATA = crush.data;
              } else {
                env[desc.baseUrlEnv] = loopback;
              }
            }
            else {
              // Still talk to the user's endpoint directly: without this a local
              // model (Ollama, vLLM…) would silently fall back to the cloud.
              if (opts.proxyUpstream) env[desc.baseUrlEnv] = opts.proxyUpstream;
              degraded = `${meta.name} is running without hive events: its proxy bridge did not bind after ${PROXY_BIND_ATTEMPTS} attempts. Live status, cost and inbox wake will not work for this session. Respawn the agent to try again.`;
              console.error(`[hive] proxy bridge for ${meta.id} did not bind — spawning without hive events`);
              this.appendLog({ kind: 'proxy-degraded', agentId: meta.id, name: meta.name, provider: meta.provider, attempts: PROXY_BIND_ATTEMPTS });
              this.emit?.('hive:degraded', { agentId: meta.id, name: meta.name, reason: 'proxy-bind', message: degraded });
            }
          }
        } catch (e) { console.error(`[hive] install ${desc.kind} bridge failed:`, e); }
      }
      // Inject the protocol text whichever way the CLI accepts it.
      // type-into-tui (Crush): the bare TUI reads a positional as a Cobra subcommand
      // → `Unknown command`. So DROP the positional and hand the protocol back as
      // seedPrompt; the renderer types it into the TUI after boot (ondev-b).
      const deg = {
        ...(degraded ? { degraded } : {}),
        ...(piWrap !== undefined ? { osSandbox: piWrap ? 'app' as const : 'none' as const, ...(piWrap ? { wrap: piWrap } : {}) } : {})
      };
      if (preset.seedDelivery === 'type-into-tui') return { args: [...preArgs], env, seedPrompt: prompt, ...deg };
      // Providers with no declared seed strategy intentionally spawn bare. Inbox-capable
      // non-hive-aware presets are guarded by the provider contract tests.
      if (flag) return { args: [...preArgs, flag, prompt], env, ...deg };
      if (preset.positionalInitialPrompt) return { args: [...preArgs, prompt], env, ...deg };
      return { args: preArgs, env, ...deg };
    }

    // Stage 7A — first-party Claude Code telemetry → the embedded loopback OTLP
    // collector (telemetry.ts). Pure env, no --settings change. Only injected
    // for Claude Code once the collector is up (otelEndpoint set), so telemetry-
    // off installs and non-Claude providers spawn exactly as before.
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5s — near-live without spamming
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args: string[] = [];
    if (!claudeProvider) return { args, env };

    // MCP servers go in their own file, passed with --mcp-config: Claude Code does
    // NOT load `mcpServers` from a --settings file (verified on 2.1.286 — a server
    // listed there is never started), so the default bundle and every Capabilities
    // grant used to reach no agent at all. --mcp-config is additive to the user's
    // own servers. It takes several values, so the option pushed right after it
    // ends the list and nothing positional can be swallowed as a config path.
    if (opts.lockdown) this.keepOutOfHistory(meta.id, dir);
    const mcp = this.buildDefaultMcpServers(meta.cwd, opts.mcpDefaults, opts.mcpGrant, meta.id, opts.mcpScopes, opts.toolBlocks);
    const mcpPath = join(dir, 'mcp.json');
    // A custodian never loads servers of its own or the user's, whatever the setting.
    const onlyManaged = opts.mcpOnlyManaged !== false || isCustodian(this.criticalMap(), meta.id);
    if (Object.keys(mcp.servers).length) {
      this.writeJson(mcpPath, this.forAgentJson({ mcpServers: mcp.servers }));
      args.push('--mcp-config', mcpPath);
      if (onlyManaged) args.push('--strict-mcp-config');
      // Only the gateway capability token rides in env (the file says `${...}`);
      // keys never reach the agent at all.
      Object.assign(env, mcp.env);
    } else if (existsSync(mcpPath)) {
      try { rmSync(mcpPath, { force: true }); } catch { /* stale, harmless */ }
    }
    // Nothing managed to hand over, and still nothing else allowed.
    if (onlyManaged && !Object.keys(mcp.servers).length) args.push('--strict-mcp-config');

    // The orchestrator delegates through the office (spawn-requests, inboxes).
    // Claude Code's own sub-agent tool starts a helper inside its session that
    // the office never sees: no employee, no temp, no task tracking. Asked to
    // "put an agent on it", Michael reached for that tool instead. Listed
    // before --append-system-prompt, which ends this variadic option.
    // Tools taken away in Capabilities (Web, Shell…) go the same way.
    const blockedTools = disallowedTools(opts.toolBlocks, !!meta.isGod);
    if (blockedTools.length) args.push('--disallowedTools', ...blockedTools);
    // The human already authorised these connections (and the gateway enforces
    // what each may do): no permission prompt per call, or an agent just waits.
    const allowedConnections = Object.keys(mcp.servers).filter((n) => mcp.env.MD_MCP_TOKEN && (mcp.servers[n] as { type?: string }).type === 'http');
    if (allowedConnections.length) args.push('--allowedTools', ...allowedConnections.map((n) => `mcp__${n}`));
    args.push('--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, opts.integrations, opts.runners, opts.connections, opts.envNames, cleanToolBlocks(opts.toolBlocks).includes('web'), opts.critical, opts.vaults, opts.lockdown?.outgoing));

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      const requireSandbox = await this.sandboxAvailable();
      this.writeJson(settingsPath, this.forAgentJson(this.hookSettings(shim, opts.theme, opts.lockdown ? custodianWriteRoots(dir, opts.vaults ?? []) : this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs), requireSandbox || !!opts.lockdown, opts.brokerUrl, opts.denyDirs, !!opts.lockdown)));
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /** Update the durable job string (hire role) without respawning. Refreshes
   *  registry.json + identity.md so the floor editor and the hive stay aligned. */
  patchAgentRole(id: string, role: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled' };
    const next = role.trim();
    if (!next) return { ok: false, error: 'empty role' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'unknown agent' };
      if (agent.role === next) return { ok: true };
      agent.role = next;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      writeFileSync(join(this.agentDir(id), 'identity.md'), this.forAgent(this.identityText(agent)), 'utf8');
      this.appendLog({ kind: 'role', agentId: id, role: next });
      this.commit(`hive: role ${id}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Flag (in place) archived agents that one live namesake has replaced
   *  (namesakes.ts). Only adds or re-points flags: a successor that is merely
   *  not running right now (the app booting, a team mid-restore) does not
   *  un-supersede anyone. Returns what changed. */
  private flagSuperseded(reg: Registry): Record<string, string> {
    const changed: Record<string, string> = {};
    for (const [id, heir] of Object.entries(supersededArchived(reg.agents))) {
      const a = reg.agents[id];
      if (a && a.supersededBy !== heir) { a.supersededBy = heir; changed[id] = heir; }
    }
    return changed;
  }

  /** flagSuperseded on the registry on disk, written only when something
   *  changed. Folders and history are never touched. */
  markSuperseded(): Record<string, string> {
    const root = this.root();
    if (!root) return {};
    try {
      const reg = this.registry();
      const changed = this.flagSuperseded(reg);
      if (Object.keys(changed).length) {
        this.atomicWriteJson(join(root, 'registry.json'), reg);
        this.commit('hive: flag archived agents replaced by a live namesake');
      }
      return changed;
    } catch { return {}; }
  }

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || agent.archived === archived) return;
      agent.archived = archived;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
      this.commit(`hive: ${archived ? 'archive' : 'unarchive'} ${id}`);
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /** Record (or, with null, clear) that an agent is a temp. Best-effort. */
  setTemp(id: string, temp: TempHiring | null): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return;
      if (temp) agent.temp = temp;
      else if (agent.temp) delete agent.temp;
      else return;
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.commit(`hive: ${temp ? 'temp' : 'untemp'} ${id}`);
    } catch { /* best-effort */ }
  }

  /**
   * Move every unread message in an agent's inbox to inbox/.done — the agent has
   * finished with the whole mailbox (an ephemeral worker that signaled done), so
   * nothing left in it is pending any more. Workers rarely file their own work
   * order before signaling done, and a worker id is reused on every re-hire of
   * the same name (`worker-<request name>`), so without this each new incarnation
   * boots into its predecessors' stale orders: it is told to "work everything
   * still pending", spends its first turns re-triaging tasks its memory says are
   * finished, and the inbox-wake watchdog reads the oldest of those as mail that
   * has been unanswered for days.
   *
   * Only mail that was already there when the worker signaled done is finished
   * with: `before` is that signal's timestamp, and a message created after it
   * (a follow-up question from god that crossed the worker's done) is left in
   * place, still pending, for whoever picks the mailbox up next. Without the
   * cut-off such a message was filed as read and nobody ever saw it. Messages
   * whose `created_at` is unreadable fall back to the file's mtime.
   *
   * Returns what happened — how many were filed, how many were kept, and the
   * filed messages that asked for something (`request` / `query`), so the
   * caller can tell their sender that no answer is coming. Best-effort — never
   * throws, so the release path that calls it can't be crashed by a
   * half-written file.
   */
  settleInbox(id: string, before = Number.POSITIVE_INFINITY): SettledInbox {
    const out: SettledInbox = { moved: 0, kept: 0, unanswered: [] };
    const root = this.root();
    if (!root) return out;
    const inbox = join(root, 'agents', id, 'inbox');
    if (!existsSync(inbox)) return out;
    let files: string[];
    try { files = readdirSync(inbox).filter((f) => f.endsWith('.json')); } catch { return out; }
    if (files.length === 0) return out;
    const done = join(inbox, '.done');
    try { mkdirSync(done, { recursive: true }); } catch { return out; }
    for (const f of files) {
      const fp = join(inbox, f);
      let msg: Partial<HiveMessage> = {};
      try { msg = JSON.parse(readFileSync(fp, 'utf8')) as Partial<HiveMessage>; } catch { /* half-written: file it by mtime */ }
      let at = Date.parse(msg.created_at ?? '');
      if (!Number.isFinite(at)) { try { at = statSync(fp).mtimeMs; } catch { at = 0; } }
      if (at > before) { out.kept++; continue; }
      // A rename that fails (EPERM on a file another process holds) leaves the
      // message where it was — still pending, exactly the pre-settle state.
      try { renameSync(fp, join(done, f)); out.moved++; } catch { continue; }
      if (msg.act === 'request' || msg.act === 'query') {
        out.unanswered.push({
          id: msg.id ?? f, act: msg.act, from: msg.from ?? 'unknown', subject: msg.subject ?? '',
          conversation: msg.conversation ?? ''
        });
      }
    }
    if (out.moved > 0) {
      try {
        this.appendLog({ kind: 'inbox-settled', agentId: id, count: out.moved });
        this.commit(`hive: settle inbox of ${id} (${out.moved} unread)`);
      } catch { /* best-effort */ }
    }
    return out;
  }

  /**
   * Change an agent's display name without changing its durable identity.
   * The registry key, agent directory, session id, and every mailbox path remain
   * keyed by `id`; only the human-facing name is updated.
   *
   * `fleet.json` is patched in the same operation so god's next prompt receives
   * the new name immediately rather than waiting for the periodic fleet refresh.
   */
  /**
   * Put an agent on hold, or take it off, and tell Michael immediately.
   *
   * `fleet.json` is patched in the same operation for the same reason
   * `renameAgent` does it: god's roster is injected from that file on its next
   * prompt, and waiting up to 8s for the periodic refresh means one more
   * dispatch can still land on someone the human has just claimed.
   */
  setAgentHold(id: string, hold: boolean): { ok: boolean; onHold?: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      if (!!agent.onHold === hold) return { ok: true, onHold: hold };

      agent.onHold = hold;
      this.writeJson(join(root, 'registry.json'), reg);

      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; onHold?: boolean }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) { row.onHold = hold; this.writeJson(fleetPath, fleet); }
          }
        } catch { /* fleet is a cache — the registry above is the record */ }
      }
      this.appendLog({ kind: 'agent-hold', id, onHold: hold });
      return { ok: true, onHold: hold };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  renameAgent(id: string, name: string): { ok: boolean; name?: string; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };

    const nextName = name.trim();
    if (!nextName) return { ok: false, error: 'Name is required' };

    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      if (agent.name === nextName) return { ok: true, name: nextName };

      const previousName = agent.name;
      agent.name = nextName;
      this.writeJson(join(root, 'registry.json'), reg);

      // fleet.json is ephemeral and may not exist yet. When it does, keep its
      // display name in lockstep with the registry so rosterContext() is fresh.
      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; name?: string }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) {
              row.name = nextName;
              this.writeJson(fleetPath, fleet);
            }
          }
        } catch { /* periodic snapshot will repair a malformed/stale fleet file */ }
      }

      this.appendLog({ kind: 'rename', agentId: id, previousName, name: nextName });
      this.commit(`hive: rename ${id}`);
      return { ok: true, name: nextName };
    } catch {
      return { ok: false, error: 'Could not rename agent' };
    }
  }

  /**
   * Persist the agent's Claude Code session_id (Lane A #6.6a). Captured from hook
   * payloads; written only when it actually changes (a new session), so this is a
   * no-op on the vast majority of hook events. The id is the `--resume` key for
   * idempotent resume after a crash/restart AND the accounting/dedup key for cost
   * samples. Best-effort — never throws into a hook handler.
   */
  recordSession(agentId: string, sessionId: string): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return; // unknown agent or unchanged → no write
      agent.sessionId = sessionId;
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session', agentId, sessionId });
      this.commit(`hive: session ${agentId}`);
    } catch { /* best-effort — never crash a hook handler */ }
  }

  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /**
   * Every session this agent has had, newest first (the recorded one, then the
   * log's earlier ones). A CLI writes a session's transcript only after its
   * first message, so the newest id can be an empty session (a restart that
   * started fresh and was closed again): resuming tries these in order and
   * takes the newest that has a transcript, instead of starting fresh and
   * recording yet another empty one, which lost the real conversation.
   */
  recentSessions(agentId: string, max = 10): string[] {
    const out: string[] = [];
    const add = (id: unknown) => { if (typeof id === 'string' && id && !out.includes(id)) out.push(id); };
    add(this.lastSession(agentId));
    const log = this.logTail(5_000) as Array<{ kind?: string; agentId?: string; sessionId?: string }>;
    for (let i = log.length - 1; i >= 0 && out.length < max; i--) {
      const e = log[i];
      if (e?.kind === 'session' && e.agentId === agentId) add(e.sessionId);
    }
    return out;
  }

  /** Claude Code settings that route every relevant hook through the shim.
   *  Claude-only — this is invoked solely on the Claude spawn path. (The MCP
   *  bundle is NOT here: see the --mcp-config note in ensureAgent.) */
  /**
   * Directories a sandboxed agent may write BESIDES its cwd: its own agent
   * folder (hive housekeeping) and the hive root (research deliverables; the
   * board and tasks.json for god; outbox delivery is done by main, not the agent).
   * This is what lets auto mode keep the OS sandbox on — the old full-bypass
   * posture existed only because these paths sit outside the project cwd.
   */
  private sandboxWritableDirs(meta: AgentMeta, dir: string, root: string, extra?: string[]): string[] {
    const out = [dir, root, ...(extra ?? [])].filter((d) => typeof d === 'string' && d.length > 0);
    return Array.from(new Set(out));
  }

  /** Office skills (shared/skillRequests.ts): <hive>/skills/office.json, the
   *  installed copies in <hive>/skills/store/<dir>. */
  officeSkills(): OfficeSkills {
    const root = this.root();
    if (!root) return { skills: {} };
    try { return readOfficeSkills(JSON.parse(readFileSync(join(root, 'skills', 'office.json'), 'utf8'))); } catch { return { skills: {} }; }
  }

  writeOfficeSkills(s: OfficeSkills): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'office.json'), JSON.stringify(s, null, 2), 'utf8');
  }

  /** Where office skills are installed once, before being copied to agents. */
  officeSkillStore(): string | null {
    const root = this.root();
    return root ? join(root, 'skills', 'store') : null;
  }

  /** The catalog the orchestrator searches (md-skills), and what it may add. */
  writeSkillCatalogMirror(skills: Array<{ name: string; description: string; category: string; owner: string; marketplace?: string }>, policy: SkillPolicy): void {
    const root = this.root();
    if (!root) return;
    try {
      mkdirSync(join(root, 'skills'), { recursive: true });
      writeFileSync(join(root, 'skills', 'catalog.json'), JSON.stringify({
        note: 'Mirror of the skills catalog for md-skills. Read-only.',
        policy,
        skills: skills.map((s) => ({ name: s.name, description: s.description, category: s.category, owner: s.owner, ...(s.marketplace ? { marketplace: true } : {}) }))
      }), 'utf8');
    } catch { /* best-effort */ }
  }

  /** Make an agent's .claude/skills match the office skills it should have:
   *  copy the missing ones from the store, remove the ones taken away. Only
   *  folders this marks as office skills are ever removed. */
  syncOfficeSkills(agentId: string): void {
    const store = this.officeSkillStore();
    if (!store) return;
    const dest = join(this.agentDir(agentId), '.claude', 'skills');
    const MARK = '.office-skill';
    const want = new Map(Object.values(this.officeSkills().skills).filter((s) => skillReaches(s, agentId)).map((s) => [s.dir, s]));
    try {
      if (existsSync(dest)) {
        for (const d of readdirSync(dest)) {
          if (!want.has(d) && existsSync(join(dest, d, MARK))) rmSync(join(dest, d), { recursive: true, force: true });
        }
      }
      for (const dir of want.keys()) {
        const from = join(store, dir);
        const to = join(dest, dir);
        if (!existsSync(from) || existsSync(join(to, MARK))) continue;
        this.copyBundledSkills(from, to);
        writeFileSync(join(to, MARK), 'Given by the orchestrator (office skills). Removed when it is taken away.\n', 'utf8');
      }
    } catch (e) { console.error('[hive] syncOfficeSkills failed:', e); }
  }

  /** The PreToolUse guard for an agent spawned in this run (undefined: none yet). */
  guardFor(agentId: string): GuardPolicy | undefined {
    return this.guardPolicies.get(agentId);
  }

  /** Git and "outside its folders" changed in Capabilities: the running
   *  agents get it on their next tool call, no restart (the folders stay). */
  refreshGuards(cfg: { mcpDefaults?: { [id: string]: { enabled: boolean } }; agentMcpGrants?: Record<string, string[]>; agentRoam?: string[] }): void {
    for (const [id, g] of this.guardPolicies) {
      this.guardPolicies.set(id, { ...g, git: gitAllowed(cfg.mcpDefaults, cfg.agentMcpGrants?.[id]), contained: !(cfg.agentRoam ?? []).includes(id) });
    }
  }

  /** Whether Claude Code's OS sandbox can run where this office's agents run:
   *  on Linux (a Linux machine, or a WSL floor's distro) it needs bubblewrap.
   *  Looked up once per run (per distro); false when it cannot be checked. */
  private sandboxCheck = new Map<string, Promise<boolean>>();
  sandboxAvailable(): Promise<boolean> {
    const w = this.wslRoot();
    const key = w ? `wsl:${w.distro}` : process.platform;
    if (!w && process.platform !== 'linux') return Promise.resolve(false);
    let p = this.sandboxCheck.get(key);
    if (!p) {
      p = (w
        ? runInDistroAsync(w.distro, 'sh', ['-c', 'command -v bwrap || true'])
        : new Promise<string>((resolve) => execFile('sh', ['-c', 'command -v bwrap || true'], { encoding: 'utf8', timeout: 10_000 }, (_e, out) => resolve(String(out ?? ''))))
      ).then((out) => /bwrap/.test(out), () => false);
      this.sandboxCheck.set(key, p);
    }
    return p;
  }

  private hookSettings(shim: string, theme?: 'light' | 'dark', writableDirs: string[] = [], requireSandbox = false, brokerUrl?: string, denyDirs: string[] = [], onlyBroker = false): unknown {
    // The sandbox gives Bash its own network: the app's loopback broker is
    // reachable only through the sandbox proxy, and only where allowed. The
    // hive's commands (md-api, md-run, md-browse) go through that proxy
    // (brokerClient.ts); this opens exactly the broker's host:port, not
    // localhost at large. Without it a bypass-mode agent still gets through
    // (unlisted hosts are allowed there) but any other mode is refused.
    const broker = (() => { try { return brokerUrl ? new URL(brokerUrl).host : ''; } catch { return ''; } })();
    // Bundled node, NOT bare `node` — see nodeLauncherPath(). Claude runs each of
    // these through `sh -c` with a stripped PATH, where `node` is often absent.
    const cmd = this.claudeHookCommand(shim);
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    return {
      // Match the TUI's truecolor palette to the harness terminal theme —
      // PER SESSION, so the user's global Claude theme (their own terminals
      // outside the app) is never touched.
      //
      // 'auto', not the literal light/dark. Pinning the value matched the theme at
      // SPAWN and then ignored every change: Claude Code supports DEC 2031 theme
      // notifications, but a pinned theme has nothing to reconsider, so flipping
      // the app left a running agent painting its message blocks in the old
      // palette (black highlight on a cream terminal). 'auto' is the value that
      // listens. The terminal reports the current theme the moment the CLI enables
      // 2031, so startup still matches without pinning anything.
      ...(theme ? { theme: 'auto' } : {}),
      // The status line gets the session status JSON after every response —
      // including context_window.{total_input_tokens,context_window_size},
      // the only clean programmatic source for the session's REAL context
      // window. The shim prints a compact in-terminal gauge and forwards the
      // payload to the harness (agent-card context gauge, exact limit).
      statusLine: { type: 'command', command: `${cmd} --status`, padding: 0 },
      // Native OS sandbox for Bash subprocesses (macOS Seatbelt / Linux bubblewrap).
      // Auto mode spawns with `--permission-mode bypassPermissions`, which only
      // silences PROMPTS; the sandbox is a separate, opt-in layer that was never
      // switched on. Verified live (claude 2.1.239): with this block, bypass mode
      // still writes cwd and the listed dirs but `touch $HOME/x` fails with
      // "Operation not permitted". Two layers are needed: `sandbox.filesystem`
      // governs Bash children, `permissions.additionalDirectories` governs the
      // Edit/Write tools; with only one the agent deadlocks on its own inbox.
      // failIfUnavailable stays false: a platform without a sandbox (Windows)
      // runs as before rather than refusing to spawn.
      ...(writableDirs.length
        ? {
            // Where the sandbox CAN run (bubblewrap found on Linux / in a WSL
            // floor's distro), it must: if it ever fails to start, the agent's
            // shell refuses to run rather than running unconfined.
            // Other agents' confidential vaults: hidden from the shell
            // (denyRead), and refused to the file tools by permission rules
            // (which bypass mode still honours; Read and Edit rules cover every
            // file tool) as well as by the path guard.
            // A custodian's shell reaches the broker and no other host
            // (strictAllowlist: nothing is asked, anything unlisted is refused).
            sandbox: {
              enabled: true,
              ...(requireSandbox ? { failIfUnavailable: true } : {}),
              filesystem: { allowWrite: writableDirs, ...(denyDirs.length ? { denyRead: denyDirs } : {}) },
              ...(onlyBroker
                ? { network: { allowedDomains: broker ? [broker] : [], strictAllowlist: true } }
                : broker ? { network: { allowedDomains: [broker] } } : {})
            },
            permissions: {
              additionalDirectories: writableDirs,
              ...(denyDirs.length ? { deny: denyDirs.flatMap((d) => ['Read', 'Edit'].map((t) => `${t}(/${d.replace(/\\/g, '/')}/**)`)) } : {})
            }
          }
        : {}),
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        PreToolUse: [entry('*')],
        PostToolUse: [entry('*')],
        // A failed tool call (a WebFetch refused with 403…): the hook server
        // answers it with the office browser (hooks.ts, browsePage.ts).
        PostToolUseFailure: [entry('WebFetch')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()],
        // #5C: surface mid-`/compact` so an agent boxing up its context reads as
        // 'compacting' on the floor instead of looking frozen.
        PreCompact: [entry()],
        PostCompact: [entry()]
      }
    };
  }

  /**
   * W3 — build the per-agent `mcpServers` map from the default catalog. Includes a
   * server only when it's enabled (catalog ∩ consent), scopes filesystem/git to the
   * agent cwd (never whole-disk), and namespaces every id `munder-<id>` so a server
   * of the same name in the user's own ~/.claude is never clobbered. A write/secret
   * server is included ONLY on an explicit `enabled:true` consent — never via a
   * default — so a malformed/partial config can't silently arm a keyed server.
   *
   * A per-agent `grant` (Pro Capabilities) replaces the default membership: the
   * agent gets exactly the granted servers. It never replaces consent, so a
   * granted write/secret server the user has not switched on is still left out.
   */
  buildDefaultMcpServers(
    cwd: string,
    cfg: McpDefaultsMap,
    grant?: string[],
    agentId?: string,
    scopes?: Record<string, string[]>,
    toolBlocks?: string[],
    /** Only list what the agent would get: no gateway capability is granted. */
    dryRun = false
  ): { servers: Record<string, McpServerEntry>; env: Record<string, string> } {
    const servers: Record<string, McpServerEntry> = {};
    const env: Record<string, string> = {};
    const keyed: string[] = this.keyedConnectionsFor(cfg, grant, agentId, scopes, toolBlocks);
    const granted = grant ? new Set(cleanServerList(grant)) : null;
    // Web taken away (Capabilities): no web-reading servers either.
    const noWeb = blockedMcpServers(toolBlocks);
    // The custodian of a critical connection gets that connection and nothing
    // else that could carry its data out: no built-in servers, no web, no
    // memory, lists or browser, none of your own (criticalConnections.ts).
    const custodian = isCustodian(this.criticalMap(), agentId);
    for (const e of MCP_CATALOG) {
      if (custodian) break;
      if (noWeb.has(e.id)) continue;
      // Keyed servers never run under the agent (see keyedConnectionsFor):
      // they go through main's MCP gateway below.
      if ((e.secrets ?? []).length > 0) continue;
      const consented = cfg?.[e.id]?.enabled;
      const enabled = granted ? granted.has(e.id) : (consented ?? e.defaultEnabled);
      if (!enabled) continue;
      // Defense-in-depth: a write/secret server requires an EXPLICIT opt-in; it can
      // never ride in on a default (the catalog already ships these OFF, but this
      // guards a hand-edited/partial mcpDefaults map too).
      if (e.tier !== 'safe-readonly' && consented !== true) continue;
      // "Choose agents" (Connections): a scoped server reaches only its list.
      const scope = scopes?.[e.id];
      if (Array.isArray(scope) && !(agentId && scope.includes(agentId))) continue;
      // Replace the `<cwd>` placeholder (filesystem/git) with the agent cwd at merge
      // time so these stay strictly workspace-scoped.
      // The git server needs a repository: pointed at a folder outside one (an
      // office that is not a repo) it exits at once and the agent reports
      // "munder-git … Connection closed" at every start. Give it the repo
      // the cwd is in, or leave it out.
      let repoCwd = cwd;
      if (e.id === 'git') {
        const repo = enclosingGitRepo(cwd);
        if (!repo) continue;
        repoCwd = repo;
      }
      // An MCP server runs outside the agent's OS sandbox: one rooted at a
      // folder that holds the confidential vaults (the orchestrator's cwd is
      // the office home) could read them, so it is left out.
      const home = this.getHome();
      if (e.spec.args.includes('<cwd>') && home && Object.keys(this.criticalMap()).length && within(join(home, VAULT_ROOT), repoCwd)) continue;
      const args = e.spec.args.map((a) => (a === '<cwd>' ? repoCwd : a));
      servers[`munder-${e.id}`] = { command: e.spec.command, args };
    }
    // Your own servers (Manager → MCP, mcpServers.ts): keyed ones go through
    // the gateway like the catalog's, the rest are handed over as they are.
    // Role grants name catalog servers; these carry their own agent scope.
    // A critical one of these reaches its custodian only, and the custodian
    // gets no other.
    if (agentId) {
      const mine = this.customMcp(agentId);
      const held = new Set(heldIds(this.criticalMap(), agentId, 'mcp'));
      keyed.push(...mine.gateway.filter((id) => (custodian ? held.has(id) : criticalAllows(this.criticalMap(), 'mcp', id, agentId))));
      if (!custodian) {
        for (const [id, entry] of Object.entries(mine.plain)) if (criticalAllows(this.criticalMap(), 'mcp', id, agentId)) servers[`munder-${id}`] = entry;
      }
    }
    // The office memory, for every agent while semantic memory is on.
    const mem = agentId && !custodian ? this.memoryMcp() : null;
    if (mem) servers['munder-memory'] = mem;
    // The human's lists (Memory → Lists), as tools: told only in the prompt,
    // agents kept those things in their own memory instead.
    const root = this.root();
    if (agentId && root && !custodian) servers['munder-lists'] = { command: this.nodeCommand(), args: [join(root, 'bin', 'md-lists.cjs'), join(root, 'lists')] };
    // The office browser, unless Web is switched off for this agent (the broker
    // refuses it then as well).
    if (agentId && root && !custodian && !cleanToolBlocks(toolBlocks).includes('web')) servers['munder-browser'] = { command: this.nodeCommand(), args: [join(root, 'bin', 'md-browse.cjs')] };
    // No gateway (tests, or it failed to bind) → no keyed servers at all: the
    // fallback is "without GitHub", never "with the key in the agent's env".
    const gw = keyed.length && agentId ? (dryRun ? { url: 'http://127.0.0.1:0', token: '' } : this.mcpGateway(agentId, keyed, this.mcpAccessMap(agentId, keyed))) : null;
    if (gw) {
      for (const id of keyed) {
        // `${MD_MCP_TOKEN}` is expanded by Claude Code from the process env, so
        // not even the capability token is written into the (committed) hive.
        servers[`munder-${id}`] = { type: 'http', url: `${gw.url}/mcp/${id}`, headers: { Authorization: 'Bearer ${MD_MCP_TOKEN}' } };
      }
      env.MD_MCP_TOKEN = gw.token;
    }
    return { servers, env };
  }

  /** What this agent is given, by MCP server name and where it came from — the
   *  managed list, as the app (not the agent) decides it. Grants nothing. */
  managedMcpFor(agentId: string, cwd: string, cfg: McpDefaultsMap, grant?: string[], scopes?: Record<string, string[]>, toolBlocks?: string[]): Array<{ name: string; id: string; origin: 'connection' | 'builtin' | 'yours' | 'office'; access?: Access }> {
    const { servers } = this.buildDefaultMcpServers(cwd, cfg, grant, agentId, scopes, toolBlocks, true);
    const keyed = new Set(this.keyedConnectionsFor(cfg, grant, agentId, scopes, toolBlocks));
    return Object.keys(servers).map((name) => {
      const id = name.replace(/^munder-/, '');
      if (keyed.has(id)) return { name, id, origin: 'connection' as const, access: this.mcpAccess(agentId, id) };
      if (id.startsWith('custom--')) return { name, id, origin: 'yours' as const };
      if (id === 'memory' || id === 'lists' || id === 'browser') return { name, id, origin: 'office' as const };
      return { name, id, origin: 'builtin' as const };
    });
  }

  /**
   * The keyed connections (ids) one agent gets. Keyed servers never run under
   * the agent: their key would be in its environment. They go through main's
   * MCP gateway (mcpGateway.ts), which holds the key; the agent only gets a
   * capability token. A service can have several connections (two GitHub
   * accounts…): a Capabilities grant names the service, and each connection is
   * then switched on, scoped to agents and keyed on its own. A connection
   * missing a required key is left out: it could only fail. The prompt's
   * CONNECTIONS line uses this same list, so what an agent is told matches
   * what it can call.
   */
  keyedConnectionsFor(
    cfg: McpDefaultsMap,
    grant?: string[],
    agentId?: string,
    scopes?: Record<string, string[]>,
    toolBlocks?: string[]
  ): string[] {
    const keyed: string[] = [];
    const granted = grant ? new Set(cleanServerList(grant)) : null;
    const noWeb = blockedMcpServers(toolBlocks);
    const critical = this.criticalMap();
    // A custodian gets only the critical connections it holds.
    const held = isCustodian(critical, agentId) ? new Set(heldIds(critical, agentId, 'mcp')) : null;
    for (const e of MCP_CATALOG) {
      if (noWeb.has(e.id) || (e.secrets ?? []).length === 0) continue;
      if (granted && !granted.has(e.id)) continue;
      for (const inst of this.mcpInstances(e.id)) {
        if (cfg?.[inst]?.enabled !== true) continue;
        // Critical: its custodian only (the gateway refuses anyone else too).
        if (!criticalAllows(critical, 'mcp', inst, agentId)) continue;
        if (held && !held.has(inst)) continue;
        const scope = scopes?.[inst];
        if (Array.isArray(scope) && !(agentId && scope.includes(agentId))) continue;
        // The agent's role (and the connection's own ceiling) can rule it out.
        if (agentId && this.mcpAccess(agentId, inst) === 'none') continue;
        if ((e.secrets ?? []).every((f) => f.optional || this.mcpKeyStored(inst, f.env))) keyed.push(inst);
      }
    }
    return keyed;
  }

  /** What happens to a message an agent sends before it is routed: a
   *  custodian's is redacted (criticalConnections.ts). Injected by main; unset
   *  means as is. `note` set = changed. */
  private outgoing: (msg: HiveMessage) => { msg: HiveMessage; note?: string; hold?: boolean } = (msg) => ({ msg });
  setOutgoing(filter: (msg: HiveMessage) => { msg: HiveMessage; note?: string; hold?: boolean }): void {
    this.outgoing = filter;
  }

  /** A custodian's hive folder (memory, notes, its mail) never enters the
   *  hive's git history, which every agent can read: its own .gitignore
   *  ignores everything, and anything already tracked is untracked. */
  private keepOutOfHistory(id: string, dir: string): void {
    try {
      const gi = join(dir, '.gitignore');
      const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
      if (!cur.split(/\r?\n/).includes('*')) writeFileSync(gi, `*\n${cur}`, 'utf8');
      const root = this.root();
      if (root && existsSync(join(root, '.git'))) this.git(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', `agents/${id}`], root);
    } catch (e) { console.error('[hive] keepOutOfHistory', id, e); }
  }

  /** An agent's own hive folder (for a custodian, its working folder too). */
  agentFolder(id: string): string {
    return this.agentDir(id);
  }

  /** Critical connections and their custodians (criticalConnections.ts).
   *  Injected by main; unset means none. */
  private criticalMap: () => CriticalMap = () => ({});
  setCritical(get: () => CriticalMap): void {
    this.criticalMap = get;
  }

  /** What one agent may do with one connection (connectionAccess.ts). Injected
   *  by main; unset means unrestricted (tests, and a hive without Connections). */
  private mcpAccess: (agentId: string, connectionId: string) => Access = () => 'readwrite';
  setMcpAccess(get: (agentId: string, connectionId: string) => Access): void {
    this.mcpAccess = get;
  }

  /** The access level for each of an agent's keyed connections (for the gateway). */
  mcpAccessMap(agentId: string, ids: string[]): Record<string, Access> {
    return Object.fromEntries(ids.map((id) => [id, this.mcpAccess(agentId, id)]));
  }

  /** Whether a Connections key is stored (never its value: the hive does not
   *  need it). Injected by main; unset means "none stored". */
  private mcpKeyStored: (serverId: string, envName: string) => boolean = () => false;
  setMcpKeyCheck(check: (serverId: string, envName: string) => boolean): void {
    this.mcpKeyStored = check;
  }

  /** Every connection id of a keyed service (its own id first). Injected by
   *  main from Connections; unset means one connection per service. */
  private mcpInstances: (serviceId: string) => string[] = (serviceId) => [serviceId];
  setMcpInstances(list: (serviceId: string) => string[]): void {
    this.mcpInstances = list;
  }

  /** Your own MCP servers for one agent (mcpServers.ts). Injected by main;
   *  unset means none. */
  /** The office memory as an MCP server (memory.ts mcpServer). Injected by
   *  main; unset or null means memory is off. */
  private memoryMcp: () => McpServerEntry | null = () => null;
  setMemoryMcp(get: () => McpServerEntry | null): void {
    this.memoryMcp = get;
  }

  private customMcp: (agentId: string) => { gateway: string[]; plain: Record<string, McpServerEntry> } = () => ({ gateway: [], plain: {} });
  setCustomMcp(get: (agentId: string) => { gateway: string[]; plain: Record<string, McpServerEntry> }): void {
    this.customMcp = get;
  }

  /** Grants an agent a gateway capability over its keyed servers. Injected by
   *  main; unset means no gateway. */
  private mcpGateway: (agentId: string, serverIds: string[], access?: Record<string, Access>) => { url: string; token: string } | null = () => null;
  setMcpGateway(grant: (agentId: string, serverIds: string[], access?: Record<string, Access>) => { url: string; token: string } | null): void {
    this.mcpGateway = grant;
  }

  /**
   * W3 — refresh an agent's bundled skills from the app-resources `skills/` dir.
   * Mirrors `identity.md`: overwritten every spawn so the shipped safe set tracks
   * the app. Best-effort and fully tolerant — a missing/empty source dir is a no-op
   * (Kevin populates the resource dir in lp-manifest), and any IO error is swallowed
   * so skill provisioning can never block a spawn.
   */
  private copyBundledSkills(srcDir: string, destDir: string): void {
    try {
      if (!existsSync(srcDir)) return;
      const scripts = copySkillTreeSync(srcDir, destDir);
      // On a WSL floor the copy through \\wsl.localhost lands 0644: mark the
      // scripts executable inside the distro (a no-op anywhere else).
      void restoreExecBits(destDir, scripts).catch((e) => console.error('[hive] could not mark skill scripts executable:', e));
    } catch (e) { console.error('[hive] copyBundledSkills failed:', e); }
  }

  /**
   * W1 — start a proxy-bridge sidecar for a hookless proxy-tier agent (qwen).
   * Spawns `<root>/bin/hive-proxy.cjs` under Node, which binds a loopback port and
   * reports it back as a one-line `{"port":N}` on stdout. Resolves the bound port
   * (or 0 on failure, so the caller degrades gracefully without redirecting the
   * CLI). Idempotent: any prior sidecar for the agent is killed first, so a respawn
   * never leaks a listener. Tracked in `proxyChildren` for teardown.
   */
  /** startProxyBridge with a short retry ladder. Every attempt kills the previous
   *  sidecar first (startProxyBridge is idempotent), so a retry never leaks a
   *  listener. Resolves the bound port, or 0 once every attempt has failed. */
  private async startProxyBridgeWithRetry(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string; caFile?: string; insecure?: boolean }
  ): Promise<number> {
    for (let attempt = 1; attempt <= PROXY_BIND_ATTEMPTS; attempt++) {
      const port = await this.startProxyBridge(agentId, cfg);
      if (port > 0) return port;
      if (attempt < PROXY_BIND_ATTEMPTS) {
        console.warn(`[hive] proxy bridge for ${agentId} did not bind (attempt ${attempt}/${PROXY_BIND_ATTEMPTS}), retrying`);
        await new Promise((r) => setTimeout(r, PROXY_BIND_BACKOFF_MS[attempt - 1] ?? 1000));
      }
    }
    return 0;
  }

  private startProxyBridge(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string; caFile?: string; insecure?: boolean }
  ): Promise<number> {
    this.stopProxyBridge(agentId);
    const script = this.proxyShimPath();
    if (!script) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      let settled = false;
      const settle = (port: number): void => { if (!settled) { settled = true; resolve(port); } };
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            // Run the .cjs under Electron's bundled Node, not as a second app window.
            ELECTRON_RUN_AS_NODE: '1',
            HIVE_SOCK: cfg.sock,
            AGENT_ID: agentId,
            UPSTREAM_BASE_URL: cfg.upstream,
            ...(cfg.caFile ? { UPSTREAM_CA_FILE: cfg.caFile } : {}),
            ...(cfg.insecure ? { UPSTREAM_INSECURE: '1' } : {}),
            HIVE_PROXY_SESSION: cfg.sessionId,
            HIVE_PROXY_API: cfg.api
          },
          // Read the port line from stdout; never inherit stdio (the sidecar must
          // never write into the agent's terminal or leak request bodies to a log).
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch (e) {
        console.error(`[hive] startProxyBridge spawn failed for ${agentId}:`, e);
        return settle(0);
      }
      this.proxyChildren.set(agentId, child);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (settled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (typeof msg.port === 'number' && msg.port > 0) settle(msg.port);
          else settle(0);
        } catch { settle(0); }
      });
      child.on('error', () => settle(0));
      child.on('exit', () => {
        if (this.proxyChildren.get(agentId) === child) this.proxyChildren.delete(agentId);
        settle(0); // never hang the spawn if the sidecar dies before reporting
      });
      // Hard ceiling: if the sidecar never reports a port, degrade rather than hang.
      setTimeout(() => settle(0), 4000).unref?.();
    });
  }

  /** Kill the proxy sidecar for an agent, if any. Idempotent; never throws. */
  stopProxyBridge(agentId: string): void {
    const child = this.proxyChildren.get(agentId);
    if (!child) return;
    this.proxyChildren.delete(agentId);
    try { child.kill(); } catch { /* already gone */ }
  }

  /** Kill every live proxy sidecar (app quit). Best-effort. */
  stopAllProxyBridges(): void {
    for (const id of [...this.proxyChildren.keys()]) this.stopProxyBridge(id);
  }

  /**
   * Drain an agent's inbox for the Stop hook. Returns whether to block-to-continue
   * and the message text to feed back. Uses the per-agent cursor so a message is
   * surfaced exactly once (no infinite loop).
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.atomicWriteJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join('\n');
    const reason = [
      `You have ${fresh.length} new hive message(s) in your inbox. Address them before finishing:`,
      lines,
      // Native separators (join, not string-concatenated `/`) so a Windows agent is
      // handed a path its own shell/tools accept, not `C:\…\agents\god/inbox/`.
      `Open the files in ${join(dir, 'inbox')} for full detail, act on each, then move handled ones to ${join(dir, 'inbox', '.done')}. Reply via your outbox if a message requires it.`
    ].join('\n');
    return { block: true, reason: this.forAgent(reason) };
  }

  // — agent-facing text —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (god)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- You are the **god / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.' : '',
      meta.isGod ? '- Monitor the team with `fleet.json` (live per-agent status/tokens/cost/breaker) and `registry.json`; full command reference in `COMMANDS.md`. `claude agents` does NOT list your hive siblings.' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  /**
   * The system-prompt prefix injected into every spawn via --append-system-prompt.
   *
   * 🔒 PROMPT-CACHE INVARIANT — keep this prefix VOLATILE-FREE. It interpolates
   * only values stable for an agent's whole lifetime (name, id, dir, root,
   * semanticMemory). Do NOT add dates, UUIDs, counters, board/registry state, or
   * any `Date.now()`-derived text here: a prefix that changes per spawn defeats
   * Anthropic's prompt cache (re-priming the whole system prompt every turn).
   * Volatile context belongs on the live channels — the inbox (hive messages) and
   * the PTY — never baked into this prefix. (Lane A #6.1.)
   *
   * 🪟 NO SHELL SYNTAX. Every path and command here is written the way the AGENT
   * will actually type it, on the platform it is running on. That rules out two
   * habits that were silently Windows-only breakage:
   *  - `$VAR` — POSIX-only. Under cmd.exe `$HIVE_NODE`/`$KG_CLI` expand to nothing
   *    and under PowerShell to an undefined variable, so those instructions were
   *    dead on every Windows floor. Bake the ABSOLUTE resolved path instead: it is
   *    platform-independent, needs no expansion, and stays prompt-cache-stable.
   *  - `'…' + '/inbox/'` — string-concatenating separators told a Windows agent to
   *    read `C:\Users\x\hive\agents\god/inbox/`. Use join() so the agent's own
   *    tooling gets a path it can pass straight to its shell.
   */
  /** The kind of project an agent works in (shared/memorySections.ts), from
   *  what is in its folder, or the repository the folder is in. Cached. */
  private projectTypes = new Map<string, ProjectType>();
  projectTypeOf(cwd: string | undefined): ProjectType {
    if (!cwd) return 'research';
    const hit = this.projectTypes.get(cwd);
    if (hit) return hit;
    const root = enclosingGitRepo(cwd) ?? cwd;
    let names: string[] = [];
    try { names = readdirSync(root); } catch { /* unreadable: research */ }
    const t = detectProjectType(names);
    this.projectTypes.set(cwd, t);
    return t;
  }

  private injectedPrompt(
    meta: AgentMeta,
    dir: string,
    root: string,
    semanticMemory: boolean,
    knowledgeGraph: boolean,
    kgCliPath?: string,
    integrations?: Array<{ id: string; label: string }>,
    runners?: Array<{ id: string; name: string; description?: string; secrets: string[] }>,
    connections?: PromptConnection[],
    envNames?: string[],
    webOff = false,
    critical?: string[],
    vaults?: string[],
    outgoing?: string
  ): string {
    // Native-separator path helpers — see the 🪟 note above.
    const inDir = (...parts: string[]): string => join(dir, ...parts);
    const inRoot = (...parts: string[]): string => join(root, ...parts);
    // Resolved ONCE here, at THIS agent's own spawn — same prompt-cache-stable
    // shape as name/id/dir/root above it, not a live re-read on every turn.
    // Needed only for the PREP ASSISTANT persona below, which refers to god by
    // name in prose; god's own prompt already gets its name via `meta.name`.
    const godRegistry = meta.isAssistant ? this.registry() : null;
    const godNameForPrompt = godRegistry
      ? resolveGodName(godRegistry.agents[godRegistry.godId ?? 'god']?.name)
      : '';
    const ctxLine = 'LIVE CONTEXT: each agent row in the LIVE ROSTER carries a `ctx NN%` tag — its live context-window occupancy. Treat it as the real headroom signal when routing: prefer an agent with a LOW `ctx` for a big task; treat a HIGH `ctx` (near 100%) as busy rather than idle, even if the cumulative token count looks modest.';

    // Only Claude Code gets the office's MCP servers (--mcp-config in
    // ensureAgent). Told about munder-* tools it did not have, another CLI went
    // looking for them.
    const hasOfficeMcp = isClaudeProvider(meta.provider ?? 'claude');
    const memoryLine = semanticMemory && !hasOfficeMcp
      ? 'Semantic memory: the whole hive shares a searchable MemPalace at the path in your MEMPALACE_PALACE_PATH environment variable. To recall what the office already knows, run `mempalace search "<query>"` FIRST (search by meaning over every agent’s notes and the research/ deliverables) before reading files or redoing work; `mempalace wake-up` gives a digest at the start of a task. Your notes in memory.md are mined into the palace automatically — write durable facts there.'
      : semanticMemory
      // The palace location is named, not spelled as `$MEMPALACE_PALACE_PATH`:
      // `mempalace` reads that env var itself, and the POSIX `$` form was noise
      // (or an empty expansion) for a Windows agent that tried to use it literally.
      ? 'Semantic memory: the whole hive shares a searchable MemPalace at the path in your MEMPALACE_PALACE_PATH environment variable. To recall what the office already knows, search it FIRST with the munder-memory MCP tools (search by meaning over every agent’s notes and the research/ deliverables) before reading files or redoing work; `mempalace search "<query>"` in the shell does the same, and `mempalace wake-up` gives a digest at the start of a task. Your notes in memory.md are mined into the palace automatically — write durable facts there.'
      : '';
    // Enterprise Knowledge Graph (opt-in). Volatile-free: the bundled-node launcher
    // and the KG CLI are both fixed absolute paths for an install, so baking them
    // keeps the prefix prompt-cache-stable while making the command runnable in
    // cmd.exe/PowerShell as well as a POSIX shell.
    const hiveNode = this.nodeCommand();
    const kgCli = kgCliPath || (this.winAgents() ? '%KG_CLI%' : '$KG_CLI');
    const knowledgeLine = knowledgeGraph
      ? `Enterprise knowledge: this organisation has a private Knowledge Graph of its own documents, policies, and business context. When a task needs that context — company-specific facts, house style, internal processes — query it instead of guessing: run \`"${hiveNode}" "${kgCli}" search "<query>"\` for ranked passages, \`"${hiveNode}" "${kgCli}" list\` to see what is available, and \`"${hiveNode}" "${kgCli}" get <id>\` for a full document. (That first path is the harness's bundled Node — use it instead of bare \`node\`, which may not be on your PATH.)`
      : '';
    // Item 13: state the build. Agents had no way to tell which version, or even
    // which KIND of build, they were running inside, so anything that varies
    // between a packaged app and a local dev run (umask being the one that bit
    // us) was invisible to every investigation.
    const rt = this.runtimeInfo();
    const runtimeLine = rt
      ? `RUNNING BUILD: Scranton Branch v${rt.version}, ${rt.packaged ? 'packaged app' : 'local dev build'}${rt.appPath ? `, from ${rt.appPath}` : ''}. Say this version if asked which one is running, and do not assume behaviour from an older one. A local dev build inherits the launching shell's environment (umask included) where a packaged app does not, so file modes and inherited env can legitimately differ between the two. \`log.jsonl\` records an \`app-start\` event on every launch, which is how you spot a restart or a build switch.`
      : '';
    // Item 11: god could not find the spawn queue. The mechanism has worked since
    // v0.4.4, but nothing told him it existed — the prompt said "spawn" without
    // saying how, COMMANDS.md and PROTOCOL.md did not mention it, and the only
    // description lived in a source comment. So he fell back to writing a hire
    // manifest, which needs a human to click confirm, and it looked like nothing
    // happened. Gated on the toggle: advertising a disabled path is worse than
    // saying nothing, and COMMANDS.md documents it either way for the case where
    // the operator turns it on after god was already running.
    const spawnQueueLine = meta.isGod && this.orchestratorMaySpawn()
      ? `SPAWNING A WORKER: you can start an ephemeral worker yourself by writing ONE JSON file into ${inRoot('spawn-requests')}/<id>.json. Required: \`objective\` (what the worker must do) and \`cwd\` (the repo it runs in). Optional: \`name\`, \`command\` (overrides the provider default; it must be an agent CLI — claude, codex, agy… — with no --settings/--mcp-config/--add-dir/-c/--config/--provider/--base-url flags, and \`cwd\` must be a registered repo, this office or an agent's folder, or the request is refused), \`provider\` (selects its default CLI when command is omitted), \`model\`, \`isolate\` (default true = its own git worktree), \`tokenCap\`, and \`slack\` ({channel, thread_ts}) to route its failures back to a thread. The harness polls that directory, spawns \`worker-<id>\`, and moves the request to \`spawn-requests/.done/\` on success or \`.failed/\` with a reason. This is the ONLY way you can spawn; a hire manifest under research/hires/ needs the human to confirm it in the UI, so it is not a route you can complete on your own. Reuse an existing agent first, as above — a worker is a fresh spend every time. A worker is archived when it sends its done; to let go of one you started that is no longer needed, write ${inRoot('archive-requests')}/<any-name>.json with {"id":"worker-<id>"} (only your own temps; the outcome comes back to your inbox).`
      : '';
    const godLine = meta.isGod
      ? 'You are the GOD / ORCHESTRATOR of this hive — your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS — always know what is going on: keep an accurate picture of every agent (active vs archived/idle), the task board, and all in-flight work; drain your inbox continually and triage every other agent\'s requests, answering clarifications so the team runs autonomously. (2) DELEGATE — decompose work and fan it out to the hive agents via their inboxes (route messages and assign owners; do not do their jobs); your own sub-agent tool is switched off — a helper started inside your session is invisible to the office, so "put an agent on it" always means an agent on the floor (an existing one, or a worker through spawn-requests); do NOT take on grunt implementation yourself. Stay aware of who is already on the floor and delegate OPPORTUNISTICALLY: BEFORE you spawn anything, CHECK THE LIVE ROSTER (active agents in registry.json + their state in fleet.json) and prefer routing to an EXISTING agent that fits — above all when the request names one ("ask Pam to…", "have Jim…"), route to that agent instead of reflexively creating a new one. Reuse an idle or already-running agent whose role matches; only spawn a fresh agent when no existing one is a sensible fit, and say that you checked. One capable owner beats a duplicate. (3) OWN ONLY THE IMPORTANT, high-leverage things — task decomposition, dispatch decisions, sign-offs, conflict resolution, branch integration, and final QA — and remain the sole scribe of board.md. You are otherwise fully autonomous — there is NO separate approval queue. For the genuinely critical (destructive actions, spending real money, scope changes, unresolvable conflicts), ask the human directly in your own session and let the tool-permission prompt gate the action; the human approves natively, including remotely from their phone via /remote-control. Keep the team unblocked. When you DISPATCH a task, write it as a 4-part contract so the agent can run autonomously: (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the expected deliverable/format; (3) TOOLS — what to use or avoid, and any references to read instead of re-deriving; (4) BOUNDARIES — scope limits + the definition of done. Pass references (file paths, message ids, board sections), not pasted content — keep dispatches short.'
        + ` MONITOR the floor by reading ${inRoot('fleet.json')} (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) and ${inRoot('registry.json')} — note that running 'claude agents' will NOT list your hive's sibling agents. A full Claude Code command reference is at ${inRoot('COMMANDS.md')} (slash commands act ONLY on your own session; CLI commands run in your shell and can target the fleet). You periodically receive scheduler / "Heartbeat" standup requests — on each, review every agent via fleet.json, re-engage anyone stalled, over-budget, or breaker-armed, and keep board.md and tasks.json accurate. In tasks.json, ALWAYS set each task's "assignee" to the worker's agent id the moment you dispatch it, and NEVER clear it on status changes — a done card must still say who did the work (the human reads the board by who-did-what). SUBTASKS: when a request needs several pieces of work, keep ONE card for the request (the parent) and give each piece its own card with "parent": "<the parent card's id>"; the human follows where work comes from by that link. Close the parent only when its subtasks are done, and put the overall result on the parent. PARKED work (nobody on it now, picked up later) goes to "backlog", not "todo": a todo card reads as its owner's next job. HUMAN FEEDBACK is first-class in the ledger: when a task can only proceed with the human's input — a QUESTION to answer OR an ACTION only the human can perform (create an account, approve a purchase, provide credentials/screenshots, test on their device) — set its status to "blocked" and append the concrete ask to the card's "humanQA" array (push {"q":"...","askedAt":"<iso>"}; phrase actions as clear to-dos; keep every past entry — the history documents the card's decisions). WRITE THE ASK SHORT AND IN MARKDOWN. The human reads it on a CARD, not in a terminal, so an ask longer than a short paragraph plus its options (roughly 700 characters) is a report, not a question — cut the narrative, keep the decision. Open with ONE **bold** sentence saying exactly what you need from them; put paths, commands, values and identifiers in \`backticks\`; give each option or step its own "-" bullet or "1." number; leave a blank line between paragraphs (a single newline is a line break, so each option stays on its own line). When the ask originates in another agent's report, REWRITE it into that shape — never paste the report body in as the question, and never make the human read the investigation to find the decision. The harness surfaces open questions on the office floor's ASK ME board; the human's answer lands in the same entry ("a") AND arrives as an inbox message to you — read it, act on it, and unblock the card so work continues. Do NOT park human questions in separate files (no HumanQuestion.md) and never sit waiting on the human in your own session. Steward the token budget.`
      : meta.isAssistant
      ? `You are ${godNameForPrompt}'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in ${godNameForPrompt}'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that ${godNameForPrompt} can execute autonomously, preserving the user's original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to ${godNameForPrompt}.`
      : 'For anything ambiguous, cross-cutting, or needing sign-off, address a message to "god".';
    const guardrailsLine = 'Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; god is the sole scribe) and tasks.json (structured kanban — backlog/todo/doing/blocked/done/cancelled; backlog = parked, nobody is working on it; cancelled = the human stopped it: nobody works on it and nobody moves it out of cancelled).';
    // REST integrations through the loopback key broker. The agent never holds a
    // key: md-api reads MD_BROKER_URL/MD_BROKER_TOKEN from its env, and the
    // broker adds the credential upstream. Absolute paths, not `$VAR` (cmd.exe).
    const apiCli = inRoot('bin', 'md-api.cjs');
    const runCli = inRoot('bin', 'md-run.cjs');
    const runnersLine = runners && runners.length
      ? `SECRETS: the human keeps secrets (API keys, passwords, database URLs) out of your reach — you will never see their values, and you must not try to read, print or exfiltrate them. Commands that need them are RUNNERS the app executes for you, in your worktree, with the secrets set; you get the output with every secret masked as ***. Available: ${runners.map((r) => `${r.id}${r.description ? ` (${r.description})` : ''}${r.secrets.length ? ` [uses ${r.secrets.join(', ')}]` : ''}`).join('; ')}. Run one with \`"${hiveNode}" "${runCli}" <runner>\` (\`"${hiveNode}" "${runCli}"\` lists them and the names of the stored secrets). The human may be asked to approve a run, especially after you changed files. If a task needs a secret no runner provides, PROPOSE one: \`"${hiveNode}" "${runCli}" --propose <name> --secrets NAME[,NAME] --why "<reason>" -- <command>\` (the human approves the exact command once; it then runs like any runner). Never ask for the value.`
      : `RUNNERS: commands that run with secrets you never see. None exist yet; one added later works at once: \`"${hiveNode}" "${runCli}"\` lists them and the names of the stored secrets, \`"${hiveNode}" "${runCli}" <runner>\` runs one (output masked). When a task needs a secret (a migration, a script, a check against a service), propose a runner: \`"${hiveNode}" "${runCli}" --propose <name> --secrets NAME[,NAME] --why "<reason>" -- <command>\`; the human approves the exact command once. Never ask for a secret's value.`;
    // The lists that exist now, so an agent uses them instead of inventing
    // its own place for the human's things.
    let existingLists: ReturnType<typeof parseList>[] = [];
    try {
      existingLists = readdirSync(inRoot('lists')).filter((f) => f.endsWith('.md')).slice(0, 30)
        .map((f) => parseList(f.replace(/\.md$/, ''), readFileSync(inRoot('lists', f), 'utf8')));
    } catch { /* no lists yet */ }
    const listsLine = listsInstruction(inRoot('lists'), existingLists, hasOfficeMcp);
    // Deliverables: one place the human can find them (Manager → Deliverables).
    const deliverablesLine = `DELIVERABLES: anything you produce for the human to read or use — a report, analysis, plan, table (CSV), image, export — goes in ${inRoot('research')} (a subfolder per task is fine), with a clear file name; Markdown for documents. Say the path in your reply${meta.isGod ? `, and set the "deliverable" field of its task card in ${inRoot('tasks.json')} to that path (relative to ${root}, e.g. research/<topic>/report.md) — also when an agent reports one to you` : ' and in your done message to god, who records it on the task card'}. Files you write in research/ while your task card is in "doing" are linked to that task by the app, so finish them there. Code changes stay in their repository as usual; do not copy code into research/.`;
    const integrationsLine = integrations && !integrations.length
      ? `REST APIs (Jira, Linear, Notion… the human connects them in Connections): none are enabled for you right now. One connected later works at once, no restart: run \`"${hiveNode}" "${apiCli}"\` to list the ones you have, then \`"${hiveNode}" "${apiCli}" <api> GET /path\`.`
      : integrations && integrations.length
      ? `REST APIs you can call (the harness adds the key; you never see it): ${integrations.map((i) => `${i.id} (${i.label})`).join(', ')}. Run \`"${hiveNode}" "${apiCli}" <api> GET /path\`, or \`"${hiveNode}" "${apiCli}" <api> POST /path '<json body>'\` (also PUT, PATCH, DELETE). The path is relative to that API's base URL, e.g. \`"${hiveNode}" "${apiCli}" ${integrations[0].id} GET /\`. It prints the HTTP status and the response body.`
      : '';
    // Automations: the orchestrator changes scheduled missions by request file
    // (main validates and applies them, then answers in its inbox).
    const skillsLine = meta.isGod
      ? `SKILLS: you give agents skills from the skills catalog (pdf, docx, xlsx, web testing...). Search: \`"${hiveNode}" "${inRoot('bin', 'md-skills.cjs')}" search <words>\`. To add or remove one, write ONE JSON file into ${inDir('skills')}/<id>.json: {"action":"add","skill":"<catalog name>","agents":["<agent id>"]} ("*" = every agent; action "remove" takes it away); the app installs it and answers in your inbox. Never copy skill folders by hand: only a request reaches the agents. Details: ${inRoot(PROTOCOL_DIR, 'skills.md')}.`
      : '';
    const scheduleLine = meta.isGod
      ? `AUTOMATIONS: you can create, change and delete scheduled missions (a prompt sent to an agent on a clock). Read ${inRoot('missions.json')} for the current ones and their ids. To change them, write ONE JSON file per change into ${inDir('schedule')}: {"op":"create","label":"…","to":"<agent id>","body":"<the prompt>","every":"1d"} (every: 30m, 2h, 1d, 1w; or "weekly":{"days":["mon","fri"],"time":"09:00"}), {"op":"update","id":"<id>", …only the fields to change, incl. "enabled":false}, or {"op":"delete","id":"<id>"}. The harness applies it and tells you the result in your inbox. Built-in missions can only be switched on/off or re-timed. Every mission spends tokens each time it fires, so schedule only what the human asked for or clearly needs.`
      : '';
    // Team: other offices this one is paired with (team.ts / teamNode.ts).
    const teamLine = meta.isGod
      ? `OTHER OFFICES (Team): your human may pair this office with teammates' offices. ${inRoot('team.json')} lists the ones you can write to. To message one, write ONE JSON file into ${inDir('team')}: {"to":"<teammate name>","subject":"…","body":"<markdown>"}; it is sealed end to end and delivered to that office's orchestrator. Their messages reach your inbox from "team:<name>". Write only what the human would be comfortable sending outside this office.`
      : '';
    const slackLine = meta.isGod
      ? 'SLACK REPLIES: When composing a Slack reply (or writing the `result` field of a Slack-origin kanban card), you MUST: (1) directly address what the user asked — never a bare "done"; (2) include the relevant specifics, outcome, and details; (3) format for Slack mrkdwn — open with a short *bold* headline, use bullet points for multiple items, wrap code/paths in `backtick` blocks, keep it concise (no walls of text). When finishing a Slack-origin task, always write a complete, user-facing, well-formatted `result` on the kanban card — the system posts it verbatim to Slack as the done reply.'
      : `SLACK REPLIES: If god dispatches you a task that came from Slack, it will include an exact \`"${hiveNode}" "<helper>" --channel … --thread … --text "…"\` reply command — when you finish, run it VERBATIM to post your result back to that thread yourself. The reply must be SUBSTANTIVE Slack mrkdwn (a short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done".`;
    // Agents that did not know where something was searched the whole disk for
    // it (even Scranton Branch's own source code). One map, absolute paths, and
    // a rule: what is not here does not exist for you.
    const officeMapLine = `WHERE THINGS ARE (full paths; do not search the disk for them): protocol index ${inRoot('PROTOCOL.md')}; plan ${inRoot('board.md')}; task cards ${inRoot('tasks.json')}; who is on the floor ${inRoot('registry.json')} and their live state ${inRoot('fleet.json')}; deliverables ${inRoot('research')}; the human's lists ${inRoot('lists')}; REST APIs \`"${hiveNode}" "${apiCli}"\`; runners \`"${hiveNode}" "${runCli}"\` (both list what you may use when run with no arguments). Never look for office files or tools elsewhere on the disk, in other projects, or in Scranton Branch's own installation or source code: if something is not here, in your folder, your working directory or this prompt, it does not exist for you — ask ${meta.isGod ? 'the human' : 'god'} instead of hunting for it.`;
    // The office browser: a real Chromium for pages a plain fetch cannot read.
    const browseCli = inRoot('bin', 'md-browse.cjs');
    // Claude Code agents are told when a WebFetch fails (PostToolUseFailure, see
    // hooks.ts), not up front; other CLIs have no such moment, so they read it here.
    const browserLine = webOff || hasOfficeMcp ? '' : `BROWSER: for a page that is empty, needs JavaScript or refuses a plain fetch (403, "enable JavaScript", a bot wall for non-browsers), use the office browser — the app's own Chromium${hasOfficeMcp ? ': the munder-browser tools browse_page and web_search, or' : ':'} \`"${hiveNode}" "${browseCli}" <url>\` (add --links for the page's links) and \`"${hiveNode}" "${browseCli}" --search "<query>"\`. It does not solve captchas or bot challenges; if a page asks for one, say so instead of trying to get around it.`;
    // The human asks the orchestrator how to use the app itself; it reads the
    // guide instead of guessing (or searching the app's own files).
    // Every item stays: measured with a fresh Haiku orchestrator, a short list
    // that pointed to the app-*.md topics got 2.5 of 5 "where is it" questions
    // right (it answers from the prompt and rarely opens the topics); this
    // map gets them all. The wording is kept tight because it rides on every turn.
    const appHelpLine = meta.isGod
      ? [
          `APP HELP — Scranton Branch is this app (not Claude Code: never answer with /config, settings.json or claude commands). Where things are; for anything else Read ${inRoot(PROTOCOL_DIR, 'app-pages.md')}, app-setup.md or app-settings.md first:`,
          '- Top bar: Floor (pixel office) / Manager (sidebar pages), theme, Settings (wrench, with a search).',
          '- Manager sidebar: Now, Tasks, Inbox, Deliverables; Office: Automations, Memory, Team, Factories; Setup: Capabilities, Connections, Environment, AI providers, MCP; Agents; Temps.',
          '- An agent writing outside its folders, its git, web, shell or MCP servers: Manager → Capabilities → that agent\'s row → the chip ("Outside its folders", "Git"…). Skills and your own skill marketplaces: Capabilities → Skills. Not in Settings.',
          '- What agents made (Markdown, PDF, diagrams, CSV…), who changed it, each version: Manager → Deliverables → the file. Your questions: Inbox (or the card in Tasks). What the office knows: Memory.',
          '- Keys for Jira, GitHub, Notion or any REST API: Manager → Connections. Secrets, variables, runners: Manager → Environment (md-run --propose may name a secret that does not exist yet: the human creates it in the same prompt).',
          '- Model and effort per role (orchestrator, your agents, temps): Settings → Models & API keys. Engines, custom endpoints, certificates: Manager → AI providers. Your own tool servers: Manager → MCP.',
          '- Another office at once: File → New Floor (Ctrl+Shift+N); each floor is its own window with its own orchestrator.',
          '- Settings: General (updates, Freezes log, office folder, keep awake, language, reset) · Setup (installed tools) · Models & API keys · Autonomy & limits · Tools, Slack & webhooks · Voice · Memory & knowledge.'
        ].join('\n')
      : '';
    const hireLine = meta.isGod
      ? `HIRING A PERMANENT EMPLOYEE (not a temp): write a manifest to ${inRoot('research', 'hires')}/<name>.json — {"spec":"munder-difflin/hire@1","name":"…","description":"one-line role","goal":"standing mission","provider":"claude|codex|cursor|antigravity","model":"…","character":"…","cwd":"/absolute/folder/it/works/in","isolate":false,"tokenCap":0} (only spec and name are required; tokenCap 0 = no cap; cwd defaults to the first project, and "sessionId" continues an existing Claude session). The app opens the Add-Agent review prefilled and the human confirms; then the agent appears in registry.json and you dispatch to its inbox. An invalid file comes back to your inbox as "[hire manifest rejected]" with the reason.`
      : '';
    return [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating hive of agents.`,
      `Your private workspace is ${dir}. The shared hive is ${root}. Protocol: ${inRoot('PROTOCOL.md')} is a short index; each topic is its own small file in ${inRoot(PROTOCOL_DIR)} — open only the one you need, never all of them.`,
      officeMapLine,
      browserLine,
      '',
      'HIVE PROTOCOL — follow it every task:',
      `1. At the START of a task, read ${inDir('memory.md')} and EVERY file in ${inDir('inbox')} (messages other agents sent you). After handling an inbox message, move its file into ${inDir('inbox', '.done')}.`,
      `2. Record durable knowledge in ${inDir('memory.md')}, one dated bullet each, ${memoryInstruction(this.projectTypeOf(meta.cwd))}. Correct or remove a bullet when it stops being true: people read this per project, and stale facts mislead the next agent.`,
      `3. To ask another agent for something or share information, write ONE message JSON into ${inDir('outbox')} (schema: ${inRoot(PROTOCOL_DIR, 'messages.md')}). NEVER write into another agent's folder — the orchestrator delivers your outbox.`,
      meta.isGod
        // The orchestrator's work never "ends" and it rarely learns facts itself:
        // its memory is the office's record of who did what. Left on the worker
        // wording, a live research job left it with an empty memory.
        ? "4. Your memory is the office's record of its work. Whenever a job you delegated finishes, fails or is dropped, append ONE dated bullet under Decisions: what the human asked, who did it, the outcome, and the deliverable path. Anything that went wrong on the way (a crashed temp, a blocked agent, a retry) goes under Log with how you handled it. One or two lines per job, no transcripts."
        : '4. At the END of a task, append what you learned to memory.md so future-you remembers.',
      guardrailsLine,
      memoryLine,
      knowledgeLine,
      deliverablesLine,
      integrationsLine,
      connectionsPromptLine(connections),
      confidentialityPromptLine(critical, vaults?.map((v) => this.forAgent(v))) + (critical?.length && outgoing ? `\n${signoffPromptLine(this.forAgent(outgoing))}` : ''),
      envPromptLine(envNames),
      runnersLine,
      listsLine,
      godLine,
      scheduleLine,
      skillsLine,
      appHelpLine,
      teamLine,
      spawnQueueLine,
      hireLine,
      runtimeLine,
      slackLine,
      // Only the orchestrator routes work; the line meant nothing to a worker.
      meta.isGod ? ctxLine : '',
      fenceLine(this.guardPolicies.get(meta.id)),
      `Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.`
    ].filter(Boolean).join('\n');
  }

  // — messaging —

  /** Normalize a partial message into a full HiveMessage. */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    // `id` names the inbox FILE, and an agent writes its own outbox: anything
    // but a plain name (`../../x`) would let it write JSON anywhere main can.
    const safeId = typeof partial.id === 'string' && SAFE_MSG_ID.test(partial.id) ? partial.id : `${stamp()}-${shortRand()}`;
    return {
      id: safeId,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: messageBody(partial as Record<string, unknown>),
      // hops is harness-owned (PROTOCOL.md: "The harness fills in `id`, `from`,
      // `hops`, and timestamps"), so an agent-authored value is only a carried
      // count, never authoritative. Clamp it into range: an echoed relay must
      // keep climbing toward the cap, while a copied-forward `hops: 13` must
      // not read as a runaway loop (only a harness bounce moves the counter —
      // see bounceToGod). A negative value would just buy more free bounces,
      // so the floor is 0.
      hops: Math.max(0, Math.min(typeof partial.hops === 'number' ? partial.hops : 0, HOP_CAP)),
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString()
    };
  }

  /** Atomically deliver a message into a recipient agent's inbox.
   *  Returns false when the recipient has no inbox, so the caller can bounce and
   *  log the drop rather than let the message vanish. */
  private deliver(msg: HiveMessage, toId: string): boolean {
    // Recipient and file name must stay inside the hive (see normalize).
    if (!SAFE_MSG_ID.test(msg.id)) return false;
    const agents = resolve(this.agentDir(''));
    const target = resolve(this.agentDir(toId));
    if (dirname(target) !== agents) return false;
    const inbox = join(target, 'inbox');
    if (!existsSync(inbox)) return false; // unknown recipient — the caller reports it
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
    return true;
  }

  /** One harness bounce of `msg` to god: bump the hop counter, rewrite the
   *  subject, and log the drop once the counter passes HOP_CAP. Agents can't
   *  move hops past the cap themselves (normalize clamps what they wrote), so
   *  this fuse can only fire on a REAL relay loop — a bounced mail that keeps
   *  coming back undeliverable — and never on an agent-authored number. */
  private bounceToGod(msg: HiveMessage, godId: string, subject: string): void {
    const hops = msg.hops + 1;
    if (hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    this.deliver({ ...msg, hops, to: godId, subject }, godId);
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    // Agents on a WSL floor read these inside the distro: paths the app puts in
    // a message (helper scripts, attachments, agent dirs) as they see them.
    if (this.wslRoot()) {
      partial = {
        ...partial,
        ...(typeof partial.body === 'string' ? { body: this.forAgent(partial.body) } : {}),
        ...(typeof partial.subject === 'string' ? { subject: this.forAgent(partial.subject) } : {})
      };
    }
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    const targets = msg.to === 'broadcast'
      // The roster for fan-out is the ACTIVE registry: skip the send-only prep
      // assistant and any archived agent (closed tab). Hookless providers are
      // NOT skipped — the per-target path below already serves them a terminal
      // work order, so excluding them here only made a broadcast invisible to an
      // agent that direct mail reaches fine. See selectBroadcastTargets.
      ? selectBroadcastTargets(reg.agents, msg.from)
      // Never deliver to self — guards a god → "human" message looping back to god.
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    // Targets that actually took delivery. The log below reports these instead of
    // intent, so a bounced or dropped message can never read as delivered.
    const delivered: string[] = [];
    for (const target of targets) {
      let t = target;
      // The send-only prep assistant must never be a delivery target: it doesn't
      // drain an inbox, so direct mail to it would rot unread (observed live: a
      // task brief plus the follow-up reprimand about the unread inbox, both
      // unread for hours). Bounce such mail to god instead, so the sender's intent
      // surfaces immediately and nothing is silently lost.
      if (reg.agents[t]?.isAssistant) {
        this.bounceToGod(msg, godId, `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`);
        continue;
      }
      // An ARCHIVED recipient (its terminal is gone) still has an inbox, so the
      // mail lands there and reads as delivered — and stays unread. Filing it
      // is right: a worker re-hired under the same id reads it on its first turn
      // (a released worker's inbox is settled only up to its done signal). But
      // the sender learned nothing, so god kept mailing dead agents for hours
      // (seen live 2026-08-16), and a request to a worker nobody re-hires was
      // simply lost. This comes BEFORE the provider branches below on purpose:
      // with no terminal there is nothing to hand a work order to, whatever the
      // engine — the inbox is the only place left. The notice itself is ROUTED,
      // not dropped into an inbox, so a sender on a hookless or proxy-tier
      // engine gets it the way it gets any mail.
      //
      // A re-hire usually gets a NEW id under the same name, so an office piles
      // up archived namesakes (seen live: ~20 archived "Jim - Jira Manager" next
      // to the live one) and an agent that remembered an old id kept mailing a
      // dead inbox; an inform or a done vanished without a word. So: exactly one
      // live agent with that name → the mail goes to it (normal delivery below)
      // and the sender is told the live id. Otherwise it is filed as before and
      // the sender is told for EVERY act, with the live agents of a similar name.
      if (t !== godId && reg.agents[t]?.archived) {
        const sender = reg.agents[msg.from];
        const tell = !!sender && !sender.archived;
        const live = liveNamesakes(reg.agents, t);
        const heir = live.length === 1 && live[0] !== msg.from ? live[0] : undefined;
        if (heir) {
          this.appendLog({ kind: 'archived-recipient', from: msg.from, to: t, id: msg.id, act: msg.act, reroutedTo: heir });
          if (tell) {
            this.routeMessage(this.normalize({
              to: msg.from,
              act: 'inform',
              in_reply_to: msg.id,
              conversation: msg.conversation,
              hops: msg.hops + 1,
              requires_reply: false,
              subject: `["${t}" is archived — delivered to "${heir}"] ${msg.subject}`,
              body: `${t} has no live terminal (archived). Your ${msg.act} was delivered to ${heir} `
                + `"${reg.agents[heir]?.name ?? heir}", the live agent with that name: use ${heir} from now on.`
            }, 'system'));
          }
          t = heir;
        } else {
          if (this.deliver(msg, t)) delivered.push(t);
          this.appendLog({ kind: 'archived-recipient', from: msg.from, to: t, id: msg.id, act: msg.act });
          if (tell) {
            const similar = similarLive(reg.agents, t).filter((k) => k !== msg.from);
            const who = similar.length
              ? `Live agents with a similar name: ${similar.map((k) => `${k} "${reg.agents[k]?.name ?? k}"`).join(', ')}. `
              : 'No live agent has a similar name. ';
            this.routeMessage(this.normalize({
              to: msg.from,
              act: 'inform',
              in_reply_to: msg.id,
              conversation: msg.conversation,
              hops: msg.hops + 1,
              requires_reply: false,
              subject: `[no one is there to answer — "${t}" is archived] ${msg.subject}`,
              body: `Your ${msg.act} to ${t} was filed in its inbox, but ${t} has no live terminal (archived), `
                + `so it will only be read if ${t} is restored or re-hired under the same id. `
                + who
                + 'If this matters, send it to an agent on the live roster or hire one.'
            }, 'system'));
          }
          continue;
        }
      }
      // A provider without safe-idle lifecycle state (a hookless custom command)
      // would let direct mail rot unread. Claude and bridged Antigravity/Codex
      // receive directly into inbox/ for guarded renderer delivery. Otherwise try
      // a terminal work-order handoff to its REPL (#53);
      // if the renderer is unavailable, bounce to god to relay. God is exempt
      // (the bounce target).
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.bounceToGod(msg, godId, `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a hookless CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`);
        } else delivered.push(t);
        continue;
      }
      // 1d — proxy-tier providers (qwen) CAN receive inbox, but only via a
      // SYNTHESIZED Stop, which just advances the cursor — the sidecar observes the
      // CLI's stream and can't inject a drain reason back into its turn. So the real
      // mail rides the terminal work-order path verbatim, exactly like a hookless
      // provider; the synthesized Stop→drain keeps the cursor in step.
      const proxyDesc = bridgeOf(reg.agents[t]?.provider);
      if (t !== godId && proxyDesc?.kind === 'proxy' && proxyDesc.inboxDelivery === 'terminal') {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.bounceToGod(msg, godId, `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a proxy-tier CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`);
        } else delivered.push(t);
        continue;
      }
      if (this.deliver(msg, t)) { delivered.push(t); continue; }
      // No agents/<t>/inbox — an id that isn't on the floor. This was the one
      // delivery failure with neither bounce nor log, so the sender saw a routed
      // message and the mail simply ceased to exist. Record the drop beside the
      // hop-cap one and bounce to god, mirroring the undeliverable bounces above.
      this.appendLog({ kind: 'drop', reason: 'no-inbox', from: msg.from, to: t, id: msg.id });
      if (t !== godId) {
        this.bounceToGod(msg, godId, `[undeliverable — no agent "${t}" on this floor; check the id against the roster] ${msg.subject}`);
      }
    }
    this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id, delivered });
    this.emitMessage(msg, targets);
    // Main-process observer (e.g. the closing-time controller watching for the
    // team's ACKs and the god's COMPLETE). Best-effort, never breaks routing.
    try { this.routedObserver?.(msg, targets); } catch { /* observer error */ }
  }

  /** Observer invoked for EVERY routed message with its resolved targets.
   *  Used by main-process features that react to hive traffic (closing time). */
  private routedObserver: ((msg: HiveMessage, targets: string[]) => void) | null = null;
  setRoutedObserver(cb: ((msg: HiveMessage, targets: string[]) => void) | null): void {
    this.routedObserver = cb;
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human'
    });
  }

  /** Non-Claude providers cannot drain hive inbox; hand direct mail to the
   *  renderer so it can queue a terminal work order for the target PTY. */
  private emitTerminalHandoff(msg: HiveMessage, targetId: string): boolean {
    const delivered = this.emit?.('hive:terminalHandoff', {
      id: msg.id,
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      body: msg.body,
      requiresReply: msg.requires_reply,
      createdAt: msg.created_at
    }) === true;
    this.appendLog({
      kind: 'terminal-handoff',
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered
    });
    return delivered;
  }

  // — router: drain outboxes → inboxes —

  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS. */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => { void this.routeTick(); }, intervalMs);
  }

  private routing = false;
  /** One router pass: look for outbox files off the main thread, and route
   *  (synchronously, as before) only when there is something to route. The
   *  look was ~2 file operations per agent every 1.5 s on the main thread:
   *  ~0.1 s per pass with an antivirus scanning each access. */
  private async routeTick(): Promise<void> {
    if (this.routing) return;
    this.routing = true;
    try {
      const root = this.root();
      if (!root) return;
      const agentsDir = join(root, 'agents');
      let ids: string[];
      try { ids = await readdirAsync(agentsDir); } catch { return; }
      const pending = await Promise.all(ids.map((id) => readdirAsync(join(agentsDir, id, 'outbox'))
        .then((files) => files.some((f) => f.endsWith('.json')), () => false)));
      if (pending.some(Boolean)) this.routeOnce();
    } catch { /* keep the loop alive */ } finally { this.routing = false; }
  }
  stopRouter(): void {
    if (this.routerTimer) { clearInterval(this.routerTimer); this.routerTimer = null; }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const raw = readFileSync(full, 'utf8');
          let partial: Partial<HiveMessage>;
          try {
            partial = JSON.parse(raw) as Partial<HiveMessage>;
          } catch {
            const repaired = repairLiteralLineBreaksInJsonStrings(raw);
            if (!repaired.changed) {
              this.appendLog({ kind: 'drop', reason: 'malformed-json', from: id, file: f });
              try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
              continue;
            }
            try {
              partial = JSON.parse(repaired.text) as Partial<HiveMessage>;
            } catch {
              this.appendLog({ kind: 'drop', reason: 'malformed-json', from: id, file: f });
              try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
              continue;
            }
            this.appendLog({
              kind: 'outbox-repair',
              from: id,
              file: f,
              repair: 'literal-line-break'
            });
          }
          let msg = this.normalize(partial, id);
          msg.from = id; // sender is authoritative — the owning directory
          // What leaves a custodian is redacted first (criticalConnections.ts);
          // the archived copy is the redacted one, never the raw text.
          const out = this.outgoing(msg);
          // Held for the human's sign-off (a custodian's mail): main keeps the
          // redacted copy; the raw file goes, and nothing is routed.
          if (out.hold) {
            rmSync(full, { force: true });
            this.appendLog({ kind: 'outbox-held', from: id, id: msg.id, to: msg.to, ...(out.note ? { note: out.note } : {}) });
            continue;
          }
          if (out.note) {
            msg = out.msg;
            writeFileSync(join(outbox, '.sent', f), JSON.stringify(msg, null, 2), 'utf8');
            rmSync(full, { force: true });
            this.appendLog({ kind: 'outbox-redacted', from: id, id: msg.id, note: out.note });
            this.routeMessage(msg);
            routed++;
            continue;
          }
          this.routeMessage(msg);
          renameSync(full, join(outbox, '.sent', f)); // archive, don't reprocess
          routed++;
        } catch {
          // malformed file — quarantine so we don't spin on it
          try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
        }
      }
    }
    if (routed > 0) this.commit(`hive: routed ${routed} message(s)`);
    return routed;
  }

  // — read helpers (for IPC / UI) —

  /** registry.json, parsed: read on every hook event and route, so kept
   *  while the file is unchanged (the hive's own writes drop it; it is
   *  re-checked with a stat at most every 300 ms). A copy each time: callers
   *  edit what they get and write it back. */
  private registryCache: { path: string; key: string; reg: Registry; checkedAt: number } | null = null;

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    const p = join(root, 'registry.json');
    const now = Date.now();
    const c = this.registryCache;
    if (c && c.path === p && now - c.checkedAt < 300) return structuredClone(c.reg);
    let key = '';
    try { const s = statSync(p); key = `${s.mtimeMs}:${s.size}`; } catch { /* missing */ }
    if (c && c.path === p && key && c.key === key) { c.checkedAt = now; return structuredClone(c.reg); }
    const reg = this.readJson<Registry>(p, { godId: null, agents: {} });
    this.registryCache = key ? { path: p, key, reg: structuredClone(reg), checkedAt: now } : null;
    return reg;
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }
  tasks(): unknown {
    const root = this.root();
    return root ? this.readJson(join(root, 'tasks.json'), { tasks: [] }) : { tasks: [] };
  }

  /** Ticket keys for every card (`bmt-12`), assigned on first sight and kept in
   *  taskKeys.json, a ledger only the harness writes (see shared/taskKeys.ts).
   *  The prefix comes from the hive's parent folder name. */
  taskKeys(): { prefix: string; keys: Record<string, number> } {
    const root = this.root();
    if (!root) return { prefix: taskKeyPrefix(null), keys: {} };
    const prefix = taskKeyPrefix(basename(dirname(root)));
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks.filter((t) => t && typeof t.id === 'string') : [];
    const path = join(root, 'taskKeys.json');
    const current = normalizeTaskKeyLedger(this.readJson<unknown>(path, null));
    const { ledger: next, changed } = assignTaskKeys(current, tasks);
    if (changed) this.writeJson(path, next);
    return { prefix, keys: next.keys };
  }

  /** Persist the task ledger to hive/tasks.json and commit it. Mirrors the
   *  board/message persist pattern: write JSON, log the change, single-commit.
   *
   *  MERGES by card id instead of clobbering. Callers hold PARTIAL models of a
   *  card — the renderer's kanban parser knows nine fields, the god writes as
   *  many as the work needs (`result`, the verbatim Slack reply posted back to
   *  the user; `repo`; `scope`; `origin`; `commit`; …). A wholesale write meant
   *  one small edit through the UI deleted every unmodelled field on EVERY card
   *  on the board. Now an unmentioned field keeps its on-disk value.
   *
   *  Deleting a card still works: the incoming list IS the membership, so a card
   *  dropped from it (TasksKanban dismiss, the voice delete_task action) is
   *  gone. Merging protects fields, never card membership. */
  writeTasks(tasks: HiveTask[]): void {
    const root = this.root();
    if (!root) return;
    this.ensureHiveOnce(root);
    const path = join(root, 'tasks.json');
    const current = this.readJson<{ tasks?: unknown }>(path, { tasks: [] });
    const merged = mergeTaskLedger(current?.tasks, tasks);
    this.writeJson(path, { tasks: merged });
    this.appendLog({ kind: 'tasks', count: merged.length });
    this.commit(`hive: tasks (${merged.length})`);
  }

  /** Append one card against the latest on-disk ledger. Renderer callers must
   *  use this instead of re-writing a collection they read before another
   *  source (webhook, Slack, god, voice) added work. Idempotent by task id. */
  addTask(task: HiveTask): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    if (tasks.some((current) => current?.id === task.id)) return false;
    this.writeTasks([...tasks, task]);
    return true;
  }

  /** Patch one card against the latest on-disk ledger, preserving unrelated
   *  cards and fields (notably webhook.tokenHash and Slack thread metadata). */
  patchTask(id: string, patch: Partial<Omit<HiveTask, 'id'>>): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const index = tasks.findIndex((task) => task?.id === id);
    if (index < 0) return false;
    const next = tasks.slice();
    next[index] = { ...tasks[index], ...patch, id };
    this.writeTasks(next);
    return true;
  }

  /** The human edits or cancels cards from the app (shared/taskEdit.ts): all
   *  edits are checked first and written in ONE ledger write, then whoever was
   *  on each card, and god, are told through their inboxes (one message per
   *  recipient), so an agent stops work the human cancelled or gave away. */
  editTasks(edits: Array<{ id: string; edit: TaskEdit }>, from = 'human'): { ok: true; notified: string[] } | { ok: false; error: TaskEditError; id: string } {
    const ledger = this.tasks() as { tasks?: unknown };
    let next: unknown[] = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const { prefix, keys } = this.taskKeys();
    const ticketOf = (id: string): string | undefined => {
      const card = next.find((t) => (t as { id?: unknown })?.id === id) as { ticket?: unknown } | undefined;
      return (typeof card?.ticket === 'string' && card.ticket.trim()) ? card.ticket.trim() : formatTaskKey(prefix, keys[id]);
    };
    const changes: Array<{ before: Record<string, unknown>; id: string }> = [];
    for (const { id, edit } of edits) {
      const res = taskEditPatch(next, id, edit ?? {}, (x) => formatTaskKey(prefix, keys[x]));
      if (!res.ok) return { ok: false, error: res.error, id };
      if (!Object.keys(res.patch).length) continue;
      changes.push({ before: next.find((t) => (t as { id?: unknown })?.id === id) as Record<string, unknown>, id });
      next = patchTaskInLedger(next, id, res.patch);
    }
    if (!changes.length) return { ok: true, notified: [] };
    this.writeTasks(next as HiveTask[]);
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    const name = (id: string) => reg.agents[id]?.name ?? id;
    const notices = mergeTaskNotices(changes.flatMap(({ before, id }) => taskEditNotices(
      before, next.find((t) => (t as { id?: unknown })?.id === id) as Record<string, unknown>,
      { godId, ticket: ticketOf(id), name })));
    for (const n of notices) this.send({ to: n.to, act: 'inform', requires_reply: false, subject: n.subject, body: n.body }, from);
    return { ok: true, notified: notices.map((n) => n.to) };
  }

  /** Delete only the named card from the latest on-disk ledger. */
  deleteTask(id: string): boolean {
    const ledger = this.tasks() as { tasks?: HiveTask[] };
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const next = tasks.filter((task) => task?.id !== id);
    if (next.length === tasks.length) return false;
    this.writeTasks(next);
    return true;
  }
  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  /** Whether an agent has recorded NON-TRIVIAL memory — i.e. has appended real
   *  notes beyond the boilerplate header ensureAgent seeds. Lets the voice
   *  read-layer answer "what has the team remembered" and enumerate who has
   *  anything worth reading (every registered agent technically has a memory.md,
   *  but most of the floor's history lives in a handful of them). Cheap: reads a
   *  small markdown file; never throws. Works for ANY id, active OR archived. */
  private memoryFlag = new Map<string, { mtime: number; has: boolean }>();
  /** hasMemory off the main thread; the file is parsed again only when it changed. */
  async hasMemoryAsync(id: string): Promise<boolean> {
    const p = join(this.agentDir(id), 'memory.md');
    try {
      const st = await statAsync(p);
      const hit = this.memoryFlag.get(id);
      if (hit && hit.mtime === st.mtimeMs) return hit.has;
      const has = parseMemory(await readFileAsync(p, 'utf8')).length > 0;
      this.memoryFlag.set(id, { mtime: st.mtimeMs, has });
      return has;
    } catch { return false; }
  }
  hasMemory(id: string): boolean {
    const p = join(this.agentDir(id), 'memory.md');
    if (!existsSync(p)) return false;
    try {
      // A fresh seed is headings only (the sectioned template is ~300 chars,
      // so length no longer tells): any bullet or note means real memory.
      return parseMemory(readFileSync(p, 'utf8')).length > 0;
    } catch { return false; }
  }
  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** Read an agent's OUTBOX (messages it has authored/sent). Symmetric with
   *  inbox(); the router drains live outbox files into recipients' inboxes and
   *  archives the original under outbox/.sent, so a sent message survives there. */
  outbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'outbox'));
  }

  /**
   * Voice read-layer: recent message CONTENT (inbox + outbox bodies) for the
   * operator briefing, REDACTED main-side. This is the message-content half of
   * the voice query surface (the activity half is logTail()).
   *
   * Modes:
   *   - { id }                → the single message with that id, wherever it lives.
   *   - { agentId }           → recent messages in that agent's mailbox only.
   *   - {}                    → recent messages across the whole floor, newest first.
   * `limit` caps the list (default 12, max 40); `includeArchived` (default true)
   * also reads the handled subfolders (inbox/.done, outbox/.sent).
   *
   * SECURITY: every subject + body is passed through redactSecrets() here, in
   * main, so no secret and no raw body ever crosses IPC. Delivered messages exist
   * in both the sender's outbox/.sent and the recipient's inbox/.done; we dedup
   * by message id so each appears once.
   */
  voiceMessages(opts: { agentId?: string; id?: string; limit?: number; includeArchived?: boolean; history?: boolean } = {}): VoiceMessage[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];

    const wantId = typeof opts.id === 'string' ? opts.id.trim() : '';
    const onlyAgent = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    const includeArchived = opts.includeArchived !== false; // default true

    let owners: string[];
    try {
      owners = onlyAgent
        ? [onlyAgent]
        : readdirSync(agentsDir).filter((id) => !id.startsWith('.') && existsSync(this.agentDir(id)));
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const out: VoiceMessage[] = [];
    for (const owner of owners) {
      const base = this.agentDir(owner);
      const folders: Array<{ dir: string; direction: 'inbox' | 'outbox'; archived: boolean }> = [
        { dir: join(base, 'inbox'), direction: 'inbox', archived: false },
        { dir: join(base, 'outbox'), direction: 'outbox', archived: false }
      ];
      if (includeArchived) {
        folders.push({ dir: join(base, 'inbox', '.done'), direction: 'inbox', archived: true });
        folders.push({ dir: join(base, 'outbox', '.sent'), direction: 'outbox', archived: true });
      }
      for (const f of folders) {
        for (const m of this.listMessages(f.dir)) {
          if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
          seen.add(m.id);
          if (wantId && m.id !== wantId) continue;
          out.push({
            id: m.id,
            conversation: m.conversation,
            from: m.from,
            to: m.to,
            act: m.act,
            subject: redactSecrets(m.subject),
            body: redactSecrets(m.body),
            requires_reply: !!m.requires_reply,
            in_reply_to: typeof m.in_reply_to === 'string' ? m.in_reply_to : null,
            direction: f.direction,
            owner,
            archived: f.archived,
            created_at: m.created_at
          });
        }
      }
    }

    // Newest first by ISO created_at (lexicographic == chronological for ISO-8601).
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (wantId) return out.slice(0, 1);
    // 40 keeps a voice briefing short. The Inbox reads the conversation
    // history (`history`), which a cap of 40 across the whole floor cut to the
    // last few minutes of a busy office.
    const cap = opts.history === true ? 2000 : 40;
    const lim = typeof opts.limit === 'number' && isFinite(opts.limit)
      ? Math.max(1, Math.min(cap, Math.round(opts.limit)))
      : 12;
    return out.slice(0, lim);
  }
  /** Count undrained inbox messages for an agent (cheap — for the fleet snapshot). */
  /** inboxBacklog off the main thread. */
  async inboxBacklogAsync(id: string): Promise<number> {
    try { return (await readdirAsync(join(this.agentDir(id), 'inbox'))).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }
  inboxBacklog(id: string): number {
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }
  /** Install the Antigravity (`agy`) lifecycle-hook bridge: write the normalizer
   *  shim and merge a `munder-hive` hook group into agy's global hooks.json so a
   *  Gemini worker reports PreToolUse/PostToolUse/Stop/PreInvocation/PostInvocation
   *  to this HookServer (live status + guarded idle delivery), reusing the Claude pipeline.
   *
   *  Two agy-isms handled: (1) antigravity-cli#49 — agy LOADS hooks from
   *  `~/.gemini/antigravity-cli/hooks.json` but TRIGGERS from `~/.gemini/config/
   *  hooks.json`, so we write BOTH; (2) on Windows commands go to cmd.exe and
   *  agy mangles embedded quotes, so that platform gets a quote-free command
   *  (windowsHookCommand).
   *  Runtime-scoped by AGENT_ID (the shim no-ops for non-hive agy sessions), so
   *  this global config never disturbs the user's own `agy` usage. Best-effort,
   *  idempotent (only our own group is overwritten). */
  private installAgyHooks(): void {
    const root = this.root();
    if (!root) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    const command = (event: string) => this.winAgents()
      ? this.windowsHookCommand('md-agy-hook', shim, event)
      : this.nodeRun(shim, event);
    const tool = (event: string) => ({
      matcher: '*',
      hooks: [{ type: 'command', command: command(event), timeout: 0 }]
    });
    const plain = (event: string) => ({
      hooks: [{ type: 'command', command: command(event), timeout: 0 }]
    });
    const group = {
      PreToolUse: [tool('PreToolUse')],
      PostToolUse: [tool('PostToolUse')],
      PreInvocation: [plain('PreInvocation')],
      PostInvocation: [plain('PostInvocation')],
      Stop: [plain('Stop')]
    };
    const gem = join(this.userHome(), '.gemini');
    for (const p of [join(gem, 'config', 'hooks.json'), join(gem, 'antigravity-cli', 'hooks.json')]) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        let existing: Record<string, unknown> = {};
        if (existsSync(p)) {
          try { existing = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { existing = {}; }
        }
        existing['munder-hive'] = group;
        writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      } catch { /* best-effort per file */ }
    }
  }

  /** Official Google Gemini CLI lifecycle bridge. Gemini's hook payload is
   *  already snake_case; the shim maps event names into HookServer's common
   *  vocabulary and translates deny/steering replies back to Gemini.
   *
   *  The system settings path is per agent. Gemini merges object and array
   *  settings across layers, so auth and user settings remain in their normal
   *  GEMINI_CLI_HOME while this trusted bridge stays isolated. */
  private installGeminiHooks(dir: string): string {
    const home = join(dir, '.gemini-hive');
    const settingsPath = join(home, 'system-settings.json');
    try {
      mkdirSync(home, { recursive: true });
      const shim = join(home, 'gemini-hook.cjs');
      writeFileSync(shim, GEMINI_HOOK_SHIM, 'utf8');
      const hook = (name: string, matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        sequential: true,
        hooks: [{
          name: `munder-hive-${name}`,
          type: 'command',
          command: this.winAgents()
            ? this.windowsHookCommand(`md-gemini-hook-${basename(dir).replace(/[^A-Za-z0-9_-]/g, '-')}`, shim)
            : this.nodeRun(shim),
          timeout: 30000
        }]
      });
      const settings = {
        hooksConfig: { enabled: true, notifications: false },
        hooks: {
          SessionStart: [hook('session-start')],
          BeforeAgent: [hook('before-agent')],
          BeforeTool: [hook('before-tool', '.*')],
          AfterTool: [hook('after-tool', '.*')],
          AfterAgent: [hook('after-agent')]
        }
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installGeminiHooks failed:', e); }
    return settingsPath;
  }

  /** Codex lifecycle-hook bridge → full hive parity for a `codex` worker (live
   *  status + Stop→inbox-drain), the codex counterpart of installAgyHooks().
   *
   *  Codex's hook contract is already Claude-shaped: snake_case stdin
   *  (hook_event_name/tool_name/tool_input/session_id/cwd) and a matching response
   *  contract, where `Stop` honoring {decision:'block',reason} means "continue,
   *  using reason as the next prompt" — exactly what drainForStop() returns. So we
   *  reuse the Claude `cth-hook` shim VERBATIM (no translator, unlike agy) and let
   *  HookServer handle everything unchanged.
   *
   *  ISOLATION: rather than mutate the user's global Codex configuration (which
   *  also holds their login), we point this worker at a PER-AGENT CODEX_HOME
   *  (`<dir>/.codex`, alongside Claude's settings.json) holding our own config.toml
   *  with `[hooks]` tables — so the hooks fire ONLY for hive workers and a personal
   *  `codex` run is untouched. Rollout directories are linked into that isolated
   *  home from namespaced paths under the standard global scan roots. The user's
   *  ~/.codex/auth.json is linked in and their config.toml is copied + extended
   *  (login + model/provider/trust settings still apply).
   *  Returns the CODEX_HOME path for the caller to put in the worker's env. */
  private installCodexHooks(dir: string, agentId: string): string {
    const home = join(dir, '.codex');
    try {
      mkdirSync(home, { recursive: true });
      const userHome = join(this.userHome(), '.codex');
      // Symlink the user's login so the isolated home authenticates as them.
      // (config.toml is NOT symlinked — we write our own below, seeded from theirs,
      // because it must carry our [hooks] tables.) Fall back to copy where symlinks
      // need privilege (Windows). Idempotent — skip if already linked.
      const authSrc = join(userHome, 'auth.json');
      const authDest = join(home, 'auth.json');
      if (existsSync(authSrc) && !existsSync(authDest)) {
        try { this.linkPath(authSrc, authDest, false); }
        catch { try { copyFileSync(authSrc, authDest); } catch { /* best-effort */ } }
      }
      // The managed app-server daemon used by Codex Remote Control is launched
      // from the standalone install rooted at $CODEX_HOME/packages. Share the
      // user's installed binaries without duplicating them into every agent.
      const packagesSrc = join(userHome, 'packages');
      const packagesDest = join(home, 'packages');
      if (existsSync(packagesSrc) && !existsSync(packagesDest)) {
        try {
          this.linkPath(packagesSrc, packagesDest, true);
        } catch { /* remote integration falls back to a local TUI if unavailable */ }
      }
      // Wire lifecycle hooks via config.toml `[hooks]` tables — the user-layer
      // discovery surface Codex actually scans. (A bare $CODEX_HOME/hooks.json is
      // plugin-scoped — referenced FROM a plugin manifest — and is NOT discovered
      // for a plain config dir; verified empirically that it never fires.) We seed
      // this config.toml from the user's (their model/provider/trust settings carry
      // over) and append a `[[hooks.<Event>]]` group per event, each pointing at the
      // SAME cth-hook shim — reused verbatim (Codex's hook payload + response are
      // already Claude-shaped, so HookServer/drainForStop run unchanged). Regenerated
      // each spawn (idempotent). Serialize the generated command as a TOML basic
      // string; JSON string escaping is compatible here and, on POSIX, preserves
      // the embedded quotes required when a user-selected hive path has spaces.
      // NOTE: hooks fire in INTERACTIVE codex sessions (how hive workers run),
      // not in headless `codex exec`.
      //
      // `timeout` IS SECONDS HERE — do NOT copy Claude's `timeout: 0` sentinel into
      // this file. Codex parses the key as `timeout_sec` and normalizes it with
      // `timeout_sec.unwrap_or(600).max(1)`, so 0 does not mean "no timeout": it is
      // floored to ONE SECOND, the shortest budget there is. That shipped through
      // v0.3.7 and made every codex worker log `SessionStart hook (failed) — hook
      // timed out after 1s` (same for UserPromptSubmit), because each hook cold-starts
      // the Electron binary via hive-node and then waits on hooks.sock — measured
      // 0.08-0.16s idle but 0.6-0.7s under 8 concurrent spawns, which is exactly what
      // session start and prompt dispatch look like. 30s clears that by two orders of
      // magnitude while still capping a wedged shim well before its own 5s internal
      // cap stops mattering; bare omission (600s) would leave a hang looking like a
      // freeze. Verify any change with codex's own resolver, no model spend:
      // `codex app-server` → initialize → `hooks/list` reports the normalized
      // timeoutSec per event.
      const shim = this.shimPath();
      let config = existsSync(join(userHome, 'config.toml'))
        ? readFileSync(join(userHome, 'config.toml'), 'utf8') : '';
      if (shim) {
        const events = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
          'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'];
        // Windows: no nested quotes (#350), and no path with a space either —
        // see windowsHookCommand. POSIX: ordinary shell quoting, verified.
        const command = this.winAgents()
          ? this.windowsHookCommand('md-codex-hook', shim)
          : this.nodeRun(shim);
        config += '\n# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n';
        for (const ev of events) {
          config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(command)}\ntimeout = 30\n`;
        }
      }
      writeFileSync(join(home, 'config.toml'), config, 'utf8');

      // Keep each worker's CODEX_HOME isolated while putting its rollout data
      // below Codex's standard scan roots. External usage tools can then discover
      // the sessions without understanding the hive's private directory layout.
      this.exposeCodexDataDirs(home, userHome, agentId);
    } catch (e) { console.error('[hive] installCodexHooks failed:', e); }
    return home;
  }

  private exposeCodexDataDirs(home: string, userHome: string, agentId: string): void {
    for (const kind of ['sessions', 'archived_sessions'] as const) {
      try { this.exposeCodexDataDir(home, userHome, agentId, kind); }
      catch (e) { console.error(`[hive] exposeCodexDataDir(${kind}) failed:`, e); }
    }
  }

  private moveCodexDataDir(from: string, to: string): void {
    try {
      renameSync(from, to);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      rmSync(from, { recursive: true, force: true });
    }
  }

  private exposeCodexDataDir(
    home: string,
    userHome: string,
    agentId: string,
    kind: 'sessions' | 'archived_sessions'
  ): void {
    const root = this.root();
    if (!root) return;
    if (!agentId || basename(agentId) !== agentId || agentId === '.' || agentId === '..') {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    const source = join(home, kind);
    const scanRoot = join(userHome, kind, 'munder-difflin');
    const hiveId = createHash('sha1').update(root).digest('hex').slice(0, 12);
    const target = join(scanRoot, hiveId, agentId);

    let sourceStat: ReturnType<typeof lstatSync> | null = null;
    try { sourceStat = lstatSync(source); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }

    if (sourceStat?.isSymbolicLink()) {
      let current: string | null = null;
      try { current = realpathSync(source); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        unlinkSync(source);
        sourceStat = null;
      }
      if (current) {
        const rel = relative(realpathSync(scanRoot), current);
        const scope = dirname(rel);
        if (rel && !rel.startsWith('..') && !isAbsolute(rel)
          && dirname(scope) === '.' && basename(rel) === agentId) return;
        throw new Error(`${source} points outside ${scanRoot}`);
      }
    }
    if (sourceStat && !sourceStat.isDirectory()) throw new Error(`${source} is not a directory`);

    mkdirSync(dirname(target), { recursive: true });
    if (sourceStat) {
      if (existsSync(target)) {
        if (readdirSync(target).length > 0) throw new Error(`${source} and ${target} both contain data`);
        rmSync(target, { recursive: true, force: true });
      }
      this.moveCodexDataDir(source, target);
    } else if (!existsSync(target)) {
      mkdirSync(target, { recursive: true });
    }

    try {
      this.linkPath(target, source, true);
    } catch (e) {
      if (!existsSync(source) && existsSync(target)) {
        try { this.moveCodexDataDir(target, source); } catch { /* data remains at target */ }
      }
      throw e;
    }
  }

  /** Remove rollout directories moved under the user's standard Codex scan
   *  roots before a full hive reset removes the isolated CODEX_HOME links. */
  removeExposedCodexData(): void {
    const root = this.root();
    if (!root) return;
    const agents = join(root, 'agents');
    if (!existsSync(agents)) return;
    const userHome = join(this.userHome(), '.codex');

    for (const entry of readdirSync(agents, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const kind of ['sessions', 'archived_sessions'] as const) {
        const source = join(agents, entry.name, '.codex', kind);
        try {
          if (!lstatSync(source).isSymbolicLink()) continue;
          const target = realpathSync(source);
          const scanRoot = realpathSync(join(userHome, kind, 'munder-difflin'));
          const rel = relative(scanRoot, target);
          const scope = dirname(rel);
          if (!rel || rel.startsWith('..') || isAbsolute(rel)
            || dirname(scope) !== '.' || basename(rel) !== entry.name) continue;
          rmSync(target, { recursive: true, force: true });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[hive] removeExposedCodexData failed:', e);
          }
        }
      }
    }
  }

  /** Which providers your Pi is signed in to (~/.pi/agent/auth.json): names and
   *  kind only (oauth / api key), never a token. For Settings → AI providers. */
  piAuthStatus(): { file: string; providers: Array<{ id: string; kind: string }> } {
    const file = join(this.userHome(), '.pi', 'agent', 'auth.json');
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { type?: unknown } | unknown>;
      const providers = Object.entries(raw)
        .filter(([, v]) => !!v && typeof v === 'object')
        .map(([id, v]) => ({ id, kind: typeof (v as { type?: unknown }).type === 'string' ? String((v as { type?: unknown }).type) : 'key' }));
      return { file, providers };
    } catch { return { file, providers: [] }; }
  }

  /**
   * The bubblewrap argv for a pi agent (shared/bwrapSandbox.ts), or null when
   * bubblewrap cannot run here (native Windows, or not installed: the Setup row
   * says so and the agent's card shows it is not sandboxed). Writable: the
   * same folders Claude Code's sandbox gets (its hive folder, the hive, extra
   * dirs), the project or worktree it works in, the hook socket's folder and
   * the pi login it refreshes.
   */
  private async piSandbox(
    meta: AgentMeta, dir: string, root: string,
    opts: { extraWritableDirs?: string[]; writableRoots?: string[] },
    sock: string | null
  ): Promise<string[] | null> {
    if (!(await this.sandboxAvailable())) return null;
    const lin = (p: string): string => this.forAgent(p).replace(/\\/g, '/');
    const userHome = lin(this.userHome());
    const writable = [
      ...this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs),
      meta.cwd, ...(opts.writableRoots ?? []),
      // The hook socket (native Linux: a Unix socket, maybe under /tmp).
      ...(sock && !/^tcp:/.test(sock) && !/^\\\\/.test(sock) ? [dirname(sock)] : [])
    ].filter((d): d is string => typeof d === 'string' && d.length > 0).map(lin);
    // Inside the hive, the other agents' folders stay read-only (its own is reopened).
    const profile = { writable, readOnly: [lin(join(root, 'agents'))], writableFiles: [`${userHome}/.pi/agent/auth.json`], home: userHome };
    const present = new Set(await this.existingPaths(mountPoints(profile)));
    return bwrapArgs(profile, (p) => present.has(p));
  }

  /** Which of these (agent-side) paths exist where the agent runs. */
  private async existingPaths(paths: string[]): Promise<string[]> {
    const w = this.wslRoot();
    if (!w) return paths.filter((p) => existsSync(p));
    const script = 'for p in "$@"; do [ -e "$p" ] && printf "%s\\n" "$p"; done; true';
    try { return (await runInDistroAsync(w.distro, 'bash', ['-c', script, 'x', ...paths], '/')).split('\n').map((l) => l.trim()).filter(Boolean); }
    catch { return []; }
  }

  /** Pi (earendil-works) bridge. Pi has a rich `pi.on(event, …)` lifecycle but no
   *  Claude-shaped hook file; instead we drop a bundled EXTENSION into a PER-AGENT
   *  PI_CODING_AGENT_DIR (so the user's global ~/.pi is never mutated) that, when Pi
   *  loads it, posts cth-hook-shaped payloads to HIVE_SOCK on tool_call/agent_end and
   *  auto-approves tool calls when the floor is in auto mode (HIVE_AUTO_APPROVE).
   *  Emitting an `agent_end`→`Stop` keeps the harness status in step (→ idle), which
   *  lets the renderer idle inbox-wake nudge deliver mail. Returns the per-agent dir
   *  for PI_CODING_AGENT_DIR.
   *
   *  Discovery from `<PI_CODING_AGENT_DIR>/extensions/` and the events used were
   *  verified live on Pi 1.0.4. Still wrapped so a future API change can never
   *  break the spawn; the renderer nudge is the drain backstop regardless. */
  private installPiHooks(dir: string): string {
    const home = join(dir, '.pi-agent');
    try {
      // Pi discovers extensions under its agent dir; we write to the documented
      // `extensions/` location (and keep it isolated per agent).
      const extDir = join(home, 'extensions');
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, 'hive-bridge.js'), PI_EXTENSION, 'utf8');
      // A manifest so Pi auto-loads the extension on start (best-effort; harmless if
      // Pi ignores it). Kept minimal and hive-authored.
      const manifest = { name: 'munder-hive-bridge', version: '0.3.2', main: 'extensions/hive-bridge.js', auto: true };
      writeFileSync(join(home, 'extensions.json'), JSON.stringify(manifest, null, 2), 'utf8');

      const userPiDir = join(this.userHome(), '.pi', 'agent');
      // Your Pi login (`/login`: Claude, ChatGPT, Copilot, Gemini…) and the keys
      // Pi stored lives in auth.json. Linked, like Codex's, so the agent signs in
      // as you and a token Pi refreshes stays fresh for both; copied where a link
      // is not allowed. Without it a hive Pi agent was never logged in.
      const authSrc = join(userPiDir, 'auth.json');
      const authDest = join(home, 'auth.json');
      if (existsSync(authSrc)) {
        let linked = false;
        try { linked = lstatSync(authDest).isSymbolicLink(); } catch { /* not there yet */ }
        if (!linked) {
          // A copy (or nothing yet): try the link again, else refresh the copy so a
          // token Pi renewed since last time is the one the agent gets.
          try { rmSync(authDest, { force: true }); this.linkPath(authSrc, authDest, false); }
          catch { try { copyFileSync(authSrc, authDest); } catch (e) { console.error('[hive] installPiHooks auth.json:', e); } }
        }
      }
      // Your default provider and model (settings.json) and custom models.
      for (const fileName of ['models.json', 'models-store.json', 'settings.json'] as const) {
        try {
          const data = readFileSync(join(userPiDir, fileName), 'utf8');
          writeFileSync(join(home, fileName), data, 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[hive] installPiHooks copy ${fileName} failed:`, e);
        }
      }
    } catch (e) { console.error('[hive] installPiHooks failed:', e); }
    return home;
  }

  /** OpenCode (anomalyco/opencode) bridge — god Decision 1 (native plugin, not proxy).
   *  OpenCode has no Claude-shaped Stop hook, but its plugin API exposes a real
   *  `session.idle` lifecycle event. We drop a bundled PLUGIN into a PER-AGENT config
   *  dir's `plugin/` folder (OpenCode auto-loads `*.js` plugins from there) that posts
   *  HIVE_SOCK payloads on tool.execute.before/after + session.idle — the same
   *  Stop→drain semantics as codex's hooks, provider-agnostic, no traffic interception.
   *  Returns the config dir for OPENCODE_CONFIG_DIR (isolates from ~/.config/opencode).
   *
   *  LIVE-UNVERIFIED: plugin auto-load + session.idle firing + the inject path need
   *  BYOK keys to confirm; written best-effort, wrapped so it can't break the spawn.
   *  The renderer idle inbox-wake nudge is the guaranteed drain fallback. */
  private installOpenCodePlugin(dir: string, theme?: 'light' | 'dark'): string {
    const home = join(dir, '.opencode');
    try {
      // Theme: OpenCode's `system` theme keeps the terminal's own fg/bg (xterm's,
      // which already follows the app theme) and builds its greys from the
      // detected background, so it reads right on light AND dark. Written to
      // tui.json (current builds) and opencode.json (older builds read `theme`
      // there and migrate it; the migration skips when tui.json already exists).
      // Per-agent dir only, the user's ~/.config/opencode is never touched.
      if (theme) {
        mkdirSync(home, { recursive: true });
        const choice = { theme: 'system' };
        writeFileSync(join(home, 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', ...choice }, null, 2), 'utf8');
        writeFileSync(join(home, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...choice }, null, 2), 'utf8');
      }
      // BOTH `plugin/` and `plugins/`. OpenCode's current docs specify `plugins/`
      // (plural); older builds — and the shape this bridge was originally written
      // against — auto-load from `plugin/` (singular). Since the whole bridge is
      // LIVE-UNVERIFIED (no BYOK keys to prove which the installed version reads),
      // guessing one of them is a coin flip whose losing side is silent: the plugin
      // simply never loads and the agent's only inbox drain becomes the renderer
      // nudge. Writing the same ~2KB file twice costs nothing, is idempotent, and
      // is correct whichever directory the installed OpenCode actually scans.
      for (const name of ['plugin', 'plugins']) {
        const pluginDir = join(home, name);
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, 'hive-bridge.js'), OPENCODE_PLUGIN, 'utf8');
      }
    } catch (e) { console.error('[hive] installOpenCodePlugin failed:', e); }
    return home;
  }

  /** Crush (charmbracelet/crush) proxy routing. Crush has NO base-URL env override, so
   *  the generic proxy env-rewrite is a no-op for it; instead we write a per-agent
   *  CRUSH_GLOBAL_CONFIG whose standard providers' `base_url` all point at the loopback
   *  proxy (so whatever model the worker picks, its LLM traffic routes through the
   *  sidecar → synthesized Status/Stop/cost → status goes idle → the terminal
   *  work-order + renderer nudge deliver mail). A per-agent CRUSH_GLOBAL_DATA isolates
   *  session state from the user's global ~/.config/crush. Keys ride BYOK env vars
   *  (Crush reads ANTHROPIC_API_KEY/OPENAI_API_KEY/… directly), so none are written
   *  here. `api` follows the proxy's wire shape (advisory). Returns the config + data
   *  paths for the spawn env.
   *
   *  LIVE-UNVERIFIED: the single-upstream proxy serves one provider/endpoint shape at a
   *  time — for full synthesized events pick a model whose provider matches the
   *  configured upstream (or a local OpenAI-compatible endpoint). Cross-provider mixing
   *  is humanQA; the renderer nudge still delivers mail regardless. */
  private installCrushConfig(dir: string, loopbackUrl: string, api: 'openai' | 'anthropic', theme?: 'light' | 'dark'): { config: string; data: string } {
    const config = join(dir, 'crush.json');
    const data = join(dir, '.crush-data');
    try {
      mkdirSync(data, { recursive: true });
      // Override base_url → loopback for ONLY the provider whose wire-shape matches
      // the proxy (`api`): the single-upstream sidecar forwards bytes unchanged, so
      // routing a different-wire/host provider (e.g. anthropic when api='openai', or
      // openrouter/groq which are openai-wire but different hosts) through it would
      // hit the wrong endpoint and the call would fail. Those are left to their real
      // upstreams (working calls, un-proxied — no synthesized events, but mail still
      // drains via the renderer nudge + the pty-quiescence idle fallback). For the
      // default god (openai-wire) and a local OpenAI-compatible endpoint this routes
      // through the proxy cleanly. Cross-provider Crush-via-proxy is on-device
      // live-verify (Dwight verify-crush MF1; the default god model is openai-wire to
      // match). Literal loopback (Dwight's b1 — no ${VAR} expansion edge cases);
      // Crush merges config so only base_url is rewritten.
      const wireProvider = api === 'anthropic' ? 'anthropic' : 'openai';
      const providers: Record<string, { base_url: string }> = { [wireProvider]: { base_url: loopbackUrl } };
      // Theme: Crush ships one (dark) palette and no light theme, but
      // `options.tui.transparent` stops it painting its own background, so it
      // sits on xterm's, which follows the app theme. Set whenever the app
      // passes a theme, dark included, so both modes look the same way.
      const options = theme ? { tui: { transparent: true } } : undefined;
      writeFileSync(config, JSON.stringify(options ? { providers, options } : { providers }, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installCrushConfig failed:', e); }
    return { config, data };
  }

  /** Grok lifecycle-hook bridge → live hive status, session capture, guarded
   *  inbox delivery, and operator gates for `grok` workers.
   *
   *  Grok supports the same hook events and decision vocabulary as Claude Code,
   *  but its stdin payload uses camelCase keys. A small adapter normalizes those
   *  keys to HookServer's Claude-shaped contract. The hook is installed in the
   *  user's global Grok hook directory because global hooks are trusted and
   *  Grok sessions/resume stay in the user's normal GROK_HOME. The adapter is
   *  strictly scoped by AGENT_ID, so ordinary Grok sessions exit without doing
   *  anything. Best-effort and idempotent. */
  private installGrokHooks(): void {
    const root = this.root();
    if (!root) return;
    try {
      const shim = join(root, 'bin', 'grok-hook.cjs');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(shim, GROK_HOOK_SHIM, 'utf8');
      const tool = (matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        // Let Grok apply its event-aware defaults (5s normally, 600s for Stop).
        // Grok is a HOOK bridge (not a proxy sidecar), so it is hit by the same
        // `node: command not found` 127 — bundled node here too.
        hooks: [{ type: 'command', command: this.nodeRun(shim) }]
      });
      const hooks = {
        PreToolUse: [tool('.*')],
        PostToolUse: [tool('.*')],
        Stop: [tool()],
        SubagentStop: [tool('.*')],
        SessionStart: [tool('.*')],
        UserPromptSubmit: [tool()],
        PreCompact: [tool('.*')],
        PostCompact: [tool('.*')]
      };
      const hookDir = join(this.userHome(), '.grok', 'hooks');
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(
        join(hookDir, 'munder-hive.json'),
        JSON.stringify({ hooks }, null, 2),
        'utf8'
      );
    } catch (e) { console.error('[hive] installGrokHooks failed:', e); }
  }

  /** Write the live fleet snapshot Michael reads (`fleet.json`, gitignored).
   *  Best-effort — called from a timer, must never throw. */
  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    try { writeFileSync(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8'); } catch { /* noop */ }
  }
  /** writeFleetSnapshot off the main thread, for the 8 s timer. */
  async writeFleetSnapshotAsync(snapshot: unknown): Promise<void> {
    const root = this.root();
    if (!root) return;
    try { await writeFileAsync(join(root, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8'); } catch { /* noop */ }
  }

  /** Is this agent the hive's god/orchestrator? */
  isGod(agentId: string): boolean {
    try {
      const reg = this.registry();
      return reg.godId === agentId || !!reg.agents[agentId]?.isGod;
    } catch { return false; }
  }

  /**
   * A compact, one-shot LIVE ROSTER line built from `fleet.json` — injected into
   * god's context as `additionalContext` on SessionStart and every
   * UserPromptSubmit (see HookServer).
   *
   * Why: fleet.json/registry.json are always fresh on disk (8s snapshot +
   * archiveOrphanedAgents on boot + PTY-exit archiving), but god's CONTEXT is not.
   * After an app restart god resumes a session whose transcript still describes
   * the OLD floor, and it will happily message agents that no longer exist. It is
   * told to read fleet.json, but "told to" is not "always knows" — so we push the
   * truth in on every turn instead. One line, so the cost is negligible.
   *
   * `ctxOf` (optional, supplied by HookServer) lets the caller layer the LIVE
   * context-window occupancy on top of the disk snapshot — each agent gets a
   * `ctx NN%` so god can see at a glance whose context is nearly full when it
   * routes work. fleet.json only carries cumulative `tokens`, which is a spend
   * figure, not how full the CURRENT window is; the real occupancy lives in
   * HookServer.contextById (from the statusLine shim). Omitted when the callback
   * is absent or an agent has no Status tick yet.
   *
   * Returns null when there is nothing to say (no hive, no snapshot, no agents),
   * so the hook stays a no-op rather than injecting noise.
   */
  rosterContext(
    ctxOf?: (agentId: string) => { tokens: number; limit: number } | undefined
  ): string | null {
    const root = this.root();
    if (!root) return null;
    try {
      const raw = readFileSync(join(root, 'fleet.json'), 'utf8');
      const snap = JSON.parse(raw) as {
        ts?: number;
        agents?: Array<{
          id: string; name?: string; role?: string; isGod?: boolean;
          breaker?: string; tokens?: number | null; usd?: number | null;
          lastTool?: string | null; lastActiveSecAgo?: number | null; inboxBacklog?: number;
          onHold?: boolean;
        }>;
      };
      const agents = Array.isArray(snap.agents) ? snap.agents : [];
      if (!agents.length) return null;

      const ago = (s: number | null | undefined): string =>
        typeof s !== 'number' ? 'unknown'
          : s < 90 ? `${s}s ago`
            : s < 5400 ? `${Math.round(s / 60)}m ago`
              : `${Math.round(s / 3600)}h ago`;

      // Cap the list so a big floor can't crowd out the actual prompt. The
      // remainder is still counted, and fleet.json is one Read away.
      const MAX = 24;
      const shown = agents.slice(0, MAX);
      let anyCtx = false;
      let anyHold = false;
      let anyTemp = false;
      // Temps are marked from the registry (fleet.json does not carry it), so
      // god can tell the help it hired from the permanent staff.
      const reg = this.registry();
      const rows = shown.map((a) => {
        const bits = [a.role ?? 'agent',
          typeof a.lastActiveSecAgo === 'number' ? `active ${ago(a.lastActiveSecAgo)}` : 'no activity yet'];
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1000)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        // null = its engine has reported no usage (yet), which is not "spent nothing".
        if (a.tokens === null && a.usd === null) bits.push('usage not reported');
        if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
        if (a.breaker && a.breaker !== 'ok' && a.breaker !== 'none') bits.push(`breaker ${a.breaker}`);
        if (a.isGod) bits.push('you');
        // First in the row after the role would be louder, but this reads in
        // the same scan as `breaker` and `inbox`, and god already treats those
        // as routing signals.
        if (a.onHold) { bits.push('ON HOLD — 1:1 with the human'); anyHold = true; }
        if (reg.agents[a.id]?.temp) { bits.push('temp'); anyTemp = true; }
        // Live context-window occupancy from the statusLine shim — lets god see
        // which agents are near-full when routing, instead of guessing from the
        // cumulative token count. Clamp to 0-100; a fresh meter can briefly
        // report more than 100% before a window rotation.
        const cw = ctxOf?.(a.id);
        if (cw && cw.limit > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((cw.tokens / cw.limit) * 100)));
          bits.push(`ctx ${pct}%`);
          anyCtx = true;
        }
        return `${a.id}${a.name ? ` "${a.name}"` : ''} (${bits.join(', ')})`;
      });
      const more = agents.length > shown.length ? ` +${agents.length - shown.length} more` : '';
      const age = typeof snap.ts === 'number' ? ago(Math.round((Date.now() - snap.ts) / 1000)) : 'unknown';

      return `[LIVE ROSTER — auto-injected from ${join(root, 'fleet.json')}, snapshot ${age}] `
        + `${agents.length} ACTIVE agent(s): ${rows.join('; ')}.${more} `
        + 'This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — '
        + 'agents you remember that are absent here have been archived or killed, so do not message them. '
        + (anyCtx
          ? '`ctx NN%` = live window occupancy; absent = not yet reported (unknown, not empty). '
          : '')
        + (anyHold
          ? 'An agent marked `ON HOLD — 1:1 with the human` is UNAVAILABLE: the human is working '
            + 'with them directly. Do NOT message them, do NOT dispatch to them, and do NOT count '
            + 'them when picking an owner. Route to someone else, or say the work is waiting. They '
            + 'are still running and their terminal is alive, so this is not a reason to archive '
            + 'them or spawn a replacement. The human flips it off when they are done. '
          : '')
        + (anyTemp
          ? 'A `temp` is a worker you started through spawn-requests: it is archived when it sends its done; '
            + `archive one whose job is over with ${join(root, 'archive-requests')}/<id>.json (see spawn.md). `
          : '')
        + 'Route work to someone on this list before spawning anyone new.';
    } catch { return null; }
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root) return [];
    const lines = tailLines(join(root, 'log.jsonl'), n);
    return lines.map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  /** An agent's inbox, read off the main thread (the renderer asks per agent). */
  async inboxAsync(id: string): Promise<HiveMessage[]> {
    const dir = join(this.agentDir(id), 'inbox');
    let files: string[];
    try { files = (await readdirAsync(dir)).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
    const read = await Promise.all(files.map((f) => readFileAsync(join(dir, f), 'utf8').then((t) => { try { return JSON.parse(t) as HiveMessage; } catch { return null; } }, () => null)));
    return read.filter((m): m is HiveMessage => m !== null);
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage; } catch { return null; } })
      .filter((m): m is HiveMessage => m !== null);
  }

  /**
   * Record an agent's process exit so a death has a durable cause.
   *
   * Before this, an agent killed by its provider crashing was archived with
   * `{kind:'archive', agentId, archived:true}` and NOTHING else — no exit code,
   * no signal, no output. A two-second SIGILL death and a completed agent were
   * indistinguishable in the only record the hive keeps, and the crash banner
   * lived solely in a UI terminal pane. Observed live 2026-08-24: Michael's
   * `claude` CLI panicked 923ms into startup and left no trace on disk.
   *
   * Split by design:
   *   - log.jsonl  gets structured, non-sensitive fields (code, signal, path).
   *   - crashes/   gets the raw tail, and is gitignored — see ensureHive.
   * A normal exit writes nothing at all; this is a diagnostic, not an audit log.
   * The tail file is written 0600 and the directory is capped at
   * MAX_CRASH_LOGS files, oldest dropped first.
   */
  recordAgentExit(
    agentId: string,
    info: { exitCode?: number; signal?: number; tail?: string; command?: string }
  ): void {
    const root = this.root();
    if (!root) return;
    const { exitCode, signal, tail, command } = info;
    // A signal means killed (SIGILL/SIGSEGV/SIGKILL); node-pty reports exitCode 0
    // in that case, so signal must be checked independently of the code.
    const abnormal = (typeof signal === 'number' && signal !== 0) || (typeof exitCode === 'number' && exitCode !== 0);
    if (!abnormal) return;

    let tailPath: string | null = null;
    if (tail && tail.length) {
      try {
        const dir = join(root, 'crashes');
        mkdirSync(dir, { recursive: true });
        // Colons are illegal in filenames on Windows and awkward everywhere.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safeId = agentId.replace(/[^A-Za-z0-9._-]/g, '_');
        const p = join(dir, `${stamp}-${safeId}.log`);
        const header = [
          `agent:    ${agentId}`,
          `exitCode: ${String(exitCode)}`,
          `signal:   ${String(signal)}`,
          command ? `command:  ${command}` : null,
          `captured: ${new Date().toISOString()}`,
          `--- last ${tail.length} bytes of pty output ---`,
          ''
        ].filter(Boolean).join('\n');
        // 0600 explicitly. writeFileSync otherwise takes the process umask, and
        // the usual 022 (or 002) yields a world-readable file holding exactly
        // what the comment above says to keep out of git: paths, prompt
        // fragments, and whatever a provider printed as it died. A packaged
        // Electron app does not inherit the launching shell's umask the way a
        // dev build does, so the mode observed locally is not the mode a user
        // gets -- passing it removes the question.
        writeFileSync(p, header + tail, { encoding: 'utf8', mode: 0o600 });
        tailPath = p;
        pruneCrashLogs(dir);
      } catch { /* a diagnostic must never break teardown */ }
    }

    this.appendLog({
      kind: 'agent-exit',
      agentId,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      abnormal: true,
      tailPath
    });
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    try { appendFileSync(join(root, 'log.jsonl'), line, 'utf8'); } catch { /* noop */ }
  }

  /**
   * Append one cost sample to the durable, append-only ledger at
   * `<root>/cost-ledger.jsonl` (Lane A #6.6d). This is the SOLE durable cost
   * store; its row is exactly the shape Kevin (#4) reserves for the cost_ledger
   * SQLite table, so migration is a mechanical INSERT…SELECT.
   *
   * 🔒 PII: persist ONLY the allowlisted AgentUsageSample — NEVER a raw OTel
   * record (those carry user.email / account / org / hashed-user-id). The sample
   * is PII-free by construction upstream (the provider's normalize step), so we
   * add no redaction here; we just must not widen what we write. The file lives
   * at the hive ROOT, so `mempalace mine` (which only scans per-agent dirs) never
   * ingests it — no palace noise, no MINE_IGNORE entry needed.
   *
   * Like appendLog: append to disk now (durable immediately), let it ride the
   * next natural commit. Best-effort — never throws into the beat.
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // Fully snake_case so the row maps 1:1 onto Kevin's (#4) cost_ledger SQLite
    // columns (agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd) — migration is a straight INSERT…SELECT.
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd
    };
    try { appendFileSync(join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n', 'utf8'); } catch { /* noop */ }
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private writeJson(p: string, data: unknown): void {
    if (p.endsWith('registry.json')) this.registryCache = null;
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }
  private atomicWriteJson(p: string, data: unknown): void {
    if (p.endsWith('registry.json')) this.registryCache = null;
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }

  // — git (single committer, retry + stale-lock recovery) —
  //
  // `gc.autoDetach=false` is what makes this call actually synchronous.
  //
  // A commit runs `gc --auto`, and git detaches that into a BACKGROUND process
  // by default. `spawnSync` returns when `git commit` exits, so the caller
  // believes the hive is quiescent while a gc it cannot see is still writing
  // into `.git/objects/`. Anything that touches the hive directory right after
  // a commit races that process: removing a hive home throws ENOTEMPTY, and a
  // read can catch a half-written pack.
  //
  // It reproduces on its own — create a HiveManager on a fresh temp home, call
  // ensureAgent, then remove the home: ~3.5% of iterations throw ENOTEMPTY,
  // and the leftover is always `.git/objects/`, sometimes still holding a
  // `bitmap-ref-tips_*` temp file that vanishes a fraction of a second later.
  // With this flag, gc runs inline and 200 iterations pass clean.
  //
  // The gc still happens — this only stops it from outliving the command that
  // triggered it, which is what "single committer" was supposed to mean.
  private git(args: string[], cwd: string): { ok: boolean; out: string; err: string } {
    // A WSL floor's hive is committed by git inside that distro (wsl.ts).
    // Agents can write inside the hive root, .git included: never run its hooks
    // or an fsmonitor command from there (that would be code run by the app).
    const inv = gitInvocation(cwd, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-c', 'commit.gpgsign=false', '-c', 'gc.autoDetach=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args]);
    const res = spawnSync(inv.file, inv.args, {
      cwd: inv.cwd, encoding: 'utf8', timeout: inv.distro ? 20000 : 8000, windowsHide: true
    });
    return { ok: res.status === 0, out: res.stdout ?? '', err: res.stderr ?? '' };
  }

  /** Has the one-time cost-ledger untrack pass run in this process yet? */
  private untrackedCostLedger = false;

  /**
   * Stop versioning the cost ledger.
   *
   * `cost-ledger.jsonl` is append-only and gains a row per usage sample, so a
   * repo that tracks it stores a fresh copy of the WHOLE file on every hive
   * commit — and the hive commits constantly. A quarter-gigabyte ledger with a
   * few thousand commits behind it is several hundred gigabytes of blob that
   * git has to walk, which is what turns a routine `gc` into a multi-gigabyte
   * `pack-objects` run. The ignore line in ensureHive keeps new copies out;
   * this drops the one already in the index, because git keeps recording a
   * file it is already tracking no matter what .gitignore says — so the ignore
   * line alone reads as a fix while the repo goes on growing. The ledger stays
   * on disk, so the cost history the app reads is untouched.
   */
  private untrackCostLedger(root: string): void {
    if (this.untrackedCostLedger) return;
    this.untrackedCostLedger = true;
    // Probe before mutating: `rm --cached` on a repo that never tracked it
    // would still rewrite the index on every launch, inside the retry path.
    const tracked = this.git(['ls-files', '--', 'cost-ledger.jsonl'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '--cached', '-q', '--ignore-unmatch', '--', 'cost-ledger.jsonl'], root);
    console.warn('[hive] untracked the cost ledger from the hive repo');
  }

  /** The two one-time untrack passes, with git off the main thread. They ran
   *  as sync git on the first commit after launch: on a slow disk or a WSL
   *  office that froze the app for ~2 s (a field log). */
  private async untrackOnceAsync(root: string): Promise<void> {
    if (!this.untrackedCostLedger) {
      this.untrackedCostLedger = true;
      const tracked = await this.gitAsync(['ls-files', '--', 'cost-ledger.jsonl'], root);
      if (tracked.ok && tracked.out.trim()) {
        await this.gitAsync(['rm', '--cached', '-q', '--ignore-unmatch', '--', 'cost-ledger.jsonl'], root);
        console.warn('[hive] untracked the cost ledger from the hive repo');
      }
    }
    if (!this.untrackedCodexHomes) {
      this.untrackedCodexHomes = true;
      const agentsDir = join(root, 'agents');
      if (!existsSync(agentsDir)) return;
      try {
        for (const id of await readdirAsync(agentsDir)) ensureMineIgnore(join(agentsDir, id));
      } catch { /* best-effort */ }
      const tracked = await this.gitAsync(['ls-files', '--', 'agents/*/.codex'], root);
      if (tracked.ok && tracked.out.trim()) {
        await this.gitAsync(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', 'agents/*/.codex'], root);
        console.warn('[hive] untracked previously-committed Codex homes from the hive repo');
      }
    }
  }

  /** Has the one-time Codex-home untrack pass run in this process yet? */
  private untrackedCodexHomes = false;

  /**
   * Stop versioning Codex worker homes that are ALREADY in the index.
   *
   * Adding `.codex/` to each agent's .gitignore only keeps NEW paths out; git
   * happily keeps recording a file it is already tracking, so a hive that
   * predates that ignore line goes on committing every SQLite and transcript
   * revision exactly as before — the .gitignore reads as a fix while the repo
   * keeps growing. This closes that: once per process, refresh every agent's
   * ignore file (agents that are not running never pass through spawn, and the
   * mine loop only reaches them if mempalace is installed) and drop any tracked
   * `.codex` path from the index. The files stay on disk, so `codex --resume`
   * is unaffected; only their history stops.
   */
  private untrackCodexHomes(root: string): void {
    if (this.untrackedCodexHomes) return;
    this.untrackedCodexHomes = true;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return;
    try {
      for (const id of readdirSync(agentsDir)) ensureMineIgnore(join(agentsDir, id));
    } catch { /* best-effort */ }
    // Probe before mutating: `rm --cached` on a clean repo would still rewrite
    // the index on every launch, and this runs inside the commit retry path.
    const tracked = this.git(['ls-files', '--', 'agents/*/.codex'], root);
    if (!tracked.ok || !tracked.out.trim()) return;
    this.git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', 'agents/*/.codex'], root);
    console.warn('[hive] untracked previously-committed Codex homes from the hive repo');
  }

  /** Deliverables an agent just wrote, waiting a few seconds for their own
   *  commit as that agent (commitDeliverables). The app's batched commit leaves
   *  them out: it used to sweep them in first, so their history said "App". */
  private heldDeliverables = new Map<string, number>();

  holdDeliverables(rels: string[]): void {
    const until = Date.now() + 60_000;
    for (const r of rels) this.heldDeliverables.set(r, until);
  }

  // — commits off the main thread —
  //
  // Every message, route, task change and registration committed the hive at
  // once with a synchronous `git add -A` + `git commit` on Electron's main
  // thread: ~180 ms on a small hive, seconds on a big one or across WSL, many
  // times a minute with a busy floor, the window frozen meanwhile. In the app
  // (setAsyncCommits) a commit is queued instead: changes arriving within
  // 1.5 s (5 s at most) become one commit, and git runs as an async child.
  // Tests and one-off tools keep the synchronous commit.
  private asyncCommits = false;
  private commitQueue: Array<{ kind: 'all'; message: string } | { kind: 'dlv'; rels: string[]; author: { id: string; name: string } }> = [];
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  private firstQueuedAt = 0;
  private flushing: Promise<void> | null = null;

  setAsyncCommits(on: boolean): void { this.asyncCommits = on; }

  private enqueueCommit(item: HiveManager['commitQueue'][number]): void {
    this.commitQueue.push(item);
    const now = Date.now();
    if (!this.firstQueuedAt) this.firstQueuedAt = now;
    if (this.commitTimer) clearTimeout(this.commitTimer);
    const wait = Math.max(0, Math.min(1500, this.firstQueuedAt + 5000 - now));
    this.commitTimer = setTimeout(() => { this.commitTimer = null; void this.flushCommits(); }, wait);
    this.commitTimer.unref?.();
  }

  /** Commit what is queued now (deliverables as their authors, then the rest
   *  as one commit). Resolves when it is in the history. */
  async flushCommits(): Promise<void> {
    while (this.flushing) await this.flushing;
    const items = this.commitQueue.splice(0);
    this.firstQueuedAt = 0;
    if (!items.length) return;
    this.flushing = (async () => {
      for (const d of items) if (d.kind === 'dlv') await this.commitDeliverablesAsync(d.rels, d.author);
      const msgs = items.filter((m): m is { kind: 'all'; message: string } => m.kind === 'all').map((m) => m.message);
      if (msgs.length) await this.commitAllAsync(msgs.length === 1 ? msgs[0] : `hive: ${msgs.length} changes: ${msgs.slice(0, 8).join('; ')}`.slice(0, 600));
    })().catch((e) => console.warn('[hive] queued commit failed:', e)).finally(() => { this.flushing = null; });
    await this.flushing;
  }

  /** At quit: what is still queued, committed before the process exits. */
  flushCommitsSync(): void {
    if (this.commitTimer) { clearTimeout(this.commitTimer); this.commitTimer = null; }
    const items = this.commitQueue.splice(0);
    this.firstQueuedAt = 0;
    for (const d of items) if (d.kind === 'dlv') this.commitDeliverablesSync(d.rels, d.author);
    const msgs = items.filter((m) => m.kind === 'all');
    if (msgs.length) this.commitSync(`hive: ${msgs.length} change(s) at quit`);
  }

  private gitAsync(args: string[], cwd: string): Promise<{ ok: boolean; out: string; err: string }> {
    const inv = gitInvocation(cwd, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '-c', 'commit.gpgsign=false', '-c', 'gc.autoDetach=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local', ...args]);
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; clearTimeout(t); resolve({ ok, out, err }); } };
      let child: ChildProcess;
      try { child = spawn(inv.file, inv.args, { cwd: inv.cwd, windowsHide: true }); } catch (e) { err = String(e); finish(false); return; }
      child.stdout?.on('data', (d) => { out += d; });
      child.stderr?.on('data', (d) => { err += d; });
      child.on('error', (e) => { err += String(e); finish(false); });
      child.on('close', (code) => finish(code === 0));
      const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } err += ' (timed out)'; finish(false); }, inv.distro ? 20000 : 8000);
    });
  }

  private async commitAllAsync(message: string): Promise<void> {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    await this.untrackOnceAsync(root);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = await this.gitAsync(['add', '-A'], root);
      const now = Date.now();
      for (const [r, until] of this.heldDeliverables) if (until < now) this.heldDeliverables.delete(r);
      if (this.heldDeliverables.size) await this.gitAsync(['reset', '-q', '--', ...this.heldDeliverables.keys()], root);
      const commit = await this.gitAsync(['commit', '-q', '-m', message], root);
      if (commit.ok || /nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) { await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); continue; }
      console.warn(`[hive] commit gave up after ${attempt + 1} attempts:`, commit.err || commit.out);
      return;
    }
  }

  private async commitDeliverablesAsync(rels: string[], author: { id: string; name: string }): Promise<void> {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git')) || !rels.length) return;
    const { who, msg } = deliverableCommitIdentity(rels, author);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = await this.gitAsync(['add', '-A', '--', ...rels], root);
      const commit = await this.gitAsync(['commit', '-q', `--author=${who}`, '-m', msg, '--', ...rels], root);
      if (commit.ok || /nothing (added )?to commit|no changes added/i.test(commit.out + commit.err)) {
        for (const r of rels) this.heldDeliverables.delete(r);
        return;
      }
      if (!add.ok || /index\.lock/i.test(commit.err)) { await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); continue; }
      console.warn('[hive] deliverable commit failed:', commit.err || commit.out);
      return;
    }
  }

  /** Commit all hive changes (queued in the app, at once elsewhere). */
  commit(message: string): void {
    if (this.asyncCommits) { this.enqueueCommit({ kind: 'all', message }); return; }
    this.commitSync(message);
  }

  /** Commit all hive changes now, on this thread. No-op if nothing is staged. */
  commitSync(message: string): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return;
    this.untrackCostLedger(root);
    this.untrackCodexHomes(root);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A'], root);
      // A held deliverable waits for its author's commit (expired holds lapse:
      // a lost timer must not keep a file out of the history for good).
      const now = Date.now();
      for (const [r, until] of this.heldDeliverables) if (until < now) this.heldDeliverables.delete(r);
      if (this.heldDeliverables.size) this.git(['reset', '-q', '--', ...this.heldDeliverables.keys()], root);
      const commit = this.git(['commit', '-q', '-m', message], root);
      if (commit.ok) return;
      if (/nothing to commit/i.test(commit.out + commit.err)) return;
      if (!add.ok || /index\.lock/i.test(commit.err)) { sleepSync(50 * (attempt + 1)); continue; }
      console.warn(`[hive] commit gave up after ${attempt + 1} attempts:`, commit.err || commit.out);
      return;
    }
    console.warn('[hive] commit gave up after 5 attempts');
  }

  /**
   * Commit some deliverables as the agent that wrote them, so the history of
   * research/ says who changed what (every other hive commit is authored
   * "Hive"). Only these paths: whatever else is pending waits for the next
   * ordinary commit. `rels` are relative to the hive root, with '/'.
   */
  commitDeliverables(rels: string[], author: { id: string; name: string }): void {
    if (this.asyncCommits) { if (rels.length) this.enqueueCommit({ kind: 'dlv', rels, author }); return; }
    this.commitDeliverablesSync(rels, author);
  }

  private commitDeliverablesSync(rels: string[], author: { id: string; name: string }): void {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git')) || !rels.length) return;
    const { who, msg } = deliverableCommitIdentity(rels, author);
    for (let attempt = 0; attempt < 5; attempt++) {
      this.clearStaleLock(root);
      const add = this.git(['add', '-A', '--', ...rels], root);
      const commit = this.git(['commit', '-q', `--author=${who}`, '-m', msg, '--', ...rels], root);
      if (commit.ok || /nothing (added )?to commit|no changes added/i.test(commit.out + commit.err)) {
        for (const r of rels) this.heldDeliverables.delete(r);
        return;
      }
      if (!add.ok || /index\.lock/i.test(commit.err)) { sleepSync(50 * (attempt + 1)); continue; }
      console.warn('[hive] deliverable commit failed:', commit.err || commit.out);
      return;
    }
  }

  /** Every committed version of one hive file, newest first: hash, time,
   *  author ("Hive" for the app's own batched commits) and message. */
  fileHistory(rel: string, limit = 100): Array<{ hash: string; ts: string; author: string; subject: string }> {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return [];
    const r = this.git(['log', `-n${Math.max(1, Math.min(500, limit))}`, '--follow', '--format=%H%x1f%aI%x1f%an%x1f%s', '--', rel], root);
    if (!r.ok) return [];
    return r.out.split('\n').filter(Boolean).map((l) => {
      const [hash, ts, author, subject] = l.split('\x1f');
      return { hash, ts, author, subject: subject ?? '' };
    }).filter((v) => /^[0-9a-f]{40}$/.test(v.hash));
  }

  /** What one commit changed in a hive file, as a unified diff (capped), or
   *  null. The first version of a file diffs against nothing. */
  fileDiff(rel: string, hash: string): string | null {
    const root = this.root();
    if (!root || !/^[0-9a-f]{7,40}$/.test(hash) || rel.includes('..')) return null;
    const r = this.git(['show', '--format=', '--no-color', '--no-ext-diff', '-U3', hash, '--', rel], root);
    return r.ok ? r.out.slice(0, 400_000) : null;
  }

  /** A hive file as it was in one commit (text, capped), or null. */
  fileAt(rel: string, hash: string): string | null {
    const root = this.root();
    if (!root || !/^[0-9a-f]{7,40}$/.test(hash) || rel.includes('..')) return null;
    const r = this.git(['show', `${hash}:${rel}`], root);
    return r.ok ? r.out.slice(0, 2_000_000) : null;
  }

  private authorsCache: { head: string; map: Record<string, { authors: string[]; last: string; lastTs: string }> } | null = null;
  /** Who has changed each file under `dir` (agents only, not the app's own
   *  "Hive" commits), most recent first, from one pass over the log; cached
   *  until HEAD moves. Keys are hive-relative paths with '/'. */
  private authorsRun: Promise<Record<string, { authors: string[]; last: string; lastTs: string }>> | null = null;

  /** fileAuthors with git off the main thread. Deliverables and Tasks ask every
   *  15 s; the sync version ran `git rev-parse` each time and `git log` when
   *  HEAD moved, 1-2 s each on a slow disk or a WSL office (a field log). */
  fileAuthorsAsync(dir: string): Promise<Record<string, { authors: string[]; last: string; lastTs: string }>> {
    if (this.authorsRun) return this.authorsRun;
    this.authorsRun = (async () => {
      const root = this.root();
      if (!root || !existsSync(join(root, '.git'))) return {};
      const head = await this.gitAsync(['rev-parse', 'HEAD'], root);
      if (!head.ok) return {};
      if (this.authorsCache?.head === head.out.trim()) return this.authorsCache.map;
      const r = await this.gitAsync(['log', '-n2000', '--no-merges', '--format=%x1e%an%x1f%aI', '--name-only', '--', dir], root);
      const map = r.ok ? parseFileAuthors(r.out) : {};
      this.authorsCache = { head: head.out.trim(), map };
      return map;
    })().finally(() => { this.authorsRun = null; });
    return this.authorsRun;
  }

  fileAuthors(dir: string): Record<string, { authors: string[]; last: string; lastTs: string }> {
    const root = this.root();
    if (!root || !existsSync(join(root, '.git'))) return {};
    const head = this.git(['rev-parse', 'HEAD'], root);
    if (!head.ok) return {};
    if (this.authorsCache?.head === head.out.trim()) return this.authorsCache.map;
    const r = this.git(['log', '-n2000', '--no-merges', '--format=%x1e%an%x1f%aI', '--name-only', '--', dir], root);
    const map = r.ok ? parseFileAuthors(r.out) : {};
    this.authorsCache = { head: head.out.trim(), map };
    return map;
  }

  private clearStaleLock(root: string): void {
    const STALE_THRESHOLD_MS = 10_000;
    try {
      for (const lock of ['index.lock', 'HEAD.lock']) {
        const path = join(root, '.git', lock);
        if (existsSync(path) && Date.now() - statSync(path).mtimeMs > STALE_THRESHOLD_MS) rmSync(path);
      }
    } catch { /* noop */ }
  }
}

// ─── Generated hive docs (written into the hive for every agent) ─────────────

/** The Claude Code command reference written to <hive>/COMMANDS.md, rendered from
 *  the SAME source as the UI "commands" tab so they never drift. Leads with the
 *  orchestrator note: slash = own session only, cli = shell/fleet; monitor
 *  siblings via fleet.json (claude agents does NOT see them). */
function renderCommandsMd(): string {
  const lines: string[] = [
    GENERATED_DOC_NOTICE,
    '',
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    '- **slash** commands act ONLY on your own session — you CANNOT run them on another agent\'s terminal.',
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    ''
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const COMMANDS_MD = renderCommandsMd();

// ─── md-api (written to <hive>/bin/md-api.cjs) ───────────────────────────────
// `md-api <integration> <METHOD> <path> [body]` → the loopback key broker.
// The agent's env carries the broker URL and its per-agent capability token (a
// handle, never the key); the broker checks the grant and adds the real
// credential upstream. Prints the status line, then the body.
const MD_API_CLI = `#!/usr/bin/env node
'use strict';
const [id, methodArg, pathArg, body] = process.argv.slice(2);
const base = process.env.MD_BROKER_URL, token = process.env.MD_BROKER_TOKEN;
if (!base || !token) {
  console.error('md-api: this agent was started without the app key broker (the app was still starting, or it is an old session). Ask the human to restart this agent.');
  process.exit(2);
}
${BROKER_CLIENT_JS}
const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
// No arguments: the APIs this agent may use right now, and how.
if (!id) {
  brokerRequest(base.replace(/\\/+$/, '') + '/i', { headers })
    .then(async (res) => {
      if (!res.ok) { console.error('md-api: the app answered HTTP ' + res.status + ' at ' + base + ' ' + (await res.text()).slice(0, 200)); process.exit(1); }
      const j = await res.json().catch(() => ({}));
      const apis = (j && j.apis) || [];
      if (!apis.length) console.log('No REST APIs are available to you right now (the human connects them in Connections; they work at once).');
      for (const a of apis) console.log(a.id + '  ' + a.label + (a.access === 'read' ? '  (read-only: GET and searches)' : ''));
      console.log('usage: md-api <api> <GET|POST|PUT|PATCH|DELETE> <path> [body: JSON, or a=1&b=2 as a form]');
      process.exit(0);
    })
    .catch((e) => { console.error(brokerError('md-api', e, base)); process.exit(1); });
} else {
  if (!methodArg) {
    console.error('usage: md-api <api> <GET|POST|PUT|PATCH|DELETE> <path> [body: JSON, or a=1&b=2 as a form]   (md-api alone lists your APIs)');
    process.exit(2);
  }
  const method = methodArg.toUpperCase();
  const path = (pathArg || '/').replace(/^\\/*/, '');
  const url = base.replace(/\\/+$/, '') + '/i/' + encodeURIComponent(id) + '/' + path;
  // JSON when it looks like JSON; otherwise a form body (Stripe takes only
  // application/x-www-form-urlencoded: key=value&key2=value2).
  if (body !== undefined) headers['Content-Type'] = /^\\s*[\\[{]/.test(body) ? 'application/json' : 'application/x-www-form-urlencoded';
  brokerRequest(url, { method, headers, body })
    .then(async (res) => {
      console.log('HTTP ' + res.status);
      const text = await res.text();
      if (text) console.log(text);
      process.exit(res.ok ? 0 : 1);
    })
    .catch((e) => { console.error(brokerError('md-api', e, base)); process.exit(1); });
}
`;

const MD_RUN_CLI = `#!/usr/bin/env node
'use strict';
// Ask the app to run a runner: a command the human defined, executed with
// secrets you never see; its output comes back with them masked.
//   md-run                      list runners and the secrets that exist (names only)
//   md-run <runner>             run one
//   md-run --propose <name> --secrets A,B [--why "<reason>"] -- <command…>
//                               ask the human to add a runner (they see the command)
const argv = process.argv.slice(2);
const base = process.env.MD_BROKER_URL, token = process.env.MD_BROKER_TOKEN;
if (!base || !token) { console.error('md-run: no runners are available to this agent.'); process.exit(2); }
${BROKER_CLIENT_JS}
const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' };
const root = base.replace(/\\/+$/, '') + '/run';
const fail = (e) => { console.error(brokerError('md-run', e, base)); process.exit(1); };
if (argv[0] === '--propose') {
  const sep = argv.indexOf('--');
  const opts = sep === -1 ? argv.slice(1) : argv.slice(1, sep);
  const command = sep === -1 ? '' : argv.slice(sep + 1).join(' ');
  const name = opts[0] && !opts[0].startsWith('--') ? opts[0] : '';
  const val = (flag) => { const i = opts.indexOf(flag); return i === -1 ? '' : (opts[i + 1] || ''); };
  if (!name || !command) {
    console.error('usage: md-run --propose <name> --secrets A,B [--why "<reason>"] -- <command…>');
    process.exit(2);
  }
  const secrets = val('--secrets').split(',').map((x) => x.trim()).filter(Boolean);
  console.log('Waiting for the human to approve runner "' + name + '"…');
  brokerRequest(root, { method: 'POST', headers, body: JSON.stringify({ name, command, secrets, description: val('--why') }) })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!body.ok) { console.error('md-run: ' + (body.error || ('HTTP ' + res.status))); process.exit(1); }
      console.log('Added runner ' + body.id + '. Run it with: md-run ' + body.id);
    })
    .catch(fail);
} else {
  const id = argv[0];
  brokerRequest(root + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'POST' : 'GET', headers })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!id) {
        if (!(body.runners || []).length) console.log('No runners are set up for you yet (the human adds them in Environment, or you propose one below; they work at once).');
        for (const r of body.runners || []) console.log(r.id + (r.description ? '  — ' + r.description : '') + (r.secrets && r.secrets.length ? '  [uses ' + r.secrets.join(', ') + ']' : ''));
        console.log('');
        console.log('Secrets stored (names only, never values): ' + ((body.secrets || []).join(', ') || 'none yet'));
        console.log('Need a command with one of them? md-run --propose <name> --secrets NAME[,NAME] --why "<reason>" -- <command>');
        process.exit(0);
      }
      if (!body.ok) { console.error('md-run: ' + (body.error || ('HTTP ' + res.status))); process.exit(1); }
      if (body.output) process.stdout.write(body.output.endsWith('\\n') ? body.output : body.output + '\\n');
      console.log('[exit ' + body.exitCode + ']');
      process.exit(body.exitCode === 0 ? 0 : 1);
    })
    .catch(fail);
}
`;

const GENERATED_HIVE_DOCS = [
  ...protocolFiles(),
  { filename: 'COMMANDS.md', contents: COMMANDS_MD }
];

// ─── cth-hook shim (written to <hive>/bin/cth-hook.cjs) ──────────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the hive's UDS, and relay the response back to `claude`. All the
// real logic lives in the main process (HookServer). Never blocks a stop on error.
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  // The office agent is the one this process belongs to (AGENT_ID). Claude Code
  // sends its OWN agent_id on calls made inside a subagent: that goes in
  // subagent_id, never in agent_id, or the office would look up the limits
  // (folders, git) of an agent it does not know, and check nothing.
  var hiveAgent = process.env.AGENT_ID || null;
  if (payload.agent_id && hiveAgent && payload.agent_id !== hiveAgent) payload.subagent_id = payload.agent_id;
  payload.agent_id = hiveAgent || payload.agent_id || null;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line mode: Claude Code pipes the session status JSON (incl.
    // context_window.total_input_tokens / .context_window_size) after every
    // response. Print the in-terminal gauge IMMEDIATELY (the TUI is waiting),
    // then forward the payload to the harness fire-and-forget so the agent
    // card's context gauge updates push-based, with the EXACT window size.
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write('ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)');
    }
    // The subscription's 5-hour window, when Claude reports it.
    const fh = payload.rate_limits && payload.rate_limits.five_hour;
    if (fh && typeof fh.used_percentage === 'number') process.stdout.write(' · 5h ' + Math.round(fh.used_percentage) + '%');
    if (sock) {
      try {
        const c = net.createConnection((String(sock).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(sock).slice(String(sock).lastIndexOf(':') + 1)) } : sock), () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection((String(sock).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(sock).slice(String(sock).lastIndexOf(':') + 1)) } : sock), () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
`;

// ─── agy-hook shim (written to <hive>/bin/agy-hook.cjs) ──────────────────────
// Antigravity's `agy` CLI fires lifecycle hooks (PreToolUse/PostToolUse/Stop/
// PreInvocation/PostInvocation) but with a DIFFERENT stdin shape than Claude
// (conversationId / toolCall{name,args} / workspacePaths, and no hook_event_name
// — the event arrives as argv from the hooks.json command). This shim normalizes
// that into the same HookPayload the HookServer already consumes, so status,
// inbox-drain-on-Stop, and tool gating are reused UNCHANGED, then translates the
// server's Claude-shaped response back into agy's stdout contract (decision:
// allow|deny|block + a message). Scoped by AGENT_ID: a personal agy session
// (no AGENT_ID in env) is a no-op, so the global hooks.json never disturbs the
// user's own agy usage — only hive workers (spawned with AGENT_ID set) bridge.
// NOTE (agy bug, antigravity-cli#49): the loader reads ~/.gemini/antigravity-cli/
// hooks.json but the trigger reads ~/.gemini/config/hooks.json — we write BOTH.
const AGY_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const event = process.argv[2] || 'Unknown';
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); } // not a hive worker → ignore
  let agy = {};
  try { agy = JSON.parse(data || '{}'); } catch (_) {}
  const tc = agy.toolCall || {};
  const payload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: agy.conversationId,
    transcript_path: agy.transcriptPath,
    cwd: Array.isArray(agy.workspacePaths) ? agy.workspacePaths[0] : undefined,
    tool_name: tc.name,
    tool_input: tc.args
  };
  let resp = '';
  const done = () => {
    // Translate the HookServer's Claude-shaped reply into agy's contract. CRITICAL:
    // agy treats ANY object written to stdout as a decision and FAIL-CLOSES (an
    // empty/decision-less object = DENY). So emit JSON ONLY when there's a real
    // directive (deny/block/steer); otherwise write NOTHING — no output = allow.
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.decision === 'block') out = { decision: 'block', reason: r.reason, stopReason: r.reason, systemMessage: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      else if (r.continue === false) out = { decision: 'block', stopReason: r.stopReason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { systemMessage: r.hookSpecificOutput.additionalContext };
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection((String(sock).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(sock).slice(String(sock).lastIndexOf(':') + 1)) } : sock), () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── pi bridge extension (written to <agentDir>/.pi-agent/extensions/) ───────
// A bundled extension for Pi (earendil-works). Pi exposes a pi.on(event,…)
// lifecycle; this posts cth-hook-shaped payloads to HIVE_SOCK on tool_call /
// tool_result / agent_end and AUTO-APPROVES tool calls when the floor is in auto
// mode (HIVE_AUTO_APPROVE, gated by config.autoMode — Pam guardrail #5). The
// agent_end→Stop keeps the harness status in step (→ idle) so the renderer idle
// inbox-wake nudge can deliver mail. Fully wrapped so a wrong API guess can never
// break the spawn. Verified live on Pi 1.0.4: session_start gives the id through
// ctx.sessionManager.getSessionId(), message_end carries per-response usage.
/** Git follows the Git capability (Capabilities -> Who has what): the same
 *  rule that decides whether the agent gets the Git server. */
export function gitAllowed(cfg?: { [id: string]: { enabled: boolean } }, grant?: string[]): boolean {
  if (grant) return cleanServerList(grant).includes('git');
  return cfg?.git?.enabled ?? MCP_CATALOG.find((e) => e.id === 'git')?.defaultEnabled ?? true;
}

/** One prompt line for what the guard enforces, so the agent does not learn
 *  it by being refused. Nothing when it may do everything. */
export function fenceLine(g: GuardPolicy | undefined): string {
  if (!g) return '';
  const parts: string[] = [];
  if (g.contained) parts.push(`write only inside your folders (${g.cwd}, your hive folder, the hive, the temp dir): writes, moves and deletes elsewhere are refused; reading is fine`);
  if (!g.git) parts.push('git is switched off for you: do not run git; ask the orchestrator if something needs it');
  return parts.length ? `LIMITS: ${parts.join('. ')}.` : '';
}

const PI_EXTENSION = `'use strict';
var net = require('node:net');
var SOCK = process.env.HIVE_SOCK;
var AGENT = process.env.AGENT_ID || null;
var AUTO = process.env.HIVE_AUTO_APPROVE === '1';
// Pi's session id, from session_start: on every payload, so the office can
// resume this session (--session <id>) and key its cost rows.
var SID = null;
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    if (SID && !payload.session_id) payload.session_id = SID;
    var c = net.createConnection((String(SOCK).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(SOCK).slice(String(SOCK).lastIndexOf(':') + 1)) } : SOCK), function () { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', function () {});
  } catch (e) {}
}
// PreToolUse waits for the answer: the office may refuse a call (git off, a
// write outside the agent's folders). No answer in 3 s: the call goes ahead.
function ask(payload) {
  return new Promise(function (resolve) {
    var done = false, resp = '';
    function finish(v) { if (!done) { done = true; resolve(v); } }
    try {
      if (!SOCK) return finish(null);
      payload.agent_id = payload.agent_id || AGENT;
      if (SID && !payload.session_id) payload.session_id = SID;
      var c = net.createConnection((String(SOCK).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(SOCK).slice(String(SOCK).lastIndexOf(':') + 1)) } : SOCK), function () { try { c.write(JSON.stringify(payload) + '\\n'); } catch (e) {} });
      c.setEncoding('utf8');
      c.on('data', function (d) { resp += d; });
      c.on('end', function () {
        try { var r = JSON.parse(resp || '{}'); var h = r.hookSpecificOutput; finish(h && h.permissionDecision === 'deny' ? (h.permissionDecisionReason || 'Refused by the office.') : null); } catch (e) { finish(null); }
      });
      c.on('error', function () { finish(null); });
      setTimeout(function () { try { c.destroy(); } catch (e) {} finish(null); }, 3000);
    } catch (e) { finish(null); }
  });
}
function firstDefined(primary, fallback) {
  return primary !== undefined && primary !== null ? primary : fallback;
}
function piField(ev, key) {
  try { return ev == null ? undefined : ev[key]; } catch (e) { return undefined; }
}
function piToolName(ev) {
  var tool = piField(ev, 'tool');
  return firstDefined(piField(ev, 'toolName'), firstDefined(piField(ev, 'name'), piField(tool, 'name')));
}
function piToolInput(ev) {
  return firstDefined(piField(ev, 'input'), piField(ev, 'args'));
}
function piToolPayload(hookEventName, ev) {
  return {
    hook_event_name: hookEventName,
    tool_name: piToolName(ev),
    tool_input: piToolInput(ev)
  };
}
function register(pi) {
  if (!pi || typeof pi.on !== 'function') return false;
  try {
    pi.on('tool_call', async function (ev) {
      var refused = await ask(piToolPayload('PreToolUse', ev));
      if (refused) return { block: true, reason: refused };
      if (AUTO) { try { if (ev && typeof ev.approve === 'function') ev.approve(); } catch (e) {} return { approve: true }; }
      return undefined;
    });
    pi.on('tool_result', function (ev) { post(piToolPayload('PostToolUse', ev)); });
    pi.on('agent_end', function () { post({ hook_event_name: 'Stop' }); });
    pi.on('session_start', function (ev, ctx) {
      try { SID = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === 'function' ? ctx.sessionManager.getSessionId() : SID; } catch (e) {}
      if (SID) post({ hook_event_name: 'SessionStart', source: ev && ev.reason });
    });
    // One cost row per model response, in the shape the hook server already
    // records for the proxy bridge (CostSample).
    pi.on('message_end', function (ev) {
      var m = ev && ev.message;
      var u = m && m.role === 'assistant' ? m.usage : null;
      if (!u || !SID) return;
      post({
        hook_event_name: 'CostSample',
        model: m.provider && m.model ? m.provider + '/' + m.model : (m.model || ''),
        input: u.input || 0, output: u.output || 0, cache_read: u.cacheRead || 0, cache_creation: u.cacheWrite || 0,
        // Pi prices its own responses (0 for a local model with no price set).
        usd: u.cost && typeof u.cost.total === 'number' ? u.cost.total : undefined
      });
    });
    return true;
  } catch (e) { return false; }
}
try { if (typeof globalThis !== 'undefined' && globalThis.pi) register(globalThis.pi); } catch (e) {}
module.exports = function (pi) { return register(pi); };
module.exports.activate = function (pi) { return register(pi); };
module.exports.default = module.exports;
`;

// ─── opencode bridge plugin (written to <agentDir>/.opencode/plugin/) ────────
// A bundled plugin for OpenCode (anomalyco/opencode) — god Decision 1. OpenCode
// has no Claude-shaped Stop hook but its plugin API exposes a real session.idle
// event; this posts cth-hook-shaped payloads to HIVE_SOCK on tool.execute.before/
// after + session.idle. The session.idle→Stop keeps status in step (→ idle) so the
// renderer idle inbox-wake nudge delivers mail. ESM (OpenCode runs on Bun). Fully
// wrapped. LIVE-UNVERIFIED (plugin auto-load + session.idle firing need BYOK keys).
const OPENCODE_PLUGIN = `import { createConnection } from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID || null;
// The session this agent runs in (session.created), on every payload: the
// office records it to resume the agent and to key its cost rows.
let SID = null;
let MODEL = '';
const seenSteps = new Set();
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    if (SID && !payload.session_id) payload.session_id = SID;
    const c = createConnection((String(SOCK).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(SOCK).slice(String(SOCK).lastIndexOf(':') + 1)) } : SOCK), () => { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', () => {});
  } catch (e) {}
}
// PreToolUse waits for the answer: the office may refuse a call (git off, a
// write outside the agent's folders). No answer in 3 s: the call goes ahead.
function ask(payload) {
  return new Promise((resolve) => {
    let done = false;
    let resp = '';
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      if (!SOCK) return finish(null);
      payload.agent_id = payload.agent_id || AGENT;
      if (SID && !payload.session_id) payload.session_id = SID;
      const c = createConnection((String(SOCK).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(SOCK).slice(String(SOCK).lastIndexOf(':') + 1)) } : SOCK), () => { try { c.write(JSON.stringify(payload) + '\\n'); } catch (e) {} });
      c.setEncoding('utf8');
      c.on('data', (d) => { resp += d; });
      c.on('end', () => {
        try { const h = JSON.parse(resp || '{}').hookSpecificOutput; finish(h && h.permissionDecision === 'deny' ? (h.permissionDecisionReason || 'Refused by the office.') : null); } catch (e) { finish(null); }
      });
      c.on('error', () => finish(null));
      setTimeout(() => { try { c.destroy(); } catch (e) {} finish(null); }, 3000);
    } catch (e) { finish(null); }
  });
}
export const HiveBridge = async () => {
  // The app writes this file to plugin/ and plugins/ (older and newer OpenCode
  // read one or the other); OpenCode 1.18 loads both, which sent every event
  // twice. The second copy registers nothing.
  if (globalThis.__mdHiveBridge) return {};
  globalThis.__mdHiveBridge = true;
  return {
    event: async (input) => {
      try {
        const e = input && input.event;
        const p = (e && e.properties) || {};
        if (!e) return;
        if (e.type === 'session.created' && p.info && !p.info.parentID && !SID) {
          SID = p.info.id;
          post({ hook_event_name: 'SessionStart' });
        } else if (e.type === 'message.updated' && p.info && p.info.role === 'assistant' && p.info.modelID) {
          MODEL = (p.info.providerID ? p.info.providerID + '/' : '') + p.info.modelID;
        } else if (e.type === 'message.part.updated' && p.part && p.part.type === 'step-finish' && !seenSteps.has(p.part.id)) {
          // One row per model step, with OpenCode's own price (0 for a local model).
          seenSteps.add(p.part.id);
          const k = p.part.tokens || {};
          const cache = k.cache || {};
          post({ hook_event_name: 'CostSample', model: MODEL, input: k.input || 0, output: k.output || 0, cache_read: cache.read || 0, cache_creation: cache.write || 0, usd: typeof p.part.cost === 'number' ? p.part.cost : undefined });
        } else if (e.type === 'session.idle' && (!SID || p.sessionID === SID)) {
          post({ hook_event_name: 'Stop' });
        }
      } catch (err) {}
    },
    // The arguments (output.args) too: which file a write touches, which command
    // ran — the steps timeline and Deliverables read them, as for every other CLI.
    // Throwing is how a plugin refuses a tool call in OpenCode.
    'tool.execute.before': async (input, output) => {
      let refused = null;
      try { refused = await ask({ hook_event_name: 'PreToolUse', tool_name: input && (input.tool || input.name), tool_input: output && output.args }); } catch (e) {}
      if (refused) throw new Error(refused);
    },
    'tool.execute.after': async (input) => {
      try { post({ hook_event_name: 'PostToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    }
  };
};
export default HiveBridge;
`;

// ─── proxy-bridge sidecar (written to <hive>/bin/hive-proxy.cjs) ─────────────
// One per proxy-tier agent (qwen). A dependency-free, loopback-only reverse
// proxy: the agent's CLI is pointed at this (via ANTHROPIC_BASE_URL/OPENAI_BASE_URL),
// and it forwards every request to the user's real upstream UNCHANGED (headers,
// body, streaming). It TEES each response to synthesize the same HIVE_SOCK payloads
// the hook shims emit — Status (context gauge), PostToolUse (breaker), Stop (idle
// drain), and the new CostSample (cost ledger) — so a hookless CLI becomes a hive
// citizen. NEVER logs bodies or keys; the captured body is parsed in-memory and
// dropped. Idle is heuristic: a turn that ends with no tool call and no new request
// within an ~800ms debounce → Stop (a new request cancels it).
const PROXY_BRIDGE_SHIM = `#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const SOCK = process.env.HIVE_SOCK;
const AGENT_ID = process.env.AGENT_ID || null;
const UPSTREAM = process.env.UPSTREAM_BASE_URL || '';
const SESSION = process.env.HIVE_PROXY_SESSION || null;
const API = process.env.HIVE_PROXY_API === 'anthropic' ? 'anthropic' : 'openai';
// TLS to the upstream (Settings → AI Engines → Certificates): the app's CA
// bundle (Node's roots + the user's CA / Windows / WSL stores), and verification
// off only when the user turned it off.
let UPSTREAM_CA;
try { if (process.env.UPSTREAM_CA_FILE) UPSTREAM_CA = require('fs').readFileSync(process.env.UPSTREAM_CA_FILE); } catch (e) {}
const UPSTREAM_INSECURE = process.env.UPSTREAM_INSECURE === '1';

function trimSlash(s) { while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s; }

// Per-model context-window size for the Status gauge; fallback 200k.
function ctxSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('[1m]') !== -1 || m.indexOf('-1m') !== -1) return 1000000;
  if (m.indexOf('claude') !== -1) return 200000;
  if (m.indexOf('gpt-4o') !== -1 || m.indexOf('gpt-4.1') !== -1 || m.indexOf('o1') !== -1 || m.indexOf('o3') !== -1) return 128000;
  if (m.indexOf('qwen') !== -1) return 262144;
  return 200000;
}

// Fire-and-forget emit of a shim-shaped payload to the hive socket. Never throws.
function emit(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection((String(SOCK).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(SOCK).slice(String(SOCK).lastIndexOf(':') + 1)) } : SOCK), function () { c.end(JSON.stringify(payload) + '\\n'); });
    c.on('error', function () {});
  } catch (e) {}
}

let stopTimer = null;
function armStop() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(function () {
    stopTimer = null;
    emit({ hook_event_name: 'Stop', agent_id: AGENT_ID, session_id: SESSION });
  }, 800);
  if (stopTimer.unref) stopTimer.unref();
}
function cancelStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }

function safeArgs(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return { _raw: String(s).slice(0, 500) }; }
}

// Parse a completed response (single JSON or an SSE stream) and synthesize events.
function parseAndEmit(bodyStr, isSse) {
  const objs = [];
  if (isSse) {
    const lines = bodyStr.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const idx = ln.indexOf('data:');
      if (idx === -1) continue;
      const data = ln.slice(idx + 5).trim();
      if (!data || data === '[DONE]') continue;
      try { objs.push(JSON.parse(data)); } catch (e) {}
    }
  } else {
    try { objs.push(JSON.parse(bodyStr)); } catch (e) {}
  }
  if (!objs.length) { armStop(); return; }

  let model = null, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sawUsage = false;
  const toolCalls = [];
  const oaiTools = {}; // accumulate streaming openai tool_calls by index

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o || typeof o !== 'object') continue;
    if (o.model) model = o.model;
    if (API === 'anthropic') {
      if (o.type === 'message_start' && o.message) {
        if (o.message.model) model = o.message.model;
        const u = o.message.usage || {};
        input += u.input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'message_delta' && o.usage) {
        output += o.usage.output_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
        toolCalls.push({ name: o.content_block.name, input: o.content_block.input || {} });
      } else if (o.usage && !o.type) {
        // non-streaming full message body
        const u = o.usage;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      }
      if (Array.isArray(o.content)) {
        for (let j = 0; j < o.content.length; j++) {
          const blk = o.content[j];
          if (blk && blk.type === 'tool_use') toolCalls.push({ name: blk.name, input: blk.input || {} });
        }
      }
    } else {
      if (o.usage) {
        const u = o.usage;
        input += u.prompt_tokens || 0;
        output += u.completion_tokens || 0;
        if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) cacheRead += u.prompt_tokens_details.cached_tokens;
        sawUsage = true;
      }
      const choices = o.choices || [];
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c];
        if (!ch) continue;
        if (ch.message && Array.isArray(ch.message.tool_calls)) {
          for (let t = 0; t < ch.message.tool_calls.length; t++) {
            const tc = ch.message.tool_calls[t];
            if (tc && tc.function) toolCalls.push({ name: tc.function.name, input: safeArgs(tc.function.arguments) });
          }
        }
        if (ch.delta && Array.isArray(ch.delta.tool_calls)) {
          for (let t = 0; t < ch.delta.tool_calls.length; t++) {
            const tc = ch.delta.tool_calls[t];
            if (!tc) continue;
            const k = (tc.index != null ? tc.index : t);
            if (!oaiTools[k]) oaiTools[k] = { name: null, args: '' };
            if (tc.function) {
              if (tc.function.name) oaiTools[k].name = tc.function.name;
              if (tc.function.arguments) oaiTools[k].args += tc.function.arguments;
            }
          }
        }
      }
    }
  }
  const keys = Object.keys(oaiTools);
  for (let i = 0; i < keys.length; i++) {
    const t = oaiTools[keys[i]];
    if (t.name) toolCalls.push({ name: t.name, input: safeArgs(t.args) });
  }

  if (sawUsage) {
    emit({ hook_event_name: 'Status', agent_id: AGENT_ID, context_window: { total_input_tokens: input + cacheRead + cacheCreation, context_window_size: ctxSize(model) } });
    emit({ hook_event_name: 'CostSample', agent_id: AGENT_ID, session_id: SESSION, model: model, input: input, output: output, cache_read: cacheRead, cache_creation: cacheCreation });
  }
  if (toolCalls.length) {
    cancelStop(); // a tool call means the turn continues
    for (let i = 0; i < toolCalls.length; i++) {
      emit({ hook_event_name: 'PostToolUse', agent_id: AGENT_ID, session_id: SESSION, tool_name: toolCalls[i].name, tool_input: toolCalls[i].input });
    }
  } else {
    armStop();
  }
}

let upstreamUrl = null;
try { upstreamUrl = new URL(UPSTREAM); } catch (e) {}

const server = http.createServer(function (req, res) {
  cancelStop(); // a new request means the turn is still going
  if (!upstreamUrl) { res.statusCode = 502; res.end('proxy: no upstream'); return; }
  let target;
  try { target = new URL(trimSlash(UPSTREAM) + req.url); } catch (e) { res.statusCode = 502; res.end('proxy: bad url'); return; }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  // Ask upstream for plaintext so the tee can parse SSE/JSON reliably; the client
  // gets uncompressed bytes (loopback — negligible) and no content-encoding to undo.
  delete headers['accept-encoding'];
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers
  };
  if (isHttps) {
    if (UPSTREAM_CA) opts.ca = UPSTREAM_CA;
    if (UPSTREAM_INSECURE) opts.rejectUnauthorized = false;
  }
  const upReq = lib.request(opts, function (upRes) {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    const ct = String((upRes.headers['content-type'] || ''));
    const wantParse = ct.indexOf('json') !== -1 || ct.indexOf('event-stream') !== -1;
    const isSse = ct.indexOf('event-stream') !== -1;
    const chunks = [];
    let total = 0;
    upRes.on('data', function (chunk) {
      res.write(chunk); // stream straight through to the CLI
      if (wantParse && total < 4194304) { chunks.push(chunk); total += chunk.length; }
    });
    upRes.on('end', function () {
      res.end();
      if (wantParse && chunks.length) {
        try { parseAndEmit(Buffer.concat(chunks).toString('utf8'), isSse); } catch (e) {}
      }
    });
    upRes.on('error', function () { try { res.end(); } catch (e) {} });
  });
  upReq.on('error', function () { try { res.statusCode = 502; res.end('proxy: upstream error'); } catch (e) {} });
  req.pipe(upReq);
});

server.on('error', function () {
  try { process.stdout.write(JSON.stringify({ port: 0 }) + '\\n'); } catch (e) {}
  process.exit(0);
});
server.listen(0, '127.0.0.1', function () {
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  try { process.stdout.write(JSON.stringify({ port: port }) + '\\n'); } catch (e) {}
});
`;

// Official Gemini CLI bridge. Gemini already sends snake_case payload fields;
// normalize its event names, then translate HookServer decisions back into
// Gemini's documented hook output contract.
const GEMINI_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let gemini = {};
  try { gemini = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    SessionStart: 'SessionStart',
    BeforeAgent: 'UserPromptSubmit',
    BeforeTool: 'PreToolUse',
    AfterTool: 'PostToolUse',
    AfterAgent: 'Stop'
  };
  const payload = {
    ...gemini,
    hook_event_name: names[gemini.hook_event_name] || gemini.hook_event_name || 'Unknown',
    agent_id: agentId
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'deny', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = { hookSpecificOutput: { additionalContext: r.hookSpecificOutput.additionalContext } };
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection((String(sock).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(sock).slice(String(sock).lastIndexOf(':') + 1)) } : sock), () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── grok-hook shim (written to <hive>/bin/grok-hook.cjs) ───────────────────
// Grok's lifecycle events and decisions are Claude-compatible, but the wire
// payload is camelCase and uses snake_case event values. Normalize the input for
// HookServer and translate its Claude-style permission denial into Grok's direct
// decision form. Scoped by AGENT_ID so the trusted global hook is inert outside
// Munder-spawned workers.
const GROK_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let grok = {};
  try { grok = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    permission_denied: 'PermissionDenied',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    notification: 'Notification',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact'
  };
  const payload = {
    hook_event_name: names[grok.hookEventName] || grok.hookEventName || 'Unknown',
    agent_id: agentId,
    session_id: grok.sessionId,
    cwd: grok.cwd || grok.workspaceRoot,
    tool_name: grok.toolName,
    tool_input: grok.toolInput,
    stop_hook_active: grok.stopHookActive,
    prompt: grok.prompt,
    source: grok.source,
    notification_type: grok.notificationType,
    message: grok.message
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'block', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = r;
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection((String(sock).startsWith('tcp://') ? { host: '127.0.0.1', port: Number(String(sock).slice(String(sock).lastIndexOf(':') + 1)) } : sock), () => c.write(JSON.stringify(payload) + '\\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;
