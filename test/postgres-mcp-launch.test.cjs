'use strict';
/**
 * The Database connection runs `uvx postgres-mcp`. Its latest release pins a
 * pglast that PyPI no longer has, so without overrides uv installs 0.1.0, which
 * crashes on start under mcp 2.x. The catalog carries uv overrides and the
 * gateway hands them to uvx through UV_OVERRIDE.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { mcpCatalogEntry } = loadTs('src/shared/mcpCatalog.ts');
const { McpGateway, uvOverrideEnv } = loadTs('src/main/mcpGateway.ts');

test('the Database server installs with a pglast that exists and mcp 1.x', () => {
  const o = mcpCatalogEntry('db').spec.uvOverrides;
  assert.ok(o.some((l) => /^pglast>=7\.20/.test(l)), 'pglast override');
  assert.ok(o.includes('mcp<2'), 'mcp kept below 2');
});

test('uvOverrideEnv writes the lines to a file and points UV_OVERRIDE at it', () => {
  assert.deepEqual(uvOverrideEnv(undefined), {});
  assert.deepEqual(uvOverrideEnv([]), {});
  const env = uvOverrideEnv(['pglast>=7.20,<8', 'mcp<2']);
  assert.equal(fs.readFileSync(env.UV_OVERRIDE, 'utf8'), 'pglast>=7.20,<8\nmcp<2\n');
});

test('the gateway starts the server with UV_OVERRIDE set', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-uvo-'));
  const script = path.join(dir, 'server.cjs');
  // Answers initialize with the overrides file's content as its name.
  fs.writeFileSync(script, `
process.stdin.on('data', (d) => {
  const m = JSON.parse(String(d).split('\\n')[0]);
  const name = require('fs').readFileSync(process.env.UV_OVERRIDE, 'utf8');
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name, version: '1' } } }) + '\\n');
});`);
  const gw = new McpGateway({
    resolveSpec: () => ({ command: process.execPath, args: [script], env: {}, uvOverrides: ['pglast>=7.20,<8', 'mcp<2'] }),
    requestTimeoutMs: 5000
  });
  await gw.start();
  t.after(() => { gw.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const token = gw.grant('dwight', ['db']);
  const res = await fetch(`${gw.url()}/mcp/db`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
  });
  assert.equal((await res.json()).result.serverInfo.name, 'pglast>=7.20,<8\nmcp<2\n');
});
