/**
 * Licensed art from ZerogeWorkshop's private assets repo, copied into
 * assets/private/ at build time by tools/zw-assets.cjs. Builds without that
 * repo have no such files: callers get null and draw the free art instead.
 */
const urls = import.meta.glob('./private/**/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

/** The bundled URL for a file listed in tools/zw-assets.json (e.g. "atlases/office-floors-16.png"), or null. */
export function privateTileUrl(rel: string): string | null {
  return urls[`./private/${rel}`] ?? null;
}

/** True when this build carries the licensed art. */
export const hasPrivateTiles = Object.keys(urls).length > 0;
