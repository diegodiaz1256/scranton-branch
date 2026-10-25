'use strict';

// Clear on a switch of work: the switch detection (shared/workSwitch.ts), the
// minimum-session rule, the handoff → clear → resume flow (main/workSwitch.ts)
// and the defaults for new and existing installs (shared/triggers.ts).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { detectWorkSwitches, sessionOldEnough, isWorkSwitchMessage, fallbackHandoff } = loadTs('src/shared/workSwitch.ts');
const { WorkSwitchClearer, HANDOFF_WAIT_MS } = loadTs('src/main/workSwitch.ts');
const { DEFAULT_CONTEXT_TRIGGER, workSwitchRuleFor } = loadTs('src/shared/triggers.ts');

const card = (id, assignee, status, extra = {}) => ({ id, title: `Task ${id}`, assignee, status, ...extra });

// ── switch detection ─────────────────────────────────────────────────────────

test('the first reading of the ledger only learns where everyone is', () => {
  const r = detectWorkSwitches({}, null, [card('A', 'dev', 'doing')]);
  assert.deepEqual(r.switches, []);
  assert.equal(r.current.dev, 'A');
});

test('finishing A and starting B is a switch', () => {
  const prev = [card('A', 'dev', 'doing'), card('B', 'dev', 'todo')];
  const next = [card('A', 'dev', 'done'), card('B', 'dev', 'doing')];
  const r = detectWorkSwitches({}, prev, next);
  assert.deepEqual(r.switches, [{ agentId: 'dev', from: 'A', to: 'B' }]);
  assert.equal(r.current.dev, 'B');
});

test('a new card handed to an agent whose last card is done is a switch (the dispatch)', () => {
  const prev = [card('A', 'dev', 'done')];
  const next = [card('A', 'dev', 'done'), card('B', 'dev', 'todo')];
  const r = detectWorkSwitches({ dev: 'A' }, prev, next);
  assert.deepEqual(r.switches, [{ agentId: 'dev', from: 'A', to: 'B' }]);
});

test('an agent still doing its card has not switched, whatever else it picks up', () => {
  const prev = [card('A', 'dev', 'doing')];
  const next = [card('A', 'dev', 'doing'), card('B', 'dev', 'doing'), card('C', 'dev', 'todo')];
  const r = detectWorkSwitches({}, prev, next);
  assert.deepEqual(r.switches, []);
  assert.equal(r.current.dev, 'A');
});

test('a parent and its own subtask are the same work', () => {
  const prev = [card('P', 'dev', 'doing')];
  const next = [card('P', 'dev', 'blocked'), card('S', 'dev', 'doing', { parent: 'P' })];
  assert.deepEqual(detectWorkSwitches({}, prev, next).switches, []);
});

test('a card it already held alongside the finished one is not new work', () => {
  const prev = [card('A', 'dev', 'doing'), card('B', 'dev', 'doing')];
  const next = [card('A', 'dev', 'done'), card('B', 'dev', 'doing')];
  const r = detectWorkSwitches({ dev: 'A' }, prev, next);
  assert.deepEqual(r.switches, []);
  assert.equal(r.current.dev, 'B');
});

test('an assignee written as a name resolves to the agent id; unknown ones are ignored', () => {
  const ids = { 'jim halpert': 'jim', jim: 'jim' };
  const of = (a) => ids[a.toLowerCase()] ?? null;
  const prev = [card('A', 'Jim Halpert', 'doing'), card('X', 'nobody', 'doing')];
  const next = [card('A', 'Jim Halpert', 'done'), card('B', 'jim', 'doing'), card('X', 'nobody', 'done'), card('Y', 'nobody', 'doing')];
  assert.deepEqual(detectWorkSwitches({}, prev, next, of).switches, [{ agentId: 'jim', from: 'A', to: 'B' }]);
});

test('in-progress spellings count as doing', () => {
  const prev = [card('A', 'dev', 'in_progress')];
  const next = [card('A', 'dev', 'done'), card('B', 'dev', 'In Progress')];
  assert.deepEqual(detectWorkSwitches({}, prev, next).switches, [{ agentId: 'dev', from: 'A', to: 'B' }]);
});

// ── the minimum-session rule ────────────────────────────────────────────────

test('the 60-minute rule: 59 minutes is too young, 60 is old enough', () => {
  const hour = 3_600_000;
  assert.equal(sessionOldEnough(0, hour - 60_000, hour), false);
  assert.equal(sessionOldEnough(0, hour, hour), true);
  assert.equal(sessionOldEnough(undefined, hour * 5, hour), false, 'an unknown session start is never old enough');
});

// ── the flow ─────────────────────────────────────────────────────────────────

function harness(over = {}) {
  let now = 10_000_000;
  const files = new Map();
  const queue = [];
  const withdrawn = [];
  const logs = [];
  const holds = [];
  const agent = { name: 'Dev', canWriteHandoff: true, clearCommand: '/clear', ...over.agent };
  const state = { busy: null, enabled: true, minSessionMs: 3_600_000 };
  const tasks = { A: card('A', 'dev', 'done', { description: 'Fix the login bug' }), B: card('B', 'dev', 'doing') };
  const c = new WorkSwitchClearer({
    now: () => now,
    rule: () => ({ enabled: state.enabled, minSessionMs: state.minSessionMs }),
    agent: (id) => (id === 'dev' ? agent : null),
    handoffPath: (id) => ({ host: `H:/agents/${id}/handoff.md`, agent: `/home/u/agents/${id}/handoff.md` }),
    inboxPath: (id) => `/home/u/agents/${id}/inbox`,
    standingPath: () => over.standing,
    fileMtime: (p) => (files.has(p) ? files.get(p).m : null),
    writeFile: (p, text) => files.set(p, { text, m: now }),
    busyReason: () => state.busy,
    task: (id) => tasks[id],
    taskHistory: () => ['2026-10-25T10:00:00Z: status todo → doing'],
    terminalTail: () => 'edited src/login.ts',
    recentlyFiled: () => ['/home/u/agents/dev/inbox/.done/order-B.json'],
    enqueue: (id, text) => queue.push({ id, text }),
    withdraw: (id, text) => withdrawn.push({ id, text }),
    holdNudges: (id, on) => holds.push(on),
    refreshLedger: () => over.refreshLedger?.(c),
    log: (l) => logs.push(l)
  });
  return {
    c, files, queue, withdrawn, logs, state, holds,
    advance: (ms) => { now += ms; },
    get now() { return now; }
  };
}

const SWITCH = [{ agentId: 'dev', from: 'A', to: 'B' }];

test('a session younger than the minimum is left alone', () => {
  const h = harness();
  h.c.noteSessionStart('dev', h.now);
  h.advance(59 * 60_000);
  h.c.onSwitches(SWITCH);
  h.c.tick();
  assert.deepEqual(h.queue, []);
});

test('a switch skipped for a young session says so in the log', () => {
  const h = harness();
  h.c.noteSessionStart('dev', h.now);
  h.advance(20 * 60_000);
  h.c.onSwitches(SWITCH);
  assert.deepEqual(h.queue, []);
  assert.ok(h.logs.some((l) => /dev moved A → B; not cleared, its session is 20 min old \(minimum 60 min\)/.test(l)), h.logs.join('\n'));
});

// The orchestrator moves the card and sends the work order at the same moment.
// The periodic ledger read has not seen the move yet when the inbox nudge is
// about to go out: the nudge must re-read the ledger and wait for the handoff,
// or the agent does B in the session that is about to be cleared.
function simultaneous(over = {}) {
  const board = { prev: [card('A', 'dev', 'doing'), card('B', 'dev', 'todo')], now: null, current: {} };
  board.read = (c) => {
    if (!board.now) return;
    const r = detectWorkSwitches(board.current, board.prev, board.now);
    board.current = r.current;
    board.prev = board.now;
    board.now = null;
    c.onSwitches(r.switches);
  };
  const h = harness({ ...over, refreshLedger: board.read });
  board.read(h.c); // the periodic read learned where everyone is
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  // Card move and work order land together; no periodic read in between.
  board.now = [card('A', 'dev', 'done'), card('B', 'dev', 'doing')];
  return h;
}

test('a nudge sent with the card move waits for the handoff instead of reaching the old session', () => {
  const h = simultaneous();
  assert.equal(h.c.beforeNudge('dev'), true, 'the nudge is held');
  assert.equal(h.queue.length, 1);
  assert.ok(isWorkSwitchMessage(h.queue[0].text), 'the handoff request goes out instead');
  assert.equal(h.c.holdsNudges('dev'), true);
  // Still asking: later nudges wait too.
  h.advance(4000);
  assert.equal(h.c.beforeNudge('dev'), true);
  // The note is written; the next nudge queues the clear and the resume at once
  // (not on the next tick), and is itself not needed: the resume names the inbox.
  h.files.set('H:/agents/dev/handoff.md', { text: '# note', m: h.now });
  h.advance(1000);
  assert.equal(h.c.beforeNudge('dev'), true);
  assert.deepEqual(h.queue.slice(1).map((m) => m.text.split(' ')[0]), ['/clear', '[work']);
  assert.match(h.queue[2].text, /inbox/);
  // A new session with no switch: nudges go out as usual.
  assert.equal(h.c.beforeNudge('dev'), false);
});

test('the same race on an engine that cannot be asked: note, clear and resume before the nudge', () => {
  const h = simultaneous({ agent: { canWriteHandoff: false, clearCommand: '/new' } });
  assert.equal(h.c.beforeNudge('dev'), true);
  assert.ok(h.files.get('H:/agents/dev/handoff.md'), 'the app wrote the note');
  assert.deepEqual(h.queue.map((m) => m.text.split(' ')[0]), ['/new', '[work']);
});

test('a nudge with no switch on the board, or one deferred on a sign-off, still goes out', () => {
  // Nothing moved on the board.
  const quiet = harness({ refreshLedger: () => {} });
  quiet.c.noteSessionStart('dev', quiet.now);
  quiet.advance(2 * 3_600_000);
  assert.equal(quiet.c.beforeNudge('dev'), false);
  assert.deepEqual(quiet.queue, []);
  // Note written, but a rejection from the human must still reach it.
  const h = simultaneous();
  assert.equal(h.c.beforeNudge('dev'), true);
  h.files.set('H:/agents/dev/handoff.md', { text: '# note', m: h.now });
  h.state.busy = "waiting for the human's sign-off";
  h.advance(1000);
  assert.equal(h.c.beforeNudge('dev'), false);
});

test('a young session is not held up by the race check', () => {
  const h = simultaneous();
  h.c.noteSessionStart('dev', h.now - 10 * 60_000);
  assert.equal(h.c.beforeNudge('dev'), false);
  assert.deepEqual(h.queue, []);
});

test('handoff first, then clear and resume once the note is written', () => {
  const h = harness();
  h.c.noteSessionStart('dev', h.now);
  h.advance(61 * 60_000);
  h.c.onSwitches(SWITCH);
  assert.equal(h.queue.length, 1);
  assert.ok(isWorkSwitchMessage(h.queue[0].text));
  assert.match(h.queue[0].text, /\/home\/u\/agents\/dev\/handoff\.md/);
  assert.match(h.queue[0].text, /Task A/);
  // Nothing more until the note exists.
  h.advance(5000); h.c.tick();
  assert.equal(h.queue.length, 1);
  h.files.set('H:/agents/dev/handoff.md', { text: '# note', m: h.now });
  h.advance(5000); h.c.tick();
  assert.deepEqual(h.queue.slice(1).map((m) => m.text.split(' ')[0]), ['/clear', '[work']);
  const resume = h.queue[2].text;
  assert.match(resume, /handoff\.md/);
  assert.match(resume, /inbox/);
  assert.match(resume, /order-B\.json/, 'mail filed while switching is named, so a work order is never lost');
  assert.equal(h.c.isPending('dev'), false);
  assert.equal(h.c.sessionStartedAt('dev'), h.now, 'the clear starts a new session');
});

test('inbox nudges are held only while the agent is asked for its note', () => {
  const h = harness();
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  h.c.onSwitches(SWITCH);
  assert.equal(h.c.holdsNudges('dev'), true);
  assert.deepEqual(h.holds, [true]);
  h.files.set('H:/agents/dev/handoff.md', { text: '# note', m: h.now });
  h.state.busy = 'outbox not sent yet';
  h.advance(5000); h.c.tick();
  // Deferred on in-flight work: its inbox (a sign-off rejection, say) must reach it.
  assert.equal(h.c.holdsNudges('dev'), false);
  assert.deepEqual(h.holds, [true, false]);
});

test('an old handoff.md from before the request does not count as written', () => {
  const h = harness();
  h.files.set('H:/agents/dev/handoff.md', { text: 'old', m: h.now - 3_600_000 });
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  h.c.onSwitches(SWITCH);
  h.advance(5000); h.c.tick();
  assert.equal(h.queue.length, 1);
});

test('nothing is cleared while a sign-off or an unsent outbox item is in flight', () => {
  const h = harness();
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  h.c.onSwitches(SWITCH);
  h.files.set('H:/agents/dev/handoff.md', { text: '# note', m: h.now });
  h.state.busy = "waiting for the human's sign-off";
  h.advance(5000); h.c.tick();
  assert.equal(h.queue.length, 1, 'the clear waits');
  h.state.busy = null;
  h.advance(5000); h.c.tick();
  assert.equal(h.queue[1].text, '/clear');
});

test('an engine that cannot be asked gets a note from the app, then the clear', () => {
  const h = harness({ agent: { canWriteHandoff: false, clearCommand: '/new' }, standing: '/home/u/agents/dev/session-prompt.md' });
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  h.c.onSwitches(SWITCH);
  const note = h.files.get('H:/agents/dev/handoff.md');
  assert.ok(note, 'the app wrote handoff.md');
  assert.match(note.text, /Fix the login bug/);
  assert.match(note.text, /edited src\/login\.ts/);
  h.c.tick();
  assert.equal(h.queue[0].text, '/new');
  assert.match(h.queue[1].text, /session-prompt\.md/, 'engines whose instructions were the first prompt are pointed back at them');
});

test('no note in time: the request is taken back and the app writes one', () => {
  const h = harness();
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  h.c.onSwitches(SWITCH);
  h.advance(HANDOFF_WAIT_MS); h.c.tick();
  assert.equal(h.withdrawn.length, 1);
  assert.match(h.files.get('H:/agents/dev/handoff.md').text, /did not write its own note in time/);
  assert.equal(h.queue[1].text, '/clear');
});

test('god, engines without a clear command, and a disabled rule are left alone', () => {
  for (const over of [{ agent: { isGod: true } }, { agent: { clearCommand: null } }]) {
    const h = harness(over);
    h.c.noteSessionStart('dev', h.now);
    h.advance(2 * 3_600_000);
    h.c.onSwitches(SWITCH);
    h.c.tick();
    assert.deepEqual(h.queue, []);
  }
  const h = harness();
  h.state.enabled = false;
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  h.c.onSwitches(SWITCH);
  assert.deepEqual(h.queue, []);
});

test('turning the rule off mid hand-off takes the request back', () => {
  const h = harness();
  h.c.noteSessionStart('dev', h.now);
  h.advance(2 * 3_600_000);
  h.c.onSwitches(SWITCH);
  h.state.enabled = false;
  h.c.tick();
  assert.equal(h.withdrawn.length, 1);
  assert.equal(h.c.isPending('dev'), false);
});

test('the fallback note says where it came from', () => {
  const text = fallbackHandoff({
    agentName: 'Dev', from: card('A', 'dev', 'done'), fromId: 'A', to: undefined, toId: 'B',
    history: [], terminalTail: '', at: new Date(0), reason: 'no-hooks'
  });
  assert.match(text, /^# Handoff: Task A/);
  assert.match(text, /Written by the app/);
  assert.match(text, /Moved to task `B`/);
});

// ── defaults: on for new installs, existing configs keep their settings ─────

test('new installs get the rule on, at 60 minutes', () => {
  assert.deepEqual(DEFAULT_CONTEXT_TRIGGER.workSwitch, { enabled: true, minSessionMs: 3_600_000 });
  assert.equal(workSwitchRuleFor(DEFAULT_CONTEXT_TRIGGER, false).enabled, true);
  assert.equal(workSwitchRuleFor(undefined, false).enabled, true);
});

test('a config saved before the rule existed keeps its trigger settings: off', () => {
  const saved = { compact: DEFAULT_CONTEXT_TRIGGER.compact, clear: DEFAULT_CONTEXT_TRIGGER.clear };
  assert.equal(workSwitchRuleFor(saved, true).enabled, false);
  assert.equal(workSwitchRuleFor(undefined, true).enabled, false, 'a config with no triggers at all is an existing install too');
});

test('a saved choice is kept, and the minimum is clamped', () => {
  assert.deepEqual(workSwitchRuleFor({ workSwitch: { enabled: true, minSessionMs: 1800_000 } }, true), { enabled: true, minSessionMs: 1800_000 });
  assert.equal(workSwitchRuleFor({ workSwitch: { enabled: false } }, false).enabled, false);
  assert.equal(workSwitchRuleFor({ workSwitch: { enabled: true, minSessionMs: 5 } }, true).minSessionMs, 60_000);
});
