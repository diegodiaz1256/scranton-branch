'use strict';
/**
 * The office browser: agents read pages with the app's own Chromium (browser.ts)
 * through the integration broker, by command (md-browse) or MCP (munder-browser).
 * Web switched off for an agent closes it in its tools, its prompt AND the broker.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const B = loadTs('src/shared/browsePage.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { MD_BROWSE } = loadTs('src/main/browseCli.ts');

test('which URLs may be opened', () => {
  assert.equal(B.browseUrlProblem('https://example.com/a?b=1'), null);
  assert.equal(B.browseUrlProblem('http://localhost:3000/'), null, 'a local dev server is a real use');
  assert.match(B.browseUrlProblem('file:///etc/passwd'), /only http and https/);
  assert.match(B.browseUrlProblem('javascript:alert(1)'), /only http and https/);
  assert.match(B.browseUrlProblem('http://169.254.169.254/latest/meta-data/'), /metadata/);
  assert.match(B.browseUrlProblem('https://user:pw@example.com/'), /credentials/);
  assert.match(B.browseUrlProblem(''), /required/);
});

test('the user agent is the Chrome one, without Electron and the app', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) munder-difflin/0.4.6-fork.30 Chrome/128.0.6613.186 Electron/32.3.3 Safari/537.36';
  assert.equal(B.chromeUserAgent(ua), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36');
});

test('what the agent gets back', () => {
  const out = B.formatBrowsed({ title: 'T', url: 'https://x/', text: 'a'.repeat(3000), links: [{ text: 'L', href: 'https://x/l' }], status: 403 }, { size: 1000, mode: 'article', withLinks: true });
  assert.match(out, /^# T\nURL: https:\/\/x\/ \(HTTP 403\)/);
  assert.match(out, /page 1 of 3 · next: page 2/);
  assert.match(out, /- \[L\]\(https:\/\/x\/l\)/);
  assert.equal(B.browseChars(undefined), B.BROWSE_DEFAULT_CHARS);
  assert.equal(B.browseChars(10_000_000), B.BROWSE_MAX_CHARS);
  const s = B.formatSearch('q', [{ title: 'R', href: '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp&rut=x', snippet: 'S' }], '');
  assert.match(s, /1\. \[R\]\(https:\/\/example\.com\/p\)\n {3}S/);
});

async function broker(t, { webOff = false } = {}) {
  const calls = [];
  const b = new IntegrationBroker({
    getRecord: () => undefined, getSecret: () => undefined,
    browser: {
      blocked: (agentId) => (webOff && agentId === 'jim' ? 'Web is switched off for this agent (Capabilities), so the office browser is too.' : null),
      browse: async (url, o) => { calls.push(['browse', url, o]); return `PAGE ${url}`; },
      search: async (q) => { calls.push(['search', q]); return `RESULTS ${q}`; }
    }
  });
  const r = await b.start(0);
  assert.ok(r.ok);
  t.after(() => b.stop());
  return { b, calls, token: b.grant('pty-jim', [], {}, 'jim') };
}

const post = (b, token, route, body) => fetch(`${b.url()}/${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('broker: /browse and /search reach the browser', async (t) => {
  const { b, calls, token } = await broker(t);
  const r1 = await post(b, token, 'browse', { url: 'https://example.com', links: true, max_chars: 5000 });
  assert.equal(r1.status, 200);
  assert.equal(await r1.text(), 'PAGE https://example.com');
  const r2 = await post(b, token, 'search', { query: 'warhammer' });
  assert.equal(await r2.text(), 'RESULTS warhammer');
  assert.deepEqual(calls, [['browse', 'https://example.com', { links: true, maxChars: 5000, page: 1, mode: undefined }], ['search', 'warhammer']]);
  const get = await fetch(`${b.url()}/browse`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(get.status, 405);
  const anon = await fetch(`${b.url()}/browse`, { method: 'POST', body: '{}' });
  assert.equal(anon.status, 401, 'no token, no browser');
});

test('broker: Web switched off closes the browser too', async (t) => {
  const { b, calls, token } = await broker(t, { webOff: true });
  const r = await post(b, token, 'browse', { url: 'https://example.com' });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /Web is switched off/);
  assert.deepEqual(calls, []);
});

test('md-browse as a command and as an MCP server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-browse-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'md-browse.cjs');
  fs.writeFileSync(script, MD_BROWSE);
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push([req.url, req.headers.authorization, JSON.parse(body)]); res.end(`OK ${req.url}`); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const env = { ...process.env, MD_BROKER_URL: `http://127.0.0.1:${server.address().port}`, MD_BROKER_TOKEN: 'tok' };

  const cli = (args) => new Promise((resolve, reject) => execFile(process.execPath, [script, ...args], { env }, (e, out) => (e ? reject(e) : resolve(out))));
  assert.equal(await cli(['https://example.com', '--links', '--chars', '3000']), 'OK /browse\n');
  assert.equal(await cli(['--search', 'pintura miniaturas']), 'OK /search\n');
  assert.deepEqual(seen.slice(0, 2), [
    ['/browse', 'Bearer tok', { url: 'https://example.com', links: true, max_chars: 3000 }],
    ['/search', 'Bearer tok', { query: 'pintura miniaturas' }]
  ]);

  const mcp = spawn(process.execPath, [script], { env });
  t.after(() => mcp.kill());
  const lines = [];
  let buf = '';
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => mcp.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browse_page', arguments: { url: 'https://example.org' } } });
  for (let i = 0; i < 50 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 100));
  const byId = Object.fromEntries(lines.map((l) => [l.id, l.result]));
  assert.equal(byId[1].serverInfo.name, 'munder-browser');
  assert.deepEqual(byId[2].tools.map((x) => x.name), ['browse_page', 'web_search']);
  assert.equal(byId[3].content[0].text, 'OK /browse');
});

test('agents get the browser in their tools, unless Web is off', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-browse-hive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const on = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, {});
  const off = await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home }, { toolBlocks: ['web'] });
  const servers = (inj) => Object.keys(JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers);
  const prompt = (inj) => inj.args[inj.args.indexOf('--append-system-prompt') + 1];
  assert.ok(servers(on).includes('munder-browser'));
  assert.ok(!servers(off).includes('munder-browser'));
  // Claude agents hear about it when a WebFetch fails (hook), not up front.
  assert.doesNotMatch(prompt(on), /BROWSER:/);
  assert.doesNotMatch(prompt(off), /BROWSER:/);
  assert.ok(fs.existsSync(path.join(home, 'hive', 'bin', 'md-browse.cjs')));
  const codex = await hive.ensureAgent({ id: 'oscar', name: 'Oscar', provider: 'codex', cwd: home }, {});
  const cp = codex.args[codex.args.length - 1];
  assert.match(cp, /BROWSER: .*md-browse\.cjs/);
  assert.doesNotMatch(cp, /munder-browser tools/, 'no MCP promised to a CLI that does not get it');
});

test('web search leaves out sponsored results', () => {
  // Live from WSL: the first "result" for a Warhammer query was an Amazon ad
  // (DuckDuckGo's /y.js ad redirect).
  const result = (href, { ad = false, adClass = false } = {}) => ({
    matches: (sel) => adClass && sel.includes('result--ad'),
    querySelector: (sel) => sel === 'a.result__a' ? { href, innerText: 'T ' + href } : sel === '.result__snippet' ? { innerText: 'S' } : sel === '.badge--ad' ? (ad ? {} : null) : null
  });
  const document = { querySelectorAll: () => [
    result('https://duckduckgo.com/y.js?ad_domain=amazon.es'),
    result('https://ads.example/', { adClass: true }),
    result('https://shop.example/', { ad: true }),
    result('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwarhammer.com%2F')
  ], body: { innerText: '' } };
  const out = new Function('document', 'return ' + B.EXTRACT_SEARCH_SCRIPT)(document);
  assert.deepEqual(out.results.map((r) => r.href), ['https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwarhammer.com%2F']);
});

test('a failed WebFetch is answered with the office browser, not the prompt', async (t) => {
  assert.equal(B.webFetchFailed('PostToolUseFailure', 'Request failed with status code 403', undefined), true);
  assert.equal(B.webFetchFailed('PostToolUseFailure', 'The user doesn\'t want to proceed with this tool use', undefined), false);
  assert.equal(B.webFetchFailed('PostToolUse', undefined, 'The page shows "Just a moment..." and asks to enable JavaScript.'), true);
  assert.equal(B.webFetchFailed('PostToolUse', undefined, 'ok'), true, 'next to empty');
  assert.equal(B.webFetchFailed('PostToolUse', undefined, 'The article explains how Electron renders pages with Chromium and lists the release dates of every major version since 2016.'), false);
  // Claude agents: no browser line in the prompt; the hook registers failures.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-browse-hint-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const inj = await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd: home }, {});
  assert.doesNotMatch(inj.args[inj.args.indexOf('--append-system-prompt') + 1], /BROWSER:/);
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  assert.equal(settings.hooks.PostToolUseFailure[0].matcher, 'WebFetch');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/hooks.ts'), 'utf8');
  assert.match(src, /p\.tool_name === 'WebFetch' && webFetchFailed\(event, p\.error, p\.tool_response\) \? WEB_FETCH_HINT : null/);
});

// Lean output (the reader from the Crawl4AI/Fortress work): main content,
// pages from a cache, and the page's words marked as data.
test('pages break at paragraphs, and the last page says there is no next', () => {
  const para = (n) => `Paragraph ${n}. ` + 'word '.repeat(60).trim();
  const text = Array.from({ length: 40 }, (_, i) => para(i + 1)).join('\n\n');
  const one = B.pageOf(text, 1, 2000);
  assert.ok(one.pages > 1);
  assert.ok(one.body.endsWith('word'), 'a piece ends at a paragraph, not mid-word');
  const all = Array.from({ length: one.pages }, (_, i) => B.pageOf(text, i + 1, 2000).body).join('\n\n');
  assert.equal(all, text, 'the pages put together are the whole text');
  assert.equal(B.pageOf(text, 999, 2000).page, one.pages, 'a page past the end is the last one');
  const last = B.formatBrowsed({ title: 'T', url: 'https://x/', text }, { page: one.pages, size: 2000, mode: 'article', withLinks: false });
  assert.doesNotMatch(last, /next: page/);
});

test('the page text is marked as untrusted; article and full read different text', () => {
  const p = { title: 'T', url: 'https://x/', text: 'Only the story.', fullText: 'Menu · Only the story. · Footer' };
  const art = B.formatBrowsed(p, { size: 12000, mode: 'article', withLinks: false });
  assert.match(art, /<untrusted-web-content>\nOnly the story\.\n<\/untrusted-web-content>/);
  assert.match(art, /Main content · page 1 of 1 · menus, footers and ads left out/);
  const full = B.formatBrowsed(p, { size: 12000, mode: 'full', withLinks: false });
  assert.match(full, /Menu · Only the story\. · Footer/);
  assert.equal(B.browseMode('full'), 'full');
  assert.equal(B.browseMode('anything'), 'article', 'article unless full is asked for');
});

test('the cache keeps a page for its next pages, then forgets it', () => {
  let now = 0;
  const c = new B.BrowseCache(1000, 2, () => now);
  c.set('https://a/', { title: 'A', url: 'https://a/', text: 'a' });
  assert.equal(c.get('https://a/').title, 'A');
  now = 1001;
  assert.equal(c.get('https://a/'), undefined, 'expired');
  c.set('https://1/', { title: '1', url: '', text: '' });
  c.set('https://2/', { title: '2', url: '', text: '' });
  c.set('https://3/', { title: '3', url: '', text: '' });
  assert.equal(c.get('https://1/'), undefined, 'oldest dropped past the limit');
  assert.equal(c.get('https://3/').title, '3');
});
