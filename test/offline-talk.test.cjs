'use strict';
// Offline talk: the orchestrator's reply travels on its Stop event (Claude's
// last_assistant_message) and is read aloud without markdown.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

test('a Stop event carries the reply, redacted and short; other events do not', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-talk-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', isGod: true, cwd: home });
  const sent = [];
  const server = new HookServer(hive, () => ({ send: (ch, payload) => { if (ch === 'hive:hookEvent') sent.push(payload); }, isDestroyed: () => false }), () => ({}), undefined, undefined);
  await server.handle({ agent_id: 'god', hook_event_name: 'Stop', last_assistant_message: 'The report is in research/report.md. Key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd' });
  await server.handle({ agent_id: 'god', hook_event_name: 'PreToolUse', tool_name: 'Read', last_assistant_message: 'not this' });
  const stop = sent.find((e) => e.event === 'Stop');
  assert.ok(stop && stop.reply, 'the Stop event has the reply');
  assert.match(stop.reply, /research\/report\.md/);
  assert.doesNotMatch(stop.reply, /sk-ant-api03-ABCDEFGH/, 'secrets are redacted');
  assert.equal(sent.find((e) => e.event === 'PreToolUse')?.reply, undefined);
});

test('what is read aloud has no markdown, code or link targets', () => {
  // localTalk imports the app's i18n and recorder; only its pure helper is under test.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'realtime', 'localTalk.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function speakable'), src.indexOf('\nfunction speak('));
  const speakable = new Function(`${body.replace('export function speakable(text: string): string', 'return function speakable(text)')}`)();
  assert.equal(
    speakable('**Done.** See [the report](research/report.md) and run `npm test`.\n\n```js\nconsole.log(1)\n```\n# Next'),
    'Done. See the report and run npm test. Next'
  );
});

test('local Whisper falls back to WASM when WebGPU fails mid-transcription', () => {
  // Seen live: the model loaded on WebGPU, then ONNX Runtime's WebGPU backend
  // threw "Cannot read properties of undefined (reading 'destroy')" while
  // transcribing, and offline talk gave up. The load-time fallback never ran.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'freeflow', 'whisper.worker.ts'), 'utf8');
  assert.match(src, /const device = 'gpu' in navigator && !gpuFailed \? 'webgpu' : 'wasm';/);
  const transcribe = src.slice(src.indexOf("m.type === 'transcribe'"));
  assert.match(transcribe, /catch \(e\) \{[\s\S]*gpuFailed = true;[\s\S]*load\(m\.model, false\)[\s\S]*\(m\.audio, opts\)/);
});
