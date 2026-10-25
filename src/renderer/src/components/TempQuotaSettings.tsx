import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { clampTempQuota, MAX_TEMPS_AT_ONCE, TEMP_QUOTA_MAX, tempsAtOnce } from '@shared/agentTemps';
import { clonableAgents } from './TempAnswerOptions';

const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-700)', textTransform: 'uppercase'
};
const inputStyle: CSSProperties = {
  padding: '6px 8px 4px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 13, color: 'var(--cth-ink-900)', outline: 'none'
};

/**
 * Settings → Autonomy & limits → Temps: the office's "Max temps at once"
 * (every temp counts, whoever started it) and each lasting agent's "Temps per
 * agent" (0-4, default 0 = it may not start any). Staged like the rest of the
 * tab and written by the footer Save. A custodian is not listed: it never
 * starts temps.
 */
export function TempQuotaSettings({ config, stage }: { config: HarnessConfig; stage: (patch: Partial<HarnessConfig>) => void }) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [atOnce, setAtOnce] = useState<string>(String(tempsAtOnce(config.maxConcurrentWorkers)));
  const [quota, setQuota] = useState<Record<string, number>>(config.agentTempQuota ?? {});
  const lasting = clonableAgents(agents, config.criticalCustodians);

  const changeAtOnce = (v: string): void => {
    setAtOnce(v);
    const n = Number(v);
    if (v.trim() && Number.isFinite(n)) stage({ maxConcurrentWorkers: tempsAtOnce(n) });
  };
  const changeQuota = (id: string, v: string): void => {
    const next = { ...quota, [id]: clampTempQuota(Number(v)) };
    if (!next[id]) delete next[id];
    setQuota(next);
    stage({ agentTempQuota: next });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{t('tempQuota.desc')}</span>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, ...labelStyle }}>
        {t('tempQuota.atOnce')}
        <input type="number" min="1" max={MAX_TEMPS_AT_ONCE} step="1" value={atOnce}
          onChange={(e) => changeAtOnce(e.target.value)} style={{ ...inputStyle, width: 140 }} />
        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', textTransform: 'none', fontFamily: 'var(--cth-font-ui)' }}>{t('tempQuota.atOnceDesc')}</span>
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={labelStyle}>{t('tempQuota.perAgent')}</span>
        {lasting.length === 0 && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('tempQuota.noAgents')}</span>}
        {lasting.map((a) => (
          <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
            <select aria-label={t('tempQuota.perAgentFor', { name: a.name })} value={String(quota[a.id] ?? 0)}
              onChange={(e) => changeQuota(a.id, e.target.value)} style={{ ...inputStyle, width: 120 }}>
              {Array.from({ length: TEMP_QUOTA_MAX + 1 }, (_, n) => (
                <option key={n} value={n}>{n === 0 ? t('tempQuota.off') : t('tempQuota.n', { count: n })}</option>
              ))}
            </select>
          </div>
        ))}
        <span style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>{t('tempQuota.perAgentDesc')}</span>
      </div>
    </div>
  );
}
