import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { AnonCategory, TermCategory } from '@shared/anonymize';
import type { AnonSuggestion } from '@shared/anonSuggest';
import type { AnonAgentActivity } from '@shared/anonActivity';
import type { AnonAgentStatus, AnonDictionaryEntry } from '@shared/anonSettings';
import { StateBadge, type Tone } from './data';

/** "Dictionary term · System" / "Email". */
export function categoryLabel(t: TFunction, category: AnonCategory, term?: TermCategory): string {
  return term ? `${t('pro.privacy.cat_term')} · ${t(`pro.privacy.tcat_${term}`)}` : t(`pro.privacy.cat_${category}`);
}

const fmtTime = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Suggestions found locally (Jira/Confluence through your connections, git
 * remotes, your email domains, config files, tickets on tasks). Ticked terms
 * and prefixes go into the dictionary editor (then Save); a ticked .env
 * secret is read and stored by main, its value never shown.
 */
export function SuggestionsCard({ onAdd, onSecretCount }: { onAdd: (terms: AnonDictionaryEntry[], prefixes: string[]) => void; onSecretCount: (n: number) => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<AnonSuggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, { category?: TermCategory; as?: string }>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const find = async () => {
    setBusy(true); setError(null);
    try {
      const r = await window.cth.anonSuggest();
      setList(r.suggestions);
      setNotes(r.notes);
      // Terms and prefixes start ticked; secrets only when the human ticks them.
      setPicked(new Set(r.suggestions.filter((s) => s.kind !== 'envSecret').map((s) => s.id)));
      setEdits({});
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const flip = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const add = async () => {
    if (!list) return;
    const chosen = list.filter((s) => picked.has(s.id));
    const terms = chosen.flatMap((s) => (s.kind === 'term' ? [{ ...s.entry, ...(edits[s.id]?.category ? { category: edits[s.id].category } : {}), ...(edits[s.id]?.as !== undefined ? { as: edits[s.id].as } : {}) }] : []));
    const prefixes = chosen.flatMap((s) => (s.kind === 'ticketPrefix' ? [s.prefix] : []));
    const secrets = chosen.filter((s): s is Extract<AnonSuggestion, { kind: 'envSecret' }> => s.kind === 'envSecret');
    if (secrets.length && !(await window.cth.confirm(t('pro.privacy.sugSecretsConfirm', { count: secrets.length }), { detail: secrets.map((s) => `${s.file}: ${s.name}`).join('\n'), ok: t('pro.privacy.addSecret') }))) return;
    setBusy(true); setError(null);
    try {
      for (const s of secrets) {
        const r = await window.cth.anonAcceptEnvSecret(s.file, s.name);
        if (!r.ok) setError(r.error ?? t('integrations.couldNotSave'));
        else if (typeof r.secretCount === 'number') onSecretCount(r.secretCount);
      }
      onAdd(terms, prefixes);
      setList((l) => (l ? l.filter((s) => !picked.has(s.id)) : l));
      setPicked(new Set());
    } finally { setBusy(false); }
  };

  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong style={{ fontSize: 14 }}>{t('pro.privacy.suggestions')}</strong>
      <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.suggestionsBody')}</span>
      <div className="pro-row" style={{ gap: 8 }}>
        <button className="pro-btn" disabled={busy} onClick={() => void find()}>{t(list ? 'pro.privacy.findAgain' : 'pro.privacy.find')}</button>
        {list && list.length > 0 && <button className="pro-btn pro-btn-primary" disabled={busy || !picked.size} onClick={() => void add()}>{t('pro.privacy.addSelected', { count: picked.size })}</button>}
      </div>
      {list && list.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.noSuggestions')}</span>}
      {list && list.map((s) => (
        <label key={s.id} className="pro-row pro-sub" style={{ gap: 6, fontSize: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="checkbox" checked={picked.has(s.id)} onChange={() => flip(s.id)} />
          {s.kind === 'term' && (
            <>
              <span className="pro-mono" style={{ fontWeight: 600 }}>{s.entry.term}</span>
              {s.entry.aliases?.length ? <span style={{ fontSize: 11 }}>({s.entry.aliases.join(', ')})</span> : null}
              <span>→</span>
              {s.entry.category === 'domain'
                ? <span>{t('pro.privacy.tcat_domain')}</span>
                : (
                  <>
                    <select className="pro-input" aria-label={t('pro.privacy.category')} value={edits[s.id]?.category ?? s.entry.category ?? 'other'} onChange={(e) => setEdits((x) => ({ ...x, [s.id]: { ...x[s.id], category: e.target.value as TermCategory } }))}>
                      {(['person', 'company', 'customer', 'system', 'project', 'team', 'product', 'process-step', 'other'] as TermCategory[]).map((c) => <option key={c} value={c}>{t(`pro.privacy.tcat_${c}`)}</option>)}
                    </select>
                    <input className="pro-input" aria-label={t('pro.privacy.codename')} style={{ width: 150 }} value={edits[s.id]?.as ?? s.entry.as ?? ''} onChange={(e) => setEdits((x) => ({ ...x, [s.id]: { ...x[s.id], as: e.target.value } }))} />
                  </>
                )}
            </>
          )}
          {s.kind === 'ticketPrefix' && <span>{t('pro.privacy.sugPrefix')} <span className="pro-mono" style={{ fontWeight: 600 }}>{s.prefix}-…</span></span>}
          {s.kind === 'envSecret' && <span>{t('pro.privacy.sugEnvSecret')} <span className="pro-mono" style={{ fontWeight: 600 }}>{s.name}</span></span>}
          <span style={{ fontSize: 11 }}>{t(`pro.privacy.src_${s.source}`)}: {s.from}</span>
        </label>
      ))}
      {notes.length > 0 && <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.privacy.sugNotes', { notes: notes.join('; ') })}</span>}
      {error && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12 }}>{error}</span>}
    </section>
  );
}

/** Paste text, see what the model would get. Uses a copy of the office's map. */
export function PreviewCard() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [out, setOut] = useState<{ output: string; subs: Array<{ codename: string; category: AnonCategory; term?: TermCategory }> } | null>(null);
  const run = async () => { setOut(await window.cth.anonPreview(text)); };
  const distinct = out ? [...new Map(out.subs.map((s) => [s.codename, s])).values()] : [];
  const box = { flex: '1 1 260px', minHeight: 140, fontSize: 12, whiteSpace: 'pre-wrap' as const, overflowWrap: 'anywhere' as const };
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong style={{ fontSize: 14 }}>{t('pro.privacy.preview')}</strong>
      <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.previewBody')}</span>
      <div className="pro-row" style={{ gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <textarea className="pro-input pro-mono" style={box} placeholder={t('pro.privacy.previewPh')} aria-label={t('pro.privacy.previewIn')} value={text} onChange={(e) => { setText(e.target.value); setOut(null); }} />
        <div className="pro-input pro-mono" style={{ ...box, background: 'var(--cth-paper-100)' }} aria-label={t('pro.privacy.previewOut')}>{out ? out.output : <span className="pro-sub">{t('pro.privacy.previewEmpty')}</span>}</div>
      </div>
      <div className="pro-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="pro-btn" disabled={!text} onClick={() => void run()}>{t('pro.privacy.previewRun')}</button>
        {out && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.previewCount', { count: out.subs.length })}</span>}
        {distinct.map((s) => <span key={s.codename} className="pro-chip pro-mono" style={{ fontSize: 11 }}>{s.codename} · {categoryLabel(t, s.category, s.term)}</span>)}
      </div>
    </section>
  );
}

const STATUS_TONE: Record<AnonAgentStatus, Tone> = { on: 'green', local: 'blue', off: 'grey', 'not-covered': 'amber' };

/** The agent panel's anonymization: status at its last start, counter and log (codenames only). */
export function AnonAgentCard({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<{ status: AnonAgentStatus; reason?: string } | null>(null);
  const [act, setAct] = useState<AnonAgentActivity | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      void window.cth.anonGet().then((s) => { if (alive) setStatus(s.statuses[agentId] ?? null); }).catch(() => {});
      void window.cth.anonActivity(agentId).then((a) => { if (alive) setAct(a); }).catch(() => {});
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(h); };
  }, [agentId]);
  if (!status && !act?.total) return null;
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="pro-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 13 }}>{t('pro.privacy.agentCard')}</strong>
        {status && <StateBadge label={t(`pro.privacy.status_${status.status}`)} tone={STATUS_TONE[status.status]} />}
        {status?.reason && <span className="pro-sub" style={{ fontSize: 11.5 }}>{t(`pro.privacy.reason_${status.reason}`)}</span>}
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.counter', { count: act?.total ?? 0, requests: act?.requests ?? 0 })}</span>
        {act && act.rows.length > 0 && <button className="pro-btn" onClick={() => setOpen((o) => !o)}>{t(open ? 'pro.privacy.hideLog' : 'pro.privacy.showLog')}</button>}
      </div>
      {open && act && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
          {act.rows.map((r) => (
            <div key={r.codename} className="pro-row pro-sub" style={{ gap: 8, fontSize: 11.5 }}>
              <span className="pro-mono" style={{ minWidth: 70 }}>{fmtTime(r.lastAt)}</span>
              <span className="pro-mono" style={{ fontWeight: 600, minWidth: 140 }}>{r.codename}</span>
              <span style={{ flex: 1 }}>{categoryLabel(t, r.category, r.term)}</span>
              <span className="pro-mono">×{r.count}</span>
            </div>
          ))}
        </div>
      )}
      <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.privacy.logNote')}</span>
    </section>
  );
}
