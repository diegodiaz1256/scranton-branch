/**
 * md-ssh: the `ssh` an agent in an OS sandbox finds first on its PATH
 * (<hive>/bin/ssh/ssh runs <hive>/bin/md-ssh.cjs). It never touches a key:
 * it sends the argv git gave it to the app's key broker (`GET /ssh`,
 * `Upgrade: md-ssh`, through the sandbox's proxy when there is one) and pipes
 * stdin/stdout/stderr in frames (shared/sshRelay.ts) until the app reports
 * ssh's exit code. A refusal is printed as one line and exits 255, as ssh
 * does when it cannot connect. Plain node, no dependencies.
 */
import { BROKER_CLIENT_JS } from './brokerClient';

export const MD_SSH_CLI = `#!/usr/bin/env node
'use strict';
const net = require('net');
const argv = process.argv.slice(2);
const base = process.env.MD_BROKER_URL, token = process.env.MD_BROKER_TOKEN;
const die = (m) => { process.stderr.write('ssh (office): ' + m + '\\n'); process.exit(255); };
if (!base || !token) die('SSH keys are hidden from agents in this office, and this agent was started without the app (an old session): ask the human to restart it, or use an HTTPS remote.');
${BROKER_CLIENT_JS}
const u = new URL(base);
const proxy = brokerProxy();
const spec = Buffer.from(JSON.stringify({ argv, gitProtocol: process.env.GIT_PROTOCOL || undefined })).toString('base64');
const sock = proxy ? net.connect(+(proxy.port || 80), proxy.hostname) : net.connect(+u.port, u.hostname);
let phase = proxy ? 'connect' : 'upgrade';
let buf = Buffer.alloc(0);
let status = 0, body = '', framed = false;
const frame = (type, data) => { const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(data ? data.length : 0, 1); return data ? Buffer.concat([h, data]) : h; };
const sendUpgrade = () => sock.write('GET /ssh HTTP/1.1\\r\\nHost: ' + u.host + '\\r\\nAuthorization: Bearer ' + token + '\\r\\nConnection: Upgrade\\r\\nUpgrade: md-ssh\\r\\nX-MD-SSH: ' + spec + '\\r\\n\\r\\n');
sock.on('connect', () => {
  if (phase === 'connect') {
    const auth = proxy.username ? 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') + '\\r\\n' : '';
    sock.write('CONNECT ' + u.host + ' HTTP/1.1\\r\\nHost: ' + u.host + '\\r\\n' + auth + '\\r\\n');
  } else sendUpgrade();
});
sock.on('error', (e) => die(brokerError('', e, base)));
let pending = Buffer.alloc(0);
const onFrames = (d) => {
  pending = Buffer.concat([pending, d]);
  while (pending.length >= 5) {
    const len = pending.readUInt32BE(1);
    if (pending.length < 5 + len) break;
    const type = pending[0], data = pending.subarray(5, 5 + len);
    pending = pending.subarray(5 + len);
    if (type === 1) { if (!process.stdout.write(data)) { sock.pause(); process.stdout.once('drain', () => sock.resume()); } }
    else if (type === 2) process.stderr.write(data);
    else if (type === 3) { const code = data.readInt32BE(0); process.stdout.write('', () => process.exit(code)); return; }
  }
};
sock.on('data', (d) => {
  if (framed) return onFrames(d);
  buf = Buffer.concat([buf, d]);
  if (status) { body += d.toString('utf8'); return; }
  const end = buf.indexOf('\\r\\n\\r\\n');
  if (end === -1) return;
  const head = buf.subarray(0, end).toString('latin1');
  const rest = buf.subarray(end + 4);
  buf = Buffer.alloc(0);
  const code = +((/^HTTP\\/1\\.[01] (\\d{3})/.exec(head) || [])[1] || 0);
  if (phase === 'connect') {
    if (code !== 200) die('the sandbox network blocked ' + u.host + ' (HTTP ' + code + '). ' + brokerError('', new Error('blocked'), base));
    phase = 'upgrade';
    sendUpgrade();
    return;
  }
  if (code === 101) {
    framed = true;
    process.stdin.on('data', (c) => sock.write(frame(0, c)));
    process.stdin.on('end', () => sock.write(frame(4)));
    if (rest.length) onFrames(rest);
    return;
  }
  status = code || 500;
  body = rest.toString('utf8');
});
sock.on('close', () => {
  if (framed) die('the connection to the app closed before ssh finished');
  let msg = body;
  try { msg = JSON.parse(body).error || body; } catch { /* plain text */ }
  die(msg || ('the app answered HTTP ' + status));
});
`;

/** The `ssh` on the agent's PATH: `exec <node> <md-ssh.cjs> "$@"`. Paths are
 *  the agent's own (Linux paths on a WSL floor), single-quoted for sh. */
export function sshWrapperScript(node: string, script: string): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# The office's ssh: git over SSH without the keys (md-ssh.cjs).\nexec ${node === 'node' ? 'node' : q(node)} ${q(script)} "$@"\n`;
}
