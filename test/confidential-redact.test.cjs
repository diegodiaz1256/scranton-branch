'use strict';
/**
 * The app-side safety net under a custodian's prompt: what it sends out of its
 * own folder is redacted first. Keys, statuses and counts survive; people,
 * contacts, credentials, links into the service and long quotes do not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { redactConfidential, redactionTotal } = loadTs('src/shared/confidentialRedact.ts');

const HOSTS = ['acme.atlassian.net'];

test('keeps what a summary needs: ticket keys, statuses, counts, dates', () => {
  const text = 'INFOSEC-123 and INFOSEC-7 are Open; 12 issues in To Do, 3 Done since 2026-10-20 (sprint 42).';
  const r = redactConfidential(text, { hosts: HOSTS });
  assert.equal(r.text, text);
  assert.equal(redactionTotal(r), 0);
});

test('emails and phone numbers', () => {
  const r = redactConfidential('Reporter jane.doe@acme.com, call +34 612 345 678 or (555) 123-4567.', { hosts: HOSTS });
  assert.equal(r.text, 'Reporter [REDACTED:email], call [REDACTED:phone] or [REDACTED:phone].');
  assert.deepEqual(r.counts, { email: 1, phone: 2 });
});

test('credentials and tokens (the app-wide scrubber)', () => {
  const r = redactConfidential('token ghp_abcdefghijklmnop1234 and Authorization: Basic YWxpY2U6c2VjcmV0MTIz and API_KEY=zzz123', { hosts: HOSTS });
  assert.doesNotMatch(r.text, /ghp_abcdef|YWxpY2U6|zzz123/);
  assert.match(r.text, /\[REDACTED:secret\]/);
  assert.ok(r.counts.secret >= 3);
});

test('links into the critical service (pages, attachments) go; other links stay', () => {
  const r = redactConfidential('See https://acme.atlassian.net/browse/INFOSEC-123 and https://acme.atlassian.net/secure/attachment/1/dump.csv; docs at https://developer.atlassian.com/cloud.', { hosts: HOSTS });
  assert.equal(r.text, 'See [REDACTED:url] and [REDACTED:url]; docs at https://developer.atlassian.com/cloud.');
  const a = redactConfidential('file at https://files.example.com/download/x.pdf');
  assert.equal(a.text, 'file at [REDACTED:url]', 'an attachment/download link anywhere');
});

test('people the service named', () => {
  const r = redactConfidential('Assigned to Jane Doe; jane doe reviewed. Janet stays.', { names: ['Jane Doe'] });
  assert.equal(r.text, 'Assigned to [REDACTED:name]; [REDACTED:name] reviewed. Janet stays.');
});

test('long verbatim quotes go as a whole; short ones stay', () => {
  const body = 'The production database password rotation failed because the vault agent on db-02 could not reach the KMS endpoint, and the fallback credentials in the runbook were used for six hours.';
  const r = redactConfidential(`INFOSEC-9 says:\n> ${body}\nStatus: Open.`);
  assert.equal(r.text, 'INFOSEC-9 says:\n[REDACTED:quote]Status: Open.');
  const fenced = redactConfidential('Body:\n```\n' + body + '\n```\nend');
  assert.equal(fenced.text, 'Body:\n[REDACTED:quote]\nend');
  const quoted = redactConfidential(`Summary "${body}"`);
  assert.equal(quoted.text, 'Summary [REDACTED:quote]');
  assert.equal(redactConfidential('Title "Rotate keys"').text, 'Title "Rotate keys"');
});

test('never throws, never drops the message', () => {
  assert.deepEqual(redactConfidential(undefined), { text: '', counts: {} });
  const r = redactConfidential('[REDACTED:email] already done');
  assert.equal(r.text, '[REDACTED:email] already done');
});
