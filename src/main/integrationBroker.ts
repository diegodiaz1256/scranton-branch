/**
 * Loopback secret broker (Phase 2 foundation, main process).
 *
 * A 127.0.0.1-only HTTP proxy. An ephemeral worker calls
 *   <METHOD> http://127.0.0.1:<port>/i/<integrationId>/<path...>
 * authenticating with a PER-WORKER CAPABILITY TOKEN (a handle, NOT any secret) in the
 * `Authorization: Bearer` / `X-MD-Broker-Token` header. The broker validates the token,
 * authorizes the integration, decrypts the integration's real secret, injects it as the
 * upstream auth header, forwards to the integration's baseUrl, and streams the response
 * back. The worker uses the integration WITHOUT EVER SEEING the credential.
 *
 * Generalizes the existing src/main/slack.ts `SlackReplyServer` (a loopback broker that
 * posts Slack replies without the agent seeing the bot token) to an N-integration proxy.
 *
 * DEPENDENCY-FREE of electron by design: `getRecord` + `getSecret` are injected, so this
 * module is unit-testable under plain node. The secret is materialized ONLY here, at
 * forward-time, and is NEVER logged, NEVER returned to the worker, NEVER echoed in an
 * error.
 *
 * NOT an open proxy: a worker can only reach baseUrls the user registered (it selects an
 * integration by id, never a host), and the path is confined under the integration
 * origin (see resolveUpstreamUrl).
 *
 * Contract: hive/docs/integrations-spec.md.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable, type Duplex } from 'node:stream';
import { isReadRequest, type Access } from '../shared/connectionAccess';
import {
  type IntegrationRecord,
  buildAuthHeaders,
  resolveUpstreamUrl,
  authTypeNeedsSecret
} from '../shared/integrations';

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB request-body cap
const UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_USER_AGENT = 'munder-difflin-broker/1';

/** Hop-by-hop headers never forwarded in either direction. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
]);
/** Request headers the worker is NEVER allowed to pass upstream. */
const STRIP_REQUEST = new Set([
  'authorization', 'x-md-broker-token', 'host', 'cookie', 'content-length', ...HOP_BY_HOP
]);
/** Response headers never forwarded back (fetch already decodes the body, so the
 *  upstream content-encoding/length would be wrong). */
const STRIP_RESPONSE = new Set([
  'content-encoding', 'content-length', 'set-cookie', ...HOP_BY_HOP
]);

interface Capability {
  workerId: string;
  allowedIds: Set<string>;
  /** Per integration: 'read' lets only reads through (isReadRequest). Absent → unrestricted. */
  access: Map<string, Access>;
  /** The agent this capability belongs to. With `deps.live`, what it may use is
   *  looked up on every request from this id, not frozen at spawn. */
  agentId?: string;
  grantedAt: number;
}

export interface IntegrationBrokerDeps {
  /** Resolve an integration record by id (injected — the registry). */
  getRecord: (id: string) => IntegrationRecord | undefined;
  /** Decrypt a secret by ref (injected — the secret store). Main-internal. */
  getSecret: (secretRef: string | undefined) => string | undefined;
  /** What an agent may use RIGHT NOW (enabled, keyed, chosen, its level). When
   *  set, a capability carrying an agentId is checked against this on every
   *  request, so turning an API on (or off) applies at once, no respawn. */
  live?: (agentId: string) => { ids: string[]; access: Record<string, Access> };
  /** Why an agent may not use an integration, in words (for the 403). */
  whyNot?: (agentId: string, integrationId: string) => string | undefined;
  /** Checked on EVERY request to an integration, after (and whatever) the
   *  grant says: a reason to refuse it (a critical API this agent is not the
   *  custodian of, or a capability with no agent behind it), or null. Fail
   *  closed: a check that throws refuses. */
  refuse?: (agentId: string | undefined, integrationId: string) => string | null;
  /** Told about every request to an integration: who, which API, method and
   *  path (never the query, headers or bodies), allowed or not, the status. */
  onRequest?: (e: BrokerRequestRecord) => void;
  /** Runners (envVault.ts): what an agent may run with secrets it never sees. */
  runners?: {
    describe: (workerId: string) => Array<{ id: string; name: string; description?: string; secrets: string[] }>;
    run: (workerId: string, runnerId: string) => Promise<{ ok: boolean; exitCode?: number | null; output?: string; error?: string }>;
    /** Names (never values) of the secrets a proposed runner may use. */
    secretNames?: () => string[];
    /** Propose a runner; resolves once the human has decided. */
    propose?: (workerId: string, proposal: unknown) => Promise<{ ok: boolean; id?: string; error?: string }>;
  };
  /** The office browser (browser.ts): read a page or search the web with the
   *  app's Chromium. `blocked` says why this agent may not (Web switched off). */
  browser?: {
    blocked: (agentId: string | undefined) => string | null;
    browse: (url: string, opts: { links: boolean; maxChars: number; page?: number; mode?: string }) => Promise<string>;
    search: (query: string) => Promise<string>;
  };
  /** SSH through the office (sshRelay.ts): `GET /ssh` with `Upgrade: md-ssh`,
   *  handed over once the caller's token is checked. */
  ssh?: {
    upgrade: (agentId: string | undefined, req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  };
}

export interface BrokerRequestRecord {
  ts: number;
  agentId?: string;
  workerId: string;
  integrationId: string;
  method: string;
  /** The path under the API, without the query string. */
  path: string;
  allowed: boolean;
  status?: number;
}

/** True for IPv4 loopback (127.0.0.0/8) and IPv6 ::1 (incl. v4-mapped). Mirrors slack.ts. */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

export class IntegrationBroker {
  private server: Server | null = null;
  private port = 0;
  private readonly deps: IntegrationBrokerDeps;
  /** token -> capability. In-memory only; NEVER persisted. */
  private readonly byToken = new Map<string, Capability>();
  /** workerId -> token, for revoke. */
  private readonly byWorker = new Map<string, string>();

  constructor(deps: IntegrationBrokerDeps) {
    this.deps = deps;
  }

  /** Bind a loopback port (0 ⇒ OS-assigned). Resolves the bound port. */
  start(preferredPort = 0): Promise<{ ok: boolean; port?: number; error?: string }> {
    return new Promise((resolve) => {
      if (this.server) { resolve({ ok: true, port: this.port }); return; }
      const server = createServer((req, res) => this.handle(req, res));
      server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
      const onError = (e: Error): void => { server.off('listening', onListening); resolve({ ok: false, error: e.message }); };
      const onListening = (): void => {
        server.off('error', onError);
        this.server = server;
        const addr = server.address();
        this.port = addr && typeof addr === 'object' ? addr.port : preferredPort;
        resolve({ ok: true, port: this.port });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // 127.0.0.1 ONLY — never bound to a routable interface, never tunneled.
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /** Close the broker. Idempotent and best-effort. Clears all capabilities. */
  stop(): void {
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    this.port = 0;
    this.byToken.clear();
    this.byWorker.clear();
  }

  /** Whether the broker is bound and serving. */
  running(): boolean {
    return !!this.server && this.port > 0;
  }

  /** The base URL workers use (only valid while running). */
  url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Mint a per-worker capability token granting access to `allowedIds`. Any prior
   *  token for this worker is revoked first. The token is a random handle — never a
   *  secret, never persisted. */
  grant(workerId: string, allowedIds: string[], access?: Record<string, Access>, agentId?: string): string {
    this.revoke(workerId);
    const token = randomBytes(32).toString('base64url');
    this.byToken.set(token, { workerId, allowedIds: new Set(allowedIds), access: new Map(Object.entries(access ?? {})), agentId, grantedAt: Date.now() });
    this.byWorker.set(workerId, token);
    return token;
  }

  /** What a capability allows right now: looked up live for an agent's
   *  capability when the app provides `live`, else what was granted at spawn. */
  private allowed(cap: Capability): { ids: Set<string>; access: Map<string, Access> } {
    if (cap.agentId && this.deps.live) {
      try {
        const l = this.deps.live(cap.agentId);
        return { ids: new Set(l.ids), access: new Map(Object.entries(l.access)) };
      } catch { /* fall back to the spawn-time grant */ }
    }
    return { ids: cap.allowedIds, access: cap.access };
  }

  /** Revoke a worker's capability (called on teardown). Idempotent. */
  revoke(workerId: string): void {
    const token = this.byWorker.get(workerId);
    if (token) { this.byToken.delete(token); this.byWorker.delete(workerId); }
  }

  /** Constant-time-ish lookup of a presented token against live capabilities. */
  private resolveCapability(provided: string | undefined): Capability | undefined {
    if (!provided) return undefined;
    const a = Buffer.from(provided);
    for (const [token, cap] of this.byToken) {
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) return cap;
    }
    return undefined;
  }

  private static sendError(res: ServerResponse, status: number, code: string, message: string): void {
    if (res.headersSent) { try { res.end(); } catch { /* noop */ } return; }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message, code }));
  }

  /** Extract the bearer/x-md-broker-token from the request. */
  private static tokenFrom(req: IncomingMessage): string | undefined {
    const x = req.headers['x-md-broker-token'];
    if (typeof x === 'string' && x) return x;
    const auth = req.headers['authorization'];
    if (typeof auth === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (m) return m[1].trim();
    }
    return undefined;
  }

  /** An upgrade: only `GET /ssh` with `Upgrade: md-ssh` and a live token. */
  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => { /* the caller went away */ });
    const no = (status: number, message: string): void => {
      const body = JSON.stringify({ error: message });
      try { socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); } catch { /* gone */ }
    };
    if (!isLoopback(req.socket.remoteAddress ?? '')) return no(403, 'loopback callers only');
    const cap = this.resolveCapability(IntegrationBroker.tokenFrom(req));
    if (!cap) return no(401, 'missing or invalid capability token');
    if (!/^\/ssh\/?$/.test(req.url ?? '') || String(req.headers.upgrade ?? '').toLowerCase() !== 'md-ssh' || !this.deps.ssh) return no(404, 'not found');
    this.deps.ssh.upgrade(cap.agentId, req, socket, head);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // 1) Loopback — defense in depth even though the bind already excludes others.
    if (!isLoopback(req.socket.remoteAddress ?? '')) {
      return IntegrationBroker.sendError(res, 403, 'forbidden', 'loopback callers only');
    }
    // 2) Capability token.
    const cap = this.resolveCapability(IntegrationBroker.tokenFrom(req));
    if (!cap) return IntegrationBroker.sendError(res, 401, 'unauthorized', 'missing or invalid capability token');

    // 3a) Runners: GET /run lists them, POST /run/<id> runs one. The output
    //     comes back with every secret value masked (envVault.ts).
    const rawUrl = req.url ?? '';
    const run = /^\/run(?:\/([^/?#]+))?\/?$/.exec(rawUrl);
    if (run && this.deps.runners) {
      const runners = this.deps.runners;
      if (!run[1] && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ runners: runners.describe(cap.workerId), secrets: runners.secretNames?.() ?? [] }));
        return;
      }
      // POST /run {name, command, secrets, description}: propose a new runner.
      // Held open until the human decides (the prompt shows the command).
      if (!run[1] && req.method === 'POST' && runners.propose) {
        const propose = runners.propose;
        void readBodyCapped(req).then(async (buf) => {
          let body: unknown = {};
          try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch { return IntegrationBroker.sendError(res, 400, 'bad_request', 'body must be JSON'); }
          const r = await propose(cap.workerId, body);
          res.writeHead(r.ok ? 200 : 409, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        }, (e) => IntegrationBroker.sendError(res, 500, 'proposal_failed', e instanceof Error ? e.message : String(e)));
        return;
      }
      if (run[1] && req.method === 'POST') {
        void runners.run(cap.workerId, decodeURIComponent(run[1])).then((r) => {
          res.writeHead(r.ok ? 200 : 409, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        }, (e) => IntegrationBroker.sendError(res, 500, 'runner_failed', e instanceof Error ? e.message : String(e)));
        return;
      }
      return IntegrationBroker.sendError(res, 405, 'method_not_allowed', 'GET /run, POST /run (propose) or POST /run/<id>');
    }

    // 3a'') POST /browse {url, links?, max_chars?} and POST /search {query}: the
    //      office browser (sb-browse). Plain text back.
    const browse = /^\/(browse|search)\/?$/.exec(rawUrl);
    if (browse && this.deps.browser) {
      if ((req.method ?? '').toUpperCase() !== 'POST') return IntegrationBroker.sendError(res, 405, 'method_not_allowed', `POST /${browse[1]}`);
      const browser = this.deps.browser;
      const why = browser.blocked(cap.agentId);
      if (why) return IntegrationBroker.sendError(res, 403, 'forbidden', why);
      void readBodyCapped(req).then(async (buf) => {
        let a: Record<string, unknown> = {};
        try { a = JSON.parse(buf.toString('utf8') || '{}'); } catch { /* empty */ }
        const text = browse[1] === 'search'
          ? await browser.search(String(a.query ?? ''))
          : await browser.browse(String(a.url ?? ''), {
            links: a.links === true,
            maxChars: typeof a.max_chars === 'number' ? a.max_chars : 0,
            page: typeof a.page === 'number' ? a.page : 1,
            mode: typeof a.mode === 'string' ? a.mode : undefined
          });
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(text);
      }).catch((e) => IntegrationBroker.sendError(res, 422, 'browse_failed', e instanceof Error ? e.message : String(e)));
      return;
    }

    // 3a') GET /i: the APIs this agent may use right now (sb-api with no arguments).
    if (/^\/i\/?(\?.*)?$/.test(rawUrl) && (req.method ?? 'GET').toUpperCase() === 'GET') {
      const now = this.allowed(cap);
      const apis = [...now.ids].map((id) => ({ id, label: this.deps.getRecord(id)?.label ?? id, access: now.access.get(id) ?? 'readwrite' }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ apis }));
      return;
    }

    // 3) Parse /i/<integrationId>/<path...>.
    const m = /^\/i\/([^/?#]+)(?:\/([^?#]*))?(\?[^#]*)?$/.exec(rawUrl);
    if (!m) return IntegrationBroker.sendError(res, 404, 'not_found', 'expected /i/<integrationId>/<path>');
    const integrationId = decodeURIComponent(m[1]);
    const path = m[2] ?? '';
    const query = m[3] ?? '';
    const method = (req.method ?? 'GET').toUpperCase();
    const note = (allowed: boolean, status?: number): void => {
      try { this.deps.onRequest?.({ ts: Date.now(), agentId: cap.agentId, workerId: cap.workerId, integrationId, method, path: `/${path}`, allowed, status }); } catch { /* a log never breaks a call */ }
    };

    // 3') Critical APIs: only the custodian, checked here whatever was granted.
    if (this.deps.refuse) {
      let why: string | null;
      try { why = this.deps.refuse(cap.agentId, integrationId); } catch { why = `${integrationId} cannot be checked right now, so it is refused.`; }
      if (why) { note(false, 403); return IntegrationBroker.sendError(res, 403, 'critical', why); }
    }

    // 4) Authorize: live (what the agent may use now) or the spawn-time grant.
    const now = this.allowed(cap);
    if (!now.ids.has(integrationId) || now.access.get(integrationId) === 'none') {
      const why = cap.agentId ? this.deps.whyNot?.(cap.agentId, integrationId) : undefined;
      return IntegrationBroker.sendError(res, 403, 'forbidden',
        why ? `${integrationId} is not available to this agent: ${why}. Changes in Connections apply at once, no restart needed.` : 'integration not in this worker capability');
    }
    // 5) Resolve the record (still enabled?).
    const rec = this.deps.getRecord(integrationId);
    if (!rec) return IntegrationBroker.sendError(res, 404, 'not_found', 'unknown integration');
    if (!rec.enabled) return IntegrationBroker.sendError(res, 403, 'forbidden', 'integration is disabled');

    // 6) Confine the upstream URL under the integration origin (NOT an open proxy).
    const upstream = resolveUpstreamUrl(rec.baseUrl, path + query);
    if (!upstream) return IntegrationBroker.sendError(res, 400, 'bad_request', 'invalid or out-of-bounds path');

    // 7) Secret (decrypted ONLY here, used ONLY to inject the upstream header).
    let secret: string | undefined;
    if (authTypeNeedsSecret(rec.authType)) {
      secret = this.deps.getSecret(rec.secretRef);
      if (!secret) return IntegrationBroker.sendError(res, 503, 'no_secret', 'no secret configured for this integration');
    }

    // The full upstream path: an API whose base is the endpoint (Linear's /graphql)
    // sends an empty relative one.
    note(true);
    void this.forward(req, res, rec, upstream, secret, now.access.get(integrationId), upstream.pathname);
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    rec: IntegrationRecord,
    upstream: URL,
    secret: string | undefined,
    access?: Access,
    path = ''
  ): Promise<void> {
    // Buffer the request body with a hard cap (write methods).
    const method = (req.method ?? 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD';
    let body: Buffer | undefined;
    if (hasBody) {
      try {
        body = await readBodyCapped(req);
      } catch (e) {
        if ((e as Error).message === 'too_large') {
          return IntegrationBroker.sendError(res, 413, 'payload_too_large', 'request body too large');
        }
        return IntegrationBroker.sendError(res, 400, 'bad_request', 'could not read request body');
      }
    }

    // Read-only access (Connections → REST APIs, or the agent's role): reads and
    // searches only. Checked before the secret ever goes upstream.
    if (access === 'read' && !isReadRequest(method, path, body?.toString('utf8'))) {
      return IntegrationBroker.sendError(res, 403, 'read_only', `${method} ${path} would change things; your access to this API is read-only. Ask the human to give your role read & write access (Capabilities) or raise the API's limit (Connections).`);
    }

    // Sanitize worker headers, then inject the auth header(s). Injected auth ALWAYS
    // wins: the strip list removes any worker-supplied authorization/auth header.
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (STRIP_REQUEST.has(key)) continue;
      if (Array.isArray(v)) outHeaders[key] = v.join(', ');
      else if (typeof v === 'string') outHeaders[key] = v;
    }
    if (!outHeaders['user-agent']) outHeaders['user-agent'] = DEFAULT_USER_AGENT;
    const injected = buildAuthHeaders(rec.authType, rec.authHeader, secret);
    for (const [k, v] of Object.entries(injected)) {
      delete outHeaders[k]; // ensure the worker can't shadow an injected header
      outHeaders[k] = v;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(upstream, {
        method,
        headers: outHeaders,
        body: body as BodyInit | undefined,
        redirect: 'manual',
        signal: ac.signal
      });
    } catch (e) {
      clearTimeout(timer);
      // The message could in theory contain the URL but never the secret.
      return IntegrationBroker.sendError(res, 502, 'bad_gateway', `upstream request failed: ${(e as Error).message}`);
    }

    // Stream the response back (status + sanitized headers + body).
    const respHeaders: Record<string, string> = {};
    upstreamRes.headers.forEach((value, key) => {
      if (!STRIP_RESPONSE.has(key.toLowerCase())) respHeaders[key] = value;
    });
    res.writeHead(upstreamRes.status, respHeaders);
    try {
      if (upstreamRes.body) {
        await pipeWebStream(upstreamRes.body, res);
      } else {
        res.end();
      }
    } catch {
      try { res.end(); } catch { /* socket gone */ }
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read a request body into a Buffer, aborting past MAX_BODY_BYTES (throws 'too_large'). */
function readBodyCapped(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (e) => reject(e));
  });
}

/** Pipe a web ReadableStream (fetch response body) to a node ServerResponse. */
function pipeWebStream(web: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const node = Readable.fromWeb(web as Parameters<typeof Readable.fromWeb>[0]);
    node.on('error', reject);
    res.on('error', reject);
    res.on('finish', resolve);
    node.pipe(res);
  });
}
