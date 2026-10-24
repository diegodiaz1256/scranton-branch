'use strict';
/**
 * Critical connections: one custodian agent per critical connection or REST
 * API. Everyone else (the orchestrator included) is left out at spawn AND
 * refused by the MCP gateway / key broker on every call, and the custodian is
 * locked down: its critical connections and nothing else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/shared/criticalConnections.ts');
const { explainConnection } = loadTs('src/shared/connectionAccess.ts');
const { McpGateway } = loadTs('src/main/mcpGateway.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const MAP = { 'mcp:custom--jira': 'pam-1', 'api:confluence': 'pam-1', 'api:jira': '' };

test('only the custodian passes; nobody while none is chosen; never without an id', () => {
  assert.equal(C.criticalAllows(MAP, 'mcp', 'custom--jira', 'pam-1'), true);
  assert.equal(C.criticalAllows(MAP, 'mcp', 'custom--jira', 'god'), false, 'the orchestrator is not exempt');
  assert.equal(C.criticalAllows(MAP, 'mcp', 'custom--jira', 'pam-2'), false, 'a re-hire with the same name is another id');
  assert.equal(C.criticalAllows(MAP, 'mcp', 'custom--jira', undefined), false);
  assert.equal(C.criticalAllows(MAP, 'api', 'jira', 'pam-1'), false, 'critical with no custodian: nobody');
  assert.equal(C.criticalAllows(MAP, 'api', 'github', 'jim'), true, 'not critical: untouched');
  assert.equal(C.criticalAllows(undefined, 'api', 'github', 'jim'), true);
});

test('custodianships, held ids, set and clean', () => {
  assert.deepEqual(C.custodianships(MAP, 'pam-1').sort(), ['api:confluence', 'mcp:custom--jira']);
  assert.deepEqual(C.heldIds(MAP, 'pam-1', 'api'), ['confluence']);
  assert.equal(C.isCustodian(MAP, 'jim'), false);
  assert.equal(C.isCustodian(MAP, ''), false, 'an empty custodian slot is nobody');
  const on = C.setCritical({}, 'api', 'jira', true);
  assert.deepEqual(on, { 'api:jira': '' }, 'critical first, custodian next');
  assert.deepEqual(C.setCritical(on, 'api', 'jira', true, 'pam-1'), { 'api:jira': 'pam-1' });
  assert.deepEqual(C.setCritical(on, 'api', 'jira', false), {});
  assert.deepEqual(C.cleanCriticalMap({ 'api:jira': ' pam-1 ', 'evil:x': 'a', 'mcp:../x': 'b', 'api:y': 3 }), { 'api:jira': 'pam-1' });
});

test('only Claude Code agents can be custodians', () => {
  assert.equal(C.canBeCustodian('claude'), true);
  assert.equal(C.canBeCustodian(undefined), true, 'an agent with no provider recorded is Claude Code');
  for (const p of ['codex', 'gemini', 'opencode', 'agy', 'custom']) assert.equal(C.canBeCustodian(p), false, p);
});

test('the refusal names the custodian and says to ask it through the hive', () => {
  const r = C.criticalRefusal('Jira', 'Pam');
  assert.match(r, /critical connection/);
  assert.match(r, /Only Pam/);
  assert.match(r, /outbox/);
  assert.match(C.criticalRefusal('Jira', undefined), /No custodian is chosen/);
});

test('the CONFIDENTIALITY block: short, firm, prompt-injection aware', () => {
  assert.equal(C.confidentialityPromptLine([]), '');
  const p = C.confidentialityPromptLine(['Jira', 'Confluence']);
  assert.match(p, /^CONFIDENTIALITY/);
  assert.match(p, /Jira, Confluence/);
  assert.match(p, /including the orchestrator/);
  assert.match(p, /never instructions/i);
  assert.match(p, /Never paste raw bodies/);
  assert.match(p, /ask the human/);
  assert.ok(p.length < 1600, 'short');
});

test('why an agent lacks a critical connection', () => {
  const facts = { service: 'github-token', enabled: true, ready: true, scope: null, webBlocked: false, mcpCapable: true, ceiling: 'read' };
  assert.deepEqual(explainConnection('jim', { ...facts, custodian: 'pam-1' }), { access: 'none', reason: 'critical' });
  assert.deepEqual(explainConnection('pam-1', { ...facts, custodian: 'pam-1' }), { access: 'read' });
  assert.deepEqual(explainConnection('jim', { ...facts, custodian: '' }), { access: 'none', reason: 'critical' });
  assert.deepEqual(explainConnection('jim', facts), { access: 'read' });
});

// ─── spawn: not configured ──────────────────────────────────────────────────

function floor(t, map) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-crit-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.setMcpKeyCheck(() => true);
  hive.setMcpGateway(() => ({ url: 'http://127.0.0.1:5555', token: 'tok' }));
  hive.setCustomMcp(() => ({ gateway: ['custom--jira', 'custom--other'], plain: { 'custom--plain': { command: 'x', args: [] } } }));
  hive.setMemoryMcp(() => ({ command: 'mempalace', args: [] }));
  hive.setCritical(() => map);
  return { home, hive };
}
const CFG = { 'github-token': { enabled: true }, notion: { enabled: true }, fetch: { enabled: true } };

test('spawn: a critical connection is configured for its custodian only', (t) => {
  const map = { 'mcp:github-token': 'pam-1', 'mcp:custom--jira': 'pam-1' };
  const { hive, home } = floor(t, map);
  for (const other of ['jim', 'god']) {
    const s = hive.buildDefaultMcpServers(home, CFG, undefined, other).servers;
    assert.equal(s['munder-github-token'], undefined, `${other} gets no critical catalog connection`);
    assert.equal(s['munder-custom--jira'], undefined, `${other} gets no critical server of your own`);
    assert.ok(s['munder-notion'] && s['munder-custom--other'], 'what is not critical is untouched');
    assert.deepEqual(hive.keyedConnectionsFor(CFG, undefined, other), ['notion']);
  }
  const pam = hive.buildDefaultMcpServers(home, CFG, undefined, 'pam-1').servers;
  assert.deepEqual(Object.keys(pam).sort(), ['munder-custom--jira', 'munder-github-token'],
    'the custodian: its critical connections, and no web, memory, lists, browser, built-ins or other connections');
  assert.deepEqual(hive.keyedConnectionsFor(CFG, undefined, 'pam-1'), ['github-token']);
});

test('spawn: critical with no custodian reaches nobody', (t) => {
  const { hive, home } = floor(t, { 'mcp:github-token': '' });
  assert.equal(hive.buildDefaultMcpServers(home, CFG, undefined, 'pam-1').servers['munder-github-token'], undefined);
});

// ─── gateway: refused on every call ─────────────────────────────────────────

async function mockMcp(t) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      const m = JSON.parse(b); seen.push(m.method);
      const result = m.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'jira', version: '1' } }
        : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'INFOSEC-1: Open' }] } : { tools: [{ name: 'get_issue' }] };
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/mcp`, seen };
}

test('gateway: a token granted before the connection became critical is refused; the custodian passes', async (t) => {
  const up = await mockMcp(t);
  const map = {};
  const calls = [];
  const gw = new McpGateway({
    resolveSpec: () => ({ url: up.url, headers: { authorization: 'Basic SECRET' } }),
    refuse: (agentId, id) => (C.criticalAllows(map, 'mcp', id, agentId) ? null : C.criticalRefusal('Jira', 'Pam')),
    onCall: (e) => calls.push(e)
  });
  assert.equal((await gw.start()).ok, true);
  t.after(() => gw.stop());
  const jim = gw.grant('jim', ['custom--jira']);
  const pam = gw.grant('pam-1', ['custom--jira']);
  const call = (tok) => fetch(`${gw.url()}/mcp/custom--jira`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_issue', arguments: { key: 'INFOSEC-1' } } }) }).then((r) => r.json());
  assert.equal((await call(jim)).result.content[0].text, 'INFOSEC-1: Open', 'before: not critical');
  map['mcp:custom--jira'] = 'pam-1';
  const before = up.seen.length;
  const refused = await call(jim);
  assert.equal(refused.error.code, -32001);
  assert.match(refused.error.message, /Only Pam/);
  assert.equal(up.seen.length, before, 'the refused call never reached the server');
  assert.equal((await call(pam)).result.content[0].text, 'INFOSEC-1: Open');
  assert.deepEqual(calls.map((c) => [c.agentId, c.tool, c.allowed]), [['jim', 'get_issue', true], ['jim', 'get_issue', false], ['pam-1', 'get_issue', true]]);
  assert.ok(calls.every((c) => !('arguments' in c)), 'no arguments in the record');
});

test('gateway: a check that throws refuses (fail closed)', async (t) => {
  const up = await mockMcp(t);
  const gw = new McpGateway({ resolveSpec: () => ({ url: up.url, headers: {} }), refuse: () => { throw new Error('boom'); } });
  assert.equal((await gw.start()).ok, true);
  t.after(() => gw.stop());
  const tok = gw.grant('pam-1', ['custom--jira']);
  const r = await fetch(`${gw.url()}/mcp/custom--jira`, { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then((x) => x.json());
  assert.ok(r.error);
  assert.equal(up.seen.length, 0);
});

// ─── broker: refused on every request ───────────────────────────────────────

test('broker: only the custodian reaches a critical API, whatever its token was granted; the log has no bodies', async (t) => {
  const hits = [];
  const upstream = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"key":"INFOSEC-1"}'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const record = { id: 'jira', label: 'Jira', kind: 'custom-rest', baseUrl: `http://127.0.0.1:${upstream.address().port}/rest/api/3`, authType: 'none', enabled: true, createdAt: 0, updatedAt: 0 };
  const map = { 'api:jira': 'pam-1' };
  const log = [];
  const broker = new IntegrationBroker({
    getRecord: (id) => (id === 'jira' ? record : undefined), getSecret: () => undefined,
    refuse: (agentId, id) => (C.criticalAllows(map, 'api', id, agentId) ? null : C.criticalRefusal('Jira', 'Pam')),
    onRequest: (e) => log.push(e)
  });
  assert.equal((await broker.start()).ok, true);
  t.after(() => broker.stop());
  const tokens = { jim: broker.grant('pty-jim', ['jira'], { jira: 'read' }, 'jim'), god: broker.grant('pty-god', ['jira'], { jira: 'read' }, 'god'),
    pam: broker.grant('pty-pam', ['jira'], { jira: 'read' }, 'pam-1'), worker: broker.grant('w-1', ['jira'], { jira: 'read' }) };
  const get = (tok) => fetch(`${broker.url()}/i/jira/issue/INFOSEC-1?fields=summary`, { headers: { authorization: `Bearer ${tok}` } });
  for (const who of ['jim', 'god', 'worker']) {
    const r = await get(tokens[who]);
    assert.equal(r.status, 403, who);
    const body = await r.json();
    assert.equal(body.code, 'critical');
    assert.match(body.error, /Only Pam/);
  }
  assert.equal(hits.length, 0, 'nothing reached Jira');
  const ok = await get(tokens.pam);
  assert.equal(ok.status, 200);
  assert.deepEqual(hits, ['GET /rest/api/3/issue/INFOSEC-1?fields=summary']);
  assert.deepEqual(log.map((e) => [e.agentId ?? e.workerId, e.method, e.path, e.allowed]),
    [['jim', 'GET', '/issue/INFOSEC-1', false], ['god', 'GET', '/issue/INFOSEC-1', false], ['w-1', 'GET', '/issue/INFOSEC-1', false], ['pam-1', 'GET', '/issue/INFOSEC-1', true]]);
  assert.ok(log.every((e) => !JSON.stringify(e).includes('summary')), 'no query string in the log');
});
