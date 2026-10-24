'use strict';
/**
 * The hook server works out which files a tool call writes, for every CLI the
 * floor runs, and makes relative paths absolute against the agent's folder.
 * Deliverables and the task links are built on this, so each CLI's real event
 * shape goes through the real HookServer here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

async function floor(t, provider) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hooks-files-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  // Let out of its folders: these check the paths read, not the fence (tool-guard.test.cjs).
  await hive.ensureAgent({ id: 'a1', name: 'A', provider, cwd }, { roam: true });
  const server = new HookServer(hive, () => null, () => ({}), undefined, undefined);
  const seen = [];
  server.onStep = (_id, e) => seen.push(e);
  const fire = (payload) => server.handle({ agent_id: 'a1', session_id: 's1', ...payload });
  return { cwd, server, fire, seen };
}

const files = (seen) => seen.flatMap((e) => e.files ?? []);

test('Codex apply_patch: relative paths in the patch, made absolute against the agent folder', async (t) => {
  const { cwd, fire, seen } = await floor(t, 'codex');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: ['apply_patch', '*** Begin Patch\n*** Add File: research/r.md\n+x\n*** End Patch'] } });
  assert.deepEqual(files(seen), [path.join(cwd, 'research/r.md')]);
});

test('Codex reporting only after the tool ran (PostToolUse) still counts', async (t) => {
  const { cwd, fire, seen } = await floor(t, 'codex');
  await fire({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { input: '*** Begin Patch\n*** Update File: notes.md\n@@\n-a\n+b\n*** End Patch' } });
  assert.deepEqual(files(seen), [path.join(cwd, 'notes.md')]);
});

test('Antigravity write_to_file (agy shim payload)', async (t) => {
  const { fire, seen } = await floor(t, 'agy');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'write_to_file', tool_input: { TargetFile: '/abs/research/plan.md', CodeContent: '# plan' } });
  assert.deepEqual(files(seen), ['/abs/research/plan.md']);
});

test('OpenCode write (plugin now sends output.args)', async (t) => {
  const { fire, seen } = await floor(t, 'opencode');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { filePath: '/abs/research/o.md', content: 'x' } });
  assert.deepEqual(files(seen), ['/abs/research/o.md']);
});

test('Pi edit with a relative path', async (t) => {
  const { cwd, fire, seen } = await floor(t, 'pi');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'edit', tool_input: { path: 'research/p.md', oldText: 'a', newText: 'b' } });
  assert.deepEqual(files(seen), [path.join(cwd, 'research/p.md')]);
});

test('the history the Deliverables list reads carries them too; reads carry none', async (t) => {
  const { server, fire } = await floor(t, 'pi');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'read', tool_input: { path: 'x.md' } });
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { path: '/abs/y.md', content: 'z' } });
  const steps = server.stepsFor('a1');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].files, undefined);
  assert.deepEqual(steps[1].files, ['/abs/y.md']);
  assert.equal(steps[1].detail, '/abs/y.md', 'the step says which file, not its content');
});

// Live on a WSL floor: Jim appended to a report with `echo … >> file` (Claude's
// Bash), nothing recorded the write, and the app's batched commit took it in
// as "App": the history and "edited by" kept naming the agent before him.
test('a shell write counts: Claude Bash appending to a report (WSL Linux path)', async (t) => {
  const { fire, seen } = await floor(t, 'claude');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/home/u/offices/x', tool_input: { command: 'echo "- Jim: final pass" >> /home/u/offices/x/hive/research/hist/notes.md' } });
  assert.deepEqual(files(seen), ['/home/u/offices/x/hive/research/hist/notes.md']);
});

test('a WSL agent\'s relative writes stay Linux paths under its Linux folder', async (t) => {
  const { fire, seen } = await floor(t, 'claude');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/home/u/offices/x', tool_input: { command: 'cd hive && cat > research/a.md <<\'EOF\'\n# A\nEOF' } });
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: '/home/u/offices/x', tool_input: { command: ['apply_patch', '*** Begin Patch\n*** Update File: hive/research/b.md\n@@\n-a\n+b\n*** End Patch'] } });
  assert.deepEqual(files(seen), ['/home/u/offices/x/hive/research/a.md', '/home/u/offices/x/hive/research/b.md']);
});

test('shell commands that write nothing carry no files', async (t) => {
  const { fire, seen } = await floor(t, 'claude');
  await fire({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'od -c research/a.md | tail -5 2>/dev/null; mkdir -p research/new; ls > /dev/null 2>&1' } });
  assert.deepEqual(files(seen), []);
});
