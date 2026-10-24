'use strict';
/**
 * Pi has no OS sandbox of its own, so on Linux and WSL floors the app wraps it
 * in bubblewrap, like Claude Code's own sandbox: the disk read-only except the
 * agent's writable set, a private /tmp, credential folders hidden. Where
 * bubblewrap cannot run (native Windows, or not installed) the agent runs as
 * before and its card says it is not sandboxed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { bwrapArgs, mountPoints, SECRET_HOME_DIRS } = loadTs('src/shared/bwrapSandbox.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const pairs = (args, flag) => { const out = []; args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); }); return out; };

test('the disk is read-only except the writable set; /tmp is private; credentials are hidden', () => {
  const exists = (p) => ['/home/u/.ssh', '/home/u/.aws', '/home/u/.pi/agent/auth.json'].includes(p);
  const a = bwrapArgs({ writable: ['/home/u/office/hive/agents/jim', '/home/u/office/hive', '/home/u/project/'], writableFiles: ['/home/u/.pi/agent/auth.json'], home: '/home/u' }, exists);
  assert.deepEqual(a.slice(0, 10), ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp']);
  assert.deepEqual(pairs(a, '--bind-try'), ['/home/u/office/hive/agents/jim', '/home/u/office/hive', '/home/u/project']);
  assert.deepEqual(pairs(a, '--bind'), ['/home/u/.pi/agent/auth.json'], 'the pi login it refreshes');
  assert.deepEqual(pairs(a, '--tmpfs'), ['/tmp', '/home/u/.ssh', '/home/u/.aws'], 'only existing credential folders are hidden');
  assert.ok(a.lastIndexOf('--bind-try') < a.indexOf('/home/u/.ssh'), 'hidden after the writable binds');
  assert.ok(!a.includes('--unshare-net'), 'host network: the model API and the app\'s loopback services');
});

test('folders it may not read are hidden; no network when asked; nonsense paths are dropped', () => {
  const a = bwrapArgs({ writable: ['/', '/tmp', 'relative', '/ok'], hide: ['/home/u/office/confidential'], home: '/home/u', network: 'none' }, (p) => p === '/home/u/office/confidential');
  assert.deepEqual(pairs(a, '--bind-try'), ['/ok']);
  assert.ok(pairs(a, '--tmpfs').includes('/home/u/office/confidential'));
  assert.ok(a.includes('--unshare-net'));
});

test('mount points to check: the credential folders, the hidden ones and the writable files', () => {
  const m = mountPoints({ writable: [], hide: ['/x'], writableFiles: ['/home/u/.pi/agent/auth.json'], home: '/home/u/' });
  assert.ok(m.includes('/home/u/.ssh') && m.includes('/x') && m.includes('/home/u/.pi/agent/auth.json'));
  assert.equal(m.length, SECRET_HOME_DIRS.length + 2);
});

function tmpHome(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pisbx-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }

test('a pi agent is wrapped where bubblewrap runs, with Claude\'s writable set plus its project', async (t) => {
  const home = tmpHome(t);
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => true;
  hive.existingPaths = async (ps) => ps.filter((p) => p.endsWith('.ssh'));
  // As the agent sees paths (a WSL floor's distro, or Linux itself).
  const lin = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).split(path.sep).join('/');
  hive.forAgent = lin;
  const inj = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: project }, { extraWritableDirs: [path.join(home, 'palace')] });
  assert.equal(inj.osSandbox, 'app');
  const binds = pairs(inj.wrap, '--bind-try');
  for (const d of [path.join(home, 'hive', 'agents', 'pi-1'), path.join(home, 'hive'), path.join(home, 'palace'), project]) {
    assert.ok(binds.includes(lin(d)), `${d} writable`);
  }
  assert.ok(pairs(inj.wrap, '--tmpfs').some((p) => p.endsWith('/.ssh')));
  assert.deepEqual(pairs(inj.wrap, '--ro-bind-try'), [lin(path.join(home, 'hive', 'agents'))], 'the other agents folders are read-only');
  assert.ok(inj.wrap.lastIndexOf(lin(path.join(home, 'hive', 'agents', 'pi-1'))) > inj.wrap.indexOf('--ro-bind-try'), 'its own folder reopened after');
  assert.ok(inj.env.PI_CODING_AGENT_DIR, 'still the hive bridge extension');
});

test('where bubblewrap cannot run, the agent runs as before and is marked not sandboxed', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => false;
  const inj = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: home }, {});
  assert.equal(inj.osSandbox, 'none');
  assert.equal(inj.wrap, undefined);
});

test('other CLIs are untouched', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => true;
  const inj = await hive.ensureAgent({ id: 'cx-1', name: 'Codex', provider: 'codex', cwd: home }, {});
  assert.equal(inj.wrap, undefined);
  assert.equal(inj.osSandbox, undefined);
});
