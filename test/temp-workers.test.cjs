'use strict';
// A temp is archived when its job is done — also after an app restart.
//
// Seen live: a finished temp stayed on the live roster for 3 days. Three gaps:
// (1) its done signal was ignored because the agent's `created_at` (written
// with the distro's clock/timezone on a WSL floor) read as earlier than the
// spawn; (2) Restore team brought it back after a restart as a regular agent,
// because the hiring lived only in main's memory; (3) the orchestrator had no
// way to let go of a temp it hired. The hiring is now persisted in the
// registry, done detection falls back to the file's mtime, and the
// orchestrator can archive its own temps through archive-requests/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { authoredAfter, latestDone, archiveRequestProblem, legacyTemps } = loadTs('src/main/tempWorkers.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write an outbox message the way an agent does, then stamp its mtime. */
function outboxMsg(agentDir, name, msg, mtimeMs, sub = '') {
  const dir = path.join(agentDir, 'outbox', sub);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, JSON.stringify(msg));
  if (mtimeMs !== undefined) fs.utimesSync(fp, mtimeMs / 1000, mtimeMs / 1000);
  return fp;
}

test('a created_at that reads as before the spawn falls back to the file mtime', () => {
  const spawnedAt = Date.parse('2026-10-24T10:00:00Z');
  const fresh = spawnedAt + 60_000;
  // An offset-less stamp from a distro two hours behind the host reads as earlier.
  assert.equal(authoredAfter('2026-10-24T08:01:00', fresh, spawnedAt), fresh);
  assert.equal(authoredAfter(undefined, fresh, spawnedAt), fresh, 'missing created_at → mtime (unchanged)');
  assert.equal(authoredAfter('garbage', fresh, spawnedAt), fresh, 'unparseable → mtime (unchanged)');
  const later = '2026-10-24T10:05:00Z';
  assert.equal(authoredAfter(later, fresh, spawnedAt), Date.parse(later), 'a usable created_at still wins');
});

test('a done left by a prior worker under the same id is still not counted', () => {
  const spawnedAt = Date.parse('2026-10-24T10:00:00Z');
  const old = spawnedAt - 3_600_000;
  assert.equal(authoredAfter('2026-10-23T09:00:00Z', old, spawnedAt), null);
  assert.equal(authoredAfter(undefined, old, spawnedAt), null);
  assert.equal(authoredAfter(undefined, Number.NaN, spawnedAt), null, 'no usable time → not counted');
});

test('latestDone finds a fresh done whose created_at is behind, in outbox and outbox/.sent', (t) => {
  const agentDir = tmp(t, 'md-temp-done-');
  const spawnedAt = Date.now() - 10 * 60_000;
  outboxMsg(agentDir, 'a.json', { act: 'inform', created_at: new Date().toISOString(), body: 'progress' });
  outboxMsg(agentDir, 'stale.json', { act: 'done', created_at: '2020-01-01T00:00:00Z', body: 'last time' }, spawnedAt - 86_400_000, '.sent');
  assert.equal(latestDone(agentDir, spawnedAt), null, 'only a stale done: not finished');

  const skewed = new Date(spawnedAt - 2 * 3_600_000).toISOString().slice(0, 19); // no offset, 2h behind
  const mtime = spawnedAt + 5 * 60_000;
  outboxMsg(agentDir, 'done.json', { act: 'done', created_at: skewed, body: 'report: shipped' }, mtime, '.sent');
  const done = latestDone(agentDir, spawnedAt);
  assert.ok(done, 'the done is seen');
  assert.equal(Math.round(done.at), Math.round(mtime));
  assert.equal(done.text, 'report: shipped');
});

test('the orchestrator may archive only a temp it hired', () => {
  const reg = {
    godId: 'god-1',
    agents: {
      'god-1': { id: 'god-1', name: 'Michael', cwd: '/', isGod: true, status: 'idle', lastSeen: 0 },
      'jim-1': { id: 'jim-1', name: 'Jim', cwd: '/', status: 'idle', lastSeen: 0 },
      'worker-a': { id: 'worker-a', name: 'A', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 'a', spawnedAt: 1, baseBranch: 'main', hiredBy: 'orchestrator' } },
      'worker-legacy': { id: 'worker-legacy', name: 'L', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 'legacy', spawnedAt: 1, baseBranch: 'main' } },
      'worker-temp-x': { id: 'worker-temp-x', name: 'H', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 'temp-x', spawnedAt: 1, baseBranch: 'main', hiredBy: 'human' } }
    }
  };
  assert.equal(archiveRequestProblem(reg, 'worker-a'), null);
  assert.equal(archiveRequestProblem(reg, 'worker-legacy'), null, 'no hiredBy = an orchestrator spawn-request');
  assert.match(archiveRequestProblem(reg, ''), /missing "id"/);
  assert.match(archiveRequestProblem(reg, 'nobody'), /no agent "nobody"/);
  assert.match(archiveRequestProblem(reg, 'god-1'), /yourself/);
  assert.match(archiveRequestProblem(reg, 'jim-1'), /not a temp/);
  assert.match(archiveRequestProblem(reg, 'worker-temp-x'), /hired by the human/);
});

test('temps hired before the hiring was persisted are rebuilt from spawn-requests/.done', (t) => {
  const doneDir = tmp(t, 'md-temp-legacy-');
  const reg = {
    godId: 'god-1',
    agents: {
      'worker-jira': { id: 'worker-jira', name: 'Jim - Jira Manager', cwd: '/', status: 'idle', lastSeen: 0 },
      'worker-marked': { id: 'worker-marked', name: 'M', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 'marked', spawnedAt: 5, baseBranch: 'dev' } },
      'worker-temp-k1': { id: 'worker-temp-k1', name: 'K', cwd: '/', status: 'idle', lastSeen: 0 }
    }
  };
  const write = (f, body, mtimeMs) => {
    const fp = path.join(doneDir, f);
    fs.writeFileSync(fp, JSON.stringify(body));
    fs.utimesSync(fp, mtimeMs / 1000, mtimeMs / 1000);
  };
  write('jira-old.json', { id: 'jira', objective: 'old sync', cwd: '/' }, 1_000_000);
  write('jira.json', { objective: 'triage the board', cwd: '/', tokenCap: 5000, slack: { channel: 'C1', thread_ts: '1.2' } }, 2_000_000);
  write('marked.json', { objective: 'x', cwd: '/' }, 3_000_000);
  write('temp-k1.json', { objective: 'y', cwd: '/' }, 4_000_000);
  write('ghost.json', { objective: 'z', cwd: '/' }, 5_000_000);
  fs.writeFileSync(path.join(doneDir, 'broken.json'), '{');

  const out = legacyTemps(reg, doneDir);
  assert.deepEqual(Object.keys(out).sort(), ['worker-jira', 'worker-temp-k1'], 'only registered, unmarked workers');
  assert.equal(Math.round(out['worker-jira'].spawnedAt), 2_000_000, 'the newest hiring wins');
  assert.equal(out['worker-jira'].objective, 'triage the board');
  assert.equal(out['worker-jira'].tokenCap, 5000);
  assert.deepEqual(out['worker-jira'].slack, { channel: 'C1', thread_ts: '1.2' });
  assert.equal(out['worker-jira'].hiredBy, 'orchestrator');
  assert.equal(out['worker-temp-k1'].hiredBy, 'human');
  assert.deepEqual(legacyTemps(reg, path.join(doneDir, 'missing')), {}, 'no folder → nothing');
});

test('the hiring survives a respawn (Restore team) and marks the temp on god\'s roster', async (t) => {
  const home = tmp(t, 'md-temp-hive-');
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-x', name: 'Xavier', provider: 'claude', cwd: home, role: 'worker' });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const hiring = { reqId: 'x', spawnedAt: 1234, baseBranch: 'main', tokenCap: 900, objective: 'do x', hiredBy: 'orchestrator' };
  hive.setTemp('worker-x', hiring);
  hive.setArchived('worker-x', true); // the app quit

  await hive.ensureAgent({ id: 'worker-x', name: 'Xavier', provider: 'claude', cwd: home, role: 'worker' }); // restored
  const a = hive.registry().agents['worker-x'];
  assert.equal(a.archived, false);
  assert.deepEqual(a.temp, hiring, 'still a temp after the respawn');

  hive.writeFleetSnapshot({ ts: Date.now(), agents: [
    { id: 'god-1', name: 'Michael', isGod: true },
    { id: 'worker-x', name: 'Xavier', role: 'worker' },
    { id: 'jim-1', name: 'Jim' }
  ] });
  const roster = hive.rosterContext();
  assert.match(roster, /worker-x "Xavier" \(worker, [^)]*temp\)/);
  assert.doesNotMatch(roster, /jim-1 "Jim" \([^)]*temp/);
  assert.match(roster, /archive-requests/);

  hive.setTemp('worker-x', null); // reopened by hand: a regular agent from now on
  assert.equal(hive.registry().agents['worker-x'].temp, undefined);
  assert.doesNotMatch(hive.rosterContext(), /, temp\)|A `temp` is/);
});
