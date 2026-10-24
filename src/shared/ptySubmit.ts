import type { AgentProvider } from './agentProvider';

/**
 * Typing a message into an agent's TUI and making sure it was SUBMITTED.
 *
 * The app types a message (the text) and then presses Enter (a lone "\r") as a
 * separate write a few hundred milliseconds later. That gap is the only thing
 * that tells a TUI "this \r is Enter, not part of the text", and it does not
 * survive a loaded machine: a stalled main process runs both queued writes back
 * to back, and wsl.exe/ConPTY can hand both to the CLI in one read. Claude Code
 * then takes the whole chunk as a paste, keeps the "\r" as an invisible
 * character in its input, and the next Enter only removes it ("Removed 1
 * invisible character · review and press Enter to send"). The message stays on
 * the prompt, every later nudge is appended to it, and nothing goes through
 * until a human presses Enter. Measured against real Claude Code in WSL: text
 * and "\r" in one write stayed unsubmitted in about half the tries.
 *
 * Two defences, both here so the renderer and the main process share them:
 *  - bracketed paste (ESC[200~ … ESC[201~) around the text for CLIs that
 *    support it. The TUI then knows exactly where the text ends, so the Enter
 *    after it is an Enter however the bytes are chunked (0 stuck in the same
 *    measurement, Enter in the very same write);
 *  - after Enter, read the screen: if the text is still on the prompt, press
 *    Enter once more, and if it is STILL there, report it as stuck instead of
 *    calling it delivered — the caller then stops typing into that terminal and
 *    tells the human, rather than piling more text onto the line.
 */

/**
 * Which CLIs take bracketed paste on their input.
 *
 * A total record so a new provider has to be looked at. `false` keeps the old
 * behaviour for that CLI (single-line text typed raw, multi-line still wrapped):
 * Antigravity's agy takes the markers as literal text and never submits, and
 * the ones nobody has verified stay on the path they were already on. The
 * submit check below applies to every provider either way.
 */
const BRACKETED_PASTE: Record<AgentProvider, boolean> = {
  // Verified in WSL against Claude Code 2.1.x: wrapped text + "\r" in one write
  // submits every time; raw text + "\r" in one write does not.
  claude: true,
  // Codex (crossterm), Gemini CLI and its qwen fork (Ink), and pi all enable
  // DEC mode 2004 and parse paste brackets on input.
  codex: true,
  gemini: true,
  qwen: true,
  pi: true,
  antigravity: false,
  grok: false,
  kimi: false,
  opencode: false,
  crush: false,
  copilot: false,
  cursor: false,
  custom: false
};

export function acceptsBracketedPaste(provider: AgentProvider): boolean {
  return BRACKETED_PASTE[provider] ?? false;
}

/** The bytes to write for `text`, before the separate Enter. Multi-line text is
 *  always bracketed (a bare "\n" would submit it line by line, #24). A slash
 *  command stays typed: it is short (a CLI does not take a few typed keys for a
 *  paste), and a CLI opens its command menu on a typed "/", which a pasted one
 *  may not do. */
export function pastePayload(text: string, provider: AgentProvider): string {
  const bracket = text.includes('\n') || (acceptsBracketedPaste(provider) && !text.startsWith('/'));
  return bracket ? `\x1b[200~${text}\x1b[201~` : text;
}

/** How long to wait between typing `text` into a TUI and pressing Enter. */
export function preEnterDelayMs(text: string): number {
  if (text.startsWith('/')) return 450;
  return Math.min(1100, 140 + Math.floor(text.length / 3));
}

/** A short piece of the message that fits on one screen row, to look for on
 *  the prompt after Enter. Taken from the first line, whitespace collapsed. */
export function submitProbe(text: string, max = 24): string {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  return first.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/** A row that is only a TUI's box drawing (or blank): the edge of its input box. */
function isFrameRow(row: string): boolean {
  return /^[\s─-╿▀-▟]*$/.test(row);
}

/**
 * The text in the TUI's input area: the cursor row and the rows above it up to
 * the box's edge (a rule line or a blank row), prompt markers and box sides
 * stripped. Claude Code, Codex and Gemini all keep the cursor inside their input
 * box, and draw the box with a frame row above it, so this stops before the
 * transcript — where a message that WAS submitted is echoed back.
 */
export function inputAreaText(rows: readonly string[], cursorRow: number, maxRows = 16): string {
  const out: string[] = [];
  for (let y = cursorRow; y >= 0 && y > cursorRow - maxRows; y--) {
    const row = rows[y] ?? '';
    if (isFrameRow(row)) {
      if (y === cursorRow) continue; // the cursor can sit on a padding row
      break;
    }
    out.unshift(row.replace(/^[\s│┃>›❯]+/, '').replace(/[\s│┃]+$/, ''));
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Is `probe` on the prompt? Matching ignores whitespace, since the TUI wraps
 *  the text at its own column. */
export function inputAreaHas(area: string, probe: string): boolean {
  if (!probe) return false;
  const squash = (s: string): string => s.replace(/\s+/g, '');
  return squash(area).includes(squash(probe));
}

export type SubmitVerdict =
  /** The text left the prompt after the first Enter. */
  | 'submitted'
  /** It left only after a second Enter. */
  | 'retried'
  /** Still on the prompt after two Enters: a human has to look. */
  | 'stuck'
  /** The screen could not be read; the old fire-and-forget behaviour. */
  | 'unverified';

export interface SubmitIo {
  write: (data: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  /** Is `probe` still on the prompt? null when the screen cannot tell. */
  inputHas: (probe: string) => boolean | null;
}

/** How long after Enter the prompt is watched for the text to leave. */
export const SUBMIT_CHECK_MS = 2500;
const SUBMIT_POLL_MS = 150;

/** Watch the prompt for `probe` to be gone on two reads in a row (one read can
 *  land mid-redraw). 'gone', 'present', or 'unknown' when the screen can't say. */
async function watchPrompt(io: SubmitIo, probe: string, ms: number): Promise<'gone' | 'present' | 'unknown'> {
  let goneReads = 0;
  let known = false;
  for (let waited = 0; waited <= ms; waited += SUBMIT_POLL_MS) {
    await io.sleep(SUBMIT_POLL_MS);
    const has = io.inputHas(probe);
    if (has === null) { goneReads = 0; continue; }
    known = true;
    if (has) goneReads = 0;
    else if (++goneReads >= 2) return 'gone';
  }
  return known ? 'present' : 'unknown';
}

/**
 * Type `text`, press Enter, and check it was taken. Retries Enter ONCE — a
 * second Enter is what a person does when the first one was eaten, and it also
 * clears Claude Code's "review and press Enter" stop. Never types the text again.
 */
export async function submitAndVerify(
  io: SubmitIo,
  text: string,
  provider: AgentProvider
): Promise<SubmitVerdict> {
  await io.write(pastePayload(text, provider));
  await io.sleep(preEnterDelayMs(text));
  await io.write('\r');
  const probe = submitProbe(text);
  if (!probe) return 'unverified';
  const first = await watchPrompt(io, probe, SUBMIT_CHECK_MS);
  if (first === 'gone') return 'submitted';
  if (first === 'unknown') return 'unverified';
  await io.write('\r');
  const second = await watchPrompt(io, probe, SUBMIT_CHECK_MS);
  if (second === 'gone') return 'retried';
  return second === 'unknown' ? 'unverified' : 'stuck';
}

/**
 * Is the CLI showing a usage-limit stop? Claude Code prints these when a plan
 * limit is hit; an inbox nudge typed at that point is not run and just sits
 * on the prompt. Matched on the bottom of the screen, case-insensitively.
 */
export function showsUsageLimit(screen: string): boolean {
  return /hit your (?:session |weekly |usage |daily )?limit|usage limit reached|rate-limit-options to re-arm|continuing automatically at/i.test(screen);
}
