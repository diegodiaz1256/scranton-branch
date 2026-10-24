'use strict';
/**
 * The OpenCode bridge plugin, run for real: it must send each tool call's
 * arguments (output.args), or nobody can tell which file an OpenCode agent wrote.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('tool.execute.before posts the tool name and its arguments to the hive socket', { skip: process.platform === 'win32' }, async (t) => {
  const hiveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-oc-'));
  t.after(() => fs.rmSync(hiveHome, { recursive: true, force: true }));
  const hive = new HiveManager(() => hiveHome);
  await hive.ensureAgent({ id: 'oc-1', name: 'OC', provider: 'opencode', cwd: hiveHome });
  const pluginDir = path.join(hiveHome, 'hive', 'agents', 'oc-1', '.opencode', 'plugin');
  const found = fs.existsSync(pluginDir) ? fs.readdirSync(pluginDir) : [];
  const file = found.length ? path.join(pluginDir, found[0]) : null;
  assert.ok(file, `plugin written under ${pluginDir}`);

  const sock = path.join(hiveHome, 'h.sock');
  const frames = [];
  // The office answers a tool call (as the hook server does); the plugin
  // waits for that answer, and refuses the call when none comes.
  const server = net.createServer((c) => {
    let b = '';
    let got = false;
    const take = () => { if (!got && b.trim()) { got = true; frames.push(JSON.parse(b.trim())); } };
    c.on('data', (d) => { b += d; if (b.endsWith('\n') && b.includes('"PreToolUse"')) { take(); c.end('{}'); } });
    c.on('end', take);
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  process.env.HIVE_SOCK = sock;
  process.env.AGENT_ID = 'oc-1';
  const copy = path.join(hiveHome, `plugin-${Date.now()}.mjs`);
  fs.copyFileSync(file, copy);
  const mod = await import(pathToFileURL(copy).href);
  const hooks = await mod.default();
  await hooks['tool.execute.before']({ tool: 'write', sessionID: 's', callID: 'c' }, { args: { filePath: '/r/research/a.md', content: 'x' } });
  await new Promise((r) => setTimeout(r, 200));
  delete process.env.HIVE_SOCK; delete process.env.AGENT_ID;
  assert.deepEqual(frames[0], { hook_event_name: 'PreToolUse', tool_name: 'write', tool_input: { filePath: '/r/research/a.md', content: 'x' }, agent_id: 'oc-1' });
});
