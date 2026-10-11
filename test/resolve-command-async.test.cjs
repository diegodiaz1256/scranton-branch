'use strict';
// Settings → Tools checked a dozen CLIs with a sync `where` (a login shell on
// macOS) each, which froze the main process for 1.2 s (freezes.jsonl:
// ipc tools:status). The async lookup finds the same paths without blocking.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { resolveCommand, resolveCommandAsync } = loadTs('src/main/shellEnv.ts');

test('finds the same binary as the sync lookup', async () => {
  const sync = resolveCommand('node');
  const asyncPath = await resolveCommandAsync('node');
  assert.equal(asyncPath, sync);
  assert.ok(fs.existsSync(asyncPath), asyncPath);
});

test('paths, unsafe names and missing tools come back unchanged', async () => {
  assert.equal(await resolveCommandAsync('/usr/bin/x'), '/usr/bin/x');
  assert.equal(await resolveCommandAsync('C:\\tools\\x.exe'), 'C:\\tools\\x.exe');
  assert.equal(await resolveCommandAsync('a;rm -rf /'), 'a;rm -rf /');
  assert.equal(await resolveCommandAsync('no-such-tool-acme-101'), 'no-such-tool-acme-101');
});

test('tools:status resolves the rows without the sync lookup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const start = src.indexOf("ipcMain.handle('tools:status'");
  const body = src.slice(start, src.indexOf('// ─── IPC: semantic memory', start));
  assert.match(body, /await resolveCommandAsync\(spec\.bin\)/);
  assert.match(body, /await memory\.binAsync\(\)/);
  assert.doesNotMatch(body, /resolveCliCommand\(spec\.bin\)/);
});
