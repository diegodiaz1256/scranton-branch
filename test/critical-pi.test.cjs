'use strict';
/**
 * A pi custodian, locked down by the app rather than by its prompt:
 * - its extension refuses a tool call the office cannot answer (STRICT);
 * - it runs in bubblewrap with no network (md-netgate relays only the app's
 *   loopback services and HTTPS to its model provider), writing only its own
 *   folder and its vaults, with the folders it may not read hidden;
 * - only pi's built-in tools, no MCP; no packages or extensions of the user's;
 *   its pi login is a copy, never a link into the user's own file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HiveManager } = loadTs('src/main/hive.ts');
const { MD_NETGATE, piModelHosts } = loadTs('src/main/netgate.ts');

const pairs = (args, flag) => { const out = []; args.forEach((a, i) => { if (a === flag) out.push(args[i + 1]); }); return out; };
function tmp(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-critpi-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }

test('model hosts: the default provider\'s, and remote custom base URLs; loopback ones are relayed, not proxied', () => {
  assert.deepEqual(piModelHosts('{"defaultProvider":"anthropic"}', null), ['api.anthropic.com']);
  assert.deepEqual(piModelHosts('{"defaultProvider":"mock"}', '{"providers":{"mock":{"baseUrl":"http://127.0.0.1:18191/v1"},"corp":{"baseUrl":"https://llm.corp.example/v1"}}}'), ['llm.corp.example']);
  assert.deepEqual(piModelHosts('not json', '{'), []);
});

test('a pi custodian: netgate around bubblewrap with no network, own folder and vault only, strict guard, built-in tools only', async (t) => {
  const home = tmp(t);
  const userHome = tmp(t);
  fs.mkdirSync(path.join(userHome, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.pi', 'agent', 'auth.json'), '{"anthropic":{"type":"api_key","key":"sk-test"}}');
  fs.writeFileSync(path.join(userHome, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-x', packages: ['npm:evil-ext'], extensions: ['/x'] }));
  const lin = (p) => p.replace(/^([A-Za-z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`).split(path.sep).join('/');
  const hive = new HiveManager(() => home);
  hive.forAgent = lin;
  hive.userHome = () => userHome;
  hive.nodeCommand = () => 'node';
  hive.sandboxAvailable = async () => true;
  hive.existingPaths = async (ps) => ps;
  const dir = path.join(home, 'hive', 'agents', 'pam-1');
  const vault = path.join(home, 'confidential', 'api-jira');
  const deny = [path.join(home, 'confidential', 'api-hr')];
  const inj = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'pi', cwd: dir },
    { critical: ['Jira'], vaults: [vault], extraWritableDirs: [vault], denyDirs: deny, lockdown: { outgoing: path.join(dir, 'outgoing') } });

  assert.equal(inj.osSandbox, 'app');
  assert.equal(inj.wrapCommand, 'node', 'md-netgate runs first, outside the sandbox');
  const [script, gateDir, hosts] = inj.wrap;
  assert.ok(script.endsWith('/.netgate/md-netgate.cjs'));
  assert.equal(fs.readFileSync(path.join(dir, '.netgate', 'md-netgate.cjs'), 'utf8'), MD_NETGATE, 'written fresh into its own folder');
  assert.equal(hosts, 'api.anthropic.com', 'its model provider only');
  const b = inj.wrap.indexOf('bwrap');
  const inner = inj.wrap.lastIndexOf('--inner');
  const bwrap = inj.wrap.slice(b + 1, inj.wrap.lastIndexOf('--', inner));
  assert.ok(bwrap.includes('--unshare-net'), 'no network of its own');
  const binds = pairs(bwrap, '--bind-try');
  assert.deepEqual(binds.slice(0, 2), [lin(dir), lin(vault)], 'its folder and its vault');
  // Plus, on Linux itself, the folder of the app's hook socket (a Unix socket there).
  assert.deepEqual(binds.slice(2), process.platform === 'win32' ? [] : [lin(path.dirname(hive.sockPath()))], 'nothing else');
  assert.ok(pairs(bwrap, '--tmpfs').includes(lin(deny[0])), 'another vault hidden');
  assert.equal(pairs(bwrap, '--bind').length, 0, 'no write into the user\'s pi login');
  assert.equal(inj.wrap[inner + 1], gateDir);

  assert.equal(inj.env.HIVE_GUARD_STRICT, '1');
  const tools = inj.args.indexOf('--tools');
  assert.equal(inj.args[tools + 1], 'read,bash,edit,write,grep,find,ls');
  assert.equal(inj.args[inj.args.indexOf('--exclude-tools') + 1], 'mcp__*');
  const piDir = inj.env.PI_CODING_AGENT_DIR;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(piDir, 'settings.json'), 'utf8')), { defaultProvider: 'anthropic', defaultModel: 'claude-x' }, 'no packages or extensions of the user\'s');
  assert.equal(fs.lstatSync(path.join(piDir, 'auth.json')).isSymbolicLink(), false, 'its login is a copy');
  const g = hive.guardFor('pam-1');
  assert.deepEqual(g.roots, [dir, vault]);
});

test('an ordinary pi agent keeps the host network and is not strict', async (t) => {
  const home = tmp(t);
  const hive = new HiveManager(() => home);
  hive.sandboxAvailable = async () => true;
  hive.existingPaths = async () => [];
  const inj = await hive.ensureAgent({ id: 'pi-1', name: 'Pi', provider: 'pi', cwd: home }, {});
  assert.equal(inj.wrapCommand, undefined);
  assert.ok(!inj.wrap.includes('--unshare-net'));
  assert.equal(inj.env.HIVE_GUARD_STRICT, undefined);
  assert.equal(inj.args.indexOf('--tools'), -1);
});

// ─── the extension: refuse what the office cannot answer ────────────────────

function extension() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  const raw = src.slice(src.indexOf('const PI_EXTENSION = `') + 'const PI_EXTENSION = `'.length);
  return (0, eval)('`' + raw.slice(0, raw.search(/`;\r?\n/)) + '`');
}

async function toolCall(t, env, answer) {
  const dir = tmp(t);
  const file = path.join(dir, 'ext.cjs');
  fs.writeFileSync(file, extension());
  let port = 0;
  if (answer !== undefined) {
    const srv = net.createServer((c) => { c.on('data', () => { if (answer !== 'hang') c.end(answer); }); c.on('error', () => {}); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    port = srv.address().port;
    t.after(() => srv.close());
  }
  const runner = path.join(dir, 'run.cjs');
  fs.writeFileSync(runner, `const ext = require(${JSON.stringify(file)}); const h = {}; ext({ on: (e, f) => { h[e] = f; } });
    h.tool_call({ toolName: 'bash', input: { command: 'cat x' } }).then((r) => { console.log(JSON.stringify(r ?? null)); process.exit(0); });`);
  const p = spawn(process.execPath, [runner], { env: { ...process.env, ...env, ...(port ? { HIVE_SOCK: `tcp://127.0.0.1:${port}` } : {}) } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => p.on('exit', r));
  return JSON.parse(out.trim());
}

test('extension: the office\'s refusal blocks the call', async (t) => {
  const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Refused: outside your folders.' } });
  assert.deepEqual(await toolCall(t, { AGENT_ID: 'pam-1' }, deny), { block: true, reason: 'Refused: outside your folders.' });
});

test('extension: no answer from the office blocks a custodian\'s call, not an ordinary agent\'s', async (t) => {
  const strict = await toolCall(t, { AGENT_ID: 'pam-1', HIVE_GUARD_STRICT: '1', HIVE_SOCK: 'tcp://127.0.0.1:1' });
  assert.equal(strict.block, true);
  assert.match(strict.reason, /could not be asked/);
  assert.equal(await toolCall(t, { AGENT_ID: 'jim-1', HIVE_SOCK: 'tcp://127.0.0.1:1' }), null);
  const noSock = await toolCall(t, { AGENT_ID: 'pam-1', HIVE_GUARD_STRICT: '1', HIVE_SOCK: '' });
  assert.equal(noSock.block, true, 'no office at all: refused');
  assert.equal(await toolCall(t, { AGENT_ID: 'pam-1', HIVE_GUARD_STRICT: '1' }, '{}'), null, 'the office allows it');
});

// ─── md-netgate's proxy: the model host only ────────────────────────────────

test('netgate: the CONNECT proxy refuses every host but the allowed ones, and relays loopback ports', { skip: process.platform === 'win32' ? 'Unix sockets in a temp dir: Linux/macOS (the WSL run covers it live)' : false }, async (t) => {
  const dir = tmp(t);
  const script = path.join(dir, 'md-netgate.cjs');
  fs.writeFileSync(script, MD_NETGATE);
  const app = http.createServer((_q, r) => r.end('pong'));
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(() => app.close());
  const gate = path.join(dir, 'gate');
  const p = spawn(process.execPath, [script, gate, 'api.allowed.example', '--', process.execPath, '-e', 'setTimeout(()=>{},4000)'],
    { env: { ...process.env, MD_BROKER_URL: `http://127.0.0.1:${app.address().port}` } });
  t.after(() => p.kill());
  for (let i = 0; i < 50 && !fs.existsSync(path.join(gate, 'proxy.sock')); i++) await new Promise((r) => setTimeout(r, 50));
  const ask = (line) => new Promise((resolve) => { const c = net.connect(path.join(gate, 'proxy.sock'), () => c.write(line)); let s = ''; c.on('data', (d) => { s += d; c.end(); }); c.on('close', () => resolve(s)); });
  assert.match(await ask('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n'), /^HTTP\/1\.1 403/);
  assert.match(await ask('GET http://example.com/ HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/);
  assert.match(await ask('CONNECT api.allowed.example:80 HTTP/1.1\r\n\r\n'), /^HTTP\/1\.1 403/, 'port 443 only');
  const relayed = await new Promise((resolve) => { const c = net.connect(path.join(gate, `${app.address().port}.sock`), () => c.write('GET / HTTP/1.0\r\n\r\n')); let s = ''; c.on('data', (d) => { s += d; }); c.on('close', () => resolve(s)); });
  assert.match(relayed, /pong/);
});
