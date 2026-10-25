// The offline cost estimate prices each Haiku generation at its own list price,
// instead of Haiku 3.5's $0.80/$4 for every Haiku.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { priceFor, estimateCostUsd } = loadTs('src/main/pricing.ts');

const row = (m) => {
  const p = priceFor(m);
  return [p.inputPerM, p.outputPerM, p.cacheReadPerM, p.cacheWritePerM];
};

test('Haiku 5.5 is priced at $0.10 / $0.50 per million', () => {
  assert.deepEqual(row('claude-haiku-5-5'), [0.1, 0.5, 0.01, 0.125]);
  assert.deepEqual(row('claude-haiku-5-5[1m]'), [0.1, 0.5, 0.01, 0.125]);
});

test('Haiku 4.5 is priced at $1 / $5 per million, in every id spelling', () => {
  for (const id of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4-5', 'claude-haiku-4.5']) {
    assert.deepEqual(row(id), [1, 5, 0.1, 1.25], id);
  }
});

test('the older Haikus keep their own prices', () => {
  assert.deepEqual(row('claude-3-5-haiku-20241022'), [0.8, 4, 0.08, 1.0]);
  assert.deepEqual(row('claude-3-haiku-20240307'), [0.25, 1.25, 0.03, 0.3]);
});

test('an unknown Haiku falls back to the dearer current row, not the cheapest', () => {
  assert.deepEqual(row('claude-haiku-next'), [1, 5, 0.1, 1.25]);
});

test('one million Haiku 5.5 output tokens cost $0.50', () => {
  const usd = estimateCostUsd('claude-haiku-5-5', { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(usd, 0.5);
});

test('Opus and Sonnet rows are untouched', () => {
  assert.equal(priceFor('claude-opus-4-8').inputPerM, 15);
  assert.equal(priceFor('claude-sonnet-5-5').inputPerM, 3);
});
