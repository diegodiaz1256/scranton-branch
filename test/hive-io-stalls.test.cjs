'use strict';
// Less blocking I/O in the main process (slow on a WSL office): the log is
// read from its end, and the agents' helper scripts are rewritten only when
// they changed (src/main/hive.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager, tailLines } = loadTs('src/main/hive.ts');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-io-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('tailLines returns the last lines, across chunk boundaries, without a partial line', (t) => {
  const f = path.join(tmp(t), 'log.jsonl');
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(i % 97) }));
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.deepEqual(tailLines(f, 3), lines.slice(-3));
  assert.deepEqual(tailLines(f, 1200), lines.slice(-1200), 'spans many 64 KB chunks');
  assert.deepEqual(tailLines(f, 99999), lines, 'more than the file has: all of it');
  assert.deepEqual(tailLines(path.join(path.dirname(f), 'missing'), 5), []);
  assert.deepEqual(tailLines(f, 0), []);
});

test('the helper scripts are written once, then left alone until they change', (t) => {
  const home = tmp(t);
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const shim = path.join(hive.root(), 'bin', 'sb-run.cjs');
  // Whole seconds, and 1 ms of slack: some filesystems (CI's) store mtimes
  // with less precision than JavaScript's.
  const old = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
  fs.utimesSync(shim, old, old);
  hive.ensureHive();
  assert.ok(Math.abs(fs.statSync(shim).mtimeMs - old.getTime()) < 1, 'unchanged: not rewritten');
  fs.rmSync(shim);
  hive.ensureHive();
  assert.ok(fs.existsSync(shim), 'a missing one is written back');
});
