'use strict';
/**
 * The hosts a pi custodian may reach over HTTPS (sb-netgate): detected from
 * its pi settings, plus or instead of the human's (config.piModelHosts,
 * Settings → AI providers → pi). Hostnames only, HTTPS only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { normalizeModelHost, sanitizePiModelHosts, resolvePiModelHosts } = loadTs('src/shared/piModelHosts.ts');

test('a host: a bare hostname or an https URL to one', () => {
  const ok = (s, h) => assert.deepEqual(normalizeModelHost(s), { ok: true, host: h }, s);
  const no = (s, e) => assert.deepEqual(normalizeModelHost(s), { ok: false, error: e }, s);
  ok('llm.corp.example', 'llm.corp.example');
  ok('  LLM.Corp.Example. ', 'llm.corp.example');
  ok('https://gw.corp.example', 'gw.corp.example');
  ok('https://gw.corp.example/', 'gw.corp.example');
  ok('gw.corp.example:443', 'gw.corp.example');
  ok('xn--bcher-kva.example', 'xn--bcher-kva.example');
  no('', 'empty');
  no(undefined, 'empty');
  no('http://gw.corp.example', 'notHttps');
  no('ftp://gw.corp.example', 'notHttps');
  no('https://gw.corp.example:8443', 'port');
  no('gw.corp.example:80', 'port');
  no('https://gw.corp.example/v1', 'path');
  no('10.0.0.5', 'ip');
  no('https://[::1]', 'ip');
  no('2001:db8::1', 'ip');
  no('localhost', 'loopback');
  no('a.localhost', 'loopback');
  no('*.corp.example', 'invalid');
  no('intranet', 'invalid');
  no('user@gw.corp.example', 'invalid');
  no('-bad.example', 'invalid');
  no('gw.corp.example;evil.com', 'invalid');
  no('a,b.example', 'invalid');
});

test('saved config: valid hosts only, deduplicated, mode add unless replace', () => {
  assert.deepEqual(sanitizePiModelHosts({ hosts: ['GW.corp.example', 'https://gw.corp.example', 'http://x.example', 'bad', 42], mode: 'replace' }), { hosts: ['gw.corp.example'], mode: 'replace' });
  assert.deepEqual(sanitizePiModelHosts({ hosts: 'x', mode: 'nope' }), { hosts: [], mode: 'add' });
  assert.equal(sanitizePiModelHosts(null), undefined);
});

test('resolved: the detected ones plus the human\'s, or only the human\'s', () => {
  assert.deepEqual(resolvePiModelHosts(['api.anthropic.com'], undefined), ['api.anthropic.com']);
  assert.deepEqual(resolvePiModelHosts(['api.anthropic.com'], { hosts: ['gw.corp.example', 'api.anthropic.com'], mode: 'add' }), ['api.anthropic.com', 'gw.corp.example']);
  assert.deepEqual(resolvePiModelHosts(['api.anthropic.com'], { hosts: ['gw.corp.example'], mode: 'replace' }), ['gw.corp.example']);
  assert.deepEqual(resolvePiModelHosts(['api.anthropic.com'], { hosts: [], mode: 'replace' }), [], 'only the app and a loopback model');
  assert.deepEqual(resolvePiModelHosts(['api.anthropic.com'], { hosts: ['evil.example,api.x.ai'], mode: 'add' }), ['api.anthropic.com'], 'a hand-edited config cannot smuggle a second host past the comma list');
});

test('sb-netgate gets them: a pi custodian\'s launch carries the resolved hosts', async (t) => {
  const electron = require.resolve('electron');
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pihosts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const userHome = path.join(home, 'user');
  fs.mkdirSync(path.join(userHome, '.pi', 'agent'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-x' }));
  const hive = new HiveManager(() => home);
  hive.userHome = () => userHome;
  hive.nodeCommand = () => 'node';
  hive.sandboxAvailable = async () => true;
  hive.existingPaths = async () => [];
  assert.deepEqual(hive.detectedPiModelHosts(), ['api.anthropic.com'], 'what Settings shows as found');
  const dir = path.join(home, 'hive', 'agents', 'pam-1');
  const launch = async (modelHosts) => (await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'pi', cwd: dir },
    { lockdown: { outgoing: path.join(dir, 'outgoing') }, modelHosts })).wrap[2];
  assert.equal(await launch(undefined), 'api.anthropic.com');
  assert.equal(await launch({ hosts: ['gw.corp.example'], mode: 'add' }), 'api.anthropic.com,gw.corp.example');
  assert.equal(await launch({ hosts: ['gw.corp.example'], mode: 'replace' }), 'gw.corp.example');
  assert.equal(await launch({ hosts: ['http://evil.example', '1.2.3.4'], mode: 'replace' }), ',', 'nothing invalid gets through (and no empty argument: wsl.exe refuses one)');
  // The app's own model providers reach pi's models.json only after the launch
  // is built: their remote hosts count as detected (a loopback one is relayed).
  const custom = ['https://llm.corp.example/v1', 'http://127.0.0.1:8010/v1'];
  assert.deepEqual(hive.detectedPiModelHosts(custom), ['api.anthropic.com', 'llm.corp.example']);
  const inj = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'pi', cwd: dir }, { lockdown: { outgoing: path.join(dir, 'outgoing') }, piCustomBaseUrls: custom });
  assert.equal(inj.wrap[2], 'api.anthropic.com,llm.corp.example');
});
