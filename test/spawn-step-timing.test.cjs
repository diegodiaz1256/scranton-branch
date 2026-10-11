'use strict';
// An agent start froze the main process for ~0.9 s on a real install, and the
// freeze log only said "ipc pty:spawn (async)". Each start step now reports its
// duration to the freeze monitor, so the next stall names the slow step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { FreezeMonitor } = loadTs('src/main/freezeLog.ts');

const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

test('each step hands its duration to the freeze monitor', () => {
  const fn = src.slice(src.indexOf('function spawnStep('), src.indexOf('function spawnStepsDone('));
  assert.match(fn, /freezes\.noteOp\(`spawn: \$\{prev\}`, now - at\)/);
  assert.match(src, /spawnStepsDone\(opts\.id\);\s*spawnStep\(opts\.id, 'checking the command and folder'\);/);
  assert.match(src, /spawnStep\(opts\.id, 'keys, connections and engine settings'\);/);
});

test('a slow step shows up in the freeze entry, a quick one does not', (t) => {
  const file = path.join(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'md-spawn-steps-')), 'freezes.jsonl');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  let now = 0;
  const m = new FreezeMonitor({ file, now: () => now });
  m.start(); m.stop(); // sets the first beat at t=0
  now = 950;
  m.noteOp('spawn: starting the terminal', 900);
  m.noteOp('spawn: certificates', 5);
  now = 1000;
  m.beat(); // 900 ms late: a freeze
  const entry = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.deepEqual(entry.during.map((d) => d.label), ['spawn: starting the terminal']);
  assert.equal(entry.during[0].ms, 900);
});
