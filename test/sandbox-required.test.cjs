'use strict';
// Where Claude Code's OS sandbox can run (bubblewrap on Linux or in a WSL
// floor's distro), it is required: if it fails to start, the agent's shell
// refuses instead of running unconfined. Elsewhere nothing changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

function hive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sbx-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const h = new HiveManager(() => home);
  h.ensureHive();
  return { h, home };
}

test('with a sandbox available, the agent settings require it', (t) => {
  const { h, home } = hive(t);
  const s = h.hookSettings(path.join(home, 'hive', 'bin', 'cth-hook.cjs'), undefined, [home], true);
  assert.equal(s.sandbox.enabled, true);
  assert.equal(s.sandbox.failIfUnavailable, true);
});

test('without one, the sandbox stays best-effort (Windows, or no bubblewrap)', (t) => {
  const { h, home } = hive(t);
  const s = h.hookSettings(path.join(home, 'hive', 'bin', 'cth-hook.cjs'), undefined, [home], false);
  assert.equal(s.sandbox.enabled, true);
  assert.equal('failIfUnavailable' in s.sandbox, false);
});

test('native Windows has no Claude sandbox to require', { skip: process.platform !== 'win32' }, async (t) => {
  const { h } = hive(t);
  assert.equal(await h.sandboxAvailable(), false);
});
