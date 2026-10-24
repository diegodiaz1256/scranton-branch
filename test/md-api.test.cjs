'use strict';
/**
 * md-api: how any hive agent reaches a REST integration without holding its key.
 * The agent runs <hive>/bin/md-api.cjs with only MD_BROKER_URL + its capability
 * token; the broker adds the real credential upstream.
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
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

const SECRET = 'lin_api_TEST_real_key_never_in_agent_env';

function run(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('md-api calls an integration through the broker, which adds the key', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md api-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const cli = path.join(home, 'hive', 'bin', 'md-api.cjs');
  assert.ok(fs.existsSync(cli), 'bootstrap writes the helper');

  const seen = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const base = `http://127.0.0.1:${upstream.address().port}/v1`;

  const record = { id: 'linear', label: 'Linear', kind: 'custom-rest', baseUrl: base, authType: 'bearer', secretRef: 'int:linear', enabled: true, createdAt: 0, updatedAt: 0 };
  const broker = new IntegrationBroker({ getRecord: (id) => (id === 'linear' ? record : undefined), getSecret: (ref) => (ref === 'int:linear' ? SECRET : undefined) });
  await broker.start(0);
  t.after(() => broker.stop());
  const token = broker.grant('pty-dwight', ['linear']);
  const env = { MD_BROKER_URL: broker.url(), MD_BROKER_TOKEN: token };

  const get = await run(cli, ['linear', 'GET', '/issues?first=1'], env);
  assert.equal(get.code, 0, get.err);
  assert.match(get.out, /^HTTP 200/);
  assert.match(get.out, /"ok":true/);

  const post = await run(cli, ['linear', 'post', 'issues', '{"title":"x"}'], env);
  assert.equal(post.code, 0, post.err);

  // Stripe takes only form bodies: a body that is not JSON goes as a form.
  const form = await run(cli, ['linear', 'POST', 'customers', 'email=a%40b.c&name=Dwight'], env);
  assert.equal(form.code, 0, form.err);

  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/v1/issues?first=1');
  assert.equal(seen[0].auth, `Bearer ${SECRET}`, 'the broker injected the real key upstream');
  assert.equal(seen[1].method, 'POST');
  assert.equal(seen[1].body, '{"title":"x"}');
  assert.equal(seen[1].type, 'application/json');
  assert.equal(seen[2].body, 'email=a%40b.c&name=Dwight');
  assert.equal(seen[2].type, 'application/x-www-form-urlencoded');
  assert.ok(!JSON.stringify(env).includes(SECRET), 'the agent env never held the key');

  const other = await run(cli, ['stripe', 'GET', '/'], env);
  assert.notEqual(other.code, 0, 'an integration outside the grant is refused');

  const none = await run(cli, ['linear', 'GET', '/'], {});
  assert.equal(none.code, 2);
  assert.match(none.err, /started without the app key broker.*restart this agent/);
});

test('the prompt lists the granted integrations with the exact md-api command', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-api-prompt-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent(
    { id: 'jim', name: 'Jim', provider: 'claude', cwd: home },
    { integrations: [{ id: 'linear', label: 'Linear' }] }
  );
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /REST APIs you can call/);
  assert.match(prompt, /linear \(Linear\)/);
  assert.ok(prompt.includes(path.join(home, 'hive', 'bin', 'md-api.cjs')), 'absolute helper path, no $VAR');

  const bare = await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home }, {});
  assert.doesNotMatch(bare.args[bare.args.indexOf('--append-system-prompt') + 1], /REST APIs you can call/);
});
