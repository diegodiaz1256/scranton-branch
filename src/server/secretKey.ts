/**
 * The server's secret-store key — the stand-in for the OS keychain that
 * Electron's safeStorage uses on a desktop.
 *
 * Sources, first found wins:
 *   SB_SECRET_KEY_FILE   a file holding 32 bytes (raw, hex or base64) — a Docker
 *                        or systemd credential (LoadCredential=) is the right home
 *   SB_SECRET_KEY        the same, inline; removed from the environment once read
 *   <data dir>/secret.key   generated on first run, mode 0600
 *
 * Agents must never be able to read it. They run as child processes, so:
 *   - the env var is deleted before any child is spawned, and the key file is
 *     never inside the office;
 *   - on Linux, run agents as another user (SB_AGENT_USER) so neither the key
 *     file nor /proc/<server pid>/environ is readable to them. See
 *     SERVER.md.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeAppEnv } from '../shared/envName';

function parse(raw: Buffer): Buffer | null {
  if (raw.length === 32) return raw;
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  const b = Buffer.from(text, 'base64');
  return b.length === 32 ? b : null;
}

export function loadSecretKey(dataDir: string): Buffer | null {
  // SB_* or the older MD_* name; both are removed so no child inherits either.
  const file = takeAppEnv('SECRET_KEY_FILE');
  if (file) {
    try {
      const k = parse(readFileSync(file));
      if (k) return k;
      console.error('[secrets] SB_SECRET_KEY_FILE is not a 32-byte key; secrets are disabled');
    } catch (e) {
      console.error(`[secrets] cannot read SB_SECRET_KEY_FILE: ${(e as Error).message}; secrets are disabled`);
    }
    return null; // an explicit source that fails must not fall back silently
  }
  const inline = takeAppEnv('SECRET_KEY');
  if (inline) {
    const k = parse(Buffer.from(inline));
    if (k) return k;
    console.error('[secrets] SB_SECRET_KEY is not a 32-byte key; secrets are disabled');
    return null;
  }
  const path = join(dataDir, 'secret.key');
  try {
    if (existsSync(path)) {
      const k = parse(readFileSync(path));
      if (k) return k;
      console.error(`[secrets] ${path} is not a 32-byte key; secrets are disabled`);
      return null;
    }
    const k = randomBytes(32);
    writeFileSync(path, k.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`[secrets] generated ${path} (keep it with your backups; without it stored keys are unreadable)`);
    return k;
  } catch (e) {
    console.error(`[secrets] no usable key: ${(e as Error).message}; secrets are disabled`);
    return null;
  }
}
