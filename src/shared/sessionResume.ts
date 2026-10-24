/**
 * Whether an agent may continue its recorded CLI session in this spawn.
 *
 * A session belongs to the folder and the role it was started in. CLIs key
 * their sessions by working folder (Claude Code's projects/<dir>, pi's
 * sessions/<dir>, Codex's recorded cwd), and resuming one from another folder
 * either asks a question nobody is there to answer (pi: "Session found in
 * different project… Fork? [y/N]", answered by the app's first typed prompt,
 * after which pi exits) or carries the old folder's context into the new one.
 * Becoming, or ceasing to be, the custodian of a critical connection changes
 * what the agent may see and where it writes: a session from before must not
 * cross that line in either direction. In both cases the agent starts fresh.
 *
 * Pure: no electron, no node.
 */
import { normPath } from './toolGuard';

/** Where and as what the recorded session ran. Missing fields are unknown
 *  (a registry written before this was recorded) and never block. */
export interface SessionContext {
  cwd?: string;
  custodian?: boolean;
}

/** Why the recorded session must not be resumed now, or null when it may. */
export function freshSessionReason(stored: SessionContext | undefined, now: { cwd: string; custodian: boolean }): string | null {
  if (!stored) return null;
  if (typeof stored.custodian === 'boolean' && stored.custodian !== now.custodian) {
    return now.custodian
      ? 'it became the custodian of a critical connection since its last session'
      : 'it is no longer the custodian of a critical connection';
  }
  if (stored.cwd && now.cwd && normPath(stored.cwd) !== normPath(now.cwd)) {
    return `its working folder changed since its last session (${stored.cwd} -> ${now.cwd})`;
  }
  return null;
}

/** The line shown in the agent's terminal and log when it starts fresh. */
export function freshSessionNotice(reason: string): string {
  return `Started a new session instead of resuming the previous one: ${reason}.`;
}
