const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { piSessionSaved } = loadTs('src/main/piSession.ts');

test('a pi session counts as saved only when its file exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
  try {
    const sid = '01a17df9-d28b-742d-a806-86c33af9f386';
    assert.equal(piSessionSaved(dir, sid), false, 'no sessions folder: never saved');
    const key = path.join(dir, 'sessions', '--home-d-proj--');
    fs.mkdirSync(key, { recursive: true });
    assert.equal(piSessionSaved(dir, sid), false, 'pi reported the id but wrote nothing');
    fs.writeFileSync(path.join(key, `2026-10-27T15-24-42-334Z_${sid}.jsonl`), '{}\n');
    assert.equal(piSessionSaved(dir, sid), true);
    assert.equal(piSessionSaved(dir, '01a17e07-308f-71f9-816d-d49186543f82'), false, 'another id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
