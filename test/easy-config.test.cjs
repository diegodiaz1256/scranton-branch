'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  EASY_NAV_GROUPS, EASY_NAV_ADVANCED, EASY_PAGE_DECISIONS, easyNavPlaced, hasSimpleView,
  connectionState, sortConnections, secretsSummary, memoryState, agentPowers, isRiskyPower, findJargon
} = loadTs('src/shared/easyConfig.ts');

/** Every Manager sidebar page (proStore.ts ProSection, minus the agent list). */
const ALL_PAGES = ['now', 'tasks', 'inbox', 'deliverables', 'automations', 'memory', 'skills', 'capabilities',
  'connections', 'environment', 'providers', 'mcp', 'team', 'factories', 'temps'];

test('the Easy sidebar places every page exactly once, none hidden', () => {
  const placed = easyNavPlaced();
  assert.deepEqual([...placed].sort(), [...ALL_PAGES].sort());
  assert.equal(new Set(placed).size, placed.length);
});

test('expert pages sit under Advanced; everyday settings get plain-named groups', () => {
  for (const p of ['mcp', 'factories', 'temps', 'providers']) assert.ok(EASY_NAV_ADVANCED.items.includes(p), p);
  const named = EASY_NAV_GROUPS.filter((g) => g.label);
  assert.ok(named.length >= 2);
  for (const g of named) assert.equal(g.defaultOpen, true, `${g.id} starts open`);
  for (const p of ['connections', 'capabilities', 'environment']) {
    assert.ok(named.some((g) => g.items.includes(p)), `${p} is in a named group, not Advanced`);
  }
});

test('every configuration page has an Easy entry; simple views have at most three decisions', () => {
  for (const p of ['automations', 'memory', 'skills', 'capabilities', 'connections', 'environment', 'providers', 'mcp', 'team', 'factories', 'temps']) {
    assert.ok(p in EASY_PAGE_DECISIONS, p);
    assert.ok(EASY_PAGE_DECISIONS[p].length <= 3, p);
  }
  assert.equal(hasSimpleView('connections'), true);
  assert.equal(hasSimpleView('mcp'), false);
  assert.equal(hasSimpleView('tasks'), false);
});

test('connection state in words', () => {
  assert.equal(connectionState({ enabled: true, ready: true }), 'connected');
  assert.equal(connectionState({ enabled: true, ready: false }), 'needsKey');
  assert.equal(connectionState({ enabled: false, ready: true }), 'off');
  const sorted = sortConnections([
    { label: 'Zed', enabled: false, ready: false },
    { label: 'Beta', enabled: true, ready: false },
    { label: 'Alpha', enabled: true, ready: true },
    { label: 'Aardvark', enabled: true, ready: true }
  ]).map((c) => c.label);
  assert.deepEqual(sorted, ['Aardvark', 'Alpha', 'Beta', 'Zed']);
});

test('saved passwords count secrets and 1Password values, not plain settings', () => {
  assert.deepEqual(secretsSummary([{ kind: 'secret' }, { kind: 'op' }, { kind: 'plain' }]), { passwords: 2, settings: 1 });
  assert.deepEqual(secretsSummary([]), { passwords: 0, settings: 0 });
});

test('memory state in one word', () => {
  const base = { available: true, enabled: true, active: true, modelReady: true, downloading: false };
  assert.equal(memoryState(null), 'checking');
  assert.equal(memoryState(base), 'on');
  assert.equal(memoryState({ ...base, enabled: false }), 'off');
  assert.equal(memoryState({ ...base, available: false }), 'notInstalled');
  assert.equal(memoryState({ ...base, downloading: true }), 'preparing');
  assert.equal(memoryState({ ...base, modelReady: false }), 'preparing');
});

test('extra powers are reported, risky ones first and flagged', () => {
  const cfg = {
    agentUnsandboxed: ['a'],
    agentDocker: { a: true },
    agentSshRelay: { a: { keys: ['id_ed25519'] } },
    agentCloudCredentials: { a: ['aws'] },
    agentRoam: ['a']
  };
  const p = agentPowers(cfg, 'a');
  assert.deepEqual(p.slice(0, 2), ['unsandboxed', 'docker']);
  assert.ok(p.includes('sshKeys'));
  assert.ok(p.includes('roam'));
  assert.deepEqual(agentPowers(cfg, 'b'), []);
  assert.deepEqual(agentPowers({}, 'a'), []);
  assert.equal(isRiskyPower('unsandboxed'), true);
  assert.equal(isRiskyPower('docker'), true);
  assert.equal(isRiskyPower('roam'), false);
});

test('findJargon spots whole words only', () => {
  assert.deepEqual(findJargon('Add an MCP server'), ['MCP']);
  assert.deepEqual(findJargon('Apps you connect'), []);
  assert.deepEqual(findJargon('rapid'), []); // "API" inside a word is not jargon
});

/** Every string under `pro.easy` (and the Easy group names), tooltips aside. */
function easyStrings(locale) {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'));
  const out = [];
  const walk = (o, key) => {
    for (const [k, v] of Object.entries(o)) {
      const full = `${key}.${k}`;
      if (typeof v === 'string') { if (!k.endsWith('Tip')) out.push([full, v]); } else walk(v, full);
    }
  };
  walk(j.pro.easy, 'pro.easy');
  out.push(['pro.nav.group_easyOffice', j.pro.nav.group_easyOffice], ['pro.nav.group_easyAccess', j.pro.nav.group_easyAccess]);
  return out;
}

for (const locale of ['en', 'es']) {
  test(`Easy view text has no jargon (${locale})`, () => {
    for (const [key, text] of easyStrings(locale)) assert.deepEqual(findJargon(text), [], `${key}: ${text}`);
  });
}

test('Easy keys exist in both languages', () => {
  const keys = (l) => easyStrings(l).map(([k]) => k).sort();
  assert.deepEqual(keys('en'), keys('es'));
});
