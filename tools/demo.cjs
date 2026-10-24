#!/usr/bin/env node
'use strict';
/**
 * `npm run demo` — open the app on a seeded demo office, in the Pro layout,
 * with pretend agents that spend no tokens. Isolated from your real office and
 * config (see src/main/demo.ts), so it can run next to a normal instance.
 *
 *   npm run demo          seed .demo/ if it is missing, then launch
 *   npm run demo:reset    re-seed .demo/ from scratch, then launch
 *
 * Pass --no-launch to only seed. Anything else is handed to electron-vite, e.g.
 *   npm run demo -- --remoteDebuggingPort 9222
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { seedDemo, DEFAULT_DEMO_HOME } = require('./seed-demo-hive.cjs');

const reset = process.argv.includes('--reset');
const launch = !process.argv.includes('--no-launch');
const home = DEFAULT_DEMO_HOME;

if (reset || !fs.existsSync(path.join(home, 'userData', 'config.json'))) {
  const out = seedDemo({ home });
  console.log(`[demo] seeded ${out.home}${out.hasRepo ? '' : ' (git not found: no temp, no worktrees)'}`);
} else {
  console.log(`[demo] reusing ${home} (npm run demo:reset to start over)`);
}

if (launch) {
  // electron-vite's package `exports` hide its bin, so resolve it by path.
  const cli = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
  const passThrough = process.argv.slice(2).filter((a) => a !== '--reset' && a !== '--no-launch');
  const child = spawn(process.execPath, [cli, 'dev', ...passThrough], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, SB_DEMO_HOME: home }
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
