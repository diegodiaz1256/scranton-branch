'use strict';
// Antigravity's shell tool is run_command { CommandLine }: what it writes is
// that agent's change in the Deliverables, as for every other CLI's shell. The
// guard already read CommandLine; the Deliverables did not. Seen on a WSL floor
// (final e2e, 2026-10-25): the agy worker's run_command calls carried no files
// in the steps the app kept for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { callWrittenFiles } = loadTs('src/shared/toolGuard.ts');

const project = '/home/zeroge/offices/e2e-final-1025/wordfreq';

test('an agy run_command that writes a report counts, made absolute against its folder', () => {
  assert.deepEqual(
    callWrittenFiles('run_command', { CommandLine: 'echo "# Notes" > research/notes.md', WaitMsBeforeAsync: 5000 }, '/home/zeroge/offices/e2e-final-1025/hive'),
    ['/home/zeroge/offices/e2e-final-1025/hive/research/notes.md']
  );
  assert.deepEqual(
    callWrittenFiles('run_command', { CommandLine: `cd ${project} && sed -i 's/a/b/' README.md`, toolSummary: 'Edit README' }, project),
    [`${project}/README.md`]
  );
});

test('a run_command that writes nothing names no file', () => {
  assert.deepEqual(callWrittenFiles('run_command', { CommandLine: `cd ${project} && npm test` }, project), []);
});
