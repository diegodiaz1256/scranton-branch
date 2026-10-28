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
  assert.match(body, /if \(deliverable\) \{\s*await openInDeliverables\(deliverable\);\s*return;[\s\S]*?openFileInIde\(hit\.path\)/);
  assert.match(body, /async function openInDeliverables[\s\S]*?setFocusDeliverable\(deliverable\);[\s\S]*?setLayout\('pro'\);[\s\S]*?section: 'deliverables'/);
  assert.match(pool, /void activatePath\(abs, action, event, rel \?\? undefined\);/);
  const view = read('src/renderer/src/pro/DeliverablesView.tsx');
  assert.match(view, /setQuery\(''\); setTypeFilter\(''\); setByFilter\(''\); setFocusTask\(null\);/);
  assert.match(view, /setSelected\(hit\.abs\);\s*setReveal\(hit\.abs\);/);
  assert.match(view, /scrollIntoView\(\{ block: 'center' \}\)/);
  assert.match(read('src/main/index.ts'), /ipcMain\.handle\('deliverables:match'[\s\S]*?matchDeliverable\(p, index\)/);
});

// An office from an older version, on disk: the orchestrator runs in the office
// folder (not the hive), so `research/...` it printed (relative to the hive, as
// its prompt spells it) or wrote (relative to itself) is not under its folder's
// research/ — and before the prompt named the hive's folder, some of it really
// landed in <office>/research/.
const os = require('node:os');
function oldOffice() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb old office '));
  const hive = path.join(home, 'hive');
  const put = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '# r\n'); };
  put(path.join(hive, 'research', 'DUN-12', 'report.md'));
  put(path.join(home, 'research', 'pricing.md'));
  put(path.join(home, 'research', 'hires', 'pam.json'));
  put(path.join(home, 'proj', 'README.md'));
  return {
    home, hive,
    index: { researchDir: path.join(hive, 'research'), distro: null, known: [], legacyDirs: [path.join(home, 'research')] },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true })
  };
}

test('an old office: a hive-relative path the orchestrator printed opens in Deliverables', (t) => {
  const { matchRelativeDeliverable } = loadTs('src/shared/deliverableMatch.ts');
  const o = oldOffice();
  t.after(o.cleanup);
  // The orchestrator's folder is the office; the file is in the hive's research/.
  const hit = matchRelativeDeliverable('research/DUN-12/report.md', o.index, [o.home, o.hive, o.home], fs.existsSync);
  assert.equal(hit, path.join(o.hive, 'research', 'DUN-12', 'report.md'));
  // A worker in a project printed the same: its folder first, then the hive.
  assert.equal(matchRelativeDeliverable('research/DUN-12/report.md', o.index, [path.join(o.home, 'proj'), o.hive, o.home], fs.existsSync), hit);
  // Nothing that is not on disk, nothing that is not a deliverable.
  assert.equal(matchRelativeDeliverable('research/DUN-99/report.md', o.index, [o.home, o.hive, o.home], fs.existsSync), null);
  assert.equal(matchRelativeDeliverable('README.md', o.index, [path.join(o.home, 'proj'), o.hive, o.home], fs.existsSync), null);
  // Absolute paths are matchDeliverable's (the renderer already found them).
  assert.equal(matchRelativeDeliverable(hit, o.index, [o.home], fs.existsSync), null);
});

test('an old office: its own research/ folder is a deliverables folder too', (t) => {
  const o = oldOffice();
  t.after(o.cleanup);
  const legacy = path.join(o.home, 'research', 'pricing.md');
  assert.equal(matchDeliverable(legacy, o.index), legacy);
  const { matchRelativeDeliverable } = loadTs('src/shared/deliverableMatch.ts');
  assert.equal(matchRelativeDeliverable('research/pricing.md', o.index, [o.home, o.hive, o.home], fs.existsSync), legacy);
  // Hire proposals stay out there as well.
  assert.equal(matchDeliverable(path.join(o.home, 'research', 'hires', 'pam.json'), o.index), null);
  // A new office (no legacy folder) is unchanged: <office>/research is nothing.
  assert.equal(matchDeliverable(legacy, { ...o.index, legacyDirs: undefined }), null);
});

test('main and the terminal wire the old-office fallback', () => {
  const main = read('src/main/index.ts');
  const handler = main.slice(main.indexOf("ipcMain.handle('deliverables:match'"), main.indexOf("ipcMain.handle('hive:keepHumanPrompt'"));
  assert.match(handler, /legacyDirs: legacyResearchDirs\(\)/);
  assert.match(handler, /matchRelativeDeliverable\(p, index, \[cwd, root, home\]/);
  const list = main.slice(main.indexOf("ipcMain.handle('deliverables:list'"), main.indexOf('async function scanResearch'));
  assert.match(list, /legacyResearchDirs\(\)/);
  const pool = read('src/renderer/src/components/terminalPool.ts');
  const body = pool.slice(pool.indexOf('async function activatePath'), pool.indexOf('function registerMarkdownLinkProvider'));
  // A relative token that is not under the agent's folder asks main before giving up.
  assert.match(body, /if \(!res \|\| !res\.exists\) \{[\s\S]*?deliverablesMatch\(rel\.token, rel\.cwd\)/);
});
