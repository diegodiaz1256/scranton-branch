/**
 * The HTTP client the hive's own commands (md-api, md-run, md-browse) use to
 * reach the app's loopback key broker. Plain JS, spliced into each generated
 * `<hive>/bin/*.cjs` file; no dependencies.
 *
 * Why not `fetch`: inside Claude Code's OS sandbox (bubblewrap on Linux and in
 * a WSL floor's distro, Seatbelt on macOS) a command gets its own network, so
 * 127.0.0.1 is not where the broker listens and the connection is refused
 * ("md-api: fetch failed"). Its traffic leaves only through the sandbox's
 * proxy (`http_proxy`), and that proxy lets it reach exactly the broker's
 * port, which the agent's settings allow (hive.ts hookSettings). The sandbox
 * also lists 127.0.0.1 in `no_proxy`, and Node's fetch reads neither, so the
 * request is sent to the proxy by hand. Outside the sandbox it goes direct.
 *
 *   brokerRequest(url, { method, headers, body }) → { status, ok, text(), json() }
 *   brokerError('md-api', e, url) → one line naming the URL, the error code
 *                                   and, in the sandbox, what to do ('' for
 *                                   no "md-api: " prefix)
 */
export const BROKER_CLIENT_JS = String.raw`
const brokerHttp = require('http');
function brokerProxy() {
  if (process.env.SANDBOX_RUNTIME !== '1') return null;
  const raw = process.env.http_proxy || process.env.HTTP_PROXY;
  if (!raw) return null;
  try { const p = new URL(raw); return p.protocol === 'http:' ? p : null; } catch { return null; }
}
function brokerRequest(url, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body == null ? null : Buffer.from(String(opts.body), 'utf8');
    if (body) headers['Content-Length'] = body.length;
    const proxy = brokerProxy();
    let req;
    if (proxy) {
      headers.Host = u.host;
      if (proxy.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
      req = brokerHttp.request({ host: proxy.hostname, port: proxy.port || 80, method: opts.method || 'GET', path: u.href, headers });
    } else {
      req = brokerHttp.request(u, { method: opts.method || 'GET', headers });
    }
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        // The sandbox proxy's own refusal, not the broker's answer.
        if (proxy && res.statusCode === 403 && /blocked by network allowlist/i.test(text)) {
          const e = new Error('the sandbox network blocked ' + u.host);
          e.code = 'SANDBOX_BLOCKED';
          return reject(e);
        }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => text, json: async () => JSON.parse(text) });
      });
    });
    if (body) req.write(body);
    req.end();
  });
}
function brokerError(name, e, url) {
  const cause = (e && e.cause) || e || {};
  const msg = String((e && e.message) || e);
  const code = cause.code && msg.indexOf(cause.code) === -1 ? ' (' + cause.code + ')' : '';
  const where = url ? new URL(url).origin : 'the app';
  const hint = process.env.SANDBOX_RUNTIME === '1'
    ? 'This command runs inside the Claude Code sandbox, whose network must allow ' + where + ' (agents started by a current version of the app have that): ask the human to restart this agent.'
    : 'Is the app still running? Ask the human to restart this agent.';
  return (name ? name + ': ' : '') + 'could not reach the app at ' + where + ': ' + msg + code + '. ' + hint;
}
`;
