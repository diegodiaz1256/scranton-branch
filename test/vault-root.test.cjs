'use strict';
/**
 * The office's confidential folder is a real directory before an agent starts
 * (src/main/vaultRoot.ts). Claude Code's sandbox leaves an empty read-only file
 * where a denied path is missing; pi's bubblewrap then died at launch with
 * "Can't mkdir …/confidential: Not a directory".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { ensureVaultRoot } = loadTs('src/main/vaultRoot.ts');

const office = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault root '));

test('a missing confidential folder is made', () => {
  const root = path.join(office(), 'confidential');
  assert.equal(ensureVaultRoot(root), true);
  assert.ok(fs.statSync(root).isDirectory());
});

test("the empty read-only file a sandbox left there becomes the folder", () => {
  const root = path.join(office(), 'confidential');
  fs.writeFileSync(root, '');
  fs.chmodSync(root, 0o444);
  assert.equal(ensureVaultRoot(root), true);
  assert.ok(fs.statSync(root).isDirectory());
});

test('a folder that is already there is kept with what it holds', () => {
  const root = path.join(office(), 'confidential');
  fs.mkdirSync(path.join(root, 'api-jira'), { recursive: true });
  fs.writeFileSync(path.join(root, 'api-jira', 'note.md'), 'x');
  assert.equal(ensureVaultRoot(root), true);
  assert.equal(fs.readFileSync(path.join(root, 'api-jira', 'note.md'), 'utf8'), 'x');
});

test('a file with content is never deleted', () => {
  const root = path.join(office(), 'confidential');
  fs.writeFileSync(root, 'not ours');
  assert.equal(ensureVaultRoot(root), false);
  assert.equal(fs.readFileSync(root, 'utf8'), 'not ours');
});
