/**
 * Easy mode for the Manager's configuration pages: which pages sit where in
 * the Easy sidebar, which few decisions each page shows before "Show all
 * options", and the plain-language status those decisions are described with.
 *
 * Only presentation is decided here. Every page and every setting stays
 * reachable (the full page is one click below the simple one), and the
 * human-only safety switches (running without the sandbox, Docker, SSH keys,
 * cloud logins, critical sign-off) are never changed from the simple view:
 * it only reports them in words and sends the user to the full controls, with
 * their warnings and confirmations.
 *
 * Pure on purpose (no Electron, no React) so the renderer and tests share it.
 */

import { unsandboxedAgents } from './unsandboxed';
import { cleanDockerMap } from './agentDocker';
import { cleanSshRelayMap } from './sshRelay';
import { cleanCloudCredentialMap } from './cloudCredentials';

/** A sidebar group in Easy mode; `label` is `pro.nav.<label>`. */
export interface EasyNavGroup { id: string; label?: string; items: readonly string[]; defaultOpen?: boolean }

/**
 * The Easy sidebar. Above the agent list: the daily pages, then the settings a
 * non-technical owner does touch, in two small groups with plain names (open
 * by default, so they are seen). Below the agent list: "Advanced", folded,
 * with the pages that need technical knowledge to use at all.
 *
 *  - Your office: things the office does by itself or keeps (routines, what
 *    it remembers, know-how it was taught).
 *  - Access: what the agents may reach (apps you connect, what they may do on
 *    this computer, the passwords they may use).
 *  - Advanced: AI engines (model keys, local endpoints), tool servers (MCP),
 *    other offices (peer relays, invites), factories (pipelines), temps.
 */
export const EASY_NAV_GROUPS: readonly EasyNavGroup[] = [
  { id: 'main', items: ['now', 'tasks', 'inbox', 'deliverables'] },
  { id: 'easyOffice', label: 'group_easyOffice', items: ['automations', 'memory', 'skills'], defaultOpen: true },
  { id: 'easyAccess', label: 'group_easyAccess', items: ['connections', 'capabilities', 'environment'], defaultOpen: true }
];
export const EASY_NAV_ADVANCED: EasyNavGroup = {
  id: 'advanced', label: 'group_advanced', items: ['providers', 'mcp', 'team', 'factories', 'temps']
};

/** Every page the Easy sidebar places, in order (each exactly once). */
export function easyNavPlaced(): string[] {
  return [...EASY_NAV_GROUPS.flatMap((g) => g.items), ...EASY_NAV_ADVANCED.items];
}

/**
 * The decisions each configuration page shows in Easy mode before "Show all
 * options" (documentation of the audit, and what the simple views render).
 * An empty list: the page shows its plain explanation and then the full page
 * (expert pages, and pages whose content is the list itself).
 */
export const EASY_PAGE_DECISIONS: Readonly<Record<string, readonly string[]>> = {
  connections: ['status-per-app', 'set-up-an-app'],
  capabilities: ['role-per-agent', 'extra-powers-status'],
  environment: ['saved-passwords-status', 'add-a-password'],
  memory: ['memory-on-off'],
  skills: ['installed-know-how'],
  automations: [],
  providers: [],
  mcp: [],
  team: [],
  factories: [],
  temps: []
};

/** The pages that get a simple view (with decisions) above their full page. */
export function hasSimpleView(page: string): boolean {
  return (EASY_PAGE_DECISIONS[page]?.length ?? 0) > 0;
}

// --- Plain-language status ---------------------------------------------------

export type ConnectionState = 'connected' | 'needsKey' | 'off';

/** One connection in words: switched on and has its key = connected. */
export function connectionState(c: { enabled: boolean; ready: boolean }): ConnectionState {
  if (!c.enabled) return 'off';
  return c.ready ? 'connected' : 'needsKey';
}

/** Connected first, then the ones waiting for a key, then the ones off;
 *  alphabetical inside each. */
export function sortConnections<T extends { enabled: boolean; ready: boolean; label: string }>(list: readonly T[]): T[] {
  const rank: Record<ConnectionState, number> = { connected: 0, needsKey: 1, off: 2 };
  return list.slice().sort((a, b) => rank[connectionState(a)] - rank[connectionState(b)] || a.label.localeCompare(b.label));
}

/** Saved passwords vs plain settings (secret and 1Password values are both
 *  "passwords" to a non-technical user: agents use them, never see them). */
export function secretsSummary(vars: ReadonlyArray<{ kind: 'plain' | 'secret' | 'op' | string }>): { passwords: number; settings: number } {
  const passwords = vars.filter((v) => v.kind === 'secret' || v.kind === 'op').length;
  return { passwords, settings: vars.length - passwords };
}

export type MemoryState = 'checking' | 'on' | 'off' | 'preparing' | 'notInstalled';

/** The office memory in one word. `null` = not known yet. */
export function memoryState(s: { available: boolean; enabled: boolean; active: boolean; modelReady: boolean; downloading: boolean } | null | undefined): MemoryState {
  if (!s) return 'checking';
  if (!s.enabled) return 'off';
  if (!s.available) return 'notInstalled';
  if (s.downloading || !s.modelReady) return 'preparing';
  return s.active ? 'on' : 'preparing';
}

/** The extra powers a human gave one agent, beyond its safe defaults. */
export type AgentPower = 'unsandboxed' | 'docker' | 'sshKeys' | 'cloudLogins' | 'roam';

/** Ordered by risk, highest first. */
export function agentPowers(config: {
  agentUnsandboxed?: unknown; agentDocker?: unknown; agentSshRelay?: unknown; agentCloudCredentials?: unknown; agentRoam?: unknown;
}, agentId: string): AgentPower[] {
  const out: AgentPower[] = [];
  if (unsandboxedAgents(config.agentUnsandboxed).includes(agentId)) out.push('unsandboxed');
  if (cleanDockerMap(config.agentDocker)[agentId]) out.push('docker');
  if (cleanSshRelayMap(config.agentSshRelay)[agentId]) out.push('sshKeys');
  if ((cleanCloudCredentialMap(config.agentCloudCredentials)[agentId] ?? []).length > 0) out.push('cloudLogins');
  if (Array.isArray(config.agentRoam) && config.agentRoam.includes(agentId)) out.push('roam');
  return out;
}

/** The powers that take the agent out of its safety fence (warned in red). */
export function isRiskyPower(p: AgentPower): boolean {
  return p === 'unsandboxed' || p === 'docker';
}

// --- No jargon ---------------------------------------------------------------

/**
 * Words a non-technical user should not meet in the simple views (they may
 * appear in a tooltip that explains them, never in the text itself). Matched
 * as whole words, case-insensitively. The Spanish view uses the same terms.
 */
export const EASY_JARGON: readonly string[] = [
  'MCP', 'PTY', 'bwrap', 'sandbox', 'env var', 'environment variable', 'variable de entorno', 'CLI', 'token', 'tokens',
  'API', 'APIs', 'REST', 'SSH', 'Docker', 'runner', 'runners', 'socket', 'endpoint', 'scope', 'PATH', 'JSON', 'stdio', 'hive'
];

/** The jargon words found in a text (empty = plain). */
export function findJargon(text: string): string[] {
  const found: string[] = [];
  for (const w of EASY_JARGON) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}_])`, 'iu');
    if (re.test(text)) found.push(w);
  }
  return found;
}
