'use strict';
// The Deliverables listing stats every file before cutting, so the newest file
// is listed however many old ones come first in folder order, and however deep
// or big it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { scanDeliverables } = loadTs('src/main/deliverableScan.ts');

function seed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv scan '));
  const put = (rel, body, ageMin) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    const t = new Date(Date.now() - ageMin * 60_000);
    fs.utimesSync(p, t, t);
  };
  for (let i = 0; i < 700; i++) put(`archive/note-${String(i).padStart(3, '0')}.md`, '# old\n', 10_000 + i);
  put('zz-acme/proposal.html', Buffer.alloc(3 * 1024 * 1024, 'x'), 1);
  put('clients/acme/2026/q4/drafts/deep.md', '# deep\n', 5);
  put('hires/cv.md', '# not a deliverable\n', 2);
  put('.hidden/x.md', '# dot\n', 2);
  return dir;
}

test('the newest file is listed after 700 older ones, big and deep files too', async (t) => {
  const dir = seed();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await scanDeliverables(dir, { skipTop: ['hires'] });
  assert.equal(r.total, 702);
  assert.equal(r.truncated, false);
  assert.equal(r.files[0].rel, 'zz-acme/proposal.html');
  assert.equal(r.files[0].size, 3 * 1024 * 1024);
  assert.equal(r.files[1].rel, 'clients/acme/2026/q4/drafts/deep.md');
  assert.ok(!r.files.some((f) => f.rel.startsWith('hires/') || f.rel.startsWith('.hidden/')));
});

test('the cap keeps the newest files, not the first ones read', async (t) => {
  const dir = seed();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = await scanDeliverables(dir, { maxFiles: 3, skipTop: ['hires'] });
  assert.equal(r.truncated, true);
  assert.deepEqual(r.files.map((f) => f.rel), ['zz-acme/proposal.html', 'clients/acme/2026/q4/drafts/deep.md', 'archive/note-000.md']);
});
