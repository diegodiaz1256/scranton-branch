/** Slash commands that open an interactive picker/panel instead of starting a
 * normal agent turn. Automated queue delivery must wait until that UI closes. */
const INTERACTIVE_COMMANDS = new Set([
  '/model',
  '/reasoning',
  '/permissions',
  '/permission',
  '/provider',
  '/settings',
  '/config',
  '/experimental',
  '/experiments',
  '/hooks',
  '/mcp',
  '/apps',
  '/plugins',
  '/resume',
  '/sessions'
]);

export function opensInteractiveTerminalUi(input: string): boolean {
  // Only a BARE command opens a picker. `/model` prompts you to choose;
  // `/model sonnet` applies the argument and returns to the prompt with no UI
  // to close. Matching on the first token alone latched the block on the second
  // form too, and nothing could ever clear it — the agent's message queue then
  // silently stopped delivering for the rest of the session.
  const trimmed = input.trim().toLowerCase();
  if (/\s/.test(trimmed)) return false;
  return INTERACTIVE_COMMANDS.has(trimmed);
}

/** Follow output only if the user was already at (or one line from) the bottom.
 * This keeps live TUIs visible without yanking someone reading scrollback. */
export function shouldFollowTerminalOutput(viewportY: number, baseY: number, pinned = 0): boolean {
  return baseY - viewportY <= 1 + pinned;
}

/** Blank screen rows under the content (and the cursor) that following output
 *  should hide. A TUI like Claude Code redraws a region at the bottom; when it
 *  shrinks (a menu closes) the rows it cleared stay blank below the prompt,
 *  and "scrolled to the bottom" showed that empty space instead of the prompt.
 *  Lifting the viewport by this many rows keeps the prompt at the bottom.
 *  Capped by the scrollback there is to show above. */
export function blankRowsBelowContent(screenRowBlank: boolean[], cursorRow: number, baseY: number): number {
  let last = screenRowBlank.length - 1;
  while (last >= 0 && screenRowBlank[last]) last--;
  const lastUsed = Math.max(last, cursorRow);
  return Math.max(0, Math.min(baseY, screenRowBlank.length - 1 - lastUsed));
}

/** How long an untouched draft on the prompt keeps blocking queue delivery.
 *
 * The block exists so automation can't fuse its text onto a half-written line.
 * It still has to expire, because the flag is set from KEYSTROKES and a TUI that
 * swallows keys for its own UI can leave it set while the prompt is visibly
 * empty — a phantom draft, which wedged the queue for the rest of the session.
 *
 * Half an hour, not a minute. The old 60s window fired while the user had merely
 * paused to think, and treating a real draft as abandoned is the expensive
 * mistake; leaving a queued message parked a while longer is the cheap one. When
 * it does fire, delivery simply types after the existing text (the two fuse into
 * one prompt) — automation never deletes what the user wrote. */
export const STALE_INPUT_MS = 1_800_000;

/** How long an untouched picker keeps blocking queue delivery.
 * The picker latch is set when the user submits a bare `/model`-style command
 * and is cleared by an Enter, Escape or Ctrl-C typed into that terminal — so a
 * picker closed any other way leaves it set with no path back. Same half hour,
 * same reason: it is the user's menu, so wait a long time, then deliver. We
 * never send Escape ourselves; closing someone's open menu to make room for a
 * queued message is not ours to do. */
export const STALE_PICKER_MS = 1_800_000;

export interface TerminalAutomationState {
  exited: boolean;
  pickerOpen: boolean;
  inputDirty: boolean;
  settleUntil: number;
  inputDirtyAt?: number; // last keystroke that left a draft; absent ⇒ never expires
  pickerOpenedAt?: number; // when the picker latched; absent ⇒ never expires
  /** Text the app typed is still on the prompt after Enter, twice. Unlike a
   *  draft it does not expire: typing more would append to it, which is the
   *  pile-up this exists to stop. Cleared by the human's next keystroke in that
   *  terminal, or by the screen showing the text gone. */
  submitStuck?: boolean;
}

/** A picker nobody has interacted with for STALE_PICKER_MS is treated as gone. */
export function isStaleTerminalPicker(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return state.pickerOpen
    && state.pickerOpenedAt !== undefined
    && now - state.pickerOpenedAt >= STALE_PICKER_MS;
}

/** Why automation may not own the prompt right now, or null when it may. */
export type TerminalAutomationBlock = 'exited' | 'picker' | 'stuck' | 'draft' | 'settling' | null;

/** A draft nobody has touched for STALE_INPUT_MS is treated as abandoned. */
export function isStaleTerminalDraft(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return state.inputDirty
    && state.inputDirtyAt !== undefined
    && now - state.inputDirtyAt >= STALE_INPUT_MS;
}

export function terminalAutomationBlock(
  state: TerminalAutomationState,
  now = Date.now()
): TerminalAutomationBlock {
  if (state.exited) return 'exited';
  if (state.pickerOpen && !isStaleTerminalPicker(state, now)) return 'picker';
  if (state.submitStuck) return 'stuck';
  if (state.inputDirty && !isStaleTerminalDraft(state, now)) return 'draft';
  if (now < state.settleUntil) return 'settling';
  return null;
}

/** Automatic writes may own the prompt only when no user draft or picker does. */
export function canAutomateTerminal(
  state: TerminalAutomationState,
  now = Date.now()
): boolean {
  return terminalAutomationBlock(state, now) === null;
}

/** One screen row of a logical line: its text (indent already removed for
 *  a continuation row), its 1-based buffer row, and the column its text starts at. */
export interface LineRow { text: string; row: number; x0: number }

/** Does `cur` continue `prev`? The terminal's own soft wrap, or a TUI's hard
 *  wrap: Claude Code breaks long lines itself, ending a full row and indenting
 *  the next, so a long path printed by an agent arrives as several lines. */
export function continuesRow(prev: string, cur: string, softWrapped: boolean, cols: number): boolean {
  return softWrapped || (prev.length >= cols - 1 && /^\s+\S/.test(cur));
}

/** Where a span of the joined text sits on screen, as an xterm link range
 *  (1-based columns, inclusive end). Matched one row at a time, a wrapped
 *  path was never a link. */
export function wrappedSpanRange(rows: LineRow[], start: number, length: number): {
  start: { x: number; y: number }; end: { x: number; y: number };
} {
  const at = (i: number) => {
    let off = 0;
    for (const r of rows) {
      if (i < off + r.text.length || r === rows[rows.length - 1]) return { x: r.x0 + (i - off) + 1, y: r.row };
      off += r.text.length;
    }
    return { x: i + 1, y: rows[0]?.row ?? 1 };
  };
  return { start: at(start), end: at(start + Math.max(1, length) - 1) };
}
