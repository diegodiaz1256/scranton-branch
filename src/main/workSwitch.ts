/**
 * Clear on a switch of work (shared/workSwitch.ts has the pure half).
 *
 * When the task ledger shows an agent moving to a different card, and its
 * session has run at least the rule's minimum, three things happen in order:
 *
 *   1. HANDOFF. The agent is asked (through the message queue, so the request
 *      waits for an idle prompt and never lands on a human's draft) to write
 *      agents/<id>/handoff.md. An engine that cannot be asked (no hooks, so the
 *      app cannot tell a turn from a prompt) gets one written by the app from
 *      the board, the task's history and the end of its terminal, and so does
 *      an agent that has not written its own within HANDOFF_WAIT_MS.
 *   2. CLEAR. Once the note exists and nothing of the agent's is in flight (a
 *      custodian's message waiting for the human's sign-off, an outbox file the
 *      router has not taken yet), the provider's own clear verb is queued — the
 *      same command the context trigger's clear rule types.
 *   3. RESUME. Right behind it, the first message of the new session: read the
 *      note (and, for engines whose hive instructions were their first prompt,
 *      those instructions again), then the inbox. Mail is never touched — it is
 *      files on disk — and anything the agent filed while switching is named,
 *      since its work order may be among it.
 *
 * No electron import: everything it needs is passed in, so it is unit-tested
 * with fakes (test/work-switch.test.cjs).
 */
import {
  fallbackHandoff,
  handoffPrompt,
  resumePrompt,
  sessionOldEnough,
  type WorkSwitch
} from '../shared/workSwitch';
import type { TaskSnapshot } from '../shared/taskHistory';
import type { WorkSwitchRule } from '../shared/triggers';

/** How long the agent has to write its own note before the app writes one. */
export const HANDOFF_WAIT_MS = 30 * 60_000;
/** How long a clear may wait on in-flight work (a sign-off, an unsent outbox
 *  file) before this switch is given up on. The next switch tries again. */
export const CLEAR_DEFER_MAX_MS = 2 * 3_600_000;
/** File-time slack: a note written in the same second as the request still counts. */
const MTIME_SLACK_MS = 2000;

export interface WorkSwitchAgent {
  name: string;
  isGod?: boolean;
  isAssistant?: boolean;
  /** Its engine reports turns through hooks, so it can be asked to write the note. */
  canWriteHandoff: boolean;
  /** The command that clears its context, or null when nothing typed can. */
  clearCommand: string | null;
}

export interface WorkSwitchDeps {
  now(): number;
  rule(): WorkSwitchRule;
  /** The live agent, or null when it has no terminal. */
  agent(id: string): WorkSwitchAgent | null;
  /** handoff.md as the app opens it, and as the agent names it. */
  handoffPath(id: string): { host: string; agent: string };
  inboxPath(id: string): string;
  /** The agent's standing instructions file, for engines that lose them on a clear. */
  standingPath(id: string): string | undefined;
  fileMtime(hostPath: string): number | null;
  writeFile(hostPath: string, text: string): void;
  /** Why the agent may not be cleared right now ('sign-off', 'outbox'…), or null. */
  busyReason(id: string): string | null;
  task(taskId: string): TaskSnapshot | undefined;
  taskHistory(taskId: string): string[];
  terminalTail(id: string): string;
  /** Mail the agent filed since `since`, as it names the files. */
  recentlyFiled(id: string, since: number): string[];
  enqueue(id: string, text: string): void;
  withdraw(id: string, text: string): void;
  /** Hold (true) or let go (false) the app's inbox nudges for this agent: while
   *  it is asked for its note, a nudge would start the new work in the session
   *  about to be cleared, and the resume sends it to the inbox anyway. */
  holdNudges(id: string, on: boolean): void;
  log(line: string): void;
}

interface Pending {
  from: string;
  to: string;
  requestedAt: number;
  /** The handoff request queued for the agent, while it may still be undelivered. */
  prompt?: string;
  written: boolean;
  deferredSince?: number;
}

export class WorkSwitchClearer {
  private sessions = new Map<string, number>();
  private pending = new Map<string, Pending>();

  constructor(private deps: WorkSwitchDeps) {}

  /** A new session began for this agent (its terminal spawned, or a clear landed). */
  noteSessionStart(id: string, at = this.deps.now()): void {
    this.sessions.set(id, at);
  }

  sessionStartedAt(id: string): number | undefined {
    return this.sessions.get(id);
  }

  /** The agent's terminal is gone: nothing to clear. */
  forget(id: string): void {
    this.sessions.delete(id);
    this.end(id);
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /** Inbox nudges wait while the agent is being asked for its note (only then:
   *  a clear deferred on a sign-off must still let a rejection reach it). */
  holdsNudges(id: string): boolean {
    const p = this.pending.get(id);
    return !!p && !p.written;
  }

  private end(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (!p.written) this.deps.holdNudges(id, false);
  }

  private markWritten(id: string, p: Pending): void {
    if (p.written) return;
    p.written = true;
    this.deps.holdNudges(id, false);
  }

  onSwitches(switches: readonly WorkSwitch[]): void {
    for (const s of switches) {
      try { this.begin(s); } catch (e) { this.deps.log(`[work-switch] ${s.agentId}: ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  private title(id: string): string {
    return this.deps.task(id)?.title?.trim() || id;
  }

  private begin(s: WorkSwitch): void {
    const d = this.deps;
    const rule = d.rule();
    if (!rule.enabled) return;
    const running = this.pending.get(s.agentId);
    // Already handing off: the note is about the work it is leaving, so only
    // where it is going changes.
    if (running) { running.to = s.to; return; }
    const agent = d.agent(s.agentId);
    if (!agent || agent.isGod || agent.isAssistant) return;
    if (!agent.clearCommand) {
      d.log(`[work-switch] ${s.agentId} moved ${s.from} → ${s.to}; its engine has no clear command, left as is`);
      return;
    }
    const now = d.now();
    if (!sessionOldEnough(this.sessions.get(s.agentId), now, rule.minSessionMs)) return;
    const paths = d.handoffPath(s.agentId);
    if (agent.canWriteHandoff) {
      const prompt = handoffPrompt(paths.agent, this.title(s.from), this.title(s.to));
      d.enqueue(s.agentId, prompt);
      this.pending.set(s.agentId, { from: s.from, to: s.to, requestedAt: now, prompt, written: false });
      d.holdNudges(s.agentId, true);
      d.log(`[work-switch] ${s.agentId} moved ${s.from} → ${s.to}; asked for a handoff note`);
    } else {
      this.writeFallback(s.agentId, agent.name, s.from, s.to, 'no-hooks');
      this.pending.set(s.agentId, { from: s.from, to: s.to, requestedAt: now, written: true });
      d.log(`[work-switch] ${s.agentId} moved ${s.from} → ${s.to}; the app wrote its handoff note`);
    }
  }

  private writeFallback(id: string, name: string, from: string, to: string, reason: 'no-hooks' | 'timeout'): void {
    const d = this.deps;
    d.writeFile(d.handoffPath(id).host, fallbackHandoff({
      agentName: name,
      from: d.task(from), fromId: from,
      to: d.task(to), toId: to,
      history: d.taskHistory(from),
      terminalTail: d.terminalTail(id),
      at: new Date(d.now()),
      reason
    }));
  }

  /** Move every hand-off along. Cheap when nothing is pending. */
  tick(): void {
    if (!this.pending.size) return;
    const d = this.deps;
    const now = d.now();
    const enabled = d.rule().enabled;
    for (const [id, p] of [...this.pending]) {
      try {
        const agent = d.agent(id);
        if (!agent || !enabled || !agent.clearCommand) {
          if (p.prompt) d.withdraw(id, p.prompt);
          this.end(id);
          continue;
        }
        if (!p.written) {
          const m = d.fileMtime(d.handoffPath(id).host);
          if (m !== null && m >= p.requestedAt - MTIME_SLACK_MS) {
            this.markWritten(id, p);
          } else if (now - p.requestedAt >= HANDOFF_WAIT_MS) {
            // Taken back first, so a fresh session is never asked about work it
            // no longer remembers.
            if (p.prompt) d.withdraw(id, p.prompt);
            this.writeFallback(id, agent.name, p.from, p.to, 'timeout');
            this.markWritten(id, p);
            d.log(`[work-switch] ${id} wrote no handoff note in time; the app wrote one`);
          } else {
            continue;
          }
        }
        const busy = d.busyReason(id);
        if (busy) {
          p.deferredSince ??= now;
          if (now - p.deferredSince >= CLEAR_DEFER_MAX_MS) {
            this.pending.delete(id);
            d.log(`[work-switch] ${id} not cleared: ${busy} for too long`);
          }
          continue;
        }
        const paths = d.handoffPath(id);
        d.enqueue(id, agent.clearCommand);
        d.enqueue(id, resumePrompt({
          handoffPath: paths.agent,
          inboxPath: d.inboxPath(id),
          toTitle: this.title(p.to),
          standingPath: d.standingPath(id),
          // A margin before the request: the work order usually lands in the
          // same minute the card moves.
          recentlyFiled: d.recentlyFiled(id, p.requestedAt - 10 * 60_000)
        }));
        this.pending.delete(id);
        this.sessions.set(id, now);
        d.log(`[work-switch] ${id} cleared for ${p.to}; its next session starts from the handoff note`);
      } catch (e) {
        d.log(`[work-switch] ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
