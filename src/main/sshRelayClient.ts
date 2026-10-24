/**
 * md-ssh: the `ssh` an agent in an OS sandbox finds first on its PATH
 * (<hive>/bin/ssh/ssh runs <hive>/bin/md-ssh.cjs). It never touches a key:
 * it sends the argv git gave it to the app's key broker (`GET /ssh`,
 * `Upgrade: md-ssh`, through the sandbox's proxy when there is one) and pipes
 * stdin/stdout/stderr in frames (shared/sshRelay.ts) until the app reports
 * ssh's exit code. A refusal is printed as one line and exits 255, as ssh
 * does when it cannot connect. Plain node, no dependencies.
 *
 * md-ssh-sign: the agent's gpg.ssh.program (<hive>/bin/ssh/md-ssh-sign runs
 * <hive>/bin/md-ssh-sign.cjs). `-Y sign` sends the public key and the object
 * git wants signed the same way and writes the signature the app sends back
 * to <file>.sig, as ssh-keygen does; every other `-Y` (verify,
 * find-principals, check-novalidate) needs no key and runs the real
 * ssh-keygen.
 */
import { BROKER_CLIENT_JS } from './brokerClient';

/**
 * The transport both share: `officeRelay(spec, io)` opens `GET /ssh` with the
 * spec in X-MD-SSH, streams io.input as stdin frames and hands back stdout,
 * stderr and the exit code. Needs `base`, `token` and `die` in scope.
 */
const RELAY_JS = `${BROKER_CLIENT_JS}
function officeRelay(specObj, io) {
  const u = new URL(base);
  const proxy = brokerProxy();
  const spec = Buffer.from(JSON.stringify(specObj)).toString('base64');
  const sock = proxy ? net.connect(+(proxy.port || 80), proxy.hostname) : net.connect(+u.port, u.hostname);
  let phase = proxy ? 'connect' : 'upgrade';
  let buf = Buffer.alloc(0);
  let status = 0, body = '', framed = false, exiting = false;
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
      if (type === 1) { if (io.out(data) === false) { sock.pause(); io.drain(() => sock.resume()); } }
      else if (type === 2) io.err(data);
      else if (type === 3) { exiting = true; io.exit(data.readInt32BE(0)); return; }
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
      io.input((c) => sock.write(frame(0, c)), () => sock.write(frame(4)));
      if (rest.length) onFrames(rest);
      return;
    }
    status = code || 500;
    body = rest.toString('utf8');
  });
  sock.on('close', () => {
    // It already finished: its exit code is out, only output is still flushing.
    if (exiting) return;
    if (framed) die('the connection to the app closed before it finished');
    let msg = body;
    try { msg = JSON.parse(body).error || body; } catch { /* plain text */ }
    die(msg || ('the app answered HTTP ' + status));
  });
}
`;

export const MD_SSH_CLI = `#!/usr/bin/env node
'use strict';
const net = require('net');
const argv = process.argv.slice(2);
const base = process.env.MD_BROKER_URL, token = process.env.MD_BROKER_TOKEN;
const die = (m) => { process.stderr.write('ssh (office): ' + m + '\\n'); process.exit(255); };
if (!base || !token) die('SSH keys are hidden from agents in this office, and this agent was started without the app (an old session): ask the human to restart it, or use an HTTPS remote.');
${RELAY_JS}
officeRelay({ argv, gitProtocol: process.env.GIT_PROTOCOL || undefined }, {
  input: (send, end) => { process.stdin.on('data', send); process.stdin.on('end', end); },
  out: (d) => process.stdout.write(d),
  drain: (f) => process.stdout.once('drain', f),
  err: (d) => process.stderr.write(d),
  exit: (code) => process.stdout.write('', () => process.exit(code))
});
`;

export const MD_SSH_SIGN_CLI = `#!/usr/bin/env node
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const die = (m) => { process.stderr.write('sign (office): ' + m + '\\n'); process.exit(255); };
// ssh-keygen's arguments as git passes them: -Y <op> -n <ns> -f <key> [-U] [-O opt] <file>...
let op = '', ns = '', keyFile = '';
const files = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-Y') op = argv[++i] || '';
  else if (a === '-n') ns = argv[++i] || '';
  else if (a === '-f') keyFile = argv[++i] || '';
  else if (a === '-O' || a === '-I' || a === '-s') i++;
  else if (a.startsWith('-') && a !== '-') continue;
  else files.push(a);
}
if (op !== 'sign') {
  // Verifying needs no key: the real ssh-keygen (the office's folder holds none).
  const r = require('child_process').spawnSync('ssh-keygen', argv, { stdio: 'inherit' });
  if (r.error) die('ssh-keygen: ' + r.error.message);
  process.exit(r.status === null ? 255 : r.status);
}
const base = process.env.MD_BROKER_URL, token = process.env.MD_BROKER_TOKEN;
if (!base || !token) die('signing with your SSH key goes through the office, and this agent was started without the app (an old session): ask the human to restart it.');
${RELAY_JS}
// The key, as git named it: a public key line is sent as is; a key file the
// agent cannot read (its keys are hidden) is sent by path for the app to find
// among the human's. A private key's contents are never sent.
const key = {};
if (keyFile) {
  const pubOf = (f) => { try { const t = fs.readFileSync(f, 'utf8'); return /^(key::)?(ssh|ecdsa|sk-ssh|sk-ecdsa)-/.test(t.trim()) ? t.trim().split(/\\r?\\n/)[0] : ''; } catch { return ''; } };
  const pub = pubOf(keyFile) || pubOf(keyFile + '.pub');
  if (pub) key.pub = pub;
  else key.keyPath = path.resolve(keyFile.replace(/^~(?=\\/)/, process.env.HOME || '~'));
}
const target = files[0];
if (files.length > 1) die('one file at a time');
let input;
try { input = target ? fs.readFileSync(target) : fs.readFileSync(0); } catch (e) { die('cannot read ' + (target || 'stdin') + ': ' + e.message); }
const sig = [];
officeRelay({ op: 'sign', namespace: ns, ...key, cwd: process.cwd() }, {
  input: (send, end) => { for (let i = 0; i < input.length; i += 65536) send(input.subarray(i, i + 65536)); end(); },
  out: (d) => { sig.push(Buffer.from(d)); return true; },
  drain: () => {},
  err: (d) => process.stderr.write(d),
  exit: (code) => {
    if (code === 0) {
      try { if (target) fs.writeFileSync(target + '.sig', Buffer.concat(sig)); else process.stdout.write(Buffer.concat(sig)); }
      catch (e) { die('cannot write the signature: ' + e.message); }
    }
    process.stderr.write('', () => process.exit(code));
  }
});
`;

/** A wrapper on the agent's PATH: `exec <node> <script> "$@"`. Paths are the
 *  agent's own (Linux paths on a WSL floor), single-quoted for sh. */
export function sshWrapperScript(node: string, script: string, what = 'ssh: git over SSH without the keys (md-ssh.cjs)'): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# The office's ${what}.\nexec ${node === 'node' ? 'node' : q(node)} ${q(script)} "$@"\n`;
}
