/**
 * Moving in from "Munder Difflin" (this fork's old name).
 *
 * Until 0.4.6-fork.6 the fork installed as "Munder Difflin" — the same app id,
 * data folder and keychain entry as the upstream app, so the two collided. It is
 * now "Scranton Branch". On the first launch under the new name:
 *
 *  1. migrateLegacyData() (at import, before anything reads userData) copies
 *     the old data folder — settings, roster, Team, Connections keys, history —
 *     into the new one. Browser caches are left behind. The old folder is not
 *     touched, so the old app keeps working until it is removed.
 *     Windows: encrypted keys carry over (their key is in the copied
 *     "Local State", protected by the user's Windows login). macOS / Linux: the
 *     key lives in the keychain under the old app name, so stored keys and the
 *     Team identity have to be entered / paired again — the app says so.
 *
 *  2. offerLegacyUninstall() (once the window is up) finds an installed OLD
 *     FORK — a "Munder Difflin" whose version carries "-fork." — and offers to
 *     remove it. Upstream's own Munder Difflin is never touched.
 *
 * Must be imported right after demo.ts in index.ts.
 */
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DEMO_HOME } from './demo';
import { appEnv } from '../shared/envName';

// The old builds named the data folder after package.json's "name"
// (`munder-difflin`); `Munder Difflin` covers a build that set productName.
const OLD_NAMES = ['Munder Difflin', 'munder-difflin'];
const MARKER = 'migrated-from.json';
/** Chromium's disposable state: caches, locks, crash dumps. */
const SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache',
  'GrShaderCache', 'Crashpad', 'blob_storage', 'Shared Dictionary', 'SingletonLock', 'SingletonCookie',
  'SingletonSocket', 'lockfile', 'Service Worker'
]);

export interface MigrationResult { from: string; at: string; keysMayNeedReentry: boolean }

let result: MigrationResult | null = null;
export function legacyMigration(): MigrationResult | null { return result; }

function migrateLegacyData(): void {
  if (DEMO_HOME || appEnv('SERVER') === '1') return;
  const target = app.getPath('userData');
  if (existsSync(join(target, 'config.json')) || existsSync(join(target, MARKER))) return;
  const appData = app.getPath('appData');
  const from = OLD_NAMES.map((n) => join(appData, n)).find((d) => d !== target && existsSync(join(d, 'config.json')));
  if (!from) return;
  try {
    cpSync(from, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: (src) => !SKIP.has(basename(src))
    });
    result = { from, at: new Date().toISOString(), keysMayNeedReentry: process.platform !== 'win32' };
    writeFileSync(join(target, MARKER), JSON.stringify(result, null, 2));
    console.log(`[migration] copied settings and data from ${from}`);
  } catch (e) {
    console.error('[migration] could not copy the old data folder:', e);
  }
}

migrateLegacyData();

// ─── the old install ─────────────────────────────────────────────────────────

interface LegacyInstall { version: string; remove: () => Promise<void>; where: string }

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 15_000 }, (_e, out) => resolve(String(out ?? ''))));

async function findWindows(): Promise<LegacyInstall | null> {
  for (const hive of ['HKCU', 'HKLM']) {
    const out = await run('reg', ['query', `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'Munder Difflin', '/d']);
    // Each block: a key line, then "    Name    REG_SZ    value" lines.
    for (const block of out.split(/\r?\n(?=HKEY_)/)) {
      const val = (name: string): string | undefined =>
        block.match(new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm'))?.[1]?.trim();
      const display = val('DisplayName') ?? '';
      const version = val('DisplayVersion') ?? '';
      const uninstall = val('QuietUninstallString') ?? val('UninstallString');
      if (!display.startsWith('Munder Difflin') || !/-fork\./.test(version) || !uninstall) continue;
      return {
        version,
        where: display,
        remove: () => new Promise((resolve) => {
          // electron-builder's uninstaller: /S silent, keeps the old data
          // folder (we copied it already; it is left as a fallback).
          const cmd = /\s\/S\b/.test(uninstall) ? uninstall : `${uninstall} /S`;
          const child = spawn(cmd, { shell: true, detached: true, windowsHide: true, stdio: 'ignore' });
          child.on('exit', () => resolve());
          child.on('error', () => resolve());
        })
      };
    }
  }
  return null;
}

async function findMac(): Promise<LegacyInstall | null> {
  for (const dir of ['/Applications', join(app.getPath('home'), 'Applications')]) {
    const bundle = join(dir, 'Munder Difflin.app');
    const plist = join(bundle, 'Contents', 'Info.plist');
    if (!existsSync(plist)) continue;
    const version = readFileSync(plist, 'utf8').match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? '';
    if (!/-fork\./.test(version)) continue;
    return { version, where: bundle, remove: () => shell.trashItem(bundle) };
  }
  return null;
}

async function findLegacyInstall(): Promise<LegacyInstall | null> {
  if (process.platform === 'win32') return findWindows();
  if (process.platform === 'darwin') return findMac();
  return null; // AppImages live wherever their owner put them
}

/** Offer, once per launch until answered, to remove the old fork install. */
export async function offerLegacyUninstall(win: BrowserWindow | null, opts: { ask: (key: string) => unknown; remember: (key: string, v: unknown) => void }): Promise<void> {
  if (DEMO_HOME || !app.isPackaged || opts.ask('legacy.uninstall.answered')) return;
  const old = await findLegacyInstall().catch(() => null);
  if (!old) return;
  const keysLine = result?.keysMayNeedReentry
    ? '\n\nOn this system the old app’s stored keys are locked to its old name: re-enter Connection keys, and pair Team again, in this app.'
    : '';
  const box = {
    type: 'question' as const,
    buttons: ['Remove the old app', 'Keep it', 'Keep it, don’t ask again'],
    defaultId: 0,
    cancelId: 1,
    title: 'Scranton Branch',
    message: `This fork is now called Scranton Branch. The old “Munder Difflin ${old.version}” is still installed.`,
    detail: `Your settings, offices and history were copied here. Removing the old app leaves its data folder in place as a backup.${keysLine}`
  };
  const { response } = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
  if (response === 2) { opts.remember('legacy.uninstall.answered', 'keep'); return; }
  if (response !== 0) return;
  try {
    await old.remove();
    opts.remember('legacy.uninstall.answered', 'removed');
    console.log(`[migration] removed the old install (${old.where})`);
  } catch (e) {
    console.error('[migration] could not remove the old install:', e);
    await dialog.showMessageBox({ type: 'warning', message: 'The old app could not be removed automatically.', detail: `Remove “${old.where}” yourself.` });
  }
}
