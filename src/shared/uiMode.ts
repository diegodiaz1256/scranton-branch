/**
 * Easy mode vs Full mode: how much of the app is on show.
 *
 * Easy mode keeps the screens a non-technical user needs every day in view and
 * folds everything else under "Advanced". Nothing is removed: every page and
 * every setting stays one click away. Full mode is the app as it always was.
 *
 * Pure on purpose (no Electron, no React) so main, renderer and tests share it.
 */

export type UiMode = 'easy' | 'full';

/** The config fields the mode is resolved from. */
export interface UiModeConfig {
  uiMode?: UiMode | string | null;
  audience?: 'technical' | 'non-technical' | string | null;
}

/** The chosen mode, else a default from the onboarding answer: someone who said
 *  they are not technical starts in Easy mode, everyone else (and anyone who
 *  has not answered yet) in Full mode, so existing installs look unchanged. */
export function resolveUiMode(cfg: UiModeConfig | null | undefined): UiMode {
  if (cfg?.uiMode === 'easy' || cfg?.uiMode === 'full') return cfg.uiMode;
  return cfg?.audience === 'non-technical' ? 'easy' : 'full';
}

export function isEasyMode(cfg: UiModeConfig | null | undefined): boolean {
  return resolveUiMode(cfg) === 'easy';
}

/**
 * Sidebar pages Easy mode keeps in view (the Pro shell's section ids).
 *  - thread: the conversation with the orchestrator, readable (the first page).
 *  - now: what the office is doing, in sentences.
 *  - tasks: the jobs and who owns them; questions waiting on you live here.
 *  - inbox: the conversations, including the chat with the orchestrator.
 *  - deliverables: what the agents produced.
 * The agent list (your team) stays too; it is not a nav group item.
 */
export const EASY_NAV_ESSENTIALS = ['thread', 'now', 'tasks', 'inbox', 'deliverables'] as const;

/** The page Easy mode opens on. */
export const EASY_HOME = 'thread' as const;

/**
 * The layout to switch to at start, or null to leave it: Easy mode lands in
 * the Manager layout (where its sidebar and thread live) as long as no layout
 * was ever chosen on this machine (stored = the saved choice, null if none).
 * An explicit choice, Classic included, always stands.
 */
export function landingLayout(stored: string | null | undefined, cfg: UiModeConfig | null | undefined): 'pro' | null {
  if (stored === 'classic' || stored === 'pro') return null;
  return isEasyMode(cfg) ? 'pro' : null;
}

/** Settings sections Easy mode keeps in view; the rest fold under "Advanced settings". */
export const EASY_SETTINGS_ESSENTIALS = ['General', 'Autonomy & Budgets'] as const;

/** Split a list into what Easy mode shows and what it folds under Advanced,
 *  keeping the original order in both and losing nothing. */
export function splitForEasyMode<T extends string>(all: readonly T[], essentials: readonly string[]): { essential: T[]; advanced: T[] } {
  const keep = new Set(essentials);
  return {
    essential: all.filter((x) => keep.has(x)),
    advanced: all.filter((x) => !keep.has(x))
  };
}
