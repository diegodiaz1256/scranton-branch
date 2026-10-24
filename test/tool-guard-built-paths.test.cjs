'use strict';
// Paths code builds at run time (process.env.TMPDIR + "/x", homedir() + "/x"):
// the guard resolves the start it knows from the agent's environment and
// refuses only when the whole path is outside. Seen on a WSL floor (e2e,
// v1.1.3): god's `fs.readFileSync(process.env.TMPDIR+"/obj.txt")` next to a
// write into the hive was refused as "/obj.txt is outside your folders".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { guardToolCall } = loadTs('src/shared/toolGuard.ts');

const r = String.raw;
const U = (p) => `\\\\wsl.localhost\\Ubuntu${p.replace(/\//g, '\\')}`;
const office = '/home/zeroge/offices/e2e-escapes-2033';
const tmp = '/home/zeroge/.cache/scranton-branch/tmp';
// The policy HiveManager builds for god on a WSL floor, after noteAgentTmp.
const WSL = {
  cwd: U(office),
  roots: [U(office), U(`${office}/hive`), U(`${office}/hive/agents/god`), '/tmp', U('/home/zeroge/.claude/projects'), tmp],
  git: true, contained: true, home: U('/home/zeroge'), distro: 'Ubuntu',
  // Claude's sandboxed shell in the distro has TMPDIR=/tmp/claude-1000 (checked
  // with claude 2.1.310 in WSL); the app's policy reads TMPDIR as /tmp.
  vars: { TMPDIR: '/tmp', CLAUDE_CODE_TMPDIR: tmp }
};
const bash = (command, policy = WSL, cwd = `${office}/hive`) => guardToolCall('Bash', { command }, policy, r`C:\Users\me`, cwd);

test('the recorded e2e command (TMPDIR + "/obj.txt" read, writes in the hive) is allowed', () => {
  // God's call from the e2e-escapes-2033 transcript (heredoc text shortened).
  const command = `cd ${office}/hive && W=${office}/wordfreq\ncat > $TMPDIR/obj.txt <<'EOF'\nSandbox check.\nEOF\nnode -e '\nconst fs=require("fs"),o=fs.readFileSync(process.env.TMPDIR+"/obj.txt","utf8").trim(),W=process.argv[1];\nconst m={"probe-claude":{provider:"claude"}};\nfor(const n in m)fs.writeFileSync("spawn-requests/"+n+".json",JSON.stringify({objective:o,cwd:W,name:n,...m[n]}))' $W`;
  assert.equal(bash(command), null);
});

test('known starts resolve: inside is allowed, outside is refused naming the whole path', () => {
  for (const code of [
    `require("fs").writeFileSync(process.env.TMPDIR + "/obj.txt", "x")`,
    `require("fs").writeFileSync(process.env["TMPDIR"]+"/a/b.txt", "x")`,
    `require("fs").writeFileSync(require("os").tmpdir() + "/obj.txt", "x")`,
    `require("fs").writeFileSync(require("os").homedir() + "${office.slice('/home/zeroge'.length)}/out.txt", "x")`
  ]) assert.equal(bash(`node -e '${code}'`), null, code);
  for (const code of [
    `open(os.environ["CLAUDE_CODE_TMPDIR"] + "/claude-1000/scratchpad/n.md", "w").write("x")`,
    `open(os.environ["TMPDIR"] + "/obj.txt", "w").write("x")`,
    `open(os.getenv("TMPDIR") + "/obj.txt", "w").write("x")`,
    `open(tempfile.gettempdir() + "/obj.txt", "w").write("x")`
  ]) assert.equal(bash(`python3 -c '${code}'`), null, code);

  const out = bash(`node -e 'require("fs").writeFileSync(require("os").homedir() + "/escape.txt", "x")'`);
  assert.match(out.reason, /^Refused: \/home\/zeroge\/escape\.txt is outside your folders\./);
  const climb = bash(`node -e 'require("fs").writeFileSync(process.env.TMPDIR + "/../../../escape.txt", "x")'`);
  assert.ok(climb, 'climbing out of TMPDIR is refused');
  assert.match(climb.reason, /is outside your folders/);
});

test('an unknown start that looks outside is still refused', () => {
  const v = bash(`node -e 'require("fs").writeFileSync(process.env.SOMEWHERE + "/escape.txt", "x")'`);
  assert.ok(v);
  assert.match(v.reason, /builds at run time with "\/escape\.txt"/);
  // Without the agent's values the guard cannot tell: as before, refused.
  const { vars, ...noVars } = WSL;
  assert.ok(bash(`node -e 'require("fs").writeFileSync(process.env.TMPDIR + "/obj.txt", "x")'`, noVars));
});

test('open() whose file argument holds a call of its own is a write', () => {
  const v = bash(`python3 -c "import os; open(os.path.expanduser('~') + '/escape-py.txt', 'w').write('x')"`);
  assert.ok(v, 'expanduser(~) + "/x" opened for writing is refused');
  assert.match(v.reason, /^Refused: \/home\/zeroge\/escape-py\.txt is outside your folders/);
  assert.ok(bash(`python3 -c "open(str(os.path.expanduser('~')) + '/escape.txt', 'a')"`), 'two levels deep');
  // Reading is not writing; a file inside its folders is fine.
  assert.equal(bash(`python3 -c "print(open(os.path.expanduser('~') + '/notes.txt').read())"`), null);
  assert.equal(bash(`python3 -c "open(os.path.expanduser('~') + '${office.slice('/home/zeroge'.length)}/out.txt', 'w').write('x')"`), null);
});

test('shell $TMPDIR / ${TMPDIR} resolve to the agent temp folder', () => {
  assert.equal(bash('echo x > ${TMPDIR}/obj.txt'), null);
  assert.equal(bash('echo x > $TMPDIR/obj.txt'), null);
  const v = bash('echo x > $TMPDIR/../../../escape.txt');
  assert.ok(v);
  // A shell word is named as the agent typed it.
  assert.match(v.reason, /^Refused: \$TMPDIR\/\.\.\/\.\.\/\.\.\/escape\.txt is outside your folders/);
  assert.ok(bash('echo x > $HOME/escape.txt'), '$HOME still resolves');
  assert.equal(bash('echo x > $SOMETHING/obj.txt'), null, 'an unknown variable is not guessed at');
});

test('a Windows agent: os.tmpdir() and %TEMP% are its temp folder', () => {
  const temp = r`C:\Users\me\AppData\Local\Temp`;
  const WIN = { cwd: r`C:\work\shop`, roots: [r`C:\work\shop`, temp], git: true, contained: true, vars: { TMPDIR: temp, TEMP: temp, TMP: temp } };
  const g = (command) => guardToolCall('PowerShell', { command }, WIN, r`C:\Users\me`);
  assert.equal(g(`node -e "require('fs').writeFileSync(require('os').tmpdir() + '/obj.txt', 'x')"`), null);
  assert.equal(g(`Set-Content -Path $env:TEMP\\obj.txt -Value x`), null);
  const v = g(`node -e "require('fs').writeFileSync(require('os').homedir() + '/escape.txt', 'x')"`);
  assert.match(v.reason, /^Refused: C:\\Users\\me\\escape\.txt is outside your folders/);
});

test('HiveManager: the policy carries the temp folder, noteAgentTmp adds a WSL agent\'s own', async (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-guard-tmp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'worker-1', name: 'Dwight', provider: 'claude', cwd: home });
  assert.equal(hive.guardFor('worker-1').vars.TMPDIR, os.tmpdir());
  hive.noteAgentTmp('worker-1', '/home/u/.cache/scranton-branch/tmp');
  const g = hive.guardFor('worker-1');
  assert.equal(g.vars.CLAUDE_CODE_TMPDIR, '/home/u/.cache/scranton-branch/tmp');
  assert.equal(g.vars.TMPDIR, os.tmpdir(), 'TMPDIR is left as it was');
  assert.ok(g.roots.includes('/home/u/.cache/scranton-branch/tmp'));
});
