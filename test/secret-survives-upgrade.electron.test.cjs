'use strict';
/**
 * A REST grant (Jira) answered 503 no_secret after the upgrade to v1.1.0 while
 * Connections showed the key as saved: the floor it ran in could not decrypt
 * the key copied into it (fixed by alignFloorKey, d024c18f). The broker maps an
 * undefined getSecret to 503 no_secret (integrationBroker.ts), so these check
 * getSecret/hasSecret with the real safeStorage, each step a new app process
 * (fresh modules, Local State read again at startup):
 *
 * - the same profile reads its key back after a restart (an upgrade);
 * - a floor seeded from it (New Floor) reads the copied key.
 *
 * Windows only: there safeStorage's key lives in <userData>/Local State, which
 * is what made a floor's key differ. macOS and Linux take it from the keychain
 * by app name (and would prompt or have no keyring on a CI box).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const FIXTURE = path.join(__dirname, 'fixtures', 'secret-profile-main.cjs');
const skip = process.platform !== 'win32' && 'safeStorage keeps its key in Local State only on Windows';

/** One app process with the fixture as its main; its JSON result. */
async function runApp(args) {
  const electronBin = require('electron');
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-secret-run-')), 'out.json');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [FIXTURE, ...args, `--out=${out}`], { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* gone */ }
      resolve('timeout');
    }, 60_000);
    child.on('exit', (c) => { clearTimeout(t); resolve(c); });
  });
  assert.equal(code, 0, `app exited ${code}:\n${log}`);
  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.error, undefined, result.error);
  return result;
}

test('a stored integration key is still readable after the app restarts on the same profile', { skip }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-secret-upgrade-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const stored = await runApp([`--user-data=${userData}`, '--store=jira-secret=jira-token-123']);
  assert.equal(stored.stored, true);
  assert.ok(!fs.readFileSync(path.join(userData, 'integration-secrets.json'), 'utf8').includes('jira-token-123'), 'encrypted at rest');

  const read = await runApp([`--user-data=${userData}`, '--read=jira-secret']);
  assert.equal(read.value, 'jira-token-123');
  assert.equal(read.has, true);
});

test('a floor reads the key copied into it from the main profile', { skip }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-secret-floor-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const id = 'abcdef12';
  const stored = await runApp([`--user-data=${userData}`, '--store=jira-secret=jira-token-456', `--seed-floor=${id}`]);
  assert.equal(stored.stored, true);
  const floorDir = path.join(userData, 'floors', id);
  assert.equal(path.resolve(stored.seeded), path.resolve(floorDir));
  assert.ok(fs.existsSync(path.join(floorDir, 'integration-secrets.json')), 'seedFloor copied the encrypted keys');

  const read = await runApp([`--user-data=${userData}`, '--read=jira-secret', `--md-floor=${id}`]);
  assert.equal(path.resolve(read.userData), path.resolve(floorDir), 'ran as the floor');
  assert.equal(read.value, 'jira-token-456', 'decrypted in the floor (else the broker answers 503 no_secret)');
  assert.equal(read.has, true);

  // And again, as after an upgrade of an app that already ran the floor.
  const again = await runApp([`--user-data=${userData}`, '--read=jira-secret', `--md-floor=${id}`]);
  assert.equal(again.value, 'jira-token-456');
  // The main profile still reads it too.
  assert.equal((await runApp([`--user-data=${userData}`, '--read=jira-secret'])).value, 'jira-token-456');
});
