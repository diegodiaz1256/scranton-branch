'use strict';
// Capabilities said "no git" but the agent kept running git in its shell, and
// any agent could write anywhere on the disk. The PreToolUse guard refuses both.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { guardToolCall, normPath, within, splitCommands } = loadTs('src/shared/toolGuard.ts');

const r = String.raw;
const WIN = { cwd: r`C:\work\shop`, roots: [r`C:\work\shop`, r`G:\office\hive`, r`C:\Temp`], git: true, contained: true };
const bash = (command, p = WIN) => guardToolCall('Bash', { command }, p, r`C:\Users\me`);

test('path spellings fold together', () => {
  assert.equal(normPath(r`C:\Work\Shop\ `.trim()), '/c/work/shop');
  assert.equal(normPath('/mnt/c/work/shop'), '/c/work/shop');
  assert.equal(normPath('/c/work/shop/../x'), '/c/work/x');
  assert.ok(within('/c/WORK/shop/src/a.ts', r`C:\work\shop`));
  assert.ok(!within(r`C:\work\shopping`, r`C:\work\shop`));
});

test('git off: git in the shell is refused, however it is spelled', () => {
  const p = { ...WIN, git: false };
  for (const c of ['git status', 'cd src && git commit -m x', 'GIT_DIR=x git log', r`"C:\Program Files\Git\bin\git.exe" push`, 'echo hi; git push', 'ls | git hash-object --stdin']) {
    assert.ok(bash(c, p), c);
  }
  assert.equal(bash('echo git is great', p), null);
  assert.equal(bash('npm test', p), null);
  assert.equal(guardToolCall('PowerShell', { command: 'git status' }, WIN), null, 'git on: allowed');
  assert.ok(guardToolCall('PowerShell', { command: 'git status' }, p));
});

test('contained: file tools write only inside its folders', () => {
  assert.equal(guardToolCall('Write', { file_path: r`C:\work\shop\a.ts` }, WIN), null);
  assert.equal(guardToolCall('Edit', { file_path: 'src/a.ts' }, WIN), null, 'relative to cwd');
  assert.equal(guardToolCall('Write', { file_path: 'G:/office/hive/agents/jim/outbox/m.json' }, WIN), null);
  assert.ok(guardToolCall('Write', { file_path: r`C:\Users\me\.bashrc` }, WIN));
  assert.ok(guardToolCall('Edit', { file_path: r`..\other\a.ts` }, WIN), 'escapes with ..');
  assert.ok(guardToolCall('write', { filePath: r`D:\x.txt` }, WIN), 'OpenCode spelling');
  assert.equal(guardToolCall('Read', { file_path: r`D:\x.txt` }, WIN), null, 'reading elsewhere is fine');
});

test('contained: the shell may not move to, write to or delete from outside', () => {
  for (const c of [r`cd D:\other && npm i`, 'cd .. && rm -rf shop', r`echo x > C:\Users\me\a.txt`, 'rm -rf /c/Users/me', r`Remove-Item -Recurse D:\data`, 'mv a.ts ../elsewhere/', r`cp src/a.ts D:\backup\ `.trim(), r`git -C D:\other status`, r`Set-Location ~\Desktop`, 'echo hi >> ~/notes.md']) {
    assert.ok(bash(c), c);
  }
  for (const c of ['npm test 2>&1', r`cat D:\other\README.md`, r`cp D:\other\seed.json ./fixtures/`, 'ls /c/Users', 'rm -rf node_modules', 'echo x > /dev/null', 'cd src && npm run build > out.log', r`echo x > C:\Temp\scratch.txt`, 'node -e "1>2"']) {
    assert.equal(bash(c), null, c);
  }
});

test('let out: no fence, git rule still applies', () => {
  const free = { ...WIN, contained: false };
  assert.equal(guardToolCall('Write', { file_path: r`D:\x.txt` }, free), null);
  assert.equal(bash(r`cd D:\other`, free), null);
  assert.ok(bash('git push', { ...free, git: false }));
});

test('commands split on separators but not inside quotes or 2>&1', () => {
  assert.deepEqual(splitCommands('a "b && c" && d 2>&1 | e'), [['a', 'b && c'], ['d', '2>&1'], ['e']]);
});

test('other CLIs: a Codex patch or an agy write outside is refused too', () => {
  assert.ok(guardToolCall('apply_patch', { input: '*** Begin Patch\n*** Add File: ../../evil.md\n+x\n*** End Patch' }, WIN));
  assert.ok(guardToolCall('write_to_file', { TargetFile: r`D:\x.md`, CodeContent: 'x' }, WIN));
  assert.equal(guardToolCall('apply_patch', { input: '*** Begin Patch\n*** Add File: research/r.md\n+x\n*** End Patch' }, WIN), null);
});

test('through the real hook server: Git off in Capabilities refuses git, the prompt says so', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const electron = require.resolve('electron');
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };
  const { HiveManager } = loadTs('src/main/hive.ts');
  const { HookServer } = loadTs('src/main/hooks.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  // A grant without the Git server: git is off for this agent.
  const inj = await hive.ensureAgent({ id: 'g1', name: 'G', provider: 'claude', cwd }, { mcpGrant: ['filesystem'] });
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /LIMITS: write only inside your folders/);
  assert.match(prompt, /git is switched off for you/);
  const server = new HookServer(hive, () => null, () => ({}), undefined, undefined);
  const ask = (tool_name, tool_input) => server.handle({ agent_id: 'g1', session_id: 's', hook_event_name: 'PreToolUse', tool_name, tool_input });
  assert.equal((await ask('Bash', { command: 'git push' })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((await ask('Write', { file_path: path.join(os.homedir(), 'x.txt') })).hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal((await ask('Write', { file_path: path.join(cwd, 'ok.txt') })).hookSpecificOutput, undefined);
  assert.equal((await ask('Bash', { command: 'npm test' })).hookSpecificOutput, undefined);
  // Relative paths resolve where the hook says the shell is.
  assert.equal((await ask('Bash', { command: 'echo x > ok.txt' })).hookSpecificOutput, undefined);
  const inHome = await server.handle({ agent_id: 'g1', session_id: 's', hook_event_name: 'PreToolUse', cwd: os.homedir(), tool_name: 'Bash', tool_input: { command: 'echo x > ok.txt' } });
  assert.equal(inHome.hookSpecificOutput?.permissionDecision, 'deny');
  // Switched back on in Capabilities: the running agent gets it at once.
  hive.refreshGuards({ agentMcpGrants: { g1: ['filesystem', 'git'] } });
  assert.equal((await ask('Bash', { command: 'git push' })).hookSpecificOutput, undefined);
  hive.refreshGuards({ agentMcpGrants: { g1: ['filesystem'] }, agentRoam: ['g1'] });
  assert.equal((await ask('Write', { file_path: path.join(os.homedir(), 'x.txt') })).hookSpecificOutput, undefined, 'let out');
  // Default (no grant): git stays on.
  await hive.ensureAgent({ id: 'g2', name: 'H', provider: 'claude', cwd }, {});
  const ok = await server.handle({ agent_id: 'g2', session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } });
  assert.equal(ok.hookSpecificOutput, undefined);
});

// A WSL office (report 2026-10-14): the app, on Windows, records the folders
// as \\wsl.localhost\<distro>\…, while the agent inside the distro writes
// /home/…. Every write to its own outbox, tasks.json and research/ was refused.
test('on a WSL floor the agent may write its own folders by their Linux paths', () => {
  const unc = r`\\wsl.localhost\Ubuntu\home\me\office`;
  const policy = {
    cwd: unc,
    roots: [unc, r`\\wsl.localhost\Ubuntu\home\me\office\hive`, r`\\wsl.localhost\Ubuntu\home\me\office\hive\agents\god`, '/tmp'],
    git: true, contained: true, home: r`\\wsl.localhost\Ubuntu\home\me`
  };
  const hive = '/home/me/office/hive';
  for (const [tool, input] of [
    ['Write', { file_path: `${hive}/agents/god/outbox/to-worker.json`, content: '{}' }],
    ['Bash', { command: `cat > ${hive}/agents/god/outbox/to-worker.json <<'X'\n{}\nX` }],
    ['Bash', { command: `cd ${hive} && python3 -c "print(1)"` }],
    ['Bash', { command: 'cd /home/me/office && ls hive/agents/god/outbox' }],
    ['Write', { file_path: r`\\wsl.localhost\Ubuntu\home\me\office\hive\tasks.json`, content: '{}' }],
    ['Write', { file_path: r`\\wsl$\Ubuntu\home\me\office\research\r.md`, content: 'x' }],
    ['Bash', { command: 'echo hi > ~/office/hive/board.md' }]
  ]) assert.equal(guardToolCall(tool, input, policy, '/c/Users/me'), null, `${tool} ${JSON.stringify(input)}`);
  // Still fenced: somewhere else in the distro, or on the Windows side.
  assert.ok(guardToolCall('Write', { file_path: '/home/me/other/x.txt', content: 'x' }, policy, '/c/Users/me'));
  assert.ok(guardToolCall('Bash', { command: 'rm -rf /etc/x' }, policy, '/c/Users/me'));
  assert.ok(guardToolCall('Write', { file_path: 'C:/Windows/x.txt', content: 'x' }, policy, '/c/Users/me'));
});

// A WSL office (v1.1.3): relative paths resolved against the folder the agent
// was started in, not where its shell was. From hive/agents/god/inbox,
// `cd ../..` was "outside your folders"; from hive/research, `>> ../agents/…`
// too. The policy below is what HiveManager builds for god on that floor; the
// payloads are real PreToolUse calls from claude in the distro (cwd included).
test('on a WSL floor relative paths resolve where the shell is (the hook cwd)', () => {
  const office = r`\\wsl.localhost\Ubuntu\home\zeroge\offices\wsl-guardcwd`;
  const policy = {
    cwd: office,
    roots: [office, `${office}\\hive\\agents\\god`, `${office}\\hive`, '/tmp', r`\\wsl.localhost\Ubuntu\home\zeroge\.claude\projects`],
    git: false, contained: true, home: r`\\wsl.localhost\Ubuntu\home\zeroge`
  };
  const lin = '/home/zeroge/offices/wsl-guardcwd';
  const call = (command, cwd) => guardToolCall('Bash', { command }, policy, r`C:\Users\me`, cwd);
  for (const [cwd, command] of [
    [`${lin}/hive/agents/god/inbox`, 'cd ../.. && pwd'],
    [`${lin}/hive/agents/god/inbox`, 'ls ../.. && echo done > ../../../board.md'],
    [`${lin}/hive/research`, 'echo x >> ../agents/god/memory.md'],
    [`${lin}/hive/research`, `cd ${lin}/hive/agents/god/inbox && echo y >> ../memory.md && cd ../../.. && pwd`],
    [lin, 'cd hive/research && echo x >> ../board.md'],
    [lin, 'pushd hive/agents/god/inbox && echo x > ../memory.md && popd && echo y > hive/board.md'],
    ['/home/zeroge/.claude/projects/-home-zeroge-offices', 'echo x > notes.md']
  ]) assert.equal(call(command, cwd), null, `${cwd}: ${command}`);
  // Still fenced, wherever the shell is.
  for (const [cwd, command] of [
    [`${lin}/hive/research`, 'echo z > /home/zeroge/escape.txt'],
    [`${lin}/hive/research`, 'echo z > ../../../escape.txt'],
    [`${lin}/hive/agents/god/inbox`, 'cd ../../../../.. && rm -rf offices'],
    [lin, 'cd hive && cd ../.. && touch x'],
    // A cd inside a subshell does not move the commands after it.
    [lin, '(cd hive/agents/god/inbox) && echo z > ../../../../escape.txt'],
    [lin, 'pushd hive/agents/god/inbox && popd && echo z > ../escape.txt'],
    [`${lin}/hive`, 'git status']
  ]) assert.ok(call(command, cwd), `${cwd}: ${command}`);
  // No cwd from the hook (other CLIs): the folder it was started in, as before.
  assert.ok(call('echo x >> ../agents/god/memory.md'));
  assert.equal(call('cd hive/research && echo x >> ../agents/god/memory.md'), null);
});

test('the shell cwd counts on Windows too, and a cd in the line moves what follows', () => {
  assert.equal(guardToolCall('Bash', { command: 'echo x > ../hive/board.md' }, { ...WIN, roots: [...WIN.roots, r`G:\office`] }, r`C:\Users\me`, r`G:\office\research`), null);
  assert.equal(bash(r`cd G:\office\hive\agents\jim && echo x > ..\..\board.md`), null);
  assert.equal(bash(r`cd /d G:\office\hive && echo x > tasks.json`), null);
  assert.ok(bash(r`cd G:\office\hive && echo x > ..\escape.txt`));
  assert.ok(guardToolCall('Write', { file_path: '../x.txt' }, WIN, r`C:\Users\me`, r`C:\work\shop`));
  assert.equal(guardToolCall('Write', { file_path: '../shop/x.txt' }, WIN, r`C:\Users\me`, r`C:\work\shop\src`), null);
});
