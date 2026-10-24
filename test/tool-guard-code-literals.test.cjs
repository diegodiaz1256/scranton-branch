'use strict';
// Text in inline code is not a path because it starts with a slash: a file's
// content `'// placeholder\n'` is a comment. Seen on a WSL floor (final e2e,
// 2026-10-25): an Antigravity worker's
//   node -e "fs.writeFileSync('<project>/test/index.js', '// placeholder\n')"
// inside its own project was refused as "// placeholder\n is outside your folders".
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { guardToolCall } = loadTs('src/shared/toolGuard.ts');

const r = String.raw;
const U = (p) => `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, '\\')}`;
const office = '/home/zeroge/offices/e2e-final-1025';
const project = `${office}/wordfreq`;
// The policy HiveManager builds for a worker on a WSL floor.
const WSL = {
  cwd: U(project),
  roots: [U(project), U(`${office}/hive`), U(`${office}/hive/agents/worker-wf-agy`), '/tmp'],
  git: true, contained: true, home: U('/home/zeroge'), distro: 'Ubuntu',
  vars: { TMPDIR: '/tmp' }
};
const agy = (CommandLine) => guardToolCall('run_command', { CommandLine }, WSL, r`C:\Users\me`, project);
const bash = (command) => guardToolCall('Bash', { command }, WSL, r`C:\Users\me`, project);

test('the recorded agy call (a comment as the file content, inside the project) is allowed', () => {
  const recorded = `node -e "const fs = require('fs'); fs.writeFileSync('${project}/test/index.js', '// placeholder\\n');"\ncd ${project} && npm test\nrm ${project}/test/index.js`;
  assert.equal(agy(recorded), null);
});

test('comment text written by inline code is content, in any interpreter', () => {
  for (const cmd of [
    `node -e "require('fs').writeFileSync('${project}/a.js', '// TODO')"`,
    `node -e "require('fs').writeFileSync('${project}/a.css', '/* reset */')"`,
    `python3 -c "open('${project}/a.py', 'w').write('// not python but fine')"`,
    `node -e "require('fs').writeFileSync('a.js', '//')"`
  ]) assert.equal(bash(cmd), null, cmd);
});

test('a real path next to the comment is still checked', () => {
  const v = bash(`node -e "require('fs').writeFileSync('/home/zeroge/escape.js', '// placeholder')"`);
  assert.ok(v && v.deny);
  assert.match(v.reason, /\/home\/zeroge\/escape\.js is outside your folders/);
  // A UNC-style or protocol-relative path is a path, not a comment.
  assert.ok(bash(`node -e "require('fs').writeFileSync('//server/share/x.txt', 'x')"`)?.deny);
});
