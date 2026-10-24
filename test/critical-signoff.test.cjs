'use strict';
/**
 * Nothing a custodian sends out leaves without the human's sign-off, and the
 * app (not the agent's good behaviour) is what holds it. One test per way out:
 *   1. mail: held by the router whatever its fields, delivered only on approval;
 *   2. files: the custodian writes only its own folder and its vaults (guard
 *      and OS sandbox), so research/, other agents and the project are refused;
 *   3. memory: its folder stays out of the hive's history and away from the
 *      shared palace and the memory server;
 *   4. network: its shell reaches no host, no web tools, no other servers;
 *   5. what others could read of it (its folder, its transcripts) is denied;
 *   6. engine: only Claude Code can be a custodian.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const S = loadTs('src/shared/criticalSignoff.ts');
const C = loadTs('src/shared/criticalConnections.ts');
const { guardToolCall } = loadTs('src/shared/toolGuard.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const sha = (t) => createHash('sha256').update(t).digest('hex');
const ITEM = { id: 'msg-1', kind: 'message', from: 'pam-1', createdAt: 1, to: 'god', act: 'inform', subject: 'INFOSEC-123', text: 'Open, reporter [REDACTED:email].', redactions: { email: 1 } };

test('decide: approve as shown delivers exactly that and audits its hash', () => {
  const o = S.decide(ITEM, { action: 'approve' }, 42, sha);
  assert.deepEqual(o.deliver, { subject: 'INFOSEC-123', text: 'Open, reporter [REDACTED:email].', edited: false });
  assert.equal(o.bounce, undefined);
  assert.equal(o.audit.action, 'approved');
  assert.equal(o.audit.by, 'human');
  assert.equal(o.audit.at, 42);
  assert.equal(o.audit.sha256, sha('INFOSEC-123\nOpen, reporter [REDACTED:email].'));
});

test('decide: the human\'s edit is what leaves, marked as edited', () => {
  const o = S.decide(ITEM, { action: 'approve', text: 'INFOSEC-123 is open.' }, 1, sha);
  assert.equal(o.deliver.text, 'INFOSEC-123 is open.');
  assert.equal(o.deliver.edited, true);
  assert.equal(o.audit.action, 'approved-edited');
  assert.equal(o.audit.sha256, sha('INFOSEC-123\nINFOSEC-123 is open.'));
});

test('decide: reject sends nothing out and the reason back; anything malformed is a reject', () => {
  const o = S.decide(ITEM, { action: 'reject', reason: 'Too much detail.' }, 1, sha);
  assert.equal(o.deliver, undefined);
  assert.match(o.bounce.subject, /^\[not sent\]/);
  assert.match(o.bounce.body, /Reason: Too much detail\./);
  assert.equal(o.audit.action, 'rejected');
  for (const bad of [null, {}, { action: 'approved' }, { action: 'APPROVE' }]) assert.equal(S.decide(ITEM, bad, 1, sha).deliver, undefined, JSON.stringify(bad));
});

test('deliverable names: plain names only', () => {
  assert.equal(S.cleanDeliverableName('infosec-summary.md'), 'infosec-summary.md');
  for (const bad of ['../x.md', 'a/b.md', 'a\\b.md', '.hidden', '', 'C:x', 7]) assert.equal(S.cleanDeliverableName(bad), null, String(bad));
});

// ─── 1. mail is held by the router ──────────────────────────────────────────

function tmpHome(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'md-signoff-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; }

async function office(t) {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const held = [];
  hive.setOutgoing((msg) => (msg.from === 'pam-1' ? (held.push(msg), { msg, hold: true }) : { msg }));
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  return { home, hive, held, outbox: path.join(home, 'hive', 'agents', 'pam-1', 'outbox') };
}

test('mail: a custodian\'s message to anyone is held, whatever its fields; nothing is routed or archived', async (t) => {
  const { hive, held, outbox } = await office(t);
  const bypasses = [
    { to: 'god', act: 'inform', subject: 'status', body: 'INFOSEC-123 raw body' },
    { to: 'jim-1', act: 'request', subject: 'fyi', body: 'raw' },
    { to: 'human', act: 'inform', subject: 'to the human', body: 'raw' },
    { to: 'broadcast', act: 'inform', subject: 'all', body: 'raw' },
    { to: 'god', act: 'done', subject: 'approved already', body: 'raw', needs_human: false, requires_reply: false, hops: 99 }
  ];
  bypasses.forEach((m, i) => fs.writeFileSync(path.join(outbox, `m${i}.json`), JSON.stringify(m)));
  hive.routeOnce();
  assert.equal(held.length, bypasses.length);
  assert.equal(hive.inbox('god').length, 0);
  assert.equal(hive.inbox('jim-1').length, 0);
  assert.deepEqual(fs.readdirSync(outbox).filter((f) => f.endsWith('.json')), [], 'the raw files are gone');
  assert.deepEqual(fs.readdirSync(path.join(outbox, '.sent')), [], 'nothing archived either');
  assert.equal(hive.logTail(50).filter((e) => e.kind === 'outbox-held').length, bypasses.length);
});

test('mail: once approved it is delivered as signed, from the custodian', async (t) => {
  const { hive } = await office(t);
  const o = S.decide(ITEM, { action: 'approve', text: 'INFOSEC-123 is open.' }, 1, sha);
  hive.send({ to: ITEM.to, act: ITEM.act, subject: o.deliver.subject, body: o.deliver.text }, ITEM.from);
  const got = hive.inbox('god');
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 'pam-1');
  assert.equal(got[0].body, 'INFOSEC-123 is open.');
});

// ─── 2. files: own folder and vaults only ───────────────────────────────────

test('files: the custodian\'s guard refuses research/, other agents, the project, the hive and temp', () => {
  const dir = '/home/u/office/hive/agents/pam-1';
  const vault = '/home/u/office/confidential/api-jira';
  const policy = { roots: S.custodianWriteRoots(dir, [vault]), cwd: dir, git: false, contained: true };
  const refused = [
    ['Write', { file_path: '/home/u/office/hive/research/leak.md', content: 'x' }],
    ['Write', { file_path: '/home/u/office/hive/agents/jim-1/inbox/m.json', content: '{}' }],
    ['Edit', { file_path: '/home/u/project/README.md', old_string: 'a', new_string: 'b' }],
    ['Write', { file_path: '/home/u/office/hive/tasks.json', content: '{}' }],
    ['Bash', { command: 'cp notes.md /home/u/office/hive/research/' }],
    ['Bash', { command: 'echo x > /tmp/share.txt' }],
    ['Bash', { command: 'cat outbox/m.json > ../jim-1/inbox/m.json' }],
    ['Bash', { command: 'git commit -am leak' }]
  ];
  for (const [tool, input] of refused) assert.ok(guardToolCall(tool, input, policy, '/home/u'), `${tool} ${JSON.stringify(input)}`);
  assert.equal(guardToolCall('Write', { file_path: `${dir}/outbox/m.json`, content: '{}' }, policy, '/home/u'), null);
  assert.equal(guardToolCall('Write', { file_path: `${dir}/outgoing/summary.md`, content: 'x' }, policy, '/home/u'), null);
  assert.equal(guardToolCall('Write', { file_path: `${vault}/reports/full.md`, content: 'x' }, policy, '/home/u'), null);
});

test('files + network: the custodian\'s sandbox writes its folder and vault only, reaches only the broker, and its folder leaves the history', async (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  const dir = path.join(home, 'hive', 'agents', 'pam-1');
  const vault = path.join(home, 'confidential', 'api-jira');
  const inj = await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: dir },
    { critical: ['Jira'], vaults: [vault], extraWritableDirs: [vault, path.join(home, 'palace')], roam: true, brokerUrl: 'http://127.0.0.1:47123', lockdown: { outgoing: path.join(dir, 'outgoing') } });
  const s = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  assert.deepEqual(s.sandbox.filesystem.allowWrite, [dir, vault], 'not the hive root, not the palace');
  assert.deepEqual(s.permissions.additionalDirectories, [dir, vault]);
  assert.deepEqual(s.sandbox.network, { allowedDomains: ['127.0.0.1:47123'], strictAllowlist: true }, 'the broker (md-api), no other host');
  assert.equal(s.sandbox.failIfUnavailable, true, 'no sandbox, no custodian shell');
  const g = hive.guardFor('pam-1');
  assert.deepEqual(g.roots, [dir, vault]);
  assert.equal(g.contained, true, 'roam is ignored for a custodian');
  assert.equal(g.git, false);
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^\*$/m, '3. its folder stays out of the hive history');
  const prompt = inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  assert.match(prompt, /SIGN-OFF: everything you send out is held/);
  assert.ok(prompt.includes(path.join(dir, 'outgoing')));
});

test('3+4. memory and network servers: a custodian gets none of them', (t) => {
  const home = tmpHome(t);
  const hive = new HiveManager(() => home);
  hive.setCritical(() => ({ 'mcp:github-token': 'pam-1' }));
  hive.setMcpKeyCheck(() => true);
  hive.setMcpGateway(() => ({ url: 'http://127.0.0.1:1', token: 't' }));
  hive.setMemoryMcp(() => ({ command: 'mempalace', args: [] }));
  hive.setCustomMcp(() => ({ gateway: ['custom--slack'], plain: { 'custom--x': { command: 'x', args: [] } } }));
  const servers = Object.keys(hive.buildDefaultMcpServers(path.join(home, 'p'), { 'github-token': { enabled: true }, fetch: { enabled: true }, filesystem: { enabled: true } }, undefined, 'pam-1').servers);
  assert.deepEqual(servers, ['munder-github-token']);
});

// ─── 5. what others could read of it ────────────────────────────────────────

test('5. another agent may not read the custodian\'s folder or its transcripts', () => {
  const policy = { roots: ['/home/u/project'], cwd: '/home/u/project', git: true, contained: true,
    deny: ['/home/u/office/confidential', '/home/u/office/hive/agents/pam-1', '/home/u/.claude/projects/-home-u-office-hive-agents-pam-1'] };
  for (const [tool, input] of [
    ['Read', { file_path: '/home/u/office/hive/agents/pam-1/memory.md' }],
    ['Bash', { command: 'tail -50 ~/.claude/projects/-home-u-office-hive-agents-pam-1/abc.jsonl' }],
    ['Grep', { pattern: 'INFOSEC', path: '/home/u/office/hive/agents/pam-1' }]
  ]) assert.ok(guardToolCall(tool, input, policy, '/home/u'), `${tool} ${JSON.stringify(input)}`);
});

// ─── 6. engine ──────────────────────────────────────────────────────────────

test('6. only Claude Code can be a custodian (hooks, path guard, OS sandbox, tool and MCP lockdown)', () => {
  assert.deepEqual([...C.CUSTODIAN_PROVIDERS], ['claude']);
  for (const p of ['pi', 'codex', 'gemini', 'opencode', 'crush', 'qwen', 'grok', 'agy', 'cursor', 'copilot']) assert.equal(C.canBeCustodian(p), false, p);
});
