'use strict';
// wsl.exe, and ConPTY on Windows, paint escape sequences before the agent
// starts, so "ready to type into" waits for visible text (src/main/pty.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { hasVisibleText, readyToType } = loadTs('src/main/pty.ts');

const E = '\x1b';

test('escape sequences, titles and whitespace alone are not a frame', () => {
  assert.equal(hasVisibleText(`${E}[?25l${E}[2J${E}[H${E}]0;wsl.exe\x07`), false);
  assert.equal(hasVisibleText(`${E}[?1049h\r\n  \t`), false);
});

test('any visible character is', () => {
  assert.equal(hasVisibleText(`${E}[1mWelcome to Claude Code${E}[0m`), true);
  assert.equal(hasVisibleText('❯'), true);
});

test('a Windows pty is not ready on ConPTY\'s own opening bytes, only once the agent painted and settled', () => {
  // What ConPTY writes the instant the pty opens, before Claude Code runs.
  const conptyOpen = `${E}[?9001h${E}[?1004h`;
  assert.equal(hasVisibleText(conptyOpen), false);
  let visibleAt = 0;
  const feed = (data, at) => { if (!visibleAt && hasVisibleText(data)) visibleAt = at; };
  feed(conptyOpen, 50);
  assert.equal(readyToType(visibleAt, 500), false);
  assert.equal(readyToType(visibleAt, 5000), false);
  feed(`${E}[1m Claude Code v2.1.302${E}[0m`, 600);
  assert.equal(readyToType(visibleAt, 1200), false);
  assert.equal(readyToType(visibleAt, 2100), true);
});
