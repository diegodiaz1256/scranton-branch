#!/usr/bin/env node
/**
 * Smoke test for the server build (out/server): a fresh office comes up with no
 * GUI, the orchestrator spawns (a stand-in agent, tools/demo-agent.cjs, so no
 * real CLI or login is needed), and SIGTERM shuts it all down.
 *
 *   node tools/build-server.cjs && (cd out/server && npm install --omit=dev)
 *   node tools/server-smoke.cjs
 */
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');

const root = resolve(__dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'md-server-'));
const data = join(dir, 'data');
const office = join(dir, 'office');
mkdirSync(data);
writeFileSync(join(data, 'config.json'), JSON.stringify({
  godProvider: 'custom',
  autoMode: true,
  defaultCommand: `node "${join(root, 'tools', 'demo-agent.cjs').split('\\').join('/')}"`
}));

const child = spawn(process.execPath, [join(root, 'out/server/index.cjs'), '--office', office, '--name', 'Smoke'], {
  env: { ...process.env, SB_DATA_DIR: data, SB_MAX_WORKERS: '2' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

const fail = (why) => {
  console.error(`FAIL: ${why}\n--- server log ---\n${log}`);
  try { child.kill('SIGKILL'); } catch { /* gone */ }
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  let god = null;
  while (Date.now() - t0 < 90_000) {
    if (exited) fail(`server exited early (${JSON.stringify(exited)})`);
    try {
      const reg = JSON.parse(readFileSync(join(office, 'hive', 'registry.json'), 'utf8'));
      god = Object.values(reg.agents ?? reg).find((a) => a && a.id === 'god' && a.sessionId);
      if (god) break;
    } catch { /* not yet */ }
    await sleep(1000);
  }
  if (!god) fail('the orchestrator never started');
  console.log(`ok: ${god.name} is up after ${Date.now() - t0} ms`);
  if (!/floor engine running/.test(log)) fail('the floor engine did not report in');
  const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
  if (cfg.maxConcurrentWorkers !== 2) fail(`SB_MAX_WORKERS not applied (${cfg.maxConcurrentWorkers})`);
  if (cfg.onboardingComplete !== true) fail('--office did not complete onboarding');

  if (process.platform === 'win32') { child.kill(); console.log('ok (shutdown not checked on Windows)'); return; }
  child.kill('SIGTERM');
  const t1 = Date.now();
  while (!exited && Date.now() - t1 < 30_000) await sleep(250);
  if (!exited) fail('did not stop within 30 s of SIGTERM');
  console.log(`ok: stopped ${Date.now() - t1} ms after SIGTERM (${JSON.stringify(exited)})`);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
})().catch((e) => fail(e.stack));
