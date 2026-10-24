'use strict';
/**
 * The OpenCode bridge plugin with the events OpenCode 1.18.34 really sends
 * (captured from a run against a mock OpenAI-compatible model):
 * - the app writes the plugin to plugin/ AND plugins/, and 1.18 loads both:
 *   every event reached the office twice;
 * - the session id (session.created) and each step's tokens and cost
 *   (message.part.updated, type step-finish) were never sent, so an OpenCode
 *   agent had no session to resume and no cost.
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

test('loaded twice, the plugin reports once, with its session and a cost row per step', async (t) => {
  const hiveHome = fs.mkdtempSync(path.join(os.tmpdir(), 'md-oc-cost-'));
  t.after(() => fs.rmSync(hiveHome, { recursive: true, force: true }));
  const hive = new HiveManager(() => hiveHome);
  await hive.ensureAgent({ id: 'oc-1', name: 'OC', provider: 'opencode', cwd: hiveHome });
  const base = path.join(hiveHome, 'hive', 'agents', 'oc-1', '.opencode');
  const files = ['plugin', 'plugins'].map((d) => path.join(base, d, 'hive-bridge.js'));
  for (const f of files) assert.ok(fs.existsSync(f), f);

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
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  process.env.HIVE_SOCK = `tcp://127.0.0.1:${server.address().port}`;
  process.env.AGENT_ID = 'oc-1';
  delete globalThis.__mdHiveBridge;
  t.after(() => { delete process.env.HIVE_SOCK; delete process.env.AGENT_ID; delete globalThis.__mdHiveBridge; });

  // Both copies, as OpenCode loads them.
  const hooks = [];
  for (const [i, f] of files.entries()) {
    const copy = path.join(hiveHome, `copy-${i}.mjs`);
    fs.copyFileSync(f, copy);
    hooks.push(await (await import(pathToFileURL(copy).href)).default());
  }
  const fire = async (event) => { for (const h of hooks) if (h.event) await h.event({ event }); };
  await fire({ type: 'session.created', properties: { sessionID: 'ses_1', info: { id: 'ses_1' } } });
  await fire({ type: 'session.created', properties: { sessionID: 'ses_sub', info: { id: 'ses_sub', parentID: 'ses_1' } } });
  await fire({ type: 'message.updated', properties: { sessionID: 'ses_1', info: { id: 'msg_1', role: 'assistant', modelID: 'mock-1', providerID: 'mock', tokens: { input: 0, output: 0 }, cost: 0 } } });
  const step = { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_1', type: 'step-finish', tokens: { total: 1050, input: 1000, output: 50, reasoning: 0, cache: { write: 3, read: 7 } }, cost: 0 } } };
  await fire(step);
  await fire(step); // the same part updated again: still one row
  await fire({ type: 'session.idle', properties: { sessionID: 'ses_sub' } }); // a sub-agent going idle is not the agent
  await fire({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
  for (const h of hooks) if (h['tool.execute.before']) await h['tool.execute.before']({ tool: 'bash' }, { args: { command: 'ls' } });
  await new Promise((r) => setTimeout(r, 300));

  const seen = frames.map((f) => [f.hook_event_name, f.session_id]).sort();
  assert.deepEqual(seen, [['CostSample', 'ses_1'], ['PreToolUse', 'ses_1'], ['SessionStart', 'ses_1'], ['Stop', 'ses_1']].sort());
  const cost = frames.find((f) => f.hook_event_name === 'CostSample');
  assert.deepEqual({ model: cost.model, input: cost.input, output: cost.output, cache_read: cost.cache_read, cache_creation: cost.cache_creation, usd: cost.usd },
    { model: 'mock/mock-1', input: 1000, output: 50, cache_read: 7, cache_creation: 3, usd: 0 });
});
