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
