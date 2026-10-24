'use strict';
// The default model for agents with no model of their own moved from Fable 5 to
// Sonnet 5.5. A config.json saved before holds the old default as if chosen, so
// it is switched once; any other model, or Fable picked again later, is kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-default-model-'));
const electron = require.resolve('electron');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString()
};
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData }, safeStorage } };

const { readConfig, migrateDefaultModelV1 } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('a fresh install defaults agents to Sonnet 5.5', () => {
  assert.equal(readConfig().defaultModel, 'claude-sonnet-5-5');
});

test('the old Fable 5 default is switched to Sonnet 5.5 once', () => {
  const saved = [];
  const out = migrateDefaultModelV1({ defaultModel: 'claude-fable-5' }, (c) => saved.push(c));
  assert.equal(out.defaultModel, 'claude-sonnet-5-5');
  assert.equal(out.defaultModelMigratedV1, true);
  assert.equal(saved.length, 1, 'persisted');
});

test('a model the human picked is kept, and so is Fable picked after the migration', () => {
  // Each call below is a fresh config already marked migrated, as after the first run.
  assert.equal(migrateDefaultModelV1({ defaultModel: 'claude-opus-5-5', defaultModelMigratedV1: true }, () => {}).defaultModel, 'claude-opus-5-5');
  assert.equal(migrateDefaultModelV1({ defaultModel: 'claude-fable-5', defaultModelMigratedV1: true }, () => {}).defaultModel, 'claude-fable-5');
});
