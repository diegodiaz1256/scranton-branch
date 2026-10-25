/**
 * The cloud and developer CLIs' logins under the human's home (gh, aws, az,
 * gcloud, kubectl, docker, npm, pip, netrc, git's credential store): hidden
 * from every sandboxed agent by default, like ~/.ssh, and exposed per agent
 * only when the human ticks them in Capabilities (Cloud credentials).
 *
 * Hidden where the agent's OS sandbox runs: Claude Code's (denyRead and Read/
 * Edit deny rules, hive.ts hookSettings) and the app's bubblewrap for pi and
 * agy (bwrapSandbox.ts). A Windows floor has no OS sandbox to hide them with.
 *
 * Paths are relative to the agent's home, with `/`. Pure: no electron, no node.
 */

export interface CloudCredentialSet {
  id: string;
  /** The CLI it belongs to (a product name: not translated). */
  label: string;
  /** Folders under $HOME. */
  dirs: readonly string[];
  /** Single files under $HOME. */
  files: readonly string[];
}

export const CLOUD_CREDENTIALS: readonly CloudCredentialSet[] = [
  { id: 'gh', label: 'GitHub CLI (gh)', dirs: ['.config/gh'], files: [] },
  { id: 'aws', label: 'AWS CLI', dirs: ['.aws'], files: [] },
  { id: 'azure', label: 'Azure CLI (az)', dirs: ['.azure'], files: [] },
  { id: 'gcloud', label: 'Google Cloud (gcloud)', dirs: ['.config/gcloud'], files: [] },
  { id: 'kube', label: 'Kubernetes (kubectl)', dirs: ['.kube'], files: [] },
  { id: 'docker', label: 'Docker', dirs: ['.docker'], files: [] },
  { id: 'npm', label: 'npm', dirs: [], files: ['.npmrc'] },
  { id: 'pypi', label: 'PyPI (pip, twine)', dirs: [], files: ['.pypirc'] },
  { id: 'netrc', label: 'netrc', dirs: [], files: ['.netrc'] },
  { id: 'git', label: 'Git credential store', dirs: [], files: ['.git-credentials', '.config/git/credentials'] }
];

export const CLOUD_CREDENTIAL_IDS: readonly string[] = CLOUD_CREDENTIALS.map((s) => s.id);

/** Agent id → the sets it may read. Absent or empty → none. */
export type CloudCredentialMap = Record<string, string[]>;

/** One agent's choice, cleaned: known ids, once each, in catalog order. */
export function cleanCloudCredentialIds(raw: unknown): string[] {
  const want = new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  return CLOUD_CREDENTIAL_IDS.filter((id) => want.has(id));
}

/** The map from config, cleaned: agents with nothing exposed are dropped. */
export function cleanCloudCredentialMap(raw: unknown): CloudCredentialMap {
  const out: CloudCredentialMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [agentId, ids] of Object.entries(raw as Record<string, unknown>)) {
    const clean = cleanCloudCredentialIds(ids);
    if (agentId && clean.length) out[agentId] = clean;
  }
  return out;
}

/** What stays hidden from an agent that may read `exposed` (relative paths). */
export function hiddenCredentialPaths(exposed: readonly string[] = []): { dirs: string[]; files: string[] } {
  const open = new Set(exposed);
  const hidden = CLOUD_CREDENTIALS.filter((s) => !open.has(s.id));
  return { dirs: hidden.flatMap((s) => s.dirs), files: hidden.flatMap((s) => s.files) };
}

/**
 * The agent's own line about it, so a `gh` that says "not logged in" is not
 * a puzzle to work around: what is hidden, that it is on purpose, and who can
 * change it. Empty when nothing is hidden.
 */
export function credentialPromptLine(exposed: readonly string[] = []): string {
  const open = new Set(exposed);
  const hidden = CLOUD_CREDENTIALS.filter((s) => !open.has(s.id));
  if (!hidden.length) return '';
  const where = (s: CloudCredentialSet): string => [...s.dirs, ...s.files].map((p) => `~/${p}`).join(', ');
  const allowed = CLOUD_CREDENTIALS.filter((s) => open.has(s.id));
  return [
    `CREDENTIALS: the human's cloud and developer CLI logins are hidden from you on purpose (like ~/.ssh): ${hidden.map((s) => `${s.label} (${where(s)})`).join('; ')}.`,
    'A command that needs one fails as if logged out (gh "not logged in", aws "Unable to locate credentials", a private HTTPS git remote asking for a username). Do not retry it, search for the files or a token elsewhere, or ask other agents for them.',
    'Say which login the task needs and stop that step: the human can allow it for you in Manager → Capabilities → your row → Cloud credentials (it applies when you are restarted). Public HTTPS remotes still work, and git over SSH goes through the office when the human allows it.',
    allowed.length ? `Allowed for you: ${allowed.map((s) => s.label).join(', ')}.` : ''
  ].filter(Boolean).join(' ');
}
