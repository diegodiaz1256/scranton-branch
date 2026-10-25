'use strict';

// Agent files (scranton-agent@1): export never carries a secret or the
// human's paths, import validates a strict schema and grants nothing beyond
// what the file lists AND the office allows, and role bundles round-trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  AGENT_FILE_SPEC, AGENT_FILE_MAX_BYTES, DEFAULT_EXPORT_PARTS, EXPORT_PARTS,
  buildAgentFile, validateAgentFile, parseAgentFile, planAgentImport, scrubPaths,
  isSafeSkillPath, agentFileName, effortOf, fillPlaceholders
} = loadTs('src/shared/agentFile.ts');
const { ROLE_BUNDLES, cleanCustomBundles } = loadTs('src/shared/roleBundles.ts');

const ALL = Object.fromEntries(EXPORT_PARTS.map((p) => [p, true]));

// A small seeded PRNG so a failure names a reproducible case.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function word(r, n) { let o = ''; for (let i = 0; i < n; i++) o += ALPHA[Math.floor(r() * ALPHA.length)]; return o; }
const PREFIXES = ['ghp_', 'sk-', 'xoxb-', 'AKIA', 'glpat-', 'sk_live_', 'AIza', 'plain'];

/** An office with secret-looking values planted everywhere a value can sit. */
function plantedOffice(seed) {
  const r = rng(seed);
  const secrets = [];
  const secret = () => { const v = PREFIXES[Math.floor(r() * PREFIXES.length)] + word(r, 20 + Math.floor(r() * 20)); secrets.push(v); return v; };
  const home = r() < 0.5 ? 'C:\\Users\\Usuario' : '/home/zeroge';
  const sep = home.includes('\\') ? '\\' : '/';
  const cwd = `${home}${sep}code${sep}my project`;
  const id = 'jim-abc';
  const config = {
    harnessHome: `${home}${sep}offices${sep}main`,
    registeredRepos: [cwd],
    mcpDefaults: { git: { enabled: true }, 'github-token': { enabled: true } },
    agentMcpGrants: { [id]: ['git', 'github-token', 'db'] },
    agentMcpAccess: { [id]: { 'github-token': 'readwrite', git: 'read' } },
    agentToolBlocks: { [id]: ['web'] },
    customMcp: [
      { id: 'custom--a', name: 'Local tool', enabled: true, agents: null,
        transport: { kind: 'stdio', command: `${home}${sep}bin${sep}tool.exe`, args: ['--api-key', secret(), `--token=${secret()}`, `DB_PASSWORD=${secret()}`, `${cwd}${sep}data`] },
        env: { API_KEY: secret(), REGION: secret() }, secretEnv: ['OTHER_TOKEN'] },
      { id: 'custom--b', name: 'Remote', enabled: true, agents: [id],
        transport: { kind: 'http', url: `https://user:${secret()}@mcp.example.com/v1?api_key=${secret()}#${secret()}` },
        env: {}, secretEnv: [], headers: { Authorization: `Bearer ${secret()}`, 'X-Team': secret() }, secretHeaders: ['X-Api-Key'] },
      { id: 'custom--c', name: 'Someone else', enabled: true, agents: ['other'],
        transport: { kind: 'stdio', command: 'x', args: [secret()] }, env: {}, secretEnv: [] }
    ],
    envVars: [
      { name: 'OPENAI_API_KEY', kind: 'secret', agents: null },
      { name: 'REGION', kind: 'plain', value: secret(), agents: [id] },
      { name: 'NOT_MINE', kind: 'plain', value: secret(), agents: ['other'] }
    ],
    integrations: [{ id: 'jira', label: 'Jira', baseUrl: `https://${word(r, 8)}.atlassian.net`, secretRef: `int:jira`, authHeader: 'Authorization' }],
    integrationScopes: {},
    criticalCustodians: { 'mcp:github-token': id },
    agentUnsandboxed: [id],
    agentRoam: [id],
    agentSshRelay: { [id]: { keys: ['SHA256:' + secret()] } },
    roleEffort: { agent: 'high' },
    agentTokenCaps: { [id]: 2000000 }
  };
  const goalSecret = secret();
  const src = {
    agent: {
      id, name: 'Jim', description: `Reviews PRs in ${cwd}`, character: 'jim', accent: 'sky',
      goal: `Ship it. Key is ${goalSecret} and the token ghp_${word(r, 30)} lives in ${cwd}${sep}.env`,
      provider: 'claude', model: 'claude-opus-4-8[1m]', command: 'claude --model claude-opus-4-8[1m] --effort max', cwd
    },
    tags: ['code-review'],
    config,
    skills: [{ name: 'xlsx', owner: 'anthropics', url: `https://github.com/anthropics/skills?token=${secret()}`,
      files: [{ path: 'SKILL.md', content: `Use ${secret()} at ${home}${sep}x` }, { path: 'scripts/run.py', content: 'print(1)' }] }],
    connections: [{ service: 'github-token', label: 'GitHub (work)' }],
    memory: `- learned: password=${secret()}\n- repo at ${cwd}`,
    homes: [home],
    now: '2026-10-25T10:00:00.000Z'
  };
  return { src, secrets, home, cwd };
}

test('export never carries a secret value, a vault/custodian marker or the human\'s paths (property)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const { src, secrets, home } = plantedOffice(seed);
    // With the office's known secret values, and without them: the structured
    // places (env, headers, args, URLs) are dropped by construction.
    for (const known of [secrets, []]) {
      const file = buildAgentFile({ ...src, secrets: known }, ALL);
      const json = JSON.stringify(file);
      const structured = known.length ? secrets : secrets.filter((s) => !src.agent.goal.includes(s) && !src.memory.includes(s) && !src.skills[0].files[0].content.includes(s));
      for (const s of structured) assert.ok(!json.includes(s), `seed ${seed}: secret ${s} leaked`);
      for (const banned of ['secretRef', 'criticalCustodians', 'custodian', 'agentUnsandboxed', 'agentRoam', 'SshRelay', 'Bearer ', 'int:jira', 'atlassian.net']) {
        assert.ok(!json.includes(banned), `seed ${seed}: ${banned} in export`);
      }
      assert.ok(!json.includes(home.replace(/\\/g, '\\\\')) && !json.includes(home), `seed ${seed}: home path leaked`);
      assert.ok(!/Usuario|zeroge/.test(json), `seed ${seed}: user name leaked`);
      assert.ok(!/ghp_[A-Za-z0-9]{8,}/.test(json), `seed ${seed}: token-looking value leaked`);
      assert.equal(validateAgentFile(JSON.parse(json)).ok, true);
    }
  }
});

test('export keeps names, not values: env names, header names, MCP env names', () => {
  const { src, secrets } = plantedOffice(7);
  const file = buildAgentFile({ ...src, secrets }, ALL);
  assert.deepEqual(file.envNames, ['OPENAI_API_KEY', 'REGION']);
  const stdio = file.mcpServers.find((m) => m.kind === 'stdio');
  assert.deepEqual(stdio.envNames.sort(), ['API_KEY', 'OTHER_TOKEN', 'REGION']);
  assert.equal(stdio.command, '{{HOME}}\\bin\\tool.exe'.replace(/\\/g, src.agent.cwd.includes('\\') ? '\\' : '/'));
  assert.ok(stdio.args.includes('[REDACTED]') && stdio.args.includes('--token=[REDACTED]') && stdio.args.includes('DB_PASSWORD=[REDACTED]'));
  const http = file.mcpServers.find((m) => m.kind === 'http');
  assert.equal(http.url, 'https://mcp.example.com/v1');
  assert.deepEqual(http.headerNames.sort(), ['Authorization', 'X-Api-Key', 'X-Team']);
  assert.ok(!file.mcpServers.some((m) => m.name === 'Someone else'), 'a server scoped to another agent is not its');
  assert.deepEqual(file.connections, [{ service: 'github-token', label: 'GitHub (work)' }, { service: 'api:jira', label: 'Jira' }]);
  assert.equal(file.engine.effort, 'max');
  assert.equal(file.skills[0].source, 'https://github.com/anthropics/skills');
  assert.match(file.identity.role, /\{\{PROJECT\}\}/);
});

test('memory and skill files are left out unless ticked', () => {
  const { src, secrets } = plantedOffice(3);
  const file = buildAgentFile({ ...src, secrets }, DEFAULT_EXPORT_PARTS);
  assert.equal(file.memory, undefined);
  assert.equal(file.skills[0].files, undefined);
  assert.equal(DEFAULT_EXPORT_PARTS.memory, false);
  assert.equal(DEFAULT_EXPORT_PARTS.skillFiles, false);
  const off = buildAgentFile({ ...src, secrets }, Object.fromEntries(EXPORT_PARTS.map((p) => [p, false])));
  assert.deepEqual(Object.keys(off).sort(), ['exportedAt', 'identity', 'spec']);
  assert.deepEqual(off.identity, { name: 'Jim' });
});

const minimal = () => ({ spec: AGENT_FILE_SPEC, identity: { name: 'Jim' } });

test('schema: a minimal file passes; wrong spec, unknown fields and bad types fail', () => {
  assert.equal(validateAgentFile(minimal()).ok, true);
  assert.equal(validateAgentFile({ ...minimal(), spec: 'scranton-agent@2' }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), command: 'calc.exe' }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), identity: { name: 'Jim', cwd: '/x' } }).ok, false);
  assert.equal(validateAgentFile({ spec: AGENT_FILE_SPEC }).ok, false, 'a name is required');
  assert.equal(validateAgentFile(JSON.parse(`{"spec":"${AGENT_FILE_SPEC}","identity":{"name":"x"},"__proto__":{"polluted":1}}`)).ok, false);
  assert.equal(validateAgentFile([]).ok, false);
  assert.equal(validateAgentFile('x').ok, false);
  assert.equal(validateAgentFile({ ...minimal(), hire: { tokenCap: -1 } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), hire: { isolate: 'yes' } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), capabilities: { access: { git: 'admin' } } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), capabilities: { toolBlocks: ['everything'] } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), engine: { provider: 'claude', effort: 'turbo' } }).ok, false);
});

test('schema: no executable can ride in (custom provider, shell metacharacters in the model)', () => {
  assert.equal(validateAgentFile({ ...minimal(), engine: { provider: 'custom' } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), engine: { provider: 'bash' } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), engine: { provider: 'claude', model: 'x&calc' } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), engine: { provider: 'claude', model: 'claude-opus-4-8[1m]' } }).ok, true);
  assert.equal(validateAgentFile({ ...minimal(), engine: { provider: 'antigravity', model: 'Gemini 3.1 Pro (High)' } }).ok, true);
});

test('schema: oversized and control-character content is refused', () => {
  assert.equal(validateAgentFile({ ...minimal(), prompt: { goal: 'x'.repeat(4001) } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), identity: { name: 'x'.repeat(41) } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), identity: { name: 'Jim\u001b[2J' } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), identity: { name: 'Jim\nRole' } }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), envNames: Array.from({ length: 65 }, (_, i) => `V${i}`) }).ok, false);
  assert.equal(validateAgentFile({ ...minimal(), memory: 'x'.repeat(64 * 1024 + 1) }).ok, false);
  assert.equal(parseAgentFile(' '.repeat(AGENT_FILE_MAX_BYTES + 1)).ok, false);
  assert.equal(parseAgentFile('{not json').ok, false);
});

test('schema: skill names and file paths cannot leave their folder', () => {
  for (const bad of ['../x', '..', 'a/b', 'a\\b', '.hidden', 'C:', '']) {
    assert.equal(validateAgentFile({ ...minimal(), skills: [{ name: bad }] }).ok, false, `skill name ${JSON.stringify(bad)}`);
  }
  for (const bad of ['../../etc/passwd', '/etc/passwd', 'C:/x.md', 'C:\\x.md', 'a\\..\\b', 'a/../b', 'a/./b', '.env', 'con.txt', 'a/NUL', 'a//b', 'trailing.', 'x/'.repeat(7) + 'y']) {
    assert.equal(isSafeSkillPath(bad), false, `path ${JSON.stringify(bad)}`);
    assert.equal(validateAgentFile({ ...minimal(), skills: [{ name: 'ok', files: [{ path: bad, content: '' }] }] }).ok, false, `file ${JSON.stringify(bad)}`);
  }
  for (const good of ['SKILL.md', 'scripts/run.py', 'reference/forms v2.md']) assert.equal(isSafeSkillPath(good), true, good);
  assert.equal(validateAgentFile({ ...minimal(), skills: [{ name: 'ok', files: [{ path: 'a.md', content: '' }, { path: 'A.md', content: '' }] }] }).ok, false, 'duplicate paths');
  assert.equal(validateAgentFile({ ...minimal(), skills: [{ name: 'ok', source: 'http://evil.example/x' }] }).ok, false, 'source must be https');
  assert.equal(validateAgentFile({ ...minimal(), mcpServers: [{ kind: 'http', name: 'x', url: 'https://u:p@x.example', headerNames: [] }] }).ok, false, 'no credentials in a URL');
  assert.equal(validateAgentFile({ ...minimal(), mcpServers: [{ kind: 'stdio', name: 'x', command: 'x', args: [], envNames: ['BAD-NAME'] }] }).ok, false);
});

const LOCAL = {
  catalogSkills: [{ name: 'xlsx', owner: 'anthropics' }, { name: 'pdf', owner: 'anthropics' }],
  officeSkills: ['pdf'],
  mcpEnabled: { git: true },
  connections: [{ service: 'github-token', label: 'GitHub', ready: false, enabled: false }],
  integrations: [],
  customMcpNames: [],
  envNames: ['REGION'],
  customBundles: [],
  ceilings: {}
};

test('round-trip: export → file → import plan keeps what it should', () => {
  const { src, secrets } = plantedOffice(11);
  const file = buildAgentFile({ ...src, secrets }, ALL);
  const back = parseAgentFile(JSON.stringify(file, null, 2));
  assert.equal(back.ok, true, back.errors.join('; '));
  assert.deepEqual(back.file, file);
  const plan = planAgentImport(back.file, LOCAL);
  assert.equal(plan.name, 'Jim');
  assert.equal(plan.provider, 'claude');
  assert.equal(plan.model, 'claude-opus-4-8[1m]');
  assert.equal(plan.effort, 'max');
  assert.deepEqual(plan.grant, ['git', 'github-token', 'db']);
  assert.deepEqual(plan.tags, ['code-review']);
  assert.deepEqual(plan.toolBlocks, ['web']);
  assert.equal(plan.tokenCap, 2000000);
  assert.deepEqual(plan.skills.install, [{ name: 'xlsx', owner: 'anthropics' }]);
  assert.deepEqual(plan.skills.withFiles, ['xlsx']);
  assert.deepEqual(plan.envMissing, ['OPENAI_API_KEY']);
  assert.deepEqual(plan.envPresent, ['REGION']);
  assert.deepEqual(plan.connections.missing.map((c) => c.service), ['github-token', 'api:jira']);
  assert.deepEqual(plan.mcpManual.map((m) => m.name), ['Local tool', 'Remote']);
  assert.equal(plan.memory, true);
  assert.equal(fillPlaceholders('in {{PROJECT}}/src', '/work/p'), 'in /work/p/src');
});

test('import grants nothing privileged: access capped by the office, keyed servers wait for consent', () => {
  const file = validateAgentFile({
    ...minimal(),
    capabilities: { servers: ['git', 'github-token', 'not-a-server'], access: { 'github-token': 'readwrite', git: 'readwrite', 'api:jira': 'readwrite', other: 'readwrite' } },
    mcpServers: [{ kind: 'catalog', id: 'filesystem' }, { kind: 'catalog', id: 'ghost' }]
  }).file;
  const plan = planAgentImport(file, { ...LOCAL, ceilings: { git: 'readwrite' } });
  assert.deepEqual(plan.grant, ['git', 'github-token']);
  assert.deepEqual(plan.unknownServers.sort(), ['ghost', 'not-a-server']);
  // A connection with no ceiling of its own stays read-only; api:jira is not in this office.
  assert.deepEqual(plan.access, { 'github-token': 'read', git: 'readwrite' });
  assert.ok(plan.needsConsent.includes('github-token'));
  for (const k of ['custodian', 'critical', 'unsandboxed', 'roam', 'sshRelay', 'cloudCredentials']) assert.equal(k in plan, false);
  // Skills install only from this office's catalog, by name.
  const sk = planAgentImport(validateAgentFile({ ...minimal(), skills: [{ name: 'evil', source: 'https://evil.example/s.zip' }] }).file, LOCAL);
  assert.deepEqual(sk.skills.install, []);
  assert.deepEqual(sk.skills.unavailable, ['evil']);
});

test('role bundles round-trip through an agent file', () => {
  for (const b of ROLE_BUNDLES) {
    const src = { agent: { id: 'a', name: 'A' }, config: { agentMcpGrants: { a: b.servers }, agentMcpAccess: { a: b.access ?? {} } } };
    const file = parseAgentFile(JSON.stringify(buildAgentFile(src, ALL))).file;
    assert.equal(file.capabilities.bundle.id, b.id);
    const here = planAgentImport(file, LOCAL);
    assert.equal(here.bundle.exists, true, `${b.id} is a built-in everywhere`);
    assert.deepEqual([...here.grant].sort(), [...b.servers].sort());
  }
  // A custom bundle the other office lacks comes back as one it can save.
  const mine = { id: 'my-qa', label: 'QA', icon: 'git', servers: ['git', 'fetch'], access: { git: 'readwrite' } };
  const src = { agent: { id: 'a', name: 'A' }, config: { agentMcpGrants: { a: ['fetch', 'git'] }, customRoleBundles: [mine] } };
  const file = parseAgentFile(JSON.stringify(buildAgentFile(src, ALL))).file;
  const plan = planAgentImport(file, LOCAL);
  assert.equal(plan.bundle.exists, false);
  const saved = cleanCustomBundles([plan.bundle.bundle]);
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].servers.sort(), ['fetch', 'git']);
  assert.deepEqual(saved[0].access, { git: 'readwrite' });
  assert.equal(planAgentImport(file, { ...LOCAL, customBundles: saved }).bundle.exists, true);
});

test('paths become placeholders on every platform', () => {
  const roots = [{ path: 'C:\\Users\\Usuario\\code\\proj', token: '{{PROJECT}}' }, { path: 'C:\\Users\\Usuario', token: '{{HOME}}' }];
  assert.equal(scrubPaths('see c:\\users\\usuario\\code\\proj\\src and C:/Users/Usuario/code/proj', roots), 'see {{PROJECT}}\\src and {{PROJECT}}');
  assert.equal(scrubPaths('D:\\Users\\Bob\\x', []), '{{HOME}}\\x');
  assert.equal(scrubPaths('cd /home/zeroge/offices && ls /Users/ann/Desktop', []), 'cd {{HOME}}/offices && ls {{HOME}}/Desktop');
  assert.equal(scrubPaths('\\\\wsl.localhost\\Ubuntu\\home\\zeroge\\x', []), '{{HOME}}\\x');
  assert.equal(scrubPaths('https://github.com/home/x and /usr/bin/node', []), 'https://github.com/home/x and /usr/bin/node');
  assert.equal(agentFileName('Jim Halpert!'), 'jim-halpert.sbagent.json');
  assert.equal(effortOf('claude --effort=low', 'high'), 'low');
  assert.equal(effortOf('claude', 'high'), 'high');
  assert.equal(effortOf('claude', undefined), undefined);
});
