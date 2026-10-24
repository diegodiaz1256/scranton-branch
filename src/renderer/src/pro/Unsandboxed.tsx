import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import { confirmsName, unsandboxedAgents } from '@shared/unsandboxed';

/** The red mark of an agent the human let run without its OS sandbox: on its
 *  card and on its page (above its terminal), for as long as it is on. */
export function UnsandboxedBadge({ agentId, config }: { agentId: string; config: HarnessConfig }) {
  const { t } = useTranslation();
  if (!unsandboxedAgents(config.agentUnsandboxed).includes(agentId)) return null;
  return <span className="pro-badge pro-badge-unsandboxed" title={t('pro.unsandboxed.badgeTip')}>{t('pro.unsandboxed.badge')}</span>;
}

/**
 * The warning before "Run without sandbox" goes on: what the agent will be able
 * to do, what still holds, and its name typed back. Main checks the name again
 * (agent:setUnsandboxed) and refuses a custodian.
 */
export function UnsandboxDialog({ name, busy, error, onConfirm, onCancel }: {
  name: string; busy: boolean; error: string | null;
  onConfirm: (typed: string) => void; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const ok = confirmsName(typed, name);
  return (
    <div className="pro-modal-back" role="presentation" onClick={onCancel}>
      <div className="pro-card pro-modal pro-modal-danger" role="alertdialog" aria-modal="true" aria-labelledby="unsandbox-title" aria-describedby="unsandbox-intro"
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
        <strong id="unsandbox-title" style={{ fontSize: 15 }}>⚠ {t('pro.unsandboxed.title', { name })}</strong>
        <span id="unsandbox-intro" className="pro-text" style={{ fontSize: 13 }}>{t('pro.unsandboxed.intro')}</span>
        <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {(['risk1', 'risk2', 'risk3', 'risk4'] as const).map((k) => <li key={k}>{t(`pro.unsandboxed.${k}`)}</li>)}
        </ul>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.unsandboxed.still')}</span>
        <label className="pro-sub" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {t('pro.unsandboxed.typeLabel', { name })}
          <input className="pro-input" autoFocus value={typed} spellCheck={false} autoComplete="off" placeholder={name}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) onConfirm(typed); }} />
        </label>
        {error && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12 }}>{error}</span>}
        <div className="pro-row" style={{ justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <button className="pro-btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button className="pro-btn pro-btn-danger" disabled={!ok || busy} onClick={() => onConfirm(typed)}>{t('pro.unsandboxed.confirm')}</button>
        </div>
      </div>
    </div>
  );
}
