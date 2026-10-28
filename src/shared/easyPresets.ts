/**
 * Easy-mode presets: "Careful", "Balanced" and "Autonomous". Each one is a
 * named set of values for settings that already exist. A preset adds no new
 * behaviour of its own.
 *
 * A preset only touches these settings:
 *   - autoMode: agents act without asking first, or ask before acting
 *   - orchestratorMaySpawn: whether the orchestrator may hire on its own
 *   - circuitBreaker.hardStop / tokenVelocityPerMin: what the runaway breaker
 *     does when it trips, and how fast spending may run. The breaker itself
 *     stays ON in every preset.
 *   - usageWindowAlerts: how early agents are told the subscription is nearly spent
 *
 * It never touches the human-only safety switches: running without the sandbox,
 * Docker, SSH or cloud logins, critical-connection sign-off, or per-agent grants.
 * It also leaves the floor token budget (costCapTokens) alone. That figure counts
 * cache reads, so a fixed number chosen here could trip within minutes of a busy
 * session (#189). The budget stays whatever the user typed.
 *
 * Pure (no Electron, no React): the Settings modal and the tests share it.
 */

import { DEFAULT_USAGE_ALERT_THRESHOLDS, normalizeThresholds, type UsageAlertThresholds } from './usageWindowAlerts';

export type EasyPreset = 'careful' | 'balanced' | 'autonomous';
export const EASY_PRESETS: readonly EasyPreset[] = ['careful', 'balanced', 'autonomous'];

/** The breaker's own default velocity ceiling (src/main/breaker.ts DEFAULTS). */
export const DEFAULT_VELOCITY_PER_MIN = 60_000;

/** The part of the config a preset reads and writes. */
export interface PresetView {
  autoMode?: boolean;
  orchestratorMaySpawn?: boolean;
  circuitBreaker?: {
    enabled?: boolean;
    hardStop?: boolean;
    tokenVelocityPerMin?: number;
    repeatedToolLimit?: number;
    errorStormLimit?: number;
  };
  usageWindowAlerts?: Partial<UsageAlertThresholds> | null;
}

interface PresetValues {
  autoMode: boolean;
  orchestratorMaySpawn: boolean;
  hardStop: boolean;
  /** undefined = the breaker's default ceiling. */
  tokenVelocityPerMin: number | undefined;
  usageWindowAlerts: UsageAlertThresholds;
}

const VALUES: Record<EasyPreset, PresetValues> = {
  // Agents ask before acting, only you hire, the breaker stops a runaway outright,
  // spending may run at half the usual speed, and warnings come early.
  careful: {
    autoMode: false,
    orchestratorMaySpawn: false,
    hardStop: true,
    tokenVelocityPerMin: 30_000,
    usageWindowAlerts: { fiveHourPct: 80, weeklyPct: 90 }
  },
  // The app's defaults: agents work on their own inside the sandbox, only you hire,
  // the breaker steers before it stops.
  balanced: {
    autoMode: true,
    orchestratorMaySpawn: false,
    hardStop: false,
    tokenVelocityPerMin: undefined,
    usageWindowAlerts: { ...DEFAULT_USAGE_ALERT_THRESHOLDS }
  },
  // Like Balanced, and the orchestrator may also hire helpers by himself.
  autonomous: {
    autoMode: true,
    orchestratorMaySpawn: true,
    hardStop: false,
    tokenVelocityPerMin: undefined,
    usageWindowAlerts: { ...DEFAULT_USAGE_ALERT_THRESHOLDS }
  }
};

/** The config keys a preset is allowed to write. Anything else stays the user's. */
export const PRESET_KEYS = ['autoMode', 'orchestratorMaySpawn', 'circuitBreaker', 'usageWindowAlerts'] as const;

/** The patch that applies a preset. Other breaker fields (repeat and error limits)
 *  are carried over from `current`, and the breaker is always left enabled. */
export function presetPatch(preset: EasyPreset, current: PresetView = {}): Required<Pick<PresetView, 'autoMode' | 'orchestratorMaySpawn' | 'circuitBreaker'>> & { usageWindowAlerts: UsageAlertThresholds } {
  const v = VALUES[preset];
  return {
    autoMode: v.autoMode,
    orchestratorMaySpawn: v.orchestratorMaySpawn,
    circuitBreaker: {
      ...(current.circuitBreaker ?? {}),
      enabled: true,
      hardStop: v.hardStop,
      tokenVelocityPerMin: v.tokenVelocityPerMin
    },
    usageWindowAlerts: { ...v.usageWindowAlerts }
  };
}

/** What the settings effectively are, with each default filled in. */
function effective(c: PresetView) {
  const th = normalizeThresholds(c.usageWindowAlerts ?? undefined);
  return {
    autoMode: c.autoMode !== false,
    orchestratorMaySpawn: c.orchestratorMaySpawn === true,
    breakerOn: c.circuitBreaker?.enabled !== false,
    hardStop: c.circuitBreaker?.hardStop === true,
    velocity: c.circuitBreaker?.tokenVelocityPerMin ?? DEFAULT_VELOCITY_PER_MIN,
    fiveHourPct: th.fiveHourPct,
    weeklyPct: th.weeklyPct
  };
}

/** Which preset the settings match, or 'custom' when they were changed one by one
 *  (in Advanced) and match none of them. */
export function detectPreset(c: PresetView): EasyPreset | 'custom' {
  const now = effective(c);
  for (const p of EASY_PRESETS) {
    const want = effective(presetPatch(p, c));
    if ((Object.keys(want) as (keyof typeof want)[]).every((k) => want[k] === now[k])) return p;
  }
  return 'custom';
}

/** One line per thing a preset sets, as i18n key suffixes under
 *  `settings.presets.change.*`, so the UI can say exactly what it changes. */
export function presetChanges(preset: EasyPreset): string[] {
  const v = VALUES[preset];
  return [
    v.autoMode ? 'autoOn' : 'autoOff',
    v.orchestratorMaySpawn ? 'hireBoth' : 'hireYou',
    v.hardStop ? 'breakerStop' : 'breakerSteer',
    v.tokenVelocityPerMin ? 'velocitySlow' : 'velocityDefault',
    v.usageWindowAlerts.fiveHourPct < DEFAULT_USAGE_ALERT_THRESHOLDS.fiveHourPct ? 'warnEarly' : 'warnDefault'
  ];
}
