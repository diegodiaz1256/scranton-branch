import { useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from './store';
import {
  INITIAL_AUTO_STATE, countRecentStalls, decideAutoLevel, effectiveOfficeLevel, parseOfficeRenderSetting,
  type AutoState, type OfficeRenderLevel, type OfficeRenderSetting
} from '@shared/officeRenderLevel';

/**
 * The office floor's render level (src/shared/officeRenderLevel.ts): the
 * user's choice, what Auto picked, and whether the many-agents suggestion was
 * waved off. A window preference rather than a HarnessConfig key, like the
 * layout in pro/proStore.ts: agents never read it, so it stays out of the
 * config contract that main, preload and renderer mirror by hand.
 */
const LS_SETTING = 'cth.officeRenderLevel';
const LS_HINT = 'cth.officeRenderHintDismissed';

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* the choice lasts this session */ }
}

interface OfficeRenderState {
  setting: OfficeRenderSetting;
  autoLevel: OfficeRenderLevel;
  hintDismissed: boolean;
  setSetting: (s: OfficeRenderSetting) => void;
  setAutoLevel: (l: OfficeRenderLevel) => void;
  dismissHint: () => void;
}

export const useOfficeRender = create<OfficeRenderState>((set) => ({
  setting: parseOfficeRenderSetting(read(LS_SETTING)),
  autoLevel: 'full',
  hintDismissed: read(LS_HINT) === '1',
  setSetting: (setting) => { write(LS_SETTING, setting); set({ setting }); },
  setAutoLevel: (autoLevel) => set({ autoLevel }),
  dismissHint: () => { write(LS_HINT, '1'); set({ hintDismissed: true }); }
}));

/** The level the floor draws at right now. */
export function useOfficeLevel(): OfficeRenderLevel {
  return useOfficeRender((s) => effectiveOfficeLevel(s.setting, s.autoLevel));
}

/** How often Auto re-reads the freeze log, and re-decides (for the calm timer). */
const FREEZE_POLL_MS = 15_000;
const DECIDE_MS = 5_000;

/**
 * Drives Auto while it is the chosen setting: watches the battery (where the
 * platform reports one), the freeze log and the number of agents on the floor,
 * and feeds them to decideAutoLevel. Mount once; idle otherwise.
 */
export function useAutoOfficeLevel(): void {
  const auto = useOfficeRender((s) => s.setting === 'auto');
  useEffect(() => {
    if (!auto) return;
    let alive = true;
    // Freezes from before Auto was switched on (start-up, an earlier session)
    // say nothing about how the floor is doing now.
    const since = Date.now();
    let state: AutoState = { ...INITIAL_AUTO_STATE, level: useOfficeRender.getState().autoLevel };
    let onBattery = false;
    let stalls = 0;

    const decide = (): void => {
      if (!alive) return;
      const agentCount = useStore.getState().agents.length;
      state = decideAutoLevel(state, { onBattery, recentStalls: stalls, agentCount }, Date.now());
      if (useOfficeRender.getState().autoLevel !== state.level) useOfficeRender.getState().setAutoLevel(state.level);
    };

    let battery: { charging: boolean; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void } | null = null;
    const onCharging = (): void => { onBattery = !!battery && !battery.charging; decide(); };
    const nav = navigator as Navigator & { getBattery?: () => Promise<NonNullable<typeof battery>> };
    nav.getBattery?.().then((b) => {
      if (!alive) return;
      battery = b;
      b.addEventListener('chargingchange', onCharging);
      onCharging();
    }).catch(() => { /* no battery API: treat as plugged in */ });

    const pollFreezes = (): void => {
      void window.cth.freezes?.().then((entries) => {
        stalls = countRecentStalls(entries ?? [], Date.now(), since);
        decide();
      }).catch(() => { /* keep the last count */ });
    };
    pollFreezes();
    const freezeTimer = setInterval(pollFreezes, FREEZE_POLL_MS);
    const decideTimer = setInterval(decide, DECIDE_MS);
    const unsub = useStore.subscribe((s, prev) => { if (s.agents.length !== prev.agents.length) decide(); });
    decide();

    return () => {
      alive = false;
      clearInterval(freezeTimer);
      clearInterval(decideTimer);
      unsub();
      battery?.removeEventListener('chargingchange', onCharging);
    };
  }, [auto]);
}
