/**
 * Who a message to an ARCHIVED agent was really meant for.
 *
 * A re-hire gets a new id under the same display name, so a long-lived office
 * ends up with one live "Jim - Jira Manager" and a pile of archived ones (seen
 * live: ~20 in one registry.json). An agent that remembered an old id kept
 * mailing it: the mail was filed in a dead inbox, and its sender heard nothing
 * unless the message asked for a reply. These helpers find the live namesake to
 * re-route to, or the live agents to name in the notice when there is no single
 * obvious one. Pure: they read a registry snapshot and nothing else.
 */

/** The registry fields these helpers read. */
export interface NamesakeAgent {
  name?: string;
  archived?: boolean;
  isAssistant?: boolean;
  supersededBy?: string;
}

/** A display name compared loosely: case, spacing and dash style ignored. */
export function normName(name: string | undefined): string {
  return (name ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
}

/** First word of a display name ("Jim - Jira Manager" -> "jim"). */
function firstWord(name: string | undefined): string {
  return normName(name).split(/[\s\-_.,:;/]+/).filter(Boolean)[0] ?? '';
}

/** An agent that can take mail: on the floor, and not the send-only assistant. */
function isLive(a: NamesakeAgent | undefined): boolean {
  return !!a && !a.archived && !a.isAssistant;
}

/** The live agents with exactly the same display name as `id`. */
export function liveNamesakes(agents: Record<string, NamesakeAgent>, id: string): string[] {
  const want = normName(agents[id]?.name);
  if (!want) return [];
  return Object.keys(agents).filter((k) => k !== id && isLive(agents[k]) && normName(agents[k].name) === want).sort();
}

/** Live agents whose name starts with the same word as `id`'s (same name
 *  first), for a notice that has to say who is around instead. */
export function similarLive(agents: Record<string, NamesakeAgent>, id: string, max = 8): string[] {
  const exact = liveNamesakes(agents, id);
  const word = firstWord(agents[id]?.name);
  const rest = word
    ? Object.keys(agents).filter((k) => k !== id && !exact.includes(k) && isLive(agents[k]) && firstWord(agents[k].name) === word).sort()
    : [];
  return [...exact, ...rest].slice(0, max);
}

/** Archived agents that a single live agent of the same name has replaced:
 *  archived id -> live id. An archived agent whose name matches no live agent,
 *  or several, is left out (there is no one obvious successor). */
export function supersededArchived(agents: Record<string, NamesakeAgent>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, a] of Object.entries(agents)) {
    if (!a.archived) continue;
    const live = liveNamesakes(agents, id);
    if (live.length === 1) out[id] = live[0];
  }
  return out;
}
