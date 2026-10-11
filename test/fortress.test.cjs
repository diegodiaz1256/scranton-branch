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

test('the Fortress CLI gets UTF-8 output, so a cp1252 console cannot crash it', () => {
  const { fortressCliEnv } = loadTs('src/main/fortress.ts');
  const env = fortressCliEnv({ PATH: '/bin', PYTHONIOENCODING: 'cp1252' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONUNBUFFERED, '1');
});
