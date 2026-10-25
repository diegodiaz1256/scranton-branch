'use strict';
/**
 * The cloud and developer CLIs' logins (gh, aws, az, gcloud, kubectl, docker,
 * npm, pip, netrc, git's credential store) are hidden from every sandboxed
 * agent by default, like ~/.ssh: Claude Code's sandbox (denyRead + Read/Edit
 * deny rules) and the app's bubblewrap (pi, agy). The human may expose some
 * to one agent in Capabilities; the agent's prompt says what is hidden and
 * who can change it, so it does not loop on a logged-out CLI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { CLOUD_CREDENTIALS, cleanCloudCredentialMap, cleanCloudCredentialIds, hiddenCredentialPaths, credentialPromptLine } = loadTs('src/shared/cloudCredentials.ts');
const { bwrapArgs } = loadTs('src/shared/bwrapSandbox.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const pairs = (args, flag) => { const out = []; args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); }); return out; };

test('the catalog: the logins the task names, folders and files', () => {
  const all = CLOUD_CREDENTIALS.flatMap((s) => [...s.dirs, ...s.files]);
  for (const p of ['.aws', '.config/gh', '.azure', '.kube', '.docker', '.config/gcloud', '.npmrc', '.pypirc', '.netrc', '.git-credentials']) assert.ok(all.includes(p), p);
  // Keys are not here: they are always hidden (KEY_HOME_DIRS), and SSH goes through the relay.
  assert.ok(!all.includes('.ssh') && !all.includes('.gnupg'));
});

test('the per-agent choice is cleaned: known ids only, in order; empty agents dropped', () => {
  assert.deepEqual(cleanCloudCredentialIds(['aws', 'nope', 'gh', 'gh', 3]), ['gh', 'aws']);
  assert.deepEqual(cleanCloudCredentialMap({ jim: ['gh'], pam: [], dwight: 'aws', '': ['gh'] }), { jim: ['gh'] });
  assert.deepEqual(cleanCloudCredentialMap(null), {});
  const h = hiddenCredentialPaths(['gh', 'netrc']);
  assert.ok(!h.dirs.includes('.config/gh') && !h.files.includes('.netrc'));
  assert.ok(h.dirs.includes('.aws') && h.files.includes('.git-credentials'));
});

test('the agent is told what is hidden, that it is on purpose and who can change it', () => {
  const none = credentialPromptLine([]);
  assert.match(none, /hidden from you on purpose/);
  assert.match(none, /~\/\.config\/gh/);
  assert.match(none, /Do not retry/);
  assert.match(none, /Capabilities → your row → Cloud credentials/);
  const some = credentialPromptLine(['gh']);
  assert.ok(!some.includes('~/.config/gh'), 'gh is not listed as hidden');
  assert.match(some, /Allowed for you: GitHub CLI \(gh\)/);
  assert.equal(credentialPromptLine(CLOUD_CREDENTIALS.map((s) => s.id)), '');
});

test('bubblewrap: folders under a tmpfs, files under /dev/null, exposed ones left readable', () => {
  const present = ['/home/u/.ssh', '/home/u/.aws', '/home/u/.config/gh', '/home/u/.netrc', '/home/u/.git-credentials'];
  const hidden = bwrapArgs({ writable: [], home: '/home/u' }, (p) => present.includes(p));
  assert.deepEqual(pairs(hidden, '--tmpfs'), ['/tmp', '/home/u/.ssh', '/home/u/.config/gh', '/home/u/.aws']);
  const devnull = hidden.flatMap((a, i) => (a === '--ro-bind' && hidden[i + 1] === '/dev/null' ? [hidden[i + 2]] : []));
  assert.deepEqual(devnull, ['/home/u/.netrc', '/home/u/.git-credentials']);
  const gh = bwrapArgs({ writable: [], home: '/home/u', exposeCredentials: ['gh', 'git'] }, (p) => present.includes(p));
  assert.ok(!gh.includes('/home/u/.config/gh') && !gh.includes('/home/u/.git-credentials'), 'exposed');
  assert.ok(gh.includes('/home/u/.ssh') && gh.includes('/home/u/.aws') && gh.includes('/home/u/.netrc'), 'the rest stay hidden');
});

function tmpHome(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-creds-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }

function sandboxedHive(home) {
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => true;
  hive.sshWrapperDir = () => path.join(home, 'hive', 'bin', 'ssh');
  hive.userHome = () => home;
  return hive;
}
const settingsOf = (inj) => JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
const promptOf = (inj) => inj.args[inj.args.indexOf('--append-system-prompt') + 1];

test('a sandboxed Claude agent: every login denied to its shell and file tools by default, and its prompt says so', async (t) => {
  const home = tmpHome(t);
  const hive = sandboxedHive(home);
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, {});
  const s = settingsOf(inj);
  const gh = path.join(home, '.config', 'gh');
  const netrc = path.join(home, '.netrc');
  for (const p of [gh, path.join(home, '.aws'), netrc, path.join(home, '.git-credentials'), path.join(home, '.ssh')]) assert.ok(s.sandbox.filesystem.denyRead.includes(p), `denyRead ${p}`);
  const slash = (p) => p.replace(/\\/g, '/');
  assert.ok(s.permissions.deny.includes(`Read(/${slash(gh)}/**)`), 'Read(~/.config/gh/**) refused');
  assert.ok(s.permissions.deny.includes(`Read(/${slash(netrc)})`), 'a single file by its own path');
  assert.ok(s.permissions.deny.includes(`Edit(/${slash(netrc)})`));
  assert.match(promptOf(inj), /CREDENTIALS: .*hidden from you on purpose/);
});

test('exposed to one agent: that login is readable, the rest stay hidden', async (t) => {
  const home = tmpHome(t);
  const hive = sandboxedHive(home);
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, { exposeCredentials: ['gh'] });
  const s = settingsOf(inj);
  assert.ok(!s.sandbox.filesystem.denyRead.includes(path.join(home, '.config', 'gh')));
  assert.ok(s.sandbox.filesystem.denyRead.includes(path.join(home, '.aws')));
  assert.match(promptOf(inj), /Allowed for you: GitHub CLI \(gh\)/);
});

test('pi in the app\'s bubblewrap gets the same: hidden by default, exposed when allowed', async (t) => {
  const home = tmpHome(t);
  const hive = sandboxedHive(home);
  const lin = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).split(path.sep).join('/');
  hive.forAgent = lin;
  hive.existingPaths = async (ps) => ps.filter((p) => p.endsWith('/.config/gh') || p.endsWith('/.aws'));
  const off = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: home }, {});
  assert.ok(pairs(off.wrap, '--tmpfs').includes(lin(path.join(home, '.config', 'gh'))));
  const on = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: home }, { exposeCredentials: ['gh'] });
  assert.ok(!pairs(on.wrap, '--tmpfs').includes(lin(path.join(home, '.config', 'gh'))));
  assert.ok(pairs(on.wrap, '--tmpfs').includes(lin(path.join(home, '.aws'))));
});

test('no OS sandbox (a Windows floor): nothing to hide them with, and no prompt line claiming it', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => false;
  hive.sshWrapperDir = () => null;
  hive.userHome = () => home;
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, {});
  assert.doesNotMatch(promptOf(inj), /CREDENTIALS:/);
  const deny = settingsOf(inj).sandbox?.filesystem?.denyRead ?? [];
  assert.ok(!deny.includes(path.join(home, '.aws')));
});

test('main: only cloudCreds:set changes it (custodian refused, logged); the generic config write drops it; a custodian spawns with none', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const update = src.slice(src.indexOf("ipcMain.handle('config:update'"), src.indexOf("ipcMain.handle('config:setAgentMcpGrant'"));
  assert.match(update, /agentCloudCredentials: _cloudCreds,[^}]*\.\.\.safePatch \} = patch/);
  const set = src.slice(src.indexOf("ipcMain.handle('cloudCreds:set'"));
  assert.match(set.slice(0, 1500), /isCustodian\(/);
  assert.match(set.slice(0, 1500), /appendLog\(\{ kind: 'cloud-credentials'/);
  assert.match(src, /exposeCredentials: isCustodian\(criticalMap\(\), opts\.hive\.id\) \? \[\]/);
});
