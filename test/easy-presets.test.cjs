'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { EASY_PRESETS, PRESET_KEYS, presetPatch, detectPreset, presetChanges, DEFAULT_VELOCITY_PER_MIN } = loadTs('src/shared/easyPresets.ts');
const { EASY_HIRE_ENGINE, EASY_HIRE_ROLES, easyHireRole } = loadTs('src/shared/easyHire.ts');

test('each preset round-trips: applying it reads back as that preset', () => {
  for (const p of EASY_PRESETS) assert.equal(detectPreset(presetPatch(p)), p);
});

test('a fresh config (all defaults) reads as Balanced', () => {
  assert.equal(detectPreset({}), 'balanced');
});

test('a setting changed by hand turns it into Custom', () => {
  const careful = presetPatch('careful');
  assert.equal(detectPreset({ ...careful, circuitBreaker: { ...careful.circuitBreaker, tokenVelocityPerMin: 45000 } }), 'custom');
  assert.equal(detectPreset({ ...presetPatch('balanced'), usageWindowAlerts: { fiveHourPct: 70, weeklyPct: 98 } }), 'custom');
  // Turning the breaker off matches no preset: every preset keeps it on.
  assert.equal(detectPreset({ circuitBreaker: { enabled: false } }), 'custom');
});

test('the velocity default and an explicit default value are the same thing', () => {
  assert.equal(detectPreset({ circuitBreaker: { tokenVelocityPerMin: DEFAULT_VELOCITY_PER_MIN } }), 'balanced');
});

test('presets only write the keys they own, and never switch the breaker off', () => {
  const current = {
    circuitBreaker: { enabled: false, repeatedToolLimit: 12, errorStormLimit: 9 },
    agentUnsandboxed: { a: true }, agentDocker: { a: true }, criticalConnections: [{ id: 'x' }], costCapTokens: 5
  };
  for (const p of EASY_PRESETS) {
    const patch = presetPatch(p, current);
    assert.deepEqual(Object.keys(patch).sort(), [...PRESET_KEYS].sort());
    assert.equal(patch.circuitBreaker.enabled, true);
    // The user's own breaker limits are carried over untouched.
    assert.equal(patch.circuitBreaker.repeatedToolLimit, 12);
    assert.equal(patch.circuitBreaker.errorStormLimit, 9);
    for (const k of ['agentUnsandboxed', 'agentDocker', 'agentSshRelay', 'agentCloudCredentials', 'criticalConnections', 'costCapTokens']) {
      assert.equal(k in patch, false, `${p} must not touch ${k}`);
    }
  }
});

test('Careful is the most cautious, Autonomous the only one where the orchestrator hires', () => {
  const c = presetPatch('careful'); const b = presetPatch('balanced'); const a = presetPatch('autonomous');
  assert.equal(c.autoMode, false);
  assert.equal(c.circuitBreaker.hardStop, true);
  assert.ok(c.circuitBreaker.tokenVelocityPerMin < DEFAULT_VELOCITY_PER_MIN);
  assert.ok(c.usageWindowAlerts.fiveHourPct < b.usageWindowAlerts.fiveHourPct);
  assert.deepEqual([c, b, a].map((x) => x.orchestratorMaySpawn), [false, false, true]);
});

test('every preset lists what it changes, one line per setting', () => {
  for (const p of EASY_PRESETS) assert.equal(presetChanges(p).length, 5);
  assert.deepEqual(presetChanges('careful'), ['autoOff', 'hireYou', 'breakerStop', 'velocitySlow', 'warnEarly']);
  assert.deepEqual(presetChanges('autonomous'), ['autoOn', 'hireBoth', 'breakerSteer', 'velocityDefault', 'warnDefault']);
});

test('easy hire starts on Claude Code with Sonnet 5.5, never a Fable model', () => {
  assert.equal(EASY_HIRE_ENGINE.provider, 'claude');
  assert.equal(EASY_HIRE_ENGINE.model, 'claude-sonnet-5-5');
  assert.doesNotMatch(EASY_HIRE_ENGINE.model, /fable/i);
});

test('every easy hire role but "other" fills a description and goal', () => {
  for (const r of EASY_HIRE_ROLES) {
    if (r.id === 'other') { assert.equal(r.description, ''); assert.equal(r.goal, ''); continue; }
    assert.ok(r.description.length > 0 && r.goal.length > 0, r.id);
  }
  assert.equal(easyHireRole('writing').id, 'writing');
  assert.equal(easyHireRole('nope').id, 'other');
});
