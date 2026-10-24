/**
 * Demo mode (`npm run demo`, see tools/demo.cjs).
 *
 * When SB_DEMO_HOME (or the older MD_DEMO_HOME) is set, the whole app runs out of that folder instead of the
 * user's real profile: config.json, the SQLite store, trigger history, the
 * renderer's localStorage and the single-instance lock all live under
 * `<SB_DEMO_HOME>/userData`. The demo office (harnessHome) is seeded beside it,
 * so a demo run can neither read nor write the real office, and it can run next
 * to a normal instance.
 *
 * Must be the FIRST import in index.ts: `userData` has to be redirected before
 * anything resolves a path under it, and before the single-instance lock is taken.
 */
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appEnv } from '../shared/envName';

const raw = appEnv('DEMO_HOME')?.trim();

/** The demo root, or null outside demo mode. */
export const DEMO_HOME: string | null = raw ? resolve(raw) : null;

if (DEMO_HOME) {
  const userData = join(DEMO_HOME, 'userData');
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
}
