'use strict';
// Local Whisper gets the app language as a hint. Without it, Whisper small
// returned only "Michael," for a Spanish dictation (live, fake microphone);
// with "es" it returned the whole sentence.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { whisperLanguage } = loadTs('src/renderer/src/freeflow/whisperLanguage.ts');

test('UI language → Whisper language code', () => {
  assert.equal(whisperLanguage('es'), 'es');
  assert.equal(whisperLanguage('en'), 'en');
  assert.equal(whisperLanguage('zh-CN'), 'zh');
  assert.equal(whisperLanguage('ar'), 'ar');
  assert.equal(whisperLanguage(undefined), undefined);
  assert.equal(whisperLanguage('cimode'), undefined);
});

test('the recorder passes it to local Whisper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/freeflow/recorder.ts'), 'utf8');
  assert.match(src, /transcribeLocal\(blob, cfg\??\.freeflowLocalModel \?\? 'small', whisperLanguage\(i18n\.language\)\)/);
});
