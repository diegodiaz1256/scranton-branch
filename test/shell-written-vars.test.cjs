'use strict';
// A shell write through a variable the same command line set
// (`H=../hive; cat > $H/research/WF-1/summary.html`) is a write to that path.
// Seen on a WSL floor (final e2e, 2026-10-25): god wrote its deliverable this
// way; the Deliverables recorded "<project>/$H/research/WF-1/summary.html"
// (a path that does not exist), never committed the report, and its History
// stayed empty.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { shellWrittenPaths, callWrittenFiles } = loadTs('src/shared/toolGuard.ts');

const office = '/home/zeroge/offices/e2e-final-1025';

test('the recorded god call writes the report in research/', () => {
  // God's Bash call from the transcript (the HTML shortened).
  const command = `cd ${office}/wordfreq; sed -i 's#node --test test/"#node --test"#' package.json; npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'\nH=../hive; mkdir -p $H/research/WF-1\ncat > $H/research/WF-1/summary.html <<'E'\n<!doctype html><html><body><h1>wordfreq</h1></body></html>\nE\ncd $H && pwd && ls research/WF-1/summary.html`;
  assert.deepEqual(callWrittenFiles('Bash', { command }, `${office}/hive/agents/god`), [
    `${office}/wordfreq/package.json`,
    `${office}/hive/research/WF-1/summary.html`
  ]);
});

test('variables set earlier on the line, quoted or exported', () => {
  assert.deepEqual(shellWrittenPaths('R=research; echo x > $R/a.md'), ['research/a.md']);
  assert.deepEqual(shellWrittenPaths('R="research/q 1"; echo x > "$R/a.md"'), ['research/q 1/a.md']);
  assert.deepEqual(shellWrittenPaths('export R=/tmp/out && echo x >> $R/b.md'), ['/tmp/out/b.md']);
  assert.deepEqual(shellWrittenPaths('cd /x/y && D=../z; touch $D/c.md'), ['/x/z/c.md']);
});

test('a variable the line never set is still left out, also after a cd', () => {
  assert.deepEqual(shellWrittenPaths('cd /x && echo x > $OUT/a.md; echo y > "$HOME/b.md"'), []);
  assert.deepEqual(callWrittenFiles('Bash', { command: 'cd /x && echo x > $OUT/a.md' }, '/w'), []);
});
