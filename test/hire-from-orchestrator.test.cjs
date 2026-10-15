'use strict';
// A permanent hire the orchestrator proposes in research/hires/ reaches the
// human's Add-Agent review once, and never spawns by itself (src/main/hire.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { collectHireManifests, restoreOfferedHire } = loadTs('src/main/hire.ts');
const { validateHireManifest } = loadTs('src/shared/hire.ts');

function hiresDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hires-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the orchestrator\'s manifest is offered once, then filed away', (t) => {
  const dir = hiresDir(t);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'hire-from-orchestrator.json'), path.join(dir, 'w40k-expert.json'));
  const first = collectHireManifests([dir]);
  assert.equal(first.offered.length, 1, JSON.stringify(first.invalid));
  assert.equal(first.offered[0].name, 'Dwight');
  assert.ok(fs.existsSync(path.join(dir, '.offered', 'w40k-expert.json')));
  assert.deepEqual(collectHireManifests([dir]), { offered: [], sources: [], invalid: [] }, 'not offered twice');
});

test('an invalid manifest is reported and set aside', (t) => {
  const dir = hiresDir(t);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"name": "no spec"}');
  const r = collectHireManifests([dir]);
  assert.equal(r.offered.length, 0);
  assert.equal(r.invalid[0].file, 'bad.json');
  assert.ok(fs.existsSync(path.join(dir, '.invalid', 'bad.json')));
});

test('dotfiles and empty files in research/hires are not manifests', (t) => {
  const dir = hiresDir(t);
  // Claude Code's sandbox mounts an empty .mcp.json into the folder a command runs in.
  fs.writeFileSync(path.join(dir, '.mcp.json'), '');
  fs.writeFileSync(path.join(dir, 'empty.json'), '');
  assert.deepEqual(collectHireManifests([dir]), { offered: [], sources: [], invalid: [] });
  assert.ok(fs.existsSync(path.join(dir, '.mcp.json')), 'left where it is');
  assert.ok(!fs.existsSync(path.join(dir, '.invalid')), 'nothing reported as rejected');
});

test('a batch is offered whole, and a manifest closed unreviewed comes back once restored', (t) => {
  const dir = hiresDir(t);
  for (const n of ['a', 'b', 'c']) {
    fs.writeFileSync(path.join(dir, `${n}.json`), JSON.stringify({ spec: 'munder-difflin/hire@1', name: n.toUpperCase() }));
  }
  const first = collectHireManifests([dir]);
  assert.deepEqual(first.offered.map((m) => m.name), ['A', 'B', 'C']);
  assert.deepEqual(first.sources.map((s) => s.file), ['a.json', 'b.json', 'c.json']);

  const restored = restoreOfferedHire(dir, 'c.json');
  assert.equal(restored, path.join(dir, 'c.json'));
  assert.deepEqual(collectHireManifests([dir], new Set([restored])).offered, [], 'not re-offered this session');
  assert.deepEqual(collectHireManifests([dir]).offered.map((m) => m.name), ['C'], 'offered again next launch');
});

test('restoreOfferedHire only moves a plain manifest name', (t) => {
  const dir = hiresDir(t);
  assert.equal(restoreOfferedHire(dir, '../x.json'), null);
  assert.equal(restoreOfferedHire(dir, '.mcp.json'), null);
  assert.equal(restoreOfferedHire(dir, 'missing.json'), null);
});

test('a manifest can name its folder and a session to continue', () => {
  const ok = validateHireManifest({
    spec: 'munder-difflin/hire@1', name: 'Dwight',
    cwd: '/home/me/projects/my app', sessionId: '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', tokenCap: 0
  });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.equal(ok.manifest.cwd, '/home/me/projects/my app');
  assert.equal(ok.manifest.sessionId, '0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0');
  assert.equal(ok.manifest.tokenCap, undefined, 'tokenCap 0 is no cap');
  for (const cwd of ['C:\\code\\app', 'C:/code/app', '\\\\wsl.localhost\\Ubuntu\\home', '~/code']) {
    assert.equal(validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'X', cwd }).ok, true, cwd);
  }
  for (const cwd of ['relative/dir', 'code', 42]) {
    assert.equal(validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'X', cwd }).ok, false, String(cwd));
  }
  assert.equal(validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'X', sessionId: 'abc; rm -rf /' }).ok, false);
  assert.equal(validateHireManifest({ spec: 'munder-difflin/hire@1', name: 'X', tokenCap: -1 }).ok, false);
});
