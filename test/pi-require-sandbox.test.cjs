'use strict';
/**
 * Settings → AI providers → "Refuse pi agents without an OS sandbox"
 * (config.piRequireSandbox, shared/piSandbox.ts): with it on, a pi agent where
 * the app cannot build its bubblewrap sandbox is not started, and its terminal
 * says why and how to install bubblewrap. Off (the default), nothing changes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { refusePiWithoutSandbox, piNoSandboxLines, piNoSandboxScript, BWRAP_INSTALL } = loadTs('src/shared/piSandbox.ts');

test('refused only for pi, only with the setting on, only without bubblewrap', () => {
  assert.equal(refusePiWithoutSandbox('pi', true, false), true);
  assert.equal(refusePiWithoutSandbox('pi', undefined, false), false, 'default off: it runs, badged "Not sandboxed"');
  assert.equal(refusePiWithoutSandbox('pi', false, false), false);
  assert.equal(refusePiWithoutSandbox('pi', true, true), false, 'bubblewrap there: it runs sandboxed');
  for (const p of ['claude', 'codex', 'opencode', undefined]) assert.equal(refusePiWithoutSandbox(p, true, false), false, `${p} has its own sandbox story`);
});

test('the explanation: why, and how to install bubblewrap where it can run', () => {
  const wsl = piNoSandboxLines('wsl', 'Ubuntu').join('\n');
  assert.match(wsl, /not started/);
  assert.match(wsl, /bubblewrap, which is not installed in WSL \(Ubuntu\)/);
  assert.ok(wsl.includes(BWRAP_INSTALL), 'the install command');
  assert.match(wsl, /Refuse pi agents without an OS sandbox/);
  assert.match(piNoSandboxLines('linux').join('\n'), /not installed on this machine/);
  const win = piNoSandboxLines('windows').join('\n');
  assert.match(win, /only on a Linux or WSL floor, not on native Windows/);
  assert.ok(!win.includes('apt'), 'nothing to install on Windows itself');
  assert.match(piNoSandboxLines('mac').join('\n'), /not on macOS/);
  assert.ok(!piNoSandboxLines('wsl', 'Ub"untu; rm -rf').join('').includes(';'), 'a distro name cannot inject');
});

const shown = (out) => out.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());

test('the script prints exactly those lines in the agent\'s terminal', () => {
  if (process.platform === 'win32') {
    // As PtyManager runs a shellScript on Windows: cmd.exe /d /s /c "<script>".
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${piNoSandboxScript('windows')}"`], { encoding: 'utf8', windowsVerbatimArguments: true });
    assert.deepEqual(shown(out), piNoSandboxLines('windows').map((l) => l.trimEnd()).filter((l) => l.trim()));
    assert.ok(!piNoSandboxScript('windows').includes('"'), 'no double quotes (wrapped verbatim)');
  }
  if (process.platform !== 'win32' || fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe')) {
    // As it runs on Linux and in a WSL distro: bash -lc <script>.
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
    const out = execFileSync(bash, ['-c', piNoSandboxScript('wsl', 'Ubuntu')], { encoding: 'utf8' });
    assert.deepEqual(shown(out), piNoSandboxLines('wsl', 'Ubuntu').map((l) => l.trimEnd()).filter((l) => l.trim()));
  }
});

test('the spawn path checks it before the hive prepares the agent, and returns the explaining terminal', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  const core = src.slice(src.indexOf('async function spawnAgentCore('));
  const check = core.indexOf('refusePiWithoutSandbox(provider, readConfig().piRequireSandbox, await hive.sandboxAvailable())');
  assert.ok(check > 0, 'spawnAgentCore asks');
  assert.ok(check < core.indexOf('hive.ensureAgent('), 'before the agent is prepared or started');
  assert.ok(check < core.indexOf('buildMissingCliScript('), 'before a missing pi would be installed');
  const branch = core.slice(check, core.indexOf('\n  }\n', check));
  assert.match(branch, /shellScript: piNoSandboxScript\(place, wslFloor\?\.distro\)/);
  assert.match(branch, /return res;/);
});
