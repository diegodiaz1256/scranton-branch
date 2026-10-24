/**
 * How much of the office floor to draw (Settings → General → Office floor).
 *
 *   full  — today's floor: characters walk, take breaks, carry notes.
 *   still — the office is drawn but everyone stays at their desk. State is an
 *           icon over the head, a message is an envelope and a short line between
 *           two desks, and the scene only redraws when something changes.
 *   cards — no office at all: Pixi is never started, one HTML card per agent.
 *   auto  — picks one of the three from the battery, the freeze log and the
 *           number of agents (decideAutoLevel below).
 *
 * Pure, so the decisions are unit-tested without a renderer.
 */

export type OfficeRenderLevel = 'full' | 'still' | 'cards';
export type OfficeRenderSetting = OfficeRenderLevel | 'auto';

export const OFFICE_RENDER_SETTINGS: readonly OfficeRenderSetting[] = ['full', 'still', 'cards', 'auto'];

/** Unknown or missing values (a fresh install, a hand-edited key) mean today's floor. */
export function parseOfficeRenderSetting(raw: unknown): OfficeRenderSetting {
  return typeof raw === 'string' && (OFFICE_RENDER_SETTINGS as readonly string[]).includes(raw)
    ? raw as OfficeRenderSetting
    : 'full';
}

export function effectiveOfficeLevel(setting: OfficeRenderSetting, autoLevel: OfficeRenderLevel): OfficeRenderLevel {
  return setting === 'auto' ? autoLevel : setting;
}

/**
 * "Many agents": above this many on the floor, the full office costs enough that
 * we suggest a lighter level (and Auto takes one). Measured with the demo office:
 * see the PR for the numbers behind it.
 */
export const MANY_AGENTS = 8;
/** Auto only goes back once the floor is down to this many (no flapping at 8/9). */
export const MANY_AGENTS_CLEAR = 6;

/** The non-blocking "try a lighter floor" suggestion. */
export function shouldRecommendLighter(o: { setting: OfficeRenderSetting; agentCount: number; dismissed: boolean }): boolean {
  return !o.dismissed && o.setting === 'full' && o.agentCount > MANY_AGENTS;
}

// ─── Auto ────────────────────────────────────────────────────────────────────

/** Freezes counted over this window. */
export const STALL_WINDOW_MS = 5 * 60_000;
/** One freeze in the window → no walking; this many → no office. */
export const STALLS_FOR_CARDS = 3;
/** Going back to a heavier level waits until things have been calm this long. */
export const RECOVER_AFTER_MS = 60_000;

export interface AutoSignals {
  /** Running on battery (false when unknown, or on a desktop with no battery). */
  onBattery: boolean;
  /** Freezes in the last STALL_WINDOW_MS (countRecentStalls). */
  recentStalls: number;
  agentCount: number;
}

export interface AutoState {
  level: OfficeRenderLevel;
  /** The many-agents condition, with its own hysteresis (MANY_AGENTS / MANY_AGENTS_CLEAR). */
  manyAgents: boolean;
  /** Since when the signals have allowed a heavier level than `level`; null while they don't. */
  calmSince: number | null;
}

export const INITIAL_AUTO_STATE: AutoState = { level: 'full', manyAgents: false, calmSince: null };

const RANK: Record<OfficeRenderLevel, number> = { full: 0, still: 1, cards: 2 };

/** The level the signals ask for right now, before hysteresis. */
export function autoTarget(s: AutoSignals, manyAgents: boolean): OfficeRenderLevel {
  if (s.recentStalls >= STALLS_FOR_CARDS) return 'cards';
  if (s.onBattery && manyAgents) return 'cards';
  if (s.onBattery || manyAgents || s.recentStalls > 0) return 'still';
  return 'full';
}

/**
 * One Auto step. Lighter levels apply at once (the app is struggling now);
 * heavier ones only after the signals have stayed calm for RECOVER_AFTER_MS, so
 * a laptop plugged in for a second or a single freeze does not make the floor
 * flicker between levels.
 */
export function decideAutoLevel(prev: AutoState, s: AutoSignals, now: number): AutoState {
  const manyAgents = prev.manyAgents ? s.agentCount > MANY_AGENTS_CLEAR : s.agentCount > MANY_AGENTS;
  const target = autoTarget(s, manyAgents);
  if (RANK[target] >= RANK[prev.level]) {
    return { level: target, manyAgents, calmSince: null };
  }
  const calmSince = prev.calmSince ?? now;
  if (now - calmSince >= RECOVER_AFTER_MS) return { level: target, manyAgents, calmSince: null };
  return { level: prev.level, manyAgents, calmSince };
}

/**
 * Freezes from the freeze log (newest first or any order) inside the window.
 * `notBefore` drops the ones from before this window opened: a start-up stall
 * (or one from yesterday's session) says nothing about the floor now.
 */
export function countRecentStalls(entries: ReadonlyArray<{ at: string }>, now: number, notBefore = 0): number {
  const from = Math.max(now - STALL_WINDOW_MS, notBefore);
  let n = 0;
  for (const e of entries) {
    const t = Date.parse(e.at);
    if (Number.isFinite(t) && t >= from && t <= now) n++;
  }
  return n;
}

// ─── No walking: the icon over each head ─────────────────────────────────────

export type StillGlyph = 'none' | 'typing' | 'waiting' | 'asking' | 'stuck' | 'compacting' | 'success';

/** Agent status → the icon a seated avatar wears when nobody walks. */
export function stillGlyphFor(status: string): StillGlyph {
  switch (status) {
    case 'working':
    case 'thinking':
      return 'typing';
    case 'waiting':
      return 'waiting';
    case 'blocked':
      return 'asking';
    case 'looping':
      return 'stuck';
    case 'compacting':
      return 'compacting';
    case 'success':
      return 'success';
    default:
      return 'none';
  }
}
