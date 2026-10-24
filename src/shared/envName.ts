/**
 * The app's own environment variables are named SB_* (Scranton Branch). They
 * were MD_* under the fork's old name, and those still work: systemd units,
 * compose files, user scripts and agents started by an older build set them.
 * SB_ wins when both are set; an empty value counts as unset.
 */
export const ENV_PREFIX = 'SB_';
/** The old prefix, still read. */
export const LEGACY_ENV_PREFIX = 'MD_';

type Env = Record<string, string | undefined>;

/** `SB_<name>`, else `MD_<name>`, else undefined. `name` has no prefix. */
export function appEnv(name: string, env: Env = process.env): string | undefined {
  const sb = env[ENV_PREFIX + name];
  if (sb !== undefined && sb !== '') return sb;
  const md = env[LEGACY_ENV_PREFIX + name];
  return md !== undefined && md !== '' ? md : undefined;
}

/** appEnv, then both names removed from `env` (for secrets: no child of this
 *  process may inherit either). */
export function takeAppEnv(name: string, env: Env = process.env): string | undefined {
  const v = appEnv(name, env);
  delete env[ENV_PREFIX + name];
  delete env[LEGACY_ENV_PREFIX + name];
  return v;
}

/** Both names with one value, for variables the app hands to a child: new
 *  tools read SB_*, and an older script in the same session still finds MD_*. */
export function bothEnv(name: string, value: string): Record<string, string> {
  return { [ENV_PREFIX + name]: value, [LEGACY_ENV_PREFIX + name]: value };
}
