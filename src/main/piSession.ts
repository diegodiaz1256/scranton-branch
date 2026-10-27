import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Did pi save session `sid` in this agent's PI_CODING_AGENT_DIR? Its files are
 *  sessions/<folder key>/<time>_<id>.jsonl, written once the model has answered.
 *  Unreadable counts as saved: then pi itself decides, as before. */
export function piSessionSaved(piDir: string, sid: string): boolean {
  if (!/^[0-9A-Za-z-]{6,}$/.test(sid)) return true;
  const root = join(piDir, 'sessions');
  try {
    if (!existsSync(root)) return false;
    return readdirSync(root, { withFileTypes: true }).some((d) => d.isDirectory()
      && readdirSync(join(root, d.name)).some((f) => f.endsWith('.jsonl') && f.includes(sid)));
  } catch { return true; }
}
