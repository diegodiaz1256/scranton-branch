'use strict';
/**
 * agy (Antigravity CLI) has a `--sandbox` of its own, but in agy 1.4.7 on WSL
 * it leaves /home, /tmp and /mnt/c writable and makes only the project
 * read-only: it keeps an agent out of nothing. So on Linux and WSL floors the
 * app wraps agy in its own bubblewrap, as it does pi: the disk read-only
 * except the agent's writable set and agy's own state, the office's controls
 * and agy's hook config read-only. Its hook may then let its shell run while
 * the office does not answer, like Claude Code's.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { cliStateMounts } = loadTs('src/shared/bwrapSandbox.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const pairs = (args, flag) => { const out = []; args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); }); return out; };

test('agy\'s state: its own folder writable, its hook config and installed programs not; ~/.gemini/config untouched', () => {
  const s = cliStateMounts('agy', '/home/u/');
  assert.deepEqual(s.writable, ['/home/u/.gemini/antigravity-cli', '/home/u/.cache/antigravity']);
  assert.deepEqual(s.writableFiles, []);
  assert.ok(s.controls.includes('/home/u/.gemini/antigravity-cli/hooks.json'));
  assert.ok(s.controls.includes('/home/u/.gemini/antigravity-cli/builtin'));
  // agy rewrites bin/agentapi before every shell command: bin/ itself must stay writable.
  assert.ok(!s.controls.includes('/home/u/.gemini/antigravity-cli/bin'));
  assert.ok(![...s.writable, ...s.controls].some((p) => p.startsWith('/home/u/.gemini/config')), 'hooks, plugins, MCP stay read-only with $HOME');
});

test('pi\'s state is still only its login', () => {
  assert.deepEqual(cliStateMounts('pi', '/home/u'), { writable: [], writableFiles: ['/home/u/.pi/agent/auth.json'], controls: [] });
});

function tmpHome(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agysbx-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }
const lin = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).split(path.sep).join('/');

function agyHive(home, sandbox) {
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => sandbox;
  hive.existingPaths = async (ps) => ps.filter((p) => p.endsWith('.ssh'));
  // agy's hooks.json is merged into the user's home: keep it in the temp one.
  hive.userHome = () => home;
  hive.forAgent = lin;
  return hive;
}

test('an agy agent is wrapped where bubblewrap runs, with Claude\'s writable set, its project and agy\'s state', async (t) => {
  const home = tmpHome(t);
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const hive = agyHive(home, true);
  const inj = await hive.ensureAgent({ id: 'agy-1', name: 'Angela', provider: 'antigravity', cwd: project }, { extraWritableDirs: [path.join(home, 'palace')] });
  assert.equal(inj.osSandbox, 'app');
  assert.equal(inj.wrapCommand, undefined, 'plain bwrap');
  const binds = pairs(inj.wrap, '--bind-try');
  for (const d of [path.join(home, 'hive', 'agents', 'agy-1'), path.join(home, 'hive'), path.join(home, 'palace'), project, path.join(home, '.gemini', 'antigravity-cli')]) {
    assert.ok(binds.includes(lin(d)), `${d} writable`);
  }
  assert.ok(!binds.includes(lin(home)), 'not the whole home');
  const ro = pairs(inj.wrap, '--ro-bind-try');
  assert.equal(ro[0], lin(path.join(home, 'hive', 'agents')), 'the other agents folders are read-only');
  for (const c of [path.join(home, 'hive', 'bin'), path.join(home, '.gemini', 'antigravity-cli', 'hooks.json')]) assert.ok(ro.includes(lin(c)), `${c} read-only`);
  assert.ok(inj.wrap.indexOf(lin(path.join(home, '.gemini', 'antigravity-cli', 'hooks.json'))) > inj.wrap.lastIndexOf('--bind-try'), 'hooks.json after every writable bind');
  assert.ok(pairs(inj.wrap, '--tmpfs').some((p) => p.endsWith('/.ssh')));
  // Its hook knows the shell is contained (hookOffline.ts).
  assert.equal(JSON.parse(inj.env.HIVE_GUARD).sandboxed, true);
  assert.ok(fs.existsSync(path.join(home, '.gemini', 'antigravity-cli', 'hooks.json')), 'still the hive hook bridge');
});

test('where bubblewrap cannot run, agy runs as before, marked not sandboxed, and its shell waits for the office', async (t) => {
  const home = tmpHome(t);
  const hive = agyHive(home, false);
  const inj = await hive.ensureAgent({ id: 'agy-1', name: 'Angela', provider: 'antigravity', cwd: home }, {});
  assert.equal(inj.osSandbox, 'none');
  assert.equal(inj.wrap, undefined);
  assert.equal(JSON.parse(inj.env.HIVE_GUARD).sandboxed, false);
});
