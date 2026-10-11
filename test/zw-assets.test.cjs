'use strict';
// Licensed art is copied at build time from the private assets repo; without
// that repo the build still works, and a half-present repo fails loudly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assetsDir, safeRel, sync } = require('../tools/zw-assets.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zw-assets-'));

test('listed files are copied, keeping their folders', () => {
  const src = tmp(); const out = tmp();
  fs.mkdirSync(path.join(src, 'atlases'), { recursive: true });
  fs.writeFileSync(path.join(src, 'atlases', 'office-floors-16.png'), 'png');
  fs.writeFileSync(path.join(out, 'stale.png'), 'old');
  sync(['atlases/office-floors-16.png'], src, out);
  assert.equal(fs.readFileSync(path.join(out, 'atlases', 'office-floors-16.png'), 'utf8'), 'png');
  assert.equal(fs.existsSync(path.join(out, 'stale.png')), false, 'the output is rebuilt from the manifest');
});

test('a listed file missing from the repo fails the build', () => {
  assert.throws(() => sync(['atlases/nope.png'], tmp(), tmp()), /missing from/);
});

test('ZW_ASSETS points at the assets repo; with nothing listed, nothing is needed', () => {
  assert.equal(assetsDir({ ZW_ASSETS: '/x/assets' }), path.resolve('/x/assets'));
  const out = tmp();
  assert.deepEqual(sync([], tmp(), out), []);
});

test('manifest paths cannot leave the repo', () => {
  for (const bad of ['../x.png', 'a/../../x.png', '/etc/x', 'C:/x.png', 'a\\b.png', '', 'a//b.png']) assert.equal(safeRel(bad), null, bad);
  assert.throws(() => sync(['../secret.png'], tmp(), tmp()), /unsafe path/);
});

test('the manifest is valid JSON with a files list', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'zw-assets.json'), 'utf8'));
  assert.ok(Array.isArray(m.files));
  for (const f of m.files) assert.ok(safeRel(f), f);
});
