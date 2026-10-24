import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Agent } from '@/store/store';
import { IntegrationsRegistry } from '@/components/IntegrationsRegistry';
import { Avatar, StateBadge } from './data';
import { Guide, useGuide } from './Guide';
import type { HarnessConfig } from '@/store/config';
import { mcpDescription, mcpField } from '@/i18n/catalogText';
import { CriticalBadge, CriticalSection, custodianFor } from './CriticalConnection';

type Connection = Awaited<ReturnType<typeof window.cth.connectionsList>>[number];
type TestResult = { ok: boolean; message: string };

/** The guide's steps, `pro.conn.step<n>` / `pro.conn.step<n>Body`. */
const STEPS = (t: TFunction): Array<[string, string]> =>
  [1, 2, 3, 4, 5].map((n) => [t(`pro.conn.step${n}`), t(`pro.conn.step${n}Body`)]);

/**
 * Connections — the outside services agents can use. Keyed MCP servers (GitHub,
 * Database, Web Search, Notion, Sentry), as many connections of each as you
 * need (two GitHub accounts, prod and staging databases): paste the key, test
 * it, choose who gets it. Keys go one way into the encrypted store, are never
 * shown again and never reach an agent (main runs the server; see
 * mcpGateway.ts). A guide walks through it. Below, the REST APIs that agents
 * reach through the key broker.
 */
export function ConnectionsView({ roster, config }: { roster: Agent[]; config: HarnessConfig }) {
  const { t } = useTranslation();
  const [list, setList] = useState<Connection[]>([]);
  const [guide, toggleGuide] = useGuide('cth.connectionsGuide');
  const reload = useCallback(() => {
    void window.cth.connectionsList().then(setList).catch(() => { /* keep last */ });
  }, []);
  useEffect(reload, [reload]);

  const live = list.filter((c) => c.enabled && c.ready).length;
  const services = Array.from(new Map(list.map((c) => [c.service, c.serviceLabel])).entries());

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.nav.connections')}</h2>
        <span className="pro-sub">{t('pro.conn.onCount', { live, total: list.length })}</span>
        <div className="pro-head-end">
          <button className="pro-btn" onClick={toggleGuide}>{guide ? t('pro.conn.hideGuide') : t('pro.conn.howItWorks')}</button>
        </div>
      </div>

      {guide && <Guide title={t('pro.conn.guideTitle')} steps={STEPS(t)} onClose={toggleGuide} />}

      {services.map(([service, label]) => (
        <ServiceGroup key={service} service={service} label={label}
          connections={list.filter((c) => c.service === service)} roster={roster} config={config} onChange={reload} />
      ))}

      <h3 style={{ margin: '10px 0 0', fontSize: 14 }}>{t('pro.conn.restTitle')}</h3>
      <p className="pro-text" style={{ marginTop: -6 }}>
        {t('pro.conn.restBody')}
      </p>
      {/* A plain card that grows with its content: the page scrolls, not the card. */}
      <div className="pro-card" style={{ flexShrink: 0 }}><IntegrationsRegistry /></div>
      <ApiAccess roster={roster} config={config} />
    </div>
  );
}

function ServiceGroup({ service, label, connections, roster, config, onChange }: {
  service: string; label: string; connections: Connection[]; roster: Agent[]; config: HarnessConfig; onChange: () => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    const r = await window.cth.connectionsAdd(service, name);
    if (!r.ok) { setError(r.error ?? t('pro.conn.couldNotAdd')); return; }
    setAdding(false); setName(''); onChange();
  };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="pro-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
        {connections.map((c) => <ConnectionCard key={c.id} c={c} roster={roster} config={config} onChange={onChange} />)}
      </div>
      {adding ? (
        <div className="pro-row">
          <input className="pro-input" placeholder={t('pro.conn.namePlaceholder', { label })} maxLength={40} value={name} autoFocus
            onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); if (e.key === 'Escape') setAdding(false); }} />
          <button className="pro-btn pro-btn-primary" disabled={!name.trim()} onClick={() => void add()}>{t('common.add')}</button>
          <button className="pro-btn" onClick={() => setAdding(false)}>{t('common.cancel')}</button>
          {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
        </div>
      ) : (
        <button className="pro-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>+ {t('pro.conn.another', { label })}</button>
      )}
    </section>
  );
}

function ConnectionCard({ c, roster, config, onChange }: { c: Connection; roster: Agent[]; config: HarnessConfig; onChange: () => void }) {
  const { t } = useTranslation();
  const critical = custodianFor(config, 'mcp', c.id) !== undefined;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [label, setLabel] = useState(c.label);
  const [copied, setCopied] = useState<number | null>(null);

  const state = !c.enabled
    ? { label: t('pro.conn.off'), tone: 'grey' as const }
    : c.ready ? { label: t('pro.conn.on'), tone: 'green' as const } : { label: t('pro.conn.needsKey'), tone: 'amber' as const };

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true); setError(null);
    const res = await fn().catch((e) => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (!res.ok) setError(res.error ?? t('integrations.couldNotSave'));
    onChange();
    return res.ok;
  };

  const save = async (env: string) => {
    const value = drafts[env] ?? '';
    if (!value.trim()) return;
    if (await run(() => window.cth.connectionsSetSecret(c.id, env, value))) {
      setDrafts((d) => ({ ...d, [env]: '' }));
      setTest(null);
    }
  };

  const doTest = async () => {
    setBusy(true); setTest(null);
    const res = await window.cth.connectionsTest(c.id).catch(() => ({ ok: false, message: t('integrations.testFailed') }));
    setBusy(false);
    setTest(res);
  };

  const remove = async () => {
    if (!(await window.cth.confirm(t('pro.conn.deleteConfirm', { name: c.label }), { detail: t('pro.conn.deleteDetail'), ok: t('pro.caps.delete') }))) return;
    void run(() => window.cth.connectionsRemove(c.id));
  };

  const rename = () => { void run(() => window.cth.connectionsRename(c.id, label)).then(() => setRenaming(false)); };

  const scoped = c.scope !== null;
  const toggleAgent = (id: string) => {
    const cur = new Set(c.scope ?? []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    // Choosing agents for a ready connection is the human saying "these should
    // have it": a switch left off made that do nothing at all.
    void run(async () => {
      const r = await window.cth.connectionsSetScope(c.id, [...cur]);
      if (r.ok && cur.size > 0 && !c.enabled && c.ready) return window.cth.connectionsSetEnabled(c.id, true);
      return r;
    });
  };
  const assignedButOff = scoped && !c.enabled && c.scope!.length > 0;

  return (
    <article className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="pro-row">
        {renaming ? (
          <>
            <input className="pro-input" value={label} maxLength={40} autoFocus onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(false); }} />
            <button className="pro-btn" onClick={rename}>{t('common.save')}</button>
          </>
        ) : (
          <>
            <p className="pro-title">{c.label}</p>
            {!c.primary && <span className="pro-chip">{c.serviceLabel}</span>}
            <StateBadge label={state.label} tone={state.tone} />
            {critical && <CriticalBadge />}
          </>
        )}
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
          {c.docsUrl && <button className="pro-btn" onClick={() => void window.cth.openExternal(c.docsUrl!)}>{t('pro.conn.getKey')}</button>}
          <button className={`pro-btn${c.enabled ? '' : ' pro-btn-primary'}`} disabled={busy}
            onClick={() => void run(() => window.cth.connectionsSetEnabled(c.id, !c.enabled))}>
            {c.enabled ? t('pro.conn.turnOff') : t('pro.conn.turnOn')}
          </button>
        </span>
      </div>
      {c.primary ? <p className="pro-text">{mcpDescription(t, c.service, c.description)}</p> : (
        <div className="pro-row" style={{ gap: 6 }}>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.separate', { label: c.serviceLabel })}</span>
          {!renaming && <button className="pro-btn" style={{ padding: '2px 8px' }} onClick={() => setRenaming(true)}>{t('pro.conn.rename')}</button>}
          <button className="pro-btn" style={{ padding: '2px 8px' }} onClick={remove}>{t('pro.caps.delete')}</button>
        </div>
      )}

      {c.fields.map((f) => (
        <div key={f.env} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label className="pro-sub" style={{ fontSize: 12 }} htmlFor={`${c.id}-${f.env}`}>
            {mcpField(t, c.service, f.env, 'label', f.label)}{f.optional ? ` (${t('pro.conn.optional')})` : ''}
            {f.stored && <span className="pro-chip pro-chip-on" style={{ marginInlineStart: 6 }}>{t('pro.conn.saved')}</span>}
          </label>
          <div className="pro-row">
            <input id={`${c.id}-${f.env}`} className="pro-input pro-mono" style={{ flex: 1 }} type="password" autoComplete="off" spellCheck={false}
              placeholder={f.stored ? t('pro.conn.savedPlaceholder') : (f.placeholder ?? '')}
              value={drafts[f.env] ?? ''}
              onChange={(e) => setDrafts((d) => ({ ...d, [f.env]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(f.env); }} />
            <button className="pro-btn" disabled={busy || !(drafts[f.env] ?? '').trim()} onClick={() => void save(f.env)}>{t('common.save')}</button>
            {f.stored && <button className="pro-btn" disabled={busy} onClick={() => void run(() => window.cth.connectionsSetSecret(c.id, f.env, ''))}>{t('pro.conn.remove')}</button>}
          </div>
          <span className="pro-sub" style={{ fontSize: 11.5 }}>{mcpField(t, c.service, f.env, 'help', f.help)}</span>
        </div>
      ))}

      <div className="pro-row" style={{ flexWrap: 'wrap' }}>
        <button className="pro-btn" disabled={busy || !c.testable || !c.ready} onClick={() => void doTest()}>{busy ? t('pro.conn.working') : t('pro.conn.test')}</button>
        {test && <span className="pro-text" style={{ color: test.ok ? 'var(--cth-ink-900)' : 'var(--cth-coral)' }}>{test.ok ? '✓ ' : '✕ '}{test.message}</span>}
        {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--pro-line)', paddingTop: 10 }}>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.accessTitle')}</span>
        <div className="pro-tabs" role="radiogroup" aria-label={t('pro.conn.accessTitle')}>
          {(['none', 'read', 'readwrite'] as const).map((lv) => (
            <button key={lv} role="radio" aria-selected={c.access === lv} aria-checked={c.access === lv} disabled={busy}
              onClick={() => { if (c.access !== lv) void run(() => window.cth.connectionsSetAccess(c.id, lv)); }}>{t(`pro.conn.access_${lv}`)}</button>
          ))}
        </div>
        <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.accessHint')}</span>
        {critical && <span className="pro-text" style={{ fontSize: 12 }}>{t('pro.conn.criticalScopeNote')}</span>}
        {!critical && <div className="pro-tabs" role="radiogroup" aria-label={t('pro.conn.whoGetsIt')}>
          <button role="radio" aria-selected={!scoped} aria-checked={!scoped} disabled={busy}
            onClick={() => void run(() => window.cth.connectionsSetScope(c.id, null))}>{t('pro.conn.everyAgent')}</button>
          <button role="radio" aria-selected={scoped} aria-checked={scoped} disabled={busy}
            onClick={() => { if (!scoped) void run(() => window.cth.connectionsSetScope(c.id, [])); }}>{t('pro.conn.chooseAgents')}</button>
        </div>}
        {scoped && !critical && (
          <div className="pro-row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {roster.length === 0 && <span className="pro-sub">{t('pro.conn.noAgents')}</span>}
            {roster.map((a) => {
              const on = c.scope!.includes(a.id);
              return (
                <button key={a.id} className={`pro-chip ${on ? 'pro-chip-on' : 'pro-chip-off'}`} style={{ cursor: 'pointer', fontFamily: 'var(--cth-font-ui)' }}
                  aria-pressed={on} disabled={busy} onClick={() => toggleAgent(a.id)}>
                  <Avatar agent={a} /> {a.name}
                </button>
              );
            })}
          </div>
        )}
        {assignedButOff && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{t('pro.conn.offAssigned')}</span>}
        <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.restartNote')}</span>
      </div>

      <CriticalSection kind="mcp" id={c.id} name={c.label} roster={roster} config={config} />

      <WhoAndActivity id={c.id} version={`${c.enabled}|${c.ready}|${c.access}|${(c.scope ?? []).join(',')}|${custodianFor(config, 'mcp', c.id) ?? '-'}`} />

      {c.examples.length > 0 && (
        <details>
          <summary className="pro-sub" style={{ fontSize: 12, cursor: 'pointer' }}>{t('pro.conn.thingsToAsk')}</summary>
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {c.examples.map((ex, i) => {
              const text = c.primary ? ex : `Using the "${c.label}" ${c.serviceLabel} connection: ${ex}`;
              return (
                <li key={i} style={{ fontSize: 12.5 }}>
                  <span className="pro-text">{text}</span>{' '}
                  <button className="pro-btn" style={{ padding: '0 6px', fontSize: 11 }}
                    onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(i); setTimeout(() => setCopied(null), 1200); }); }}>
                    {copied === i ? t('pro.conn.copied') : t('pro.conn.copy')}
                  </button>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </article>
  );
}

type AgentAccess = Awaited<ReturnType<typeof window.cth.connectionsAgents>>[number];
type Call = Awaited<ReturnType<typeof window.cth.connectionsActivity>>[number];

/** Who has this connection (and why not, for the rest) and the latest calls made
 *  with it, refused ones included. Loaded only when opened. */
function WhoAndActivity({ id, version }: { id: string; version: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<AgentAccess[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  useEffect(() => {
    if (!open) return;
    const load = () => {
      void window.cth.connectionsAgents(id).then(setAgents).catch(() => {});
      void window.cth.connectionsActivity(id).then(setCalls).catch(() => {});
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [open, id, version]);
  const level = (a: AgentAccess) => a.access === 'readwrite' ? t('pro.caps.accessWriteShort') : a.access === 'read' ? t('pro.caps.accessReadShort') : t(`pro.conn.why_${a.reason ?? 'off'}`);
  return (
    <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="pro-sub" style={{ fontSize: 12, cursor: 'pointer' }}>{t('pro.conn.whoAndActivity')}</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
        {agents.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.noAgents')}</span>}
        {agents.map((a) => (
          <div key={a.agentId} className="pro-row" style={{ gap: 8, fontSize: 12.5 }}>
            <span className="pro-dot" style={{ background: a.access === 'none' ? 'var(--cth-ink-300)' : 'var(--cth-mint)' }} />
            <span style={{ minWidth: 100 }}>{a.name}</span>
            <span className={a.access === 'none' ? 'pro-sub' : undefined} style={{ fontSize: 12 }}>{level(a)}</span>
          </div>
        ))}
        <span className="pro-sub" style={{ fontSize: 11, marginTop: 6, letterSpacing: '.08em', textTransform: 'uppercase' }}>{t('pro.conn.recentCalls')}</span>
        {calls.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.noCalls')}</span>}
        {calls.map((c, i) => (
          <div key={i} className="pro-row" style={{ gap: 8, fontSize: 12 }}>
            <span className="pro-sub pro-mono" style={{ fontSize: 11 }}>{new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span style={{ minWidth: 80 }}>{c.agentName}</span>
            <span className="pro-mono" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.tool}</span>
            <span style={{ color: !c.allowed || c.ok === false ? 'var(--cth-coral)' : 'var(--cth-ink-700)' }}>
              {!c.allowed ? t('pro.conn.callRefused') : c.ok === false ? t('pro.conn.callFailed') : t('pro.conn.callOk')}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

type Level = 'none' | 'read' | 'readwrite';

/** Who may use each REST API (Jira, Linear, Notion…) and how: a limit no role
 *  can exceed (read-only = GET and searches), and every agent or chosen ones.
 *  The key broker enforces both on every request. */
function ApiAccess({ roster, config }: { roster: Agent[]; config: HarnessConfig }) {
  const { t } = useTranslation();
  const [apis, setApis] = useState<Array<{ id: string; label: string; enabled: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => { void window.cth.integrationsList().then((r) => { if (alive) setApis(r.map((x) => ({ id: x.id, label: x.label, enabled: x.enabled }))); }).catch(() => {}); };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!apis.length) return null;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <h3 style={{ margin: '6px 0 0', fontSize: 14 }}>{t('pro.conn.apiAccessTitle')}</h3>
      <p className="pro-text" style={{ marginTop: -6 }}>{t('pro.conn.apiAccessBody')}</p>
      <div className="pro-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))' }}>
        {apis.map((a) => {
          const level: Level = config.integrationPolicy?.[a.id] ?? 'read';
          const scope = config.integrationScopes?.[a.id];
          const scoped = Array.isArray(scope);
          const critical = custodianFor(config, 'api', a.id) !== undefined;
          return (
            <article key={a.id} className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, opacity: a.enabled ? 1 : 0.65 }}>
              <div className="pro-row">
                <p className="pro-title">{a.label}</p>
                <span className="pro-chip pro-mono" style={{ fontSize: 11 }}>{a.id}</span>
                {!a.enabled && <StateBadge label={t('pro.conn.off')} tone="grey" />}
                {critical && <CriticalBadge />}
              </div>
              <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.conn.accessTitle')}</span>
              <div className="pro-tabs" role="radiogroup" aria-label={t('pro.conn.accessTitle')}>
                {(['none', 'read', 'readwrite'] as const).map((lv) => (
                  <button key={lv} role="radio" aria-selected={level === lv} aria-checked={level === lv} disabled={busy}
                    onClick={() => { if (level !== lv) void act(() => window.cth.integrationsSetAccess(a.id, lv)); }}>{t(`pro.conn.access_${lv}`)}</button>
                ))}
              </div>
              {level === 'read' && <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.apiReadMeans')}</span>}
              {critical && <span className="pro-text" style={{ fontSize: 12 }}>{t('pro.conn.criticalScopeNote')}</span>}
              {!critical && <div className="pro-tabs" role="radiogroup" aria-label={t('pro.conn.whoGetsIt')}>
                <button role="radio" aria-selected={!scoped} aria-checked={!scoped} disabled={busy} onClick={() => void act(() => window.cth.integrationsSetScope(a.id, null))}>{t('pro.conn.everyAgent')}</button>
                <button role="radio" aria-selected={scoped} aria-checked={scoped} disabled={busy} onClick={() => { if (!scoped) void act(() => window.cth.integrationsSetScope(a.id, [])); }}>{t('pro.conn.chooseAgents')}</button>
              </div>}
              {scoped && !critical && (
                <div className="pro-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  {roster.map((ag) => {
                    const on = scope!.includes(ag.id);
                    return (
                      <button key={ag.id} className={`pro-chip ${on ? 'pro-chip-on' : 'pro-chip-off'}`} style={{ cursor: 'pointer', fontFamily: 'var(--cth-font-ui)' }}
                        aria-pressed={on} disabled={busy}
                        onClick={() => void act(() => window.cth.integrationsSetScope(a.id, on ? scope!.filter((x) => x !== ag.id) : [...scope!, ag.id]))}>
                        <Avatar agent={ag} /> {ag.name}
                      </button>
                    );
                  })}
                </div>
              )}
              <CriticalSection kind="api" id={a.id} name={a.label} roster={roster} config={config} />
            </article>
          );
        })}
      </div>
      <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.conn.restartNote')}</span>
    </section>
  );
}
