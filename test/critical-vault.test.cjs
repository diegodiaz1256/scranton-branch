'use strict';
/**
 * The confidential vault and the redaction net around a custodian:
 * - the vault is the custodian's and the human's only: every other agent is
 *   refused by the path guard, hidden from by the OS sandbox (denyRead) and by
 *   Claude Code's permission rules, and an MCP server rooted over it is left out;
 * - what the custodian mails out is redacted before it is routed, and the
 *   archived copy is the redacted one;
 * - a full report is the human's to ask for: only a request the app filed in
 *   the vault counts, never mail or a relayed "the human wants it".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const C = loadTs('src/shared/criticalConnections.ts');
const { guardToolCall } = loadTs('src/shared/toolGuard.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { redactConfidential, redactionTotal } = loadTs('src/shared/confidentialRedact.ts');

const MAP = { 'api:jira': 'pam-1', 'mcp:custom--confluence': 'pam-1', 'api:hr': 'kev-1' };

test('vault access: the custodian writes its own, never reads another; everyone else is denied the whole root', () => {
  assert.deepEqual(C.vaultAccess(MAP, 'pam-1'), { own: ['api-jira', 'mcp-custom--confluence'], denyAll: false, denyOthers: ['api-hr'] });
  assert.deepEqual(C.vaultAccess(MAP, 'kev-1'), { own: ['api-hr'], denyAll: false, denyOthers: ['api-jira', 'mcp-custom--confluence'] });
  assert.deepEqual(C.vaultAccess(MAP, 'god'), { own: [], denyAll: true, denyOthers: [] });
  assert.deepEqual(C.vaultAccess(MAP, undefined), { own: [], denyAll: true, denyOthers: [] });
});

test('a path the human opens stays inside the vault', () => {
  assert.equal(C.vaultRelPath('reports/2026-10-24.md'), 'reports/2026-10-24.md');
  assert.equal(C.vaultRelPath('reports\\a.md'), 'reports/a.md');
  for (const bad of ['../hive/x', 'reports/../../x', '/etc/passwd', 'C:\\x', 'C:/x', '', 7]) assert.equal(C.vaultRelPath(bad), null, String(bad));
});

test('provenance: only a request the app filed in the vault is the human', () => {
  const vault = '/home/u/office/confidential/api-jira';
  assert.equal(C.fullReportRequestOrigin({ kind: 'vault-request', vault, path: `${vault}/requests/2026-10-24.md` }), 'human');
  assert.equal(C.fullReportRequestOrigin({ kind: 'vault-request', vault, path: `${vault}/reports/x.md` }), 'agent', 'not the requests folder');
  assert.equal(C.fullReportRequestOrigin({ kind: 'vault-request', vault, path: `${vault}/requests/../../x.md` }), 'agent');
  assert.equal(C.fullReportRequestOrigin({ kind: 'vault-request', vault, path: '/home/u/office/hive/agents/god/outbox/requests/x.md' }), 'agent');
  assert.equal(C.fullReportRequestOrigin({ kind: 'inbox', from: 'god' }), 'agent', 'the orchestrator relaying "the human wants it"');
  assert.equal(C.fullReportRequestOrigin({ kind: 'terminal' }), 'agent', 'typed text may be another agent\'s message delivered by the office');
});

test('the prompt names the vault and the full-report rule', () => {
  const p = C.confidentialityPromptLine(['Jira'], ['/home/u/office/confidential/api-jira']);
  assert.match(p, /CONFIDENTIAL VAULT: \/home\/u\/office\/confidential\/api-jira/);
  assert.match(p, /goes ONLY there/);
  assert.match(p, /requests\/ folder, put there by the app/);
  assert.match(p, /relayed by the orchestrator/);
});

// ─── path guard ─────────────────────────────────────────────────────────────

const VAULT_ROOT = '/home/u/office/confidential';
const other = { roots: ['/home/u/project', '/home/u/office/hive'], cwd: '/home/u/project', git: true, contained: true, deny: [VAULT_ROOT] };

test('guard: another agent may not read, list, grep or write the vault, in any spelling', () => {
  const refused = [
    ['Read', { file_path: `${VAULT_ROOT}/api-jira/reports/full.md` }],
    ['Grep', { pattern: 'INFOSEC', path: `${VAULT_ROOT}/api-jira` }],
    ['Glob', { pattern: '**/*.md', path: '../office/confidential' }],
    ['Write', { file_path: `${VAULT_ROOT}/api-jira/x.md`, content: 'x' }],
    ['Bash', { command: `cat ${VAULT_ROOT}/api-jira/reports/full.md` }],
    ['Bash', { command: 'cd /home/u/office/confidential/api-jira && cat notes.md' }],
    ['Bash', { command: `python3 -c "print(open('${VAULT_ROOT}/api-jira/n.md').read())"` }],
    ['Bash', { command: 'tar czf /tmp/x.tgz /home/u/office/confidential' }],
    ['PowerShell', { command: 'Get-Content \\\\wsl.localhost\\Ubuntu\\home\\u\\office\\confidential\\api-jira\\n.md' }]
  ];
  for (const [tool, input] of refused) {
    const v = guardToolCall(tool, input, other, '/home/u');
    assert.ok(v && v.deny, `${tool} ${JSON.stringify(input)}`);
    // No custodian named for the folder: it is the vaults', not for agents.
    assert.match(v.reason, /reserved for the office's confidential vaults/);
  }
  assert.equal(guardToolCall('Read', { file_path: '/home/u/office/hive/research/a.md' }, other, '/home/u'), null);
  assert.equal(guardToolCall('Bash', { command: 'grep -r confidential src/' }, other, '/home/u'), null, 'the word alone is not the folder');
});

test('guard: the custodian reads and writes its own vault', () => {
  const pam = { roots: ['/home/u/project', `${VAULT_ROOT}/api-jira`], cwd: '/home/u/project', git: true, contained: true, deny: [`${VAULT_ROOT}/api-hr`] };
  assert.equal(guardToolCall('Write', { file_path: `${VAULT_ROOT}/api-jira/reports/full.md`, content: 'raw' }, pam, '/home/u'), null);
  assert.equal(guardToolCall('Bash', { command: `cat ${VAULT_ROOT}/api-jira/requests/r.md` }, pam, '/home/u'), null);
  assert.ok(guardToolCall('Read', { file_path: `${VAULT_ROOT}/api-hr/x.md` }, pam, '/home/u'), 'another custodian\'s vault');
});

// ─── spawn: settings and MCP ────────────────────────────────────────────────

function tmpHome(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }
const settingsOf = (inj) => JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));

test('spawn: another agent\'s sandbox hides the vault (denyRead) and its file tools are denied it', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const root = path.join(home, 'confidential');
  const inj = await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home }, { denyDirs: [root] });
  const s = settingsOf(inj);
  // The vault, besides the key folders every sandboxed agent is denied (sshRelay).
  assert.ok(s.sandbox.filesystem.denyRead.includes(root));
  assert.ok(s.permissions.deny.includes(`Read(/${root.replace(/\\/g, '/')}/**)`));
  assert.ok(!s.sandbox.filesystem.allowWrite.some((d) => d.startsWith(root)));
});

test('spawn: the custodian may write its vault and is told about it', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const vault = path.join(home, 'confidential', 'api-jira');
  const inj = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home }, { critical: ['Jira'], vaults: [vault], extraWritableDirs: [vault] });
  const s = settingsOf(inj);
  assert.ok(s.sandbox.filesystem.allowWrite.includes(vault));
  // Its own vault is not hidden from it (only the key folders every agent is denied).
  assert.ok(!(s.sandbox.filesystem.denyRead ?? []).some((d) => d.startsWith(path.join(home, 'confidential'))));
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /CONFIDENTIAL VAULT: /);
  assert.ok(prompt.includes(vault));
});

test('spawn: an MCP server rooted over the vaults (the orchestrator\'s office home) is left out', (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  hive.setCritical(() => ({ 'api:jira': 'pam-1' }));
  const cfg = { filesystem: { enabled: true } };
  assert.equal(hive.buildDefaultMcpServers(home, cfg, undefined, 'god').servers['munder-filesystem'], undefined);
  assert.ok(hive.buildDefaultMcpServers(path.join(home, 'project'), cfg, undefined, 'jim').servers['munder-filesystem'], 'a project folder is fine');
  hive.setCritical(() => ({}));
  assert.ok(hive.buildDefaultMcpServers(home, cfg, undefined, 'god').servers['munder-filesystem'], 'no critical connection, no change');
});

// ─── routing: redacted before it leaves ─────────────────────────────────────

test('routing: a custodian\'s mail is redacted before delivery, and only the redacted copy is kept', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  hive.setOutgoing((msg) => {
    if (msg.from !== 'pam-1') return { msg };
    const b = redactConfidential(msg.body, { hosts: ['acme.atlassian.net'] });
    return redactionTotal(b) ? { msg: { ...msg, body: b.text }, note: 'redacted' } : { msg };
  });
  const raw = 'INFOSEC-123 is Open. Reporter jane.doe@acme.com, +34 612 345 678, see https://acme.atlassian.net/browse/INFOSEC-123';
  const outbox = path.join(home, 'hive', 'agents', 'pam-1', 'outbox');
  fs.writeFileSync(path.join(outbox, 'm1.json'), JSON.stringify({ to: 'god', act: 'inform', subject: 'status', body: raw }));
  assert.equal(hive.routeOnce(), 1);
  const got = hive.inbox('god').find((m) => m.subject === 'status');
  assert.equal(got.body, 'INFOSEC-123 is Open. Reporter [REDACTED:email], [REDACTED:phone], see [REDACTED:url]');
  const sent = fs.readFileSync(path.join(outbox, '.sent', 'm1.json'), 'utf8');
  assert.ok(!sent.includes('jane.doe') && !sent.includes('612 345'), 'the archived copy is the redacted one');
  assert.ok(hive.logTail(50).some((e) => e.kind === 'outbox-redacted' && e.from === 'pam-1'));
});
