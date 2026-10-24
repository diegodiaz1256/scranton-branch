'use strict';
/**
 * The hive's commands and the app's environment variables are named sb-* / SB_*
 * since the rename to Scranton Branch. The md-* commands and MD_* variables they
 * replaced must keep working: agents already running, saved prompts, user
 * scripts and a server's systemd or compose environment still use them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { appEnv, takeAppEnv, bothEnv } = loadTs('src/shared/envName.ts');
const { toolAlias, withToolAliases } = loadTs('src/main/agentBinAliases.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

test('SB_* is read first, MD_* is the fallback, an empty value counts as unset', () => {
  assert.equal(appEnv('OFFICE', { SB_OFFICE: '/new', MD_OFFICE: '/old' }), '/new');
  assert.equal(appEnv('OFFICE', { MD_OFFICE: '/old' }), '/old');
  assert.equal(appEnv('OFFICE', { SB_OFFICE: '', MD_OFFICE: '/old' }), '/old');
  assert.equal(appEnv('OFFICE', {}), undefined);
});

test('a secret read from the environment is removed under both names', () => {
  const env = { SB_SECRET_KEY: 'new', MD_SECRET_KEY: 'old', OTHER: 'x' };
  assert.equal(takeAppEnv('SECRET_KEY', env), 'new');
  assert.deepEqual(env, { OTHER: 'x' });
  const legacy = { MD_SECRET_KEY_FILE: '/run/secrets/k' };
  assert.equal(takeAppEnv('SECRET_KEY_FILE', legacy), '/run/secrets/k');
  assert.deepEqual(legacy, {});
});

test('a variable handed to an agent carries both names', () => {
  assert.deepEqual(bothEnv('BROKER_URL', 'http://127.0.0.1:1'), { SB_BROKER_URL: 'http://127.0.0.1:1', MD_BROKER_URL: 'http://127.0.0.1:1' });
});

test('each hive command has its other name; other bin files have none', () => {
  const bin = path.join('h', 'bin');
  assert.equal(toolAlias(path.join(bin, 'sb-api.cjs')), path.join(bin, 'md-api.cjs'));
  assert.equal(toolAlias(path.join(bin, 'md-netgate.cjs')), path.join(bin, 'sb-netgate.cjs'));
  for (const f of ['cth-hook.cjs', 'hive-proxy.cjs', 'md-slack-reply.cjs', 'sb-api.js', 'md-preview.cjs']) {
    assert.equal(toolAlias(path.join(bin, f)), null, f);
  }
  const out = withToolAliases([[path.join(bin, 'cth-hook.cjs'), 'H'], [path.join(bin, 'md-run.cjs'), 'R']]);
  assert.deepEqual(out, [[path.join(bin, 'cth-hook.cjs'), 'H'], [path.join(bin, 'sb-run.cjs'), 'R'], [path.join(bin, 'md-run.cjs'), 'R']]);
});

test('bootstrap writes every hive command as sb-* and as an identical md-* alias', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb tools-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  new HiveManager(() => home).ensureHive();
  const bin = path.join(home, 'hive', 'bin');
  for (const name of ['api', 'run', 'browse', 'skills', 'lists']) {
    const sb = path.join(bin, `sb-${name}.cjs`), md = path.join(bin, `md-${name}.cjs`);
    assert.ok(fs.existsSync(sb), `sb-${name}.cjs`);
    assert.ok(fs.existsSync(md), `md-${name}.cjs`);
    assert.equal(fs.readFileSync(md, 'utf8'), fs.readFileSync(sb, 'utf8'), `md-${name}.cjs is the same script`);
  }
});

function run(script, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('sb-api and md-api reach the broker with SB_* or with only the older MD_* env', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb tools-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  new HiveManager(() => home).ensureHive();
  const bin = path.join(home, 'hive', 'bin');

  const seen = [];
  const broker = http.createServer((req, res) => {
    seen.push(`${req.url} ${req.headers.authorization}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ apis: [{ id: 'jira', label: 'Jira' }] }));
  });
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  t.after(() => broker.close());
  const url = `http://127.0.0.1:${broker.address().port}`;

  const cases = [
    ['sb-api.cjs', { SB_BROKER_URL: url, SB_BROKER_TOKEN: 'tok-sb' }, 'Bearer tok-sb'],
    ['md-api.cjs', { SB_BROKER_URL: url, SB_BROKER_TOKEN: 'tok-sb' }, 'Bearer tok-sb'],
    ['sb-api.cjs', { MD_BROKER_URL: url, MD_BROKER_TOKEN: 'tok-md' }, 'Bearer tok-md'],
    ['md-api.cjs', { MD_BROKER_URL: url, MD_BROKER_TOKEN: 'tok-md' }, 'Bearer tok-md'],
    // Both set: SB_ wins.
    ['md-api.cjs', { SB_BROKER_URL: url, SB_BROKER_TOKEN: 'tok-sb', MD_BROKER_URL: 'http://127.0.0.1:9', MD_BROKER_TOKEN: 'tok-md' }, 'Bearer tok-sb'],
  ];
  for (const [script, env, auth] of cases) {
    seen.length = 0;
    const r = await run(path.join(bin, script), env);
    assert.equal(r.code, 0, `${script} ${Object.keys(env).join(',')}: ${r.err}`);
    assert.match(r.out, /^jira {2}Jira/m);
    assert.deepEqual(seen, [`/i ${auth}`]);
  }

  const none = await run(path.join(bin, 'sb-api.cjs'), {});
  assert.equal(none.code, 2, 'no broker in either name: the clear error, not a crash');
});
