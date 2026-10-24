'use strict';
/**
 * Agents searched the whole disk for things the office has: Michael grepped
 * Scranton Branch's own source on another drive to find the hire-manifest
 * format, and hunted a runner added after he started. Codex/OpenCode agents
 * were told to use munder-* MCP tools nobody had wired for them.
 *
 * Every agent now gets one map of the office with absolute paths and a rule
 * against hunting; the orchestrator gets the hire format; tools are only
 * promised to the CLIs that have them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function spawn(t, meta, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-map-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ cwd: home, ...meta }, { semanticMemory: true, ...opts });
  const i = inj.args.indexOf('--append-system-prompt');
  const prompt = i >= 0 ? inj.args[i + 1] : inj.args[inj.args.length - 1];
  return { prompt, root: path.join(home, 'hive') };
}

test('every agent gets the office map with absolute paths and the no-hunting rule', async (t) => {
  for (const provider of ['claude', 'codex']) {
    const { prompt, root } = await spawn(t, { id: 'jim', name: 'Jim', provider });
    assert.match(prompt, /WHERE THINGS ARE/, provider);
    for (const f of ['tasks.json', 'board.md', 'registry.json', 'research', 'lists']) {
      assert.ok(prompt.includes(path.join(root, f)), `${provider}: ${f} by full path`);
    }
    assert.ok(prompt.includes(path.join(root, 'bin', 'md-run.cjs')), `${provider}: runners`);
    assert.match(prompt, /source code: if something is not here/, provider);
    assert.match(prompt, /ask god instead of hunting/, provider);
  }
});

test('the runner command is there even before any runner exists', async (t) => {
  const { prompt } = await spawn(t, { id: 'jim', name: 'Jim', provider: 'claude' }, { runners: [] });
  assert.match(prompt, /RUNNERS: .*None exist yet; one added later works at once/);
});

test('the orchestrator knows how to propose a permanent hire', async (t) => {
  const { prompt, root } = await spawn(t, { id: 'god', name: 'Michael', provider: 'claude', isGod: true });
  assert.ok(prompt.includes(path.join(root, 'research', 'hires')));
  assert.match(prompt, /"spec":"munder-difflin\/hire@1"/);
  assert.match(prompt, /ask the human instead of hunting/);
  const worker = await spawn(t, { id: 'jim', name: 'Jim', provider: 'claude' });
  assert.doesNotMatch(worker.prompt, /HIRING A PERMANENT EMPLOYEE/);
});

test('MCP tools are only promised where they are wired', async (t) => {
  const claude = await spawn(t, { id: 'jim', name: 'Jim', provider: 'claude' });
  assert.match(claude.prompt, /munder-memory MCP tools/);
  assert.match(claude.prompt, /munder-lists tools/);
  const codex = await spawn(t, { id: 'jim', name: 'Jim', provider: 'codex' });
  assert.doesNotMatch(codex.prompt, /munder-memory|munder-lists/);
  assert.match(codex.prompt, /run `mempalace search/);
  assert.match(codex.prompt, /edit the file in that folder/);
});

test('PROTOCOL.md is a short index; each topic is its own file', async (t) => {
  const { root, prompt } = await spawn(t, { id: 'god', name: 'Michael', provider: 'claude', isGod: true });
  const index = fs.readFileSync(path.join(root, 'PROTOCOL.md'), 'utf8');
  const read = (f) => fs.readFileSync(path.join(root, 'protocol', f), 'utf8');
  assert.ok(index.length < 3500, `the index stays short (${index.length} chars)`);
  assert.match(index, /Open only the topic you need/);
  assert.match(index, /## Where things are — don't search for them/);
  assert.match(index, /Scranton Branch's\s+own installation or source code/);
  // Every topic file exists, is listed in the index under its audience, and is small.
  const { PROTOCOL_DOCS } = loadTs('src/main/protocolDocs.ts');
  const worker = index.slice(index.indexOf('## Every agent'), index.indexOf('## Orchestrator'));
  for (const d of PROTOCOL_DOCS) {
    const body = read(d.file);
    assert.ok(body.length < 2500, `${d.file} is ${body.length} chars`);
    assert.ok(index.includes(`protocol/${d.file}`), `${d.file} in the index`);
    assert.equal(worker.includes(`protocol/${d.file}`), d.who === 'everyone', `${d.file} under its audience`);
  }
  assert.match(read('messages.md'), /"act": "request \| inform/);
  assert.match(read('services.md'), /`bin\/md-run\.cjs` with no arguments/);
  assert.match(read('hire.md'), /"spec": "munder-difflin\/hire@1"/);
  // What a live orchestrator had to guess or got wrong on a WSL floor: the
  // engine names and pi's model form, polling for the spawn, archiving a temp
  // that had already sent its done.
  assert.match(read('spawn.md'), /antigravity \| gemini \| pi \| opencode/);
  assert.match(read('spawn.md'), /pi and opencode: provider\/model/);
  assert.match(read('spawn.md'), /Don't sleep or poll/);
  assert.match(read('spawn.md'), /archives a temp when it sends `done`\*\*: no archive request for that/);
  assert.doesNotMatch(index, /several Claude agents/);
  // The prompt sends agents to the topic, not the whole protocol.
  assert.ok(prompt.includes(path.join(root, 'protocol', 'messages.md')));
  assert.match(prompt, /open only the one you need/);
});

test('md-run with no runners says so instead of printing nothing', async (t) => {
  // Live: a Pi agent ran it, got exit 0 and an empty line, and could not tell
  // "none yet" from a failure.
  const http = require('node:http');
  const { execFile } = require('node:child_process');
  const { root } = await spawn(t, { id: 'jim', name: 'Jim', provider: 'claude' });
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ runners: [] })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const out = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(root, 'bin', 'md-run.cjs')], {
    env: { ...process.env, MD_BROKER_URL: `http://127.0.0.1:${server.address().port}`, MD_BROKER_TOKEN: 't' }
  }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
  assert.match(out, /No runners are set up for you yet/);
});

test('every agent is told where a deliverable goes: one folder per ticket, or a dated topic', async (t) => {
  for (const meta of [{ id: 'jim', name: 'Jim', provider: 'codex' }, { id: 'god', name: 'Michael', provider: 'claude', isGod: true }]) {
    const { prompt, root } = await spawn(t, meta);
    assert.ok(prompt.includes(path.join(root, 'research', '<ticket>')), `${meta.id}: research/<ticket> by full path`);
    assert.match(prompt, /research\/<yyyy-mm-dd>-<topic>/, meta.id);
    assert.match(prompt, /one main document per folder/i, meta.id);
    const services = fs.readFileSync(path.join(root, 'protocol', 'services.md'), 'utf8');
    assert.match(services, /`research\/<ticket>\/`/);
    assert.match(services, /`research\/<yyyy-mm-dd>-<topic>\/`/);
  }
});
