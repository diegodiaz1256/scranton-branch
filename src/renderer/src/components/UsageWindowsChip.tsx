import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { untilReset, usageLevel, type RateLimits, type UsageWindow } from '@shared/rateLimits';
import type { ActiveUsageAlert } from '@shared/usageWindowAlerts';

const colour = { ok: 'var(--cth-ink-500)', warn: 'var(--cth-status-waiting)', high: 'var(--cth-status-blocked)' } as const;

/**
 * The subscription's usage windows in the title bar: "5h 23% · week 40%".
 * On a Claude subscription these, not dollars, are what runs out. Reported by
 * the agents' status line (shared/rateLimits.ts), so it shows once an agent
 * has answered; hidden for API-key users, who have no windows. A window past
 * its warning threshold (Settings → Autonomy) adds a pill: the agents on that
 * account were told to wrap up (main/usageAlerts.ts).
 */
export function UsageWindowsChip(): JSX.Element | null {
  const { t } = useTranslation();
  const [rl, setRl] = useState<RateLimits | null>(null);
  const [alerts, setAlerts] = useState<ActiveUsageAlert[]>([]);
  const [, tick] = useState(0);

  useEffect(() => {
    let live = true;
    void window.cth.rateLimits().then((r) => { if (live && r) setRl(r); }).catch(() => {});
    const off = window.cth.onRateLimits((r) => setRl(r));
    void window.cth.usageAlerts().then((a) => { if (live) setAlerts(a); }).catch(() => {});
    const offAlerts = window.cth.onUsageAlerts((a) => setAlerts(a));
    // Re-render each minute so "resets in" stays true between ticks.
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => { live = false; off(); offAlerts(); clearInterval(id); };
  }, []);

  const now = Date.now();
  // An alert outlives a restart (it is on disk); the windows come with the first tick.
  const shownAlerts = alerts.filter((a) => !(a.resetsAt && a.resetsAt <= now));
  if ((!rl || (!rl.fiveHour && !rl.sevenDay)) && !shownAlerts.length) return null;
  // A window that has reset since the last report is back to 0.
  const shown = (w?: UsageWindow): UsageWindow | undefined =>
    w && w.resetsAt && w.resetsAt <= now ? { pct: 0 } : w;
  const five = shown(rl?.fiveHour);
  const week = shown(rl?.sevenDay);
  const line = (label: string, w?: UsageWindow): string | null =>
    w ? `${label}: ${Math.round(w.pct)}%${w.resetsAt ? ` · ${t('usage.resetsIn', { time: untilReset(w.resetsAt, now) })}` : ''}` : null;
  const title = [
    t('usage.title'),
    line(t('usage.fiveHour'), five),
    line(t('usage.week'), week),
    line(t('usage.weekOpus'), shown(rl?.sevenDayOpus)),
    line(t('usage.weekSonnet'), shown(rl?.sevenDaySonnet)),
    ...shownAlerts.map((a) => t(a.level === 'limit' ? 'usage.alertLimitTip' : 'usage.alertNearTip', {
      window: t(a.window === 'fiveHour' ? 'usage.fiveHour' : 'usage.week'),
      time: a.resetsAt ? untilReset(a.resetsAt, now) : '?'
    }))
  ].filter(Boolean).join('\n');

  const part = (label: string, w?: UsageWindow) => w && (
    <span style={{ color: colour[usageLevel(w.pct)] }}>{label} {Math.round(w.pct)}%</span>
  );
  return (
    <span
      className="cth-titlebar-nodrag"
      title={title}
      aria-label={title}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}
    >
      {part(t('usage.fiveHourShort'), five)}
      {five && week && <span>·</span>}
      {part(t('usage.weekShort'), week)}
      {shownAlerts.map((a) => (
        <span
          key={`${a.provider}-${a.window}`}
          style={{
            fontSize: 11,
            padding: '0 var(--cth-space-1)',
            color: 'var(--cth-ink-900)',
            background: a.level === 'limit' ? 'var(--cth-coral-light)' : 'var(--cth-lemon-light)'
          }}
        >
          {t(a.level === 'limit' ? 'usage.alertLimit' : 'usage.alertNear', {
            window: t(a.window === 'fiveHour' ? 'usage.fiveHourShort' : 'usage.weekShort')
          })}
        </span>
      ))}
    </span>
  );
}
