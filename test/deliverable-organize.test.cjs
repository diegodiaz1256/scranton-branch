'use strict';
// Deliverables list organisation: a folder's main document carries its assets,
// tasks are ordered by status with done ones archived, by agent, and the real
// folder tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { bundleAssets, groupByTask, groupByAgent, folderTree, isDeliverableLike } = loadTs('src/shared/deliverableOrganize.ts');

const it = (rel, ts, extra = {}) => ({ abs: `/h/research/${rel}`, name: rel.split('/').pop(), rel, ts, authors: [], taskIds: [], ...extra });
const names = (entries) => entries.map((e) => e.item.name + (e.assets.length ? `[${e.assets.map((a) => a.name).join(',')}]` : ''));

test('the main document of a folder takes its images, tables and renders, also from subfolders', () => {
  const items = [
    it('acme/proposal.html', 10),
    it('acme/hero.svg', 5),
    it('acme/style.css', 4),
    it('acme/renders/page-1.png', 30),
    it('acme/proposal.pdf', 8),
    it('acme/notes.md', 9),
    it('loose.md', 3),
    it('loose.png', 2)
  ];
  const out = bundleAssets(items);
  // Ordered by the newest file in each entry: the render makes the proposal newest.
  assert.deepEqual(names(out), ['proposal.html[page-1.png,proposal.pdf,hero.svg,style.css]', 'notes.md', 'loose.md', 'loose.png']);
  assert.equal(out[0].ts, 30);
});

test('a folder with no document keeps its files apart, and files elsewhere are never bundled', () => {
  const out = bundleAssets([it('data/a.csv', 2), it('data/b.png', 1), { abs: 'C:\\x\\r.md', name: 'r.md', ts: 5, authors: [], taskIds: [] }, { abs: 'C:\\x\\r.png', name: 'r.png', ts: 4, authors: [], taskIds: [] }]);
  assert.deepEqual(names(out), ['r.md', 'r.png', 'a.csv', 'b.png']);
});

test('an entry belongs to the tasks of its assets too', () => {
  const [e] = bundleAssets([it('t/report.md', 1, { taskIds: ['t1'] }), it('t/chart.png', 2, { taskIds: ['t2'] })]);
  assert.deepEqual(e.taskIds.sort(), ['t1', 't2']);
});

test('by task: doing before blocked before todo, done tasks archived, the rest loose', () => {
  const entries = bundleAssets([
    it('a/x.md', 50, { taskIds: ['done1'] }),
    it('b/y.md', 40, { taskIds: ['todo1'] }),
    it('c/z.md', 10, { taskIds: ['doing1'] }),
    it('d/w.md', 30, { taskIds: ['blocked1'] }),
    it('e/v.md', 20),
    it('f/u.md', 60, { taskIds: ['gone'] })
  ]);
  const tasks = [
    { id: 'done1', status: 'done' }, { id: 'todo1', status: 'todo' }, { id: 'doing1', status: 'doing' }, { id: 'blocked1', status: 'blocked' }
  ];
  const g = groupByTask(entries, tasks);
  assert.deepEqual(g.active.map((x) => x.task.id), ['doing1', 'blocked1', 'todo1']);
  assert.deepEqual(g.archived.map((x) => x.task.id), ['done1']);
  // A link to a task no longer on the board does not hide the file.
  assert.deepEqual(names(g.loose), ['u.md', 'v.md']);
});

test('by agent: most recently active first, unknown last', () => {
  const entries = bundleAssets([it('a.md', 1, { by: 'Pam' }), it('b.md', 5, { authors: ['Jim'] }), it('c.md', 9), it('d.md', 3, { by: 'Pam' })]);
  assert.deepEqual(groupByAgent(entries).map((g) => `${g.agent}:${g.entries.length}`), ['Jim:1', 'Pam:2', ':1']);
});

test('folder tree: every level, folders by name, counts, files elsewhere by folder', () => {
  const items = [
    it('clients/acme/2026/q4/drafts/deep.md', 1),
    it('clients/acme/brief.md', 2),
    it('archive/n1.md', 3),
    it('top.md', 4),
    { abs: 'C:\\w\\out.html', name: 'out.html', ts: 7, authors: [], taskIds: [] }
  ];
  const t = folderTree(items, () => 'C:\\w');
  assert.equal(t.research.count, 4);
  assert.deepEqual(t.research.folders.map((f) => f.name), ['archive', 'clients']);
  const acme = t.research.folders[1].folders[0];
  assert.equal(acme.name, 'acme');
  assert.equal(acme.count, 2);
  assert.equal(acme.folders[0].folders[0].folders[0].files[0].name, 'deep.md');
  assert.deepEqual(t.research.files.map((f) => f.name), ['top.md']);
  assert.deepEqual(t.elsewhere.map((n) => [n.name, n.files.length]), [['C:\\w', 1]]);
});

test('written elsewhere: documents and pictures count, code does not', () => {
  assert.equal(isDeliverableLike('report.html'), true);
  assert.equal(isDeliverableLike('chart.png'), true);
  assert.equal(isDeliverableLike('index.ts'), false);
  assert.equal(isDeliverableLike('package.json'), false);
});

test('a file in research/<ticket>/ belongs to that ticket', () => {
  const { taskOfFolder } = loadTs('src/shared/deliverableOrganize.ts');
  const tasks = [{ id: 't1', key: 'DUN-12' }, { id: 't2', key: 'DUN-120' }, { id: 't3' }];
  assert.equal(taskOfFolder('DUN-12/report.md', tasks), 't1');
  assert.equal(taskOfFolder('dun-120/sub/chart.png', tasks), 't2');
  assert.equal(taskOfFolder('DUN-12.md', tasks), null);
  assert.equal(taskOfFolder('2026-10-20-pricing/summary.md', tasks), null);
});
