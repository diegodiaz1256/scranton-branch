'use strict';
/**
 * "Run without sandbox": a per-agent switch only the human turns on (the
 * agent's name typed back), never for a custodian. On, Claude Code's sandbox
 * is off and pi runs without bubblewrap; the guard still keeps the office's
 * control files from it.
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
const { confirmsName, runsUnsandboxed, unsandboxedAgents, unsandboxRefusal } = loadTs('src/shared/unsandboxed.ts');

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-unsbx-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('only the listed agents, and never a custodian', () => {
  assert.deepEqual(unsandboxedAgents(['jim', 'jim', '', 3, 'pam']), ['jim', 'pam']);
  assert.deepEqual(unsandboxedAgents(undefined), []);
  assert.equal(runsUnsandboxed(['jim'], {}, 'jim'), true);
  assert.equal(runsUnsandboxed(['jim'], {}, 'pam'), false);
  assert.equal(runsUnsandboxed([], {}, 'jim'), false, 'off by default');
  assert.equal(runsUnsandboxed(['jim'], { 'mcp:jira': 'jim' }, 'jim'), false, 'a custodian keeps its sandbox');
});

test('turning it on takes the agent\'s name typed back; turning it off does not', () => {
  assert.equal(confirmsName('  JIM ', 'Jim'), true);
  assert.equal(confirmsName('Jimmy', 'Jim'), false);
  assert.equal(confirmsName('', 'Jim'), false);
  assert.equal(unsandboxRefusal({ on: true, name: 'Jim', typed: 'jim', custodian: false, known: true }), null);
  assert.match(unsandboxRefusal({ on: true, name: 'Jim', typed: 'yes', custodian: false, known: true }), /Type Jim/);
  assert.match(unsandboxRefusal({ on: true, name: 'Pam', typed: 'Pam', custodian: true, known: true }), /custodian/);
  assert.equal(unsandboxRefusal({ on: false, name: 'Pam', typed: undefined, custodian: true, known: true }), null, 'off is always allowed');
  assert.equal(unsandboxRefusal({ on: true, name: 'x', typed: 'x', custodian: false, known: false }), 'unknown agent');
});

test('a Claude agent run without sandbox: sandbox off, its control files still refused', async (t) => {
  const home = tmp(t);
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: project }, { unsandboxed: true });
  const s = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  assert.deepEqual(s.sandbox, { enabled: false });
  assert.equal(inj.osSandbox, 'off');
  assert.equal(JSON.parse(inj.env.HIVE_GUARD).sandboxed, false, 'offline, its shell waits for the office');
  if (process.platform !== 'win32') assert.ok(s.permissions.deny.some((r) => r.includes('settings.json')), 'Edit rules on the controls stay');
  const v = guardToolCall('Write', { file_path: path.join(home, 'hive', 'bin', 'cth-hook.cjs') }, hive.guardFor('jim'), os.homedir(), project);
  assert.match(v.reason, /control files/);

  // Back on: the sandbox returns and the mark goes.
  const again = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: project }, {});
  const s2 = JSON.parse(fs.readFileSync(again.args[again.args.indexOf('--settings') + 1], 'utf8'));
  // (On Windows the block comes back written but off: see hive.ts.)
  assert.equal(s2.sandbox.enabled, process.platform !== 'win32');
  assert.equal(s2.sandbox.allowUnsandboxedCommands, false);
  assert.equal(again.osSandbox, undefined);
});

test('a pi agent run without sandbox gets no bubblewrap, and is marked off, not "none"', async (t) => {
  const home = tmp(t);
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => true;
  hive.existingPaths = async () => [];
  const inj = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: project }, { unsandboxed: true });
  assert.equal(inj.wrap, undefined);
  assert.equal(inj.osSandbox, 'off');
  const boxed = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: project }, {});
  assert.equal(boxed.osSandbox, 'app');
  assert.ok(Array.isArray(boxed.wrap));
});

test('main: only agent:setUnsandboxed sets it; the generic config write drops it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const update = src.slice(src.indexOf("ipcMain.handle('config:update'"), src.indexOf("ipcMain.handle('config:setAgentMcpGrant'"));
  assert.match(update, /const safePatch = stripHumanOnly\(patch\)/);
  assert.ok(require('./load-ts.cjs')('src/shared/anonSettings.ts').HUMAN_ONLY_CONFIG_KEYS.includes('agentUnsandboxed'));
  assert.match(update, /writeConfig\(safePatch\)/);
  assert.ok(!/writeConfig\(patch\)/.test(update));
  const set = src.slice(src.indexOf("ipcMain.handle('agent:setUnsandboxed'"));
  assert.match(set.slice(0, 1500), /unsandboxRefusal\(/);
  assert.match(set.slice(0, 1500), /appendLog\(\{ kind: 'unsandboxed'/);
});
