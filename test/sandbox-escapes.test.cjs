'use strict';
/**
 * Ways an agent stepped outside its sandbox when "the hive had a problem":
 *
 * 1. Its hook let every tool call through when the office (the app's hook
 *    server) did not answer, so Write/Edit reached anywhere on the disk.
 *    Now a hive agent's hook retries, then decides from its folders: inside
 *    goes ahead, outside or a control file is refused, a shell goes ahead only
 *    where an OS sandbox holds it. Other events never wait.
 * 2. A Bash call with `dangerouslyDisableSandbox` ran unconfined: the
 *    per-agent settings now hold `allowUnsandboxedCommands: false`.
 * 3. The office's controls (agents' settings.json/mcp.json and hook configs,
 *    the hive's bin/, the project's .claude/settings*.json) sat in folders the
 *    agent may write. Now they are read-only to its shell (denyWrite), refused
 *    to its file tools (permission rules) and refused by the guard.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { guardToolCall, withinPattern } = loadTs('src/shared/toolGuard.ts');
const { bwrapArgs } = loadTs('src/shared/bwrapSandbox.ts');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-escape-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function claudeAgent(t, extra = {}) {
  const home = tmp(t);
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: project }, extra);
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  return { home, project, hive, inj, settings, root: path.join(home, 'hive'), dir: path.join(home, 'hive', 'agents', 'jim') };
}

// ─── 2: no way out of the sandbox ───────────────────────────────────────────

test('a Claude agent may not run commands outside its sandbox', async (t) => {
  const { settings } = await claudeAgent(t);
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
  assert.equal(settings.sandbox.excludedCommands, undefined, 'no command is let out of it');
  assert.notEqual(settings.sandbox.filesystem.disabled, true);
});

// ─── 3: the office's controls ───────────────────────────────────────────────

test('its settings, mcp.json, the hive bin/ and the project\'s Claude settings are read-only to its shell and refused to its file tools', async (t) => {
  const { settings, root, dir, project } = await claudeAgent(t);
  const deny = settings.sandbox.filesystem.denyWrite;
  for (const p of [path.join(dir, 'settings.json'), path.join(dir, 'mcp.json'), path.join(root, 'bin'),
    path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')]) {
    assert.ok(deny.includes(p), `denyWrite ${p}`);
  }
  // Its own folder and the hive stay writable.
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(dir));
  assert.ok(!deny.includes(dir) && !deny.includes(root));
  if (process.platform !== 'win32') {
    const rules = settings.permissions.deny;
    assert.ok(rules.includes(`Edit(/${path.join(root, 'agents', '*', 'settings.json')})`), 'every agent\'s settings, hired later too');
    assert.ok(rules.includes(`Edit(/${path.join(root, 'bin')}/**)`));
  }
});

test('another agent\'s controls are denied too, and a respawn picks up new agents', async (t) => {
  const { hive, project, root } = await claudeAgent(t);
  await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: project });
  const again = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: project });
  const s = JSON.parse(fs.readFileSync(again.args[again.args.indexOf('--settings') + 1], 'utf8'));
  assert.ok(s.sandbox.filesystem.denyWrite.includes(path.join(root, 'agents', 'pam', 'settings.json')));
});

test('the guard refuses the controls to file tools and shell commands, even for an agent let out of its folders', async (t) => {
  const { hive, root, dir, project } = await claudeAgent(t, { roam: true });
  const g = hive.guardFor('jim');
  assert.equal(g.contained, false);
  const pam = path.join(root, 'agents', 'pam', 'settings.json');
  const shim = path.join(root, 'bin', 'cth-hook.cjs');
  for (const [tool, input] of [
    ['Write', { file_path: path.join(dir, 'settings.json') }],
    ['Edit', { file_path: pam }],
    ['Write', { file_path: path.join(project, '.claude', 'settings.local.json') }],
    ['Bash', { command: `echo x >> "${shim}"` }],
    ['Bash', { command: `cd "${root}" && rm -rf bin` }],
    ['Bash', { command: `mv "${path.join(root, 'bin')}" /tmp/b` }],
    ['Bash', { command: `ln -s "${shim}" "${path.join(dir, 'x.cjs')}"` }],
    ['Bash', { command: `node -e "require('fs').writeFileSync('${shim.replace(/\\/g, '/')}', '')"` }]
  ]) {
    const v = guardToolCall(tool, input, g, os.homedir(), project);
    assert.ok(v, `${tool} ${JSON.stringify(input)}`);
    assert.match(v.reason, /control files/);
  }
  // Ordinary work goes on: its folders, the project, reading the controls, running bin/.
  for (const [tool, input] of [
    ['Write', { file_path: path.join(project, 'src', 'a.ts') }],
    ['Write', { file_path: path.join(dir, 'memory.md') }],
    ['Write', { file_path: path.join(project, '.claude', 'skills', 'x', 'SKILL.md') }],
    ['Read', { file_path: path.join(dir, 'settings.json') }],
    ['Bash', { command: `node "${path.join(root, 'bin', 'md-api.cjs')}" github GET /user` }],
    ['Bash', { command: `cp "${path.join(dir, 'settings.json')}" /tmp/s.json` }],
    ['Bash', { command: `mv "${path.join(dir, 'inbox', 'm.md')}" "${path.join(dir, 'inbox', '.done')}"/` }]
  ]) {
    assert.equal(guardToolCall(tool, input, g, os.homedir(), project), null, `${tool} ${JSON.stringify(input)}`);
  }
});

test('a pattern\'s * is one whole folder name', () => {
  assert.ok(withinPattern('/h/hive/agents/pam/settings.json', '/h/hive/agents/*/settings.json'));
  assert.ok(withinPattern('/h/hive/agents/pam/.gemini-hive/x.cjs', '/h/hive/agents/*/.gemini-hive'));
  assert.ok(!withinPattern('/h/hive/agents/settings.json', '/h/hive/agents/*/settings.json'));
  assert.ok(!withinPattern('/h/hive/agents/pam/sub/settings.json', '/h/hive/agents/*/settings.json'));
  assert.ok(withinPattern('C:\\H\\hive\\agents\\Pam\\mcp.json', 'c:/h/hive/agents/*/mcp.json'));
});

test('bubblewrap keeps the controls read-only over a writable folder', () => {
  const args = bwrapArgs({ writable: ['/h/hive', '/h/hive/agents/jim'], readOnly: ['/h/hive/agents'], controls: ['/h/hive/bin', '/h/hive/agents/jim/settings.json'], home: '/home/u' }, () => false);
  const last = (p) => args.lastIndexOf(p);
  assert.ok(last('/h/hive/bin') > args.indexOf('/h/hive'), 'after the hive is opened');
  assert.equal(args[args.lastIndexOf('/h/hive/agents/jim/settings.json') - 2], '--ro-bind-try');
  assert.ok(args.lastIndexOf('/h/hive/agents/jim/settings.json') > args.lastIndexOf('/h/hive/agents/jim'), 'after its own folder is reopened');
});
