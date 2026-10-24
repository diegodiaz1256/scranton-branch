'use strict';
// The human edits / cancels task cards from the app (src/shared/taskEdit.ts,
// HiveManager.editTasks). Before this, a hive task could not be edited or
// cancelled at all, and nothing told the agent on it to stop.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { taskEditPatch, taskEditNotices, mergeTaskNotices, isTaskStatus } = loadTs('src/shared/taskEdit.ts');
const { diffTasks, snapshotOf } = loadTs('src/shared/taskHistory.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const card = (id, extra = {}) => ({ id, title: id, status: 'todo', dependsOn: [], priority: 3, createdAt: '2026-10-24T08:00:00.000Z', ...extra });

test('cancelled is a status; unknown ones are not', () => {
  assert.equal(isTaskStatus('cancelled'), true);
  assert.equal(isTaskStatus('done'), true);
  assert.equal(isTaskStatus('archived'), false);
});

test('an edit patches only what changed, and null clears a field', () => {
  const ledger = [card('a', { title: 'Old', description: 'keep', assignee: 'jim', parent: 'p' }), card('p')];
  const res = taskEditPatch(ledger, 'a', { title: ' New ', description: 'keep', assignee: '', parent: null, ticket: 'JIRA-7' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.patch, { title: 'New', assignee: null, parent: null, ticket: 'JIRA-7' });
});

test('cancelling stamps cancelledAt; reopening clears it', () => {
  const ledger = [card('a', { status: 'doing' })];
  const cancel = taskEditPatch(ledger, 'a', { status: 'cancelled' }, undefined, '2026-10-24T09:00:00.000Z');
  assert.deepEqual(cancel.patch, { status: 'cancelled', cancelledAt: '2026-10-24T09:00:00.000Z' });
  const reopen = taskEditPatch([card('a', { status: 'cancelled', cancelledAt: 'x' })], 'a', { status: 'todo' });
  assert.deepEqual(reopen.patch, { status: 'todo', cancelledAt: null });
});

test('bad edits are refused with a reason', () => {
  const ledger = [card('a'), card('b', { parent: 'a' }), card('c', { parent: 'b' }), card('d', { ticket: 'JIRA-1' })];
  const keyOf = (id) => ({ a: 'dun-1', b: 'dun-2', c: 'dun-3', d: 'dun-4' })[id];
  const err = (id, edit) => taskEditPatch(ledger, id, edit, keyOf).error;
  assert.equal(err('zzz', { title: 'x' }), 'notFound');
  assert.equal(err('a', { title: '   ' }), 'emptyTitle');
  assert.equal(err('a', { status: 'archived' }), 'badStatus');
  assert.equal(err('a', { ticket: 'has space' }), 'badTicket');
  assert.equal(err('a', { ticket: 'dun-2' }), 'ticketTaken', 'a generated key another card shows');
  assert.equal(err('a', { ticket: 'jira-1' }), 'ticketTaken', 'a ticket another card has, any case');
  assert.equal(err('a', { parent: 'a' }), 'parentSelf');
  assert.equal(err('a', { parent: 'nope' }), 'parentMissing');
  assert.equal(err('a', { parent: 'c' }), 'parentLoop', 'a subtask of a subtask');
  assert.equal(taskEditPatch(ledger, 'a', { ticket: 'dun-1' }, keyOf).ok, true, 'its own generated key is fine');
});

test('cancel: the assignee is told to stop, god is told to keep it cancelled', () => {
  const before = card('a', { title: 'Migrate', status: 'doing', assignee: 'dwight' });
  const notices = taskEditNotices(before, { ...before, status: 'cancelled' }, { godId: 'god', ticket: 'dun-3', name: (x) => x.toUpperCase() });
  assert.deepEqual(notices.map((n) => n.to), ['dwight', 'god']);
  assert.match(notices[0].subject, /^Task cancelled: dun-3 "Migrate"$/);
  assert.match(notices[0].body, /Stop working on it now/);
  assert.match(notices[0].body, /dun-3 \(id a\)/, 'names the card by ticket and id, so the timeline links it');
  assert.match(notices[1].body, /DWIGHT, who has been told to stop/);
  assert.match(notices[1].body, /do not dispatch it again/);
});

test('reassign: the old owner stops, god dispatches to the new one', () => {
  const before = card('a', { status: 'doing', assignee: 'jim' });
  const notices = taskEditNotices(before, { ...before, assignee: 'pam' }, { godId: 'god' });
  assert.deepEqual(notices.map((n) => n.to), ['jim', 'god']);
  assert.match(notices[0].body, /reassigned task a "a" to pam\. It is no longer yours\./);
  assert.match(notices[1].body, /from jim to pam\. Dispatch it to them/);
});

test('editing the contract tells the owner; parked or done cards only tell god', () => {
  const doing = card('a', { status: 'doing', assignee: 'jim', description: 'old' });
  const live = taskEditNotices(doing, { ...doing, description: 'new' }, { godId: 'god' });
  assert.deepEqual(live.map((n) => n.to), ['jim', 'god']);
  assert.match(live[0].body, /Description:\nnew/);

  const parked = card('b', { status: 'backlog', assignee: 'jim' });
  assert.deepEqual(taskEditNotices(parked, { ...parked, status: 'cancelled' }, { godId: 'god' }).map((n) => n.to), ['god']);
  const ticketOnly = taskEditNotices(doing, { ...doing, ticket: 'JIRA-9' }, { godId: 'god' });
  assert.deepEqual(ticketOnly.map((n) => n.to), ['god'], 'a new ticket is no news to the worker');
  assert.deepEqual(taskEditNotices(doing, { ...doing }, { godId: 'god' }), [], 'nothing changed, nobody told');
});

test('a card god holds itself gets one notice, not two', () => {
  const before = card('a', { status: 'doing', assignee: 'god' });
  const notices = taskEditNotices(before, { ...before, status: 'cancelled' }, { godId: 'god' });
  assert.deepEqual(notices.map((n) => n.to), ['god']);
  assert.match(notices[0].body, /It was yours: stop working on it\./);
});

test('notices to one agent merge into a single message', () => {
  const merged = mergeTaskNotices([
    { to: 'jim', subject: 'Task cancelled: dun-1 "A"', body: 'stop A' },
    { to: 'god', subject: 'x', body: 'y' },
    { to: 'jim', subject: 'Task cancelled: dun-2 "B"', body: 'stop B' }
  ]);
  assert.deepEqual(merged.map((n) => n.to), ['jim', 'god']);
  assert.equal(merged[0].subject, '2 task changes from the human: dun-1, dun-2');
  assert.match(merged[0].body, /stop A[\s\S]*stop B/);
});

test('history: an edit is an event; an old snapshot without the fields is not', () => {
  const prev = [snapshotOf(card('a', { description: 'one' }))];
  const next = [snapshotOf(card('a', { description: 'two', ticket: 'JIRA-1', status: 'cancelled' }))];
  const ev = diffTasks(prev, next, '2026-10-24T10:00:00Z');
  assert.deepEqual(ev.map((e) => e.kind), ['status', 'edited']);
  assert.equal(ev[0].to, 'cancelled');
  assert.deepEqual(ev[1].fields, ['description', 'ticket']);
  const legacy = [{ id: 'a', title: 'a', status: 'todo' }];
  assert.deepEqual(diffTasks(legacy, [snapshotOf(card('a', { description: 'x' }))], 'now').map((e) => e.kind), []);
});

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-edit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'dwight', name: 'Dwight', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home });
  return hive;
}

test('editTasks writes the ledger once and lands the notices in the inboxes', async (t) => {
  const hive = await floor(t);
  hive.writeTasks([
    card('plan', { title: 'Plan v2', status: 'doing', assignee: 'god-1', slack: { channel: 'C1', thread_ts: '1' } }),
    card('schema', { title: 'Migrate', status: 'doing', assignee: 'dwight', parent: 'plan' }),
    card('ui', { title: 'Invoice list', status: 'todo', assignee: 'dwight', parent: 'plan' })
  ]);
  const res = hive.editTasks([
    { id: 'plan', edit: { status: 'cancelled' } },
    { id: 'schema', edit: { status: 'cancelled' } },
    { id: 'ui', edit: { status: 'cancelled' } }
  ]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.notified.sort(), ['dwight', 'god-1']);

  const tasks = hive.tasks().tasks;
  assert.deepEqual(tasks.map((x) => x.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.ok(tasks.every((x) => typeof x.cancelledAt === 'string'));
  assert.deepEqual(tasks[0].slack, { channel: 'C1', thread_ts: '1' }, 'fields the app does not model survive');

  const [toDwight] = hive.inbox('dwight');
  assert.equal(toDwight.from, 'human');
  assert.equal(toDwight.act, 'inform');
  assert.equal(toDwight.requires_reply, false);
  assert.match(toDwight.subject, /^2 task changes from the human: /, 'one message for both of his cards');
  assert.match(toDwight.body, /Stop working on it now/);
  assert.equal(hive.inbox('jim').length, 0, 'an uninvolved agent hears nothing');
  assert.equal(hive.inbox('god-1').length, 1);
});

test('one bad edit in a batch changes nothing', async (t) => {
  const hive = await floor(t);
  hive.writeTasks([card('a', { assignee: 'jim' }), card('b')]);
  const res = hive.editTasks([{ id: 'a', edit: { status: 'cancelled' } }, { id: 'b', edit: { parent: 'b' } }]);
  assert.deepEqual(res, { ok: false, error: 'parentSelf', id: 'b' });
  assert.equal(hive.tasks().tasks[0].status, 'todo');
  assert.equal(hive.inbox('jim').length, 0);
});
