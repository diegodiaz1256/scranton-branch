'use strict';
// Kanban: a subtask in the same column as its parent hangs under it instead of
// standing as a loose card; parked work has its own column.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { columnRoots, subtasksIn } = loadTs('src/shared/taskBoard.ts');

test('subtasks in the parent column hang under it; others stand alone', () => {
  const doing = [{ id: 'p' }, { id: 'a', parent: 'p' }, { id: 'b', parent: 'p' }, { id: 'c', parent: 'elsewhere' }, { id: 'self', parent: 'self' }];
  assert.deepEqual(columnRoots(doing).map((c) => c.id), ['p', 'c', 'self']);
  assert.deepEqual(subtasksIn(doing, 'p').map((c) => c.id), ['a', 'b']);
  assert.deepEqual(subtasksIn(doing, 'self'), []);
});

test('backlog is a status the board, the parser and the agents know', () => {
  const kanban = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/TasksKanban.tsx'), 'utf8');
  assert.match(kanban, /status: isTaskStatus\(t\.status\)/, 'the parser checks the shared status list');
  const { TASK_STATUSES } = require('./load-ts.cjs')('src/shared/taskEdit.ts');
  assert.ok(TASK_STATUSES.includes('backlog'), 'the parser keeps it');
  const view = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/pro/TasksView.tsx'), 'utf8');
  assert.match(view, /status: 'backlog'/);
  const docs = fs.readFileSync(path.join(__dirname, '..', 'src/main/protocolDocs.ts'), 'utf8');
  assert.match(docs, /backlog \/ todo \/ doing \/ blocked \/ done \/ cancelled/);
});

test('every subtask under a card, at any depth, once even with a cycle', () => {
  const { descendantsOf } = require('./load-ts.cjs')('src/shared/taskBoard.ts');
  const cards = [{ id: 'a' }, { id: 'b', parent: 'a' }, { id: 'c', parent: 'b' }, { id: 'd', parent: 'a' }, { id: 'e' }, { id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }];
  assert.deepEqual(descendantsOf(cards, 'a').map((c) => c.id), ['b', 'c', 'd']);
  assert.deepEqual(descendantsOf(cards, 'e'), []);
  assert.deepEqual(descendantsOf(cards, 'x').map((c) => c.id), ['y'], 'a loop in the ledger does not hang');
});
