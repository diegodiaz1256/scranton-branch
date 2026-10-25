'use strict';
// Your MCP servers and the ones set up for other tools (src/main/mcpServers.ts):
// found across configs, imported with their keys moved out of agents' reach.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { McpServers, parseCodexToml, looksSecret } = loadTs('src/main/mcpServers.ts');

const HOME = path.join('X:', 'home');
const APPDATA = path.join('X:', 'appdata');
const files = {
  [path.join(HOME, '.claude.json')]: JSON.stringify({
    mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abc123SECRET', LOG_LEVEL: 'info' } } },
    projects: { 'G:/work/shop': { mcpServers: { postgres: { command: 'uvx', args: ['postgres-mcp'], env: { DATABASE_URI: 'postgres://u:pw@db/shop' } } } } }
  }),
  [path.join(APPDATA, 'Claude', 'claude_desktop_config.json')]: JSON.stringify({ mcpServers: { fetch: { command: 'uvx', args: ['mcp-server-fetch'] } } }),
  [path.join(HOME, '.cursor', 'mcp.json')]: JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer lin_api_x' } } } }),
  [path.join(HOME, '.codex', 'config.toml')]: [
    'model = "gpt-6"',
    '[mcp_servers.sentry]',
    'command = "npx"',
    'args = ["-y", "@sentry/mcp-server"]',
    'env = { SENTRY_AUTH_TOKEN = "sntrys_xyz", SENTRY_HOST = "sentry.io" }',
    '[mcp_servers.docs]',
    'url = "https://docs.example.com/mcp"'
  ].join('\n')
};

function make() {
  let custom = [];
  const secrets = new Map();
  const m = new McpServers({
    readFile: (p) => files[p] ?? null, home: HOME, appData: () => APPDATA,
    readCustom: () => custom, writeCustom: (c) => { custom = c; },
    getSecret: (r) => secrets.get(r), setSecret: (r, v) => { secrets.set(r, v); return { ok: true }; }, deleteSecret: (r) => secrets.delete(r)
  });
  return { m, secrets, get custom() { return custom; } };
}

test('finds servers across Claude Code (user + project), Claude Desktop, Cursor and Codex', () => {
  const { m } = make();
  const found = m.scan().map((f) => `${f.source}:${f.name}:${f.transport.kind}`);
  assert.deepEqual(found.sort(), [
    'Claude Code (shop):postgres:stdio', 'Claude Code:github:stdio', 'Claude Desktop:fetch:stdio',
    'Codex:docs:http', 'Codex:sentry:stdio', 'Cursor:linear:http'
  ].sort());
});

test('the UI listing never carries a secret-looking value', () => {
  const { m } = make();
  const ui = JSON.stringify(m.scanForUi());
  for (const v of ['ghp_abc123SECRET', 'postgres://u:pw@db/shop', 'sntrys_xyz', 'lin_api_x']) assert.ok(!ui.includes(v), v);
  assert.ok(ui.includes('"value":"info"'), 'plain values stay visible');
});

test('importing moves keys to the store and the server behind the gateway', () => {
  const s = make();
  const r = s.m.import('Claude Code', 'github');
  assert.equal(r.ok, true, r.error);
  const saved = s.custom[0];
  assert.deepEqual(saved.secretEnv, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
  assert.deepEqual(saved.env, { LOG_LEVEL: 'info' });
  assert.ok(!JSON.stringify(s.custom).includes('ghp_abc123'), 'config has no key');
  const forAgent = s.m.forAgent('god');
  assert.deepEqual(forAgent.gateway, [r.id], 'a keyed server goes through the gateway');
  assert.deepEqual(forAgent.plain, {});
  assert.equal(s.m.launchSpec(r.id).env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_abc123SECRET', 'only main gets the key');
});

test('a server with no secrets is handed to agents as is; scope limits who gets it', () => {
  const s = make();
  const { id } = s.m.import('Claude Desktop', 'fetch');
  assert.deepEqual(s.m.forAgent('god').plain[id], { command: 'uvx', args: ['mcp-server-fetch'] });
  s.m.setAgents(id, ['pam']);
  assert.equal(s.m.forAgent('god').plain[id], undefined);
  assert.ok(s.m.forAgent('pam').plain[id]);
});

test('a remote server with a key header is imported behind the gateway, the key in the store', () => {
  const s = make();
  const r = s.m.import('Cursor', 'linear');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(s.custom[0].secretHeaders, ['Authorization']);
  assert.ok(!JSON.stringify(s.custom).includes('lin_api_x'), 'config has no key');
  assert.deepEqual(s.m.forAgent('god'), { gateway: [r.id], plain: {} }, 'never handed over with the key');
  assert.deepEqual(s.m.remoteSpec(r.id), { url: 'https://mcp.linear.app/sse', headers: { Authorization: 'Bearer lin_api_x' } }, 'only main gets the key');
  assert.equal(s.m.launchSpec(r.id), null);
  assert.deepEqual(s.m.listCustom()[0].headersStored, { Authorization: true });
  s.m.remove(r.id);
  assert.equal(s.secrets.size, 0, 'removing it deletes the key');
});

test('a remote server with only plain headers is handed over as is', () => {
  const s = make();
  const r = s.m.save({ name: 'docs', transport: { kind: 'http', url: 'https://docs.example.com/mcp' }, env: {}, headers: { 'X-Tenant': 'acme', 'Content-Type': 'text/plain' } }, []);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(s.m.forAgent('god').plain[r.id], { type: 'http', url: 'https://docs.example.com/mcp', headers: { 'X-Tenant': 'acme' } }, 'reserved headers are dropped');
});

test('editing a remote server keeps a stored header key when left empty, and drops it when no longer secret', () => {
  const s = make();
  const { id } = s.m.import('Cursor', 'linear');
  s.m.save({ id, name: 'linear', transport: { kind: 'http', url: 'https://mcp.linear.app/sse' }, env: {}, headers: { Authorization: '' } }, [], ['Authorization']);
  assert.equal(s.m.remoteSpec(id).headers.Authorization, 'Bearer lin_api_x');
  s.m.save({ id, name: 'linear', transport: { kind: 'http', url: 'https://mcp.linear.app/sse' }, env: {}, headers: {} }, [], []);
  assert.equal(s.secrets.size, 0);
  assert.equal(s.custom[0].secretHeaders, undefined);
});

test('codex TOML reader and secret detection', () => {
  const found = parseCodexToml(files[path.join(HOME, '.codex', 'config.toml')], 'c');
  assert.deepEqual(found[0].env, { SENTRY_AUTH_TOKEN: 'sntrys_xyz', SENTRY_HOST: 'sentry.io' });
  assert.equal(looksSecret('SENTRY_HOST', 'sentry.io'), false);
  assert.equal(looksSecret('X', 'sk-live-whatever'), true);
});

test('the hive hands an imported keyed server out through the gateway, the key nowhere in it', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-custom-mcp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const s = make();
  const gh = s.m.import('Claude Code', 'github').id;
  const fetchId = s.m.import('Claude Desktop', 'fetch').id;
  const hive = new HiveManager(() => home);
  hive.setCustomMcp((agentId) => s.m.forAgent(agentId));
  hive.setMcpGateway((_agentId, ids) => ({ url: 'http://127.0.0.1:5555', token: `cap:${ids.join(',')}` }));
  const { servers, env } = hive.buildDefaultMcpServers(home, {}, undefined, 'dwight');
  assert.deepEqual(servers[`munder-${gh}`], { type: 'http', url: `http://127.0.0.1:5555/mcp/${gh}`, headers: { Authorization: 'Bearer ${SB_MCP_TOKEN}' } });
  assert.deepEqual(servers[`munder-${fetchId}`], { command: 'uvx', args: ['mcp-server-fetch'] });
  assert.equal(env.SB_MCP_TOKEN, `cap:${gh}`);
  assert.equal(env.MD_MCP_TOKEN, `cap:${gh}`, 'the old name too, for a session started before the rename');
  assert.ok(!JSON.stringify({ servers, env }).includes('ghp_abc123'));
});
