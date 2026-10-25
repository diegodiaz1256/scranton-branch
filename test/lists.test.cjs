'use strict';
// Personal lists (src/shared/lists.ts): read, write, move items between states.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { parseList, formatList, moveItem, slugify } = loadTs('src/shared/lists.ts');

const md = '# Colección Warhammer\n\n## Tengo\n- [x] Combat Patrol Death Guard — pintado a medias\n- [ ] Space Marines starter\n\n## Quiero\n- [ ] Mortarion\n- Plague Marines — los nuevos\n';

test('a list reads back as it was written', () => {
  const l = parseList('coleccion-warhammer', md);
  assert.equal(l.title, 'Colección Warhammer');
  assert.deepEqual(l.sections.map((s) => s.name), ['Tengo', 'Quiero']);
  assert.deepEqual(l.sections[0].items[0], { text: 'Combat Patrol Death Guard', done: true, note: 'pintado a medias' });
  assert.equal(l.sections[1].items[1].text, 'Plague Marines');
  assert.deepEqual(parseList('x', formatList(l)), { ...l, slug: 'x' }, 'round trip');
});

test('bought: an item moves from Want to Have, keeping its note', () => {
  const l = moveItem(parseList('c', md), 'Plague Marines', 'Tengo');
  assert.equal(l.sections[0].items.at(-1).text, 'Plague Marines');
  assert.equal(l.sections[0].items.at(-1).note, 'los nuevos');
  assert.ok(!l.sections[1].items.some((i) => i.text === 'Plague Marines'));
});

test('slugs are file-safe', () => {
  assert.equal(slugify('Colección Warhammer 40k!'), 'coleccion-warhammer-40k');
});

test('agents are told the lists that exist, and not to keep them elsewhere', () => {
  const { listsInstruction } = loadTs('src/shared/lists.ts');
  const text = listsInstruction('/office/hive/lists', [parseList('coleccion-warhammer', md)]);
  assert.match(text, /coleccion-warhammer\.md \("Colección Warhammer": Tengo \/ Quiero\)/);
  assert.match(text, /never Claude Code's own memory/);
});

test('munder-lists: an agent moves a bought item and adds a wanted one through the tools', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  const { MD_LISTS_MCP } = loadTs('src/main/listsMcp.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md lists '));
  const script = path.join(dir, 'sb-lists.cjs');
  fs.writeFileSync(script, MD_LISTS_MCP);
  const lists = path.join(dir, 'lists');
  fs.mkdirSync(lists);
  fs.writeFileSync(path.join(lists, 'coleccion-warhammer.md'), md);
  const p = spawn(process.execPath, [script, lists]);
  const replies = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const rpc = (id, method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  rpc(1, 'initialize', {});
  rpc(2, 'tools/list', {});
  rpc(3, 'tools/call', { name: 'list_move', arguments: { list: 'coleccion warhammer', item: 'mortarion', to: 'tengo' } });
  rpc(4, 'tools/call', { name: 'list_add', arguments: { list: 'Colección Warhammer', section: 'Quiero', item: 'Kill Team Plague Marines' } });
  rpc(5, 'tools/call', { name: 'lists_overview', arguments: {} });
  for (let i = 0; i < 100 && replies.length < 5; i++) await new Promise((r) => setTimeout(r, 50));
  p.kill();
  assert.equal(replies.length, 5);
  assert.deepEqual(replies[1].result.tools.map((t) => t.name), ['lists_overview', 'list_add', 'list_move', 'list_check', 'list_create']);
  assert.match(replies[2].result.content[0].text, /Moved "Mortarion" from Quiero to Tengo/);
  const l = parseList('coleccion-warhammer', fs.readFileSync(path.join(lists, 'coleccion-warhammer.md'), 'utf8'));
  assert.ok(l.sections[0].items.some((i) => i.text === 'Mortarion'));
  assert.ok(l.sections[1].items.some((i) => i.text === 'Kill Team Plague Marines'));
  assert.match(replies[4].result.content[0].text, /Tengo: .*Mortarion/);
});
