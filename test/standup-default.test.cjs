'use strict';
// The hourly ops standup ships OFF for a new install. An install with a saved
// config keeps whatever it has: on, off, or (for a config saved before
// missions existed) the old default, which was on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-standup-default-'));
const electron = require.resolve('electron');
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${Buffer.from(s).toString('hex')}`),
  decryptString: (b) => Buffer.from(String(b).slice(4), 'hex').toString()
};
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData }, safeStorage } };

const { readConfig, writeConfig, forgetConfigCache, OPS_STANDUP_MISSION } = loadTs('src/main/config.ts');
const configFile = path.join(userData, 'config.json');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function standup() {
  forgetConfigCache();
  return (readConfig().missions ?? []).find((m) => m.id === 'ops-standup');
}

function saveRaw(cfg) {
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2));
}

test('a new install lists the standup, switched off', () => {
  fs.rmSync(configFile, { force: true });
  const m = standup();
  assert.ok(m, 'still listed so the user can turn it on');
  assert.equal(m.enabled, false);
  assert.equal(m.intervalMs, OPS_STANDUP_MISSION.intervalMs);
});

test('a new install that saves its first setting keeps the standup off', () => {
  fs.rmSync(configFile, { force: true });
  forgetConfigCache();
  writeConfig({ onboardingComplete: true });
  assert.equal(standup().enabled, false);
});

test('a saved config with the standup on keeps it on', () => {
  saveRaw({ onboardingComplete: true, missions: [{ ...OPS_STANDUP_MISSION, enabled: true }] });
  assert.equal(standup().enabled, true);
});

test('a saved config with the standup off keeps it off', () => {
  saveRaw({ onboardingComplete: true, missions: [{ ...OPS_STANDUP_MISSION, enabled: false, lastFiredAt: 1 }] });
  assert.equal(standup().enabled, false);
});

test('a saved config from before missions existed keeps the old default (on)', () => {
  saveRaw({ onboardingComplete: true, harnessHome: null });
  assert.equal(standup().enabled, true);
});
