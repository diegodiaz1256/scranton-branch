import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import { cleanCriticalMap, custodianships } from '@shared/criticalConnections';
import { CLOUD_CREDENTIALS, cleanCloudCredentialMap } from '@shared/cloudCredentials';

/**
 * "Cloud credentials" for one agent (shared/cloudCredentials.ts): the cloud
 * and developer CLIs' logins under your home are hidden from every sandboxed
 * agent; ticking one lets this agent read it, from its next start. Main
 * checks again (custodians) and logs every change to the hive.
 */
export function CloudCredentialsSection({ agent, config }: { agent: Agent; config: HarnessConfig }) {
  const { t } = useTranslation();
  const exposed = cleanCloudCredentialMap(config.agentCloudCredentials)[agent.id] ?? [];
  const custodian = custodianships(cleanCriticalMap(config.criticalCustodians), agent.id).length > 0;
  const [available, setAvailable] = useState(true);
  const [present, setPresent] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.cth.cloudCredsStatus().then((r) => { if (alive) { setAvailable(r.available); setPresent(r.present); } }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const flip = async (id: string) => {
    const on = exposed.includes(id);
    if (!on && !(await window.cth.confirm(t('pro.caps.creds.confirm', { name: agent.name, cli: CLOUD_CREDENTIALS.find((s) => s.id === id)?.label ?? id }), { detail: t('pro.caps.creds.warning'), ok: t('pro.caps.creds.allow') }))) return;
    setBusy(true); setError(null);
    try {
      const r = await window.cth.cloudCredsSet(agent.id, on ? exposed.filter((x) => x !== id) : [...exposed, id]);
      if (!r.ok) setError(r.error ?? t('integrations.couldNotSave'));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const why = !available ? t('pro.caps.creds.unavailable') : custodian ? t('pro.caps.creds.custodian') : null;

  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong style={{ fontSize: 14 }}>{t('pro.caps.creds.title', { name: agent.name })}</strong>
      <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.creds.body')}</span>
      <span className="pro-text" style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{t('pro.caps.creds.warning')}</span>
      {why && <span className="pro-sub" style={{ fontSize: 12 }}>{why}</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {CLOUD_CREDENTIALS.map((s) => {
          const on = exposed.includes(s.id);
          return (
            <label key={s.id} className="pro-sub" style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, cursor: why && !on ? 'default' : 'pointer', flexWrap: 'wrap' }}>
              <input type="checkbox" checked={on} disabled={busy || (!!why && !on)} onChange={() => void flip(s.id)} />
              <span>{s.label}</span>
              <span className="pro-mono" style={{ fontSize: 11 }}>{[...s.dirs, ...s.files].map((p) => `~/${p}`).join(', ')}</span>
              {available && !present.includes(s.id) && <span style={{ fontSize: 11 }}>{t('pro.caps.creds.notFound')}</span>}
            </label>
          );
        })}
      </div>
      <span className="pro-sub" style={{ fontSize: 11.5 }}>{exposed.length ? t('pro.caps.creds.restart') : t('pro.caps.creds.none')}</span>
      {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
    </section>
  );
}
