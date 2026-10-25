'use strict';
// Any lasting agent may start a temp, not only the orchestrator.
//
// An agent writes a spawn request into its own folder; main starts the temp
// when the human gave that agent temps ("Temps per agent", 0-4, default 0)
// and the office has a free desk ("Max temps at once"), and refuses it with
// the reason otherwise. The temp reports to the agent that asked, only that
// agent may archive it, and it never gets more access than its parent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  clampTempQuota, tempQuotaOf, tempsAtOnce, agentTempProblem,
  parseAnswerer, isTempTarget, cloneTarget, cloneProblem,
  inheritedAccess, withoutAccess, changedAccess, TEMP_QUOTA_MAX
} = loadTs('src/shared/agentTemps.ts');
const { archiveRequestProblem, latestDone } = loadTs('src/main/tempWorkers.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { PROTOCOL_DOCS } = loadTs('src/main/protocolDocs.ts');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ─── quota ──────────────────────────────────────────────────────────────────

test('"Temps per agent" is a whole number from 0 to 4, absent means 0 (off)', () => {
  assert.equal(TEMP_QUOTA_MAX, 4);
  assert.equal(clampTempQuota(undefined), 0);
  assert.equal(clampTempQuota(-1), 0);
  assert.equal(clampTempQuota(2.7), 2);
  assert.equal(clampTempQuota(9), 4);
  assert.equal(clampTempQuota('3'), 3);
  assert.equal(clampTempQuota('lots'), 0);
  assert.equal(tempQuotaOf(undefined, 'pam'), 0, 'nobody set it → no temps');
  assert.equal(tempQuotaOf({ pam: 2 }, 'pam'), 2);
  assert.equal(tempQuotaOf({ pam: 2 }, 'jim'), 0);
});

test('"Max temps at once" defaults to 4 and stays within 1-16', () => {
  assert.equal(tempsAtOnce(undefined), 4);
  assert.equal(tempsAtOnce(0), 1);
  assert.equal(tempsAtOnce(99), 16);
  assert.equal(tempsAtOnce(6), 6);
});

test('a request is refused, with a reason the agent can act on, whenever it is over quota', () => {
  const pam = { id: 'pam' };
  assert.equal(agentTempProblem(pam, 2, 0, 0, 4), null, 'within both limits → started');
  assert.equal(agentTempProblem(pam, 2, 1, 3, 4), null);
  assert.match(agentTempProblem(pam, 0, 0, 0, 4), /has not allowed you to start temps.*Temps per agent/);
  assert.match(agentTempProblem(pam, 2, 2, 2, 4), /already have 2 temps running and your limit is 2/);
  assert.match(agentTempProblem(pam, 1, 1, 1, 4), /already have 1 temp running and your limit is 1/);
  assert.match(agentTempProblem(pam, 3, 1, 4, 4), /every temp desk in the office is taken \(4 of 4/);
});

test('a temp, a custodian and the orchestrator cannot use an agent\'s own queue', () => {
  assert.match(agentTempProblem({ id: 'worker-pam-x', temp: true }, 4, 0, 0, 4), /a temp cannot start temps/);
  assert.match(agentTempProblem({ id: 'angela', custodian: true }, 4, 0, 0, 4), /critical connection/);
  assert.match(agentTempProblem({ id: 'god', isGod: true }, 4, 0, 0, 4), /hive's spawn-requests/);
  assert.match(agentTempProblem({ id: 'ghost', missing: true }, 4, 0, 0, 4), /no agent "ghost"/);
});

// ─── a temp gets at most its parent's access ────────────────────────────────

const parentCfg = () => ({
  agentMcpGrants: { pam: ['github'], jim: ['github', 'jira'] },
  agentMcpAccess: { pam: { github: 'read' }, jim: { github: 'readwrite' } },
  agentToolBlocks: { pam: ['web'] },
  connectionScopes: { jira: ['jim'], github: ['pam', 'jim'] },
  integrationScopes: { crm: ['jim'], tickets: ['pam'] },
  envVars: [{ name: 'A', kind: 'plain', agents: ['pam'] }, { name: 'B', kind: 'secret', agents: ['jim'] }, { name: 'C', kind: 'plain', agents: null }],
  customMcp: [{ id: 'm1', agents: ['jim'] }, { id: 'm2', agents: ['pam'] }, { id: 'm3', agents: null }],
  agentRoam: ['pam'],
  agentUnsandboxed: ['pam'],
  agentSshRelay: { pam: { ask: false } },
  agentCloudCredentials: { pam: ['aws'] },
  criticalCustodians: { 'mcp:jira': 'jim' }
});

test('a temp inherits its parent\'s restrictions and joins only the lists its parent is on', () => {
  const cfg = parentCfg();
  const p = inheritedAccess(cfg, 'pam', 'worker-pam-x');
  assert.deepEqual(p.agentMcpGrants['worker-pam-x'], ['github'], 'the same MCP grant, not Jim\'s');
  assert.deepEqual(p.agentMcpAccess['worker-pam-x'], { github: 'read' }, 'read where the parent reads');
  assert.deepEqual(p.agentToolBlocks['worker-pam-x'], ['web'], 'the parent\'s blocked tools stay blocked');
  assert.deepEqual(p.connectionScopes.jira, ['jim'], 'not on a connection the parent is not on');
  assert.deepEqual(p.connectionScopes.github, ['pam', 'jim', 'worker-pam-x']);
  assert.deepEqual(p.integrationScopes.crm, ['jim']);
  assert.deepEqual(p.integrationScopes.tickets, ['pam', 'worker-pam-x']);
  assert.deepEqual(p.envVars.map((v) => v.agents), [['pam', 'worker-pam-x'], ['jim'], null]);
  assert.deepEqual(p.customMcp.map((m) => m.agents), [['jim'], ['pam', 'worker-pam-x'], null]);
  // The parent itself is untouched.
  assert.deepEqual(p.agentMcpGrants.pam, ['github']);
  assert.deepEqual(p.agentMcpGrants.jim, ['github', 'jira']);
});

test('the grants that widen an agent are never passed to its temp', () => {
  const p = inheritedAccess(parentCfg(), 'pam', 'worker-pam-x');
  assert.ok(!p.agentRoam.includes('worker-pam-x'), 'no writing outside its folders');
  assert.ok(!p.agentUnsandboxed.includes('worker-pam-x'), 'always sandboxed');
  assert.equal(p.agentSshRelay['worker-pam-x'], undefined, 'no SSH keys');
  assert.equal(p.agentCloudCredentials['worker-pam-x'], undefined, 'no cloud logins');
  assert.ok(!Object.values(p.criticalCustodians).includes('worker-pam-x'), 'never a custodian');
});

test('a reused temp id loses whatever it had before, and a finished temp forgets everything', () => {
  const cfg = parentCfg();
  // A stale entry left under the same id with more than the parent has.
  cfg.agentUnsandboxed.push('worker-pam-x');
  cfg.agentMcpGrants['worker-pam-x'] = ['github', 'jira', 'slack'];
  cfg.connectionScopes.jira.push('worker-pam-x');
  cfg.criticalCustodians['mcp:slack'] = 'worker-pam-x';
  const p = inheritedAccess(cfg, 'pam', 'worker-pam-x');
  assert.deepEqual(p.agentMcpGrants['worker-pam-x'], ['github']);
  assert.ok(!p.agentUnsandboxed.includes('worker-pam-x'));
  assert.deepEqual(p.connectionScopes.jira, ['jim']);
  assert.equal(p.criticalCustodians['mcp:slack'], '');

  const after = { ...cfg, ...p };
  const gone = withoutAccess(after, 'worker-pam-x');
  assert.equal(gone.agentMcpGrants['worker-pam-x'], undefined);
  assert.equal(JSON.stringify(gone).includes('worker-pam-x'), false, 'no trace of the temp is left');
});

test('a parent with no entry gives its temp the same defaults it has, and a no-op writes nothing', () => {
  const cfg = { connectionScopes: { github: ['jim'] } };
  const p = inheritedAccess(cfg, 'pam', 'worker-pam-x');
  assert.equal(p.agentMcpGrants['worker-pam-x'], undefined, 'default set, like Pam');
  assert.deepEqual(p.connectionScopes.github, ['jim'], 'Pam is not on GitHub, so neither is her temp');
  assert.deepEqual(changedAccess(cfg, p), {}, 'nothing to write');
  assert.deepEqual(Object.keys(changedAccess(parentCfg(), inheritedAccess(parentCfg(), 'pam', 'w'))).sort(),
    ['agentMcpAccess', 'agentMcpGrants', 'agentToolBlocks', 'connectionScopes', 'customMcp', 'envVars', 'integrationScopes']);
});

// ─── archive rights ─────────────────────────────────────────────────────────

function reg() {
  return {
    godId: 'god-1',
    agents: {
      'god-1': { id: 'god-1', name: 'Michael', cwd: '/', status: 'idle', lastSeen: 0, isGod: true },
      pam: { id: 'pam', name: 'Pam', cwd: '/', status: 'idle', lastSeen: 0 },
      jim: { id: 'jim', name: 'Jim', cwd: '/', status: 'idle', lastSeen: 0 },
      'worker-pam-a': { id: 'worker-pam-a', name: 'A', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 'pam-a', spawnedAt: 1, baseBranch: 'main', hiredBy: 'agent', parent: 'pam' } },
      'worker-g': { id: 'worker-g', name: 'G', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 'g', spawnedAt: 1, baseBranch: 'main', hiredBy: 'orchestrator' } },
      'worker-t': { id: 'worker-t', name: 'T', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 't', spawnedAt: 1, baseBranch: 'main', hiredBy: 'trigger' } },
      'worker-temp-h': { id: 'worker-temp-h', name: 'H', cwd: '/', status: 'idle', lastSeen: 0, temp: { reqId: 'temp-h', spawnedAt: 1, baseBranch: 'main', hiredBy: 'human' } }
    }
  };
}

test('an agent may archive only the temps it started', () => {
  const r = reg();
  assert.equal(archiveRequestProblem(r, 'worker-pam-a', 'pam'), null, 'Pam\'s own temp');
  assert.match(archiveRequestProblem(r, 'worker-pam-a', 'jim'), /not started by you/);
  assert.match(archiveRequestProblem(r, 'worker-g', 'pam'), /not started by you/, 'not the orchestrator\'s');
  assert.match(archiveRequestProblem(r, 'worker-temp-h', 'pam'), /hired by the human/);
  assert.match(archiveRequestProblem(r, 'jim', 'pam'), /not a temp/);
  assert.match(archiveRequestProblem(r, 'pam', 'pam'), /yourself/);
});

test('the orchestrator keeps its own and the triggers\' temps, and leaves an agent\'s alone', () => {
  const r = reg();
  assert.equal(archiveRequestProblem(r, 'worker-g'), null);
  assert.equal(archiveRequestProblem(r, 'worker-t'), null, 'a trigger\'s temp reports to the orchestrator');
  assert.match(archiveRequestProblem(r, 'worker-pam-a'), /started by Pam, so it is theirs/);
  assert.match(archiveRequestProblem(r, 'god-1'), /yourself/);
});

// ─── routing back ───────────────────────────────────────────────────────────

test('the done scan says who the done was addressed to, so a stray one is forwarded to the parent', (t) => {
  const dir = tmp(t, 'md-agent-temp-done-');
  const out = path.join(dir, 'outbox', '.sent');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'd.json'), JSON.stringify({ to: 'pam', act: 'done', body: 'found 3 flaky tests', created_at: new Date().toISOString() }));
  const done = latestDone(dir, Date.now() - 60_000);
  assert.equal(done.to, 'pam');
  assert.equal(done.text, 'found 3 flaky tests');
});

test('an agent\'s temp shows on god\'s roster as that agent\'s, not god\'s', async (t) => {
  const home = tmp(t, 'md-agent-temp-roster-');
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-pam-a', name: 'Pam (temp)', provider: 'claude', cwd: home, role: 'worker' });
  hive.setTemp('worker-pam-a', { reqId: 'pam-a', spawnedAt: 1, baseBranch: 'main', hiredBy: 'agent', parent: 'pam', accessFrom: 'pam' });
  hive.writeFleetSnapshot({ ts: Date.now(), agents: [
    { id: 'god-1', name: 'Michael', isGod: true },
    { id: 'pam', name: 'Pam' },
    { id: 'worker-pam-a', name: 'Pam (temp)', role: 'worker' }
  ] });
  assert.match(hive.rosterContext(), /worker-pam-a "Pam \(temp\)" \([^)]*temp of pam\)/);
  assert.match(hive.rosterContext(), /leave it alone/);
});

// ─── docs and prompt ────────────────────────────────────────────────────────

function promptOf(inj) {
  const i = inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt');
  assert.ok(i >= 0);
  return inj.args[i + 1];
}

test('an agent\'s prompt explains its own temp queue only when the human gave it temps', async (t) => {
  const home = tmp(t, 'md-agent-temp-prompt-');
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  hive.setTempQuota((id) => (id === 'pam' ? 2 : 0));
  const pam = promptOf(await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home }));
  assert.match(pam, /STARTING A TEMP: the human lets you run up to 2 temps at once/);
  assert.ok(pam.includes(path.join(home, 'hive', 'agents', 'pam', 'spawn-requests')), 'its own folder, not the hive root');
  assert.match(pam, /comes back to YOUR inbox/);
  assert.match(pam, /at most your access/);
  const jim = promptOf(await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }));
  assert.doesNotMatch(jim, /STARTING A TEMP/, 'no temps → not told about them');
  const god = promptOf(await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true }));
  assert.doesNotMatch(god, /STARTING A TEMP/, 'the orchestrator has its own queue');
});

test('temps.md is for every agent and states the quota, the inheritance and the archive rule', () => {
  const doc = PROTOCOL_DOCS.find((d) => d.file === 'temps.md');
  assert.equal(doc.who, 'everyone');
  assert.match(doc.body, /Temps per agent\* \(0–4, default 0 = none\)/);
  assert.match(doc.body, /agents\/<your-id>\/spawn-requests\/<id>\.json/);
  assert.match(doc.body, /at most your access/);
  assert.match(doc.body, /Max temps at once/);
  assert.match(doc.body, /Anyone else's temp is refused/);
});

// ─── "who answers" ──────────────────────────────────────────────────────────

test('a trigger target can name a temp or a clone of an agent; anything else is an agent', () => {
  assert.deepEqual(parseAnswerer('temp'), { kind: 'temp' });
  assert.deepEqual(parseAnswerer(cloneTarget('pam')), { kind: 'clone', of: 'pam' });
  assert.deepEqual(parseAnswerer('god'), { kind: 'agent', id: 'god' });
  assert.deepEqual(parseAnswerer(undefined), { kind: 'agent', id: 'god' }, 'unset = the orchestrator');
  assert.deepEqual(parseAnswerer('temp:'), { kind: 'agent', id: 'temp:' }, 'a clone needs an agent');
  assert.equal(isTempTarget('temp:jim'), true);
  assert.equal(isTempTarget('jim'), false);
  assert.equal(isTempTarget('broadcast'), false);
});

test('the orchestrator, a temp and a custodian are never cloned', () => {
  assert.equal(cloneProblem({ id: 'pam' }, false), null);
  assert.match(cloneProblem({ id: 'god-1', isGod: true }, false), /orchestrator/);
  assert.match(cloneProblem({ id: 'worker-x', temp: { reqId: 'x' } }, false), /temp cannot be cloned/);
  assert.match(cloneProblem({ id: 'angela' }, true), /custodian is never cloned/);
  assert.match(cloneProblem(undefined, false), /no longer in the office/);
});
