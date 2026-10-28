import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import { cleanCriticalMap, custodianships } from '@shared/criticalConnections';
import { cleanDockerMap } from '@shared/agentDocker';

/**
 * "Allow Docker" for one agent (shared/agentDocker.ts): the Docker socket is
 * out of every sandboxed agent's reach; on, this agent's sandbox lets it
 * connect, from its next start. Docker is root where agents run, so the
 * switch says so before and after. Main checks again (custodians) and logs
 * every change to the hive.
 */
export function DockerSection({ agent, config }: { agent: Agent; config: HarnessConfig }) {
  const { t } = useTranslation();
  const on = !!cleanDockerMap(config.agentDocker)[agent.id];
  const custodian = custodianships(cleanCriticalMap(config.criticalCustodians), agent.id).length > 0;
  const [available, setAvailable] = useState(true);
  const [present, setPresent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.cth.dockerStatus().then((r) => { if (alive) { setAvailable(r.available); setPresent(r.present); } }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const flip = async () => {
    if (!on && !(await window.cth.confirm(t('pro.caps.docker.confirm', { name: agent.name }), { detail: t('pro.caps.docker.warning'), ok: t('pro.caps.docker.allow') }))) return;
    setBusy(true); setError(null);
    try {
      const r = await window.cth.dockerSet(agent.id, !on);
      if (!r.ok) setError(r.error ?? t('integrations.couldNotSave'));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const why = !available ? t('pro.caps.docker.unavailable') : custodian ? t('pro.caps.docker.custodian') : null;

  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong style={{ fontSize: 14 }}>{t('pro.caps.docker.title', { name: agent.name })}</strong>
      <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.docker.body')}</span>
      <span className="pro-text" style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{t('pro.caps.docker.warning')}</span>
      {why && <span className="pro-sub" style={{ fontSize: 12 }}>{why}</span>}
      <label className="pro-sub" style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 12, cursor: why && !on ? 'default' : 'pointer', flexWrap: 'wrap' }}>
        <input type="checkbox" checked={on} disabled={busy || (!!why && !on)} onChange={() => void flip()} />
        <span>{t('pro.caps.docker.toggle')}</span>
        {available && !present && <span style={{ fontSize: 11 }}>{t('pro.caps.docker.notFound')}</span>}
      </label>
      <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.caps.docker.scope')}</span>
      <span className="pro-sub" style={{ fontSize: 11.5 }}>{on ? t('pro.caps.docker.restart') : t('pro.caps.docker.off')}</span>
      {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
    </section>
  );
}
