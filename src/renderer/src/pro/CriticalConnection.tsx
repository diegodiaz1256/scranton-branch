import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { canBeCustodian, cleanCriticalMap, custodianOf, custodianships, type CriticalKind } from '@shared/criticalConnections';
import { Avatar } from './data';
import { previewKind } from '@shared/deliverables';
import { PdfPreview } from './PdfPreview';
import { TextPreview } from './DeliverablesView';

type AuditRow = Awaited<ReturnType<typeof window.cth.criticalAudit>>[number];

/** The custodian of a connection from the live config ('' none, undefined = not critical). */
export function custodianFor(config: HarnessConfig, kind: CriticalKind, id: string): string | undefined {
  return custodianOf(cleanCriticalMap(config.criticalCustodians), kind, id);
}

/** The lock badge on a critical connection's card. */
export function CriticalBadge() {
  const { t } = useTranslation();
  return <span className="pro-badge pro-badge-critical" title={t('pro.conn.criticalTip')}>🔒 {t('pro.conn.criticalBadge')}</span>;
}

/** The lock badge on a custodian agent's card; nothing for anyone else. */
export function CustodianBadge({ agentId, config }: { agentId: string; config: HarnessConfig }) {
  const { t } = useTranslation();
  const held = custodianships(cleanCriticalMap(config.criticalCustodians), agentId);
  if (!held.length) return null;
  const names = held.map((k) => k.replace(/^(mcp|api):/, '')).join(', ');
  return <span className="pro-badge pro-badge-critical" title={t('pro.conn.custodianTip', { names })}>🔒 {t('pro.conn.custodianBadge')}</span>;
}

/**
 * Mark a connection (or REST API, or your own MCP server) critical and choose
 * its ONE custodian. Only Claude Code agents qualify, never the orchestrator;
 * main checks both again. Below, the audit of every call made to it.
 */
export function CriticalSection({ kind, id, name, roster, config }: {
  kind: CriticalKind; id: string; name: string; roster: Agent[]; config: HarnessConfig;
}) {
  const { t } = useTranslation();
  const custodian = custodianFor(config, kind, id);
  const critical = custodian !== undefined;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = async (on: boolean, who?: string) => {
    setBusy(true); setError(null);
    const r = await window.cth.criticalSet(kind, id, on, who).catch((e) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (!r.ok) setError(r.error ?? t('integrations.couldNotSave'));
  };
  const turnOff = async () => {
    if (!(await window.cth.confirm(t('pro.conn.criticalOffConfirm', { name }), { detail: t('pro.conn.criticalOffDetail'), ok: t('pro.conn.criticalOff') }))) return;
    void set(false);
  };
  const live = roster.filter((a) => !a.archived);
  const gone = critical && !!custodian && !roster.some((a) => a.id === custodian);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--pro-line)', paddingTop: 10 }}>
      <div className="pro-row" style={{ gap: 8 }}>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.criticalTitle')}</span>
        {critical && <CriticalBadge />}
        <button className={`pro-btn${critical ? '' : ' pro-btn-primary'}`} style={{ marginInlineStart: 'auto', padding: '2px 8px' }} disabled={busy}
          onClick={() => void (critical ? turnOff() : set(true))}>
          {critical ? t('pro.conn.criticalOff') : t('pro.conn.criticalOn')}
        </button>
      </div>
      <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.criticalBody')}</span>
      {critical && (
        <>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.custodian')}</span>
          <div className="pro-row" role="radiogroup" aria-label={t('pro.conn.custodian')} style={{ flexWrap: 'wrap', gap: 6 }}>
            {live.length === 0 && <span className="pro-sub">{t('pro.conn.noAgents')}</span>}
            {live.map((a) => {
              const on = custodian === a.id;
              const why = a.isGod ? t('pro.conn.custodianNotGod') : !canBeCustodian(a.provider) ? t('pro.conn.custodianOnlyClaude') : undefined;
              return (
                <button key={a.id} role="radio" aria-checked={on} className={`pro-chip ${on ? 'pro-chip-on' : 'pro-chip-off'}`}
                  style={{ cursor: why ? 'not-allowed' : 'pointer', fontFamily: 'var(--cth-font-ui)', opacity: why ? 0.5 : 1 }}
                  title={why} disabled={busy || !!why} onClick={() => { if (!on) void set(true, a.id); }}>
                  <Avatar agent={a} /> {a.name}
                </button>
              );
            })}
          </div>
          <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.custodianPick')}</span>
          {!custodian && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{t('pro.conn.custodianNone')}</span>}
          {gone && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{t('pro.conn.custodianGone')}</span>}
          <ConfidentialVault kind={kind} id={id} hasCustodian={!!custodian} />
          <CriticalAudit kind={kind} id={id} />
        </>
      )}
      {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
    </div>
  );
}

type VaultFile = Awaited<ReturnType<typeof window.cth.criticalVaultList>>['files'][number];

/** The confidential vault: what the custodian keeps raw, and the full reports
 *  the human asked for. Read here, read-only; no agent but the custodian can
 *  open the folder. A full report is asked for here and only here. */
function ConfidentialVault({ kind, id, hasCustodian }: { kind: CriticalKind; id: string; hasCustodian: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ rel: string; text?: string; bytes?: Uint8Array; error?: string } | null>(null);
  const [ask, setAsk] = useState('');
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const load = () => { void window.cth.criticalVaultList(kind, id).then((r) => { setFiles(r.files); setDir(r.dir); }).catch(() => {}); };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [open, kind, id]);
  const view = async (rel: string) => {
    const r = await window.cth.criticalVaultRead(kind, id, rel).catch((e) => ({ ok: false, error: String(e) }) as { ok: boolean; text?: string; base64?: string; error?: string });
    if (!r.ok) { setViewing({ rel, error: r.error }); return; }
    setViewing({ rel, text: r.text, bytes: r.base64 ? Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)) : undefined });
  };
  const request = async () => {
    const r = await window.cth.criticalRequestReport(kind, id, ask).catch((e) => ({ ok: false, error: String(e) }) as { ok: boolean; file?: string; error?: string });
    setNote(r.ok ? t('pro.conn.vaultRequested', { file: r.file }) : (r.error ?? t('integrations.couldNotSave')));
    if (r.ok) setAsk('');
  };
  const name = viewing?.rel.split('/').pop() ?? '';
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="pro-sub" style={{ fontSize: 12, cursor: 'pointer' }}>🔒 {t('pro.conn.vault')}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
        <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.vaultBody')}</span>
        {files.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.vaultEmpty')}</span>}
        {files.map((f) => (
          <button key={f.rel} className="pro-row" style={{ gap: 8, fontSize: 12, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'start', color: 'inherit' }} onClick={() => void view(f.rel)}>
            <span className="pro-mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.rel}</span>
            <span className="pro-sub pro-mono" style={{ fontSize: 11 }}>{new Date(f.mtime).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          </button>
        ))}
        {viewing && (
          <div className="pro-card" style={{ padding: 10, maxHeight: 420, overflow: 'auto' }}>
            <div className="pro-row" style={{ gap: 8 }}>
              <span className="pro-mono" style={{ fontSize: 12, flex: 1 }}>{viewing.rel}</span>
              <button className="pro-btn" style={{ padding: '0 8px' }} onClick={() => setViewing(null)}>{t('common.close')}</button>
            </div>
            {viewing.error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{viewing.error}</span>}
            {viewing.bytes && previewKind(name) === 'pdf' && <PdfPreview bytes={viewing.bytes} name={name} />}
            {viewing.text !== undefined && <TextPreview kind={previewKind(name)} text={viewing.text} dir={dir ?? ''} name={viewing.rel} />}
          </div>
        )}
        <div className="pro-row" style={{ gap: 6 }}>
          <button className="pro-btn" style={{ padding: '2px 8px' }} onClick={() => void window.cth.criticalVaultReveal(kind, id)}>{t('pro.conn.vaultReveal')}</button>
        </div>
        {hasCustodian && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.vaultAsk')}</span>
            <div className="pro-row" style={{ gap: 6 }}>
              <input className="pro-input" style={{ flex: 1 }} value={ask} maxLength={4000} placeholder={t('pro.conn.vaultAskPlaceholder')}
                onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ask.trim()) void request(); }} />
              <button className="pro-btn pro-btn-primary" disabled={!ask.trim()} onClick={() => void request()}>{t('pro.conn.vaultAskSend')}</button>
            </div>
            <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.vaultAskHint')}</span>
            {note && <span className="pro-text" style={{ fontSize: 12 }}>{note}</span>}
          </div>
        )}
      </div>
    </details>
  );
}

/** Every call made to a critical connection, refused ones included: who,
 *  what, when. Loaded only when opened; never arguments or bodies. */
function CriticalAudit({ kind, id }: { kind: CriticalKind; id: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    if (!open) return;
    const load = () => { void window.cth.criticalAudit(kind, id).then(setRows).catch(() => {}); };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [open, kind, id]);
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="pro-sub" style={{ fontSize: 12, cursor: 'pointer' }}>{t('pro.conn.criticalAudit')}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {rows.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.criticalAuditEmpty')}</span>}
        {rows.map((r, i) => (
          <div key={i} className="pro-row" style={{ gap: 8, fontSize: 12 }}>
            <span className="pro-sub pro-mono" style={{ fontSize: 11 }}>{new Date(r.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span style={{ minWidth: 80 }}>{r.agentName ?? r.agentId}</span>
            <span className="pro-mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.call}</span>
            <span style={{ color: !r.allowed || r.ok === false ? 'var(--cth-coral)' : 'var(--cth-ink-700)' }}>
              {!r.allowed ? t('pro.conn.callRefused') : r.ok === false ? t('pro.conn.callFailed') : t('pro.conn.callOk')}
            </span>
          </div>
        ))}
        <button className="pro-btn" style={{ alignSelf: 'flex-start', padding: '2px 8px' }} onClick={() => void window.cth.criticalRevealAudit()}>{t('pro.conn.criticalAuditFile')}</button>
      </div>
    </details>
  );
}
