'use strict';
// A `files:` list under mac/win/linux made electron-builder drop the top-level
// list and pack the whole repo (docs, blog, .claude, src, tests): the Linux
// artifact went from 141 MB to 324 MB and Windows from 255 MB to 608 MB.
// Keep every files rule at the top level.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const lines = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8').split(/\r?\n/);

/** The second-level keys under each top-level key (comments ignored). */
function sections() {
  const out = new Map();
  let top = null;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const t = line.match(/^([A-Za-z][\w-]*):/);
    if (t) { top = t[1]; out.set(top, []); continue; }
    const k = line.match(/^ {2}([A-Za-z][\w-]*):/);
    if (k && top) out.get(top).push(k[1]);
  }
  return out;
}

test('no platform section has its own files list', () => {
  const s = sections();
  for (const key of ['mac', 'win', 'linux', 'nsis', 'portable', 'dmg', 'appImage']) {
    assert.ok(!(s.get(key) ?? []).includes('files'), `${key}.files would replace the top-level files list`);
  }
});

test('the top-level list ships the build output, not the repo', () => {
  const start = lines.findIndex((l) => /^files:/.test(l));
  assert.ok(start >= 0);
  const entries = [];
  for (let i = start + 1; i < lines.length && !/^[A-Za-z]/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s+-\s+"?([^"#]+?)"?\s*$/);
    if (m) entries.push(m[1]);
  }
  assert.ok(entries.includes('out/**'), JSON.stringify(entries));
  for (const f of entries.filter((e) => !e.startsWith('!'))) assert.doesNotMatch(f, /^(docs|blog|src|test|\.claude)\b/, f);
});
