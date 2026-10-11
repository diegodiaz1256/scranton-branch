'use strict';
// The 8 s fleet snapshot froze the main process for 4.8 s once on a slow disk
// (freezes.jsonl: "interval writeFleetSnapshot"). Its disk work is async now:
// the inbox counts and the write match the sync versions.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

test('async inbox count and snapshot write match the sync ones', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fleet-async-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const inbox = path.join(hive.agentDir('jim-1'), 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  for (const f of ['a.json', 'b.json', 'note.txt']) fs.writeFileSync(path.join(inbox, f), '{}');

  assert.equal(await hive.inboxBacklogAsync('jim-1'), 2);
  assert.equal(await hive.inboxBacklogAsync('jim-1'), hive.inboxBacklog('jim-1'));
  assert.equal(await hive.inboxBacklogAsync('nobody'), 0);

  const snap = { ts: 1, agents: [{ id: 'jim-1', inboxBacklog: 2 }] };
  await hive.writeFleetSnapshotAsync(snap);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hive.root(), 'fleet.json'), 'utf8')), snap);
});

test('the timer runs one pass at a time and keeps the disk work async', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /if \(!hive\.enabled\(\) \|\| fleetBusy\) return;/);
  assert.match(src, /hive\.inboxBacklogAsync\(id\)/);
  assert.match(src, /await hive\.writeFleetSnapshotAsync\(/);
  assert.doesNotMatch(src, /inboxBacklog: hive\.inboxBacklog\(id\)/);
});
