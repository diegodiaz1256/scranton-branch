'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { MAX_AGENT_TOKEN_CAP } = loadTs('src/shared/tokenCaps.ts');

// config.ts resolves its file through Electron's app.getPath(). Point that one
// dependency at a throwaway userData root so this test never touches the real
// application config.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-agent-cap-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { readConfig, setAgentTokenCap, writeConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('consecutive agent caps survive an interleaved config update', () => {
  writeConfig({ agentTokenCaps: { existing: 50 } });

  setAgentTokenCap('jim', 100);
  writeConfig({ registeredRepos: ['/workspace/project'] });
  setAgentTokenCap('pam', 200);

  const config = readConfig();
  assert.deepEqual(config.agentTokenCaps, {
    existing: 50,
    jim: 100,
    pam: 200
  });
  // Repos are stored resolved (on Windows /workspace/project is <drive>:\workspace\project).
  assert.deepEqual(config.registeredRepos, [path.resolve('/workspace/project')]);
});

test('setting and clearing caps use the latest persisted map', () => {
  writeConfig({ agentTokenCaps: { existing: 50, obsolete: 75 } });

  setAgentTokenCap('jim', 100);
  setAgentTokenCap('obsolete', undefined);
  setAgentTokenCap('pam', 200);

  assert.deepEqual(readConfig().agentTokenCaps, {
    existing: 50,
    jim: 100,
    pam: 200
  });
});

test('invalid agent-cap IPC values cannot reach persisted config', () => {
  const baseline = { existing: 50 };
  writeConfig({ agentTokenCaps: baseline });
  for (const [agentId, tokenCap] of [
    ['', 100],
    [null, 100],
    ['jim', null],
    ['jim', 0],
    ['jim', -1],
    ['jim', 1.5],
    ['jim', Number.NaN],
    ['jim', MAX_AGENT_TOKEN_CAP + 1]
  ]) {
    assert.throws(() => setAgentTokenCap(agentId, tokenCap), /invalid agent token cap/i);
  }
  assert.deepEqual(readConfig().agentTokenCaps, baseline);
});


// ─── A temp's token cap: work tokens, a warning at 80%, and its last words ───
// Before: a temp over its cap was killed at once, with no warning and no partial
// result (only god was told), and the cap counted cached reads, which the
// breaker excludes from per-agent budgets (#189), so it tripped early.
const { workTokensOf } = loadTs('src/main/breaker.ts');
const { capStage, capDispatchNote, capWarningBody, lastOutboxMessage, lastWords, CAP_WARN_AT } = loadTs('src/main/workerCap.ts');

test('a temp cap counts work tokens, not cached reads', () => {
  const sample = { input: 10_000, output: 5_000, cacheRead: 900_000, cacheCreation: 20_000 };
  assert.equal(workTokensOf(sample), 35_000);
  assert.equal(workTokensOf(null), 0);
  // A 100k cap: the old total (935k) reaped this temp; its work is a third of the cap.
  assert.equal(capStage(workTokensOf(sample), 100_000, false), null);
});

test('the cap warns once at 80% and reaps only above it', () => {
  assert.equal(CAP_WARN_AT, 0.8);
  assert.equal(capStage(79_999, 100_000, false), null);
  assert.equal(capStage(80_000, 100_000, false), 'warn');
  assert.equal(capStage(95_000, 100_000, true), null, 'warned once is enough');
  assert.equal(capStage(100_000, 100_000, true), null, 'at the cap is not over it');
  assert.equal(capStage(100_001, 100_000, true), 'reap');
  assert.equal(capStage(100_001, 100_000, false), 'reap', 'a jump straight past the cap still reaps');
  assert.equal(capStage(10, 0, false), null, '0 = unlimited');
});

test('the temp is told its cap at dispatch and asked to wrap up at the warning', () => {
  assert.match(capDispatchNote(250_000), /budget of 250,000 tokens/);
  assert.match(capDispatchNote(250_000), /80%/);
  const warn = capWarningBody(200_000, 250_000);
  assert.match(warn, /200,000 of your 250,000-token budget \(80%\)/);
  assert.match(warn, /commit what you have/);
  assert.match(warn, /"act":"done"/);
});

test('the reap notice carries the temp\'s newest outbox message since it was hired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cap-last-'));
  try {
    const spawnedAt = Date.now() - 60_000;
    fs.mkdirSync(path.join(dir, 'outbox', '.sent'), { recursive: true });
    const put = (sub, name, msg, mtime) => {
      const fp = path.join(dir, 'outbox', sub, name);
      fs.writeFileSync(fp, JSON.stringify(msg));
      fs.utimesSync(fp, mtime / 1000, mtime / 1000);
    };
    assert.equal(lastOutboxMessage(dir, spawnedAt), null);
    assert.equal(lastWords(null), 'It sent nothing before it was stopped.');
    put('.sent', 'old.json', { act: 'done', subject: 'last hire', body: 'old' }, spawnedAt - 86_400_000);
    put('.sent', 'a.json', { act: 'inform', subject: 'progress', body: 'parsed 3 of 9 files', created_at: new Date(spawnedAt + 10_000).toISOString() }, spawnedAt + 10_000);
    // Offset-less stamp that reads as before the hire: dated by its mtime.
    put('', 'b.json', { act: 'inform', subject: 'partial', body: 'partial table in out/report.md', created_at: '2020-01-01T00:00:00' }, spawnedAt + 20_000);
    const last = lastOutboxMessage(dir, spawnedAt);
    assert.deepEqual(last, { act: 'inform', subject: 'partial', text: 'partial table in out/report.md' });
    assert.equal(lastWords(last), 'Its last message (inform, "partial"):\npartial table in out/report.md');
    assert.match(lastWords({ act: 'inform', subject: '', text: 'x'.repeat(5000) }, 100), /^Its last message \(inform\):\nx{99}…$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the worker tick warns before it reaps, and reaps with the last words', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(source, /function workerTokensUsed\(workerId: string\): number \{\s*return workTokensOf\(/);
  const stage = source.indexOf('capStage(used, tokenCap, !!rec.capWarned)');
  assert.ok(stage > 0, 'the tick asks capStage');
  const warn = source.indexOf('capWarningBody(', stage);
  const reap = source.indexOf('lastWords(lastOutboxMessage(', stage);
  assert.ok(warn > 0 && reap > 0, 'a warning request and a reap notice with the last words');
  assert.ok(source.indexOf('capDispatchNote(') > 0, 'the cap is in the work order');
});
