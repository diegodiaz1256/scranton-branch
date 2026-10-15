'use strict';
// The Inbox reads as one chat per agent (src/shared/inboxThreads.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { buildThread, summarizeThreads, parseAnswerMail } = loadTs('src/shared/inboxThreads.ts');

const msg = (id, from, to, created_at, extra = {}) => ({
  id, from, to, act: 'inform', subject: id, body: '', requires_reply: false, created_at, ...extra
});

test('a thread is the agent\'s messages either way plus its card questions, oldest first', () => {
  const messages = [
    msg('m2', 'jim', 'god', '2026-10-07T10:02:00Z', { in_reply_to: 'm1' }),
    msg('m1', 'god', 'jim', '2026-10-07T10:01:00Z'),
    msg('m3', 'pam', 'god', '2026-10-07T10:03:00Z'),
    msg('hb', 'heartbeat', 'jim', '2026-10-07T10:04:00Z'),
    msg('all', 'god', 'broadcast', '2026-10-07T10:05:00Z')
  ];
  const tasks = [{
    id: 't1', key: 'T-1', title: 'Fix login', assignee: 'jim',
    humanQA: [{ q: 'Which provider?', a: 'Google', askedAt: '2026-10-07T10:01:30Z', answeredAt: '2026-10-07T10:06:00Z' }]
  }];
  const thread = buildThread('jim', false, messages, tasks, 'god');
  assert.deepEqual(thread.map((i) => i.kind === 'message' ? i.message.id : i.kind),
    ['m1', 'question', 'm2', 'all', 'answer']);
  assert.equal(thread[2].replyTo.id, 'm1', 'a reply knows what it answers');
});

test('the orchestrator is also addressed as "god" and owns unassigned questions', () => {
  const messages = [msg('m1', 'jim', 'god', '2026-10-07T10:00:00Z'), msg('m2', 'michael', 'human', '2026-10-07T10:01:00Z')];
  const tasks = [{ id: 't', title: 'Budget', humanQA: [{ q: 'OK to spend $5?', askedAt: '2026-10-07T09:00:00Z' }] }];
  const thread = buildThread('michael', true, messages, tasks, 'michael');
  assert.deepEqual(thread.map((i) => i.kind === 'message' ? i.message.id : i.kind), ['question', 'm1', 'm2']);
});

test('the list puts agents waiting on you first, then the most recent', () => {
  const agents = [{ id: 'god', isGod: true }, { id: 'jim' }, { id: 'pam' }, { id: 'kevin' }];
  const messages = [msg('a', 'god', 'jim', '2026-10-07T10:00:00Z'), msg('b', 'god', 'pam', '2026-10-07T11:00:00Z')];
  const tasks = [{ id: 't', title: 'x', assignee: 'jim', humanQA: [{ q: '?', askedAt: '2026-10-07T09:00:00Z' }] }];
  const rows = summarizeThreads(agents, messages, tasks, 'god');
  assert.deepEqual(rows.map((r) => r.agentId), ['jim', 'god', 'pam', 'kevin']);
  assert.equal(rows[0].waiting, 1);
  assert.equal(rows[3].count, 0);
});

test('the answer mail to the orchestrator reads as the answer, with its question', () => {
  const body = [
    'The human answered the open question on task task-7 ("Check the release branches"):',
    'Q: **Two things from you:**',
    '1. When the fixes are ready, may they be pushed?',
    '   Answer: yes to both / only #1',
    'A: Push the first fix',
    'do this one',
    "The answer is also recorded in the card's humanQA. Act on it, unblock the card, and continue the work."
  ].join('\n');
  const mail = msg('a1', 'human', 'god', '2026-10-07T19:14:00Z', { subject: 'HUMAN ANSWER on task "Check the release branches"', body });
  const parsed = parseAnswerMail(mail);
  assert.equal(parsed.taskId, 'task-7');
  assert.match(parsed.q, /^\*\*Two things from you/);
  assert.match(parsed.q, /Answer: yes to both/, 'an "Answer:" inside the question is not the answer');
  assert.equal(parsed.a, 'Push the first fix\ndo this one');

  // God's thread: no card copy of this answer, so the mail becomes the answer item.
  const thread = buildThread('god', true, [mail], [], 'god');
  assert.equal(thread.length, 1);
  assert.equal(thread[0].kind, 'answer');
  assert.equal(thread[0].q, parsed.q);

  // When the card already records it, the mail is not shown twice.
  const tasks = [{ id: 'task-7', title: 'Check the release branches', assignee: 'jim',
    humanQA: [{ q: parsed.q, a: parsed.a, askedAt: '2026-10-07T19:00:00Z', answeredAt: '2026-10-07T19:14:00Z' }] }];
  const godThread = buildThread('god', true, [mail], tasks, 'god');
  assert.deepEqual(godThread.map((i) => i.kind), ['question', 'answer']);
  assert.equal(parseAnswerMail(msg('x', 'jim', 'god', '2026-10-07T19:00:00Z')), null);
});
