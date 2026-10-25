'use strict';
/**
 * SSH through the office, part two: Git LFS over SSH and commit signing with
 * the human's SSH key (shared/sshRelay.ts, main/sshRelay.ts, md-ssh-sign).
 *
 * LFS's two SSH commands go through the relay like git's own, with the same
 * repository-path check and nothing else. Signing: a sandboxed agent's
 * gpg.ssh.program is the office's md-ssh-sign; the app signs outside the
 * sandbox with one of the human's keys, in the namespace "git" only, and only
 * when "Sign commits with my key" is on for that agent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync, execFile } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const relay = loadTs('src/shared/sshRelay.ts');
const { SshRelay, sshKeyFingerprint, parseSshSigner, SSH_SIGN_SCRIPT } = loadTs('src/main/sshRelay.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const has = (cmd, args) => { try { return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0; } catch { return false; } };
const HAS_LFS = has('git', ['lfs', 'version']);
const HAS_KEYGEN = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined;

// ─── Git LFS: the request filter ────────────────────────────────────────────

test('Git LFS: authenticate and transfer pass with a path and upload or download', () => {
  const ok = (argv, want) => {
    const r = relay.parseSshArgv(argv);
    assert.equal(r.ok, true, `${JSON.stringify(argv)}: ${r.error}`);
    assert.deepEqual(r.req, want);
  };
  // What git-lfs hands ssh (a bare path), with its multiplexing options.
  ok(['-oControlMaster=auto', '-oControlPath=/tmp/sock-x', 'git@github.com', 'git-lfs-authenticate o/r.git download'],
    { host: 'github.com', user: 'git', service: 'git-lfs-authenticate', path: 'o/r.git', operation: 'download' });
  ok(['git@github.com', 'git-lfs-transfer o/r.git upload'],
    { host: 'github.com', user: 'git', service: 'git-lfs-transfer', path: 'o/r.git', operation: 'upload' });
  ok(['-p', '2222', 'git@git.example.com', "git-lfs-transfer '/srv/it'\\''s.git' download"],
    { host: 'git.example.com', user: 'git', port: 2222, service: 'git-lfs-transfer', path: "/srv/it's.git", operation: 'download' });
});

test('Git LFS: anything else on its command line is refused', () => {
  const no = (cmd, why) => {
    const r = relay.parseSshArgv(['git@github.com', cmd]);
    assert.equal(r.ok, false, cmd);
    if (why) assert.match(r.error, why);
  };
  no('git-lfs-authenticate o/r.git', /upload or download/);              // no operation
  no('git-lfs-transfer o/r.git lock', /upload or download/);
  no('git-lfs-authenticate o/r.git download; id', /upload or download/);
  no('git-lfs-transfer o/r.git; id download', /repository path/);         // injected after the path
  no('git-lfs-transfer $(id) upload', /repository path/);
  no("git-lfs-transfer 'a' 'b' upload", /repository path/);
  no('git-lfs-transfer  upload', /repository path/);
  no('git-lfs-locks o/r.git upload', /only git transfers/);              // not one of the two
  no('git-lfs o/r.git upload', /only git transfers/);
});

test('Git LFS: the real ssh gets the path as git-lfs sent it, the operation after it', () => {
  const r = relay.parseSshArgv(['git@github.com', 'git-lfs-authenticate o/r.git upload']).req;
  assert.deepEqual(relay.relaySshArgv(r).slice(-3), ['--', 'github.com', 'git-lfs-authenticate o/r.git upload']);
  const q = relay.relaySshArgv({ host: 'h', service: 'git-lfs-transfer', path: 'my repo.git', operation: 'download' });
  assert.equal(q.at(-1), "git-lfs-transfer 'my repo.git' download");
  // git's own transfers are quoted as before.
  assert.equal(relay.relaySshArgv({ host: 'h', service: 'git-upload-pack', path: 'o/r.git' }).at(-1), "git-upload-pack 'o/r.git'");
});

// ─── signing: the checks ────────────────────────────────────────────────────

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJFk3KcS6efMAmX0aBQ0XWbQjvR3yqYQ1i2Ul1dYpT3a me@laptop';
const COMMIT = 'tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@a> 1 +0000\ncommitter A <a@a> 1 +0000\n\nAdd the thing\n\nbody\n';

test('signing: only the namespace "git", a public key or a key path, nothing private', () => {
  assert.deepEqual(relay.parseSignSpec({ namespace: 'git', pub: `key::${PUB}`, cwd: '/home/u/p' }),
    { ok: true, req: { namespace: 'git', pub: PUB.split(' ').slice(0, 2).join(' '), repo: '/home/u/p' } });
  assert.deepEqual(relay.parseSignSpec({ namespace: 'git', keyPath: '/home/u/.ssh/id_ed25519' }),
    { ok: true, req: { namespace: 'git', keyPath: '/home/u/.ssh/id_ed25519' } });
  for (const ns of ['file', 'email@example.com', 'git ', 'GIT', undefined]) {
    const r = relay.parseSignSpec({ namespace: ns, pub: PUB });
    assert.equal(r.ok, false, String(ns));
    assert.match(r.error, /namespace "git"/);
  }
  assert.equal(relay.parsePubKey('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn...'), null);
  assert.equal(relay.parseSignSpec({ namespace: 'git' }).ok, false);
});

test('signing: only commits, tags and push certificates; the subject for the audit', () => {
  assert.deepEqual(relay.describeSignPayload(COMMIT), { kind: 'commit', subject: 'Add the thing' });
  assert.deepEqual(relay.describeSignPayload('object 4b825dc642cb6eb9a060e54bf8d69288fbee4904\ntype commit\ntag v1.0\ntagger A <a@a> 1 +0000\n\nRelease\n'), { kind: 'tag', subject: 'v1.0: Release' });
  assert.equal(relay.describeSignPayload('certificate version 0.1\npusher A\n\n').kind, 'push');
  assert.equal(relay.describeSignPayload('hello, sign me'), null);
  assert.equal(relay.describeSignPayload('{"amount": 100}'), null);
  assert.equal(relay.describeSignPayload(`tree ${'a'.repeat(40)}\n${'x'.repeat(relay.MAX_SIGN_PAYLOAD)}`), null);
});

test('signing: refused when the sub-switch is off, for a custodian, outside a sandbox', () => {
  assert.match(relay.sshSignRefusal({ grant: null, custodian: false, sandboxed: true }), /Sign commits with my key/);
  assert.match(relay.sshSignRefusal({ grant: {}, custodian: false, sandboxed: true }), /Sign commits with my key/);
  assert.match(relay.sshSignRefusal({ grant: { sign: true }, custodian: true, sandboxed: true }), /custodian/);
  assert.match(relay.sshSignRefusal({ grant: { sign: true }, custodian: false, sandboxed: false }), /sandbox/);
  assert.equal(relay.sshSignRefusal({ grant: { sign: true }, custodian: false, sandboxed: true }), null);
  assert.deepEqual(relay.cleanSshRelayMap({ a: { sign: true }, b: { sign: 'yes' } }), { a: { sign: true }, b: {} });
});

test('the signer config is read from the human\'s global git config', () => {
  assert.deepEqual(parseSshSigner('prog\t/opt/1Password/op-ssh-sign\nkey\tssh-ed25519 AAAA x\n'), { program: '/opt/1Password/op-ssh-sign', signingKey: 'ssh-ed25519 AAAA x' });
  assert.deepEqual(parseSshSigner(''), { program: '', signingKey: '' });
});

test('a sandboxed agent\'s gpg.ssh.program is the office signer, set in its env, the user\'s config untouched', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sign-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  const wrapper = path.join(home, 'hive', 'bin', 'ssh');
  hive.sandboxAvailable = async () => true;
  hive.sshWrapperDir = () => wrapper;
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: project }, {});
  const n = Number(inj.env.GIT_CONFIG_COUNT) - 1;
  assert.ok(n >= 0);
  assert.equal(inj.env[`GIT_CONFIG_KEY_${n}`], 'gpg.ssh.program');
  assert.equal(inj.env[`GIT_CONFIG_VALUE_${n}`], path.join(wrapper, 'md-ssh-sign'));
  assert.match(fs.readFileSync(path.join(wrapper, 'md-ssh-sign'), 'utf8'), /md-ssh-sign\.cjs' "\$@"/);
  assert.ok(fs.existsSync(path.join(home, 'hive', 'bin', 'md-ssh-sign.cjs')));
  // Not sandboxed: none of it.
  hive.sandboxAvailable = async () => false;
  hive.sshWrapperDir = () => null;
  const off = await hive.ensureAgent({ id: 'kev', name: 'Kevin', provider: 'codex', cwd: project }, {});
  assert.equal(Object.values(off.env).includes('gpg.ssh.program'), false);
});

// ─── end to end: md-ssh / md-ssh-sign ⇄ broker ⇄ the app ────────────────────

async function office(t, grant, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md sign-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const audit = [], ran = [], asked = [], signed = [], sshAsked = [];
  const r = new SshRelay({
    grant: () => grant.current,
    custodian: () => !!grant.custodian,
    sandboxed: () => true,
    agentName: () => 'Jim',
    identities: async () => [],
    run: async (argv, env) => { ran.push(argv); return opts.run(argv, env); },
    ask: async (name, req) => { sshAsked.push(req); await new Promise((res) => setTimeout(res, 50)); return true; },
    audit: (e) => audit.push(e),
    signKeys: async () => opts.keys ?? [],
    sign: async (key, payload) => { signed.push({ key, payload: payload.toString() }); return opts.sign(key, payload); },
    askSign: async (name, w) => { asked.push(w); return grant.answer !== false; }
  });
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined, ssh: { upgrade: (a, q, s, h) => r.upgrade(a, q, s, h) } });
  assert.equal((await broker.start(0)).ok, true);
  t.after(() => broker.stop());
  const token = broker.grant('pty-1', [], {}, 'jim');
  return { home, bin: path.join(home, 'hive', 'bin'), url: broker.url(), token, audit, ran, asked, signed, sshAsked };
}

const gitAsync = (args, opts) => new Promise((resolve, reject) => execFile('git', args, opts, (e, out, err) => (e ? reject(new Error(`${String(err)}${e.message}`)) : resolve(String(out)))));

test('a real git-lfs push and clone run through md-ssh and the relay (git-lfs-transfer)', { skip: !HAS_LFS && 'git-lfs is not installed' }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'md lfs-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();
  const bare = path.join(work, 'repo.git');
  const store = path.join(work, 'lfs-store');
  g(work, 'init', '-q', '--bare', bare);
  g(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const server = path.join(__dirname, 'fixtures', 'lfs-transfer-server.cjs');
  // The "real ssh" on the host: git's transfer commands and git-lfs-transfer
  // run on the local repository and object store.
  const o = await office(t, { current: { ask: true } }, {
    run: async (argv, env) => {
      const cmd = argv.at(-1);
      const [service, ...rest] = cmd.split(' ');
      if (service === 'git-lfs-transfer') {
        assert.equal(rest[0], 'office/repo.git');
        return spawn(process.execPath, [server, store, rest[1]], { env: { ...process.env, ...env } });
      }
      return spawn('git', [service.replace(/^git-/, ''), bare], { env: { ...process.env, ...env } });
    }
  });
  const cli = path.join(o.bin, 'md-ssh.cjs');
  const env = {
    ...process.env,
    GIT_SSH_COMMAND: `"${process.execPath.replace(/\\/g, '/')}" "${cli.replace(/\\/g, '/')}"`,
    GIT_SSH_VARIANT: 'ssh',
    GIT_TERMINAL_PROMPT: '0',
    MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token
  };
  const lfsCfg = ['-c', 'filter.lfs.process=git-lfs filter-process', '-c', 'filter.lfs.required=true', '-c', 'filter.lfs.clean=git-lfs clean -- %f', '-c', 'filter.lfs.smudge=git-lfs smudge -- %f', '-c', 'lfs.ssh.automultiplex=false'];
  const seed = path.join(work, 'seed');
  g(work, 'init', '-q', seed);
  fs.writeFileSync(path.join(seed, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  const blob = require('node:crypto').randomBytes(2 * 1024 * 1024);
  fs.writeFileSync(path.join(seed, 'big.bin'), blob);
  g(seed, ...lfsCfg, 'add', '.');
  g(seed, ...lfsCfg, 'commit', '-qm', 'seed');
  g(seed, 'remote', 'add', 'origin', 'git@github.example:office/repo.git');
  await gitAsync([...lfsCfg, 'push', '-q', 'origin', 'HEAD:main'], { cwd: seed, env });
  const oid = require('node:crypto').createHash('sha256').update(blob).digest('hex');
  assert.ok(fs.existsSync(path.join(store, oid)), 'the LFS object reached the server through the relay');
  assert.match(g(bare, 'show', 'main:big.bin'), /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:/, 'git holds only the pointer');
  const clone = path.join(work, 'clone');
  await gitAsync([...lfsCfg, 'clone', '-q', 'git@github.example:office/repo.git', clone], { env });
  assert.ok(Buffer.compare(fs.readFileSync(path.join(clone, 'big.bin')), blob) === 0, 'the clone has the real file, fetched through the relay');
  const lfsUses = o.audit.filter((e) => e.service === 'git-lfs-transfer');
  assert.ok(lfsUses.length >= 2, JSON.stringify(o.audit));
  // Its parallel sessions all fit (no "too many at once"), every one audited.
  assert.ok(lfsUses.every((e) => e.allowed && e.exit === 0 && e.path === 'office/repo.git'), JSON.stringify(lfsUses));
  // "Ask me first": one question per LFS push or fetch, not one per worker.
  const lfsAsks = o.sshAsked.filter((q) => q.service === 'git-lfs-transfer');
  assert.deepEqual([...new Set(lfsAsks.map((q) => q.operation))].sort(), ['download', 'upload']);
  assert.equal(lfsAsks.length, 2, JSON.stringify(lfsAsks));
});

test('Git LFS while the relay is off: refused with the hint, nothing runs', async (t) => {
  const o = await office(t, { current: null }, { run: () => { throw new Error('ran'); } });
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(o.bin, 'md-ssh.cjs'), 'git@github.com', 'git-lfs-authenticate o/r.git download'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token } });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, err }));
  });
  assert.equal(res.code, 255);
  assert.match(res.err, /SSH keys are hidden from agents in this office/);
  assert.equal(o.ran.length, 0);
});

/** A throwaway ed25519 key: the human's key in these tests. */
function testKey(dir) {
  const key = path.join(dir, 'id_test');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'human@test', '-f', key]);
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim();
  return { key, pub, fp: sshKeyFingerprint(pub) };
}
/** The app's signer, here: ssh-keygen with the key file. */
const keygenSign = (keyFile) => async (_key, payload) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sig-'));
  try {
    fs.writeFileSync(path.join(d, 'p'), payload);
    const r = spawnSync('ssh-keygen', ['-Y', 'sign', '-n', 'git', '-f', keyFile, path.join(d, 'p')], { encoding: 'utf8' });
    return { code: r.status ?? 255, sig: r.status === 0 ? fs.readFileSync(path.join(d, 'p.sig')) : Buffer.alloc(0), err: r.stderr };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
};

function runSign(bin, argv, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(bin, 'md-ssh-sign.cjs'), ...argv], { cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('the key fingerprint matches ssh-keygen\'s', { skip: !HAS_KEYGEN && 'no ssh-keygen' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const k = testKey(dir);
  const l = execFileSync('ssh-keygen', ['-lf', `${k.key}.pub`]).toString();
  assert.ok(l.includes(k.fp), `${l} vs ${k.fp}`);
});

test('git commit -S through the office signer: verify-commit accepts it; off, another namespace, a stranger\'s key are refused', { skip: !HAS_KEYGEN && 'no ssh-keygen' }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'md sign git-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const k = testKey(work);
  const grant = { current: { sign: true } };
  const o = await office(t, grant, { keys: [{ fingerprint: k.fp, label: 'ED25519', source: 'file', file: `${k.key}.pub` }], sign: keygenSign(k.key) });
  // The office signer as the agent gets it: GIT_CONFIG_* in its env, a
  // literal public key in the repository's config (git writes it to a temp
  // file and passes it with -f).
  const signer = path.join(work, 'md-ssh-sign.cmd');
  const program = process.platform === 'win32'
    ? (fs.writeFileSync(signer, `@"${process.execPath}" "${path.join(o.bin, 'md-ssh-sign.cjs')}" %*\r\n`), signer)
    : (fs.writeFileSync(signer, `#!/bin/sh\nexec "${process.execPath}" "${path.join(o.bin, 'md-ssh-sign.cjs')}" "$@"\n`, { mode: 0o755 }), signer);
  const repo = path.join(work, 'repo');
  const allowed = path.join(work, 'allowed_signers');
  fs.writeFileSync(allowed, `human@test ${k.pub}\n`);
  const g = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString();
  fs.mkdirSync(repo);
  g('init', '-q');
  for (const [kk, v] of [['user.name', 'Jim'], ['user.email', 'human@test'], ['gpg.format', 'ssh'], ['user.signingkey', k.pub], ['gpg.ssh.allowedSignersFile', allowed.replace(/\\/g, '/')]]) g('config', kk, v);
  const env = { ...process.env, MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'gpg.ssh.program', GIT_CONFIG_VALUE_0: program.replace(/\\/g, '/') };
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '.');
  await gitAsync(['commit', '-S', '-qm', 'Signed by the office'], { cwd: repo, env });
  const v = spawnSync('git', ['verify-commit', '-v', 'HEAD'], { cwd: repo, encoding: 'utf8' });
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stderr, /Good "git" signature for human@test/);
  assert.equal(o.signed.length, 1);
  assert.deepEqual(o.signed[0].key, { file: `${k.key}.pub` }, 'signed with the human\'s key file, found by its fingerprint');
  const use = o.audit.at(-1);
  assert.equal(use.allowed, true);
  assert.equal(use.service, 'sign');
  assert.equal(use.subject, 'commit: Signed by the office');
  assert.deepEqual(use.keys, [k.fp]);
  assert.equal(path.resolve(use.path), path.resolve(repo));
  assert.equal(JSON.stringify(o.audit).includes('tree '), false, 'the payload is never logged');

  // Off (the sub-switch): a clear error, nothing signed.
  grant.current = {};
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  g('add', '.');
  await assert.rejects(gitAsync(['commit', '-S', '-qm', 'not signed'], { cwd: repo, env }), /sign \(office\): commit signing with the human's SSH key is off for you.*Sign commits with my key/s);
  assert.equal(o.signed.length, 1);
  grant.current = { sign: true };

  // Another namespace (a file signature, an email): refused, audited.
  const payload = path.join(work, 'anything.txt');
  fs.writeFileSync(payload, 'pay 100 to mallory\n');
  const pubFile = path.join(work, 'k.pub');
  fs.writeFileSync(pubFile, `${k.pub}\n`);
  const ns = await runSign(o.bin, ['-Y', 'sign', '-n', 'file', '-f', pubFile, payload], { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token }, work);
  assert.equal(ns.code, 255);
  assert.match(ns.err, /^sign \(office\): the office signs git objects only \(namespace "git"\), not "file"/);
  assert.equal(fs.existsSync(`${payload}.sig`), false);
  assert.equal(o.audit.at(-1).allowed, false);
  // Namespace git, but not a git object.
  const notGit = await runSign(o.bin, ['-Y', 'sign', '-n', 'git', '-f', pubFile, payload], { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token }, work);
  assert.equal(notGit.code, 1);
  assert.match(notGit.err, /only git commits, tags and push certificates/);
  // A key that is not the human's.
  const other = testKey(fs.mkdtempSync(path.join(work, 'x')));
  fs.writeFileSync(pubFile, `${other.pub}\n`);
  fs.writeFileSync(payload, COMMIT);
  const stranger = await runSign(o.bin, ['-Y', 'sign', '-n', 'git', '-f', pubFile, payload], { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token }, work);
  assert.equal(stranger.code, 255);
  assert.match(stranger.err, /not one of the human's SSH keys/);
  // Keys chosen for the agent: another one is refused.
  grant.current = { sign: true, keys: [other.fp] };
  fs.writeFileSync(pubFile, `${k.pub}\n`);
  const notChosen = await runSign(o.bin, ['-Y', 'sign', '-n', 'git', '-f', pubFile, payload], { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token }, work);
  assert.match(notChosen.err, /did not choose that key/);
  // A custodian: refused.
  grant.current = { sign: true };
  grant.custodian = true;
  const cust = await runSign(o.bin, ['-Y', 'sign', '-n', 'git', '-f', pubFile, payload], { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token }, work);
  assert.match(cust.err, /custodian/);
  grant.custodian = false;
  assert.equal(o.signed.length, 1, 'none of those reached the signer');
});

test('ask first: the human sees the subject; their no refuses it', { skip: !HAS_KEYGEN && 'no ssh-keygen' }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ask-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const k = testKey(work);
  const grant = { current: { sign: true, ask: true }, answer: false };
  const o = await office(t, grant, { keys: [{ fingerprint: k.fp, label: 'ED25519', source: 'agent', pub: k.pub }], sign: keygenSign(k.key) });
  const payload = path.join(work, 'commit');
  fs.writeFileSync(payload, COMMIT);
  const pubFile = path.join(work, 'k.pub');
  fs.writeFileSync(pubFile, `${k.pub}\n`);
  const env = { MD_BROKER_URL: o.url, MD_BROKER_TOKEN: o.token };
  const no = await runSign(o.bin, ['-Y', 'sign', '-n', 'git', '-f', pubFile, payload], env, work);
  assert.equal(no.code, 1);
  assert.match(no.err, /did not allow/);
  assert.deepEqual(o.asked[0], { kind: 'commit', subject: 'Add the thing', repo: work, fingerprint: k.fp });
  assert.equal(o.signed.length, 0);
  grant.answer = true;
  const yes = await runSign(o.bin, ['-Y', 'sign', '-n', 'git', '-f', pubFile, payload], env, work);
  assert.equal(yes.code, 0, yes.err);
  assert.match(fs.readFileSync(`${payload}.sig`, 'utf8'), /^-----BEGIN SSH SIGNATURE-----/);
  assert.deepEqual(o.signed[0].key, { pub: k.pub }, 'an ssh-agent key: signed by its public half');
});

test('the signer script signs in the namespace "git" with a key file', { skip: (!HAS_KEYGEN || !has('sh', ['-c', 'true'])) && 'no sh or ssh-keygen' }, (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'md-script-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const k = testKey(work);
  const b64 = (s) => Buffer.from(s).toString('base64');
  const r = spawnSync('sh', ['-c', SSH_SIGN_SCRIPT], { input: COMMIT, env: { ...process.env, MD_SIGN_PROG: '', MD_SIGN_KEYFILE: b64(`${k.key.replace(/\\/g, '/')}.pub`) } });
  assert.equal(r.status, 0, String(r.stderr));
  const sig = r.stdout.toString();
  assert.match(sig, /^-----BEGIN SSH SIGNATURE-----/);
  fs.writeFileSync(path.join(work, 's.sig'), sig);
  fs.writeFileSync(path.join(work, 'allowed'), `h ${k.pub}\n`);
  const v = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(work, 'allowed'), '-I', 'h', '-n', 'git', '-s', path.join(work, 's.sig')], { input: COMMIT });
  assert.equal(v.status, 0, String(v.stderr));
  const wrongNs = spawnSync('ssh-keygen', ['-Y', 'verify', '-f', path.join(work, 'allowed'), '-I', 'h', '-n', 'file', '-s', path.join(work, 's.sig')], { input: COMMIT });
  assert.notEqual(wrongNs.status, 0, 'a git signature is no good in another namespace');
});
