'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { resolveUiMode, isEasyMode, splitForEasyMode, EASY_NAV_ESSENTIALS, EASY_SETTINGS_ESSENTIALS } = loadTs('src/shared/uiMode.ts');

test('an explicit choice wins over the onboarding answer', () => {
  assert.equal(resolveUiMode({ uiMode: 'full', audience: 'non-technical' }), 'full');
  assert.equal(resolveUiMode({ uiMode: 'easy', audience: 'technical' }), 'easy');
});

test('unset: non-technical starts easy, everyone else full', () => {
  assert.equal(resolveUiMode({ audience: 'non-technical' }), 'easy');
  assert.equal(resolveUiMode({ audience: 'technical' }), 'full');
  assert.equal(resolveUiMode({}), 'full'); // existing installs look unchanged
  assert.equal(resolveUiMode(undefined), 'full');
  assert.equal(resolveUiMode(null), 'full');
});

test('a garbage value falls back to the default', () => {
  assert.equal(resolveUiMode({ uiMode: 'simple', audience: 'non-technical' }), 'easy');
  assert.equal(resolveUiMode({ uiMode: '', audience: 'technical' }), 'full');
  assert.equal(isEasyMode({ uiMode: 'easy' }), true);
  assert.equal(isEasyMode({ uiMode: 'full' }), false);
});

test('the split loses nothing and keeps the order', () => {
  const all = ['now', 'tasks', 'inbox', 'deliverables', 'automations', 'memory', 'skills', 'capabilities', 'connections', 'environment', 'providers', 'mcp', 'team', 'factories', 'temps'];
  const { essential, advanced } = splitForEasyMode(all, EASY_NAV_ESSENTIALS);
  assert.deepEqual(essential, ['now', 'tasks', 'inbox', 'deliverables']);
  assert.deepEqual([...essential, ...advanced].sort(), [...all].sort());
  assert.equal(new Set([...essential, ...advanced]).size, all.length);
  assert.deepEqual(advanced, all.filter((x) => !essential.includes(x)));
});

test('settings keep General and Autonomy & Budgets in view', () => {
  const all = ['General', 'Prerequisites', 'Agents & Models', 'Autonomy & Budgets', 'Connections', 'Voice', 'Memory & Knowledge'];
  const { essential, advanced } = splitForEasyMode(all, EASY_SETTINGS_ESSENTIALS);
  assert.deepEqual(essential, ['General', 'Autonomy & Budgets']);
  assert.deepEqual(advanced, ['Prerequisites', 'Agents & Models', 'Connections', 'Voice', 'Memory & Knowledge']);
});
