'use strict';
// Mail to an archived agent reaches its live namesake, or the sender hears who
// is around instead.
//
// Seen live: registry.json held ~20 archived "Jim - Jira Manager" entries next
// to the one live Jim. An agent that remembered an old id kept mailing it; the
// mail was filed in a dead inbox and the sender was told only when the message
// asked for a reply, so an inform or a done simply vanished. Now:
//  - exactly one live agent with the same name: the mail goes to it, and the
//    sender is told the live id so it stops using the old one;
//  - none or several: the mail is filed as before and the sender is told for
//    every act, with the live agents of a similar name to pick from;
//  - archived entries a live namesake replaced are flagged `supersededBy` at
//    boot (their folders and history stay), so readers of registry.json can
//    skip them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { liveNamesakes, similarLive, supersededArchived, normName } = loadTs('src/main/namesakes.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-namesake-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  for (const id of ['jim-old1', 'jim-old2', 'jim-live']) {
    await hive.ensureAgent({ id, name: 'Jim - Jira Manager', provider: 'claude', cwd: home });
  }
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  hive.setArchived('jim-old1', true);
  hive.setArchived('jim-old2', true);
  return { home, hive };
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

test('names compare loosely; namesakes and similar names are found among live agents only', () => {
  assert.equal(normName('  Jim  –  Jira   Manager '), 'jim - jira manager');
  const agents = {
    a: { name: 'Jim - Jira Manager', archived: true },
    b: { name: 'jim - jira manager' },
    c: { name: 'Jim - Jira Manager', archived: true },
    d: { name: 'Jim Halpert' },
    e: { name: 'Jim - Jira Manager', isAssistant: true },
    f: { name: 'Pam' }
  };
  assert.deepEqual(liveNamesakes(agents, 'a'), ['b']);
  assert.deepEqual(similarLive(agents, 'a'), ['b', 'd'], 'same name first, then the same first word');
  assert.deepEqual(supersededArchived(agents), { a: 'b', c: 'b' });
  agents.g = { name: 'JIM - JIRA MANAGER' };
  assert.deepEqual(supersededArchived(agents), {}, 'two live namesakes: no single successor');
});

test('mail to an archived id with one live namesake is re-routed there and the sender learns the live id', async (t) => {
  const { hive } = await floor(t);
  const sent = hive.send({ to: 'jim-old1', act: 'inform', subject: 'sprint closed', body: 'FYI' }, 'pam-1');

  assert.equal(hive.inbox('jim-old1').length, 0, 'nothing rots in the dead inbox');
  const [got] = hive.inbox('jim-live');
  assert.ok(got, 'the live Jim has it');
  assert.equal(got.subject, 'sprint closed');
  assert.equal(got.from, 'pam-1');

  const [notice] = hive.inbox('pam-1');
  assert.ok(notice, 'the sender is told, even for an inform');
  assert.equal(notice.from, 'system');
  assert.equal(notice.requires_reply, false);
  assert.equal(notice.in_reply_to, sent.id);
  assert.match(notice.subject, /"jim-old1" is archived — delivered to "jim-live"/);
  assert.match(notice.body, /use jim-live/);

  const [logged] = entries(hive, 'archived-recipient');
  assert.equal(logged.reroutedTo, 'jim-live');
  const [routed] = entries(hive, 'message').filter((e) => e.id === sent.id);
  assert.deepEqual(routed.delivered, ['jim-live']);
});

test('no single namesake: filed, and the sender is told for every act with who is around', async (t) => {
  const { hive, home } = await floor(t);
  await hive.ensureAgent({ id: 'jim-live2', name: 'Jim - Jira Manager', provider: 'claude', cwd: home });
  hive.send({ to: 'jim-old1', act: 'done', subject: 'closing', body: '' }, 'pam-1');
  assert.equal(hive.inbox('jim-old1').length, 1, 'filed in its inbox, as before');
  const [notice] = hive.inbox('pam-1');
  assert.ok(notice, 'a done is no longer filed silently');
  assert.match(notice.subject, /no one is there to answer — "jim-old1" is archived/);
  assert.match(notice.body, /jim-live "Jim - Jira Manager"/);
  assert.match(notice.body, /jim-live2 "Jim - Jira Manager"/);
  assert.equal(hive.inbox('jim-live').length + hive.inbox('jim-live2').length, 0, 'not guessed between two');
});

test('nobody of that name is left: the notice says so', async (t) => {
  const { hive } = await floor(t);
  hive.setArchived('jim-live', true);
  hive.send({ to: 'jim-old2', act: 'inform', subject: 'hello', body: '' }, 'pam-1');
  const [notice] = hive.inbox('pam-1');
  assert.ok(notice);
  assert.match(notice.body, /No live agent has a similar name/);
});

test('a sender mailing its own old id, the UI and archived senders get no notice loop', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'jim-old1', act: 'request', subject: 'note to self', body: '' }, 'jim-live');
  assert.equal(hive.inbox('jim-live').filter((m) => m.from === 'system').length, 1, 'told once; not re-routed to itself');
  assert.equal(hive.inbox('jim-old1').length, 1, 'filed instead');
  hive.send({ to: 'jim-old1', act: 'inform', subject: 'from the UI', body: '' }, 'system');
  assert.equal(hive.inbox('jim-live').filter((m) => m.subject === 'from the UI').length, 1, 're-routed; there is no one to notify');
});

test('archived entries a live namesake replaced are flagged supersededBy, and keep their folders', async (t) => {
  const { hive, home } = await floor(t);
  // jim-live was spawned while the old ones were still live, so nothing is
  // flagged yet: the sweep catches up.
  assert.deepEqual(hive.markSuperseded(), { 'jim-old1': 'jim-live', 'jim-old2': 'jim-live' });
  assert.deepEqual(hive.markSuperseded(), {}, 'idempotent');
  const reg = hive.registry();
  assert.equal(reg.agents['jim-old1'].supersededBy, 'jim-live');
  assert.equal(reg.agents['jim-live'].supersededBy, undefined);
  assert.ok(fs.existsSync(path.join(hive.root(), 'agents', 'jim-old1')), 'history is kept');

  // The usual order: the successor is (re)spawned after the old ones were archived.
  await hive.ensureAgent({ id: 'dwight-old', name: 'Dwight', provider: 'claude', cwd: home });
  hive.setArchived('dwight-old', true);
  await hive.ensureAgent({ id: 'dwight-new', name: 'Dwight', provider: 'claude', cwd: home });
  assert.equal(hive.registry().agents['dwight-old'].supersededBy, 'dwight-new', 'flagged by the spawn itself');

  // A successor that is just not running (app quit) un-supersedes no one.
  hive.setArchived('jim-live', true);
  hive.markSuperseded();
  assert.equal(hive.registry().agents['jim-old2'].supersededBy, 'jim-live');

  // Restoring an old one lifts its own flag.
  await hive.ensureAgent({ id: 'jim-old1', name: 'Jim - Jira Manager', provider: 'claude', cwd: home });
  assert.equal(hive.registry().agents['jim-old1'].supersededBy, undefined, 'a respawn is live again');
});
