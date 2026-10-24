'use strict';
// The hive root keeps a real, empty .mcp.json. Claude Code's sandbox protects
// that file in every folder a sandboxed command may write; when it is missing,
// each Bash call creates a placeholder and removes it, and with every agent
// allowed to write the hive root one agent's cleanup broke another's mount
// ("bwrap: Can't get type of source …/hive/.mcp.json").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');

function hive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md mcp-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, root: path.join(home, 'hive'), h: new HiveManager(() => home) };
}

test('bootstrap writes a .mcp.json that declares no servers, kept out of the hive repo', (t) => {
  const { h, root } = hive(t);
  h.ensureHive();
  const file = path.join(root, '.mcp.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: {} });
  assert.ok(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').includes('.mcp.json'));
});

test('an empty placeholder left by a sandbox is filled in; a real file is kept', (t) => {
  const { h, root } = hive(t);
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, '.mcp.json');
  fs.writeFileSync(file, '');
  h.ensureHive();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mcpServers: {} });

  const { h: h2, root: root2 } = hive(t);
  fs.mkdirSync(root2, { recursive: true });
  const mine = '{"mcpServers":{"x":{"command":"y"}}}';
  fs.writeFileSync(path.join(root2, '.mcp.json'), mine);
  h2.ensureHive();
  assert.equal(fs.readFileSync(path.join(root2, '.mcp.json'), 'utf8'), mine);
});

test('the MCP scan finds nothing in it', (t) => {
  const { h, root } = hive(t);
  h.ensureHive();
  const { McpServers } = loadTs('src/main/mcpServers.ts');
  const scan = new McpServers({
    homes: () => [],
    agentPlaces: () => [{ name: 'hive', cwd: root }],
    readFile: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
    readCustom: () => [],
    getSecret: () => undefined
  });
  assert.deepEqual(scan.scanAgents(), []);
});
