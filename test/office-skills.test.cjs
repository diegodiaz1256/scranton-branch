'use strict';
// The orchestrator manages the agents' skills: it searches the catalog with
// sb-skills, asks for one by request file, and main installs it into the
// office store and copies it into exactly the agents it named.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { planSkillRequest, searchCatalog, findCatalogSkill, readOfficeSkills } = loadTs('src/shared/skillRequests.ts');

const CATALOG = [
  { name: 'pdf', description: 'Read and fill PDF forms', url: 'https://github.com/anthropics/skills/tree/main/skills/pdf', category: 'Documents', owner: 'anthropics' },
  { name: 'pdf', description: 'Another pdf', url: 'https://github.com/someone/pdf', category: 'Documents', owner: 'someone' },
  { name: 'docx', description: 'Word documents', url: 'https://github.com/anthropics/skills/tree/main/skills/docx', category: 'Documents', owner: 'anthropics' },
  { name: 'stripe-best', description: 'Payments with Stripe', url: 'https://github.com/stripe/ai/tree/main/skills/x', category: 'Dev', owner: 'stripe' }
];
const agents = new Set(['god', 'jim', 'pam']);
const ctx = (over = {}) => ({ state: { skills: {} }, catalog: CATALOG, policy: 'official', agents, now: 'T', ...over });

test('add: installs the official skill for the named agents', () => {
  const p = planSkillRequest({ action: 'add', skill: 'PDF', agents: ['jim'] }, ctx());
  assert.equal(p.ok, true);
  assert.equal(p.install.owner, 'anthropics', 'the official one wins a shared name');
  assert.equal(planSkillRequest({ action: 'add', skill: 'anthropic-skills:docx', agents: ['*'] }, ctx()).install.name, 'docx', 'plugin-qualified name');
  assert.deepEqual(p.next.skills.pdf, { url: CATALOG[0].url, owner: 'anthropics', dir: 'pdf', agents: ['jim'], addedAt: 'T' });
});

test('policy: community skills need the human, off refuses everything', () => {
  const refused = planSkillRequest({ action: 'add', skill: 'stripe-best', agents: ['jim'] }, ctx());
  assert.equal(refused.ok, false);
  assert.match(refused.message, /community skill/);
  assert.equal(planSkillRequest({ action: 'add', skill: 'stripe-best', agents: ['jim'] }, ctx({ policy: 'catalog' })).ok, true);
  assert.equal(planSkillRequest({ action: 'add', skill: 'pdf', agents: ['jim'] }, ctx({ policy: 'off' })).ok, false);
});

test('bad requests are refused with a reason', () => {
  assert.match(planSkillRequest({ action: 'add', skill: 'pdf', agents: ['kevin'] }, ctx()).message, /No agent with id kevin/);
  assert.match(planSkillRequest({ action: 'add', skill: 'nope', agents: ['jim'] }, ctx()).message, /not in the skills catalog/);
  assert.match(planSkillRequest({ action: 'add', skill: 'pdf' }, ctx()).message, /agents is required/);
  assert.match(planSkillRequest({ action: 'zap', skill: 'pdf' }, ctx()).message, /action must be/);
});

test('add to more agents, remove from some, then from all', () => {
  let state = planSkillRequest({ action: 'add', skill: 'pdf', agents: ['jim'] }, ctx()).next;
  const more = planSkillRequest({ action: 'add', skill: 'pdf', agents: ['pam'] }, ctx({ state }));
  assert.equal(more.install, undefined, 'already in the store: no second install');
  assert.deepEqual(more.next.skills.pdf.agents, ['jim', 'pam']);
  state = more.next;
  const less = planSkillRequest({ action: 'remove', skill: 'pdf', agents: ['jim'] }, ctx({ state }));
  assert.deepEqual(less.next.skills.pdf.agents, ['pam']);
  assert.equal(less.drop, undefined);
  const gone = planSkillRequest({ action: 'remove', skill: 'pdf' }, ctx({ state: less.next }));
  assert.deepEqual(gone.next.skills, {});
  assert.equal(gone.drop, 'pdf', 'the store copy goes too');
});

test('search: only official skills under the default policy', () => {
  assert.deepEqual(searchCatalog(CATALOG, 'pdf forms', 'official').map((c) => c.owner), ['anthropics']);
  assert.ok(searchCatalog(CATALOG, 'stripe', 'catalog').length === 1);
  assert.equal(searchCatalog(CATALOG, 'stripe', 'official').length, 0);
  assert.equal(findCatalogSkill(CATALOG, 'docx').owner, 'anthropics');
});

test('hive: the agents named get it in .claude/skills, the others lose it; their own skills stay', async (t) => {
  const electron = require.resolve('electron');
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {} };
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-office-skills-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, {});
  await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home }, {});
  const store = hive.officeSkillStore();
  fs.mkdirSync(path.join(store, 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(store, 'pdf', 'SKILL.md'), '---\nname: pdf\n---\n');
  const skills = (a) => path.join(home, 'hive', 'agents', a, '.claude', 'skills');
  fs.mkdirSync(path.join(skills('jim'), 'mine'), { recursive: true });
  hive.writeOfficeSkills(readOfficeSkills({ skills: { pdf: { url: 'u', owner: 'anthropics', dir: 'pdf', agents: ['jim'], addedAt: 'T' } } }));
  hive.syncOfficeSkills('jim');
  hive.syncOfficeSkills('pam');
  assert.ok(fs.existsSync(path.join(skills('jim'), 'pdf', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(skills('pam'), 'pdf')));
  hive.writeOfficeSkills({ skills: {} });
  hive.syncOfficeSkills('jim');
  assert.ok(!fs.existsSync(path.join(skills('jim'), 'pdf')), 'taken away');
  assert.ok(fs.existsSync(path.join(skills('jim'), 'mine')), 'a skill it did not give is never removed');

  // sb-skills: the orchestrator's search, over the mirror main writes.
  hive.writeSkillCatalogMirror(CATALOG, 'official');
  hive.writeOfficeSkills(readOfficeSkills({ skills: { docx: { url: 'u', owner: 'anthropics', dir: 'docx', agents: ['*'], addedAt: 'T' } } }));
  const cli = path.join(home, 'hive', 'bin', 'sb-skills.cjs');
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf8', env: { ...process.env, HIVE_ROOT: path.join(home, 'hive') } });
  assert.match(run('search', 'pdf'), /^pdf \[anthropics\] Read and fill PDF forms/);
  assert.doesNotMatch(run('search', 'stripe'), /stripe-best/);
  assert.match(run('list'), /docx \(anthropics\) -> every agent/);
});
