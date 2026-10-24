import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { messageBody } from '../shared/messageBody';

/**
 * A temp's token cap, from warning to reap.
 *
 * The cap is measured in WORK tokens (breaker.workTokensOf: cached reads are
 * not counted, as for the breaker's per-agent budgets since #189). The temp is
 * told its cap when it starts, gets one request at CAP_WARN_AT of the cap to
 * commit what it has and send its done, and above the cap it is reaped with its
 * last outbox message carried in god's notice, so the tokens spent are not lost.
 */

/** Share of the cap at which the temp is asked to wrap up. */
export const CAP_WARN_AT = 0.8;

/** What the cap calls for now: stop the temp, warn it once, or nothing. */
export function capStage(used: number, cap: number, warned: boolean): 'reap' | 'warn' | null {
  if (!(cap > 0)) return null;
  if (used > cap) return 'reap';
  if (!warned && used >= cap * CAP_WARN_AT) return 'warn';
  return null;
}

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** The line added to a capped temp's work order. */
export function capDispatchNote(cap: number): string {
  return `[TOKEN CAP] You have a budget of ${fmt(cap)} tokens (prompt input + output + cache writes; cached reads are not counted). `
    + `At ${Math.round(CAP_WARN_AT * 100)}% you will be asked to wrap up, and above the cap you are stopped. `
    + 'Commit your work as you go so nothing is lost.';
}

/** The one request sent to a temp nearing its cap. */
export function capWarningBody(used: number, cap: number): string {
  return `You have used ${fmt(used)} of your ${fmt(cap)}-token budget (${Math.round((used / cap) * 100)}%). `
    + 'Wrap up now: commit what you have (or write your partial results to a file), then send ONE outbox message '
    + 'to god with "act":"done" saying what is finished, what is not, and where the partial work is. '
    + 'Above the cap you are stopped without another warning.';
}

/** The newest message a worker put in its outbox (or outbox/.sent) since
 *  `since`, by created_at, else file mtime: what it last said before a reap. */
export function lastOutboxMessage(agentDir: string, since: number): { act: string; subject: string; text: string } | null {
  const base = join(agentDir, 'outbox');
  let best: { at: number; act: string; subject: string; text: string } | null = null;
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as Record<string, unknown>;
        let at = Date.parse(typeof msg.created_at === 'string' ? msg.created_at : '');
        if (!Number.isFinite(at) || at <= since) at = statSync(fp).mtimeMs;
        if (!(at > since) || (best && at <= best.at)) continue;
        best = {
          at,
          act: typeof msg.act === 'string' ? msg.act : 'message',
          subject: typeof msg.subject === 'string' ? msg.subject : '',
          text: messageBody(msg)
        };
      } catch { /* skip unreadable/partial */ }
    }
  }
  return best ? { act: best.act, subject: best.subject, text: best.text } : null;
}

/** The reap notice's tail: the temp's last words, clipped. */
export function lastWords(msg: { act: string; subject: string; text: string } | null, max = 1500): string {
  if (!msg) return 'It sent nothing before it was stopped.';
  const text = msg.text.trim();
  const clipped = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return `Its last message (${msg.act}${msg.subject ? `, "${msg.subject}"` : ''}):\n${clipped || '(empty)'}`;
}
