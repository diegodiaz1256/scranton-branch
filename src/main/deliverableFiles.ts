/**
 * Serving a deliverable's files to the Deliverables viewer, so an HTML report
 * renders for real: its stylesheet, images and linked pages load beside it.
 *
 * The page is loaded from `md-dlv://<token>/<path>` inside a sandboxed iframe
 * (no scripts, its own opaque origin, no top navigation): the bytes stream
 * from disk straight to Chromium, so a 7.5 MB proposal never goes through the
 * 2 MB text read, IPC or React. Each token stands for one folder the renderer
 * asked to open (the office's research/ folder, or the folder of a file
 * written elsewhere); nothing outside that folder is served. Works for
 * \\wsl.localhost paths too: it is plain fs.
 *
 * No Electron imports here (main/index.ts wires them), so node:test can run it.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';

export const DELIVERABLE_SCHEME = 'md-dlv';

/**
 * What a served page may do. No script-src or connect-src (default-src 'none'
 * denies them), no form-action, no frame-ancestors beyond the app; styles,
 * images, fonts and media from the same folder, inline, or the web (reports
 * link CDN fonts and pictures). `sandbox` repeats the iframe's own attribute,
 * for a page opened any other way.
 */
export const SERVED_CSP = [
  "default-src 'none'",
  `img-src ${DELIVERABLE_SCHEME}: data: blob: https:`,
  `style-src 'unsafe-inline' ${DELIVERABLE_SCHEME}: https:`,
  `font-src ${DELIVERABLE_SCHEME}: data: https:`,
  `media-src ${DELIVERABLE_SCHEME}: data: https:`,
  "form-action 'none'",
  'sandbox allow-popups allow-popups-to-escape-sandbox'
].join('; ');

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8', xml: 'text/plain; charset=utf-8'
};
/** Never served as something a browser would run: scripts come back as nothing. */
const BLOCKED = new Set(['js', 'mjs', 'cjs', 'wasm']);

const ext = (p: string): string => { const m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1].toLowerCase() : ''; };

/** Is `p` the folder itself or inside it? */
function within(base: string, p: string): boolean {
  const r = relative(base, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r) && !r.split(sep).includes('..'));
}

export class DeliverableFiles {
  private bases = new Map<string, string>();
  private tokens = new Map<string, string>();

  /** The URL to load `file` from, with `base` (a folder holding it) as the
   *  root its relative links resolve in. Null when the file is not in it. */
  urlFor(base: string, file: string): string | null {
    const b = resolve(base);
    const f = resolve(file);
    if (!within(b, f) || f === b) return null;
    const key = process.platform === 'win32' ? b.toLowerCase() : b;
    let token = this.tokens.get(key);
    if (!token) {
      token = randomBytes(12).toString('hex');
      this.tokens.set(key, token);
      this.bases.set(token, b);
    }
    const rel = relative(b, f).split(sep).map(encodeURIComponent).join('/');
    return `${DELIVERABLE_SCHEME}://${token}/${rel}`;
  }

  /** The file a URL names, or null when it is not one this serves. */
  pathOf(url: string): string | null {
    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== `${DELIVERABLE_SCHEME}:`) return null;
    const base = this.bases.get(u.hostname.toLowerCase());
    if (!base) return null;
    let parts: string[];
    try { parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
    if (parts.some((x) => x === '..' || x.includes('/') || x.includes('\\') || x.includes('\0'))) return null;
    const p = resolve(base, ...parts);
    return within(base, p) && p !== base ? p : null;
  }

  /** Answer a request: the file streamed, or 404. */
  async respond(url: string): Promise<Response> {
    const p = this.pathOf(url);
    const notFound = (): Response => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    if (!p || BLOCKED.has(ext(p))) return notFound();
    try {
      const s = await stat(p);
      if (!s.isFile()) return notFound();
      const body = Readable.toWeb(createReadStream(p)) as unknown as ReadableStream;
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME[ext(p)] ?? 'application/octet-stream',
          'Content-Length': String(s.size),
          'Content-Security-Policy': SERVED_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Cache-Control': 'no-cache'
        }
      });
    } catch { return notFound(); }
  }
}
