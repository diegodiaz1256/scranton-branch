#!/usr/bin/env node
'use strict';
/**
 * A small git-lfs-transfer server (git-lfs's pure-SSH protocol,
 * docs/proposals/ssh_adapter.md): what a Git host runs for
 * `ssh host git-lfs-transfer <path> <upload|download>`. Objects are files in
 * <store>/<oid>. Enough of the protocol for a real git-lfs client to push and
 * fetch objects; no locking.
 *   node lfs-transfer-server.cjs <store> <upload|download>
 */
const fs = require('node:fs');
const path = require('node:path');

const [store, operation] = process.argv.slice(2);
if (!store || !['upload', 'download'].includes(operation)) {
  process.stderr.write('usage: lfs-transfer-server <store> <upload|download>\n');
  process.exit(2);
}
fs.mkdirSync(store, { recursive: true });

const out = (s) => process.stdout.write(s);
const pkt = (data) => {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  out(Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]));
};
const FLUSH = '0000', DELIM = '0001';
const objPath = (oid) => {
  if (!/^[0-9a-f]{64}$/.test(oid)) throw new Error('bad oid');
  return path.join(store, oid);
};

// Requests: packets up to a flush, split at the first delim into
// [command, ...arguments] and data.
let buf = Buffer.alloc(0);
let head = [], data = [], seenDelim = false;
const reply = (status, args = [], lines = null) => {
  pkt(`status ${status}\n`);
  for (const a of args) pkt(`${a}\n`);
  if (lines) { out(DELIM); for (const l of lines) pkt(Buffer.isBuffer(l) ? l : `${l}\n`); }
  out(FLUSH);
};
const handle = (cmdLine, args, body) => {
  const [cmd, arg] = cmdLine.replace(/\n$/, '').split(' ');
  const kv = Object.fromEntries(args.map((a) => a.replace(/\n$/, '').split('=')));
  if (cmd === 'version') return reply(arg === '1' ? 200 : 400, [], []);
  if (cmd === 'quit') { reply(200); process.stdout.end(() => process.exit(0)); return; }
  if (cmd === 'batch') {
    const lines = body.map((l) => l.toString().replace(/\n$/, '')).map((l) => {
      const [oid, size] = l.split(' ');
      const have = fs.existsSync(objPath(oid));
      const action = operation === 'upload' ? (have ? 'noop' : 'upload') : (have ? 'download' : 'noop');
      return `${oid} ${size} ${action}`;
    });
    return reply(200, [], lines);
  }
  if (cmd === 'put-object' && operation === 'upload') {
    fs.writeFileSync(objPath(arg), Buffer.concat(body));
    return reply(200, [], []);
  }
  if (cmd === 'verify-object') return reply(fs.existsSync(objPath(arg)) ? 200 : 404, []);
  if (cmd === 'get-object' && operation === 'download') {
    let bytes;
    try { bytes = fs.readFileSync(objPath(arg)); } catch { return reply(404, [], ['not found']); }
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 65516) chunks.push(bytes.subarray(i, i + 65516));
    return reply(200, [`size=${bytes.length}`], chunks);
  }
  if (cmd === 'list-lock') return reply(200, [], []);
  return reply(400, [], [`${cmd} is not supported here`]);
};

out('');
pkt('version=1\n');
out(FLUSH);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const len = parseInt(buf.subarray(0, 4).toString(), 16);
    if (len === 0 || len === 1) {
      buf = buf.subarray(4);
      if (len === 1) { seenDelim = true; continue; }
      const [cmd, ...args] = head;
      const body = data;
      head = []; data = []; seenDelim = false;
      if (cmd) handle(cmd.toString(), args.map(String), body);
      continue;
    }
    if (buf.length < len) break;
    const p = buf.subarray(4, len);
    buf = buf.subarray(len);
    (seenDelim ? data : head).push(p);
  }
});
process.stdin.on('end', () => process.exit(0));
