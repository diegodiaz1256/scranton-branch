'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { Anonymizer, PseudonymMap, apiForPath } = loadTs('src/shared/anonymize.ts');

const OPTS = {
  terms: [
    { term: ['SAP-FI', 'SAP FI', 'sapfi'], category: 'system' },
    { term: 'Société Générale', category: 'customer' },
    { term: 'Acme Corp', category: 'company', as: 'Globex' },
    { term: 'Project Falcon', category: 'project' },
    { term: 'Blue Team', category: 'team' },
    'Initech'
  ],
  domains: ['corp.acme.com'],
  ticketPrefixes: ['INFOSEC'],
  secrets: ['s3cr"et\\pw!']
};

const make = (opts = OPTS, map) => new Anonymizer(opts, map);

// A realistic piece of user text with everything in it.
const SENSITIVE = [
  'Ping alice.smith@acme.com about INFOSEC-123 on db1.corp.acme.com (10.20.30.40, subnet 10.20.0.0/16).',
  'Acme Corp and Société Générale use SAP-FI (a.k.a. sapfi / SAP FI) for Project Falcon; Blue Team owns it, with Initech.',
  'Use password s3cr"et\\pw! and token ghp_abcdefghijklmnop1234 with Authorization: Bearer abcdefgh12345678.'
].join('\n');

test('pseudonymizes every category and restores the exact text', () => {
  const a = make();
  const p = a.pseudonymizeText(SENSITIVE);
  for (const leak of ['alice.smith', 'acme.com', 'INFOSEC-123', '10.20.30.40', '10.20.0.0', 'Acme Corp', 'Société', 'SAP-FI', 'sapfi', 'SAP FI', 'Falcon', 'Blue Team', 'Initech', 's3cr"et', 'ghp_', 'abcdefgh12345678']) {
    assert.ok(!p.includes(leak), `leaked ${leak}: ${p}`);
  }
  assert.match(p, /user1@example\.invalid/);
  assert.match(p, /TICKET-1\b/);
  assert.match(p, /host1\.example\.invalid/);
  assert.match(p, /192\.0\.2\.1\b/);
  assert.match(p, /192\.0\.2\.2\/16/);
  assert.match(p, /\bGlobex\b/);
  assert.match(p, /Customer CU1/);
  assert.match(p, /Project P1/);
  assert.match(p, /Team T1/);
  assert.match(p, /Term X1/);
  assert.match(p, /\[SECRET_1\]/);
  // Aliases share one codename and restore to the canonical spelling.
  assert.equal((p.match(/System S1/g) || []).length, 3);
  const restored = a.restoreText(p);
  assert.equal(restored, SENSITIVE.replace('sapfi', 'SAP-FI').replace('SAP FI', 'SAP-FI'));
});

test('dictionary: user replacement, per-category codenames, never renumbered', () => {
  const dict = {
    terms: [
      { term: 'Alpha', category: 'system' },
      { term: 'Beta', category: 'system' },
      { term: 'Gamma', category: 'project' },
      { term: 'Dana Scully', category: 'person' },
      { term: 'Onboarding review', category: 'process-step' },
      { term: 'Widget', category: 'product' },
      { term: 'Delta', category: 'system', as: 'System Zeta' }
    ]
  };
  const a = make(dict);
  assert.equal(a.pseudonymizeText('Beta then Gamma'), 'System S1 then Project P1');
  assert.equal(a.pseudonymizeText('alpha, BETA, Delta'), 'System S2, System S1, System Zeta');
  assert.equal(a.pseudonymizeText('Dana Scully did the Onboarding review of Widget'), 'Person PE1 did the Step ST1 of Product PR1');
  assert.equal(a.restoreText('System Zeta talks to System S2 and System S1'), 'Delta talks to Alpha and Beta');
  // System S1 is not System S10.
  assert.equal(a.restoreText('System S10'), 'System S10');
  // Serialized and reloaded: same numbers, next number continues.
  const b = make(dict, PseudonymMap.fromJSON(JSON.parse(JSON.stringify(a.map))));
  assert.equal(b.pseudonymizeText('Beta Alpha'), 'System S1 System S2');
});

test('a user replacement that collides with a taken placeholder falls back to a codename', () => {
  const a = make({ terms: [{ term: 'One', category: 'team' }, { term: 'Two', category: 'team', as: 'Team T1' }] });
  assert.equal(a.pseudonymizeText('One Two'), 'Team T1 Team T2');
  assert.equal(a.restoreText('Team T1 Team T2'), 'One Two');
});

test('domains: subdomains get their own host, a named domain keeps the labels', () => {
  const a = make({ domains: ['corp.acme.com'], terms: [{ term: 'intra.example.org', category: 'domain', as: 'intra.example.invalid' }] });
  const p = a.pseudonymizeText('corp.acme.com, db1.corp.acme.com, x.intra.example.org, intra.example.org, notcorp.acme.com.evil.io');
  assert.equal(p, 'host1.example.invalid, host2.example.invalid, x.intra.example.invalid, intra.example.invalid, notcorp.acme.com.evil.io');
  assert.equal(a.restoreText(p), 'corp.acme.com, db1.corp.acme.com, x.intra.example.org, intra.example.org, notcorp.acme.com.evil.io');
});

test('stable across calls and turns: prompt prefix stays byte-identical', () => {
  const a = make();
  const turn1 = { model: 'claude-sonnet-4-5', system: [{ type: 'text', text: 'You help Acme Corp.', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: SENSITIVE }] };
  const r1 = JSON.stringify(a.rewriteRequest(turn1, 'anthropic'));
  const turn2 = JSON.parse(JSON.stringify(turn1));
  turn2.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Mailed bob@acme.com about INFOSEC-999 and 172.16.0.9.' }] });
  turn2.messages.push({ role: 'user', content: 'thanks, also carol@acme.com' });
  const r2 = JSON.stringify(a.rewriteRequest(turn2, 'anthropic'));
  const prefix = r1.slice(0, r1.lastIndexOf(']}'));
  assert.ok(r2.startsWith(prefix), 'turn 2 starts with turn 1 bytes');
  // A fresh anonymizer over the same map (e.g. after a restart) agrees.
  const b = make(OPTS, PseudonymMap.fromJSON(a.map.toJSON()));
  assert.equal(JSON.stringify(b.rewriteRequest(turn2, 'anthropic')), r2);
  // Numbering never changes: a new value takes the next number.
  assert.match(r2, /user2@example\.invalid/);
  assert.match(r2, /user3@example\.invalid/);
  assert.match(r2, /TICKET-2/);
});

test('no false positives on paths, identifiers, versions, model names, code', () => {
  const a = make();
  const safe = [
    'src/shared/agentSteps.ts', 'C:\\Users\\me\\proj\\file.txt', '/usr/lib/node_modules/@types/node@20.11.5/index.d.ts',
    'v1.2.3.4', 'version 10.0.19041.1', '1.2.3', 'release-1.2.3.4', 'claude-sonnet-4-5-20250929', 'gpt-4o-mini', 'gemini-2.5-pro',
    'AcmeCorpClient', 'acme_corp_id', 'useInitechHook', 'const SAP_FI_MODE = 1', 'git@github.com:org/repo.git',
    'API_KEY===undefined', 'localhost 127.0.0.1 0.0.0.0', 'user1@example.invalid host1.example.invalid 192.0.2.7',
    'INFOSEC_TEAM', 'see 2026-10-24 at 10:20', 'package@1.2.3', '@decorator.name', 'a.b.c.d', '{"name": "value"}'
  ].join('\n');
  assert.equal(a.pseudonymizeText(safe), safe);
  assert.equal(a.map.size, 0);
});

test('categories can be turned off one by one', () => {
  const a = make({ ...OPTS, categories: { email: false, ipv4: false, ticket: false } });
  const p = a.pseudonymizeText('alice@acme.com 10.1.2.3 INFOSEC-1 Initech');
  assert.equal(p, 'alice@acme.com 10.1.2.3 INFOSEC-1 Term X1');
});

test('requests: only text values change, never keys/model/tools/cache_control', () => {
  const a = make();
  const tools = [{ name: 'notify_Initech', description: 'Initech', input_schema: { type: 'object', properties: { 'alice@acme.com': { type: 'string' } } } }];
  const body = {
    model: 'claude-opus-4-1',
    tools,
    system: 'Work for Initech.',
    metadata: { user_id: 'alice@acme.com' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Mail alice@acme.com', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'Initech', signature: 'sig' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ssh db1.corp.acme.com', 'alice@acme.com': ['10.9.8.7'] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok from 10.9.8.7' }] }] }
    ]
  };
  const before = JSON.stringify(body);
  const out = a.rewriteRequest(body, 'anthropic');
  assert.equal(JSON.stringify(body), before, 'input not mutated');
  assert.deepEqual(out.tools, tools);
  assert.deepEqual(out.metadata, body.metadata);
  assert.equal(out.system, 'Work for Term X1.');
  assert.deepEqual(out.messages[0].content[0], { type: 'text', text: 'Mail user1@example.invalid', cache_control: { type: 'ephemeral' } });
  assert.equal(out.messages[1].content[0].thinking, 'Initech', 'signed thinking untouched');
  assert.deepEqual(out.messages[1].content[1].input, { command: 'ssh host1.example.invalid', 'alice@acme.com': ['192.0.2.1'] });
  assert.equal(out.messages[2].content[0].content[0].text, 'ok from 192.0.2.1');

  const chat = a.rewriteRequest({
    model: 'gpt-4o', tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
    messages: [
      { role: 'system', content: 'Initech' },
      { role: 'user', content: [{ type: 'text', text: 'alice@acme.com' }, { type: 'image_url', image_url: { url: 'https://corp.acme.com/x.png' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{"to":"alice@acme.com","n":1}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'sent to alice@acme.com' }
    ]
  }, 'openai-chat');
  assert.equal(chat.messages[0].content, 'Term X1');
  assert.equal(chat.messages[1].content[0].text, 'user1@example.invalid');
  assert.equal(chat.messages[1].content[1].image_url.url, 'https://corp.acme.com/x.png');
  assert.equal(chat.messages[2].tool_calls[0].function.arguments, '{"to":"user1@example.invalid","n":1}');
  assert.equal(chat.messages[3].content, 'sent to user1@example.invalid');

  const resp = a.rewriteRequest({
    model: 'gpt-5', instructions: 'Initech rules',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'alice@acme.com' }] },
      { type: 'function_call', call_id: 'x', name: 'f', arguments: '{"host":"corp.acme.com"}' },
      { type: 'function_call_output', call_id: 'x', output: 'up: corp.acme.com' }
    ]
  }, 'openai-responses');
  assert.equal(resp.instructions, 'Term X1 rules');
  assert.equal(resp.input[0].content[0].text, 'user1@example.invalid');
  assert.equal(resp.input[1].arguments, '{"host":"host2.example.invalid"}');
  assert.equal(resp.input[2].output, 'up: host2.example.invalid');
});

test('apiForPath', () => {
  assert.equal(apiForPath('/v1/messages?beta=true'), 'anthropic');
  assert.equal(apiForPath('/v1/messages/count_tokens'), null);
  assert.equal(apiForPath('/v1/chat/completions'), 'openai-chat');
  assert.equal(apiForPath('/v1/responses'), 'openai-responses');
});

// ─── responses ──────────────────────────────────────────────────────────────

function primed() {
  const a = make();
  a.pseudonymizeText(SENSITIVE);
  return a;
}

const MODEL_TEXT = 'Mailed user1@example.invalid re TICKET-1 on host1.example.invalid (192.0.2.1). System S1 for Customer CU1 — ok ✓ [SECRET_1] and bare SECRET_1. Not TICKET-12 or 192.0.2.10.';
const REAL_TEXT = 'Mailed alice.smith@acme.com re INFOSEC-123 on db1.corp.acme.com (10.20.30.40). SAP-FI for Société Générale — ok ✓ s3cr"et\\pw! and bare s3cr"et\\pw!. Not TICKET-12 or 192.0.2.10.';
const MODEL_TOOL = { command: 'ssh host1.example.invalid && echo "[SECRET_1]"', note: 'Customer CU1 é 😀', to: ['user1@example.invalid'] };
const REAL_TOOL = { command: 'ssh db1.corp.acme.com && echo "s3cr"et\\pw!"', note: 'Société Générale é 😀', to: ['alice.smith@acme.com'] };

test('whole response bodies are restored; unknown fields untouched', () => {
  const a = primed();
  const anth = a.restoreResponse({
    id: 'msg_1', model: 'claude', usage: { input_tokens: 3 }, extra: 'TICKET-1',
    content: [{ type: 'thinking', thinking: 'TICKET-1', signature: 's' }, { type: 'text', text: MODEL_TEXT }, { type: 'tool_use', id: 't', name: 'Bash', input: MODEL_TOOL }]
  }, 'anthropic');
  assert.equal(anth.extra, 'TICKET-1');
  assert.equal(anth.content[0].thinking, 'TICKET-1');
  assert.equal(anth.content[1].text, REAL_TEXT);
  assert.deepEqual(anth.content[2].input, REAL_TOOL);

  const chat = a.restoreResponse({ choices: [{ index: 0, message: { role: 'assistant', content: MODEL_TEXT, tool_calls: [{ function: { name: 'f', arguments: JSON.stringify(MODEL_TOOL) } }] } }] }, 'openai-chat');
  assert.equal(chat.choices[0].message.content, REAL_TEXT);
  assert.deepEqual(JSON.parse(chat.choices[0].message.tool_calls[0].function.arguments), REAL_TOOL);

  const resp = a.restoreResponse({ output_text: MODEL_TEXT, output: [{ type: 'message', content: [{ type: 'output_text', text: MODEL_TEXT }] }, { type: 'function_call', arguments: JSON.stringify(MODEL_TOOL) }] }, 'openai-responses');
  assert.equal(resp.output_text, REAL_TEXT);
  assert.equal(resp.output[0].content[0].text, REAL_TEXT);
  assert.deepEqual(JSON.parse(resp.output[1].arguments), REAL_TOOL);
});

// ─── streaming ──────────────────────────────────────────────────────────────

/** Cut a string into pieces of the given sizes, cycling. */
function pieces(s, sizes = [3, 1, 5, 2, 7]) {
  const out = [];
  let i = 0;
  let k = 0;
  while (i < s.length) { const n = sizes[k++ % sizes.length]; out.push(s.slice(i, i + n)); i += n; }
  return out;
}

const sse = (event, data, eol = '\n') => (event ? `event: ${event}${eol}` : '') + `data: ${JSON.stringify(data)}${eol}${eol}`;

function anthropicFixture() {
  let s = sse('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude', usage: { input_tokens: 1 } } });
  s += ': keep-alive comment\n\n';
  s += sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  s += sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'about TICKET-1' } });
  s += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
  s += sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  for (const p of pieces(MODEL_TEXT)) s += sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: p } });
  s += sse('content_block_stop', { type: 'content_block_stop', index: 1 });
  s += sse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} } });
  s += sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '' } });
  for (const p of pieces(JSON.stringify(MODEL_TOOL), [4, 2, 6])) s += sse('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: p } });
  s += sse('content_block_stop', { type: 'content_block_stop', index: 2 });
  s += sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 }, extra: 'TICKET-1' });
  s += sse('message_stop', { type: 'message_stop' });
  return s;
}

function openaiChatFixture(eol = '\r\n') {
  const base = { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o' };
  let s = sse(null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }, eol);
  for (const p of pieces(MODEL_TEXT)) s += sse(null, { ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] }, eol);
  const args = pieces(JSON.stringify(MODEL_TOOL), [5, 3]);
  s += sse(null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'f', arguments: '' } }] }, finish_reason: null }] }, eol);
  for (const p of args) s += sse(null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p } }] }, finish_reason: null }] }, eol);
  s += sse(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, eol);
  s += `data: [DONE]${eol}${eol}`;
  return s;
}

function responsesFixture() {
  let s = sse('response.created', { type: 'response.created', response: { id: 'r', output: [] } });
  for (const p of pieces(MODEL_TEXT)) s += sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg', output_index: 0, content_index: 0, delta: p });
  s += sse('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg', output_index: 0, content_index: 0, text: MODEL_TEXT });
  for (const p of pieces(JSON.stringify(MODEL_TOOL), [6, 1])) s += sse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc', output_index: 1, delta: p });
  s += sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc', output_index: 1, arguments: JSON.stringify(MODEL_TOOL) });
  s += sse('response.completed', { type: 'response.completed', response: { id: 'r', output: [{ type: 'message', content: [{ type: 'output_text', text: MODEL_TEXT }] }] } });
  return s;
}

/** Parse an SSE text into events: { event, data(obj|string) }. Every event must end with a blank line. */
function parseSse(text) {
  const events = [];
  const blocks = text.split(/\r\n\r\n|\n\n/);
  assert.equal(blocks.pop(), '', 'stream ends at an event boundary');
  for (const b of blocks) {
    let event;
    const data = [];
    for (const line of b.split(/\r\n|\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (!data.length) continue;
    const d = data.join('\n');
    events.push({ event, data: d === '[DONE]' ? d : JSON.parse(d) });
  }
  return events;
}

function runChunks(a, buf, cuts) {
  const r = a.createStreamRestorer();
  let out = '';
  let prev = 0;
  for (const c of [...cuts, buf.length]) { out += r.push(buf.subarray(prev, c)); prev = c; }
  return out + r.end();
}

function checkAnthropic(out) {
  const ev = parseSse(out);
  for (const e of ev) if (e.event) assert.equal(e.event, e.data.type);
  const text = ev.filter((e) => e.data.type === 'content_block_delta' && e.data.index === 1).map((e) => e.data.delta.text).join('');
  assert.equal(text, REAL_TEXT);
  const json = ev.filter((e) => e.data.type === 'content_block_delta' && e.data.index === 2).map((e) => e.data.delta.partial_json).join('');
  assert.deepEqual(JSON.parse(json), REAL_TOOL);
  // Order: every delta of a block comes before its stop.
  const stop1 = ev.findIndex((e) => e.data.type === 'content_block_stop' && e.data.index === 1);
  assert.ok(ev.every((e, i) => !(e.data.type === 'content_block_delta' && e.data.index === 1) || i < stop1));
  const thinking = ev.find((e) => e.data.delta?.type === 'thinking_delta');
  assert.equal(thinking.data.delta.thinking, 'about TICKET-1', 'thinking untouched');
  assert.equal(ev.find((e) => e.data.type === 'message_delta').data.extra, 'TICKET-1', 'unknown fields untouched');
  assert.equal(ev[ev.length - 1].data.type, 'message_stop');
}

function checkChat(out) {
  const ev = parseSse(out);
  const chunks = ev.filter((e) => e.data !== '[DONE]').map((e) => e.data);
  assert.equal(ev[ev.length - 1].data, '[DONE]');
  const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
  assert.equal(text, REAL_TEXT);
  const args = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []).map((t) => t.function?.arguments ?? '').join('');
  assert.deepEqual(JSON.parse(args), REAL_TOOL);
  for (const c of chunks) assert.equal(c.model, 'gpt-4o');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
}

function checkResponses(out) {
  const ev = parseSse(out);
  const text = ev.filter((e) => e.data.type === 'response.output_text.delta').map((e) => e.data.delta).join('');
  assert.equal(text, REAL_TEXT);
  assert.equal(ev.find((e) => e.data.type === 'response.output_text.done').data.text, REAL_TEXT);
  const args = ev.filter((e) => e.data.type === 'response.function_call_arguments.delta').map((e) => e.data.delta).join('');
  assert.deepEqual(JSON.parse(args), REAL_TOOL);
  assert.deepEqual(JSON.parse(ev.find((e) => e.data.type === 'response.function_call_arguments.done').data.arguments), REAL_TOOL);
  assert.equal(ev.find((e) => e.data.type === 'response.completed').data.response.output[0].content[0].text, REAL_TEXT);
  for (const e of ev) assert.equal(e.event, e.data.type);
}

for (const [name, fixture, check] of [
  ['Anthropic', anthropicFixture, checkAnthropic],
  ['OpenAI Chat (CRLF)', openaiChatFixture, checkChat],
  ['OpenAI Responses', responsesFixture, checkResponses]
]) {
  test(`${name} SSE: restored with a chunk boundary at every byte offset`, () => {
    const a = primed();
    const buf = Buffer.from(fixture(), 'utf8');
    assert.ok(buf.length > [...fixture()].length, 'fixture has multi-byte UTF-8');
    check(runChunks(a, buf, []));
    for (let k = 1; k < buf.length; k++) check(runChunks(a, buf, [k]));
  });

  test(`${name} SSE: restored when fed one byte at a time`, () => {
    const a = primed();
    const buf = Buffer.from(fixture(), 'utf8');
    check(runChunks(a, buf, Array.from({ length: buf.length - 1 }, (_, i) => i + 1)));
  });
}

test('SSE events without placeholders pass through byte for byte', () => {
  const a = primed();
  const s = sse('message_start', { type: 'message_start', message: { id: 'm', content: [] } })
    + 'event: ping\ndata: {"type": "ping"}\n\n'
    + sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'plain words ' } })
    + 'retry: 100\n\n';
  const r = a.createStreamRestorer();
  const out = r.push(Buffer.from(s)) + r.end();
  assert.equal(out, s);
});

test('a map with nothing in it leaves streams alone', () => {
  const a = make();
  const s = anthropicFixture();
  const r = a.createStreamRestorer();
  assert.equal(r.push(s) + r.end(), s);
});
