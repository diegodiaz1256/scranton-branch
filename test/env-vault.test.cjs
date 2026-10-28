'use strict';
// Environment and secrets (src/main/envVault.ts): agents may USE a secret
// (through a runner) but never SEE its value.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { EnvVault, maskSecrets } = loadTs('src/main/envVault.ts');

function vault(opts = {}) {
  let vars = []; let runners = [];
  const secrets = new Map();
  const asked = [];
  const v = new EnvVault({
    readVars: () => vars, writeVars: (x) => { vars = x; },
    readRunners: () => runners, writeRunners: (x) => { runners = x; },
    getSecret: (r) => secrets.get(r), setSecret: (r, s) => { secrets.set(r, s); return { ok: true }; }, deleteSecret: (r) => secrets.delete(r),
    approve: async (req) => { asked.push(req); return opts.answer ?? 'once'; },
    approveProposal: async (req) => { asked.push(req); return opts.addProposal ?? true; },
    opRead: async (ref) => { if (ref === 'op://Dev/Db/url') return 'postgres://u:hunter2-op@db/x'; throw new Error('not found'); }
  });
  return { v, secrets, asked, get vars() { return vars; }, get runners() { return runners; } };
}

test('masking catches the value and its encodings', () => {
  const s = 'sk_live_ABC123xyz';
  const text = `key=${s} b64=${Buffer.from(s).toString('base64')} url=${encodeURIComponent('a b/' + s)}`;
  const out = maskSecrets(text, [s]);
  assert.ok(!out.includes(s) && !out.includes(Buffer.from(s).toString('base64')), out);
});

test('secret values never come back out of the vault, and never reach agents', () => {
  const { v, vars } = vault();
  assert.equal(v.setVar({ name: 'STRIPE_KEY', kind: 'secret' }, 'sk_live_ABC123xyz').ok, true);
  assert.equal(v.setVar({ name: 'NODE_ENV', kind: 'plain', value: 'development' }).ok, true);
  assert.equal(v.setVar({ name: 'DATABASE_URL', kind: 'op', value: 'op://Dev/Db/url' }).ok, true);
  const listed = JSON.stringify(v.listVars());
  assert.ok(!listed.includes('sk_live'), 'the UI listing has no secret value');
  assert.ok(/"stored":true/.test(listed));
  assert.deepEqual(v.plainEnvFor('god'), { NODE_ENV: 'development' }, 'agents get plain variables only');
  assert.ok(!JSON.stringify(vars).includes('sk_live'), 'config has no secret value');
});

test('validation: names, op references, a secret needs a value', () => {
  const { v } = vault();
  assert.equal(v.setVar({ name: '1BAD', kind: 'plain', value: 'x' }).ok, false);
  assert.equal(v.setVar({ name: 'X', kind: 'op', value: 'vault/item' }).ok, false);
  assert.equal(v.setVar({ name: 'X', kind: 'secret' }).ok, false);
});

test('a runner uses secrets; its output comes back masked', async () => {
  const { v } = vault();
  v.setVar({ name: 'STRIPE_KEY', kind: 'secret' }, 'sk_live_ABC123xyz');
  v.setVar({ name: 'DATABASE_URL', kind: 'op', value: 'op://Dev/Db/url' });
  const r = v.setRunner({ name: 'leak test', command: 'node -e "console.log(process.env.STRIPE_KEY, Buffer.from(process.env.STRIPE_KEY).toString(\'base64\'), process.env.DATABASE_URL)"', secrets: ['STRIPE_KEY', 'DATABASE_URL'], approval: 'never' });
  assert.equal(r.ok, true);
  const out = await v.run(r.id, { agentName: 'Dwight', cwd: process.cwd(), fingerprint: 'a' });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.exitCode, 0);
  assert.ok(!out.output.includes('sk_live_ABC123xyz') && !out.output.includes('hunter2-op'), out.output);
  assert.match(out.output, /\*\*\* \*\*\* \*\*\*/);
});

test('on-change approval asks when the worktree changed, not again otherwise; deny stops it', async () => {
  const a = vault();
  a.v.setVar({ name: 'K', kind: 'secret' }, 'value-1234');
  const { id } = a.v.setRunner({ name: 'ok', command: 'node -e "process.exit(0)"', secrets: ['K'] });
  await a.v.run(id, { agentName: 'Jim', cwd: process.cwd(), fingerprint: 'v1' });
  await a.v.run(id, { agentName: 'Jim', cwd: process.cwd(), fingerprint: 'v1' });
  assert.equal(a.asked.length, 1, 'same state: asked once');
  await a.v.run(id, { agentName: 'Jim', cwd: process.cwd(), fingerprint: 'v2' });
  assert.equal(a.asked.length, 2, 'files changed: asked again');
  assert.equal(a.asked[1].changed, true);

  const d = vault({ answer: 'deny' });
  d.v.setVar({ name: 'K', kind: 'secret' }, 'value-1234');
  const r = d.v.setRunner({ name: 'x', command: 'node -e "1"', secrets: ['K'], approval: 'always' });
  const out = await d.v.run(r.id, { agentName: 'Jim', cwd: process.cwd(), fingerprint: 'v1' });
  assert.equal(out.ok, false);
  assert.match(out.error, /declined/);
});

test('a 1Password failure is reported, not run without the secret', async () => {
  const { v } = vault();
  v.setVar({ name: 'MISSING', kind: 'op', value: 'op://Dev/Nope/x' });
  const { id } = v.setRunner({ name: 'x', command: 'node -e "1"', secrets: ['MISSING'], approval: 'never' });
  const out = await v.run(id, { agentName: 'Jim', cwd: process.cwd(), fingerprint: 'v1' });
  assert.equal(out.ok, false);
  assert.match(out.error, /1Password could not read MISSING/);
});

test('the key broker serves runners to a token holder only, masked output and all', async (t) => {
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  const { v } = vault();
  v.setVar({ name: 'TOKEN', kind: 'secret' }, 'tok_super_secret_99');
  const { id } = v.setRunner({ name: 'echo', command: 'node -e "console.log(\'value=\' + process.env.TOKEN)"', secrets: ['TOKEN'], approval: 'never', description: 'prints it' });
  const broker = new IntegrationBroker({
    getRecord: () => undefined, getSecret: () => undefined,
    runners: { describe: () => v.describeRunners(), run: (_w, rid) => v.run(rid, { agentName: 'Pam', cwd: process.cwd(), fingerprint: 'x' }) }
  });
  const started = await broker.start(0);
  t.after(() => broker.stop());
  const token = broker.grant('pty-pam', []);
  const base = `http://127.0.0.1:${started.port}`;
  const list = await (await fetch(`${base}/run`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(list.runners.map((r) => r.id), [id]);
  assert.ok(!JSON.stringify(list).includes('tok_super'), 'listing carries names, not values');
  const ran = await (await fetch(`${base}/run/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(ran.ok, true, ran.error);
  assert.match(ran.output, /value=\*\*\*/);
  assert.ok(!ran.output.includes('tok_super_secret_99'));
  const anon = await fetch(`${base}/run/${id}`, { method: 'POST' });
  assert.equal(anon.status, 401, 'no token, no run');
});

test('on a WSL floor a runner runs inside the distro, secrets over stdin, output masked', { skip: process.platform !== 'win32' }, async (t) => {
  const { execFileSync } = require('node:child_process');
  let distro = null;
  try {
    const raw = execFileSync('wsl.exe', ['-l', '-q'], { timeout: 15000 });
    distro = raw.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
  } catch { /* no WSL */ }
  if (!distro) { t.skip('no WSL distribution'); return; }
  const { v } = vault();
  v.setVar({ name: 'TOKEN', kind: 'secret' }, 'wsl_secret_value=with spaces & "quotes"');
  const { id } = v.setRunner({ name: 'where', command: 'echo "kernel=$(uname -s) pwd=$PWD"; echo "value=$TOKEN"; env | grep -c wsl_secret_value', secrets: ['TOKEN'], approval: 'never' });
  const out = await v.run(id, { agentName: 'Pam', cwd: `\\\\wsl.localhost\\${distro}\\tmp`, fingerprint: 'x' });
  assert.equal(out.ok, true, out.error);
  assert.match(out.output, /kernel=Linux pwd=\/tmp/);
  assert.match(out.output, /value=\*\*\*/);
  assert.ok(!out.output.includes('wsl_secret_value'), out.output);
});

test('an agent can propose a runner; it exists only once the human approves it', async () => {
  const yes = vault();
  yes.v.setVar({ name: 'DATABASE_URL', kind: 'secret' }, 'postgres://u:hunter2@db/x');
  yes.v.setVar({ name: 'NODE_ENV', kind: 'plain', value: 'dev' });
  assert.deepEqual(yes.v.secretNames(), ['DATABASE_URL'], 'names only, and never a plain variable');

  const r = await yes.v.proposeRunner({ name: 'Migrate DB', command: 'npm run migrate', secrets: ['DATABASE_URL'], description: 'apply the new table' }, { agentName: 'Jim', cwd: '/work/jim' });
  assert.deepEqual(r, { ok: true, id: 'migrate-db' });
  assert.equal(yes.asked[0].agentName, 'Jim');
  assert.equal(yes.asked[0].cwd, '/work/jim', "the prompt knows the agent's folder, to show the code");
  assert.equal(yes.asked[0].proposal.command, 'npm run migrate', 'the human sees the exact command');
  assert.deepEqual(yes.runners[0].secrets, ['DATABASE_URL']);
  assert.equal(yes.runners[0].approval, 'on-change', 'still asked again after the worktree changes');

  const again = await yes.v.proposeRunner({ name: 'migrate db', command: 'rm -rf /', secrets: [] }, { agentName: 'Jim' });
  assert.equal(again.ok, false, 'an existing runner is never replaced by a proposal');
  assert.equal(yes.runners[0].command, 'npm run migrate');

  const missing = await yes.v.proposeRunner({ name: 'x', command: 'y', secrets: ['NODE_ENV'] }, { agentName: 'Jim' });
  assert.equal(missing.ok, false, 'only stored secrets can be named');
  assert.match(missing.error, /DATABASE_URL/);

  const no = vault({ addProposal: false });
  no.v.setVar({ name: 'K', kind: 'secret' }, 'v');
  assert.equal((await no.v.proposeRunner({ name: 'k', command: 'c', secrets: ['K'] }, { agentName: 'Pam' })).ok, false);
  assert.equal(no.runners.length, 0, 'declined: nothing added');
});

test('a proposal naming a secret that does not exist asks the human to create it', async () => {
  const answers = [];
  let vars = []; let runners = []; const secrets = new Map(); const asked = [];
  const v = new EnvVault({
    readVars: () => vars, writeVars: (x) => { vars = x; },
    readRunners: () => runners, writeRunners: (x) => { runners = x; },
    getSecret: (r) => secrets.get(r), setSecret: (r, s) => { secrets.set(r, s); return { ok: true }; }, deleteSecret: (r) => secrets.delete(r),
    approve: async () => 'once',
    approveProposal: async (req) => { asked.push(req); return answers.shift(); }
  });

  answers.push({ ok: true, secrets: { STRIPE_KEY: { kind: 'secret', value: 'sk_test_123' }, DB_URL: { kind: 'op', value: 'op://Dev/Db/url' } } });
  const r = await v.proposeRunner({ name: 'Charge test', command: 'npm run charge', secrets: ['STRIPE_KEY', 'DB_URL'] }, { agentName: 'Kevin' });
  assert.deepEqual(r, { ok: true, id: 'charge-test' });
  assert.deepEqual(asked[0].missing, ['STRIPE_KEY', 'DB_URL'], 'the human is told which secrets are new');
  assert.deepEqual(v.secretNames().sort(), ['DB_URL', 'STRIPE_KEY']);
  assert.ok(!JSON.stringify(vars).includes('sk_test_123'), 'the value is stored as a secret, not in config');
  assert.deepEqual(runners[0].secrets, ['STRIPE_KEY', 'DB_URL']);

  answers.push({ ok: true, secrets: {} });
  const left = await v.proposeRunner({ name: 'Deploy', command: 'npm run deploy', secrets: ['DEPLOY_TOKEN'] }, { agentName: 'Kevin' });
  assert.equal(left.ok, false, 'a missing secret left empty means no runner');
  assert.equal(runners.length, 1);
  assert.ok(!v.secretNames().includes('DEPLOY_TOKEN'));

  const bad = await v.proposeRunner({ name: 'x', command: 'y', secrets: ['../etc'] }, { agentName: 'Kevin' });
  assert.equal(bad.ok, false, 'an agent cannot invent a secret name outside the variable rules');
});
