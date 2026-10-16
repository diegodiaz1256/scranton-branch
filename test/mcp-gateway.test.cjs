'use strict';
/**
 * The MCP gateway runs a keyed server under MAIN with its key, and relays
 * MCP-over-HTTP to it for agents holding a capability token. The agent side of
 * these tests is a plain HTTP client, standing in for the agent's CLI: it must
 * be able to use the tool and must never receive the key.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { McpGateway } = loadTs('src/main/mcpGateway.ts');

const KEY = 'sntryu_REAL_KEY_must_not_cross';

// A stdio MCP server that proves it holds the key without ever sending it.
const SERVER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    let result;
    if (m.method === 'initialize') result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
    else if (m.method === 'tools/list') result = { tools: [{ name: 'has_key', inputSchema: { type: 'object' } }] };
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'key length ' + (process.env.FAKE_KEY || '').length + ', pid ' + process.pid }] };
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'nope' } }) + '\\n'); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});
`;

async function gateway(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-gw-'));
  const script = path.join(dir, 'server.cjs');
  fs.writeFileSync(script, SERVER);
  const gw = new McpGateway({
    resolveSpec: (id) => (id === 'sentry' ? { command: process.execPath, args: [script], env: { FAKE_KEY: KEY } } : null),
    requestTimeoutMs: 5000
  });
  assert.equal((await gw.start()).ok, true);
  t.after(() => { gw.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return gw;
}

async function rpc(gw, token, server, body, method = 'POST') {
  const res = await fetch(`${gw.url()}/mcp/${server}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

const init = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });

test('an agent with a capability uses the tool; the key never crosses', async (t) => {
  const gw = await gateway(t);
  const token = gw.grant('dwight', ['sentry']);
  const a = await rpc(gw, token, 'sentry', init());
  assert.equal(a.status, 200);
  assert.equal(a.json.result.serverInfo.name, 'fake');
  assert.equal((await rpc(gw, token, 'sentry', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc(gw, token, 'sentry', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.json.result.tools[0].name, 'has_key');
  const call = await rpc(gw, token, 'sentry', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'has_key', arguments: {} } });
  assert.match(call.json.result.content[0].text, new RegExp(`key length ${KEY.length}`), 'the server holds the key');
  for (const r of [a, list, call]) assert.ok(!r.text.includes(KEY), 'the key is never in a response');
});

test('no token, a wrong token, or a server outside the grant are refused', async (t) => {
  const gw = await gateway(t);
  const token = gw.grant('dwight', ['sentry']);
  assert.equal((await rpc(gw, null, 'sentry', init())).status, 401);
  assert.equal((await rpc(gw, 'forged', 'sentry', init())).status, 401);
  assert.equal((await rpc(gw, token, 'github-token', init())).status, 403);
  assert.equal((await rpc(gw, token, 'sentry', null, 'GET')).status, 405, 'no SSE stream (spec-allowed)');
});

test('unknown methods pass through as JSON-RPC errors; a re-initialize starts a fresh server', async (t) => {
  const gw = await gateway(t);
  const token = gw.grant('dwight', ['sentry']);
  const probe = await rpc(gw, token, 'sentry', { jsonrpc: '2.0', id: 'p', method: 'server/discover' });
  assert.equal(probe.json.error.code, -32601);
  await rpc(gw, token, 'sentry', init(1));
  const pid1 = (await rpc(gw, token, 'sentry', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })).json.result.content[0].text.split('pid ')[1];
  await rpc(gw, token, 'sentry', init(3));
  const pid2 = (await rpc(gw, token, 'sentry', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} })).json.result.content[0].text.split('pid ')[1];
  assert.notEqual(pid1, pid2);
});

test('revoking (agent stopped) or re-granting (respawn) kills the old capability', async (t) => {
  const gw = await gateway(t);
  const first = gw.grant('dwight', ['sentry']);
  assert.equal((await rpc(gw, first, 'sentry', init())).status, 200);
  const second = gw.grant('dwight', ['sentry']);
  assert.equal((await rpc(gw, first, 'sentry', init())).status, 401, 'a respawn retires the old token');
  assert.equal((await rpc(gw, second, 'sentry', init())).status, 200);
  gw.revoke('dwight');
  assert.equal((await rpc(gw, second, 'sentry', init())).status, 401);
});

test('a server that cannot start answers with an error instead of hanging', async (t) => {
  const gw = await gateway(t);
  const token = gw.grant('dwight', ['sentry', 'notion']);
  const r = await rpc(gw, token, 'notion', init());
  assert.equal(r.status, 200);
  assert.match(r.json.error.message, /cannot start/);
});

// A remote MCP server that wants a key in a header. It answers initialize as
// JSON and everything else as an SSE stream, with a stray notification first.
async function remote(t, key = KEY) {
  const http = require('node:http');
  const seen = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, headers: req.headers });
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(200); res.end(); return; }
    const m = JSON.parse(body);
    if (m.id === undefined) { res.writeHead(202); res.end(); return; }
    if (m.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } } }));
      return;
    }
    const result = m.method === 'tools/list'
      ? { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] }
      : { content: [{ type: 'text', text: `session ${req.headers['mcp-session-id']}, version ${req.headers['mcp-protocol-version']}` }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`);
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n\n`);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/mcp`;
  const gw = new McpGateway({
    resolveSpec: (id) => (id === 'brain' ? { url, headers: { Authorization: `Bearer ${key}` } } : id === 'stale' ? { url, headers: { Authorization: 'Bearer old' } } : null),
    requestTimeoutMs: 5000
  });
  assert.equal((await gw.start()).ok, true);
  t.after(() => { gw.stop(); srv.close(); });
  return { gw, seen };
}

test('a remote server gets its key header from the gateway; the agent never sees it', async (t) => {
  const { gw, seen } = await remote(t);
  const token = gw.grant('dwight', ['brain']);
  const a = await rpc(gw, token, 'brain', init());
  assert.equal(a.json.result.serverInfo.name, 'remote');
  assert.equal((await rpc(gw, token, 'brain', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await rpc(gw, token, 'brain', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(list.json.result.tools[0].name, 'whoami', 'the answer is read out of the SSE stream');
  const call = await rpc(gw, token, 'brain', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  assert.equal(call.json.result.content[0].text, 'session sess-1, version 2025-06-18', 'session id and protocol version are carried');
  for (const r of [a, list, call]) assert.ok(!r.text.includes(KEY), 'the key is never in a response');
  assert.ok(seen.every((s) => s.headers.authorization === `Bearer ${KEY}`), 'every upstream call carries the key');
  gw.revoke('dwight');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen.at(-1).method, 'DELETE', 'ending the agent ends the upstream session');
});

test('a remote server refusing the stored key answers with a readable error', async (t) => {
  const { gw } = await remote(t);
  const token = gw.grant('dwight', ['stale']);
  const r = await rpc(gw, token, 'stale', init());
  assert.equal(r.status, 200);
  assert.match(r.json.error.message, /refused the stored key \(HTTP 401\)/);
});
