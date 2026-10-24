'use strict';
// WSL floors: the hive (tasks.json, the agents' inboxes) lives inside the
// distro and the agents read and write it from Linux, while the app edits it
// over \\wsl.localhost. A task the human edits or cancels in the app must read
// right to an agent in the distro, the stop notice must land in its inbox
// there (with Linux paths), and the orchestrator writing tasks.json from Linux
// afterwards must not undo it. Needs WSL with node; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const NODE = '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"; ';

function distroWithNode() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('wsl.exe', ['-l', '-q'], { timeout: 15000 });
    const d = out.toString('utf16le').replace(/\0/g, '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^docker/i.test(s))[0];
    if (!d) return null;
    execFileSync('wsl.exe', ['-d', d, '--exec', 'bash', '-lc', `${NODE}command -v node`], { timeout: 20000 });
    return d;
  } catch { return null; }
}

/** Run a shell line inside the distro, as an agent there would. */
const inWsl = (distro, line) => execFileSync('wsl.exe', ['-d', distro, '--exec', 'bash', '-lc', NODE + line], { encoding: 'utf8', timeout: 60000 });

test('a task cancelled in the app reads right inside WSL and the stop notice lands in the agent inbox there', { timeout: 300000 }, async (t) => {
  const distro = distroWithNode();
  if (!distro) { t.skip('no WSL distro with node'); return; }
  const linuxHome = inWsl(distro, 'mkdir -p ~/offices && mktemp -d ~/offices/wsl-task-edit-XXXXXX').trim();
  t.after(() => { try { inWsl(distro, `rm -rf '${linuxHome}'`); } catch { /* leave it */ } });
  const home = `\\\\wsl.localhost\\${distro}${linuxHome.replace(/\//g, '\\')}`;
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => home);
  assert.ok(hive.wslRoot(), 'the app sees a WSL floor');
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'dwight', name: 'Dwight', provider: 'claude', cwd: home });

  // The orchestrator writes the ledger from inside the distro, with a field the app doesn't model.
  const linuxTasks = `${linuxHome}/hive/tasks.json`;
  inWsl(distro, `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ tasks: [
    { id: "plan", title: "Plan v2", status: "doing", assignee: "god", repo: "billing" },
    { id: "schema", title: "Migrate invoices", status: "doing", assignee: "dwight", parent: "plan", repo: "billing" }
  ] }, null, 2))' '${linuxTasks}'`);

  // The human edits one card and cancels the parent with its subtask, in the app.
  assert.equal(hive.editTasks([{ id: 'schema', edit: { title: 'Migrate invoices to cents', ticket: 'JIRA-42' } }]).ok, true);
  assert.equal(hive.editTasks([{ id: 'plan', edit: { status: 'cancelled' } }, { id: 'schema', edit: { status: 'cancelled' } }]).ok, true);

  // An agent-side reader in the distro.
  const seen = JSON.parse(inWsl(distro, `node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tasks;console.log(JSON.stringify(t.map(x=>({id:x.id,status:x.status,title:x.title,ticket:x.ticket,repo:x.repo,cancelledAt:!!x.cancelledAt}))))' '${linuxTasks}'`));
  assert.deepEqual(seen, [
    { id: 'plan', status: 'cancelled', title: 'Plan v2', repo: 'billing', cancelledAt: true },
    { id: 'schema', status: 'cancelled', title: 'Migrate invoices to cents', ticket: 'JIRA-42', repo: 'billing', cancelledAt: true }
  ]);

  // Dwight's inbox, listed and read from inside the distro.
  const inbox = JSON.parse(inWsl(distro, `node -e 'const fs=require("fs"),d=process.argv[1];console.log(JSON.stringify(fs.readdirSync(d).filter(f=>f.endsWith(".json")).map(f=>JSON.parse(fs.readFileSync(d+"/"+f,"utf8")))))' '${linuxHome}/hive/agents/dwight/inbox'`));
  const stop = inbox.find((m) => /cancelled/i.test(m.subject));
  assert.ok(stop, `a cancel notice in dwight's inbox (got: ${inbox.map((m) => m.subject).join(' | ')})`);
  assert.equal(stop.from, 'human');
  assert.equal(stop.act, 'inform');
  assert.match(stop.body, /JIRA-42 \(id schema\)/);
  assert.match(stop.body, /Stop working on it now/);
  assert.ok(!/\\\\wsl/i.test(JSON.stringify(inbox)), 'no Windows paths in what the agent reads');
  const godInbox = fs.readdirSync(path.join(home, 'hive', 'agents', 'god', 'inbox')).filter((f) => f.endsWith('.json'));
  assert.ok(godInbox.length >= 2, 'god heard about the edit and the cancel');

  // The orchestrator rewrites tasks.json from Linux (adds a card); the app reads what an agent
  // wrote, and the cancelled cards stay cancelled.
  inWsl(distro, `node -e 'const fs=require("fs"),p=process.argv[1],j=JSON.parse(fs.readFileSync(p,"utf8"));j.tasks.push({id:"next",title:"Next",status:"todo"});fs.writeFileSync(p,JSON.stringify(j))' '${linuxTasks}'`);
  const fromApp = hive.tasks().tasks;
  assert.deepEqual(fromApp.map((x) => `${x.id}:${x.status}`), ['plan:cancelled', 'schema:cancelled', 'next:todo']);
});
