'use strict';
/**
 * SSH through the office (shared/sshRelay.ts, main/sshRelay.ts, md-ssh).
 *
 * Agents in an OS sandbox no longer see ~/.ssh (nor ~/.gnupg, nor 1Password's
 * agent socket). The `ssh` first on their PATH is the office's: it sends git's
 * request to the app, which runs the real ssh outside the sandbox only when
 * the human switched it on for that agent, and only for git's own transfer
 * commands, with every forwarding switched off.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const relay = loadTs('src/shared/sshRelay.ts');
const { SshRelay, parseSshKeys } = loadTs('src/main/sshRelay.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { SECRET_HOME_DIRS, KEY_HOME_DIRS } = loadTs('src/shared/bwrapSandbox.ts');
const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');

// What git hands `ssh` inside Claude Code's sandbox (its GIT_SSH_COMMAND adds
// the proxy options) for `git ls-remote git@github.com:o/r.git`.
const GIT_ARGV = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', "ProxyCommand=socat - PROXY:localhost:%h:%p,proxyport=3128", '-o', 'SendEnv=GIT_PROTOCOL', 'git@github.com', "git-upload-pack 'o/r.git'"];

// ─── the request filter ─────────────────────────────────────────────────────

test('git\'s own transfer request is read, the sandbox\'s proxy options dropped', () => {
  const r = relay.parseSshArgv(GIT_ARGV, 'version=2');
  assert.equal(r.ok, true);
  assert.deepEqual(r.req, { host: 'github.com', user: 'git', service: 'git-upload-pack', path: 'o/r.git', gitProtocol: 'version=2' });
  const p = relay.parseSshArgv(['-p', '2222', 'ssh://deploy@git.example.com:2200/', "git-receive-pack '/srv/it'\\''s.git'"]);
  assert.equal(p.ok, true);
  assert.deepEqual(p.req, { host: 'git.example.com', user: 'deploy', port: 2200, service: 'git-receive-pack', path: "/srv/it's.git" });
});

test('anything but a git transfer is refused', () => {
  const no = (argv, why) => {
    const r = relay.parseSshArgv(argv);
    assert.equal(r.ok, false, JSON.stringify(argv));
    if (why) assert.match(r.error, why);
  };
  no(['-T', 'git@github.com'], /no interactive/);                       // ssh -T git@github.com
  no(['me@server.example.com', 'bash'], /only git transfers/);          // a shell on a host the key opens
  no(['me@server', 'cat', '~/.ssh/id_ed25519'], /only git transfers/);
  no(['-L', '8080:localhost:80', 'me@server'], /-L/);                   // port forwarding
  no(['-R', '9000:localhost:22', 'me@server', "git-upload-pack 'x'"]);
  no(['-D', '1080', 'me@server', "git-upload-pack 'x'"]);
  no(['-A', 'git@github.com', "git-upload-pack 'x'"]);                  // agent forwarding
  no(['-F', '/tmp/my_config', 'git@github.com', "git-upload-pack 'x'"]); // its own config
  no(['-i', '/tmp/stolen', 'git@github.com', "git-upload-pack 'x'"]);
  no(['-o', 'LocalCommand=touch /tmp/pwned', 'git@github.com', "git-upload-pack 'x'"], /localcommand/);
  no(['-o', 'PermitLocalCommand=yes', 'git@github.com', "git-upload-pack 'x'"]);
  no(['-o', 'IdentityAgent=/tmp/a.sock', 'git@github.com', "git-upload-pack 'x'"]);
  no(['git@github.com', "git-upload-pack 'x'; rm -rf ~"], /repository path/); // command after the path
  no(['git@github.com', "git-upload-pack 'x' && id"], /repository path/);
  no(['git@github.com', 'git-upload-pack $(id)'], /repository path/);
  no(['--', '-oProxyCommand=sh -c id', "git-upload-pack 'x'"], /host/);   // an option smuggled as the host
  no(['git@-oProxyCommand=id', "git-upload-pack 'x'"], /host/);
  no(['bad user@github.com', "git-upload-pack 'x'"], /user/);
  no(['-p', '99999', 'git@github.com', "git-upload-pack 'x'"], /port/);
  no(['git@github.com', "git-upload-pack 'x\ny'"]);
});

test('the real ssh gets the request rebuilt, every forwarding off, the host after --', () => {
  const r = relay.parseSshArgv(GIT_ARGV, 'version=2').req;
  const argv = relay.relaySshArgv(r, ['/home/u/.ssh/id_ed25519']);
  const at = argv.indexOf('--');
  assert.deepEqual(argv.slice(at), ['--', 'github.com', "git-upload-pack 'o/r.git'"]);
  for (const o of ['BatchMode=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'RequestTTY=no', 'IdentitiesOnly=yes', 'SendEnv=GIT_PROTOCOL']) {
    assert.ok(argv.slice(0, at).join(' ').includes(o), o);
  }
  assert.deepEqual(argv.slice(argv.indexOf('-i'), argv.indexOf('-i') + 2), ['-i', '/home/u/.ssh/id_ed25519']);
  assert.ok(!argv.includes('ProxyCommand=socat - PROXY:localhost:%h:%p,proxyport=3128'), 'the sandbox\'s proxy stays in the sandbox');
  // A quote in the path is quoted again the way git does.
  assert.equal(relay.relaySshArgv({ host: 'h', service: 'git-upload-pack', path: "a'b" }).at(-1), "git-upload-pack 'a'\\''b'");
  // No keys chosen: ssh's own choice, no IdentitiesOnly.
  assert.ok(!relay.relaySshArgv(r).includes('IdentitiesOnly=yes'));
});

test('the per-agent setting is cleaned: only fingerprints, ask only when true', () => {
  const fp = 'SHA256:RyrTHf/WY2Y9ozs7ShgUfBkCgNohRUoJra6STZJiJ18';
  assert.deepEqual(relay.cleanSshRelayMap({ jim: {}, pam: { keys: [fp, '~/.ssh/id_rsa', fp, 3], ask: true }, bad: 'yes', kev: { ask: 'yes' } }),
    { jim: {}, pam: { keys: [fp], ask: true }, kev: {} });
  assert.deepEqual(relay.cleanSshRelayMap(null), {});
  assert.deepEqual(relay.cleanSshRelayMap([1]), {});
});

test('refused: off, a custodian, an agent without an OS sandbox', () => {
  assert.match(relay.sshRelayRefusal({ granted: false, custodian: false, sandboxed: true }), /Capabilities/);
  assert.match(relay.sshRelayRefusal({ granted: true, custodian: true, sandboxed: true }), /custodian/);
  assert.match(relay.sshRelayRefusal({ granted: true, custodian: false, sandboxed: false }), /sandbox/);
  assert.equal(relay.sshRelayRefusal({ granted: true, custodian: false, sandboxed: true }), null);
});

test('frames survive being cut anywhere', () => {
  const a = relay.encodeFrame(1, Buffer.from('hello'));
  const b = relay.encodeFrame(3, Buffer.from([0, 0, 0, 7]));
  const all = Buffer.concat([a, b]);
  for (let cut = 0; cut <= all.length; cut++) {
    const d = new relay.FrameDecoder();
    const got = [...d.push(all.subarray(0, cut)), ...d.push(all.subarray(cut))];
    assert.deepEqual(got.map((f) => [f.type, Buffer.from(f.data).toString('hex')]), [[1, Buffer.from('hello').toString('hex')], [3, '00000007']]);
  }
  const huge = Buffer.alloc(5); huge[0] = 0; huge.writeUInt32BE(relay.MAX_FRAME + 1, 1);
  assert.throws(() => new relay.FrameDecoder().push(huge), /too large/);
});

test('the key list reads key files and the ssh-agent, each key once', () => {
  const out = [
    'sock\t/home/u/.1password/agent.sock',
    'file\t/home/u/.ssh/id_ed25519.pub\t256 SHA256:RyrTHf/WY2Y9ozs7ShgUfBkCgNohRUoJra6STZJiJ18 no comment (ED25519)',
    'agentfp\t256 SHA256:RyrTHf/WY2Y9ozs7ShgUfBkCgNohRUoJra6STZJiJ18 no comment (ED25519)',
    'agentfp\t4096 SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ (RSA)',
    'agentpub\tssh-ed25519 AAAAC3 x',
    'agentpub\tssh-rsa AAAAB3 work key'
  ].join('\n');
  const r = parseSshKeys(out);
  assert.equal(r.sock, '/home/u/.1password/agent.sock');
  assert.deepEqual(r.keys, [
    { fingerprint: 'SHA256:RyrTHf/WY2Y9ozs7ShgUfBkCgNohRUoJra6STZJiJ18', label: 'ED25519', source: 'file', file: '/home/u/.ssh/id_ed25519.pub' },
    { fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ', label: 'RSA', source: 'agent', pub: 'ssh-rsa AAAAB3 work key' }
  ]);
});

// ─── hidden from the sandbox ────────────────────────────────────────────────

test('key folders are hidden from every sandboxed agent, 1Password\'s socket too', () => {
  for (const d of ['.ssh', '.gnupg', '.1password']) {
    assert.ok(KEY_HOME_DIRS.includes(d), d);
    assert.ok(SECRET_HOME_DIRS.includes(d), d);
  }
});

test('the app\'s bubblewrap (pi, agy) starts no Windows program: WSL interop hidden, WSL_INTEROP unset', () => {
  const { bwrapArgs } = loadTs('src/shared/bwrapSandbox.ts');
  const onWsl = bwrapArgs({ writable: ['/home/u/office'], home: '/home/u' }, (p) => p === '/run/WSL' || p === '/home/u/.1password');
  assert.deepEqual(onWsl.slice(onWsl.indexOf('--unsetenv'), onWsl.indexOf('--unsetenv') + 2), ['--unsetenv', 'WSL_INTEROP']);
  const tmpfs = onWsl.flatMap((a, i) => (a === '--tmpfs' ? [onWsl[i + 1]] : []));
  assert.ok(tmpfs.includes('/run/WSL') && tmpfs.includes('/home/u/.1password'));
  // Plain Linux: nothing to hide.
  const plain = bwrapArgs({ writable: [], home: '/home/u' }, () => false);
  assert.ok(!plain.includes('/run/WSL'));
});

test('a sandboxed Claude agent: ~/.ssh denied to its shell and file tools, the office ssh first on PATH, no ssh-agent', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ssh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  // As on Linux, a WSL floor or macOS: an OS sandbox and the office's ssh.
  const wrapper = path.join(home, 'hive', 'bin', 'ssh');
  hive.sandboxAvailable = async () => true;
  hive.sshWrapperDir = () => wrapper;
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: project }, {});
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  const sshDir = path.join(os.homedir(), '.ssh');
  assert.ok(settings.sandbox.filesystem.denyRead.includes(sshDir), 'denyRead ~/.ssh');
  assert.ok(settings.sandbox.filesystem.denyRead.includes(path.join(os.homedir(), '.gnupg')));
  assert.ok(settings.permissions.deny.includes(`Read(/${sshDir.replace(/\\/g, '/')}/**)`), 'Read(~/.ssh) refused');
  assert.equal(inj.env.MD_PATH_PREPEND, wrapper);
  assert.equal(inj.env.SSH_AUTH_SOCK, '');
  assert.equal(inj.env.GIT_SSH_COMMAND, 'ssh', 'git uses it whatever core.sshCommand says');
  assert.equal(hive.isOsSandboxed('jim'), true);
  // The prepend reaches PATH first.
  const env = buildPtyEnv({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh' }, '/usr/bin:/bin', inj.env, 'linux');
  assert.equal(env.PATH, `${wrapper}:/usr/bin:/bin`);
  assert.equal(env.SSH_AUTH_SOCK, '');
});

test('an agent without an OS sandbox (a Windows floor) gets none of it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ssh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => false;
  hive.sshWrapperDir = () => null;
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'codex', cwd: project }, {});
  assert.equal(inj.env.MD_PATH_PREPEND, undefined);
  assert.equal(hive.isOsSandboxed('jim'), false);
  assert.equal(buildPtyEnv({}, 'C:\\bin', inj.env, 'win32').PATH, 'C:\\bin');
});

// ─── end to end: md-ssh ⇄ broker ⇄ the app's ssh ────────────────────────────

/** The broker with the relay; `ssh` is a node child standing in for the real
 *  one: it echoes stdin back, says something on stderr and exits 7. */
async function office(t, grant, runImpl) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md ssh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const audit = [];
  const ran = [];
  const asked = [];
  const r = new SshRelay({
    grant: () => grant.current,
    custodian: () => false,
    sandboxed: () => true,
    agentName: () => 'Jim',
    identities: async (fps) => fps.map((f) => `/keys/${f.slice(7, 12)}`),
    run: async (argv, env) => {
      ran.push({ argv, env });
      if (runImpl) return runImpl(argv, env);
      return spawn(process.execPath, ['-e', "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stdout.write('got:'+s);process.stderr.write('remote says hi\\n');process.exit(7);});"]);
    },
    ask: async (name, req) => { asked.push(req); return grant.answer !== false; },
    audit: (e) => audit.push(e)
  });
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined, ssh: { upgrade: (a, q, s, h) => r.upgrade(a, q, s, h) } });
  const started = await broker.start(0);
  assert.equal(started.ok, true);
  t.after(() => broker.stop());
  const token = broker.grant('pty-1', [], {}, 'jim');
  return { cli: path.join(home, 'hive', 'bin', 'md-ssh.cjs'), url: broker.url(), token, audit, ran, asked };
}

function runCli(cli, argv, env, input = '') {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...argv], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('relay on: git\'s request runs as the app\'s ssh, its output and exit code come back, the use is audited', async (t) => {
  const o = await office(t, { current: {} });
  const res = await runCli(o.cli, GIT_ARGV, { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token, GIT_PROTOCOL: 'version=2' }, 'want abc\n');
  assert.equal(res.out, 'got:want abc\n');
  assert.match(res.err, /remote says hi/);
  assert.equal(res.code, 7);
  assert.equal(o.ran.length, 1);
  assert.deepEqual(o.ran[0].argv.slice(-3), ['--', 'github.com', "git-upload-pack 'o/r.git'"]);
  assert.deepEqual(o.ran[0].env, { GIT_PROTOCOL: 'version=2' });
  assert.equal(o.audit.length, 1);
  assert.equal(o.audit[0].allowed, true);
  assert.equal(o.audit[0].agentId, 'jim');
  assert.equal(o.audit[0].host, 'github.com');
  assert.equal(o.audit[0].path, 'o/r.git');
  assert.equal(o.audit[0].exit, 7);
  assert.equal(JSON.stringify(o.audit).includes('want abc'), false, 'the transfer is never logged');
});

test('relay off: refused with the hint, nothing runs', async (t) => {
  const o = await office(t, { current: null });
  const res = await runCli(o.cli, GIT_ARGV, { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token });
  assert.equal(res.code, 255);
  assert.match(res.err, /^ssh \(office\): SSH keys are hidden from agents in this office\. Use an HTTPS remote, or ask the human to switch on "Use my SSH keys through the office"/);
  assert.equal(o.ran.length, 0);
  assert.equal(o.audit[0].allowed, false);
});

test('relay on: a shell or a forward is still refused; a bad token gets nothing', async (t) => {
  const o = await office(t, { current: {} });
  const shell = await runCli(o.cli, ['me@server.example.com', 'bash -i'], { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token });
  assert.equal(shell.code, 255);
  assert.match(shell.err, /only git transfers/);
  const fwd = await runCli(o.cli, ['-L', '1:h:2', 'git@github.com', "git-upload-pack 'x'"], { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token });
  assert.equal(fwd.code, 255);
  const bad = await runCli(o.cli, GIT_ARGV, { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: 'nope' });
  assert.equal(bad.code, 255);
  assert.match(bad.err, /invalid capability token/);
  assert.equal(o.ran.length, 0);
});

test('ask first: the human\'s no refuses it; chosen keys go to ssh with -i', async (t) => {
  const fp = 'SHA256:RyrTHf/WY2Y9ozs7ShgUfBkCgNohRUoJra6STZJiJ18';
  const grant = { current: { ask: true, keys: [fp] }, answer: false };
  const o = await office(t, grant);
  const no = await runCli(o.cli, GIT_ARGV, { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token });
  assert.equal(no.code, 255);
  assert.match(no.err, /did not allow/);
  assert.equal(o.asked.length, 1);
  assert.equal(o.ran.length, 0);
  grant.answer = true;
  const yes = await runCli(o.cli, GIT_ARGV, { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token });
  assert.equal(yes.code, 7);
  const argv = o.ran[0].argv;
  assert.deepEqual(argv.slice(argv.indexOf('-i'), argv.indexOf('-i') + 2), ['-i', '/keys/RyrTH']);
  assert.ok(argv.includes('IdentitiesOnly=yes'));
  assert.deepEqual(o.audit.at(-1).keys, [fp]);
});

test('inside Claude Code\'s sandbox md-ssh goes through its proxy with CONNECT', async (t) => {
  const o = await office(t, { current: {} });
  const seen = [];
  const proxy = net.createServer((c) => {
    let head = Buffer.alloc(0);
    const onData = (d) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      c.off('data', onData);
      const req = head.subarray(0, end).toString();
      seen.push(req);
      const [host, port] = /^CONNECT (\S+) /.exec(req)[1].split(':');
      const up = net.connect(+port, host, () => {
        c.write('HTTP/1.1 200 Connection established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) up.write(rest);
        c.pipe(up); up.pipe(c);
      });
      up.on('error', () => c.destroy());
      up.on('close', () => c.destroy());
    };
    c.on('data', onData);
    c.on('error', () => {});
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => proxy.close());
  const res = await runCli(o.cli, GIT_ARGV, {
    MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token, SANDBOX_RUNTIME: '1',
    http_proxy: `http://srt.user:secret@127.0.0.1:${proxy.address().port}`
  }, 'x');
  assert.equal(res.out, 'got:x');
  assert.equal(res.code, 7);
  assert.match(seen[0], new RegExp(`^CONNECT ${o.url.replace('http://', '').replace(/\./g, '\\.')} HTTP/1\\.1`));
  assert.match(seen[0], /Proxy-Authorization: Basic /);
});

test('a real git clone and push run through md-ssh and the relay (large pack, both directions)', async (t) => {
  const { execFileSync, execFile } = require('node:child_process');
  // Async: the broker answering git lives in this process.
  const gitAsync = (args, opts) => new Promise((resolve, reject) => execFile('git', args, opts, (e, out, err) => (e ? reject(new Error(String(err) || e.message)) : resolve(out))));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'md ssh git-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();
  const bare = path.join(work, 'repo.git');
  g(work, 'init', '-q', '--bare', bare);
  g(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const seed = path.join(work, 'seed');
  g(work, 'init', '-q', seed);
  fs.writeFileSync(path.join(seed, 'big.bin'), require('node:crypto').randomBytes(3 * 1024 * 1024));
  g(seed, 'add', '.');
  g(seed, 'commit', '-qm', 'seed');
  g(seed, 'push', '-q', bare, 'HEAD:refs/heads/main');
  // The "real ssh": the transfer command itself, on the local bare repo.
  const o = await office(t, { current: {} }, async (argv, env) => {
    const cmd = argv.at(-1);
    const service = cmd.slice(0, cmd.indexOf(' ')).replace(/^git-/, '');
    assert.equal(relay.unquoteSq(cmd.slice(cmd.indexOf(' ') + 1)), 'office/repo.git');
    return spawn('git', [service, bare], { env: { ...process.env, ...env } });
  });
  const env = {
    ...process.env,
    GIT_SSH_COMMAND: `"${process.execPath.replace(/\\/g, '/')}" "${o.cli.replace(/\\/g, '/')}"`,
    GIT_SSH_VARIANT: 'ssh',
    MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token
  };
  const clone = path.join(work, 'clone');
  await gitAsync(['clone', '-q', 'git@github.example:office/repo.git', clone], { env });
  assert.equal(fs.statSync(path.join(clone, 'big.bin')).size, 3 * 1024 * 1024);
  fs.writeFileSync(path.join(clone, 'note.txt'), 'pushed through the office\n');
  g(clone, 'add', '.');
  g(clone, 'commit', '-qm', 'note');
  await gitAsync(['push', '-q', 'origin', 'HEAD:main'], { cwd: clone, env });
  assert.equal(g(bare, 'show', 'main:note.txt'), 'pushed through the office\n');
  assert.deepEqual(o.audit.map((e) => [e.service, e.allowed, e.exit]), [['git-upload-pack', true, 0], ['git-receive-pack', true, 0]]);
});

test('main: only sshRelay:set turns it on or off; the generic config write drops it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const update = src.slice(src.indexOf("ipcMain.handle('config:update'"), src.indexOf("ipcMain.handle('config:setAgentMcpGrant'"));
  assert.match(update, /agentSshRelay: _sshRelay,[^}]*\.\.\.safePatch \} = patch/);
  const set = src.slice(src.indexOf("ipcMain.handle('sshRelay:set'"));
  assert.match(set.slice(0, 1500), /isCustodian\(/);
  assert.match(set.slice(0, 1500), /appendLog\(\{ kind: 'ssh-relay'/);
});
