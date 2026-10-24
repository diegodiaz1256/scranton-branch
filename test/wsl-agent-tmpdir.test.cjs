'use strict';
// A WSL office's Claude agents keep their temp files under the user's own
// cache (CLAUDE_CODE_TMPDIR), not in /tmp/claude-<uid>, which a WSL restart
// wipes and any identity in the distro may recreate with the wrong owner or
// mode, after which Claude refuses to start. The script that makes the folder
// runs inside the distro before each spawn; here it runs in this machine's sh.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { AGENT_TMP_SCRIPT } = loadTs('src/main/wsl.ts');

const sh = (() => { try { execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const run = (env) => execFileSync('sh', ['-c', AGENT_TMP_SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });

test('makes a private folder in the user cache and prints it last', { skip: !sh && 'no sh' }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md tmp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const out = run({ HOME: home }).trim().split(/\r?\n/).pop();
  assert.ok(out.endsWith('/.cache/scranton-branch/tmp'), out);
  assert.ok(fs.statSync(path.join(home, '.cache', 'scranton-branch', 'tmp')).isDirectory());
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(home, '.cache', 'scranton-branch', 'tmp')).mode & 0o777, 0o700);
  }
});

test('XDG_CACHE_HOME is honoured', { skip: !sh && 'no sh' }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md tmp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cache = path.join(home, 'xdg cache');
  const out = run({ HOME: home, XDG_CACHE_HOME: cache.replace(/\\/g, '/') }).trim().split(/\r?\n/).pop();
  assert.ok(out.endsWith('/xdg cache/scranton-branch/tmp'), out);
});

test('a folder whose mode was changed is repaired', { skip: process.platform === 'win32' || !sh }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md tmp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.cache', 'scranton-branch', 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o000);
  run({ HOME: home });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
