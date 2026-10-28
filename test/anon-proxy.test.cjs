'use strict';

// The anonymization proxy end to end against a fake model API on loopback:
// what reaches the upstream carries codenames, what reaches the CLI the real
// values (JSON and SSE), headers pass through, unreadable bodies are refused,
// unknown routes are refused, and the office's map is persisted.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { AnonProxy, requestFlavor, upstreamUrl } = loadTs('src/main/anonProxy.ts');
const { AnonStore } = loadTs('src/main/anonStore.ts');

const DICT = { terms: [{ term: 'Project Falcon', category: 'project' }, { term: 'Acme Corp', category: 'company', as: 'Globex' }], ticketPrefixes: ['INFOSEC'], secrets: ['hunter2-super'] };

function fakeUpstream(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function call(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function makeProxy(saved) {
  return new AnonProxy({
    settings: () => ({ enabled: true }),
    dictionary: () => DICT,
    loadMap: () => new (loadTs('src/shared/anonymize.ts').PseudonymMap)(),
    saveMap: (office, map) => saved.push({ office, json: map.toJSON() })
  });
}

test('paths: request flavor and upstream join', () => {
  assert.equal(requestFlavor('/v1/messages?beta=true'), 'anthropic');
  assert.equal(requestFlavor('/v1/messages/count_tokens'), 'anthropic');
  assert.equal(requestFlavor('/chat/completions'), 'openai-chat');
  assert.equal(requestFlavor('/v1/models'), null);
  assert.equal(upstreamUrl('https://api.anthropic.com/', '/v1/messages?beta=true').href, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(upstreamUrl('https://api.openai.com/v1', '/chat/completions').href, 'https://api.openai.com/v1/chat/completions');
});

test('JSON: upstream sees codenames, the CLI gets real values, headers pass through', async () => {
  const up = await fakeUpstream((req, res, body) => {
    const j = JSON.parse(body);
    const text = `Reply about ${j.messages[0].content.match(/Project P\d+/)[0]} and Globex`;
    const out = JSON.stringify({ id: 'm1', type: 'message', role: 'assistant', content: [{ type: 'text', text }] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(out);
  });
  const saved = [];
  const proxy = makeProxy(saved);
  await proxy.start();
  try {
    const base = proxy.addRoute('agent-1', '/office', up.url);
    const reqBody = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 16, messages: [{ role: 'user', content: 'Status of Project Falcon for Acme Corp? INFOSEC-12, pw hunter2-super' }] });
    const r = await call(`${base}/v1/messages?beta=true`, { headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' }, body: reqBody });
    assert.equal(r.status, 200);
    const sent = up.seen[0];
    assert.equal(sent.url, '/v1/messages?beta=true');
    assert.equal(sent.headers['x-api-key'], 'sk-test');
    assert.equal(sent.headers['anthropic-version'], '2023-06-01');
    assert.equal(Number(sent.headers['content-length']), Buffer.byteLength(sent.body));
    assert.doesNotMatch(sent.body, /Falcon|Acme|INFOSEC-12|hunter2/);
    assert.match(sent.body, /Project P1/);
    assert.match(sent.body, /Globex/);
    assert.match(sent.body, /TICKET-1/);
    assert.match(sent.body, /\[SECRET_1\]/);
    assert.match(sent.body, /claude-sonnet-5-5/);
    const got = JSON.parse(r.body);
    assert.equal(got.content[0].text, 'Reply about Project Falcon and Acme Corp');
    assert.equal(Number(r.headers['content-length']), Buffer.byteLength(r.body));
    proxy.stop();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].office, '/office');
    assert.ok(saved[0].json.entries.some((e) => e.value === 'Project Falcon'));
  } finally { proxy.stop(); up.srv.close(); }
});

test('SSE: a codename split across chunks is restored in the stream', async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    const pieces = ['Working on Proj', 'ect P1 today'];
    res.write(ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    for (const p of pieces) {
      const s = ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } });
      res.write(s.slice(0, 20));
      res.write(s.slice(20));
    }
    res.write(ev({ type: 'content_block_stop', index: 0 }));
    res.end(ev({ type: 'message_stop' }));
  });
  const proxy = makeProxy([]);
  await proxy.start();
  try {
    const base = proxy.addRoute('agent-1', '/office', up.url);
    const r = await call(`${base}/v1/messages`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'Project Falcon' }] }) });
    assert.equal(r.status, 200);
    const text = r.body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).filter((o) => o.type === 'content_block_delta').map((o) => o.delta.text).join('');
    assert.equal(text, 'Working on Project Falcon today');
  } finally { proxy.stop(); up.srv.close(); }
});

test('fail closed: unknown route and unreadable bodies never reach the upstream', async () => {
  const up = await fakeUpstream((req, res) => { res.writeHead(200); res.end('{}'); });
  const proxy = makeProxy([]);
  await proxy.start();
  try {
    const base = proxy.addRoute('agent-1', '/office', up.url);
    const bad = await call(`${proxy.url()}/a/AAAAAAAAAAAAAAAAAAAAAAAA/v1/messages`, { body: '{}' });
    assert.equal(bad.status, 403);
    const notJson = await call(`${base}/v1/messages`, { headers: { 'content-type': 'text/plain' }, body: 'Project Falcon' });
    assert.equal(notJson.status, 415);
    const gz = await call(`${base}/v1/messages`, { headers: { 'content-encoding': 'gzip' }, body: '{"a":1}' });
    assert.equal(gz.status, 415);
    assert.equal(up.seen.length, 0);
    // A GET with no body passes through.
    const get = await call(`${base}/v1/models`, { method: 'GET' });
    assert.equal(get.status, 200);
    assert.equal(up.seen.length, 1);
  } finally { proxy.stop(); up.srv.close(); }
});

test('store: the dictionary and the map are encrypted when the codec can, plain otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-store-'));
  try {
    const codec = { available: () => true, encrypt: (s) => Buffer.from(s).toString('base64'), decrypt: (c) => Buffer.from(c, 'base64').toString() };
    const store = new AnonStore(dir, codec);
    assert.equal(store.writeDictionary(DICT).encrypted, true);
    const raw = fs.readFileSync(path.join(dir, 'dictionary.json'), 'utf8');
    assert.doesNotMatch(raw, /Falcon|hunter2/);
    assert.deepEqual(store.readDictionary().secrets, ['hunter2-super']);
    const { PseudonymMap } = loadTs('src/shared/anonymize.ts');
    const m = new PseudonymMap();
    m.placeholderFor('term:project', 'Project Falcon');
    store.saveMap('/office', m);
    assert.equal(store.loadMap('/office').original('Project P1'), 'Project Falcon');
    assert.equal(store.loadMap('/other').size, 0);
    // Cannot decrypt: empty dictionary, with the reason kept for Settings.
    const blind = new AnonStore(dir, { ...codec, decrypt: () => undefined });
    assert.deepEqual(blind.readDictionary().terms, []);
    assert.match(blind.dictionaryError, /another user or machine/);
    const plain = new AnonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'anon-plain-')), { available: () => false, encrypt: () => { throw new Error('no'); }, decrypt: () => undefined });
    assert.equal(plain.writeDictionary(DICT).encrypted, false);
    assert.equal(plain.readDictionary().terms.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
