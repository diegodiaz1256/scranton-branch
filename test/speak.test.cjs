'use strict';
// Offline talk reads replies with the OS's own voices. The text never goes
// through a shell.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { speakCommands, speak } = loadTs('src/main/speak.ts');

test('each platform has a voice to try, and the text is never part of a shell line', () => {
  const win = speakCommands('win32', 'es');
  assert.equal(win[0].file, 'powershell.exe');
  assert.equal(win[0].stdin, true, 'Windows reads the text from stdin');
  assert.match(win[0].args.join(' '), /es-ES/, 'a Spanish voice when the app is in Spanish');
  assert.equal(speakCommands('darwin', 'en')[0].file, 'say');
  const linux = speakCommands('linux', 'en').map((c) => c.file);
  assert.deepEqual(linux, ['espeak-ng', 'espeak', 'spd-say']);
});

test('Windows speaks with its own engine (silently in the test)', { skip: process.platform !== 'win32', timeout: 30_000 }, async () => {
  const r = await speak('Tres tareas en curso.', 'es', 'win32', true);
  assert.deepEqual(r, { ok: true });
});
