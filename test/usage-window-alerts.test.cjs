'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const {
  DEFAULT_USAGE_ALERT_THRESHOLDS,
  REARM_MARGIN,
  decideUsageAlerts,
  normalizeThresholds,
  usageNoticeBody,
  usageNoticeSubject
} = loadTs('src/shared/usageWindowAlerts.ts');
const { UsageAlertMonitor, USAGE_ALERTS_FILE } = loadTs('src/main/usageAlerts.ts');

const H = 3_600_000;
const NOW = Date.parse('2026-10-24T12:00:00Z');
const TH = DEFAULT_USAGE_ALERT_THRESHOLDS;
const rl = (five, week, opts = {}) => ({
  at: NOW,
  ...(five != null ? { fiveHour: { pct: five, resetsAt: opts.fiveReset ?? NOW + 2 * H } } : {}),
  ...(week != null ? { sevenDay: { pct: week, resetsAt: opts.weekReset ?? NOW + 72 * H } } : {})
});

/** Feed readings in order; return every notice and the final marks. */
function run(readings, th = TH, marks = {}) {
  const all = [];
  for (const [r, now] of readings) {
    const out = decideUsageAlerts(r, marks, th, now ?? NOW);
    all.push(...out.notices);
    marks = out.marks;
  }
  return { notices: all, marks };
}

test('defaults are 95% for the 5-hour window and 98% for the week', () => {
  assert.deepEqual(TH, { fiveHourPct: 95, weeklyPct: 98 });
  assert.deepEqual(normalizeThresholds(undefined), TH);
  assert.deepEqual(normalizeThresholds({ fiveHourPct: 80.4, weeklyPct: 250 }), { fiveHourPct: 80, weeklyPct: 100 });
  assert.deepEqual(normalizeThresholds({ fiveHourPct: -1, weeklyPct: NaN }), TH);
});

test('below the thresholds nothing is sent', () => {
  const { notices, marks } = run([[rl(94, 97)]]);
  assert.equal(notices.length, 0);
  assert.deepEqual(marks, {});
});

test('crossing a threshold notifies once per window, not on later ticks', () => {
  const { notices } = run([[rl(95, 50)], [rl(96, 50)], [rl(97, 98)], [rl(97, 99)], [rl(98, 99)]]);
  assert.deepEqual(notices.map((n) => [n.window, n.level, n.pct, n.threshold]), [
    ['fiveHour', 'near', 95, 95],
    ['sevenDay', 'near', 98, 98]
  ]);
});

test('hitting 100% earns one more notice, then silence', () => {
  const { notices } = run([[rl(96)], [rl(100)], [rl(100)], [rl(99)]]);
  assert.deepEqual(notices.map((n) => n.level), ['near', 'limit']);
});

test('jumping straight to 100% sends only the limit notice', () => {
  const { notices } = run([[rl(80)], [rl(100)]]);
  assert.deepEqual(notices.map((n) => n.level), ['limit']);
});

test('hysteresis: a wobble around the line does not repeat; a real drop re-arms', () => {
  const wobble = run([[rl(95)], [rl(94)], [rl(95)], [rl(95 - REARM_MARGIN)], [rl(96)]]);
  assert.equal(wobble.notices.length, 1);
  const dropped = run([[rl(95)], [rl(95 - REARM_MARGIN - 1)], [rl(96)]]);
  assert.equal(dropped.notices.length, 2);
});

test('a reset re-arms: the reset time passed, or a new window began', () => {
  // The old window's reset passed: the mark is dropped even with no reading for it.
  const first = decideUsageAlerts(rl(96), {}, TH, NOW);
  const later = decideUsageAlerts({ at: NOW }, first.marks, TH, NOW + 3 * H);
  assert.deepEqual(later.marks, {});
  assert.equal(later.changed, true);
  // A new window (reset moved five hours on) at high use notifies again.
  const next = run([[rl(96)], [rl(97, null, { fiveReset: NOW + 7 * H }), NOW + H]]);
  assert.equal(next.notices.length, 2);
  // Small jitter in the reported reset time is the same window.
  const jitter = run([[rl(96)], [rl(97, null, { fiveReset: NOW + 2 * H + 60_000 })]]);
  assert.equal(jitter.notices.length, 1);
});

test('a reading without a window keeps its mark; unchanged marks report unchanged', () => {
  const first = decideUsageAlerts(rl(96), {}, TH, NOW);
  const quiet = decideUsageAlerts({ at: NOW, sevenDay: { pct: 10 } }, first.marks, TH, NOW + 60_000);
  assert.equal(quiet.notices.length, 0);
  assert.equal(quiet.changed, false);
  assert.ok(quiet.marks.fiveHour);
});

test('custom thresholds apply per window', () => {
  const { notices } = run([[rl(81, 90)]], normalizeThresholds({ fiveHourPct: 80, weeklyPct: 90 }));
  assert.deepEqual(notices.map((n) => n.window), ['fiveHour', 'sevenDay']);
});

test('the notice says which window, how much, when it resets and what to do; god gets dispatch advice', () => {
  const n = { window: 'fiveHour', level: 'near', pct: 96.4, threshold: 95, resetsAt: NOW + 2 * H + 5 * 60_000 };
  assert.match(usageNoticeSubject(n, 'Claude Code'), /Usage window nearly spent: Claude Code 5-hour window at 96%/);
  const worker = usageNoticeBody(n, { account: 'Claude Code', orchestrator: false, now: NOW });
  assert.match(worker, /96% of its 5-hour usage window/);
  assert.match(worker, /2026-10-24T14:05:00\.000Z \(in 2h 05m\)/);
  assert.match(worker, /handoff note/);
  assert.match(worker, /Commit or save your work/);
  assert.doesNotMatch(worker, /Stop dispatching/);
  const god = usageNoticeBody(n, { account: 'Claude Code', orchestrator: true, now: NOW });
  assert.match(god, /Stop dispatching new workers and temps/);
  assert.match(god, /Pause non-urgent work/);
  assert.match(usageNoticeSubject({ ...n, level: 'limit', pct: 100 }, 'Claude Code'), /Usage limit reached/);
});

test('the monitor notifies every live agent once and remembers it across a restart', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-alerts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sent = [];
  const changes = [];
  const deps = {
    root: () => root,
    thresholds: () => TH,
    targets: (provider) => provider === 'claude'
      ? [{ id: 'god', orchestrator: true }, { id: 'jim', orchestrator: false }]
      : [{ id: 'god', orchestrator: true }],
    accountName: (p) => (p === 'claude' ? 'Claude Code' : p),
    send: (to, subject, body) => sent.push({ to, subject, body }),
    onChange: (a) => changes.push(a)
  };
  const m = new UsageAlertMonitor(deps);
  m.observe('claude', rl(90, 50), NOW);
  assert.equal(sent.length, 0);
  m.observe('claude', rl(96, 50), NOW);
  m.observe('claude', rl(97, 50), NOW + 60_000);
  assert.deepEqual(sent.map((s) => s.to), ['god', 'jim']);
  assert.match(sent[0].body, /You are the orchestrator/);
  assert.doesNotMatch(sent[1].body, /You are the orchestrator/);
  assert.deepEqual(m.active(NOW).map((a) => [a.provider, a.window, a.level]), [['claude', 'fiveHour', 'near']]);
  assert.ok(fs.existsSync(path.join(root, USAGE_ALERTS_FILE)));

  // A new app session reads the marks back: same window, no repeat.
  const again = new UsageAlertMonitor(deps);
  again.observe('claude', rl(97, 50), NOW + 2 * 60_000);
  assert.equal(sent.length, 2);
  // The limit still gets through, to both.
  again.observe('claude', rl(100, 50), NOW + 3 * 60_000);
  assert.deepEqual(sent.slice(2).map((s) => [s.to, /Usage limit reached/.test(s.subject)]), [['god', true], ['jim', true]]);
  // After the reset, the window is quiet in the chip.
  assert.deepEqual(again.active(NOW + 3 * H), []);
});
