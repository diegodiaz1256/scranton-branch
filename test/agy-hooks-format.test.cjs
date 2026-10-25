'use strict';

/**
 * agy's hooks.json: tool events are grouped ({ matcher, hooks: [...] }), the
 * others (PreInvocation, PostInvocation, Stop) take their handlers directly.
 * Grouped everywhere, agy 1.4 refused the whole file ("invalid hook
 * "munder-hive": command hook must specify 'command'") and no hook ran: an
 * Antigravity worker's tool calls were never checked by the office.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { guardToolCall } = loadTs('src/shared/toolGuard.ts');

test('the guard reads Antigravity 1.4 tool calls: write_file/edit_file Path, run_command CommandLine', async (t) => {
  // As agy sends them on PreToolUse (captured from agy 1.4.7):
  // write_file {Path, Content}, edit_file {Path, Target, Replacement}, run_command {CommandLine}.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agy-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: project });
  const g = hive.guardFor('jim');
  const root = path.join(home, 'hive');
  const shim = path.join(root, 'bin', 'cth-hook.cjs');
  const outside = path.join(os.homedir(), 'escape.txt');
  for (const [tool, input, why] of [
    ['write_file', { Path: outside, Content: 'x' }, /outside your folders/],
    ['edit_file', { Path: shim, Target: '}', Replacement: '}\n// x' }, /control files/],
    ['run_command', { CommandLine: `echo x >> ${path.join(root, 'bin', 'agy-hook.cjs')}` }, /control files/],
    ['run_command', { CommandLine: `touch ${outside}` }, /outside your folders/]
  ]) {
    const v = guardToolCall(tool, input, g, os.homedir(), project);
    assert.ok(v, `${tool} ${JSON.stringify(input)}`);
    assert.match(v.reason, why);
  }
  for (const [tool, input] of [
    ['write_file', { Path: path.join(project, 'a.txt'), Content: 'ok' }],
    ['edit_file', { Path: path.join(project, 'a.txt'), Target: 'ok', Replacement: 'bye' }],
    ['run_command', { CommandLine: 'npm test' }],
    ['run_command', { CommandLine: `node ${path.join(root, 'bin', 'sb-api.cjs')}` }],
    ['read_file', { Path: shim }]
  ]) {
    assert.equal(guardToolCall(tool, input, g, os.homedir(), project), null, `${tool} ${JSON.stringify(input)}`);
  }
});

test('agy hooks.json: tool events grouped, the rest flat handlers with a command', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agy-hooks-'));
  const home = path.join(base, 'user');
  const harness = path.join(base, 'harness');
  fs.mkdirSync(home, { recursive: true });
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    fs.rmSync(base, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home, 'home redirect failed — aborting before touching the real home');

  const hive = new HiveManager(() => harness);
  hive.ensureHive();
  hive.installAgyHooks();

  for (const file of [path.join(home, '.gemini', 'config', 'hooks.json'), path.join(home, '.gemini', 'antigravity-cli', 'hooks.json')]) {
    const group = JSON.parse(fs.readFileSync(file, 'utf8'))['munder-hive'];
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      const [g] = group[ev];
      assert.equal(g.matcher, '*', `${ev} matcher`);
      assert.match(g.hooks[0].command, /agy-hook\.cjs/, `${ev} command`);
    }
    for (const ev of ['PreInvocation', 'PostInvocation', 'Stop']) {
      const [h] = group[ev];
      assert.equal(h.hooks, undefined, `${ev} must not be grouped`);
      assert.equal(h.type, 'command');
      assert.match(h.command, new RegExp(`agy-hook\\.cjs"? ${ev}$`), `${ev} command`);
    }
  }
});
