'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  workKindOf, summarizeWork, workBursts, joinPhrases, buildEasyThread,
  pendingQuestions, whereWeAre, plainText, humanFacing
} = loadTs('src/shared/easyThread.ts');

const msg = (id, from, to, at, extra = {}) => ({
  id, from, to, act: 'inform', subject: extra.subject ?? `s-${id}`, body: extra.body ?? `b-${id}`,
  requires_reply: false, created_at: new Date(Date.UTC(2026, 9, 28, 10, 0, at)).toISOString(), ...extra
});
const T0 = Date.UTC(2026, 9, 28, 10, 0, 0);
const ev = (agentId, event, tool, sec, extra = {}) => ({ agentId, event, tool, ts: T0 + sec * 1000, ...extra });

test('tools of any CLI map to the same kinds', () => {
  assert.equal(workKindOf('Read').kind, 'read');
  assert.equal(workKindOf('read_file').kind, 'read'); // Gemini
  assert.equal(workKindOf('view_file').kind, 'read'); // Antigravity
  assert.equal(workKindOf('exec_command').kind, 'ran'); // Codex
  assert.equal(workKindOf('run_shell_command').kind, 'ran');
  assert.equal(workKindOf('apply_patch').kind, 'edited');
  assert.equal(workKindOf('write_file').kind, 'wrote');
  assert.equal(workKindOf('grep_search').kind, 'searched');
  assert.equal(workKindOf('web_search').kind, 'webSearched');
  assert.equal(workKindOf('Task').kind, 'delegated');
  assert.equal(workKindOf('something_new').kind, 'other');
  const mcp = workKindOf('mcp__munder-github-token__create_issue');
  assert.equal(mcp.kind, 'connection');
  assert.equal(mcp.service, 'GitHub');
});

test('a burst is counted into parts, in telling order', () => {
  const parts = summarizeWork(['Write', 'Read', 'Read', 'read_file']);
  assert.deepEqual(parts, [{ kind: 'read', count: 3 }, { kind: 'wrote', count: 1 }]);
});

test('planning is only told when it is all there was', () => {
  assert.deepEqual(summarizeWork(['TodoWrite', 'Bash']), [{ kind: 'ran', count: 1 }]);
  assert.deepEqual(summarizeWork(['TodoWrite']), [{ kind: 'planned', count: 1 }]);
});

test('past three kinds the rest fold into "other things"', () => {
  const parts = summarizeWork(['Read', 'Grep', 'Edit', 'Bash', 'Bash', 'WebFetch', 'mystery']);
  assert.equal(parts.length, 3);
  assert.deepEqual(parts.slice(0, 2), [{ kind: 'read', count: 1 }, { kind: 'searched', count: 1 }]);
  assert.deepEqual(parts[2], { kind: 'other', count: 5 });
});

test('each connection service is its own part', () => {
  const parts = summarizeWork(['mcp__munder-github-token__a', 'mcp__munder-github-token__b', 'mcp__slack__post']);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].count, 2);
  assert.equal(parts[0].service, 'GitHub');
});

test('bursts split on a turn end, a new prompt and a long gap; Pre and Post count once', () => {
  const events = [
    ev('pam', 'PreToolUse', 'Read', 0), ev('pam', 'PostToolUse', 'Read', 1),
    ev('pam', 'PreToolUse', 'Read', 2), ev('pam', 'PostToolUse', 'Read', 3),
    ev('pam', 'PreToolUse', 'Write', 4), ev('pam', 'PostToolUse', 'Write', 5),
    ev('pam', 'Stop', undefined, 6),
    ev('pam', 'UserPromptSubmit', undefined, 10),
    ev('pam', 'PreToolUse', 'Bash', 11),
    // Post only (a CLI that reports after the fact) still counts.
    ev('pam', 'PostToolUse', 'exec_command', 12),
    ev('pam', 'PreToolUse', 'Bash', 12 + 600), // 10 min later
    ev('jim', 'PreToolUse', 'Bash', 1)
  ];
  const bursts = workBursts(events);
  const pam = bursts.filter((b) => b.agentId === 'pam');
  assert.equal(pam.length, 3);
  assert.deepEqual(pam[0].parts, [{ kind: 'read', count: 2 }, { kind: 'wrote', count: 1 }]);
  assert.equal(pam[0].calls, 3);
  assert.deepEqual(pam[1].parts, [{ kind: 'ran', count: 2 }]);
  assert.deepEqual(pam[2].parts, [{ kind: 'ran', count: 1 }]);
  assert.equal(bursts.filter((b) => b.agentId === 'jim').length, 1);
  // Oldest first across agents.
  assert.deepEqual(bursts.map((b) => b.start), bursts.map((b) => b.start).slice().sort((a, b) => a - b));
});

test('a long-running call does not split its own burst', () => {
  const bursts = workBursts([ev('pam', 'PreToolUse', 'Bash', 0), ev('pam', 'PostToolUse', 'Bash', 900), ev('pam', 'PreToolUse', 'Read', 901)]);
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].calls, 2);
});

test('phrases join with the given word for "and"', () => {
  assert.equal(joinPhrases([], 'and'), '');
  assert.equal(joinPhrases(['a'], 'and'), 'a');
  assert.equal(joinPhrases(['a', 'b'], 'y'), 'a y b');
  assert.equal(joinPhrases(['a', 'b', 'c'], 'and'), 'a, b and c');
});

test('the thread: human-facing messages stay, agent chatter folds per exchange', () => {
  const messages = [
    msg('m1', 'human', 'god', 0, { body: 'Write a report on Q3' }),
    msg('m2', 'god', 'pam', 5, { act: 'request' }),
    msg('m3', 'pam', 'god', 20, { act: 'done' }),
    msg('m4', 'god', 'human', 30, { body: 'Pam wrote it.' }),
    msg('m5', 'god', 'jim', 40),
    msg('m6', 'heartbeat', 'god', 41),
    msg('m4', 'god', 'human', 30) // the inbox and outbox copy of one message
  ];
  const thread = buildEasyThread({ messages, tasks: [], godId: 'michael' });
  assert.deepEqual(thread.map((e) => e.kind), ['said', 'exchange', 'said', 'exchange']);
  assert.equal(thread[0].text, 'Write a report on Q3');
  assert.deepEqual(thread[1].messages.map((m) => m.id), ['m2', 'm3']);
  assert.deepEqual(thread[1].people.sort(), ['god', 'pam']);
  assert.deepEqual(thread[3].messages.map((m) => m.id), ['m5']);
  assert.equal(humanFacing({ from: 'pam', to: 'human' }), true);
  assert.equal(humanFacing({ from: 'pam', to: 'god' }), false);
});

test('the thread: work lines go in by time and one agent\'s lines in a row merge', () => {
  const messages = [msg('m1', 'human', 'god', 0), msg('m2', 'god', 'human', 100)];
  const events = [
    ev('pam', 'PreToolUse', 'Read', 10), ev('pam', 'Stop', undefined, 11),
    ev('pam', 'PreToolUse', 'Read', 20), ev('pam', 'PreToolUse', 'Write', 21),
    ev('jim', 'PreToolUse', 'Bash', 200)
  ];
  const thread = buildEasyThread({ messages, tasks: [], events, godId: 'michael' });
  assert.deepEqual(thread.map((e) => e.kind), ['said', 'work', 'said', 'work']);
  assert.equal(thread[1].burst.agentId, 'pam');
  assert.deepEqual(thread[1].burst.parts, [{ kind: 'read', count: 2 }, { kind: 'wrote', count: 1 }]);
  assert.equal(thread[3].burst.agentId, 'jim');
});

test('the thread: the orchestrator\'s words at the end of a turn read as said to you', () => {
  const events = [
    ev('michael', 'Stop', undefined, 50, { reply: 'I asked Pam to draft it.' }),
    ev('pam', 'Stop', undefined, 60, { reply: 'internal musing' }),
    ev('michael', 'Stop', undefined, 70, { reply: '   ' })
  ];
  const thread = buildEasyThread({ messages: [], tasks: [], events, godId: 'michael' });
  assert.equal(thread.length, 1);
  assert.equal(thread[0].kind, 'said');
  assert.equal(thread[0].from, 'michael');
  assert.equal(thread[0].text, 'I asked Pam to draft it.');
});

test('the thread: answered questions show once, from the card or the answer mail', () => {
  const tasks = [{ id: 't1', key: 'DUN-1', title: 'Report', status: 'doing', humanQA: [
    { q: 'Which quarter?', a: 'Q3', askedAt: msg('x', 'a', 'b', 1).created_at, answeredAt: msg('x', 'a', 'b', 2).created_at },
    { q: 'Open one', askedAt: msg('x', 'a', 'b', 3).created_at }
  ] }];
  const mail = msg('m9', 'human', 'god', 2, {
    subject: 'HUMAN ANSWER on task "Report"',
    body: 'The human answered the open question on task t1 ("Report"):\nQ: Which quarter?\nA: Q3\nThe answer is also recorded in the card\'s humanQA.'
  });
  const orphan = msg('m10', 'human', 'god', 5, {
    subject: 'HUMAN ANSWER on task "Gone"',
    body: 'The human answered the open question on task t9 ("Gone"):\nQ: Color?\nA: Red\nThe answer is also recorded in the card\'s humanQA.'
  });
  const thread = buildEasyThread({ messages: [mail, orphan], tasks, godId: 'michael' });
  assert.deepEqual(thread.map((e) => e.kind), ['answered', 'answered']);
  assert.equal(thread[0].taskLabel, 'DUN-1 · Report');
  assert.equal(thread[0].a, 'Q3');
  assert.equal(thread[1].taskLabel, 'Gone');
  assert.equal(thread[1].a, 'Red');
});

test('pending questions: blocked cards with an open question, newest first', () => {
  const at = (s) => msg('x', 'a', 'b', s).created_at;
  const tasks = [
    { id: 'a', title: 'A', status: 'blocked', assignee: 'pam', humanQA: [{ q: 'old', a: 'yes', askedAt: at(0) }, { q: 'A?', askedAt: at(1) }] },
    { id: 'b', title: 'B', status: 'blocked', humanQA: [{ q: 'B?', askedAt: at(5) }] },
    { id: 'c', title: 'C', status: 'doing', humanQA: [{ q: 'not blocked', askedAt: at(9) }] },
    { id: 'd', title: 'D', status: 'blocked', humanQA: [{ q: 'skipped', askedAt: at(9), dismissedAt: at(10) }] }
  ];
  const p = pendingQuestions(tasks);
  assert.deepEqual(p.map((x) => x.q), ['B?', 'A?']);
  assert.equal(p[1].assignee, 'pam');
});

test('where we are: the latest request, who is on what, what is left and waiting', () => {
  const messages = [
    msg('m1', 'human', 'god', 0, { body: 'First ask' }),
    msg('m2', 'human', 'god', 10, { subject: 'Task from human', body: '\n  Make the Q3 deck\n\nmore detail' }),
    msg('m3', 'human', 'god', 20, { subject: 'HUMAN ANSWER on task "X"', body: 'The human answered the open question on task t1 ("X"):\nQ: a\nA: b' }),
    msg('m4', 'god', 'human', 30, { body: 'ok' })
  ];
  const tasks = [
    { id: 't1', title: 'Draft deck', status: 'doing', assignee: 'pam' },
    { id: 't2', title: 'Second card', status: 'doing', assignee: 'pam' },
    { id: 't3', title: 'Charts', status: 'todo' },
    { id: 't4', title: 'Blocked on you', status: 'blocked', humanQA: [{ q: 'Colors?' }] },
    { id: 't5', title: 'Blocked on a dep', status: 'blocked' },
    { id: 't6', title: 'Done', status: 'done' },
    { id: 't7', title: 'Cancelled', status: 'cancelled' }
  ];
  const delegations = [
    { agentId: 'jim', subject: 'Get the numbers', sentAt: 1, phase: 'working' },
    { agentId: 'pam', subject: 'dup', sentAt: 1, phase: 'working' },
    { agentId: 'dwight', subject: 'old', sentAt: 1, repliedAt: 2, phase: 'returned' }
  ];
  const w = whereWeAre({ messages, tasks, delegations });
  assert.equal(w.asked, 'Make the Q3 deck');
  assert.deepEqual(w.working, [{ agentId: 'pam', what: 'Draft deck' }, { agentId: 'jim', what: 'Get the numbers' }]);
  assert.equal(w.waitingOnYou, 1);
  assert.equal(w.left, 2);
  assert.equal(w.done, 1);
});

test('where we are: nothing asked yet', () => {
  const w = whereWeAre({ messages: [], tasks: [] });
  assert.equal(w.asked, undefined);
  assert.deepEqual(w.working, []);
  assert.equal(w.waitingOnYou + w.left + w.done, 0);
});

test('plain text drops markdown syntax and keeps the words', () => {
  const md = '# Report\n\nThis is **bold**, *soft* and `code`.\n\n- one\n- two\n\nSee [the file](./a.md).\n\n```js\nconst x = 1;\n```\n\n---\n> quoted';
  assert.equal(plainText(md), 'Report\n\nThis is bold, soft and code.\n\n• one\n• two\n\nSee the file.\n\nconst x = 1;\n\nquoted');
  assert.equal(plainText('2 * 3 * 4'), '2 * 3 * 4');
});
