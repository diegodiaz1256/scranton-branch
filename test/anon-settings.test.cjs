'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const {
  cleanAnonSettings, cleanDictionary, anonEnabledFor, anonCategories, anonOptions,
  stripHumanOnly, anonCoverage, anonSpawnDecision, anonStatusOf, isLoopbackUrl
} = loadTs('src/shared/anonSettings.ts');

test('settings: off by default, junk dropped, per-agent override wins', () => {
  assert.deepEqual(cleanAnonSettings(undefined), { enabled: false });
  const s = cleanAnonSettings({ enabled: true, categories: { email: true, nope: true, ipv4: 'yes' }, agents: { a: false, b: true, c: 'x' } });
  assert.deepEqual(s, { enabled: true, categories: { email: true }, agents: { a: false, b: true } });
  assert.equal(anonEnabledFor(s, 'a'), false);
  assert.equal(anonEnabledFor(s, 'b'), true);
  assert.equal(anonEnabledFor(s, 'z'), true);
  assert.equal(anonEnabledFor({ enabled: false, agents: { b: true } }, 'b'), true);
  assert.equal(anonEnabledFor({}, 'b'), false);
});

test('categories: dictionary-driven ones and credentials on, emails and IPs off by default', () => {
  const c = anonCategories({});
  assert.equal(c.term, true);
  assert.equal(c.secret, true);
  assert.equal(c.knownSecret, true);
  assert.equal(c.domain, true);
  assert.equal(c.ticket, true);
  assert.equal(c.email, false);
  assert.equal(c.ipv4, false);
  assert.equal(anonCategories({ categories: { email: true, term: false } }).email, true);
  assert.equal(anonCategories({ categories: { email: true, term: false } }).term, false);
});

test('dictionary: cleaned, deduped, prefixes upper-cased, secrets kept byte for byte', () => {
  const d = cleanDictionary({
    terms: [
      { term: ' Acme Corp ', category: 'company', aliases: ['ACME', 'acme corp', 'x'], as: ' Globex ' },
      { term: 'acme corp', category: 'other' },
      { term: 'S', category: 'system' },
      { term: 'Falcon', category: 'bogus' }
    ],
    ticketPrefixes: ['infosec', 'OPS', 'bad-prefix', 'OPS'],
    secrets: [' pa ss ', 'abc', 'abc', ' pa ss ']
  });
  assert.deepEqual(d.terms, [
    { term: 'Acme Corp', category: 'company', aliases: ['ACME'], as: 'Globex' },
    { term: 'Falcon', category: 'other' }
  ]);
  assert.deepEqual(d.ticketPrefixes, ['INFOSEC', 'OPS']);
  assert.deepEqual(d.secrets, [' pa ss ']);
  const o = anonOptions({}, d);
  assert.equal(o.terms[0].as, 'Globex');
  assert.deepEqual(o.secrets, [' pa ss ']);
});

test('human-only config: the generic write drops anonymize and the other human switches', () => {
  const out = stripHumanOnly({ theme: 'dark', anonymize: { enabled: false }, agentUnsandboxed: ['a'], agentSshRelay: {}, agentCloudCredentials: {} });
  assert.deepEqual(out, { theme: 'dark' });
  assert.deepEqual(stripHumanOnly(undefined), {});
});

test('coverage: Claude via base URL, qwen/crush behind the hive proxy, endpoint-fixed CLIs not covered', () => {
  assert.deepEqual(anonCoverage('claude', { upstream: 'https://api.anthropic.com' }), { covered: true, route: 'base-url' });
  assert.deepEqual(anonCoverage('qwen', { upstream: 'https://api.openai.com/v1' }), { covered: true, route: 'hive-proxy' });
  assert.deepEqual(anonCoverage('crush'), { covered: true, route: 'hive-proxy' });
  for (const p of ['agy', 'copilot', 'cursor', 'codex', 'gemini', 'grok', 'kimi']) {
    assert.deepEqual(anonCoverage(p), { covered: false, reason: 'endpoint-fixed' }, p);
  }
  assert.deepEqual(anonCoverage(undefined), { covered: false, reason: 'unknown-cli' });
  assert.deepEqual(anonCoverage('claude', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }), { covered: false, reason: 'cloud-platform' });
  assert.deepEqual(anonCoverage('claude', { env: { CLAUDE_CODE_USE_BEDROCK: '0' } }), { covered: true, route: 'base-url' });
});

test('coverage: opencode/pi only with a provider whose base URL the app writes; a local model needs none', () => {
  assert.deepEqual(anonCoverage('opencode', { modelProvider: 'anthropic', configurableProviders: ['local'] }), { covered: false, reason: 'model-provider' });
  assert.deepEqual(anonCoverage('pi', { modelProvider: 'litellm', configurableProviders: ['litellm'], upstream: 'https://llm.corp.example/v1' }), { covered: true, route: 'config' });
  assert.deepEqual(anonCoverage('opencode', { modelProvider: 'local', configurableProviders: ['local'], upstream: 'http://localhost:11434/v1' }), { covered: 'local' });
  assert.equal(isLoopbackUrl('http://127.0.0.1:8080'), true);
  assert.equal(isLoopbackUrl('http://[::1]:8080'), true);
  assert.equal(isLoopbackUrl('https://api.openai.com'), false);
});

test('fail closed: on + covered + no proxy refuses the spawn', () => {
  const covered = { covered: true, route: 'base-url' };
  assert.deepEqual(anonSpawnDecision({ enabled: true, coverage: covered, proxyUp: false }), { action: 'refuse', why: 'proxy-down' });
  assert.deepEqual(anonSpawnDecision({ enabled: true, coverage: covered, proxyUp: true }), { action: 'proxy', route: 'base-url' });
  assert.deepEqual(anonSpawnDecision({ enabled: false, coverage: covered, proxyUp: false }), { action: 'off' });
  const not = { covered: false, reason: 'endpoint-fixed' };
  assert.deepEqual(anonSpawnDecision({ enabled: true, coverage: not, proxyUp: false }), { action: 'uncovered', reason: 'endpoint-fixed' });
  assert.deepEqual(anonSpawnDecision({ enabled: true, coverage: not, proxyUp: true, refuseUncovered: true }), { action: 'refuse', why: 'uncovered', reason: 'endpoint-fixed' });
  assert.deepEqual(anonSpawnDecision({ enabled: true, coverage: { covered: 'local' }, proxyUp: false }), { action: 'local' });
  assert.equal(anonStatusOf({ action: 'proxy', route: 'config' }), 'on');
  assert.equal(anonStatusOf({ action: 'uncovered', reason: 'endpoint-fixed' }), 'not-covered');
  assert.equal(anonStatusOf({ action: 'refuse', why: 'proxy-down' }), 'not-covered');
});
