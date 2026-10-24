/**
 * The safety net under a custodian's prompt (criticalConnections.ts): whatever
 * the custodian of a critical connection sends out of its own folder (outbox
 * mail, memory, deliverables, worklog) is redacted by the app first. The
 * prompt asks the custodian to send the minimum; this catches what slips.
 *
 * Kept: ticket keys (INFOSEC-123), statuses, counts, dates, short prose.
 * Redacted, marked [REDACTED:<kind>]: emails, phone numbers, credentials and
 * tokens, URLs on the critical service's hosts (attachments, pages), the
 * service's people when their names are known, and long verbatim quotes.
 *
 * Fail closed but never destroy the message: redact, then deliver.
 *
 * Pure: no electron, no node.
 */
import { redact as redactSecrets } from './agentSteps';

export type RedactionKind = 'email' | 'phone' | 'secret' | 'url' | 'name' | 'quote';

export interface RedactOptions {
  /** Hosts of the critical connections (example.atlassian.net…): any URL on
   *  them, or on a subdomain, is redacted. */
  hosts?: string[];
  /** People's names seen in the service (assignees, reporters, authors). */
  names?: string[];
  /** A quote (in quotes, a code fence or a `>` block) longer than this many
   *  characters (not counting spaces) is redacted as a verbatim excerpt.
   *  Default 120. */
  maxQuote?: number;
}

export interface RedactResult {
  text: string;
  /** How many redactions of each kind were made. */
  counts: Partial<Record<RedactionKind, number>>;
}

const mark = (kind: RedactionKind): string => `[REDACTED:${kind}]`;

const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// International or local numbers with 8+ digits, allowing spaces, dots, dashes
// and parentheses; not ticket keys (INFOSEC-123), dates (2026-10-24) or times.
const PHONE = /(?<![\w-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]\d{2,4}){1,4}(?![\w-])/g;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}$|^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const QUOTE_BLOCK = /```[\s\S]*?```|(?:^|\n)(?:>[^\n]*(?:\n|$))+|"[^"\n]{40,}"|“[^”\n]{40,}”/g;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hostMatches(host: string, hosts: string[]): boolean {
  const h = host.toLowerCase();
  return hosts.some((x) => { const y = x.toLowerCase(); return h === y || h.endsWith(`.${y}`); });
}

export function redactConfidential(input: string, opts: RedactOptions = {}): RedactResult {
  const counts: Partial<Record<RedactionKind, number>> = {};
  const bump = (k: RedactionKind): string => { counts[k] = (counts[k] ?? 0) + 1; return mark(k); };
  let text = typeof input === 'string' ? input : '';
  const maxQuote = opts.maxQuote ?? 120;

  // Long verbatim excerpts first: what is inside goes as a whole.
  text = text.replace(QUOTE_BLOCK, (m) => {
    const body = m.replace(/^\n/, '');
    if (body.replace(/[`>"“”\s]/g, '').length <= maxQuote) return m;
    return (m.startsWith('\n') ? '\n' : '') + bump('quote');
  });
  // Credentials (the app's shared scrubber), then counted.
  const scrubbed = redactSecrets(text);
  if (scrubbed !== text) text = scrubbed.replace(/\*\*\*/g, () => bump('secret'));
  // URLs: on the critical service's hosts, always; anywhere, when they carry
  // credentials or point at attachments.
  text = text.replace(URL_RE, (whole) => {
    // Sentence punctuation after a link is not part of it.
    const tail = /[.,;:!?]+$/.exec(whole)?.[0] ?? '';
    const u = tail ? whole.slice(0, -tail.length) : whole;
    let host = '';
    try { host = new URL(u).hostname; } catch { return bump('url') + tail; }
    if ((opts.hosts?.length && hostMatches(host, opts.hosts)) || /attachment|download|\/files?\//i.test(u)) return bump('url') + tail;
    return whole;
  });
  text = text.replace(EMAIL, () => bump('email'));
  text = text.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 8 || DATE_LIKE.test(m.trim())) return m;
    return bump('phone');
  });
  for (const name of (opts.names ?? []).map((n) => n.trim()).filter((n) => n.length >= 3)) {
    text = text.replace(new RegExp(`(?<![\\w])${escapeRe(name)}(?![\\w])`, 'gi'), () => bump('name'));
  }
  return { text, counts };
}

/** How many redactions in all. */
export const redactionTotal = (r: RedactResult): number => Object.values(r.counts).reduce((n, v) => n + (v ?? 0), 0);
