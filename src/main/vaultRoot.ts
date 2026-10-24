/**
 * The office's confidential folder (`<office home>/confidential`, see
 * criticalConnections.ts) as a real directory, made before an agent starts.
 *
 * Every agent but a custodian is denied that folder, also when no vault exists
 * yet. Claude Code's sandbox mounts over a denied path, and where the path is
 * missing it leaves an empty read-only FILE there (seen on a WSL floor:
 * `-r--r--r-- … confidential`). Pi's bubblewrap then saw something "exist" at
 * that path and tried to mount an empty folder over a file: it died at launch
 * with `bwrap: Can't mkdir …/confidential: Not a directory`, every time. The
 * first vault made later would have failed the same way (mkdir under a file).
 *
 * Electron-free, for tests.
 */
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';

/**
 * Make `root` a directory (owner-only where the OS has modes). An empty file
 * there is a sandbox's placeholder and is replaced; anything else that is not
 * a directory is left alone (never delete content). Returns whether `root` is
 * a directory afterwards.
 */
export function ensureVaultRoot(root: string): boolean {
  try {
    const st = lstatSync(root);
    if (st.isDirectory()) return true;
    if (!st.isFile() || st.size > 0) return false;
    // Read-only: on a WSL floor the file is reached over \\wsl.localhost,
    // where a read-only file cannot be deleted until it is writable again.
    try { chmodSync(root, 0o600); } catch { /* unlink may still work */ }
    unlinkSync(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return true;
}
