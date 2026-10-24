'use strict';
// PDF deliverables are drawn by the app itself, the preview scrolls inside
// itself, and task cards/details name a task by its ticket (DUN-12), not its
// ledger id. The renderer pieces are TSX, so these pin the wiring by source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('PDFs are drawn by the app (pdf.js, lazy), with no browser plugin or blob frames', () => {
  assert.doesNotMatch(read('src/main/index.ts'), /plugins: true/);
  // The only frames are HTML deliverables, served from md-dlv:// (never blob:).
  assert.match(read('src/renderer/index.html'), /frame-src md-dlv:;/);
  const v = read('src/renderer/src/pro/DeliverablesView.tsx');
  assert.match(v, /kind === 'pdf'\) \{[\s\S]*?readBinary[\s\S]*?state: 'pdf', bytes:/);
  assert.match(v, /<PdfPreview bytes=\{loaded\.bytes\}/);
  const p = read('src/renderer/src/pro/PdfPreview.tsx');
  assert.match(p, /await import\('pdfjs-dist'\)/, 'loaded on first use');
  assert.match(p, /isEvalSupported: false/, 'no eval from a document');
});

test('the preview is capped to the page height, so only the document scrolls', () => {
  const v = read('src/renderer/src/pro/DeliverablesView.tsx');
  assert.match(v, /flex: '999 1 360px', minWidth: 0, minHeight: 360, maxHeight: '100%'/);
  assert.match(v, /<section className="pro-card" style=\{\{[^}]*maxHeight: '100%'/);
});

test('task cards and the detail show the ticket, one loader for keyed tasks', () => {
  const k = read('src/renderer/src/components/TasksKanban.tsx');
  assert.equal((k.match(/title=\{task\.id\}>\{ticketOf\(task\)\}/g) ?? []).length, 2, 'card and detail');
  assert.match(read('src/renderer/src/components/TaskDetailOverlay.tsx'), /loadKeyedTasks\(\)/);
  assert.match(read('src/renderer/src/pro/data.tsx'), /usePoll\(loadKeyedTasks/);
});
