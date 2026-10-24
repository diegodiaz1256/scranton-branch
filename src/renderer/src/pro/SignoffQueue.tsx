import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type Pending = Awaited<ReturnType<typeof window.cth.criticalPendingList>>[number];

/** The redacted text with each [REDACTED:<kind>] marked, so the human sees
 *  what the app took out. */
function Redacted({ text }: { text: string }) {
  const parts = text.split(/(\[REDACTED:[a-z]+\])/g);
  return (
    <>
      {parts.map((p, i) => /^\[REDACTED:[a-z]+\]$/.test(p)
        ? <mark key={i} className="pro-redacted">{p}</mark>
        : <Fragment key={i}>{p}</Fragment>)}
    </>
  );
}

/** How many items wait for the human's sign-off, live. */
export function usePendingCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    void window.cth.criticalPendingList().then((l) => setN(l.length)).catch(() => {});
    return window.cth.onCriticalPending((e) => setN(e.count));
  }, []);
  return n;
}

/**
 * What custodians of critical connections want to send out, held until the
 * human signs it off (criticalSignoff.ts). The text is already redacted by the
 * app; approve it as is, edit then approve, or reject with a reason that goes
 * back to the custodian. Nothing leaves otherwise, and nothing times out.
 */
export function SignoffQueue() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Pending[]>([]);
  const load = () => { void window.cth.criticalPendingList().then(setItems).catch(() => {}); };
  useEffect(() => {
    load();
    const off = window.cth.onCriticalPending(load);
    const timer = setInterval(load, 10000);
    return () => { off(); clearInterval(timer); };
  }, []);
  if (!items.length) return null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: 0, fontSize: 14 }}>🔒 {t('pro.signoff.title', { count: items.length })}</h3>
      <p className="pro-text" style={{ marginTop: -4 }}>{t('pro.signoff.body')}</p>
      {items.map((it) => <SignoffCard key={it.id} item={it} onDone={load} />)}
    </section>
  );
}

function SignoffCard({ item, onDone }: { item: Pending; onDone: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [subject, setSubject] = useState(item.subject ?? '');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (d: Parameters<typeof window.cth.criticalDecide>[1]) => {
    setBusy(true); setError(null);
    const r = await window.cth.criticalDecide(item.id, d).catch((e) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (!r.ok) { setError(r.error ?? t('integrations.couldNotSave')); return; }
    onDone();
  };
  const redactions = Object.entries(item.redactions).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${t(`pro.signoff.kind_${k}`, { defaultValue: k })}`).join(', ');
  const dest = item.kind === 'message' ? t('pro.signoff.toAgent', { to: item.to }) : t('pro.signoff.toResearch', { file: item.file });
  return (
    <article className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, boxShadow: 'inset 3px 0 0 var(--cth-coral)' }}>
      <div className="pro-row" style={{ fontSize: 12, gap: 8, flexWrap: 'wrap' }}>
        <span className="pro-badge pro-badge-critical">🔒 {item.fromName}</span>
        <span className="pro-sub">{dest}</span>
        <span className="pro-sub" style={{ marginInlineStart: 'auto' }}>{new Date(item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
      </div>
      <span className="pro-sub" style={{ fontSize: 11.5 }}>{redactions ? t('pro.signoff.redacted', { what: redactions }) : t('pro.signoff.nothingRedacted')}</span>
      {editing ? (
        <>
          {item.kind === 'message' && <input className="pro-input" value={subject} onChange={(e) => setSubject(e.target.value)} />}
          <textarea className="pro-input pro-mono" style={{ minHeight: 140, fontSize: 12.5 }} value={text} onChange={(e) => setText(e.target.value)} />
        </>
      ) : (
        <>
          {item.subject && <strong style={{ fontSize: 13 }}><Redacted text={item.subject} /></strong>}
          <pre className="pro-mono" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, maxHeight: 260, overflow: 'auto' }}><Redacted text={item.text} /></pre>
        </>
      )}
      {rejecting && (
        <input className="pro-input" autoFocus placeholder={t('pro.signoff.reasonPlaceholder')} value={reason} onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim()) void act({ action: 'reject', reason }); }} />
      )}
      <div className="pro-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {!rejecting && (
          <button className="pro-btn pro-btn-primary" disabled={busy}
            onClick={() => void act(editing ? { action: 'approve', text, ...(item.kind === 'message' ? { subject } : {}) } : { action: 'approve' })}>
            {editing ? t('pro.signoff.approveEdited') : t('pro.signoff.approve')}
          </button>
        )}
        {!rejecting && <button className="pro-btn" disabled={busy} onClick={() => setEditing((v) => !v)}>{editing ? t('common.cancel') : t('pro.signoff.edit')}</button>}
        {rejecting
          ? <>
              <button className="pro-btn" disabled={busy || !reason.trim()} onClick={() => void act({ action: 'reject', reason })}>{t('pro.signoff.rejectSend')}</button>
              <button className="pro-btn" disabled={busy} onClick={() => setRejecting(false)}>{t('common.cancel')}</button>
            </>
          : <button className="pro-btn" disabled={busy} onClick={() => { setEditing(false); setRejecting(true); }}>{t('pro.signoff.reject')}</button>}
        {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
      </div>
    </article>
  );
}
