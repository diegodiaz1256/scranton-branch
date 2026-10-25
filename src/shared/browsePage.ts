/**
 * The office browser (main/browser.ts): agents read pages through the app's
 * own Chromium instead of a plain HTTP client. Many sites answer a bare client
 * (curl, an HTTP library, a fetch tool's user agent) with 403 or an empty
 * shell that only JavaScript fills; a real browser gets the page. It does NOT
 * solve captchas, pass bot challenges or fake a fingerprint: a page that asks
 * for one comes back as it is.
 *
 * Pure helpers here so they can be tested without Electron.
 */

export const BROWSE_DEFAULT_CHARS = 12_000;
export const BROWSE_MAX_CHARS = 100_000;
/** How long a read page stays cached for its next pages. */
export const BROWSE_CACHE_MS = 10 * 60_000;

/** article: the page's main content only (what an agent reads a page for);
 *  full: everything visible, menus and footers included. */
export type BrowseMode = 'article' | 'full';
export function browseMode(raw: unknown): BrowseMode { return raw === 'full' ? 'full' : 'article'; }

/** Why an agent may not open this URL, or null. http(s) only; never the cloud
 *  metadata address (169.254.169.254 and its link-local range). Local dev
 *  servers (localhost) are allowed: checking one's own site is a real use. */
export function browseUrlProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return 'a URL is required';
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'not a valid URL'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https pages can be opened';
  if (u.username || u.password) return 'URLs with credentials are not allowed';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^169\.254\./.test(host) || host === 'metadata.google.internal' || host.startsWith('fe80:')) return 'link-local and cloud metadata addresses are not allowed';
  return null;
}

/** Chromium's user agent without the tokens Electron and the app add, i.e.
 *  what the same Chrome would send. */
export function chromeUserAgent(electronUa: string): string {
  return electronUa
    .replace(/\s(?!Chrome\/|Safari\/|AppleWebKit\/|Mozilla\/)[A-Za-z][\w.-]*\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Characters to return: default, capped. */
export function browseChars(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : BROWSE_DEFAULT_CHARS;
  return Math.max(500, Math.min(BROWSE_MAX_CHARS, n));
}

/** Runs in the page: its title, final URL, readable text and (optionally) links. */
export const EXTRACT_PAGE_SCRIPT = `(() => {
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!/^https?:/.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) links.push({ text: text.slice(0, 120), href });
    if (links.length >= 200) break;
  }
  for (const el of document.querySelectorAll('script, style, noscript, svg, iframe, template')) el.remove();
  const fullText = document.body ? document.body.innerText : '';
  // The main content: a long <article> that holds much of the page (a story,
  // not one of a front page's many teasers), else <main> / [role=main], else
  // the body; each without what surrounds content on most sites (menus,
  // headers, footers, sidebars, ads, dialogs, cookie, consent and share bars).
  // A candidate that cleans down to almost nothing gives way to the next one.
  const textOf = (el) => (el ? (el.innerText || '').trim() : '');
  const mainEl = document.querySelector('main, [role="main"]');
  const mainLen = textOf(mainEl || document.body).length;
  const story = [...document.querySelectorAll('article')]
    .map((el) => ({ el, len: textOf(el).length }))
    .sort((a, b) => b.len - a.len)[0];
  const candidates = [];
  if (story && story.len >= 1500 && story.len >= mainLen * 0.25) candidates.push(story.el);
  if (mainEl) candidates.push(mainEl);
  if (document.body) candidates.push(document.body);
  const noise = 'nav, header, footer, aside, form, button, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [aria-hidden="true"], [hidden]';
  // Consent and paywall layers from the usual providers (Didomi, OneTrust,
  // Sourcepoint, Quantcast, TrustArc, Cookiebot…), whatever their nesting.
  const consent = /didomi|onetrust|sp_message|sp-message|qc-cmp|truste|cookiebot|usercentrics|consentwall|cmp-|-cmp|consent|cookie|gdpr|paywall/i;
  const noisy = /(^|[-_\\s])(ad|ads|advert|advertisement|banner|newsletter|promo|share|social|sponsor|related|comments?|sidebar|subscribe|popup|modal)([-_\\s]|$)/i;
  const clean = (root) => {
    const copy = root.cloneNode(true);
    // A header or footer inside an <article> is the story's own (its headline,
    // byline): only the site's are dropped.
    for (const el of copy.querySelectorAll(noise)) if (!(el.matches('header, footer') && el.closest('article'))) el.remove();
    for (const el of copy.querySelectorAll('[class], [id]')) {
      const tag = (el.getAttribute('class') || '') + ' ' + (el.id || '');
      if (consent.test(tag) || (noisy.test(tag) && (el.innerText || el.textContent || '').length < 2000)) el.remove();
    }
    // innerText needs layout: measure the cleaned copy in an off-screen box.
    copy.style.position = 'absolute'; copy.style.left = '-99999px'; copy.style.width = '1000px';
    document.body.appendChild(copy);
    const t = (copy.innerText || '').trim();
    copy.remove();
    return t;
  };
  let text = fullText;
  for (const root of candidates) {
    const t = clean(root);
    if (t.length > Math.min(500, fullText.trim().length * 0.2)) { text = t; break; }
  }
  return { title: document.title || '', url: location.href, text, fullText, links };
})()`;

/** Runs on DuckDuckGo's HTML results page: title, URL and snippet per result. */
export const EXTRACT_SEARCH_SCRIPT = `(() => {
  const out = [];
  for (const r of document.querySelectorAll('.result')) {
    // Sponsored results: marked as ads, or sent through DuckDuckGo's ad redirect.
    if (r.matches('.result--ad, .result--ad--small') || r.querySelector('.badge--ad')) continue;
    const a = r.querySelector('a.result__a');
    if (!a || a.href.includes('/y.js?')) continue;
    const snippet = r.querySelector('.result__snippet');
    out.push({ title: (a.innerText || '').trim(), href: a.href, snippet: snippet ? snippet.innerText.trim() : '' });
    if (out.length >= 15) break;
  }
  return { results: out, text: out.length ? '' : (document.body ? document.body.innerText.slice(0, 2000) : '') };
})()`;

/** DuckDuckGo wraps result links in its redirect (/l/?uddg=<url>): the real URL. */
export function unwrapSearchHref(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch { return href; }
}

export interface BrowsedPage { title: string; url: string; text: string; fullText?: string; links?: Array<{ text: string; href: string }>; status?: number }

/** Page `n` (1-based) of `text` cut into pieces of about `size` characters,
 *  ending at a paragraph or line break where one is near, so a piece does
 *  not stop mid-sentence. */
export function pageOf(text: string, n: number, size: number): { body: string; page: number; pages: number } {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.6) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.6) cut = size;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  pieces.push(rest);
  const pages = pieces.length;
  const page = Math.max(1, Math.min(pages, Math.floor(n) || 1));
  return { body: pieces[page - 1], page, pages };
}

/**
 * What the agent gets back: a short header, one page of the text, links on
 * request. The text is marked as untrusted web content: it is data from the
 * page, never instructions to follow. The next page comes from the cache.
 */
export function formatBrowsed(p: BrowsedPage, o: { page?: number; size: number; mode: BrowseMode; withLinks: boolean }): string {
  const source = o.mode === 'full' ? (p.fullText ?? p.text) : p.text;
  const text = source.replace(/\n{3,}/g, '\n\n').trim();
  const { body, page, pages } = pageOf(text, o.page ?? 1, o.size);
  const head = [
    `# ${p.title || '(no title)'}`,
    `URL: ${p.url}${p.status && p.status >= 400 ? ` (HTTP ${p.status})` : ''}`,
    `${o.mode === 'article' ? 'Main content' : 'Whole page'} · page ${page} of ${pages}${page < pages ? ` · next: page ${page + 1}` : ''}${o.mode === 'article' && p.fullText ? ' · menus, footers and ads left out (mode "full" for everything)' : ''}`,
    ''
  ];
  const links = o.withLinks && p.links?.length ? ['', '## Links', ...p.links.map((l) => `- [${l.text}](${l.href})`)] : [];
  return [...head, '<untrusted-web-content>', body || '(the page has no readable text)', '</untrusted-web-content>', ...links].join('\n');
}

/** Read pages kept for their next pages: key → page and when it was read. */
export class BrowseCache {
  private entries = new Map<string, { page: BrowsedPage; at: number }>();
  constructor(private readonly ttl = BROWSE_CACHE_MS, private readonly max = 50, private readonly now: () => number = Date.now) {}
  get(url: string): BrowsedPage | undefined {
    const e = this.entries.get(url);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttl) { this.entries.delete(url); return undefined; }
    return e.page;
  }
  set(url: string, page: BrowsedPage): void {
    this.entries.delete(url);
    this.entries.set(url, { page, at: this.now() });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }
}

export function formatSearch(query: string, results: Array<{ title: string; href: string; snippet: string }>, fallbackText: string): string {
  if (!results.length) return `No results parsed for "${query}".${fallbackText ? `\n\n${fallbackText}` : ''}`;
  return [`# Web results for "${query}"`, '', ...results.map((r, i) => `${i + 1}. [${r.title}](${unwrapSearchHref(r.href)})${r.snippet ? `\n   ${r.snippet}` : ''}`)].join('\n');
}

/** Signs that a fetched page is a refusal, not the content: status words, bot
 *  walls, "enable JavaScript" shells. Read from the start of the text only. */
const REFUSAL = /\b(?:40[13]|429|forbidden|access denied|unauthorized|too many requests|just a moment|enable javascript|javascript is (?:disabled|required)|captcha|are you a robot|verify you are human|request blocked|unable to fetch)\b/i;

/**
 * Did this WebFetch fail to get the page? A failed call (PostToolUseFailure),
 * unless the user stopped it; or a "successful" one whose result is a refusal
 * or next to empty. The agent is told about the office browser at that moment,
 * not in its prompt.
 */
export function webFetchFailed(event: string | undefined, error: unknown, response: unknown): boolean {
  if (event === 'PostToolUseFailure') {
    const e = typeof error === 'string' ? error : JSON.stringify(error ?? '');
    return !/interrupt|user (?:rejected|denied|doesn't want)|permission/i.test(e);
  }
  if (event !== 'PostToolUse') return false;
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return text.trim().length < 80 || REFUSAL.test(text.slice(0, 2000));
}

/** What the agent reads right after a failed WebFetch (Claude Code agents). */
export const WEB_FETCH_HINT = 'That page did not load with WebFetch. The office has a browser for this: it opens the page in a real Chromium (JavaScript runs, normal browser headers) and returns its text. Call the munder-browser tool browse_page with the same URL (if it is not loaded yet, load it with ToolSearch "select:mcp__munder-browser__browse_page"), or, where those tools are not available (a sub-agent), run in Bash: node "$HIVE_ROOT/bin/sb-browse.cjs" <url> (add --links for its links; --search "<query>" to search). It does not solve captchas or bot challenges: if the page asks for one, say so.';
