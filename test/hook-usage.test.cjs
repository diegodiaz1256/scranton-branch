'use strict';

// fleet.json for engines without Claude's OTel (Pi, OpenCode, proxy-bridged
// CLIs): tokens, cost, last tool and last seen come from their hook bridge.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HookUsageTracker, fleetUsage } = loadTs('src/shared/hookUsage.ts');
const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');

// What a real Pi 1.0.4 run sent through the office's extension (WSL, a local
// model priced at $3/$15 per million): two responses, one bash call.
const SID = '01a16db4-480d-7479-b569-a73ead9bcc3b';
const PI_FRAMES = [
  { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'worker-pi', session_id: SID },
  { hook_event_name: 'CostSample', model: 'mock/mock-1', input: 1200, output: 80, cache_read: 0, cache_creation: 0, usd: 0.0048000000000000004, agent_id: 'worker-pi', session_id: SID },
  { hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'echo pi-usage-probe' }, agent_id: 'worker-pi', session_id: SID },
  { hook_event_name: 'PostToolUse', tool_name: 'bash', tool_input: { command: 'echo pi-usage-probe' }, agent_id: 'worker-pi', session_id: SID },
  { hook_event_name: 'CostSample', model: 'mock/mock-1', input: 2400, output: 40, cache_read: 0, cache_creation: 0, usd: 0.0078, agent_id: 'worker-pi', session_id: SID },
  { hook_event_name: 'Stop', agent_id: 'worker-pi', session_id: SID }
];

/** What HookServer.handle does with each frame; returns the ledger rows. */
function replay(tr, frames, ts) {
  const rows = [];
  for (const f of frames) {
    tr.noteEvent(f.agent_id, f.hook_event_name, f.tool_name, ts);
    if (f.hook_event_name === 'CostSample') {
      const s = tr.addCost(f.agent_id, f.session_id, { input: f.input, output: f.output, cacheRead: f.cache_read, cacheCreation: f.cache_creation, model: f.model, usd: f.usd }, ts);
      rows.push(JSON.stringify({ agent_id: s.agentId, session_id: s.sessionId, ts: s.ts, input: s.input, output: s.output, cache_read: s.cacheRead, cache_creation: s.cacheCreation, model: s.model, usd: s.usd }));
    }
  }
  return rows;
}

async function folded(rows) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-hookusage-')), 'cost-ledger.jsonl');
  fs.writeFileSync(p, rows.join('\n') + '\n');
  const t = new CostLedgerTotals();
  await t.refreshFully(p);
  return t;
}

test('a Pi agent that worked shows its tokens, cost, last tool and last seen in fleet.json', async () => {
  const tr = new HookUsageTracker();
  const rows = replay(tr, PI_FRAMES, 1000);
  const ledger = await folded(rows);
  const fu = fleetUsage({ live: undefined, hook: tr.usageFor('worker-pi'), spanTool: null, activity: tr.activityFor('worker-pi'), lifetimeUsd: ledger.has('worker-pi') ? ledger.usdFor('worker-pi') : null, now: 5000 });
  assert.deepEqual(fu, { tokens: 3720, usd: 0.0126, sessionUsd: 0.0126, lastTool: 'bash', lastActiveSecAgo: 4 });
});

test('the ledger gets a running total per session, so the lifetime fold sums every response', async () => {
  const tr = new HookUsageTracker();
  const rows = replay(tr, PI_FRAMES, 1000);
  assert.deepEqual(rows.map((r) => JSON.parse(r).usd), [0.0048000000000000004, 0.0126]);
  assert.equal(Number((await folded(rows)).usdFor('worker-pi').toFixed(4)), 0.0126);
  // One row per response (how they were written before) folds to the biggest
  // single response, not the sum: the reason rows are now running totals.
  const perResponse = PI_FRAMES.filter((f) => f.hook_event_name === 'CostSample')
    .map((f) => JSON.stringify({ agent_id: 'worker-pi', session_id: SID, usd: f.usd }));
  assert.equal((await folded(perResponse)).usdFor('worker-pi'), 0.0078);
});

test('an app restart under the same session reads as a reset, not lost spend', async () => {
  const before = new HookUsageTracker();
  const after = new HookUsageTracker(); // the app restarted: counters at zero
  const rows = [...replay(before, PI_FRAMES, 1000), ...replay(after, PI_FRAMES, 2000)];
  assert.equal(Number((await folded(rows)).usdFor('worker-pi').toFixed(4)), 0.0252);
});

test('sessions add up per agent and agents stay apart', () => {
  const tr = new HookUsageTracker();
  tr.addCost('a', 's1', { input: 10, output: 1, usd: 0.1, model: 'm1' }, 1);
  tr.addCost('a', 's2', { input: 5, output: 2, cacheRead: 3, usd: 0.2, model: 'm2' }, 2);
  tr.addCost('b', 's3', { input: 100 }, 3);
  const a = tr.usageFor('a');
  assert.equal(a.input + a.output + a.cacheRead, 21);
  assert.equal(Number(a.usd.toFixed(4)), 0.3);
  assert.equal(a.sessionId, 's2');
  assert.equal(a.model, 'm2');
  assert.equal(tr.usageFor('b').input, 100);
  assert.equal(tr.usageFor('nobody'), null);
});

test('activity: any real hook event is a sign of life; the last tool sticks across non-tool events', () => {
  const tr = new HookUsageTracker();
  tr.noteEvent('a', 'Status', undefined, 50);
  tr.noteEvent('a', 'Notification', undefined, 60);
  assert.equal(tr.activityFor('a'), null, 'a status tick or a "waiting for you" is not work');
  tr.noteEvent('a', 'PreToolUse', 'Edit', 100);
  tr.noteEvent('a', 'Stop', undefined, 200);
  assert.deepEqual(tr.activityFor('a'), { ts: 200, lastTool: 'Edit' });
});

test('an engine that reported nothing is null in fleet.json, not 0', () => {
  assert.deepEqual(fleetUsage({ lifetimeUsd: null, now: 1000 }),
    { tokens: null, usd: null, sessionUsd: null, lastTool: null, lastActiveSecAgo: null });
  // Seen working (hooks) but no usage reported: last seen and tool, usage still unknown.
  assert.deepEqual(fleetUsage({ activity: { ts: 1000, lastTool: 'read' }, lifetimeUsd: null, now: 3000 }),
    { tokens: null, usd: null, sessionUsd: null, lastTool: 'read', lastActiveSecAgo: 2 });
});

test('Claude\'s live OTel sample and spans keep priority; the ledger\'s lifetime figure wins for usd', () => {
  const live = { input: 100, output: 10, cacheRead: 0, cacheCreation: 0, usd: 0.5, ts: 9000 };
  const hook = { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, usd: 9, ts: 1000 };
  assert.deepEqual(fleetUsage({ live, hook, spanTool: 'Bash', activity: { ts: 9500, lastTool: 'Read' }, lifetimeUsd: 2.25, now: 10000 }),
    { tokens: 110, usd: 2.25, sessionUsd: 0.5, lastTool: 'Bash', lastActiveSecAgo: 1 });
});

test('main wires it: CostSample rows go through the tracker, fleet.json through fleetUsage, the roster says "not reported"', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(read('src/main/hooks.ts'), /this\.hive\.appendCostLedger\(this\.usage\.addCost\(agentId, p\.session_id,/);
  assert.match(read('src/main/hooks.ts'), /if \(agentId\) this\.usage\.noteEvent\(agentId, event, p\.tool_name\);/);
  assert.match(read('src/main/index.ts'), /hook: hookServer\.usage\.usageFor\(id\)/);
  assert.match(read('src/main/hive.ts'), /if \(a\.tokens === null && a\.usd === null\) bits\.push\('usage not reported'\);/);
});
