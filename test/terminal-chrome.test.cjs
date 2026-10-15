'use strict';
// Agent cards skip a CLI's footer (src/shared/terminalChrome.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { isChromeLine, usageNotice } = loadTs('src/shared/terminalChrome.ts');

test('Claude Code footer lines are chrome; conversation is not', () => {
  for (const l of [
    "——You've used 91% of your session limit · resets 10:40pm",
    '(Europe/Paris) · /upgr',
    'ad                       · 5h 91%',
    'ctx 0k/1000k (0%) · 5h 91%',
    '›› bypass permissions on (shift+tab to cycle) · ← 2 agents'
  ]) assert.equal(isChromeLine(l), true, l);
  for (const l of ['Pushed fix to origin/main', 'Reading src/index.ts', 'Tests: 42 passed']) assert.equal(isChromeLine(l), false, l);
});

test('the usage warning becomes one number', () => {
  assert.deepEqual(usageNotice(['x', "You've used 91% of your session limit · resets 10:40pm"]), { percent: 91, window: 'session' });
  assert.equal(usageNotice(['nothing here']), null);
});
