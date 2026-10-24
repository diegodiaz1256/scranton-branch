'use strict';
/**
 * @sentry/mcp-server exits at start when SENTRY_HOST carries a scheme ("SENTRY_HOST
 * should only contain a hostname"), while Connections → Test strips it and says
 * "Connected". A pasted URL is reduced to its host before the server sees it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { mcpCatalogEntry, cleanSecretValue } = loadTs('src/shared/mcpCatalog.ts');
const hostField = mcpCatalogEntry('sentry').secrets.find((f) => f.env === 'SENTRY_HOST');

test('the Sentry host field is host-only', () => {
  assert.equal(hostField.hostOnly, true);
});

test('a pasted URL keeps only its host (and port)', () => {
  assert.equal(cleanSecretValue(hostField, 'https://sentry.example.com'), 'sentry.example.com');
  assert.equal(cleanSecretValue(hostField, 'https://sentry.example.com/'), 'sentry.example.com');
  assert.equal(cleanSecretValue(hostField, ' https://sentry.example.com:9443/organizations/acme/ '), 'sentry.example.com:9443');
  assert.equal(cleanSecretValue(hostField, 'sentry.example.com/'), 'sentry.example.com');
  assert.equal(cleanSecretValue(hostField, 'sentry.example.com'), 'sentry.example.com');
  assert.equal(cleanSecretValue(hostField, 'localhost:18443'), 'localhost:18443');
});

test('other fields are left as typed (trimmed)', () => {
  const token = mcpCatalogEntry('sentry').secrets.find((f) => f.env === 'SENTRY_ACCESS_TOKEN');
  assert.equal(cleanSecretValue(token, ' sntryu_abc/def '), 'sntryu_abc/def');
  assert.equal(cleanSecretValue(undefined, 'https://x.y/z'), 'https://x.y/z');
});
