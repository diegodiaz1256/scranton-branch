'use strict';
/**
 * Opening an agent's terminal resizes its PTY, and the TUI answers by
 * repainting its whole screen. That repaint is not work: it used to show an
 * idle agent as working (the stream parser saw old `● Read …` lines) and reset
 * the "quiet for N s" clocks the worker wake and queue drain wait on.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { REPAINT_ECHO_MS, repaintEchoUntil, isRepaintEcho } = loadTs('src/shared/ptyRepaint.ts');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

test('output right after a resize is its repaint; later output is not', () => {
  const until = repaintEchoUntil(10_000);
  assert.equal(until, 10_000 + REPAINT_ECHO_MS);
  assert.equal(isRepaintEcho(until, 10_001), true);
  assert.equal(isRepaintEcho(until, 10_000 + REPAINT_ECHO_MS - 1), true);
  assert.equal(isRepaintEcho(until, 10_000 + REPAINT_ECHO_MS), false);
});

test('no resize pending means no output is a repaint', () => {
  assert.equal(isRepaintEcho(undefined, 5), false);
  assert.equal(isRepaintEcho(0, 5), false);
});

// Recorded on a WSL floor: claude 2.1.310 through wsl.exe + ConPTY (node-pty),
// one Read turn, then the PTY resized the way opening the terminal view does.
// t = ms since spawn; `tool` = what the stream parser's tool regex matched.
const RESIZES = [12010, 30003, 38006, 44002];
const CHUNKS = [
  // the genuine turn, before any resize
  { t: 11327, tool: null }, { t: 11511, tool: null }, { t: 11885, tool: null }, { t: 11901, tool: null },
  // resize mid-turn: repaint, then the turn's own output carries on
  { t: 12012, tool: 'Reading' }, { t: 12041, tool: 'Reading' }, { t: 12507, tool: null }, { t: 12553, tool: null },
  // idle, nothing but a status-line tick
  { t: 16570, tool: null },
  // idle, view opened (100x35): the repaint prints the old turn back
  { t: 30003, tool: 'banana' }, { t: 30004, tool: null }, { t: 30019, tool: 'banana' },
  // fullscreen (120x40)
  { t: 38007, tool: 'banana' }, { t: 38022, tool: 'banana' },
  // same-size resize: ConPTY repaints anyway
  { t: 44002, tool: 'banana' }
];

/** Replay the recording the way PtyManager does: each resize sets the
 *  deadline, each chunk outside it is activity. */
function replay(chunks, gate) {
  let until = 0;
  let r = 0;
  let lastOutputAt = 0;
  const seen = [];
  for (const c of chunks) {
    while (r < RESIZES.length && RESIZES[r] <= c.t) until = repaintEchoUntil(RESIZES[r++]);
    if (gate && isRepaintEcho(until, c.t)) continue;
    lastOutputAt = c.t;
    seen.push(c);
  }
  return { lastOutputAt, seen };
}

test('recorded WSL repaint: an idle agent stays quiet and shows no tool lines', () => {
  const before = replay(CHUNKS, false);
  // Without the gate the repaints reset the quiet clock and feed old tool lines to the parser.
  assert.equal(before.lastOutputAt, 44002);
  assert.ok(before.seen.some((c) => c.t >= 30003 && c.tool));

  const after = replay(CHUNKS, true);
  assert.equal(after.lastOutputAt, 16570, 'the last real output, not the view opening');
  assert.deepEqual(after.seen.filter((c) => c.t >= 30000), []);
});

test('recorded WSL repaint: work before and after a resize still counts', () => {
  const after = replay(CHUNKS, true);
  assert.deepEqual(after.seen.filter((c) => c.t < 12010).map((c) => c.t), [11327, 11511, 11885, 11901]);
  // A turn that keeps printing past the window is seen again.
  const long = replay([...CHUNKS.filter((c) => c.t < 13000), { t: 12010 + REPAINT_ECHO_MS + 100, tool: 'Bash' }], true);
  assert.equal(long.lastOutputAt, 12010 + REPAINT_ECHO_MS + 100);
  assert.equal(long.seen.at(-1).tool, 'Bash');
});

test('PtyManager: resize and redraw open the window, and a repaint does not bump lastOutputAt', () => {
  const src = read('src/main/pty.ts');
  assert.match(src, /resize\(id: string, cols: number, rows: number\)[^]*?s\.repaintUntil = repaintEchoUntil\(Date\.now\(\)\);\s*s\.proc\.resize\(cols, rows\)/);
  assert.match(src, /redraw\(id: string\)[^]*?s\.repaintUntil = repaintEchoUntil\(Date\.now\(\)\);\s*s\.proc\.resize\(s\.proc\.cols, s\.proc\.rows\)/);
  assert.match(src, /if \(!isRepaintEcho\(session\.repaintUntil, Date\.now\(\)\)\) session\.lastOutputAt = Date\.now\(\);/);
  assert.equal((src.match(/session\.lastOutputAt = /g) ?? []).length, 1, 'no other path bumps it');
});

test('terminal view: every resize goes through the pool, and a repaint skips the stream parser', () => {
  const pool = read('src/renderer/src/components/terminalPool.ts');
  const view = read('src/renderer/src/components/PtyTerminalView.tsx');
  assert.match(pool, /if \(!isRepaintEcho\(entry\.repaintUntil, Date\.now\(\)\)\) entry\.onData\?\.\(chunk\);/);
  assert.match(pool, /entry\.repaintUntil = repaintEchoUntil\(Date\.now\(\)\);\s*return window\.cth\.redrawPty\(entry\.ptyId\);/);
  // The only direct resize call left is inside resizePtyToTerminal, which marks it.
  assert.equal((pool.match(/window\.cth\.resizePty\(/g) ?? []).length, 1);
  assert.match(pool, /export function resizePtyToTerminal[^]*?entry\.repaintUntil = repaintEchoUntil\(Date\.now\(\)\);\s*void window\.cth\.resizePty\(/);
  assert.doesNotMatch(view, /window\.cth\.resizePty\(/);
});
