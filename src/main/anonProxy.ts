/**
 * The anonymization proxy: a loopback HTTP server in the main process that
 * sits between an agent's CLI and its model API.
 *
 *   CLI ──http──▶ 127.0.0.1:<port>/a/<route token>/… ──https──▶ real upstream
 *
 * Requests: JSON bodies are rewritten with the office's Anonymizer (names,
 * secrets… become codenames). Responses: codenames are restored to the real
 * values, whole JSON bodies and SSE streams alike, so the CLI (and the human)
 * keep working with the real names while the model only ever sees codenames.
 *
 * - One route per agent and upstream: the token in the path says which agent
 *   (its counters) and where to forward. An unknown token is refused, so no
 *   other local program can use the proxy to restore codenames.
 * - Headers pass through untouched (auth, API keys, betas), minus hop-by-hop
 *   ones; content-length is recomputed. Responses are asked uncompressed and
 *   decoded if they come compressed anyway.
 * - Fails closed: a body it cannot read (not JSON, compressed) on a request
 *   with a body is refused, never forwarded as is.
 * - One PseudonymMap per office, persisted (anonStore.ts) so resumed sessions
 *   restore. Bodies are never logged.
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { Anonymizer, PseudonymMap, apiForPath, type ApiFlavor } from '../shared/anonymize';
import { anonOptions, type AnonDictionary, type AnonSettings } from '../shared/anonSettings';

export interface AnonProxyDeps {
  settings(): AnonSettings;
  dictionary(): AnonDictionary;
  loadMap(office: string): PseudonymMap;
  saveMap(office: string, map: PseudonymMap): void;
  log?(m: string): void;
  /** One request's substitutions for an agent (placeholders only, never values). */
  onSubstitutions?(agentId: string, subs: Array<{ family: string; placeholder: string }>): void;
}

interface Route {
  token: string;
  agentId: string;
  office: string;
  upstream: string;
  tls?: { caFile?: string; insecure?: boolean };
}

interface Office {
  map: PseudonymMap;
  anon: Anonymizer | null;
  savedVersion: number;
  saveTimer: NodeJS.Timeout | null;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const MAX_BODY = 64 * 1024 * 1024;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every string value in a JSON value through `fn` (keys untouched). */
function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (isObj(v)) { const o: Obj = {}; for (const [k, x] of Object.entries(v)) o[k] = mapStrings(x, fn); return o; }
  return v;
}

/** Which API a path speaks, for the request side. count_tokens carries the
 *  whole conversation too: rewritten like a message, its answer is a number. */
export function requestFlavor(path: string): ApiFlavor | null {
  const p = path.split('?')[0];
  if (/\/messages\/count_tokens$/.test(p)) return 'anthropic';
  return apiForPath(p);
}

/** Join the upstream base and the path the CLI asked for. */
export function upstreamUrl(upstream: string, rest: string): URL {
  return new URL(upstream.replace(/\/+$/, '') + (rest.startsWith('/') ? rest : `/${rest}`));
}

export class AnonProxy {
  private server: http.Server | null = null;
  private port = 0;
  private starting: Promise<number> | null = null;
  private routes = new Map<string, Route>();
  private offices = new Map<string, Office>();

  constructor(private deps: AnonProxyDeps) {}

  running(): boolean { return !!this.server && this.port > 0; }
  url(): string | null { return this.running() ? `http://127.0.0.1:${this.port}` : null; }
  portNumber(): number { return this.port; }

  /** Listen on 127.0.0.1 (once). Rejects when it cannot bind. */
  start(): Promise<number> {
    if (this.running()) return Promise.resolve(this.port);
    if (this.starting) return this.starting;
    this.starting = new Promise<number>((resolve, reject) => {
      const srv = http.createServer((req, res) => { void this.handle(req, res); });
      srv.keepAliveTimeout = 65_000;
      srv.requestTimeout = 0; // streams can run for many minutes
      srv.once('error', (e) => { this.starting = null; reject(e); });
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address();
        this.port = a && typeof a === 'object' ? a.port : 0;
        this.server = srv;
        this.starting = null;
        srv.on('error', (e) => this.deps.log?.(`[anon] server error: ${e.message}`));
        resolve(this.port);
      });
    });
    return this.starting;
  }

  stop(): void {
    for (const office of this.offices.keys()) this.flush(office);
    try { this.server?.close(); } catch { /* gone */ }
    this.server = null;
    this.port = 0;
  }

  /**
   * A route for one agent to one upstream. Returns the base URL the CLI is
   * given (its base-URL env var or config). Same agent + upstream: same route.
   */
  addRoute(agentId: string, office: string, upstream: string, tls?: Route['tls']): string {
    const base = this.url();
    if (!base) throw new Error('the anonymization proxy is not running');
    const clean = upstream.trim().replace(/\/+$/, '');
    new URL(clean); // throws on a bad upstream
    for (const r of this.routes.values()) {
      if (r.agentId === agentId && r.upstream === clean && r.office === office) { r.tls = tls; return `${base}/a/${r.token}`; }
    }
    const token = randomBytes(18).toString('base64url');
    this.routes.set(token, { token, agentId, office, upstream: clean, tls });
    return `${base}/a/${token}`;
  }

  /** Forget an agent's routes (its process ended). */
  dropAgent(agentId: string): void {
    for (const [t, r] of this.routes) if (r.agentId === agentId) this.routes.delete(t);
  }

  /**
   * What the model would see for this text, with the office's dictionary and
   * map, without touching the map (a copy): a preview never assigns codenames
   * that real traffic would then inherit.
   */
  preview(office: string, text: string): { output: string; subs: Array<{ family: string; placeholder: string }> } {
    const live = this.anonymizerFor(office);
    const anon = new Anonymizer(anonOptions(this.deps.settings(), this.deps.dictionary()), PseudonymMap.fromJSON(live.map.toJSON()));
    const subs: Array<{ family: string; placeholder: string }> = [];
    anon.onSubstitute = (family, placeholder) => { subs.push({ family, placeholder }); };
    return { output: anon.pseudonymizeText(text), subs };
  }

  /** Settings or dictionary changed: the next request rebuilds the Anonymizer. */
  invalidate(): void {
    for (const o of this.offices.values()) o.anon = null;
  }

  /** The office's anonymizer (shared map; options as they are now). */
  anonymizerFor(office: string): Anonymizer {
    let o = this.offices.get(office);
    if (!o) {
      const map = this.deps.loadMap(office);
      o = { map, anon: null, savedVersion: map.version, saveTimer: null };
      this.offices.set(office, o);
    }
    if (!o.anon) o.anon = new Anonymizer(anonOptions(this.deps.settings(), this.deps.dictionary()), o.map);
    return o.anon;
  }

  private scheduleSave(office: string): void {
    const o = this.offices.get(office);
    if (!o || o.map.version === o.savedVersion || o.saveTimer) return;
    o.saveTimer = setTimeout(() => { o.saveTimer = null; this.flush(office); }, 500);
    o.saveTimer.unref?.();
  }

  private flush(office: string): void {
    const o = this.offices.get(office);
    if (!o) return;
    if (o.saveTimer) { clearTimeout(o.saveTimer); o.saveTimer = null; }
    if (o.map.version === o.savedVersion) return;
    this.deps.saveMap(office, o.map);
    o.savedVersion = o.map.version;
  }

  private fail(res: http.ServerResponse, status: number, msg: string): void {
    if (res.headersSent) { try { res.destroy(); } catch { /* gone */ } return; }
    const body = JSON.stringify({ type: 'error', error: { type: 'anonymizer_error', message: `Scranton Branch anonymizer: ${msg}` } });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const m = /^\/a\/([A-Za-z0-9_-]{16,64})(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '');
    const route = m ? this.routes.get(m[1]) : undefined;
    if (!m || !route) { this.fail(res, 403, 'unknown route'); return; }
    const rest = (m[2] ?? '/') + (m[3] ?? '');
    let target: URL;
    try { target = upstreamUrl(route.upstream, rest); } catch { this.fail(res, 502, 'bad upstream'); return; }

    // Read the request body.
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) { this.fail(res, 413, 'request too large'); return; }
        chunks.push(c as Buffer);
      }
    } catch { this.fail(res, 400, 'request aborted'); return; }
    let body = Buffer.concat(chunks);

    let anon: Anonymizer;
    try { anon = this.anonymizerFor(route.office); } catch (e) { this.fail(res, 500, 'could not load the dictionary'); this.deps.log?.(`[anon] anonymizer: ${e instanceof Error ? e.message : e}`); return; }
    const flavor = requestFlavor(rest);
    const versionBefore = anon.map.version;

    if (body.length) {
      const enc = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
      if (enc !== 'identity') { this.fail(res, 415, 'compressed request bodies are not supported; nothing was sent'); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(body.toString('utf8')); } catch { this.fail(res, 415, 'the request body is not JSON; nothing was sent'); return; }
      // Rewriting is synchronous, so the collector sees only this request's
      // substitutions even though the office's agents share one anonymizer.
      const subs: Array<{ family: string; placeholder: string }> = [];
      anon.onSubstitute = (family, placeholder) => { subs.push({ family, placeholder }); };
      let next: unknown;
      try {
        next = flavor && isObj(parsed)
          ? anon.rewriteRequest(parsed, flavor)
          : mapStrings(parsed, (s) => anon.pseudonymizeText(s));
      } finally { anon.onSubstitute = null; }
      body = Buffer.from(JSON.stringify(next), 'utf8');
      if (subs.length) { try { this.deps.onSubstitutions?.(route.agentId, subs); } catch { /* the counter is best-effort */ } }
    }
    if (anon.map.version !== versionBefore) this.scheduleSave(route.office);

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v;
    headers['accept-encoding'] = 'identity';
    if (body.length || req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') headers['content-length'] = String(body.length);
    headers.host = target.host;

    const isHttps = target.protocol === 'https:';
    let ca: Buffer | undefined;
    if (isHttps && route.tls?.caFile) { try { ca = readFileSync(route.tls.caFile); } catch { /* system CAs */ } }
    const opts: https.RequestOptions = {
      method: req.method,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers,
      ...(isHttps ? { ...(ca ? { ca } : {}), ...(route.tls?.insecure ? { rejectUnauthorized: false } : {}), servername: target.hostname } : {})
    };
    const up = (isHttps ? https : http).request(opts, (ures) => this.relay(ures, res, anon, flavor));
    up.on('error', (e) => { this.deps.log?.(`[anon] upstream ${target.host}: ${e.message}`); this.fail(res, 502, `upstream error (${(e as NodeJS.ErrnoException).code ?? 'network'})`); });
    req.on('close', () => { if (!res.writableEnded) up.destroy(); });
    up.end(body.length ? body : undefined);
  }

  private relay(ures: http.IncomingMessage, res: http.ServerResponse, anon: Anonymizer, flavor: ApiFlavor | null): void {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(ures.headers)) if (v !== undefined && !HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'content-encoding') headers[k] = v;
    const enc = String(ures.headers['content-encoding'] ?? 'identity').toLowerCase();
    let src: NodeJS.ReadableStream = ures;
    if (enc === 'gzip' || enc === 'x-gzip') src = ures.pipe(zlib.createGunzip());
    else if (enc === 'deflate') src = ures.pipe(zlib.createInflate());
    else if (enc === 'br') src = ures.pipe(zlib.createBrotliDecompress());
    else if (enc !== 'identity') { ures.resume(); this.fail(res, 502, `unsupported response encoding ${enc}`); return; }
    const type = String(ures.headers['content-type'] ?? '').toLowerCase();
    const status = ures.statusCode ?? 502;

    if (type.includes('text/event-stream')) {
      const restorer = anon.createStreamRestorer();
      res.writeHead(status, headers);
      res.flushHeaders?.();
      src.on('data', (c: Buffer) => { const out = restorer.push(c); if (out) res.write(out); });
      src.on('end', () => { const out = restorer.end(); res.end(out || undefined); });
      src.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
      return;
    }

    const chunks: Buffer[] = [];
    src.on('data', (c: Buffer) => chunks.push(c));
    src.on('error', () => this.fail(res, 502, 'upstream response error'));
    src.on('end', () => {
      let out = Buffer.concat(chunks);
      if (out.length && (type.includes('json') || type.startsWith('text/'))) {
        const text = out.toString('utf8');
        let restored = text;
        if (type.includes('json')) {
          try {
            const parsed = JSON.parse(text);
            const next = flavor && isObj(parsed) ? anon.restoreResponse(parsed, flavor) : mapStrings(parsed, (s) => anon.restoreText(s));
            restored = JSON.stringify(next);
          } catch { restored = anon.restoreText(text); }
        } else restored = anon.restoreText(text);
        if (restored !== text) out = Buffer.from(restored, 'utf8');
      }
      headers['content-length'] = String(out.length);
      res.writeHead(status, headers);
      res.end(out);
    });
  }
}
