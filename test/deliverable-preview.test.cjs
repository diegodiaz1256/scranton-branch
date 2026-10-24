'use strict';
// The Deliverables viewer: HTML served from its own folder through a sandboxed
// scheme (never outside it, never scripts), and big documents shown in pieces.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { DeliverableFiles, SERVED_CSP } = loadTs('src/main/deliverableFiles.ts');
const { splitMarkdown, piecesWithin, headOf } = loadTs('src/shared/previewChunks.ts');

function office() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv files '));
  const research = path.join(root, 'research');
  fs.mkdirSync(path.join(research, 'acme', 'img'), { recursive: true });
  fs.writeFileSync(path.join(research, 'acme', 'proposal.html'), '<h1>Proposal</h1><img src="img/hero.svg">');
  fs.writeFileSync(path.join(research, 'acme', 'img', 'hero.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(research, 'acme', 'app.js'), 'alert(1)');
  fs.writeFileSync(path.join(root, 'registry.json'), '{"secret":true}');
  return { root, research };
}

test('an HTML deliverable and its relative assets are served, with a CSP that runs nothing', async (t) => {
  const { root, research } = office();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new DeliverableFiles();
  const url = files.urlFor(research, path.join(research, 'acme', 'proposal.html'));
  assert.match(url, /^md-dlv:\/\/[0-9a-f]{24}\/acme\/proposal\.html$/);
  const page = await files.respond(url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(await page.text(), '<h1>Proposal</h1><img src="img/hero.svg">');
  assert.match(SERVED_CSP, /default-src 'none'/);
  assert.doesNotMatch(SERVED_CSP, /script-src|allow-scripts|allow-same-origin|allow-top-navigation/);
  assert.equal(page.headers.get('content-security-policy'), SERVED_CSP);
  // The image, as the page's relative link resolves it.
  const img = await files.respond(new URL('img/hero.svg', url).href);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/svg+xml');
  // A script beside it is not served.
  assert.equal((await files.respond(new URL('app.js', url).href)).status, 404);
});

test('nothing outside the folder: no .., no encoded separators, no unknown token', async (t) => {
  const { root, research } = office();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new DeliverableFiles();
  const url = files.urlFor(research, path.join(research, 'acme', 'proposal.html'));
  const token = new URL(url).hostname;
  for (const bad of [
    `md-dlv://${token}/../registry.json`,
    `md-dlv://${token}/acme/..%2F..%2Fregistry.json`,
    `md-dlv://${token}/%2E%2E/registry.json`,
    `md-dlv://${token}/acme%5C..%5C..%5Cregistry.json`,
    'md-dlv://0123456789abcdef01234567/acme/proposal.html',
    'file:///etc/passwd'
  ]) assert.equal((await files.respond(bad)).status, 404, bad);
  assert.equal(files.urlFor(research, path.join(root, 'registry.json')), null);
});

test('a folder with spaces and non-ASCII names', async (t) => {
  const { root, research } = office();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(research, 'año 2026');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'informe final.html'), 'ok');
  const files = new DeliverableFiles();
  const r = await files.respond(files.urlFor(research, path.join(dir, 'informe final.html')));
  assert.equal(await r.text(), 'ok');
});

test('big Markdown in pieces at block boundaries, never inside code; joined back it is the text', () => {
  let md = '';
  for (let i = 0; i < 400; i++) md += `## Part ${i}\n\nSome text for part ${i}.\n\n${i % 50 === 0 ? '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n' : ''}`;
  const pieces = splitMarkdown(md, 1024);
  assert.ok(pieces.length > 10);
  assert.equal(pieces.join(''), md);
  for (const p of pieces) assert.equal((p.match(/```/g) ?? []).length % 2, 0, 'a piece cut a code block');
  assert.deepEqual(splitMarkdown('short'), ['short']);
  assert.equal(piecesWithin(['aaaa', 'bbbb', 'cccc'], 9), 2);
  assert.equal(piecesWithin(['aaaaaaaaaaaa'], 5), 1);
});

test('plain text over the budget shows its start, cut at a line end', () => {
  const text = 'line\n'.repeat(1000);
  const { head, cut } = headOf(text, 102);
  assert.equal(cut, true);
  assert.equal(head, 'line\n'.repeat(20).slice(0, -1));
  assert.deepEqual(headOf('small', 100), { head: 'small', cut: false });
});
