'use strict';
// Deliverables: order by date, name or type, and a ticket key in the search box
// finds exactly that ticket.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { compareDeliverables, ticketQuery } = loadTs('src/shared/deliverableSort.ts');

const items = [{ name: 'b.csv', ts: 10 }, { name: 'a.md', ts: 30 }, { name: 'c10.wiki', ts: 40 }, { name: 'c9.wiki', ts: 20 }];
const order = (sort) => [...items].sort(compareDeliverables(sort)).map((i) => i.name).join(',');

test('newest, oldest, name (numeric), type', () => {
  assert.equal(order('recent'), 'c10.wiki,a.md,c9.wiki,b.csv');
  assert.equal(order('oldest'), 'b.csv,c9.wiki,a.md,c10.wiki');
  assert.equal(order('name'), 'a.md,b.csv,c9.wiki,c10.wiki');
  assert.equal(order('type'), 'b.csv,a.md,c9.wiki,c10.wiki');
});

test('a ticket key in the search is an exact match', () => {
  assert.equal(ticketQuery(' DUN-12 '), 'dun-12');
  assert.equal(ticketQuery('report'), null);
  assert.equal(ticketQuery('dun 12'), null);
});
