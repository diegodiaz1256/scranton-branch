import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunnerProposalView } from '../../../preload';
import './RunnerProposalModal.css';

type Kind = 'secret' | 'op';

/**
 * An agent asks for a runner (`sb-run --propose`): a command that runs with
 * secrets the agent never sees. The human reads the exact command, why, and
 * which secrets it uses, and can create the ones that do not exist yet right
 * here (a value or a 1Password reference), stored encrypted by the app.
 * Mounted once for both layouts; proposals queue and show one at a time.
 */
export function RunnerProposalModal() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<RunnerProposalView[]>([]);
  const [values, setValues] = useState<Record<string, { kind: Kind; value: string }>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const add = (r: RunnerProposalView) => setQueue((q) => (q.some((x) => x.id === r.id) ? q : [...q, r]));
    void window.cth.envProposalsPending().then((list) => list.forEach(add)).catch(() => {});
    return window.cth.onEnvProposal(add);
  }, []);

  const cur = queue[0];
  useEffect(() => { setValues({}); }, [cur?.id]);
  if (!cur) return null;

  const missing = new Set(cur.missing);
  const ready = cur.missing.every((m) => (values[m]?.value ?? '').trim() && (values[m]?.kind !== 'op' || /^op:\/\/.+\/.+\/.+/.test(values[m].value.trim())));
  const answer = async (ok: boolean) => {
    setBusy(true);
    try { await window.cth.envProposalAnswer(cur.id, ok ? { ok, secrets: values } : { ok }); }
    finally { setBusy(false); setQueue((q) => q.slice(1)); }
  };
  const set = (name: string, patch: Partial<{ kind: Kind; value: string }>) =>
    setValues((v) => ({ ...v, [name]: { kind: v[name]?.kind ?? 'secret', value: v[name]?.value ?? '', ...patch } }));

  return (
    <div className="rp-back" role="dialog" aria-modal="true" aria-labelledby="rp-title">
      <div className="rp-card">
        <h2 id="rp-title" className="rp-title">{t('proposal.title', { agent: cur.agentName, name: cur.proposal.name })}</h2>
        {cur.proposal.description && <p className="rp-why"><span className="rp-label">{t('proposal.why')}</span> {cur.proposal.description}</p>}
        <div>
          <div className="rp-label">{t('proposal.command')}</div>
          <pre className="rp-command">{cur.proposal.command}</pre>
        </div>
        <div>
          <div className="rp-label">{t('proposal.secrets')}</div>
          {cur.proposal.secrets.length === 0 && <p className="rp-muted">{t('proposal.noSecrets')}</p>}
          <ul className="rp-secrets">
            {cur.proposal.secrets.map((name) => (
              <li key={name}>
                <code className="rp-name">{name}</code>
                {!missing.has(name) ? <span className="rp-ok">{t('proposal.stored')}</span> : (
                  <div className="rp-new">
                    <span className="rp-missing">{t('proposal.missing')}</span>
                    <div className="rp-kind" role="group" aria-label={t('proposal.kind')}>
                      <button type="button" aria-pressed={(values[name]?.kind ?? 'secret') === 'secret'} onClick={() => set(name, { kind: 'secret' })}>{t('proposal.kindSecret')}</button>
                      <button type="button" aria-pressed={values[name]?.kind === 'op'} onClick={() => set(name, { kind: 'op' })}>{t('proposal.kindOp')}</button>
                    </div>
                    <input
                      type={(values[name]?.kind ?? 'secret') === 'secret' ? 'password' : 'text'}
                      className="rp-input" autoComplete="off" spellCheck={false}
                      placeholder={(values[name]?.kind ?? 'secret') === 'secret' ? t('proposal.valuePlaceholder') : 'op://Vault/Item/field'}
                      aria-label={t('proposal.valueFor', { name })}
                      value={values[name]?.value ?? ''}
                      onChange={(e) => set(name, { value: e.target.value })}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
        <p className="rp-muted">{t('proposal.note', { agent: cur.agentName })}</p>
        {cur.missing.length > 0 && <p className="rp-muted">{t('proposal.newSecretsNote')}</p>}
        <div className="rp-actions">
          {queue.length > 1 && <span className="rp-muted">{t('proposal.more', { count: queue.length - 1 })}</span>}
          <button type="button" className="rp-btn" disabled={busy} onClick={() => void answer(false)}>{t('proposal.decline')}</button>
          <button type="button" className="rp-btn rp-primary" disabled={busy || !ready} onClick={() => void answer(true)}>
            {cur.missing.length ? t('proposal.addWithSecrets', { count: cur.missing.length }) : t('proposal.add')}
          </button>
        </div>
      </div>
    </div>
  );
}
