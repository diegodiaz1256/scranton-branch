'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  acceptsBracketedPaste,
  pastePayload,
  preEnterDelayMs,
  submitProbe,
  inputAreaText,
  inputAreaHas,
  submitAndVerify,
  showsUsageLimit
} = loadTs('src/shared/ptySubmit.ts');
const { inboxNudgeText, queueInsertIndex } = loadTs('src/shared/hiveNudge.ts');
const { terminalAutomationBlock } = loadTs('src/renderer/src/components/terminalAutomation.ts');

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * A model of Claude Code's input box, as measured in WSL (Claude Code 2.1.x):
 *  - a bracketed paste lands as text, and an Enter after the closing bracket
 *    submits, even in the same read;
 *  - several typed characters arriving in ONE read are taken as a paste: a "\r"
 *    among them stays in the input as an invisible character;
 *  - an Enter with invisible characters in the input only removes them
 *    ("Removed 1 invisible character · review and press Enter to send").
 * The screen is the transcript, then the input box between two rules, with
 * the cursor on the input row.
 */
class FakeClaude {
  constructor() { this.input = ''; this.invisible = 0; this.sent = []; this.reads = []; }
  read(chunk) {
    this.reads.push(chunk);
    let rest = chunk;
    while (rest.length) {
      if (rest.startsWith(PASTE_START)) {
        const end = rest.indexOf(PASTE_END);
        this.input += rest.slice(PASTE_START.length, end).replace(/\r/g, '\n');
        rest = rest.slice(end + PASTE_END.length);
      } else if (rest === '\r') {
        this.enter();
        rest = '';
      } else {
        // Typed bytes in one read: a paste by heuristic, "\r" kept invisible.
        for (const ch of rest) {
          if (ch === '\r') this.invisible++;
          else this.input += ch;
        }
        rest = '';
      }
    }
  }
  enter() {
    if (this.invisible) { this.invisible = 0; return; }
    if (this.input.trim()) { this.sent.push(this.input); this.input = ''; }
  }
  rows() {
    const rows = [];
    for (const s of this.sent) rows.push(`❯ ${s}`, '', '● ok', '');
    rows.push('─'.repeat(60));
    // Wrap the input at 60 columns the way the TUI does.
    const text = this.input || '';
    const lines = [];
    for (let i = 0; i < Math.max(1, text.length); i += 56) lines.push(text.slice(i, i + 56));
    lines.forEach((l, i) => rows.push(`${i === 0 ? '❯ ' : '  '}${l}`));
    const cursor = rows.length - 1;
    rows.push('─'.repeat(60), '  ⏵⏵ bypass permissions on (shift+tab to cycle)');
    return { rows, cursor };
  }
}

/** PTY between the app and the fake. `stalled` = the main process was blocked
 *  between the app's writes, so everything written reaches the CLI as one read
 *  (what a choking machine and wsl.exe do to the old 140-300 ms gap). */
function harness(tui, { stalled = false } = {}) {
  let pending = '';
  const flush = () => { if (pending) { const c = pending; pending = ''; tui.read(c); } };
  let firstSleep = true;
  return {
    writes: [],
    write: async function (data) { this.writes.push(data); pending += data; },
    sleep: async (ms) => {
      const swallow = stalled && firstSleep; // the pre-Enter pause never happened
      firstSleep = false;
      if (!swallow || ms === 0) flush();
    },
    inputHas: (probe) => { flush(); const { rows, cursor } = tui.rows(); return inputAreaHas(inputAreaText(rows, cursor), probe); },
    end: flush
  };
}

/** The renderer's submit before this fix: raw single-line text, a pause, a lone
 *  Enter, no look at the screen. */
async function oldSubmit(io, text) {
  await io.write(text.includes('\n') ? `${PASTE_START}${text}${PASTE_END}` : text);
  await io.sleep(preEnterDelayMs(text));
  await io.write('\r');
  await io.sleep(250);
}

test('old submit: a stalled write leaves the nudge on the prompt and the next one is appended to it', async () => {
  const tui = new FakeClaude();
  const io = harness(tui, { stalled: true });
  await oldSubmit(io, inboxNudgeText(['a']));
  io.end();
  assert.equal(tui.sent.length, 0);
  assert.match(tui.input, /hive inbox/);
  // The drain thinks it delivered and types the next one onto the same line.
  const io2 = harness(tui, { stalled: true });
  await oldSubmit(io2, inboxNudgeText(['b']));
  io2.end();
  assert.equal(tui.sent.length, 0);
  assert.equal(tui.input.match(/You have new hive inbox/g).length, 2);
});

test('new submit: a stalled write still submits, because the text is bracketed', async () => {
  const tui = new FakeClaude();
  const io = harness(tui, { stalled: true });
  const verdict = await submitAndVerify(io, inboxNudgeText(['a']), 'claude');
  assert.equal(verdict, 'submitted');
  assert.equal(tui.sent.length, 1);
  assert.equal(tui.input, '');
});

test('new submit: an Enter that was eaten is pressed once more, and the text is never retyped', async () => {
  const tui = new FakeClaude();
  const io = harness(tui, { stalled: true });
  // A CLI without bracketed paste gets the raw text: the Enter rides in the
  // same read and is eaten; the second Enter clears the invisible char only.
  const verdict = await submitAndVerify(io, inboxNudgeText(['a']), 'custom');
  assert.equal(verdict, 'stuck');
  assert.equal(io.writes.filter((w) => w === '\r').length, 2);
  assert.equal(io.writes.filter((w) => w.includes('hive inbox')).length, 1);
  assert.match(tui.input, /hive inbox/);
});

test('new submit: a lost Enter is retried and the message goes through', async () => {
  const tui = new FakeClaude();
  let dropped = false;
  const io = harness(tui);
  const realRead = tui.read.bind(tui);
  tui.read = (chunk) => { if (chunk === '\r' && !dropped) { dropped = true; return; } realRead(chunk); };
  const verdict = await submitAndVerify(io, 'Brand new day: tell the team to start working.', 'claude');
  assert.equal(verdict, 'retried');
  assert.deepEqual(tui.sent, ['Brand new day: tell the team to start working.']);
});

/** A CLI that shows typed text but ignores Enter until it has finished
 *  starting (`deafEnters` Enters are dropped). */
function slowStart(deafEnters) {
  const tui = new FakeClaude();
  const realRead = tui.read.bind(tui);
  let dropped = 0;
  tui.read = (chunk) => { if (chunk === '\r' && dropped < deafEnters) { dropped++; return; } realRead(chunk); };
  return tui;
}

test('late Enter: a CLI that ignores the first two Enters still gets the text sent, with no retype', async () => {
  const tui = slowStart(3);
  const io = { ...harness(tui), humanActedAt: () => 0 };
  const verdict = await submitAndVerify(io, inboxNudgeText(['a']), 'claude');
  assert.equal(verdict, 'retried');
  assert.equal(tui.sent.length, 1);
  assert.equal(tui.input, '');
  assert.equal(io.writes.filter((w) => w === '\r').length, 4);
  assert.equal(io.writes.filter((w) => w.includes('hive inbox')).length, 1);
});

test('late Enter: never pressed once a person has touched the terminal', async () => {
  const tui = slowStart(5);
  let human = 0;
  const base = harness(tui);
  const io = { ...base, humanActedAt: () => human, now: () => 1000 };
  // The person starts typing after the app's two Enters.
  const sleep = base.sleep;
  let sleeps = 0;
  io.sleep = async (ms) => { if (ms >= 3000 && ++sleeps === 1) human = 2000; return sleep(ms); };
  const verdict = await submitAndVerify(io, inboxNudgeText(['a']), 'claude');
  assert.equal(verdict, 'stuck');
  assert.equal(io.writes.filter((w) => w === '\r').length, 2);
  assert.equal(tui.sent.length, 0);
});

test('late Enter: stuck after the last late Enter; a caller that cannot tell human input gets only two Enters', async () => {
  const tui = slowStart(99);
  const io = { ...harness(tui), humanActedAt: () => 0 };
  assert.equal(await submitAndVerify(io, inboxNudgeText(['a']), 'claude'), 'stuck');
  assert.equal(io.writes.filter((w) => w === '\r').length, 6);
  const io2 = harness(slowStart(99));
  assert.equal(await submitAndVerify(io2, inboxNudgeText(['a']), 'claude'), 'stuck');
  assert.equal(io2.writes.filter((w) => w === '\r').length, 2);
});

test('new submit: an unreadable screen falls back to the old fire-and-forget', async () => {
  const writes = [];
  const verdict = await submitAndVerify({
    write: async (d) => { writes.push(d); },
    sleep: async () => {},
    inputHas: () => null
  }, 'hello there', 'claude');
  assert.equal(verdict, 'unverified');
  assert.deepEqual(writes, [`${PASTE_START}hello there${PASTE_END}`, '\r']);
});

test('pastePayload: bracketed for CLIs that take it, raw for agy and slash commands, always for multi-line', () => {
  assert.equal(acceptsBracketedPaste('claude'), true);
  assert.equal(acceptsBracketedPaste('antigravity'), false);
  assert.equal(pastePayload('read your inbox', 'claude'), `${PASTE_START}read your inbox${PASTE_END}`);
  assert.equal(pastePayload('read your inbox', 'antigravity'), 'read your inbox');
  assert.equal(pastePayload('/compact keep the plan', 'claude'), '/compact keep the plan');
  assert.equal(pastePayload('a\nb', 'antigravity'), `${PASTE_START}a\nb${PASTE_END}`);
});

test('inputAreaText reads the input box only, not the transcript where a sent message is echoed', () => {
  const rows = [
    '❯ You have new hive inbox message(s) — at least: x',
    '● ok',
    '─'.repeat(40),
    '❯ ',
    '─'.repeat(40),
    '  ⏵⏵ bypass permissions on'
  ];
  assert.equal(inputAreaText(rows, 3), '');
  assert.equal(inputAreaHas(inputAreaText(rows, 3), submitProbe(inboxNudgeText(['x']))), false);
  const stuck = [
    '● ok',
    '─'.repeat(40),
    '❯ You have new hive inbox message(s) — at least:',
    '  2026-10-20T15-27-38-032Z-ced64f. Read your inbox',
    '─'.repeat(40)
  ];
  assert.equal(inputAreaHas(inputAreaText(stuck, 3), submitProbe(inboxNudgeText(['x']))), true);
  // Gemini-style box with side borders.
  const boxed = ['╭' + '─'.repeat(30) + '╮', '│ > hello world               │', '╰' + '─'.repeat(30) + '╯'];
  assert.equal(inputAreaText(boxed, 1), 'hello world');
});

test('submitProbe fits on one row and survives the TUI re-wrapping the text', () => {
  const probe = submitProbe(inboxNudgeText(['id']));
  assert.ok(probe.length <= 24);
  assert.equal(inputAreaHas('You have new hive\ninbox message(s)', probe), true);
});

test('showsUsageLimit recognises Claude Code limit stops (the strings from the field report)', () => {
  assert.equal(showsUsageLimit("You've hit your session limit · resets 8pm (Europe/Madrid)"), true);
  assert.equal(showsUsageLimit('Usage limit reached · continuing automatically at 8pm · esc to cancel'), true);
  assert.equal(showsUsageLimit('Automatic continue cancelled · /rate-limit-options to re-arm'), true);
  assert.equal(showsUsageLimit('91% of your session limit used'), false);
  assert.equal(showsUsageLimit('● ok'), false);
});

test('a stuck submit blocks automation and does not expire', () => {
  const ready = { exited: false, pickerOpen: false, inputDirty: false, settleUntil: 0 };
  assert.equal(terminalAutomationBlock({ ...ready, submitStuck: true }, 100), 'stuck');
  assert.equal(terminalAutomationBlock({ ...ready, submitStuck: true }, 100 + 24 * 3600_000), 'stuck');
  assert.equal(terminalAutomationBlock({ ...ready, exited: true, submitStuck: true }, 100), 'exited');
});

test("a person's message is queued ahead of a pending inbox nudge, never after it", () => {
  const nudge = { text: inboxNudgeText(['a']) };
  const human = { text: 'brand new day, tell the team to start' };
  assert.equal(queueInsertIndex([], false), 0);
  assert.equal(queueInsertIndex([human, nudge], false), 1);
  assert.equal(queueInsertIndex([nudge], true), 1);
  assert.equal(queueInsertIndex([{ ...nudge, manual: true }], false), 1);
});
