/**
 * Keep the desktop launcher pointing at the AppImage after an update.
 *
 * electron-updater replaces a versioned AppImage (Scranton-Branch-1.1.0-…)
 * with a file of its own versioned name (…-1.1.1-…) and deletes the old one.
 * A launcher in ~/.local/share/applications (written by an AppImage
 * integrator, or by hand) still named the old file, so after the first update
 * the app no longer opened from the menu. The updater emits
 * `appimage-filename-updated` with the new path; at that moment, and at every
 * start, launchers that name a missing Scranton Branch AppImage in the same
 * folder are pointed at the current one.
 *
 * Plain fs, no Electron: tested on its own.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** A Scranton Branch AppImage file name, any version. */
const OUR_APPIMAGE = /^Scranton-Branch-[^/\\]*\.AppImage$/i;

/** Point launchers at `current`. `previous` is the file just replaced (from
 *  the updater's event); without it, any missing Scranton Branch AppImage in
 *  the same folder counts as stale. Returns the launcher files rewritten. */
export function repairLaunchers(applicationsDir: string, current: string, version: string, previous?: string): string[] {
  let files: string[] = [];
  try { files = readdirSync(applicationsDir).filter((f) => f.endsWith('.desktop')); } catch { return []; }
  const dir = dirname(current);
  const stale = (p: string): boolean => {
    if (p === current) return false;
    if (previous && p === previous) return true;
    return dirname(p) === dir && OUR_APPIMAGE.test(basename(p)) && !existsSync(p);
  };
  const changed: string[] = [];
  for (const f of files) {
    const path = join(applicationsDir, f);
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    // Absolute paths ending in .AppImage, quoted or not, in any key.
    const paths = [...new Set([...text.matchAll(/\/[^\s"'=]*\.AppImage/gi)].map((m) => m[0]))];
    const old = paths.filter(stale);
    if (!old.length) continue;
    let next = text;
    for (const p of old) next = next.split(p).join(current);
    next = next.replace(/^X-AppImage-Version=.*$/m, `X-AppImage-Version=${version}`);
    if (next === text) continue;
    try { writeFileSync(path, next, 'utf8'); changed.push(path); } catch { /* not ours to write */ }
  }
  return changed;
}
