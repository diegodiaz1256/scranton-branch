/**
 * "Run without sandbox": a per-agent switch only the human can turn on.
 *
 * Off by default. On, the agent's CLI runs without its OS sandbox (Claude
 * Code's sandbox off; pi without the app's bubblewrap): its shell reaches the
 * whole disk and the network as the user. The guard still keeps the office's
 * control files from it (toolGuard.ts `controls`), and its folder fence stays
 * as set in Capabilities.
 *
 * Only the human sets it, from the app's own dialog (the name typed back as
 * confirmation): the generic config write drops it, so nothing an agent or the
 * orchestrator can reach turns it on. Refused to a critical connection's
 * custodian, and every change goes to the hive's audit log.
 */

import { cleanCriticalMap, isCustodian } from './criticalConnections';

/** The agents the human let run without a sandbox. */
export function unsandboxedAgents(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
}

/** Whether this agent starts without its OS sandbox: on the list, and not a
 *  custodian (a custodian always keeps it, whatever the list says). */
export function runsUnsandboxed(list: unknown, critical: unknown, agentId: string | undefined): boolean {
  if (!agentId || !unsandboxedAgents(list).includes(agentId)) return false;
  return !isCustodian(cleanCriticalMap(critical), agentId);
}

/** The typed confirmation: the agent's name, ignoring case and outer spaces. */
export function confirmsName(typed: unknown, name: string): boolean {
  return typeof typed === 'string' && typed.trim().length > 0 && typed.trim().toLowerCase() === name.trim().toLowerCase();
}

/** Why the switch cannot be turned on for this agent, or null. */
export function unsandboxRefusal(opts: { on: boolean; name: string; typed: unknown; custodian: boolean; known: boolean }): string | null {
  if (!opts.known) return 'unknown agent';
  if (!opts.on) return null;
  if (opts.custodian) return `${opts.name} holds a critical connection: a custodian always runs in its sandbox.`;
  if (!confirmsName(opts.typed, opts.name)) return `Type ${opts.name} to confirm.`;
  return null;
}
