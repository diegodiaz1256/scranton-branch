'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { resolveUiMode, isEasyMode, splitForEasyMode, landingLayout, EASY_HOME, EASY_NAV_ESSENTIALS, EASY_SETTINGS_ESSENTIALS } = loadTs('src/shared/uiMode.ts');

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

test('easy mode lands in the Manager layout unless a layout was chosen', () => {
  assert.equal(landingLayout(null, { uiMode: 'easy' }), 'pro');
  assert.equal(landingLayout(undefined, { audience: 'non-technical' }), 'pro');
  assert.equal(landingLayout('classic', { uiMode: 'easy' }), null); // an explicit choice stands
  assert.equal(landingLayout('pro', { uiMode: 'easy' }), null);
  assert.equal(landingLayout(null, { uiMode: 'full' }), null); // full mode unchanged
  assert.equal(landingLayout(null, {}), null);
});

test('easy mode opens on the thread, the first page of its sidebar', () => {
  assert.equal(EASY_HOME, 'thread');
  assert.equal(EASY_NAV_ESSENTIALS[0], 'thread');
  const { essential } = splitForEasyMode(['now', 'thread', 'tasks', 'memory'], EASY_NAV_ESSENTIALS);
  assert.deepEqual(essential, ['now', 'thread', 'tasks']);
});