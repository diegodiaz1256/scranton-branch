/**
 * The server's terminal pool: the same exports the floor's orchestration uses
 * from src/renderer/src/components/terminalPool.ts, on @xterm/headless — a
 * screen buffer per pty with no DOM. The server build aliases the renderer
 * module to this one.
 *
 * Nobody types into a server's terminals, so there is never a user draft or an
 * open picker to protect: automation is safe whenever the process is alive.
 */
import { Terminal } from '@xterm/headless';
import { normalizePtyChunk } from '@/components/terminalRecovery';
import { inputAreaHas, inputAreaText, showsUsageLimit } from '@shared/ptySubmit';

export interface TerminalEntry {
  ptyId: string;
  term: Terminal;
  /** Kept for callers that size a respawn off the terminal. */
  fit: { fit: () => void };
  exited: boolean;
  unsub: Array<() => void>;
  onData?: (chunk: string) => void;
  /** Text the app typed that did not go through (markSubmitStuck). */
  stuckProbe?: string;
  /** When a human last sent this terminal a message (noteHumanMessage). */
  humanActedAt: number;
  /** When a usage-limit notice first showed at the bottom of the screen; 0: none. */
  limitSeenAt: number;
}

const COLS = 120;
const ROWS = 40;
const pool = new Map<string, TerminalEntry>();

export function acquireTerminal(ptyId: string): TerminalEntry {
  const existing = pool.get(ptyId);
  if (existing) return existing;
  const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
  const entry: TerminalEntry = { ptyId, term, fit: { fit: () => {} }, exited: false, unsub: [], humanActedAt: 0, limitSeenAt: 0 };
  entry.unsub.push(window.cth.onPtyData(ptyId, (raw: string) => {
    const chunk = normalizePtyChunk(raw);
    if (!chunk) return;
    term.write(chunk);
    entry.onData?.(chunk);
  }));
  entry.unsub.push(window.cth.onPtyExit(ptyId, () => { entry.exited = true; }));
  entry.unsub.push(window.cth.onPtyRelaunch(ptyId, () => { entry.exited = false; term.reset(); }));
  // TUIs ask for the terminal's colours (OSC 10/11) and wait a moment for an
  // answer; a dark terminal is the honest one on a server.
  const reply = (index: 10 | 11, rgb: string) => (data: string): boolean => {
    if (data !== '?' || entry.exited) return data === '?';
    window.cth.writePty(ptyId, `\x1b]${index};rgb:${rgb}\x1b\\`);
    return true;
  };
  term.parser.registerOscHandler(10, reply(10, 'e6e6/e6e6/e6e6'));
  term.parser.registerOscHandler(11, reply(11, '1a1a/1a1a/1a1a'));
  pool.set(ptyId, entry);
  return entry;
}

export function terminalTail(ptyId: string | undefined, max = 3): string[] {
  const entry = ptyId ? pool.get(ptyId) : undefined;
  if (!entry) return [];
  try {
    const buf = entry.term.buffer.active;
    const out: string[] = [];
    const last = buf.baseY + buf.cursorY;
    for (let y = last; y >= 0 && y > last - 200 && out.length < max; y--) {
      const text = buf.getLine(y)?.translateToString(true).trimEnd() ?? '';
      if (text.trim() && !/^[\s─-╿▀-▟>›❯]*$/.test(text)) out.unshift(text);
    }
    return out;
  } catch {
    return [];
  }
}

export function isTerminalAutomationSafe(ptyId: string): boolean {
  return !pool.get(ptyId)?.exited;
}

export function terminalAutomationBlockFor(): null { return null; }
export function hasTerminalDraft(): boolean { return false; }
export function useHasTerminalDraft(): boolean { return false; }
export function clearTerminalDraft(): string { return ''; }
export function dismissTerminalPicker(): void {}
export function notifyThemeChangeAll(): void {}
export function attachTerminal(): void {}
export function detachTerminal(): void {}
export function reflowTerminal(): void {}

export function resetTerminal(ptyId: string, opts: { preserveScrollback?: boolean } = {}): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  entry.exited = false;
  if (!opts.preserveScrollback) entry.term.reset();
}

export function disposeTerminal(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (!entry) return;
  entry.unsub.forEach((u) => { try { u(); } catch { /* noop */ } });
  try { entry.term.dispose(); } catch { /* noop */ }
  pool.delete(ptyId);
}

/** No terminals are drawn on the server: nobody types into one here. */
export function takeHumanInput(_ptyId: string | undefined, _withinMs?: number): boolean { return false; }

/** No terminal screen to read on the server. */
export function terminalUsage(_ptyId: string | undefined): { percent: number; window: string } | null { return null; }

/** Is `probe` in the TUI's input area right now? null when the screen cannot
 *  tell. Same reading as the desktop's pool, on the headless buffer. */
export function terminalInputHas(ptyId: string, probe: string): boolean | null {
  const entry = pool.get(ptyId);
  if (!entry || entry.exited) return null;
  try {
    const buf = entry.term.buffer.active;
    const cursor = buf.baseY + buf.cursorY;
    const from = Math.max(0, cursor - 20);
    const rows: string[] = [];
    for (let y = from; y <= cursor; y++) rows.push(buf.getLine(y)?.translateToString(true) ?? '');
    return inputAreaHas(inputAreaText(rows, cursor - from), probe);
  } catch {
    return null;
  }
}

/** Text the app typed did not go through: latch the terminal so nothing more
 *  is typed onto that line. */
export function markSubmitStuck(ptyId: string, probe: string): void {
  const entry = pool.get(ptyId);
  if (entry && probe) entry.stuckProbe = probe;
}

/** Is the app's stuck text still on this terminal's prompt? Clears the latch
 *  once the screen shows it gone. */
export function terminalSubmitStuck(ptyId: string): boolean {
  const entry = pool.get(ptyId);
  if (!entry || !entry.stuckProbe) return false;
  if (terminalInputHas(ptyId, entry.stuckProbe) === false) entry.stuckProbe = undefined;
  return !!entry.stuckProbe;
}

/** Is this terminal stopped on a usage limit nobody has acted on since? Read
 *  from the bottom of the headless screen when asked (no view refreshes it). */
export function terminalShowsUsageLimit(ptyId: string | undefined): boolean {
  const entry = ptyId ? pool.get(ptyId) : undefined;
  if (!entry || entry.exited) return false;
  try {
    const buf = entry.term.buffer.active;
    const lines: string[] = [];
    for (let i = Math.max(0, buf.length - 24); i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    if (!showsUsageLimit(lines.join('\n'))) entry.limitSeenAt = 0;
    else if (!entry.limitSeenAt) entry.limitSeenAt = Date.now();
  } catch { /* keep the last reading */ }
  return !!entry.limitSeenAt && entry.humanActedAt < entry.limitSeenAt;
}

/** When a human last sent this terminal a message (0: never). */
export function terminalHumanActedAt(ptyId: string): number {
  return pool.get(ptyId)?.humanActedAt ?? 0;
}

/** A human sent this terminal a message (Team, a Slack reply): that is acting on it. */
export function noteHumanMessage(ptyId: string): void {
  const entry = pool.get(ptyId);
  if (entry) entry.humanActedAt = Date.now();
}
