// The offline cost estimate prices each Opus generation at its own list price,
// instead of the old $15/$75 for every Opus.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { priceFor, estimateCostUsd } = loadTs('src/main/pricing.ts');

const row = (m) => {
  const p = priceFor(m);
  return [p.inputPerM, p.outputPerM, p.cacheReadPerM, p.cacheWritePerM];
};

const OPUS_5_5 = [4, 20, 0.2, 5];
const OPUS_4_6 = [5, 25, 0.5, 6.25];
const LEGACY = [15, 75, 1.5, 18.75];

test('Opus 5.5 is priced at $4 / $20 per million, cache reads $0.20', () => {
  for (const id of ['claude-opus-5-5', 'claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5', 'anthropic.claude-opus-5-5', 'claude-opus-5.5']) {
    assert.deepEqual(row(id), OPUS_5_5, id);
  }
});

test('Opus 5, 4.8, 4.7 and 4.6 are priced at $5 / $25 per million', () => {
  for (const id of [
    'claude-opus-5',
    'claude-opus-5[1m]',
    'claude-opus-4-8',
    'claude-opus-4-8[1m]',
    'claude-opus-4-8-high',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-opus-4.7'
  ]) {
    assert.deepEqual(row(id), OPUS_4_6, id);
  }
});

test('Opus 4.5, 4.1, 4 and Claude 3 Opus keep the $15 / $75 row', () => {
  for (const id of [
    'claude-opus-4-5',
    'claude-opus-4-5-20251101',
    'claude-opus-4-5@20251101',
    'claude-opus-4-1',
    'claude-opus-4-1-20250805',
    'anthropic/claude-opus-4-1',
    'claude-opus-4-0',
    'claude-opus-4-20250514',
    'claude-3-opus-20240229'
  ]) {
    assert.deepEqual(row(id), LEGACY, id);
  }
});

test('an unknown or future Opus is priced as the newest known one', () => {
  for (const id of ['opus', 'claude-opus-6', 'claude-opus-5-7', 'claude-opus-next']) {
    assert.deepEqual(row(id), OPUS_5_5, id);
  }
});

test('one million Opus 4.8 output tokens cost $25', () => {
  const usd = estimateCostUsd('claude-opus-4-8', { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(usd, 25);
});
