import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The orchestrator's work log: one line per job it handed to a temp, and how it
 * ended. Written by the app, not by the model: asked in its prompt to keep this
 * record, a live orchestrator (Haiku) still left its memory empty. It lives in
 * agents/<orchestrator>/worklog.md, next to memory.md, and Memory shows it as
 * part of the orchestrator's notes.
 */
export type WorkOutcome = 'done' | 'exited' | 'idle' | 'tokens' | 'archived';

export interface WorkLogEntry {
  /** Who did the job (the temp's display name). */
  who: string;
  /** What it was asked to do. */
  objective?: string;
  outcome: WorkOutcome;
  /** Its own report, for a job that finished. */
  result?: string;
  exitCode?: number | null;
  date?: Date;
}

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

export function workLogLine(e: WorkLogEntry): string {
  const day = (e.date ?? new Date()).toISOString().slice(0, 10);
  const job = e.objective?.trim() ? ` "${clip(e.objective, 100)}"` : '';
  switch (e.outcome) {
    case 'done':
      return `- ${day}: ${e.who} finished${job}${e.result?.trim() ? ` → ${clip(e.result, 180)}` : ' (no report)'}`;
    case 'exited':
      return `- ${day}: ${e.who} stopped before reporting done${typeof e.exitCode === 'number' ? ` (exit ${e.exitCode})` : ''} on${job || ' its job'}`;
    case 'idle':
      return `- ${day}: ${e.who} was stopped after going idle on${job || ' its job'}`;
    case 'tokens':
      return `- ${day}: ${e.who} was stopped at its token cap on${job || ' its job'}`;
    case 'archived':
      return `- ${day}: ${e.who} was archived by the orchestrator on${job || ' its job'}`;
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?/g;

/** The last lines a terminal printed, readable: no escape codes, no blank or
 *  one-character lines, at most `max` characters (the end kept). */
export function terminalTail(tail: string | undefined, lines = 6, max = 600): string {
  if (!tail) return '';
  // The capture is a ring buffer: it can start in the middle of a sequence.
  const kept = tail.replace(/^\[[0-9;?]*[ -/]*[@-~]/, '').replace(ANSI, '').split(/\r?\n|\r/).map((l) => l.trimEnd()).filter((l) => l.trim().length > 1);
  const out = kept.slice(-lines).join('\n');
  return out.length > max ? `…${out.slice(out.length - max + 1)}` : out;
}

/**
 * The orchestrator's notice when a temp's process ended before it reported
 * done (it crashed, its CLI refused to start, it quit). Without it the
 * orchestrator told the human "all three started without errors" about a
 * worker that had died in its first second, and waited for its done.
 */
export function workerExitNotice(workerId: string, exitCode: number | null | undefined, tail?: string): { subject: string; body: string } {
  const code = typeof exitCode === 'number' ? ` (exit ${exitCode})` : '';
  const last = terminalTail(tail);
  return {
    subject: `[worker exited] ${workerId}`,
    body: `Worker ${workerId} stopped${code} before it reported done: nobody is doing its job now.\n`
      + (last ? `Its terminal ended with:\n${last}\n` : 'Its terminal printed nothing.\n')
      + (typeof exitCode === 'number' && exitCode !== 0 ? 'The full tail is in crashes/ in the hive.\n' : '')
      + 'A worker that fails while starting fails the same way again: fix the cause, or give the job to another agent or engine, rather than sending the same request again.'
  };
}

/** Append one line to <agentDir>/worklog.md, creating it with a heading first. */
export function appendWorkLog(agentDir: string, owner: string, line: string): void {
  const p = join(agentDir, 'worklog.md');
  if (!existsSync(p)) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(p, `# Work log — ${owner}\n\n_Written by the app: one line per job handed to a temp, and how it ended._\n\n## Log\n\n`, 'utf8');
  }
  appendFileSync(p, `${line}\n`, 'utf8');
}
