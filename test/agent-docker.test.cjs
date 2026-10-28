'use strict';
/**
 * "Allow Docker" (shared/agentDocker.ts): the Docker socket is out of every
 * sandboxed agent's reach unless the human allows it to one agent. Docker is
 * root where agents run, so only docker:set writes it, a custodian never gets
 * it, and the generic config write drops it (an agent cannot grant itself).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { cleanDockerMap, dockerGranted, dockerSocketPaths, withDockerSockets } = loadTs('src/shared/agentDocker.ts');
const { bwrapArgs } = loadTs('src/shared/bwrapSandbox.ts');
const { withoutAccess } = loadTs('src/shared/agentTemps.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const sandboxed = () => ({ sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: ['/w'] } } });

test('the map is cleaned: only `true`, never a truthy look-alike', () => {
  assert.deepEqual(cleanDockerMap({ jim: true, pam: 'true', dwight: 1, '': true, kevin: false }), { jim: true });
  assert.deepEqual(cleanDockerMap(null), {});
  assert.deepEqual(cleanDockerMap(['jim']), {});
});

test('granted only when on the map and not a custodian', () => {
  assert.equal(dockerGranted({ jim: true }, {}, 'jim'), true);
  assert.equal(dockerGranted({ jim: true }, {}, 'pam'), false);
  assert.equal(dockerGranted({}, {}, 'jim'), false);
  assert.equal(dockerGranted({ jim: true }, { 'mcp:jira': 'jim' }, 'jim'), false, 'a custodian never gets it');
  assert.equal(dockerGranted({ jim: true }, {}, undefined), false);
});

test('socket paths: the system one, rootless, and a unix:// DOCKER_HOST; nothing over TCP', () => {
  assert.deepEqual(dockerSocketPaths(), ['/var/run/docker.sock', '/run/docker.sock']);
  assert.deepEqual(dockerSocketPaths({ uid: 1000 }), ['/var/run/docker.sock', '/run/docker.sock', '/run/user/1000/docker.sock']);
  assert.deepEqual(dockerSocketPaths({ XDG_RUNTIME_DIR: '/run/user/7/', uid: 1000, DOCKER_HOST: 'unix:///home/u/d.sock' }), ['/var/run/docker.sock', '/run/docker.sock', '/run/user/7/docker.sock', '/home/u/d.sock']);
  assert.deepEqual(dockerSocketPaths({ DOCKER_HOST: 'tcp://10.0.0.1:2375' }), ['/var/run/docker.sock', '/run/docker.sock']);
  assert.deepEqual(dockerSocketPaths({ DOCKER_HOST: 'unix://relative.sock', XDG_RUNTIME_DIR: 'rel' }), ['/var/run/docker.sock', '/run/docker.sock']);
});

test('settings without a grant are untouched; with one, the socket list (and on Linux allowAllUnixSockets)', () => {
  const s = sandboxed();
  assert.deepEqual(withDockerSockets(s, [], { linux: true }), s, 'no socket: nothing changes');
  const mac = withDockerSockets(s, ['/var/run/docker.sock'], { linux: false });
  assert.deepEqual(mac.sandbox.network, { allowUnixSockets: ['/var/run/docker.sock'] });
  assert.equal(s.sandbox.network, undefined, 'the input is not mutated');
  const linux = withDockerSockets(s, ['/var/run/docker.sock'], { linux: true });
  assert.deepEqual(linux.sandbox.network, { allowUnixSockets: ['/var/run/docker.sock'], allowAllUnixSockets: true });
  assert.equal(linux.sandbox.allowUnsandboxedCommands, false, 'the rest of the sandbox stays');
});

test('merged with an existing network block (the broker), never for a strictAllowlist one', () => {
  const broker = { sandbox: { ...sandboxed().sandbox, network: { allowedDomains: ['127.0.0.1:4000'], allowUnixSockets: ['/a.sock'] } } };
  const out = withDockerSockets(broker, ['/var/run/docker.sock', '/a.sock'], { linux: false });
  assert.deepEqual(out.sandbox.network, { allowedDomains: ['127.0.0.1:4000'], allowUnixSockets: ['/a.sock', '/var/run/docker.sock'] });
  const custodian = { sandbox: { ...sandboxed().sandbox, network: { allowedDomains: ['127.0.0.1:4000'], strictAllowlist: true } } };
  assert.deepEqual(withDockerSockets(custodian, ['/var/run/docker.sock'], { linux: true }), custodian);
  assert.deepEqual(withDockerSockets({ sandbox: { enabled: false } }, ['/var/run/docker.sock'], { linux: true }), { sandbox: { enabled: false } }, 'nothing to open without a sandbox');
});

test('bubblewrap: the socket under /dev/null unless allowed', () => {
  const sock = '/run/docker.sock';
  const hidden = bwrapArgs({ writable: [], home: '/home/u', hideFiles: [sock] }, (p) => p === sock);
  const devnull = hidden.flatMap((a, i) => (a === '--ro-bind' && hidden[i + 1] === '/dev/null' ? [hidden[i + 2]] : []));
  assert.deepEqual(devnull, [sock]);
  const open = bwrapArgs({ writable: [], home: '/home/u', hideFiles: [] }, (p) => p === sock);
  assert.ok(!open.includes(sock));
});

function tmpHome(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-docker-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }
function sandboxedHive(home) {
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => true;
  hive.sshWrapperDir = () => path.join(home, 'hive', 'bin', 'ssh');
  hive.userHome = () => home;
  hive.dockerSocketList = async () => ['/var/run/docker.sock', '/run/docker.sock'];
  hive.dockerSockets = async () => ['/run/docker.sock'];
  return hive;
}
const settingsOf = (inj) => JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
const pairs = (args, flag) => { const out = []; args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); }); return out; };

test('a Claude agent: no socket by default; granted, the socket list; a custodian never', async (t) => {
  const home = tmpHome(t);
  const hive = sandboxedHive(home);
  const off = settingsOf(await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, {}));
  assert.equal(off.sandbox.network?.allowUnixSockets, undefined);
  assert.equal(off.sandbox.network?.allowAllUnixSockets, undefined);
  const on = settingsOf(await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, { docker: true }));
  assert.deepEqual(on.sandbox.network.allowUnixSockets, ['/var/run/docker.sock', '/run/docker.sock']);
  assert.equal(on.sandbox.enabled, true);
  assert.equal(on.sandbox.allowUnsandboxedCommands, false);
  const cust = settingsOf(await hive.ensureAgent({ id: 'oscar', name: 'Oscar', provider: 'claude', cwd: home }, { docker: true, lockdown: { outgoing: path.join(home, 'out') }, vaults: [] }));
  assert.equal(cust.sandbox.network.strictAllowlist, true);
  assert.equal(cust.sandbox.network.allowUnixSockets, undefined, 'a custodian never reaches Docker');
  assert.equal(cust.sandbox.network.allowAllUnixSockets, undefined);
});

test('pi in the app\'s bubblewrap: the socket hidden by default, left visible when allowed', async (t) => {
  const home = tmpHome(t);
  const hive = sandboxedHive(home);
  hive.forAgent = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).split(path.sep).join('/');
  hive.existingPaths = async (ps) => ps.filter((p) => p === '/run/docker.sock');
  const off = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: home }, {});
  assert.ok(pairs(off.wrap, '/dev/null').includes('/run/docker.sock'));
  const on = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: home }, { docker: true });
  assert.ok(!on.wrap.includes('/run/docker.sock'));
});

test('a finished temp forgets it', () => {
  assert.deepEqual(withoutAccess({ agentDocker: { t1: true, jim: true } }, 't1').agentDocker, { jim: true });
});

test('main: only docker:set changes it (custodian refused, logged); the generic config write drops it; spawn checks custodians', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const update = src.slice(src.indexOf("ipcMain.handle('config:update'"), src.indexOf("ipcMain.handle('config:setAgentMcpGrant'"));
  assert.match(update, /const safePatch = stripHumanOnly\(patch\)/);
  assert.ok(require('./load-ts.cjs')('src/shared/anonSettings.ts').HUMAN_ONLY_CONFIG_KEYS.includes('agentDocker'));
  assert.equal((src.match(/writeConfig\(\{ agentDocker/g) ?? []).length, 1, 'one writer');
  const set = src.slice(src.indexOf("ipcMain.handle('docker:set'"));
  assert.match(set.slice(0, 1200), /isCustodian\(/);
  assert.match(set.slice(0, 1200), /appendLog\(\{ kind: 'docker'/);
  assert.match(src, /docker: dockerGranted\(readConfig\(\)\.agentDocker, readConfig\(\)\.criticalCustodians, opts\.hive\.id\)/);
});
