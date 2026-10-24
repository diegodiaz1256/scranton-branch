'use strict';
/** Deliverables: which files a task names, how each kind previews, what agents wrote. */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { deliverablePaths, previewKind, parseDelimited, writtenFiles, splitPath } = loadTs('src/shared/deliverables.ts');

test('a task names its deliverables relative to the hive or absolute', () => {
  assert.deepEqual(deliverablePaths('research/q3/report.md', '/h/hive'), ['/h/hive/research/q3/report.md']);
  assert.deepEqual(deliverablePaths('see research/a.md, /tmp/b.csv', '/h/hive'), ['/h/hive/research/a.md', '/tmp/b.csv']);
  assert.deepEqual(deliverablePaths('research/my report.md', '/h/hive'), ['/h/hive/research/my report.md']);
  assert.deepEqual(deliverablePaths('`research/x.json`.', '/h/hive'), ['/h/hive/research/x.json']);
  assert.deepEqual(deliverablePaths('research\\r.md', 'C:\\Users\\me\\hive'), ['C:\\Users\\me\\hive\\research\\r.md']);
  assert.deepEqual(deliverablePaths('C:\\out\\r.pdf', '/h'), ['C:\\out\\r.pdf']);
  assert.deepEqual(deliverablePaths('done, PR opened https://github.com/a/b/pull/1', '/h'), []);
  assert.deepEqual(deliverablePaths(undefined, '/h'), []);
});

test('preview kinds by extension', () => {
  assert.equal(previewKind('a.md'), 'markdown');
  assert.equal(previewKind('A.PNG'), 'image');
  assert.equal(previewKind('t.tsv'), 'csv');
  assert.equal(previewKind('x.pdf'), 'pdf');
  assert.equal(previewKind('x.zip'), 'binary');
  assert.equal(previewKind('Makefile'), 'binary');
});

test('CSV with quotes, commas and new lines inside fields', () => {
  assert.deepEqual(parseDelimited('a,b\n"x, y","he said ""hi"""\r\n1,2', ','), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '2']]);
  assert.deepEqual(parseDelimited('a\tb\n1\t2\n', '\t'), [['a', 'b'], ['1', '2']]);
  assert.equal(parseDelimited('x\n'.repeat(500), ',', 200).length, 200);
});

test('files an agent wrote, newest first, once each', () => {
  const w = writtenFiles([
    { event: 'PreToolUse', tool: 'Write', detail: '/r/a.md', ts: 1 },
    { event: 'PreToolUse', tool: 'Edit', detail: '/r/a.md', ts: 5 },
    { event: 'PreToolUse', tool: 'Edit', detail: '/r/b.ts', ts: 3 },
    { event: 'PreToolUse', tool: 'Read', detail: '/r/c.md', ts: 9 },
    { event: 'PreToolUse', tool: 'Write', detail: '/r/d.md', ts: 9, blocked: true },
    { event: 'PostToolUse', tool: 'Write', detail: '/r/e.md', ts: 9 }
  ]);
  assert.deepEqual(w, [{ path: '/r/a.md', ts: 5, created: true }, { path: '/r/b.ts', ts: 3, created: false }]);
});

test('splitPath handles both separators', () => {
  assert.deepEqual(splitPath('/h/research/a.md'), { dir: '/h/research', name: 'a.md' });
  assert.deepEqual(splitPath('C:\\h\\a.md'), { dir: 'C:\\h', name: 'a.md' });
});

// ─── a WSL floor: agents write Linux paths, the app opens them from Windows ──

const { hostPath } = loadTs('src/shared/deliverables.ts');
const { fromLinuxPath } = loadTs('src/main/wsl.ts');

test('WSL: Linux paths become \\\\wsl.localhost or drive paths; others stay', () => {
  assert.equal(hostPath('/home/me/office/hive/research/a.md', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\office\\hive\\research\\a.md');
  assert.equal(hostPath('/mnt/c/Users/me/out.csv', 'Ubuntu'), 'C:\\Users\\me\\out.csv');
  assert.equal(hostPath('/home/me/a.md', null), '/home/me/a.md');
  assert.equal(hostPath('C:\\x\\a.md', 'Ubuntu'), 'C:\\x\\a.md');
  // Same answer as main's own converter.
  for (const p of ['/home/me/a b/c.md', '/mnt/d/x.md', '/']) assert.equal(hostPath(p, 'Ubuntu'), fromLinuxPath(p, 'Ubuntu'));
});

test('WSL: a task naming an absolute Linux path opens through the distro; relative stays under the UNC hive', () => {
  const root = '\\\\wsl.localhost\\Ubuntu\\home\\me\\office\\hive';
  assert.deepEqual(deliverablePaths('/home/me/office/hive/research/r.md', root, 'Ubuntu'), ['\\\\wsl.localhost\\Ubuntu\\home\\me\\office\\hive\\research\\r.md']);
  assert.deepEqual(deliverablePaths('research/r.md', root, 'Ubuntu'), [`${root}\\research/r.md`]);
  assert.deepEqual(splitPath(`${root}\\research/r.md`), { dir: `${root}\\research`, name: 'r.md' });
});

test('only documents open in their own app; anything that could run is only revealed', () => {
  const { canOpenExternally } = loadTs('src/shared/deliverables.ts');
  for (const ok of ['r.md', 'R.PDF', 't.csv', 'a.docx', 'b.xlsx', 'p.png', 'x.json', 'page.html']) assert.equal(canOpenExternally(ok), true, ok);
  for (const no of ['setup.exe', 'run.bat', 'x.cmd', 'a.ps1', 'b.sh', 'c.desktop', 'd.app', 'e.dmg', 'f.lnk', 'g.docm', 'h.xlsm', 'i.js', 'j.vbs', 'k.jar', 'Makefile', 'l.msi', 'm.scr']) assert.equal(canOpenExternally(no), false, no);
});

// ─── deliverables ↔ tasks ───────────────────────────────────────────────────

test('a write is linked to the task its agent has in doing (the newest if several)', () => {
  const { currentTaskOf } = loadTs('src/shared/deliverables.ts');
  const tasks = [
    { id: 'a', assignee: 'pam', status: 'done', createdAt: '2026-01-03' },
    { id: 'b', assignee: 'pam', status: 'doing', createdAt: '2026-01-01' },
    { id: 'c', assignee: 'pam', status: 'doing', createdAt: '2026-01-02' },
    { id: 'd', assignee: 'jim', status: 'doing', createdAt: '2026-01-05' }
  ];
  assert.equal(currentTaskOf(tasks, 'pam'), 'c');
  assert.equal(currentTaskOf(tasks, 'jim'), 'd');
  assert.equal(currentTaskOf(tasks, 'dwight'), null);
});

test('only files inside research/ are linked; links keep one entry per file, newest wins', () => {
  const { isInside, addLink, linkFor } = loadTs('src/shared/deliverables.ts');
  assert.equal(isInside('/h/hive/research/x/a.md', '/h/hive/research'), true);
  assert.equal(isInside('/h/hive/researcher/a.md', '/h/hive/research'), false);
  assert.equal(isInside('\\\\wsl.localhost\\U\\h\\hive\\research\\a.md', '\\\\wsl.localhost\\U\\h\\hive\\research'), true);
  assert.equal(isInside('C:\\Office\\Hive\\Research\\a.md', 'c:/office/hive/research'), true);
  let links = addLink([], { path: '/r/a.md', taskId: 't1', agentId: 'pam', ts: 1 });
  links = addLink(links, { path: '/R/A.md', taskId: 't2', agentId: 'pam', ts: 2 });
  assert.equal(links.length, 1);
  assert.equal(linkFor(links, '/r/a.md').taskId, 't2');
  assert.equal(addLink(Array.from({ length: 5 }, (_, i) => ({ path: `/r/${i}`, taskId: 't', agentId: 'a', ts: i })), { path: '/r/x', taskId: 't', agentId: 'a', ts: 9 }, 3).length, 3);
});

test('written files from any CLI: `files` on Pre or Post events', () => {
  const w = writtenFiles([
    { event: 'PreToolUse', tool: 'apply_patch', files: ['/w/jim/research/a.md', '/w/jim/src/x.ts'], ts: 2 },
    { event: 'PostToolUse', tool: 'write', files: ['/w/oc/research/b.md'], ts: 3 },
    { event: 'PreToolUse', tool: 'write_to_file', files: ['/w/agy/c.md'], ts: 1, blocked: true }
  ]);
  assert.deepEqual(w.map((f) => [f.path, f.created]), [['/w/oc/research/b.md', true], ['/w/jim/research/a.md', false], ['/w/jim/src/x.ts', false]]);
});

test('files written elsewhere are kept across restarts: one per path, newest wins, capped', () => {
  const { recordElsewhere } = loadTs('src/shared/deliverables.ts');
  const w = (path, ts, created = false, agentId = 'pam') => ({ path, agentId, name: agentId, ts, created });
  let list = recordElsewhere([], [w('C:/p/out.html', 1, true)]);
  list = recordElsewhere(list, [w('c:/P/OUT.html', 5)]);
  assert.equal(list.length, 1);
  assert.equal(list[0].ts, 5);
  assert.equal(list[0].created, true);
  // Nothing new: the same list back, so main does not rewrite the file.
  assert.equal(recordElsewhere(list, [w('C:/p/out.html', 3)]), list);
  const many = recordElsewhere([], Array.from({ length: 5 }, (_, i) => w(`/x/${i}.md`, i)), 3);
  assert.deepEqual(many.map((x) => x.path), ['/x/2.md', '/x/3.md', '/x/4.md']);
});
