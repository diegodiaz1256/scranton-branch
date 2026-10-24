'use strict';
/**
 * The hive's own commands (md-api, md-run, md-browse) inside Claude Code's OS
 * sandbox. There a command has its own network: 127.0.0.1 is not the app's,
 * and the only way out is the sandbox proxy (http_proxy, with 127.0.0.1 in
 * no_proxy). The commands send the broker request through that proxy, the
 * agent settings allow exactly the broker's host:port, and a failure names the
 * URL, the error code and the sandbox instead of "fetch failed".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function hive(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md sbx-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const h = new HiveManager(() => home);
  h.ensureHive();
  return { h, home, bin: (f) => path.join(home, 'hive', 'bin', f) };
}

/** A stand-in for the sandbox's HTTP proxy: records what it was asked and
 *  answers as the broker would (or refuses, like the real allowlist). */
async function fakeProxy(t, answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, proxyAuth: req.headers['proxy-authorization'], auth: req.headers.authorization, body });
      answer(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { seen, url: `http://srt.user:s3cret@127.0.0.1:${server.address().port}` };
}

/** A loopback port with nothing listening on it. */
async function closedPort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

const sandboxEnv = (proxyUrl, brokerUrl) => ({
  SANDBOX_RUNTIME: '1',
  http_proxy: proxyUrl,
  no_proxy: 'localhost,127.0.0.1,::1',
  MD_BROKER_URL: brokerUrl,
  MD_BROKER_TOKEN: 'tok-agent'
});

test('the agent sandbox may reach exactly the broker port', (t) => {
  const { h, home } = hive(t);
  const shim = path.join(home, 'hive', 'bin', 'cth-hook.cjs');
  const s = h.hookSettings(shim, undefined, [home], true, 'http://127.0.0.1:47123');
  assert.deepEqual(s.sandbox.network, { allowedDomains: ['127.0.0.1:47123'] });
  const none = h.hookSettings(shim, undefined, [home], true);
  assert.equal('network' in none.sandbox, false, 'no broker, nothing opened');
});

test('inside the sandbox md-api goes through the sandbox proxy to the broker', async (t) => {
  const { bin } = hive(t);
  const proxy = await fakeProxy(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/i') ? JSON.stringify({ apis: [{ id: 'jira', label: 'Jira' }] }) : '{"ok":true}');
  });
  // Nothing listens at the broker URL itself: the answer can only come via the proxy.
  const broker = `http://127.0.0.1:${await closedPort()}`;
  const env = sandboxEnv(proxy.url, broker);

  const list = await run(bin('md-api.cjs'), [], env);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /^jira {2}Jira/m);

  const post = await run(bin('md-api.cjs'), ['jira', 'POST', '/issue', '{"x":1}'], env);
  assert.equal(post.code, 0, post.err);
  assert.match(post.out, /^HTTP 200/);

  assert.equal(proxy.seen[0].url, `${broker}/i`, 'absolute URL, as a forward proxy expects');
  assert.equal(proxy.seen[0].host, new URL(broker).host);
  assert.equal(proxy.seen[0].proxyAuth, 'Basic ' + Buffer.from('srt.user:s3cret').toString('base64'));
  assert.equal(proxy.seen[0].auth, 'Bearer tok-agent');
  assert.equal(proxy.seen[1].method, 'POST');
  assert.equal(proxy.seen[1].url, `${broker}/i/jira/issue`);
  assert.equal(proxy.seen[1].body, '{"x":1}');
});

test('md-run and md-browse take the same way out', async (t) => {
  const { bin } = hive(t);
  const proxy = await fakeProxy(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url.endsWith('/run') ? JSON.stringify({ runners: [{ id: 'migrate', secrets: [] }], secrets: ['DB_URL'] }) : 'page text');
  });
  const broker = `http://127.0.0.1:${await closedPort()}`;
  const env = sandboxEnv(proxy.url, broker);

  const runList = await run(bin('md-run.cjs'), [], env);
  assert.equal(runList.code, 0, runList.err);
  assert.match(runList.out, /^migrate/m);
  assert.match(runList.out, /DB_URL/);

  const page = await run(bin('md-browse.cjs'), ['https://example.com'], env);
  assert.equal(page.code, 0, page.err);
  assert.match(page.out, /page text/);
  assert.deepEqual(proxy.seen.map((s) => s.url), [`${broker}/run`, `${broker}/browse`]);
});

test('a refusal by the sandbox network says so, with the broker address', async (t) => {
  const { bin } = hive(t);
  const proxy = await fakeProxy(t, (_req, res) => { res.writeHead(403); res.end('Connection blocked by network allowlist'); });
  const broker = 'http://127.0.0.1:47123';
  const r = await run(bin('md-api.cjs'), [], sandboxEnv(proxy.url, broker));
  assert.equal(r.code, 1);
  assert.match(r.err, /^md-api: could not reach the app at http:\/\/127\.0\.0\.1:47123: the sandbox network blocked 127\.0\.0\.1:47123/);
  assert.match(r.err, /SANDBOX_BLOCKED/);
  assert.match(r.err, /Claude Code sandbox/);
});

test('outside the sandbox the broker is called directly, and a dead one is named', async (t) => {
  const { bin } = hive(t);
  const broker = `http://127.0.0.1:${await closedPort()}`;
  // A proxy in the env of an unsandboxed agent (a corporate one) is not used for loopback.
  const env = { MD_BROKER_URL: broker, MD_BROKER_TOKEN: 'tok', http_proxy: 'http://127.0.0.1:9' };
  for (const [cli, args] of [['md-api.cjs', []], ['md-run.cjs', []], ['md-browse.cjs', ['https://example.com']]]) {
    const r = await run(bin(cli), args, env);
    assert.equal(r.code, 1, cli);
    assert.ok(r.err.includes(`could not reach the app at ${broker}`), `${cli}: ${r.err}`);
    assert.match(r.err, /ECONNREFUSED/, cli);
    assert.doesNotMatch(r.err, /fetch failed/, cli);
    assert.match(r.err, /restart this agent/, cli);
  }
});
