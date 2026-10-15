/**
 * Floors: each one is a separate office, run by its own app process.
 *
 * "New Floor" starts this same app again with `--md-floor=<id>`. That process
 * keeps everything it owns under `<userData>/floors/<id>` (config, store,
 * window state, the single-instance lock), so it opens an office of its own
 * next to the first one, with its own orchestrator and agents. An office is run
 * by one process at a time (officeLock.ts).
 *
 * Must be imported right after demo.ts in index.ts: `userData` has to be
 * redirected before anything resolves a path under it, and before the
 * single-instance lock is taken.
 */
import { app } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FLOOR_ARG = '--md-floor=';

/** A floor id from argv, or null. Only short lowercase hex: it becomes a folder name. */
export function floorIdFrom(argv: readonly string[]): string | null {
  const raw = argv.find((a) => a.startsWith(FLOOR_ARG))?.slice(FLOOR_ARG.length) ?? '';
  return /^[0-9a-f]{6,32}$/.test(raw) ? raw : null;
}

/** userData before any floor redirect: where every floor's folder lives. */
export const BASE_USER_DATA = app.getPath('userData');
export const FLOOR_ID = floorIdFrom(process.argv);

if (FLOOR_ID) {
  const dir = join(BASE_USER_DATA, 'floors', FLOOR_ID);
  mkdirSync(dir, { recursive: true });
  alignFloorKey(BASE_USER_DATA, dir, process.platform);
  app.setPath('userData', dir);
}

/**
 * A floor encrypts with the same key as the main profile.
 *
 * On Windows Electron's safeStorage keeps its key in `<userData>/Local State`
 * (`os_crypt`, protected by the Windows login), so a floor, with a userData of
 * its own, got a key of its own: the keys copied into it by seedFloor (Jira,
 * provider keys…) could not be decrypted there and read as missing. Before
 * Chromium reads Local State, the floor takes the main profile's `os_crypt`.
 * The floor's previous one is kept aside (a key typed into the floor before
 * this has to be typed again; the app now says it cannot read it).
 * On macOS and Linux the key comes from the keychain by app name: already shared.
 */
export function alignFloorKey(baseDir: string, floorDir: string, platform: string): boolean {
  if (platform !== 'win32') return false;
  const read = (p: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
  };
  const base = read(join(baseDir, 'Local State'))?.os_crypt as Record<string, unknown> | undefined;
  if (!base || typeof base.encrypted_key !== 'string') return false;
  const path = join(floorDir, 'Local State');
  const state = read(path) ?? {};
  const own = state.os_crypt as Record<string, unknown> | undefined;
  if (own && own.encrypted_key === base.encrypted_key) return false;
  if (own && typeof own.encrypted_key === 'string') state.os_crypt_floor_previous = own;
  state.os_crypt = base;
  try { writeFileSync(path, JSON.stringify(state)); return true; } catch { return false; }
}

/** Settings a new floor must not inherit: the office it would open (or the
 *  demo office), and the
 *  inbound endpoints that belong to one office (a Slack app or webhook port
 *  delivers to exactly one). */
export function floorConfigFrom(parent: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...parent };
  delete next.harnessHome;
  delete next.demoMode; // a floor is a real office of its own, never the seeded demo
  next.slackEnabled = false;
  next.webhookEnabled = false;
  return next;
}

/** Prepare a new floor's folder from the current settings and keys, so it opens
 *  on the office picker instead of first-run setup. Returns its id. */
export function seedFloor(id: string, from: string = app.getPath('userData')): string {
  const dir = join(BASE_USER_DATA, 'floors', id);
  mkdirSync(dir, { recursive: true });
  try {
    const cfg = JSON.parse(readFileSync(join(from, 'config.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(dir, 'config.json'), JSON.stringify(floorConfigFrom(cfg), null, 2));
  } catch { /* no settings yet: the floor starts with first-run setup */ }
  // Encrypted for this OS user, so the copies open in the floor as they are.
  for (const f of ['config-secrets.json', 'integration-secrets.json']) {
    if (existsSync(join(from, f))) { try { copyFileSync(join(from, f), join(dir, f)); } catch { /* best effort */ } }
  }
  return dir;
}

/** argv for a floor process: ours, minus what must not repeat (another floor
 *  id, a debugging port already taken, a deep link already handled). A null
 *  id starts the main profile. */
export function floorArgs(argv: readonly string[], id: string | null): string[] {
  const keep = argv.slice(1).filter((a) => !a.startsWith(FLOOR_ARG) && !a.startsWith('--remote-debugging-port') && !a.startsWith('munderdifflin://'));
  return id ? [...keep, FLOOR_ARG + id] : keep;
}
