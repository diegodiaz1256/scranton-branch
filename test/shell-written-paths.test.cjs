'use strict';
// Which files a shell command line writes (shared/toolGuard.ts), so a report an
// agent changes from its shell is that agent's change in the Deliverables.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { shellWrittenPaths, callWrittenFiles } = loadTs('src/shared/toolGuard.ts');

test('redirects, tee, copies, moves, touch, deletes and sed -i', () => {
  assert.deepEqual(shellWrittenPaths('echo "a > b" >> research/x.md'), ['research/x.md']);
  assert.deepEqual(shellWrittenPaths('printf x > research/y.md && cat a | tee -a research/z.md'), ['research/y.md', 'research/z.md']);
  assert.deepEqual(shellWrittenPaths('cp draft.md research/final.md; mv old.md research/new.md'), ['research/final.md', 'old.md', 'research/new.md']);
  assert.deepEqual(shellWrittenPaths("sed -i 's/a/b/' research/r.md"), ['research/r.md']);
  assert.deepEqual(shellWrittenPaths("perl -i -pe 's/a/b/' research/p.md"), ['research/p.md']);
  assert.deepEqual(shellWrittenPaths('touch research/t.md && rm research/gone.md'), ['research/t.md', 'research/gone.md']);
});

test('heredocs, nested shells and a cd before the write', () => {
  assert.deepEqual(shellWrittenPaths("cat > research/h.md <<'EOF'\n# not > a/redirect\nEOF"), ['research/h.md']);
  assert.deepEqual(shellWrittenPaths('bash -lc "echo x > research/n.md"'), ['research/n.md']);
  assert.deepEqual(shellWrittenPaths('cd hive && echo x >> research/c.md'), ['hive/research/c.md']);
  assert.deepEqual(shellWrittenPaths('(cd /tmp && echo x > a.md); echo y > b.md'), ['/tmp/a.md', 'b.md']);
});

test('reads, folders, sinks and variables are not written files', () => {
  assert.deepEqual(shellWrittenPaths('cat research/x.md 2>&1 | grep a > /dev/null'), []);
  assert.deepEqual(shellWrittenPaths('mkdir -p research/new && chmod 644 research/x.md'), []);
  assert.deepEqual(shellWrittenPaths('echo x > "$OUT"; echo y > %TEMP%\\z.md'), []);
});

test('made absolute against the folder the call ran in, Linux, Windows or the WSL share', () => {
  const bash = (command) => ({ command });
  assert.deepEqual(callWrittenFiles('Bash', bash('echo x >> hive/research/a.md'), '/home/u/office'), ['/home/u/office/hive/research/a.md']);
  assert.deepEqual(callWrittenFiles('Bash', bash('echo x >> ../research/a.md'), '/home/u/office/hive/agents'), ['/home/u/office/hive/research/a.md']);
  assert.deepEqual(callWrittenFiles('write', { path: 'research/a.md' }, String.raw`C:\My Office\hive`), [String.raw`C:\My Office\hive\research\a.md`]);
  assert.deepEqual(callWrittenFiles('edit', { path: 'research/a.md' }, String.raw`\\wsl.localhost\Ubuntu\home\u\office\hive`), [String.raw`\\wsl.localhost\Ubuntu\home\u\office\hive\research\a.md`]);
  assert.deepEqual(callWrittenFiles('Write', { file_path: '/home/u/office/hive/research/a.md' }), ['/home/u/office/hive/research/a.md']);
  assert.deepEqual(callWrittenFiles('Bash', bash('echo x > ~/a.md; echo y > b.md')), [], 'no folder known, no home: nothing guessed');
  assert.deepEqual(callWrittenFiles('Read', { file_path: '/x/a.md' }, '/x'), []);
});
