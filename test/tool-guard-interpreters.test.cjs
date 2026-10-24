'use strict';
// The folder/git guard read only the top command line, so `bash -c "rm …"`,
// `cmd /c del …`, `powershell -Command …` or a python/node one-liner walked
// straight past it. It now reads what those hand on.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { guardToolCall } = loadTs('src/shared/toolGuard.ts');

const r = String.raw;
const WIN = { cwd: r`C:\work\shop`, roots: [r`C:\work\shop`, r`G:\office\hive`, r`C:\Temp`], git: true, contained: true };
const NOGIT = { ...WIN, git: false };
const bash = (command, p = WIN) => guardToolCall('Bash', { command }, p, r`C:\Users\me`);
const ps = (command, p = WIN) => guardToolCall('PowerShell', { command }, p, r`C:\Users\me`);
const utf16b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');

test('nested shells: what they run is checked like a command line of its own', () => {
  for (const c of [
    `bash -c "rm -rf /c/Users/me/Documents"`,
    `sh -lc 'echo x > /etc/hosts'`,
    r`cmd /c del C:\Users\me\notes.txt`,
    r`powershell -Command "Remove-Item -Recurse C:\Users\me\Desktop"`,
    `pwsh -NoProfile -EncodedCommand ${utf16b64(r`Set-Content -Path C:\Windows\x.txt -Value 1`)}`,
    'wsl -d Ubuntu rm -rf /mnt/d/backup',
    `bash -c "bash -c 'mv a.ts /c/elsewhere/'"`
  ]) assert.ok(bash(c), c);
  assert.equal(bash(`bash -c "npm test && rm -rf dist"`), null, 'inside its folder is fine');
  assert.equal(bash(r`cmd /c dir C:\Windows`), null, 'reading elsewhere is fine');
});

test('one-liners that write or delete outside are refused', () => {
  for (const c of [
    `python -c "open('C:/Users/me/.bashrc', 'a').write('x')"`,
    `python3 -c "import os; os.remove('/c/Users/me/a.txt')"`,
    `python -c "import shutil; shutil.rmtree(r'D:\\data')"`,
    `python -c "from pathlib import Path; Path('~/notes.md').write_text('x')"`,
    `node -e "require('fs').writeFileSync('C:/Windows/x.txt', '')"`,
    `node -e "require('fs').rmSync('../other', { recursive: true })"`,
    `perl -e "unlink '/etc/passwd'"`,
    `ruby -e "File.write('/c/x.txt', 'y')"`
  ]) assert.ok(bash(c), c);
});

test('one-liners that only read, or write inside, are left alone', () => {
  for (const c of [
    `python -c "print(open('C:/Windows/win.ini').read())"`,
    `node -e "console.log(require('path').resolve('/tmp'))"`,
    `python -c "open('out/report.json', 'w').write('{}')"`,
    `node -e "require('fs').writeFileSync('C:/work/shop/a.txt', '')"`,
    `python -c "import json,sys; print(json.load(sys.stdin)['name'])"`
  ]) assert.equal(bash(c), null, c);
});

test('heredocs fed to an interpreter or a shell are read too', () => {
  assert.ok(bash(`python3 - <<'EOF'\nimport os\nos.remove("/c/Users/me/a.txt")\nEOF`));
  assert.ok(bash(`bash <<EOF\nrm -rf /c/Users/me/Desktop\nEOF`));
  assert.equal(bash(`python3 - <<'EOF'\nprint(open("/etc/hosts").read())\nEOF`), null);
});

test('git off: git started from a nested shell or from code is refused', () => {
  for (const c of [
    `bash -c "git push"`,
    r`cmd /c git status`,
    `python -c "import subprocess; subprocess.run(['git', 'log'])"`,
    `node -e "require('child_process').execSync('git status')"`
  ]) assert.ok(bash(c, NOGIT), c);
  assert.ok(ps(`powershell -c "git commit -am x"`, NOGIT));
  assert.equal(bash(`python -c "print('git is great')"`, NOGIT), null, 'mentioning git is not running it');
  assert.equal(bash(`python -c "import subprocess; subprocess.run(['git', 'log'])"`), null, 'git on: allowed');
  for (const c of [
    `perl -e "system('git', 'push')"`,
    `perl -e "print \`git status\`"`,
    `ruby -e "system 'git status'"`,
    `node -e "require('child_process').exec(\`git status\`)"`,
    `python3 - <<'EOF'\nimport subprocess\nsubprocess.run(["git", "push"])\nEOF`
  ]) assert.ok(bash(c, NOGIT), c);
});

// Notes that talk about git, written with git off (WSL report, v1.1.3): a JS
// template string or the word "system" ran nothing, and the lines of a
// heredoc closed by `EOF)` were read as commands.
test('git off: prose about git is not running git', () => {
  for (const c of [
    "node -e \"require('fs').appendFileSync('n.md', `use git later`)\"",
    `node -e "require('fs').appendFileSync('n.md', 'exec git later')"`,
    `python3 -c "print('the system uses git')"`,
    "msg=$(cat <<'EOF'\ngit is off for me\nEOF)",
    "(cat <<'EOF'\ngit push once Jim has git\nEOF) >> notes.md",
    "cat >> notes.md <<'EOF'\ngit later\nEOF"
  ]) assert.equal(bash(c, NOGIT), null, c);
  assert.ok(bash("msg=$(cat <<'EOF'\nnotes\nEOF)\ngit commit -m \"$msg\"", NOGIT), 'git after the heredoc still counts');
  assert.ok(bash('echo $(git rev-parse HEAD)', NOGIT), 'git in a command substitution still counts');
});

test('let out of its folders: only the git rule still applies', () => {
  const free = { ...WIN, contained: false };
  assert.equal(bash(`python -c "open('C:/Users/me/x', 'w')"`, free), null);
  assert.ok(bash(`bash -c "git status"`, { ...free, git: false }));
});
