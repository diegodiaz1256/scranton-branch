/**
 * The human's sign-off on everything a custodian sends out (criticalConnections.ts).
 *
 * A custodian's outbox mail and the files it means for the office's
 * deliverables never go straight out, whatever it believes it redacted: the
 * app holds them, runs the redactor, and shows the human the redacted text
 * with its destination. Only the human's approval delivers them (as shown, or
 * as the human edited them); a rejection goes back to the custodian with the
 * reason. Nothing times out into sending. Each decision is audited with a hash
 * of the text that left.
 *
 * Pure: no electron, no node (the hash function is passed in).
 */
import type { RedactResult } from './confidentialRedact';

export type PendingKind = 'message' | 'deliverable';

export interface PendingItem {
  id: string;
  kind: PendingKind;
  /** The custodian. */
  from: string;
  /** Epoch ms. */
  createdAt: number;
  /** message: the recipient agent id ('god', an agent, 'human'). */
  to?: string;
  /** message: its act. */
  act?: string;
  /** deliverable: the file name it asks to publish under research/. */
  file?: string;
  /** message: the subject, already redacted. */
  subject?: string;
  /** The body or file text, already redacted. */
  text: string;
  /** What the redactor took out, by kind. */
  redactions: RedactResult['counts'];
  /** message: the original message id, kept so a reply threads. */
  messageId?: string;
  conversation?: string;
  inReplyTo?: string | null;
}

export type Decision =
  | { action: 'approve'; text?: string; subject?: string }
  | { action: 'reject'; reason: string };

export interface DecisionOutcome {
  /** Approved: exactly what leaves. */
  deliver?: { subject?: string; text: string; edited: boolean };
  /** Rejected: what goes back to the custodian. */
  bounce?: { subject: string; body: string };
  /** For the audit log: who, when, what, and a hash of the text that left. */
  audit: { action: 'approved' | 'approved-edited' | 'rejected'; by: 'human'; at: number; item: string; kind: PendingKind; to?: string; file?: string; sha256?: string };
}

/** Apply the human's decision to a held item. Fails closed: anything that is
 *  not a well-formed approval is not one. */
export function decide(item: PendingItem, d: Decision, at: number, sha256: (s: string) => string): DecisionOutcome {
  if (d && d.action === 'approve') {
    const text = typeof d.text === 'string' ? d.text : item.text;
    const subject = item.kind === 'message' ? (typeof d.subject === 'string' ? d.subject : item.subject ?? '') : undefined;
    const edited = text !== item.text || (subject !== undefined && subject !== (item.subject ?? ''));
    return {
      deliver: { subject, text, edited },
      audit: { action: edited ? 'approved-edited' : 'approved', by: 'human', at, item: item.id, kind: item.kind, to: item.to, file: item.file, sha256: sha256(`${subject ?? ''}\n${text}`) }
    };
  }
  const reason = d && d.action === 'reject' && typeof d.reason === 'string' && d.reason.trim() ? d.reason.trim().slice(0, 2000) : 'No reason given.';
  const what = item.kind === 'message' ? `your message to ${item.to}${item.subject ? ` ("${item.subject}")` : ''}` : `the file ${item.file}`;
  return {
    bounce: { subject: `[not sent] the human rejected ${what}`, body: `The human did not sign off ${what}. It was not delivered.\n\nReason: ${reason}` },
    audit: { action: 'rejected', by: 'human', at, item: item.id, kind: item.kind, to: item.to, file: item.file }
  };
}

/** A file name the custodian may ask to publish: a plain name, no folders. */
export function cleanDeliverableName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length > 120 || /[\\/:*?"<>|\0]/.test(n) || n === '.' || n === '..' || n.startsWith('.')) return null;
  return n;
}

/** Where a custodian may write (its own hive folder and its vaults), and
 *  nothing else: not the project, not research/, not other agents' folders,
 *  not the hive's shared files, not the temp dir. */
export function custodianWriteRoots(agentDir: string, vaults: string[]): string[] {
  return [agentDir, ...vaults].filter((d) => typeof d === 'string' && d.length > 0);
}

/** The custodian's prompt about the sign-off. */
export function signoffPromptLine(outgoing: string): string {
  return `- SIGN-OFF: everything you send out is held by the app until the human approves it: your outbox messages (to any agent, the orchestrator included, or the human) and files for the office's deliverables. You cannot write anywhere else but your own hive folder and your vault. To publish a file to research/, write it into ${outgoing} and the human reviews it there. Wait for the decision: an approved message is delivered as the human signed it; a rejected one comes back to your inbox with the reason. Never try another way out.`;
}
