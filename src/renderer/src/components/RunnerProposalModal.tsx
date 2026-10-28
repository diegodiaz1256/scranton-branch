import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RunnerProposalView } from '../../../preload';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import './RunnerProposalModal.css';

type Kind = 'secret' | 'op';

/**
 * An agent asks for a runner (`sb-run --propose`): a command that runs with
 * secrets the agent never sees. The human reads the exact command, why, and
 * which secrets it uses, and can create the ones that do not exist yet right
 * here (a value or a 1Password reference), stored encrypted by the app.
 * The code the command runs (script files, package.json scripts) is shown
 * too, and "Explain" asks an agent for a plain-language reading of it; that
 * only informs, approving still takes the human's click.
 * Mounted once for both layouts; proposals queue and show one at a time.
 */
export function RunnerProposalModal() {
  const { t, i18n } = useTranslation();
  const [queue, setQueue] = useState<RunnerProposalView[]>([]);
  const [values, setValues] = useState<Record<string, { kind: Kind; value: string }>>({});
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState<{ state: 'idle' | 'loading' | 'done' | 'error'; text?: string; error?: string }>({ state: 'idle' });

  useEffect(() => {
    const add = (r: RunnerProposalView) => setQueue((q) => (q.some((x) => x.id === r.id) ? q : [...q, r]));
    void window.cth.envProposalsPending().then((list) => list.forEach(add)).catch(() => {});
    return window.cth.onEnvProposal(add);
  }, []);

  const cur = queue[0];
  const curId = useRef<string | undefined>(undefined);
  curId.current = cur?.id;
  useEffect(() => { setValues({}); setExplain({ state: 'idle' }); }, [cur?.id]);
  if (!cur) return null;

  const missing = new Set(cur.missing);
  const ready = cur.missing.every((m) => (values[m]?.value ?? '').trim() && (values[m]?.kind !== 'op' || /^op:\/\/.+\/.+\/.+/.test(values[m].value.trim())));
  const answer = async (ok: boolean) => {
    setBusy(true);
    try { await window.cth.envProposalAnswer(cur.id, ok ? { ok, secrets: values } : { ok }); }
    finally { setBusy(false); setQueue((q) => q.slice(1)); }
  };
  const askExplain = async () => {
    const id = cur.id;
    setExplain({ state: 'loading' });
    let r: { ok: boolean; text?: string; error?: string };
    try { r = await window.cth.envProposalExplain(id, i18n.language); }
    catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    // The window may have moved on to the next proposal meanwhile.
    if (curId.current === id) setExplain(r.ok && r.text ? { state: 'done', text: r.text } : { state: 'error', error: r.error });
  };
  const explainError = (e?: string) =>
    e === 'needsClaude' ? t('proposal.explainNeedsClaude') : e === 'gone' ? t('proposal.explainGone') : t('proposal.explainFailed', { error: e ?? '?' });
  const files = cur.files ?? [];
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
          <div className="rp-label">{t('proposal.code')}</div>
          {files.length === 0 && <p className="rp-muted">{t('proposal.codeNone')}</p>}
          {files.map((f, i) => (
            <div key={`${f.path}#${f.script ?? ''}#${i}`} className="rp-file">
              <div className="rp-file-head">
                <code className="rp-name">{f.path}</code>
                {f.script && <span className="rp-muted">{t('proposal.codeScript', { name: f.script })}</span>}
              </div>
              {f.content !== undefined
                ? <pre className="rp-code" tabIndex={0} aria-label={f.path}>{f.content}</pre>
                : <p className="rp-muted">{t(`proposal.codeError_${f.error ?? 'unreadable'}`)}</p>}
              {f.truncated && <p className="rp-muted">{t('proposal.codeTruncated')}</p>}
            </div>
          ))}
          {files.length > 0 && <p className="rp-muted">{t('proposal.codeSnapshot')}</p>}
        </div>
        <div className="rp-explain">
          {explain.state !== 'done' && (
            <button type="button" className="rp-btn" disabled={explain.state === 'loading'} onClick={() => void askExplain()}>
              {explain.state === 'loading' ? t('proposal.explaining') : t('proposal.explain')}
            </button>
          )}
          {explain.state === 'error' && <p className="rp-muted" role="alert">{explainError(explain.error)}</p>}
          {explain.state === 'done' && explain.text && (
            <div className="rp-explanation" aria-live="polite">
              <div className="rp-label">{t('proposal.explanation')}</div>
              <MarkdownPreview source={explain.text} variant="card" />
              <p className="rp-muted">{t('proposal.explainNote')}</p>
            </div>
          )}
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
