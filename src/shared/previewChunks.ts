/**
 * Big documents in the Deliverables viewer, in pieces. Rendering a 1.5 MB
 * Markdown report in one go held the window for tens of seconds; in pieces of
 * a few dozen KB, one per frame, the window keeps answering while it fills in,
 * and past a budget the rest waits for a click. Pure, so node:test can load it.
 */

/** How much of a document is shown before asking (characters). */
export const PREVIEW_BUDGET = 256 * 1024;

/**
 * Markdown cut into pieces of about `size` characters, each ending at a block
 * boundary (a blank line), never inside a fenced code block. Joined back they
 * are the text.
 */
export function splitMarkdown(text: string, size = 32 * 1024): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  const lines = text.split('\n');
  let cur: string[] = [];
  let len = 0;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    cur.push(line);
    len += line.length + 1;
    // A blank line outside code, with the piece full: cut after it.
    if (len >= size && !fence && line.trim() === '' && i < lines.length - 1) {
      out.push(cur.join('\n') + '\n');
      cur = [];
      len = 0;
    }
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

/** The pieces that fit in `budget` characters (at least one). */
export function piecesWithin(pieces: string[], budget = PREVIEW_BUDGET): number {
  let total = 0;
  for (let i = 0; i < pieces.length; i++) {
    total += pieces[i].length;
    if (total > budget) return Math.max(1, i);
  }
  return pieces.length;
}

/** The start of a plain text, cut at a line end, when it is over `max`. */
export function headOf(text: string, max = PREVIEW_BUDGET): { head: string; cut: boolean } {
  if (text.length <= max) return { head: text, cut: false };
  const nl = text.lastIndexOf('\n', max);
  return { head: text.slice(0, nl > max / 2 ? nl : max), cut: true };
}
