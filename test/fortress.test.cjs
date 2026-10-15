'use strict';
// Fortress as the office browser engine (src/main/fortress.ts): the pinned
// release, its checksum lookup, and the activation link.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fortressAsset, sha256For, approvalUrlIn, commandLine, Fortress, FORTRESS_TAG } = loadTs('src/main/fortress.ts');

test('the pinned release has an archive only where Fortress ships one', () => {
  assert.equal(fortressAsset('linux', 'x64'), 'fortress-v153-linux-x64.tar.gz');
  assert.equal(fortressAsset('linux', 'arm64'), 'fortress-v153-linux-arm64.tar.gz');
  assert.equal(fortressAsset('win32', 'x64'), 'fortress-v153-win-x64.zip');
  assert.equal(fortressAsset('darwin', 'arm64'), 'fortress-v153-mac-arm64.tar.gz');
  assert.equal(fortressAsset('darwin', 'x64'), null, 'no Intel Mac build');
  assert.equal(fortressAsset('win32', 'arm64'), null);
  assert.match(FORTRESS_TAG, /^v153\./, 'pinned, never "latest"');
});

test('a checksum is found by exact file name, in either SHA256SUMS style', () => {
  const a = 'a'.repeat(64), b = 'B'.repeat(64);
  const sums = `${a}  fortress-v153-linux-x64.tar.gz\n${b} *fortress-v153-win-x64.zip\n`;
  assert.equal(sha256For(sums, 'fortress-v153-linux-x64.tar.gz'), a);
  assert.equal(sha256For(sums, 'fortress-v153-win-x64.zip'), 'b'.repeat(64));
  assert.equal(sha256For(sums, 'fortress-v153-linux-x64.tar'), null, 'no prefix match');
  assert.equal(sha256For('', 'x'), null);
});

test('the approval link is read from the activator output', () => {
  assert.equal(approvalUrlIn('Open https://fortress.tilion.com/activate?code=ABCD-1234. Waiting…'), 'https://fortress.tilion.com/activate?code=ABCD-1234');
  assert.equal(approvalUrlIn('no link yet'), null);
});

test('nothing installed: no launcher, so the office browser keeps the built-in engine', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fortress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = new Fortress({ baseDir: dir, uvPath: () => null, env: () => process.env, platform: 'linux', arch: 'x64' });
  assert.equal(f.launcherPath(), null);
  const st = await f.status();
  assert.equal(st.supported, true);
  assert.equal(st.installed, false);
  assert.equal(st.activator, null);
  await assert.rejects(() => f.ensureEngine(), /not installed/);
  // An extracted tree without the verified marker never counts as installed.
  fs.mkdirSync(path.join(dir, FORTRESS_TAG, 'fortress-v153'), { recursive: true });
  fs.writeFileSync(path.join(dir, FORTRESS_TAG, 'fortress-v153', 'tilion'), '');
  assert.equal(f.launcherPath(), null);
  fs.writeFileSync(path.join(dir, FORTRESS_TAG, '.verified'), '{}');
  assert.equal(f.launcherPath(), path.join(dir, FORTRESS_TAG, 'fortress-v153', 'tilion'));
});

test('a Windows .cmd (tillion.cmd, a pip shim) runs through cmd.exe, quoted; anything else runs directly', () => {
  const launcher = 'C:\\Users\\Ana Ruiz\\AppData\\Roaming\\app\\fortress\\tillion.cmd';
  const w = commandLine('win32', launcher, ['--headless=new', '--user-data-dir=C:\\Users\\Ana Ruiz\\profile']);
  assert.equal(w.file, 'cmd.exe');
  assert.equal(w.verbatim, true);
  assert.deepEqual(w.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(w.args[3], `""${launcher}" "--headless=new" "--user-data-dir=C:\\Users\\Ana Ruiz\\profile""`, 'paths with spaces stay one argument');
  assert.deepEqual(commandLine('win32', 'C:\\uv\\uv.exe', ['tool', 'run']), { file: 'C:\\uv\\uv.exe', args: ['tool', 'run'], verbatim: false });
  assert.deepEqual(commandLine('linux', '/x/tilion.cmd', ['a']), { file: '/x/tilion.cmd', args: ['a'], verbatim: false });
});

// Settings polls the status every few seconds; walking the bundle and a sync
// `where uv` each time froze the main process (freezes.jsonl: fortress:status).
test('repeated status checks reuse the launcher and the CLI lookups', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fortress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let uvLookups = 0;
  const f = new Fortress({ baseDir: dir, uvPath: () => { uvLookups++; return null; }, env: () => process.env, platform: 'linux', arch: 'x64' });
  const deep = path.join(dir, FORTRESS_TAG, 'fortress-v153', 'bin');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'tilion'), '');
  fs.writeFileSync(path.join(dir, FORTRESS_TAG, '.verified'), '{}');
  assert.equal(f.launcherPath(), path.join(deep, 'tilion'));
  // A second launcher higher up would win a fresh walk; the cached one is kept.
  fs.writeFileSync(path.join(dir, FORTRESS_TAG, 'tilion'), '');
  assert.equal(f.launcherPath(), path.join(deep, 'tilion'));
  for (let i = 0; i < 3; i++) await f.status();
  assert.equal(uvLookups, 1);
  // Gone from disk (removed or reinstalled): looked up again.
  fs.rmSync(path.join(deep, 'tilion'));
  assert.equal(f.launcherPath(), path.join(dir, FORTRESS_TAG, 'tilion'));
  fs.rmSync(path.join(dir, FORTRESS_TAG, '.verified'));
  assert.equal(f.launcherPath(), null);
});

test('the Fortress CLI gets UTF-8 output, so a cp1252 console cannot crash it', () => {
  const { fortressCliEnv } = loadTs('src/main/fortress.ts');
  const env = fortressCliEnv({ PATH: '/bin', PYTHONIOENCODING: 'cp1252' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONUNBUFFERED, '1');
});

// A Fortress that did not shut down cleanly left SingletonLock on its profile,
// and every later start failed (the office browser silently fell back).
test('a stale or orphaned profile lock is cleared; anything else is left alone', { skip: process.platform === 'win32' && 'Chromium locks with a file handle on Windows' }, (t) => {
  const { clearStaleProfileLock } = loadTs('src/main/fortress.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fortress-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const host = os.hostname();
  const lockTo = (target) => {
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) fs.rmSync(path.join(dir, f), { force: true });
    fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
    fs.symlinkSync('123', path.join(dir, 'SingletonCookie'));
  };
  const gone = () => !fs.existsSync(path.join(dir, 'SingletonCookie')) && (() => { try { fs.readlinkSync(path.join(dir, 'SingletonLock')); return false; } catch { return true; } })();

  assert.equal(clearStaleProfileLock(dir, 'linux'), 'none', 'no lock');

  lockTo(`${host}-4242`);
  assert.equal(clearStaleProfileLock(dir, 'linux', () => false), 'stale-removed');
  assert.ok(gone(), 'the process is gone: lock files removed');

  lockTo(`${host}-4242`);
  const killed = [];
  assert.equal(clearStaleProfileLock(dir, 'linux', () => true, () => `chrome --headless=new --user-data-dir=${dir}`, (p) => killed.push(p)), 'orphan-stopped');
  assert.deepEqual(killed, [4242], 'our own orphaned engine is stopped');
  assert.ok(gone());

  lockTo(`${host}-4242`);
  assert.equal(clearStaleProfileLock(dir, 'linux', () => true, () => 'firefox', () => assert.fail('must not kill')), 'in-use');
  lockTo('another-host-4242');
  assert.equal(clearStaleProfileLock(dir, 'linux', () => false), 'in-use', 'another machine\'s lock (a shared folder) is not ours');
  assert.equal(clearStaleProfileLock(dir, 'win32'), 'none');
});
