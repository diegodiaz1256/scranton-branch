'use strict';
// Two things a live WSL test of a pi custodian turned up:
// 1. An agent restarted in another folder or role (made custodian: it now works
//    in its own hive folder) resumed its old session; pi asked "Session found in
//    different project… Fork? [y/N]", the app's typed prompt answered it and pi
//    exited. Such a restart starts fresh instead (sessionResume.ts).
// 2. The custodian's LIMITS line still said it may write "your hive folder, the
//    hive, the temp dir", contradicting its SIGN-OFF rules and the guard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { freshSessionReason } = loadTs('src/shared/sessionResume.ts');

function tmpHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cust-resume-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

// ─── 1. resume ──────────────────────────────────────────────────────────────

test('a session from another folder or role is not resumed; same folder and role is', () => {
  assert.equal(freshSessionReason(undefined, { cwd: '/p', custodian: false }), null, 'no session, nothing to say');
  assert.equal(freshSessionReason({ cwd: '/home/u/proj', custodian: false }, { cwd: '/home/u/proj', custodian: false }), null);
  assert.equal(freshSessionReason({ cwd: '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj', custodian: false }, { cwd: '/home/u/proj/', custodian: false }), null,
    'the WSL share and the distro path are the same folder');
  assert.equal(freshSessionReason({ cwd: 'C:\\Work\\Proj' }, { cwd: 'c:/work/proj', custodian: false }), null, 'Windows is case-insensitive; unknown role never blocks');
  assert.match(freshSessionReason({ cwd: '/home/u/proj', custodian: false }, { cwd: '/home/u/office/hive/agents/pam-1', custodian: false }), /working folder changed/);
  assert.match(freshSessionReason({ cwd: '/a', custodian: false }, { cwd: '/a', custodian: true }), /became the custodian/);
  assert.match(freshSessionReason({ cwd: '/a', custodian: true }, { cwd: '/a', custodian: false }), /no longer the custodian/);
});

test('the registry keeps the folder and role each session ran under', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'pi', cwd: proj }, {});
  hive.registryCache = null;
  hive.recordSession('pam-1', 'pi-old');
  assert.deepEqual(hive.sessionContext('pam-1'), { cwd: proj, custodian: false });

  // Made custodian: the next spawn runs in its own folder, locked down.
  const dir = hive.agentFolder('pam-1');
  const now = { cwd: dir, custodian: true };
  assert.match(freshSessionReason(hive.sessionContext('pam-1'), now), /custodian/, 'read before ensureAgent: the old session is not resumed');
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'pi', cwd: dir }, { lockdown: { outgoing: path.join(dir, 'outgoing') } });
  hive.registryCache = null;
  hive.recordSession('pam-1', 'pi-new');
  assert.deepEqual(hive.sessionContext('pam-1'), { cwd: dir, custodian: true });
  assert.equal(freshSessionReason(hive.sessionContext('pam-1'), now), null, 'its own custodian session resumes');
});

test('a registry written before this falls back to the last spawn\'s folder', (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  fs.writeFileSync(path.join(hive.root(), 'registry.json'), JSON.stringify({ godId: null, agents: { 'pam-1': { id: 'pam-1', name: 'Pam', cwd: '/home/u/proj', sessionId: 'pi-old' } } }));
  hive.registryCache = null;
  assert.deepEqual(hive.sessionContext('pam-1'), { cwd: '/home/u/proj', custodian: undefined });
  assert.match(freshSessionReason(hive.sessionContext('pam-1'), { cwd: '/home/u/office/hive/agents/pam-1', custodian: true }), /working folder changed/);
});

// ─── 2. LIMITS ──────────────────────────────────────────────────────────────

function limitsOf(inj) {
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  return prompt.split('\n').find((l) => l.startsWith('LIMITS:'));
}

test('a custodian\'s LIMITS name only its own folder and vault; an ordinary agent\'s are unchanged', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const dir = path.join(home, 'hive', 'agents', 'pam-1');
  const vault = path.join(home, 'confidential', 'api-jira');
  const cust = limitsOf(await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: dir },
    { critical: ['Jira'], vaults: [vault], lockdown: { outgoing: path.join(dir, 'outgoing') } }));
  assert.ok(cust, 'the custodian has a LIMITS line');
  assert.ok(!/your hive folder, the hive, the temp dir/.test(cust), cust);
  assert.match(cust, /write only in your own folder/);
  assert.match(cust, /confidential vault/);
  assert.ok(cust.includes(path.join(dir, 'outgoing')), 'files for research/ go through outgoing/');
  assert.match(cust, /the human signs both off/);
  assert.match(cust, /anywhere else .* are refused; reading is fine/);
  assert.match(cust, /git is switched off/);

  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const plain = limitsOf(await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: proj }, {}));
  assert.equal(plain, `LIMITS: write only inside your folders (${proj}, your hive folder, the hive, the temp dir): writes, moves and deletes elsewhere are refused; reading is fine.`);
});

test('a Capabilities change does not let a custodian out or give it git', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const dir = path.join(home, 'hive', 'agents', 'pam-1');
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: dir },
    { critical: ['Jira'], vaults: [], lockdown: { outgoing: path.join(dir, 'outgoing') } });
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: proj }, {});
  hive.refreshGuards({ mcpDefaults: { git: { enabled: true } }, agentRoam: ['pam-1', 'jim-1'] });
  assert.equal(hive.guardFor('pam-1').contained, true);
  assert.equal(hive.guardFor('pam-1').git, false);
  assert.equal(hive.guardFor('jim-1').contained, false, 'an ordinary agent is still let out');
});
