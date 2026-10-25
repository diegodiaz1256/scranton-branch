import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import { cleanCriticalMap, custodianships } from '@shared/criticalConnections';
import { cleanSshRelayMap, type SshRelayGrant } from '@shared/sshRelay';

type KeyRow = Awaited<ReturnType<typeof window.cth.sshRelayKeys>>['keys'][number];
type AuditRow = Awaited<ReturnType<typeof window.cth.sshRelayAudit>>[number];

/**
 * "Use my SSH keys through the office" for one agent (shared/sshRelay.ts):
 * off by default; on, its git over SSH is run by the app outside its sandbox,
 * with the keys chosen here, optionally asking first. Below, what it did.
 * Main checks everything again (custodians, the floor) on every use.
 */
export function SshRelaySection({ agent, config }: { agent: Agent; config: HarnessConfig }) {
  const { t } = useTranslation();
  const all = cleanSshRelayMap(config.agentSshRelay);
  const grant = all[agent.id];
  const on = !!grant;
  const custodian = custodianships(cleanCriticalMap(config.criticalCustodians), agent.id).length > 0;
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [available, setAvailable] = useState(true);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void window.cth.sshRelayKeys().then((r) => { if (alive) { setAvailable(r.available); setKeys(r.keys); } }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const loadAudit = useCallback(() => { void window.cth.sshRelayAudit(agent.id).then(setAudit).catch(() => {}); }, [agent.id]);
  useEffect(() => { loadAudit(); }, [loadAudit]);

  const save = async (next: SshRelayGrant | null) => {
    setBusy(true); setError(null);
    try {
      const r = await window.cth.sshRelaySet(agent.id, next);
      if (!r.ok) setError(r.error ?? t('integrations.couldNotSave'));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const switchOn = async () => {
    if (!(await window.cth.confirm(t('pro.caps.ssh.confirm', { name: agent.name }), { detail: t('pro.caps.ssh.warning'), ok: t('pro.caps.ssh.turnOn') }))) return;
    void save({});
  };
  const flipKey = (fp: string) => {
    const cur = grant?.keys ?? [];
    const keysNext = cur.includes(fp) ? cur.filter((k) => k !== fp) : [...cur, fp];
    void save({ ...grant, keys: keysNext.length ? keysNext : undefined });
  };
  const flipSign = async (next: boolean) => {
    if (next && !(await window.cth.confirm(t('pro.caps.ssh.signConfirm', { name: agent.name }), { detail: t('pro.caps.ssh.signWarning'), ok: t('pro.caps.ssh.turnOn') }))) return;
    void save({ ...grant, sign: next || undefined });
  };
  const why = !available ? t('pro.caps.ssh.unavailable') : custodian ? t('pro.caps.ssh.custodian') : null;

  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="pro-row" style={{ gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{t('pro.caps.ssh.title', { name: agent.name })}</strong>
        <div className="pro-switch" role="radiogroup" aria-label={t('pro.caps.ssh.title', { name: agent.name })} style={{ marginInlineStart: 'auto' }}>
          <button role="radio" aria-checked={!on} aria-pressed={!on} disabled={busy} onClick={() => { if (on) void save(null); }}>{t('pro.caps.ssh.off')}</button>
          <button role="radio" aria-checked={on} aria-pressed={on} disabled={busy || (!!why && !on)} onClick={() => { if (!on) void switchOn(); }}>{t('pro.caps.ssh.on')}</button>
        </div>
      </div>
      <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.ssh.body')}</span>
      <span className="pro-text" style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{t('pro.caps.ssh.warning')}</span>
      {why && <span className="pro-sub" style={{ fontSize: 12 }}>{why}</span>}
      {on && (
        <>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.ssh.keys')}</span>
          {keys.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.ssh.noKeys')}</span>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {keys.map((k) => {
              const picked = (grant?.keys ?? []).includes(k.fingerprint);
              return (
                <button key={k.fingerprint} aria-pressed={picked} disabled={busy}
                  className={`pro-chip${picked ? ' pro-chip-on' : ' pro-chip-off'}`} style={{ cursor: 'pointer' }}
                  title={`${k.fingerprint} · ${k.source === 'agent' ? t('pro.caps.ssh.fromAgent') : t('pro.caps.ssh.fromFile')}`}
                  onClick={() => flipKey(k.fingerprint)}>
                  {picked ? '✓ ' : ''}{k.label} <span className="pro-mono" style={{ fontSize: 11 }}>{k.fingerprint.slice(7, 19)}…</span>
                </button>
              );
            })}
          </div>
          <span className="pro-sub" style={{ fontSize: 11.5 }}>{(grant?.keys ?? []).length ? t('pro.caps.ssh.keysChosen') : t('pro.caps.ssh.keysAny')}</span>
          <label className="pro-sub" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!grant?.ask} disabled={busy} onChange={(e) => void save({ ...grant, ask: e.target.checked || undefined })} />
            {t('pro.caps.ssh.ask')}
          </label>
          <label className="pro-sub" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!grant?.sign} disabled={busy} onChange={(e) => void flipSign(e.target.checked)} />
            {t('pro.caps.ssh.sign')}
          </label>
          <span className="pro-sub" style={{ fontSize: 11.5, paddingInlineStart: 22 }}>{t('pro.caps.ssh.signBody')}</span>
        </>
      )}
      <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) loadAudit(); }}>
        <summary className="pro-sub" style={{ fontSize: 12, cursor: 'pointer' }}>{t('pro.caps.ssh.audit', { count: audit.length })}</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
          {audit.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.ssh.auditEmpty')}</span>}
          {audit.map((a, i) => (
            <div key={`${a.ts}-${i}`} className="pro-row" style={{ gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
              <span className="pro-sub pro-mono" style={{ fontSize: 11 }}>{new Date(a.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <span className={`pro-chip${a.allowed ? ' pro-chip-on' : ' pro-chip-off'}`}>{a.allowed ? t('pro.caps.ssh.allowed') : t('pro.caps.ssh.refused')}</span>
              <span className="pro-mono" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {a.service === 'sign'
                  ? `${a.allowed && a.exit === 0 ? t('pro.caps.ssh.signed') : t('pro.caps.ssh.signRequest')} ${a.subject ?? ''}${a.path ? ` · ${a.path}` : ''}`
                  : `${a.service ?? ''} ${a.host ? `${a.user ? `${a.user}@` : ''}${a.host}:${a.path ?? ''}` : ''}`}
              </span>
              {typeof a.exit === 'number' && <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.caps.ssh.exit', { code: a.exit })}</span>}
              {a.reason && <span className="pro-sub" style={{ fontSize: 11 }}>{a.reason}</span>}
            </div>
          ))}
        </div>
      </details>
      {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
    </section>
  );
}
