'use strict';
// The server's secret store pins the AES-GCM tag to 16 bytes. Without it Node
// accepted a buffer cut short, with a tag of only a few bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const { seal, open } = loadTs('src/server/secretBox.ts');

const key = crypto.randomBytes(32);

test('a sealed secret opens with its key', () => {
  assert.equal(open(key, seal(key, 'token-for-acme')), 'token-for-acme');
  assert.equal(open(key, seal(key, '')), '');
});

test('a short tag or a cut buffer is refused', () => {
  const sealed = seal(key, '');
  // An empty secret is header only: drop the last 12 tag bytes, leaving a
  // 4-byte tag that Node would otherwise check against.
  assert.throws(() => open(key, sealed.subarray(0, 20)), /not a server-encrypted secret/);
  assert.throws(() => open(key, Buffer.from('mds1')), /not a server-encrypted secret/);
});

test('a wrong key or a changed byte fails', () => {
  const sealed = seal(key, 'token-for-acme');
  assert.throws(() => open(crypto.randomBytes(32), sealed));
  const bad = Buffer.from(sealed);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => open(key, bad));
});
