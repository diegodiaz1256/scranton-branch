/**
 * munder-lists: the human's lists (hive/lists/*.md, shared/lists.ts) as MCP
 * tools for agents. Told only in their prompt, agents kept these things in
 * their own memory or in Claude Code's private memory; as tools whose
 * descriptions say when to use them, they reach for them. Plain Node, no
 * dependencies, run by the agent's own node (inside WSL on a WSL floor).
 * The file format matches shared/lists.ts (parseList / formatList).
 */
export const MD_LISTS_MCP = String.raw`#!/usr/bin/env node
'use strict';
// munder-lists — written by Scranton Branch; do not edit (it is rewritten).
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const DIR = process.argv[2] || process.env.SB_LISTS_DIR || process.env.MD_LISTS_DIR;

const slugify = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'list';
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function parse(slug, md) {
  let title = slug; const sections = []; let cur = null;
  for (const raw of md.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || /^_.*_$/.test(t)) continue;
    let m = /^#\s+(.*)$/.exec(t); if (m) { title = m[1].trim(); continue; }
    m = /^#{2,6}\s+(.*)$/.exec(t); if (m) { cur = { name: m[1].trim(), items: [] }; sections.push(cur); continue; }
    m = /^[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(t); if (!m) continue;
    if (!cur) { cur = { name: 'Items', items: [] }; sections.push(cur); }
    const parts = m[2].split(/\s+[—–]\s+/);
    const item = { text: parts[0].trim(), done: !!m[1] && m[1] !== ' ' };
    if (parts.length > 1) item.note = parts.slice(1).join(' — ').trim();
    cur.items.push(item);
  }
  return { slug, title, sections };
}
function format(l) {
  const out = ['# ' + l.title, '', '_A list the human keeps: one section per state, one item per line. Agents update it when told._', ''];
  for (const s of l.sections) {
    out.push('## ' + s.name, '');
    for (const i of s.items) out.push('- [' + (i.done ? 'x' : ' ') + '] ' + i.text + (i.note ? ' — ' + i.note : ''));
    out.push('');
  }
  return out.join('\n');
}
function all() {
  try { return fs.readdirSync(DIR).filter((f) => /\.md$/.test(f)).map((f) => parse(f.replace(/\.md$/, ''), fs.readFileSync(path.join(DIR, f), 'utf8'))); } catch { return []; }
}
function save(l) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(path.join(DIR, l.slug + '.md'), format(l), 'utf8'); }
function findList(name) {
  const lists = all(); const q = fold(name);
  return lists.find((l) => l.slug === slugify(name) || fold(l.title) === q) || lists.find((l) => fold(l.title).includes(q) || q.includes(fold(l.title)));
}
function findSection(l, name) {
  const q = fold(name);
  return l.sections.find((s) => fold(s.name) === q) || l.sections.find((s) => fold(s.name).includes(q) || q.includes(fold(s.name)));
}
function findItem(l, text, exact) {
  const q = fold(text);
  for (const s of l.sections) { const i = s.items.findIndex((x) => fold(x.text) === q); if (i >= 0) return { s, i }; }
  if (exact) return null;
  for (const s of l.sections) { const i = s.items.findIndex((x) => fold(x.text).includes(q) || q.includes(fold(x.text))); if (i >= 0) return { s, i }; }
  return null;
}

const WHEN = ' Use it for things the human tells you about their own life: what they own, want, plan, read, like (a collection, a wishlist, a shopping list…). This is the one place for them: not your memory.md and not your own memory.';
const TOOLS = [
  { name: 'lists_overview', description: 'The human\'s personal lists and what is in each section. Call this first when the human mentions something they have, want or plan.' + WHEN, inputSchema: { type: 'object', properties: {} } },
  { name: 'list_add', description: 'Add an item to a section of one of the human\'s lists (e.g. "Want" in their collection). Creates the section if it does not exist.' + WHEN, inputSchema: { type: 'object', required: ['list', 'section', 'item'], properties: { list: { type: 'string', description: 'List title or file name' }, section: { type: 'string' }, item: { type: 'string', description: 'In the human\'s own words' }, note: { type: 'string' } } } },
  { name: 'list_move', description: 'Move an item to another section, e.g. bought → from "Want" to "Have".' + WHEN, inputSchema: { type: 'object', required: ['list', 'item', 'to'], properties: { list: { type: 'string' }, item: { type: 'string' }, to: { type: 'string', description: 'Target section' }, note: { type: 'string' } } } },
  { name: 'list_check', description: 'Tick or untick an item (done / not done).', inputSchema: { type: 'object', required: ['list', 'item', 'done'], properties: { list: { type: 'string' }, item: { type: 'string' }, done: { type: 'boolean' } } } },
  { name: 'list_create', description: 'Create a new list when none of the existing ones fits (check lists_overview first).' + WHEN, inputSchema: { type: 'object', required: ['title', 'sections'], properties: { title: { type: 'string' }, sections: { type: 'array', items: { type: 'string' }, description: 'The states, e.g. ["Have", "Want"]' } } } }
];

function call(name, a) {
  if (name === 'lists_overview') {
    const lists = all();
    if (!lists.length) return 'No lists yet. Create one with list_create.';
    return lists.map((l) => l.title + ' (' + l.slug + '.md)\n' + l.sections.map((s) => '  ' + s.name + ': ' + (s.items.map((i) => (i.done ? '✓ ' : '') + i.text + (i.note ? ' (' + i.note + ')' : '')).join('; ') || '—')).join('\n')).join('\n\n');
  }
  if (name === 'list_create') {
    const slug = slugify(a.title);
    if (all().some((l) => l.slug === slug)) return 'A list called "' + a.title + '" already exists; add to it instead.';
    save({ slug, title: String(a.title).trim(), sections: (a.sections || []).map((s) => ({ name: String(s).trim(), items: [] })) });
    return 'Created "' + a.title + '" with sections: ' + (a.sections || []).join(', ') + '.';
  }
  const l = findList(a.list || '');
  if (!l) return 'No list matches "' + a.list + '". Lists: ' + (all().map((x) => x.title).join(', ') || 'none') + '.';
  if (name === 'list_add') {
    const existing = findItem(l, a.item, true);
    if (existing) return '"' + existing.s.items[existing.i].text + '" is already in ' + l.title + ' → ' + existing.s.name + '.';
    let s = findSection(l, a.section);
    if (!s) { s = { name: String(a.section).trim(), items: [] }; l.sections.push(s); }
    const item = { text: String(a.item).trim(), done: false }; if (a.note) item.note = String(a.note).trim();
    s.items.push(item); save(l);
    return 'Added "' + item.text + '" to ' + l.title + ' → ' + s.name + '.';
  }
  const hit = findItem(l, a.item);
  if (!hit) return '"' + a.item + '" is not in ' + l.title + '. Sections: ' + l.sections.map((s) => s.name + ' (' + s.items.map((i) => i.text).join(', ') + ')').join('; ');
  if (name === 'list_move') {
    let to = findSection(l, a.to);
    if (!to) { to = { name: String(a.to).trim(), items: [] }; l.sections.push(to); }
    const [item] = hit.s.items.splice(hit.i, 1);
    if (a.note) item.note = String(a.note).trim();
    to.items.push(item); save(l);
    return 'Moved "' + item.text + '" from ' + hit.s.name + ' to ' + to.name + ' in ' + l.title + '.';
  }
  if (name === 'list_check') {
    hit.s.items[hit.i].done = !!a.done; save(l);
    return (a.done ? 'Ticked' : 'Unticked') + ' "' + hit.s.items[hit.i].text + '" in ' + l.title + '.';
  }
  throw new Error('unknown tool ' + name);
}

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'munder-lists', version: '1.0.0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
  if (m.method === 'tools/call') {
    try { return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: call(m.params.name, m.params.arguments || {}) }] } }); }
    catch (e) { return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e && e.message || e) }] } }); }
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;
