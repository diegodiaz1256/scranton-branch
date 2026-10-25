/**
 * One place that fetches over https.
 *
 * Extracted from skills.ts when the hero payload needed the same thing: two
 * copies of redirect-following, timeout and status handling would drift, and the
 * one that drifted would be the one nobody was looking at.
 *
 * https only, by construction — every caller fetches from raw.githubusercontent
 * or a repo URL, and an http: fallback would silently downgrade content the app
 * then renders. A redirect may not leave https either.
 *
 * Bounded three ways: a deadline for the whole fetch (redirects included, so a
 * server that dribbles bytes cannot hold it open), at most MAX_REDIRECTS hops,
 * and at most `maxBytes` of body.
 */
import { request as httpsRequest } from 'node:https';
import { createWriteStream } from 'node:fs';

const MAX_REDIRECTS = 5;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface FetchOpts { timeoutMs?: number; maxBytes?: number }

/** Thrown when a body passes `maxBytes`. `size` is the real size when the
 *  server announced it (Content-Length), so the caller can say how big it is. */
export class TooLargeError extends Error {
  constructor(readonly limit: number, readonly size?: number) {
    super('response too large');
  }
}

/**
 * The shared walk: follow redirects, check the status and the size, and hand
 * each body chunk to `onChunk`. `onChunk` may return false to ask for a pause
 * (a slow disk); `resume` then continues the body.
 */
function fetchBody(
  url: string,
  opts: FetchOpts,
  onChunk: (c: Buffer, resume: () => void) => boolean,
  onEnd: () => void,
  onError: (e: Error) => void
): void {
  const timeoutMs = opts.timeoutMs ?? 12000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let settled = false;
  let current: ReturnType<typeof httpsRequest> | null = null;
  const finish = (err: Error | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (err) { current?.destroy(); onError(err); } else onEnd();
  };
  const deadline = setTimeout(() => finish(new Error('timed out')), timeoutMs);

  const get = (target: string, hops: number) => {
    let u: URL;
    try { u = new URL(target); } catch { finish(new Error(`invalid URL: ${target}`)); return; }
    if (u.protocol !== 'https:') { finish(new Error(`refusing a non-https URL: ${u.protocol}`)); return; }
    const req = httpsRequest(u, { method: 'GET', headers: { 'user-agent': 'scranton-branch' } }, (res) => {
      const status = res.statusCode ?? 0;
      // raw.githubusercontent redirects branch aliases; follow, relative or not.
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) { finish(new Error('too many redirects')); return; }
        get(new URL(res.headers.location, u).href, hops + 1);
        return;
      }
      if (status !== 200) { res.resume(); finish(new Error(`HTTP ${status}`)); return; }
      const announced = Number(res.headers['content-length'] ?? 0);
      if (announced > maxBytes) { finish(new TooLargeError(maxBytes, announced)); return; }
      let size = 0;
      res.on('data', (c: Buffer) => {
        if (settled) return;
        size += c.length;
        if (size > maxBytes) { finish(new TooLargeError(maxBytes)); return; }
        if (!onChunk(c, () => res.resume())) res.pause();
      });
      res.on('end', () => finish(null));
      res.on('error', (e) => finish(e));
    });
    current = req;
    req.on('error', (e) => finish(e));
    req.end();
  };
  get(url, 0);
}

/** The body as raw bytes: what a skill's images, fonts or templates need. */
export function getBytes(url: string, opts: FetchOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    fetchBody(url, opts, (c) => { chunks.push(c); return true; }, () => resolve(Buffer.concat(chunks)), reject);
  });
}

export function getText(url: string, opts: FetchOpts = {}): Promise<string> {
  return getBytes(url, opts).then((b) => b.toString('utf8'));
}

/** Stream the body into `file` instead of memory (a repository archive), with
 *  the same bounds. Resolves with the number of bytes written. */
export function downloadToFile(url: string, file: string, opts: FetchOpts = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file);
    let written = 0;
    let failed = false;
    out.on('error', (e) => { failed = true; reject(e); });
    fetchBody(
      url,
      opts,
      (c, resume) => {
        written += c.length;
        const ok = out.write(c);
        if (!ok) out.once('drain', resume);
        return ok;
      },
      () => out.end(() => { if (!failed) resolve(written); }),
      (e) => { out.destroy(); reject(e); }
    );
  });
}
