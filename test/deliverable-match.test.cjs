'use strict';
// A path an agent prints in its terminal opens in Deliverables when it is one:
// the same file whether printed as a Linux path, relative to the agent's
// folder, or as \\wsl.localhost / \\wsl$ — and nothing else does.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { matchDeliverable, deliverableKey } = loadTs('src/shared/deliverableMatch.ts');

const wsl = {
  researchDir: '\\\\wsl.localhost\\Ubuntu\\home\\zeroge\\offices\\x\\hive\\research',
  distro: 'Ubuntu',
  known: ['\\\\wsl.localhost\\Ubuntu\\home\\zeroge\\proj\\docs\\release-notes.html']
};

test('a WSL floor: Linux, relative, \\\\wsl.localhost and \\\\wsl$ spellings are the same deliverable', () => {
  const key = deliverableKey('\\\\wsl.localhost\\Ubuntu\\home\\zeroge\\offices\\x\\hive\\research\\DUN-12\\report.md');
  for (const [p, cwd] of [
    ['/home/zeroge/offices/x/hive/research/DUN-12/report.md'],
    ['research/DUN-12/report.md', '/home/zeroge/offices/x/hive'],
    ['./research/DUN-12/report.md', '/home/zeroge/offices/x/hive/'],
    ['../hive/research/DUN-12/report.md', '/home/zeroge/offices/x/agents'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\zeroge\\offices\\x\\hive\\research\\DUN-12\\report.md'],
    ['\\\\wsl$\\Ubuntu\\home\\zeroge\\offices\\x\\hive\\research\\DUN-12\\report.md'],
    ['//wsl.localhost/ubuntu/home/zeroge/offices/x/hive/research/DUN-12/REPORT.md']
  ]) {
    const hit = matchDeliverable(p, wsl, cwd);
    assert.ok(hit, `${p} is a deliverable`);
    assert.equal(deliverableKey(hit, 'Ubuntu'), key, p);
  }
});

test('the match is spelled as the list spells it, so the view finds its row', () => {
  const listed = '\\\\wsl.localhost\\Ubuntu\\home\\zeroge\\offices\\x\\hive\\research\\DUN-12\\report.md';
  assert.equal(matchDeliverable('\\\\wsl$\\Ubuntu\\home\\zeroge\\offices\\x\\hive\\research\\DUN-12\\report.md', wsl), listed);
  assert.equal(matchDeliverable('/home/zeroge/offices/x/hive/research/./DUN-12/report.md', wsl), listed);
  const mac = { researchDir: '/Users/d/office/hive/research/', distro: null, known: [] };
  assert.equal(matchDeliverable('research/2026-10-24-pricing/report.md', mac, '/Users/d/office/hive'), '/Users/d/office/hive/research/2026-10-24-pricing/report.md');
});

test('a file the list knows outside research/ matches; other files do not', () => {
  assert.equal(matchDeliverable('/home/zeroge/proj/docs/release-notes.html', wsl), wsl.known[0]);
  assert.equal(matchDeliverable('/home/zeroge/proj/src/index.ts', wsl), null);
  assert.equal(matchDeliverable('/home/zeroge/offices/x/hive/registry.json', wsl), null);
  assert.equal(matchDeliverable('/home/zeroge/offices/x/hive/researcher/a.md', wsl), null);
  // Hire proposals live under research/ but are not deliverables.
  assert.equal(matchDeliverable('/home/zeroge/offices/x/hive/research/hires/pam.json', wsl), null);
  // A relative path with no folder to resolve it against is nothing.
  assert.equal(matchDeliverable('research/DUN-12/report.md', wsl), null);
});

test('a Windows floor, a folder with spaces', () => {
  const win = { researchDir: 'C:\\Users\\Diego\\My Office\\hive\\research', distro: null, known: [] };
  assert.ok(matchDeliverable('C:\\Users\\Diego\\My Office\\hive\\research\\a b\\report.html', win));
  assert.ok(matchDeliverable('c:/users/diego/my office/hive/research/a b/report.html', win));
  assert.ok(matchDeliverable('research\\a b\\report.html', win, 'C:\\Users\\Diego\\My Office\\hive'));
  assert.equal(matchDeliverable('C:\\Users\\Diego\\My Office\\hive\\research', win), null);
});

// The renderer pieces are TSX with xterm/React: these pin the wiring by source.
const fs = require('node:fs');
const path = require('node:path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('a plain click on a deliverable opens Deliverables (Pro layout), Ctrl/Cmd-click the IDE', () => {
  const pool = read('src/renderer/src/components/terminalPool.ts');
  const body = pool.slice(pool.indexOf('async function activatePath'), pool.indexOf('function registerMarkdownLinkProvider'));
  assert.match(body, /const toIde = !!event && \(event\.metaKey \|\| event\.ctrlKey\);/);
  assert.match(body, /toIde \? null : await window\.cth\.deliverablesMatch\(hit\.path\)/);
  assert.match(body, /setFocusDeliverable\(deliverable\);[\s\S]*?setLayout\('pro'\);[\s\S]*?section: 'deliverables'[\s\S]*?return;[\s\S]*?openFileInIde\(hit\.path\)/);
  assert.match(pool, /void activatePath\(abs, action, event\);/);
  const view = read('src/renderer/src/pro/DeliverablesView.tsx');
  assert.match(view, /setQuery\(''\); setTypeFilter\(''\); setByFilter\(''\); setFocusTask\(null\);/);
  assert.match(view, /setSelected\(hit\.abs\);\s*setReveal\(hit\.abs\);/);
  assert.match(view, /scrollIntoView\(\{ block: 'center' \}\)/);
  assert.match(read('src/main/index.ts'), /ipcMain\.handle\('deliverables:match'[\s\S]*?matchDeliverable\(p, \{ researchDir: join\(root, DELIVERABLES_DIR\), distro, known \}\)/);
});
