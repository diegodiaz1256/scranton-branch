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

/** Append one line to <agentDir>/worklog.md, creating it with a heading first. */
export function appendWorkLog(agentDir: string, owner: string, line: string): void {
  const p = join(agentDir, 'worklog.md');
  if (!existsSync(p)) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(p, `# Work log — ${owner}\n\n_Written by the app: one line per job handed to a temp, and how it ended._\n\n## Log\n\n`, 'utf8');
  }
  appendFileSync(p, `${line}\n`, 'utf8');
}
