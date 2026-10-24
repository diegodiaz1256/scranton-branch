/**
 * md-netgate: the network wall around a pi custodian (criticalConnections.ts).
 *
 * Bubblewrap can take a process's network away (--unshare-net) but cannot
 * filter it. So the custodian runs with NO network, and this small script
 * gives it back exactly two things, the way Claude Code's own sandbox does
 * with its proxy:
 *   - the app's services on loopback (hook server, key broker, MCP gateway,
 *     telemetry: every 127.0.0.1/localhost port named in its environment), and
 *     a loopback model if that is what it uses;
 *   - HTTPS to its model provider's hosts only, through a CONNECT proxy that
 *     refuses every other host.
 *
 * Run as:  node md-netgate.cjs <gate dir> <allowed hosts, comma> -- bwrap … --unshare-net … -- node md-netgate.cjs --inner <gate dir> -- pi …
 * Outside the sandbox it listens on Unix sockets in <gate dir> (bound into the
 * sandbox) and relays them to the real ports and hosts; inside, it listens on
 * the same loopback ports and relays them to those sockets, then runs the CLI
 * with HTTPS_PROXY pointing at the proxy. Plain Node, no dependencies. Written
 * into the custodian's own folder at every spawn (no other agent can write it).
 */
export const MD_NETGATE = String.raw`#!/usr/bin/env node
'use strict';
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const inner = argv[0] === '--inner';
const rest = inner ? argv.slice(1) : argv;
const sep = rest.indexOf('--');
const head = rest.slice(0, sep < 0 ? rest.length : sep);
const cmd = sep < 0 ? [] : rest.slice(sep + 1);
const dir = head[0];
const PROXY_PORT = 3128;

// Loopback ports the agent is told about (its env) and a loopback model.
function loopbackPorts() {
  const ports = new Set();
  const scan = (s) => { for (const m of String(s).matchAll(/(?:127\.0\.0\.1|localhost):(\d{2,5})/g)) ports.add(Number(m[1])); };
  for (const v of Object.values(process.env)) scan(v);
  try { scan(fs.readFileSync(path.join(process.env.PI_CODING_AGENT_DIR || '', 'models.json'), 'utf8')); } catch (e) {}
  ports.delete(PROXY_PORT);
  return [...ports].filter((p) => p > 0 && p < 65536);
}

function pipe(a, b) { a.pipe(b); b.pipe(a); a.on('error', () => b.destroy()); b.on('error', () => a.destroy()); }

function run(command, env) {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
  for (const s of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(s, () => { try { child.kill(s); } catch (e) {} });
  child.on('exit', (code, sig) => process.exit(code == null ? (sig ? 1 : 0) : code));
  child.on('error', (e) => { process.stderr.write('md-netgate: ' + e.message + '\n'); process.exit(127); });
}

if (!inner) {
  const allow = new Set(String(head[1] || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.sock')) try { fs.unlinkSync(path.join(dir, f)); } catch (e) {}
  for (const port of loopbackPorts()) {
    net.createServer((c) => pipe(c, net.connect(port, '127.0.0.1'))).on('error', () => {}).listen(path.join(dir, port + '.sock'));
  }
  // CONNECT proxy: the model provider's hosts on 443, nothing else.
  net.createServer((c) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 8192) c.destroy(); return; }
      c.removeListener('data', onData);
      const m = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]\r\n/i.exec(buf);
      const host = m ? m[1].toLowerCase() : '';
      if (!m || m[2] !== '443' || !allow.has(host)) {
        process.stderr.write('md-netgate: refused ' + (m ? host + ':' + m[2] : 'a non-CONNECT request') + '\n');
        c.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nmd-netgate: this agent may reach only its model provider (' + [...allow].join(', ') + ').\n');
        return;
      }
      const up = net.connect(443, host, () => { c.write('HTTP/1.1 200 Connection established\r\n\r\n'); const extra = buf.slice(end + 4); if (extra) up.write(Buffer.from(extra, 'latin1')); pipe(c, up); });
      up.on('error', () => { try { c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {} });
    };
    c.on('data', onData);
    c.on('error', () => {});
  }).listen(path.join(dir, 'proxy.sock'), () => run(cmd, process.env));
} else {
  const ports = loopbackPorts();
  let pending = ports.length + 1;
  const ready = () => {
    if (--pending) return;
    const proxy = 'http://127.0.0.1:' + PROXY_PORT;
    run(cmd, { ...process.env, HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', NODE_USE_ENV_PROXY: '1' });
  };
  for (const port of ports) net.createServer((c) => pipe(c, net.connect(path.join(dir, port + '.sock')))).listen(port, '127.0.0.1', ready);
  net.createServer((c) => pipe(c, net.connect(path.join(dir, 'proxy.sock')))).listen(PROXY_PORT, '127.0.0.1', ready);
}
`;

/** Model provider hosts for pi's built-in providers (its settings name one). */
export const PI_PROVIDER_HOSTS: Record<string, string[]> = {
  anthropic: ['api.anthropic.com'],
  openai: ['api.openai.com'],
  'openai-codex': ['chatgpt.com', 'api.openai.com'],
  google: ['generativelanguage.googleapis.com'],
  'google-gemini-cli': ['cloudcode-pa.googleapis.com'],
  'github-copilot': ['api.githubcopilot.com', 'api.individual.githubcopilot.com', 'api.github.com'],
  groq: ['api.groq.com'],
  mistral: ['api.mistral.ai'],
  openrouter: ['openrouter.ai'],
  xai: ['api.x.ai'],
  cerebras: ['api.cerebras.ai'],
  deepseek: ['api.deepseek.com']
};

/** The hosts a pi custodian may reach: its default provider's, and the
 *  remote base URLs of its custom models (models.json). */
export function piModelHosts(settingsJson: string | null, modelsJson: string | null): string[] {
  const hosts = new Set<string>();
  try {
    const s = settingsJson ? JSON.parse(settingsJson) as { defaultProvider?: unknown } : {};
    if (typeof s.defaultProvider === 'string') for (const h of PI_PROVIDER_HOSTS[s.defaultProvider] ?? []) hosts.add(h);
  } catch { /* unreadable: none */ }
  try {
    const m = modelsJson ? JSON.parse(modelsJson) as { providers?: Record<string, { baseUrl?: unknown }> } : {};
    for (const p of Object.values(m.providers ?? {})) {
      if (typeof p?.baseUrl !== 'string') continue;
      try { const u = new URL(p.baseUrl); if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) hosts.add(u.hostname.toLowerCase()); } catch { /* not a URL */ }
    }
  } catch { /* unreadable: none */ }
  return [...hosts];
}
