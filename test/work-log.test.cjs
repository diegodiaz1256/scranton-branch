'use strict';
// The app writes the orchestrator's work log: asked to in its prompt, a live
// orchestrator still left its memory empty after a delegated job.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { workLogLine, appendWorkLog } = loadTs('src/main/workLog.ts');
const { parseMemory } = loadTs('src/shared/memorySections.ts');

const date = new Date('2026-10-09T14:15:27Z');

test('a finished job: who, what, and its report', () => {
  assert.equal(
    workLogLine({ who: 'line-counter', objective: 'Count the lines of ./project/src/invoices.js', outcome: 'done', result: 'invoices.js has 4 lines', date }),
    '- 2026-10-09: line-counter finished "Count the lines of ./project/src/invoices.js" → invoices.js has 4 lines'
  );
  assert.match(workLogLine({ who: 'w', objective: 'x', outcome: 'done', date }), /\(no report\)$/);
});

test('a job that ended badly says how', () => {
  assert.equal(workLogLine({ who: 'cache-code-reviewer', objective: 'Audit ./project', outcome: 'exited', exitCode: 1, date }),
    '- 2026-10-09: cache-code-reviewer stopped before reporting done (exit 1) on "Audit ./project"');
  assert.match(workLogLine({ who: 'w', outcome: 'idle', date }), /stopped after going idle on its job/);
  assert.match(workLogLine({ who: 'w', outcome: 'tokens', date }), /token cap/);
});

test('long text is kept to one short line', () => {
  const line = workLogLine({ who: 'w', objective: 'a '.repeat(200), outcome: 'done', result: 'b\n'.repeat(300), date });
  assert.ok(!line.includes('\n'));
  assert.ok(line.length < 320, String(line.length));
});

test('the log file gets a heading once and reads as Memory notes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worklog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  appendWorkLog(dir, 'Michael', workLogLine({ who: 'a', objective: 'one', outcome: 'done', result: 'ok', date }));
  appendWorkLog(dir, 'Michael', workLogLine({ who: 'b', objective: 'two', outcome: 'exited', exitCode: 1, date }));
  const text = fs.readFileSync(path.join(dir, 'worklog.md'), 'utf8');
  assert.equal(text.match(/^# Work log — Michael$/gm).length, 1);
  const notes = parseMemory(text);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].date, '2026-10-09');
});

// A pi temp on a WSL floor that died in its first second (bubblewrap refused a
// mount): the raw tail the app captured, escape codes and all (it starts in the
// middle of one: the capture is a ring buffer).
const PI_CRASH_TAIL = '[?9001h\u001b[?1004h\u001b[?25l\u001b[2J\u001b[m\u001b[H\r\n\r\n\r\n\r\n\u001b[H\u001b]0;C:\\WINDOWS\\SYSTEM32\\wsl.exe\u0007\u001b[?25h\u001b[?25l\u001b[K\r\n\u001b[K\r\n\u001b[K\u001b[H\u001b[?25hbwrap: Can\'t mkdir /home/zeroge/offices/e2e-20261024/confidential: Not a directory\r\n';

test('a temp that dies before its done: the orchestrator hears it, with what its terminal said', () => {
  const { workerExitNotice } = loadTs('src/main/workLog.ts');
  const n = workerExitNotice('worker-wf-tests', 1, PI_CRASH_TAIL);
  assert.equal(n.subject, '[worker exited] worker-wf-tests');
  assert.match(n.body, /stopped \(exit 1\) before it reported done: nobody is doing its job now/);
  assert.match(n.body, /Its terminal ended with:\nbwrap: Can't mkdir \/home\/zeroge\/offices\/e2e-20261024\/confidential: Not a directory\n/);
  assert.ok(!/\u001b|\u0007|wsl\.exe/.test(n.body), 'no escape codes or window titles');
  assert.match(n.body, /crashes\//);
  assert.match(n.body, /rather than sending the same request again/);
});

test('an exit with nothing printed still tells the orchestrator', () => {
  const { workerExitNotice, terminalTail } = loadTs('src/main/workLog.ts');
  const n = workerExitNotice('worker-x', 0, '\u001b[2J\r\n\r\n');
  assert.match(n.body, /Its terminal printed nothing/);
  assert.ok(!n.body.includes('crashes/'), 'a clean exit leaves no crash log');
  assert.equal(terminalTail('a\n' + 'x'.repeat(900), 6, 100).length, 100);
  assert.equal(terminalTail('bwrap: failed\r\n'), 'bwrap: failed');
});
