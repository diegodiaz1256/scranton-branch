/**
 * The hive's commands (<hive>/bin/sb-api.cjs, sb-run, sb-browse, sb-skills,
 * sb-lists, and a custodian's sb-netgate) were named md-* under the fork's old
 * name. Each one is written under both names, byte for byte, so agents that are
 * already running, saved prompts and user scripts that call md-api keep working.
 * Prompts and docs teach only the sb-* names.
 */
import { basename, dirname, join } from 'node:path';

export const TOOL_PREFIX = 'sb-';
export const LEGACY_TOOL_PREFIX = 'md-';
/** The commands that carry both names. */
export const TOOL_NAMES = ['api', 'run', 'browse', 'skills', 'lists', 'netgate'] as const;

/** The other name of a hive command file (sb-x.cjs ↔ md-x.cjs), or null when
 *  the file is not one of them. */
export function toolAlias(file: string): string | null {
  const m = /^(sb|md)-([a-z]+)\.cjs$/.exec(basename(file));
  if (!m || !(TOOL_NAMES as readonly string[]).includes(m[2])) return null;
  const other = (m[1] === 'sb' ? LEGACY_TOOL_PREFIX : TOOL_PREFIX) + m[2] + '.cjs';
  return join(dirname(file), other);
}

/** [path, content] pairs plus, for each hive command, the same content under
 *  its other name. Order is kept; the sb-* file comes first. */
export function withToolAliases(files: Array<[string, string]>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [p, c] of files) {
    const alias = toolAlias(p);
    if (!alias) { out.push([p, c]); continue; }
    const sbFirst = basename(p).startsWith(TOOL_PREFIX) ? [p, alias] : [alias, p];
    for (const f of sbFirst) out.push([f, c]);
  }
  return out;
}
