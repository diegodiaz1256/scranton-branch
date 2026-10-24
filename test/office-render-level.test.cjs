'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  parseOfficeRenderSetting, effectiveOfficeLevel, shouldRecommendLighter, decideAutoLevel, autoTarget,
  countRecentStalls, stillGlyphFor, INITIAL_AUTO_STATE, MANY_AGENTS, MANY_AGENTS_CLEAR,
  RECOVER_AFTER_MS, STALL_WINDOW_MS, STALLS_FOR_CARDS
} = loadTs('src/shared/officeRenderLevel.ts');

const calm = { onBattery: false, recentStalls: 0, agentCount: 3 };

test('a missing or unknown setting is the full floor', () => {
  assert.equal(parseOfficeRenderSetting(null), 'full');
  assert.equal(parseOfficeRenderSetting('fancy'), 'full');
  assert.equal(parseOfficeRenderSetting(3), 'full');
  for (const s of ['full', 'still', 'cards', 'auto']) assert.equal(parseOfficeRenderSetting(s), s);
});

test('auto resolves to what auto decided; a fixed level is itself', () => {
  assert.equal(effectiveOfficeLevel('auto', 'cards'), 'cards');
  assert.equal(effectiveOfficeLevel('still', 'cards'), 'still');
  assert.equal(effectiveOfficeLevel('full', 'still'), 'full');
});

test('the suggestion shows only on the full floor, above the threshold, until dismissed', () => {
  assert.equal(shouldRecommendLighter({ setting: 'full', agentCount: MANY_AGENTS, dismissed: false }), false);
  assert.equal(shouldRecommendLighter({ setting: 'full', agentCount: MANY_AGENTS + 1, dismissed: false }), true);
  assert.equal(shouldRecommendLighter({ setting: 'full', agentCount: 20, dismissed: true }), false);
  assert.equal(shouldRecommendLighter({ setting: 'still', agentCount: 20, dismissed: false }), false);
  assert.equal(shouldRecommendLighter({ setting: 'auto', agentCount: 20, dismissed: false }), false);
});

test('auto target: battery or a freeze stops the walking, both pressures drop the office', () => {
  assert.equal(autoTarget(calm, false), 'full');
  assert.equal(autoTarget({ ...calm, onBattery: true }, false), 'still');
  assert.equal(autoTarget({ ...calm, recentStalls: 1 }, false), 'still');
  assert.equal(autoTarget(calm, true), 'still');
  assert.equal(autoTarget({ ...calm, onBattery: true }, true), 'cards');
  assert.equal(autoTarget({ ...calm, recentStalls: STALLS_FOR_CARDS }, false), 'cards');
});

test('auto drops to a lighter level at once', () => {
  const s = decideAutoLevel(INITIAL_AUTO_STATE, { ...calm, onBattery: true }, 1000);
  assert.equal(s.level, 'still');
  const s2 = decideAutoLevel(s, { ...calm, onBattery: true, recentStalls: STALLS_FOR_CARDS }, 2000);
  assert.equal(s2.level, 'cards');
});

test('auto goes back only after the signals stay calm for the recovery time', () => {
  let s = decideAutoLevel(INITIAL_AUTO_STATE, { ...calm, onBattery: true }, 0);
  assert.equal(s.level, 'still');
  s = decideAutoLevel(s, calm, 10_000);             // plugged in
  assert.equal(s.level, 'still');
  s = decideAutoLevel(s, calm, 10_000 + RECOVER_AFTER_MS - 1);
  assert.equal(s.level, 'still');
  s = decideAutoLevel(s, calm, 10_000 + RECOVER_AFTER_MS);
  assert.equal(s.level, 'full');
  assert.equal(s.calmSince, null);
});

test('a blip of pressure during the calm period restarts the clock (no flapping)', () => {
  let s = decideAutoLevel(INITIAL_AUTO_STATE, { ...calm, onBattery: true }, 0);
  s = decideAutoLevel(s, calm, 1_000);                       // calm starts
  s = decideAutoLevel(s, { ...calm, onBattery: true }, 30_000); // unplugged again
  assert.equal(s.level, 'still');
  assert.equal(s.calmSince, null);
  s = decideAutoLevel(s, calm, 40_000);
  s = decideAutoLevel(s, calm, 40_000 + RECOVER_AFTER_MS - 1);
  assert.equal(s.level, 'still');
  s = decideAutoLevel(s, calm, 40_000 + RECOVER_AFTER_MS);
  assert.equal(s.level, 'full');
});

test('the agent count has its own hysteresis band', () => {
  let s = decideAutoLevel(INITIAL_AUTO_STATE, { ...calm, agentCount: MANY_AGENTS }, 0);
  assert.equal(s.level, 'full');
  s = decideAutoLevel(s, { ...calm, agentCount: MANY_AGENTS + 1 }, 1);
  assert.equal(s.level, 'still');
  assert.equal(s.manyAgents, true);
  // Back down to the threshold but not below the clear mark: still "many".
  s = decideAutoLevel(s, { ...calm, agentCount: MANY_AGENTS_CLEAR + 1 }, 2);
  s = decideAutoLevel(s, { ...calm, agentCount: MANY_AGENTS_CLEAR + 1 }, 2 + RECOVER_AFTER_MS * 2);
  assert.equal(s.level, 'still');
  s = decideAutoLevel(s, { ...calm, agentCount: MANY_AGENTS_CLEAR }, 3 + RECOVER_AFTER_MS * 2);
  assert.equal(s.manyAgents, false);
  s = decideAutoLevel(s, { ...calm, agentCount: MANY_AGENTS_CLEAR }, 3 + RECOVER_AFTER_MS * 3);
  assert.equal(s.level, 'full');
});

test('from no office, recovery goes straight to what the signals allow', () => {
  let s = decideAutoLevel(INITIAL_AUTO_STATE, { ...calm, recentStalls: STALLS_FOR_CARDS }, 0);
  assert.equal(s.level, 'cards');
  s = decideAutoLevel(s, { ...calm, recentStalls: 1 }, 1);   // fewer freezes: still lighter than full
  s = decideAutoLevel(s, { ...calm, recentStalls: 1 }, 1 + RECOVER_AFTER_MS);
  assert.equal(s.level, 'still');
});

test('freezes count inside the window and after the start mark only', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');
  const at = (msAgo) => ({ at: new Date(now - msAgo).toISOString() });
  const entries = [at(1_000), at(60_000), at(STALL_WINDOW_MS + 1), at(-5_000), { at: 'garbage' }];
  assert.equal(countRecentStalls(entries, now), 2);
  assert.equal(countRecentStalls(entries, now, now - 30_000), 1);
  assert.equal(countRecentStalls([], now), 0);
});

test('status → the icon over a seated head', () => {
  assert.equal(stillGlyphFor('working'), 'typing');
  assert.equal(stillGlyphFor('thinking'), 'typing');
  assert.equal(stillGlyphFor('waiting'), 'waiting');
  assert.equal(stillGlyphFor('blocked'), 'asking');
  assert.equal(stillGlyphFor('looping'), 'stuck');
  assert.equal(stillGlyphFor('compacting'), 'compacting');
  assert.equal(stillGlyphFor('success'), 'success');
  assert.equal(stillGlyphFor('idle'), 'none');
  assert.equal(stillGlyphFor('ghost'), 'none');
});
