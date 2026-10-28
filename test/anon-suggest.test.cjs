'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { suggestEntries, parseGitRemote, parseEnvFile, envValue, registrableDomain, hostsIn } = loadTs('src/shared/anonSuggest.ts');
const { gatherSuggestSources, envSecretValue, parseGitConfig } = loadTs('src/main/anonSuggestGather.ts');
const { AnonActivityLog, categoryOfFamily } = loadTs('src/shared/anonActivity.ts');
const { AnonProxy } = loadTs('src/main/anonProxy.ts');
const { PseudonymMap } = loadTs('src/shared/anonymize.ts');

const EMPTY = { terms: [], ticketPrefixes: [], secrets: [] };

test('git remotes: scp, ssh, https and Azure DevOps shapes', () => {
  assert.deepEqual(parseGitRemote('git@github.com:acme-labs/falcon-api.git'), { host: 'github.com', path: ['acme-labs', 'falcon-api'] });
  assert.deepEqual(parseGitRemote('https://git.acme.io/platform/billing.git'), { host: 'git.acme.io', path: ['platform', 'billing'] });
  assert.deepEqual(parseGitRemote('ssh://git@git.acme.io:2222/platform/billing.git'), { host: 'git.acme.io', path: ['platform', 'billing'] });
  assert.deepEqual(parseGitRemote('https://dev.azure.com/acme/Payments/_git/ledger'), { host: 'dev.azure.com', path: ['acme', 'Payments', 'ledger'] });
  assert.equal(parseGitRemote('not a remote'), null);
  assert.equal(registrableDomain('db.eu.acme.co.uk'), 'acme.co.uk');
  assert.equal(registrableDomain('jira.acme.com'), 'acme.com');
});

test('suggestions: categories and NATO codenames prefilled, dictionary entries skipped', () => {
  const s = suggestEntries({
    gitRemotes: ['git@github.com:acme-labs/falcon-api.git', 'https://git.acme.io/platform/billing.git'],
    emails: ['jane.doe@acme.io', 'me@gmail.com'],
    jiraProjects: [{ key: 'INFOSEC', name: 'Information Security', site: 'acme.atlassian.net' }, { key: 'OPS', name: 'Operations' }],
    confluenceSpaces: [{ key: 'ENG', name: 'Engineering Handbook' }, { key: '~jdoe', name: 'Jane Doe' }],
    connectionUrls: ['https://acme.atlassian.net/rest/api/3'],
    ticketKeys: ['PAY-12', 'PAY-13', 'bmt-1'],
    configTexts: [{ file: 'repo/app.yaml', text: 'db: postgres.prod.acme.io\nregistry: registry.npmjs.org\nlocal: cache01.corp\n' }]
  }, { terms: [{ term: 'Operations', category: 'team' }], ticketPrefixes: ['OPS'], secrets: [] });
  const terms = s.filter((x) => x.kind === 'term').map((x) => x.entry);
  const byTerm = Object.fromEntries(terms.map((e) => [e.term, e]));
  assert.equal(byTerm['acme-labs'].category, 'company');
  assert.equal(byTerm['acme-labs'].as, 'Company Alpha');
  assert.deepEqual(byTerm['acme-labs'].aliases, ['Acme Labs']);
  assert.equal(byTerm['falcon-api'].category, 'project');
  assert.equal(byTerm['falcon-api'].as, 'Project Alpha');
  assert.equal(byTerm['Information Security'].as, 'Project Charlie');
  assert.equal(byTerm['acme.io'].category, 'domain');
  assert.equal(byTerm['acme.io'].as, undefined);
  assert.equal(byTerm.acme.category, 'company');
  assert.ok(byTerm['cache01.corp']);
  assert.equal(byTerm['Engineering Handbook'].aliases[0], 'ENG');
  assert.ok(!byTerm['Jane Doe'], 'personal Confluence spaces are skipped');
  assert.ok(!byTerm['gmail.com'] && !byTerm['github.com'] && !byTerm['npmjs.org'], 'public domains are skipped');
  assert.ok(!byTerm.Operations, 'already in the dictionary');
  const prefixes = s.filter((x) => x.kind === 'ticketPrefix').map((x) => x.prefix);
  assert.deepEqual(prefixes.sort(), ['INFOSEC', 'PAY']);
});

test('.env: secret-looking variables by name only; values never in a suggestion', () => {
  const env = 'API_TOKEN=tok_live_8f8f8f8f8f\nDATABASE_URL=postgres://app:pa55w0rd@db.prod.acme.io:5432/app\nexport STRIPE_SECRET_KEY="sk_live_123456"\nAPP_NAME=billing\n';
  const vars = parseEnvFile(env);
  assert.deepEqual(vars.find((v) => v.name === 'API_TOKEN').hosts, []);
  assert.deepEqual(vars.find((v) => v.name === 'DATABASE_URL').hosts, ['db.prod.acme.io']);
  const s = suggestEntries({ emails: ['x@acme.io'], envVars: vars.map((v) => ({ ...v, file: 'repo/.env' })) }, EMPTY);
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /tok_live|pa55w0rd|sk_live/);
  assert.deepEqual(s.filter((x) => x.kind === 'envSecret').map((x) => x.name).sort(), ['API_TOKEN', 'STRIPE_SECRET_KEY']);
  assert.equal(envValue(env, 'STRIPE_SECRET_KEY'), 'sk_live_123456');
  assert.equal(envValue(env, 'MISSING'), undefined);
  assert.deepEqual(hostsIn('see package.json and index.ts at api.acme.io'), ['api.acme.io']);
});

test('gather: repos, .gitconfig, config files, .env and Jira/Confluence through the connections', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-gather-'));
  try {
    const repo = path.join(root, 'billing');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'config'));
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@git.acme.io:platform/billing.git\n[user]\n\temail = jane@acme.io\n');
    fs.writeFileSync(path.join(repo, '.env'), 'DB_PASSWORD=hunter2hunter2\nAPI_HOST=api.internal.acme.io\n');
    fs.writeFileSync(path.join(repo, 'config', 'app.yaml'), 'upstream: https://ledger.acme.io/v1\n');
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\temail = jane.doe@acme.io\n');
    const asked = [];
    const fetchJson = async (url, headers) => {
      asked.push({ url, auth: headers.Authorization });
      if (url.includes('/project/search')) return { values: [{ key: 'PAY', name: 'Payments Platform' }] };
      if (url.includes('/spaces')) return { results: [{ key: 'ENG', name: 'Engineering' }] };
      throw new Error('unexpected');
    };
    const g = await gatherSuggestSources({
      repos: [repo],
      home,
      ticketKeys: ['PAY-1'],
      connections: [
        { label: 'Jira', baseUrl: 'https://acme.atlassian.net/rest/api/3', headers: () => ({ Authorization: 'Basic x' }) },
        { label: 'Confluence', baseUrl: 'https://acme.atlassian.net/wiki/api/v2', headers: () => ({ Authorization: 'Basic x' }) },
        { label: 'Template', baseUrl: 'https://your-domain.atlassian.net/rest/api/3', headers: () => ({}) }
      ],
      fetchJson
    });
    assert.deepEqual(asked.map((a) => a.url), ['https://acme.atlassian.net/rest/api/3/project/search?maxResults=100', 'https://acme.atlassian.net/wiki/api/v2/spaces?limit=100']);
    assert.deepEqual(g.sources.gitRemotes, ['git@git.acme.io:platform/billing.git']);
    assert.deepEqual(g.sources.emails.sort(), ['jane.doe@acme.io', 'jane@acme.io']);
    assert.deepEqual(g.sources.jiraProjects.map((p) => p.key), ['PAY']);
    assert.deepEqual(g.sources.confluenceSpaces.map((p) => p.name), ['Engineering']);
    assert.doesNotMatch(JSON.stringify(g.sources), /hunter2/);
    assert.equal(envSecretValue(g.envFiles['billing/.env'], 'DB_PASSWORD'), 'hunter2hunter2');
    const s = suggestEntries(g.sources, EMPTY);
    assert.ok(s.some((x) => x.kind === 'envSecret' && x.name === 'DB_PASSWORD'));
    assert.ok(s.some((x) => x.kind === 'term' && x.entry.term === 'Payments Platform'));
    assert.ok(s.some((x) => x.kind === 'term' && x.entry.term === 'acme.io'));
    assert.deepEqual(parseGitConfig('[remote]\n url = a\n pushurl = b\n'), { urls: ['a', 'b'], emails: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('activity log: codenames and categories only, counted per request', () => {
  const log = new AnonActivityLog();
  log.record('a1', [{ family: 'term:system', placeholder: 'System S1' }, { family: 'email', placeholder: 'user1@example.invalid' }], 1000);
  log.record('a1', [{ family: 'term:system', placeholder: 'System S1' }], 2000);
  const a = log.get('a1');
  assert.equal(a.total, 3);
  assert.equal(a.requests, 2);
  assert.deepEqual(a.rows[0], { codename: 'System S1', category: 'term', term: 'system', count: 2, firstAt: 1000, lastAt: 2000 });
  assert.equal(log.get('nobody').total, 0);
  assert.deepEqual(categoryOfFamily('token:SECRET'), { category: 'secret' });
  assert.deepEqual(categoryOfFamily('host'), { category: 'domain' });
});

test('proxy: per-agent substitutions carry no real value; preview leaves the map alone', async () => {
  const up = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"content":[]}'); }); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
  const recorded = [];
  const map = new PseudonymMap();
  const proxy = new AnonProxy({
    settings: () => ({ enabled: true }),
    dictionary: () => ({ terms: [{ term: 'Project Falcon', category: 'project' }], ticketPrefixes: [], secrets: [] }),
    loadMap: () => map,
    saveMap: () => {},
    onSubstitutions: (agentId, subs) => recorded.push({ agentId, subs })
  });
  await proxy.start();
  try {
    const p = proxy.preview('/office', 'Ship Project Falcon');
    assert.equal(p.output, 'Ship Project P1');
    assert.equal(map.size, 0, 'a preview assigns nothing');
    const base = proxy.addRoute('agent-7', '/office', up.url);
    await new Promise((resolve, reject) => {
      const u = new URL(`${base}/v1/messages`);
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end(JSON.stringify({ messages: [{ role: 'user', content: 'Project Falcon and Project Falcon' }] }));
    });
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].agentId, 'agent-7');
    assert.deepEqual(recorded[0].subs, [{ family: 'term:project', placeholder: 'Project P1' }, { family: 'term:project', placeholder: 'Project P1' }]);
    assert.doesNotMatch(JSON.stringify(recorded), /Falcon/);
  } finally { proxy.stop(); up.srv.close(); }
});
