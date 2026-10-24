'use strict';
// What a refused agent reads. A refusal that names the wrong place, or a
// helper that does not exist, sends the agent round in circles (e2e, v1.1.3).
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { guardToolCall } = loadTs('src/shared/toolGuard.ts');

const r = String.raw;

// The policy HiveManager builds for god on a WSL floor (wsl-guardcwd office).
const office = r`\\wsl.localhost\Ubuntu\home\zeroge\offices\wsl-guardcwd`;
const WSL = {
  cwd: office,
  roots: [office, `${office}\\hive\\agents\\god`, `${office}\\hive`, '/tmp', r`\\wsl.localhost\Ubuntu\home\zeroge\.claude\projects`],
  git: true, contained: true, home: r`\\wsl.localhost\Ubuntu\home\zeroge`, distro: 'Ubuntu'
};
const lin = '/home/zeroge/offices/wsl-guardcwd';
const WIN = { cwd: r`C:\work\shop`, roots: [r`C:\work\shop`, r`G:\office\hive`], git: true, contained: true };

test('on a WSL floor a refusal names the folders as the agent sees them (Linux paths)', () => {
  // Real PreToolUse inputs from claude in the distro.
  for (const [tool, input] of [
    ['Bash', { command: 'echo z > /home/zeroge/escape.txt' }],
    ['Write', { file_path: '/home/zeroge/escape.txt', content: 'x' }],
    ['Bash', { command: `cd ${lin}/hive && rm -rf /home/zeroge/other` }]
  ]) {
    const v = guardToolCall(tool, input, WSL, r`C:\Users\me`, `${lin}/hive`);
    assert.ok(v, `${tool} refused`);
    assert.ok(!/wsl\.localhost|wsl\$|\\/i.test(v.reason), `no Windows path: ${v.reason}`);
    assert.match(v.reason, new RegExp(`You work in ${lin} `), v.reason);
  }
  // A path the agent wrote with the share spelling is shown in its Linux form too.
  const v = guardToolCall('Write', { file_path: r`\\wsl.localhost\Ubuntu\home\zeroge\escape.txt`, content: 'x' }, WSL, r`C:\Users\me`);
  assert.match(v.reason, /^Refused: \/home\/zeroge\/escape\.txt is outside your folders/);
});

test('a native Windows agent still reads its folders in Windows form', () => {
  const v = guardToolCall('Write', { file_path: r`D:\x.txt` }, WIN, r`C:\Users\me`);
  assert.match(v.reason, /^Refused: D:\\x\.txt is outside your folders\. You work in C:\\work\\shop /);
});

test('a path built at run time is not named as if the guard knew it', () => {
  for (const command of [
    `node -e "require('fs').writeFileSync(require('os').homedir()+'/escape.txt','x')"`,
    `node -e 'require("fs").writeFileSync(require("os").homedir() + "/escape-node.txt", "x")'`
  ]) {
    const v = guardToolCall('Bash', { command }, WSL, r`C:\Users\me`, lin);
    assert.ok(v, command);
    assert.ok(!/Refused: \/escape/.test(v.reason), `claims a path it inferred: ${v.reason}`);
    assert.match(v.reason, /outside your folders/);
    assert.match(v.reason, new RegExp(`You work in ${lin} `));
  }
  const py = guardToolCall('Bash', { command: `python3 -c "import os; p = os.path.expanduser('~') + '/escape-py.txt'; open(p, 'w').write('x')"` }, WSL, r`C:\Users\me`, lin);
  assert.ok(py && !/Refused: \/escape/.test(py.reason), py && py.reason);
  // A whole literal is still named exactly.
  const plain = guardToolCall('Bash', { command: `node -e "require('fs').writeFileSync('/etc/escape.txt','x')"` }, WSL, r`C:\Users\me`, lin);
  assert.match(plain.reason, /^Refused: \/etc\/escape\.txt is outside your folders/);
});

test('confidential/: no custodian, no "ask the custodian"', () => {
  const vaults = `${office}\\confidential`;
  const policy = { ...WSL, deny: [vaults] };
  const v = guardToolCall('Bash', { command: 'ls -ld confidential' }, policy, r`C:\Users\me`, lin);
  assert.ok(v);
  assert.ok(!/custodian/i.test(v.reason), v.reason);
  assert.match(v.reason, /reserved for the office's confidential vaults/);
  assert.match(v.reason, new RegExp(`${lin}/confidential`), v.reason);
  assert.ok(!/wsl\.localhost|\\/.test(v.reason), v.reason);
});

test('confidential/: with a custodian, the refusal says who to ask', () => {
  const vaults = r`C:\Users\me\.harness\confidential`;
  const vault = `${vaults}\\jira-acme`;
  const policy = { ...WIN, deny: [vault, r`G:\office\hive\agents\dwight`], denyOwners: { [vault]: ['dwight'], [r`G:\office\hive\agents\dwight`]: ['dwight'] } };
  const v = guardToolCall('Read', { file_path: `${vault}\\notes.md` }, policy, r`C:\Users\me`);
  assert.match(v.reason, /only its custodian \(dwight\) and the human may open\. Ask dwight through the hive/);
  const w = guardToolCall('Bash', { command: r`type G:\office\hive\agents\dwight\memory.md` }, policy, r`C:\Users\me`);
  assert.match(w.reason, /Ask dwight through the hive/);
});
