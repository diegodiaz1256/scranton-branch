import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Agent } from '@/store/store';
import type { McpFoundView, McpMineView, McpOverviewView, McpTransportView } from '../../../preload/index';
import type { HarnessConfig } from '@/store/config';
import { useProStore } from './proStore';
import { serverLabel } from '@shared/agentSteps';
import { StateBadge } from './data';
import { Guide, useGuide } from './Guide';

/**
 * MCP servers: your own, and the ones already set up for Claude Code, Claude
 * Desktop, Cursor, Codex, Gemini CLI / Antigravity and Windsurf on this
 * machine (main/mcpServers.ts). Importing one moves its keys into the
 * encrypted store; the server then runs inside the app and agents reach it
 * with a capability token, never the key.
 */

/** The guide's steps, `pro.mcp.step<n>` / `pro.mcp.step<n>Body`. */
const STEPS = (t: TFunction): Array<[string, string]> =>
  [1, 2, 3, 4].map((n) => [t(`pro.mcp.step${n}`), t(`pro.mcp.step${n}Body`)]);

const transportText = (t: McpTransportView) => (t.kind === 'stdio' ? [t.command, ...t.args].join(' ') : t.url);

export function McpView({ roster, config }: { roster: Agent[]; config: HarnessConfig }) {
  const { t } = useTranslation();
  const setView = useProStore((s) => s.setView);
  const [overview, setOverview] = useState<McpOverviewView[]>([]);
  const onlyManaged = config.mcpOnlyManaged !== false;
  const [mine, setMine] = useState<McpMineView[]>([]);
  const [found, setFound] = useState<McpFoundView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [guideOpen, toggleGuide] = useGuide('cth.guide.mcp');
  const reload = useCallback(() => {
    void window.cth.mcpList().then((r) => { setMine(r.mine); setFound(r.found); });
    void window.cth.mcpOverview().then(setOverview).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const agents = roster.filter((a) => !a.archived);
  const bySource = new Map<string, McpFoundView[]>();
  for (const f of found) bySource.set(f.source, [...(bySource.get(f.source) ?? []), f]);

  const doImport = async (f: McpFoundView) => {
    setError(null);
    const r = await window.cth.mcpImport(f.source, f.name);
    if (!r.ok) setError(r.error ?? t('pro.mcp.notImported'));
    reload();
  };

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>MCP</h2>
        <span className="pro-sub">{t('pro.mcp.sub')}</span>
        <div className="pro-head-end"><button className="pro-btn" onClick={toggleGuide}>{guideOpen ? t('pro.conn.hideGuide') : t('pro.conn.howItWorks')}</button></div>
      </div>
      {guideOpen && <Guide title={t('pro.mcp.guideTitle')} steps={STEPS(t)} onClose={toggleGuide} />}
      {error && <div className="pro-card" style={{ borderColor: 'var(--cth-coral)' }}><span className="pro-text">{error}</span></div>}

      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
        <div className="pro-row" style={{ gap: 10 }}>
          <strong style={{ fontSize: 13 }}>{t('pro.mcp.onlyManaged')}</strong>
          <div className="pro-switch" role="group" aria-label={t('pro.mcp.onlyManaged')} style={{ marginInlineStart: 'auto' }}>
            <button aria-pressed={onlyManaged} onClick={() => void window.cth.updateConfig({ mcpOnlyManaged: true })}>{t('pro.conn.on')}</button>
            <button aria-pressed={!onlyManaged} onClick={() => void window.cth.updateConfig({ mcpOnlyManaged: false })}>{t('pro.conn.off')}</button>
          </div>
        </div>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t(onlyManaged ? 'pro.mcp.onlyManagedOn' : 'pro.mcp.onlyManagedOff')}</span>
      </section>

      <h3 style={{ margin: '6px 0 0', fontSize: 14 }}>{t('pro.mcp.agentsGet')}</h3>
      <p className="pro-sub" style={{ margin: '-6px 0 0', fontSize: 12 }}>{t('pro.mcp.agentsGetSub')}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        {overview.length === 0 && <p className="pro-sub" style={{ margin: 0 }}>{t('pro.mcp.noAgents')}</p>}
        {overview.map((o) => (
          <div key={o.agentId} className="pro-card pro-row" style={{ flexWrap: 'wrap', gap: 6, padding: '8px 12px' }}>
            <strong style={{ fontSize: 13, minWidth: 110 }}>{o.name}</strong>
            {o.provider !== 'claude' && o.provider !== 'opencode' && <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.mcp.noMcpHere', { provider: o.provider })}</span>}
            {o.servers.length === 0 && (o.provider === 'claude' || o.provider === 'opencode') && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.mcp.nothingManaged')}</span>}
            {(o.provider === 'claude' || o.provider === 'opencode') && o.servers.map((s) => (
              <span key={s.name} className={`pro-chip${s.origin === 'connection' ? ' pro-chip-on' : ''}`} title={t(`pro.mcp.origin_${s.origin}`)}>
                {s.origin === 'yours' ? s.id.replace(/^custom--/, '') : s.origin === 'office' ? t(`pro.mcp.office_${s.id}`, { defaultValue: s.id }) : serverLabel(s.id)}{s.origin === 'connection' ? ` · ${s.access === 'readwrite' ? t('pro.caps.accessWriteShort') : t('pro.caps.accessReadShort')}` : ''}
              </span>
            ))}
          </div>
        ))}
      </div>

      <h3 style={{ margin: '6px 0 0', fontSize: 14 }}>{t('pro.mcp.yours')}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {mine.length === 0 && !adding && <p className="pro-sub" style={{ margin: 0 }}>{t('pro.mcp.noneYet')}</p>}
        {mine.slice().sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
          <MineCard key={s.id} s={s} agents={agents} onChanged={reload} onError={setError} />
        ))}
        {adding
          ? <ServerForm onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} onError={setError} />
          : <button className="pro-card" onClick={() => setAdding(true)} style={{ borderStyle: 'dashed', cursor: 'pointer', textAlign: 'center', flexShrink: 0 }}><span className="pro-sub">+ {t('pro.mcp.addServer')}</span></button>}
      </div>

      <h3 style={{ margin: '6px 0 0', fontSize: 14 }}>{t('pro.mcp.found')}</h3>
      {found.length === 0 && <p className="pro-sub" style={{ margin: 0 }}>{t('pro.mcp.noneFound')}</p>}
      {[...bySource.entries()].map(([source, list]) => (
        <section key={source} className="pro-card" style={{ display: 'flex', flexDirection: 'column', padding: 0, flexShrink: 0 }}>
          <div className="pro-row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--pro-line)' }}>
            <strong style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{source}</strong>
            <span className="pro-sub pro-mono" style={{ fontSize: 11, marginInlineStart: 'auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{list[0].file}</span>
          </div>
          {list.map((f) => <FoundRow key={f.name} f={f} blocked={onlyManaged} onImport={() => void doImport(f)} onConnection={() => setView({ kind: 'section', section: 'connections' })} />)}
        </section>
      ))}
    </div>
  );
}

function FoundRow({ f, blocked, onImport, onConnection }: { f: McpFoundView; blocked: boolean; onImport: () => void; onConnection: () => void }) {
  const { t } = useTranslation();
  const secrets = [...f.env, ...f.headers].filter((e) => e.secret).map((e) => e.name);
  return (
    <div className="pro-row" style={{ padding: '10px 14px', borderBottom: '1px solid var(--pro-line)', gap: 12 }}>
      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 120 }}>{f.name}</span>
      <StateBadge label={f.transport.kind === 'stdio' ? t('pro.mcp.local') : t('pro.mcp.remote')} tone={f.transport.kind === 'stdio' ? 'grey' : 'blue'} />
      <span className="pro-mono" style={{ fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--cth-ink-700)' }}>{transportText(f.transport)}</span>
      {secrets.length > 0 && <span className="pro-sub" style={{ fontSize: 11 }} title={secrets.join(', ')}>{t(secrets.length === 1 ? 'pro.mcp.keysOne' : 'pro.mcp.keysMany', { count: secrets.length })}</span>}
      {f.agent && <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.mcp.addedByAgent', { name: f.agent })}</span>}
      {!f.imported && (
        <StateBadge label={t(blocked ? 'pro.mcp.blocked' : 'pro.mcp.agentsMayReach')} tone={blocked ? 'grey' : 'amber'} />
      )}
      {f.imported
        ? <StateBadge label={t('pro.mcp.imported')} tone="green" />
        : f.suggest?.kind === 'connection'
          ? (
            <>
              <button className="pro-btn pro-btn-primary" title={t('pro.mcp.useConnectionTip', { name: f.suggest.label })} onClick={onConnection}>{t('pro.mcp.useConnection', { name: f.suggest.label })}</button>
              <button className="pro-btn" onClick={onImport}>{t('pro.mcp.import')}</button>
            </>
          )
          : f.suggest?.kind === 'builtin'
            ? <StateBadge label={t('pro.mcp.alreadyBuiltIn', { name: f.suggest.label })} tone="green" />
            : <button className="pro-btn" onClick={onImport}>{t('pro.mcp.import')}</button>}
    </div>
  );
}

function MineCard({ s, agents, onChanged, onError }: { s: McpMineView; agents: Agent[]; onChanged: () => void; onError: (e: string | null) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const missing = [...s.secretEnv.filter((e) => !s.secretsStored[e]), ...s.secretHeaders.filter((h) => !s.headersStored[h])];
  const remove = async () => {
    if (!(await window.cth.confirm(t('pro.mcp.removeConfirm', { name: s.name }), { detail: s.secretEnv.length || s.secretHeaders.length ? t('pro.mcp.removeDetail') : undefined, ok: t('pro.conn.remove') }))) return;
    await window.cth.mcpRemove(s.id);
    onChanged();
  };
  const toggleAgent = async (id: string) => {
    const cur = s.agents ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    await window.cth.mcpSetAgents(s.id, next.length ? next : null);
    onChanged();
  };
  if (editing) return <ServerForm initial={s} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} onError={onError} />;
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, opacity: s.enabled ? 1 : 0.65 }}>
      <div className="pro-row" style={{ gap: 8 }}>
        <strong style={{ fontSize: 13 }}>{s.name}</strong>
        <StateBadge label={s.transport.kind === 'stdio' ? t('pro.mcp.local') : t('pro.mcp.remote')} tone={s.transport.kind === 'stdio' ? 'grey' : 'blue'} />
        {(s.secretEnv.length > 0 || s.secretHeaders.length > 0) && <StateBadge label={t('pro.mcp.throughApp')} tone="gold" />}
        {s.source && <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.mcp.from', { source: s.source })}</span>}
        <div className="pro-switch" role="group" aria-label={t('pro.mcp.onOff')} style={{ marginInlineStart: 'auto' }}>
          <button aria-pressed={s.enabled} onClick={() => void window.cth.mcpSetEnabled(s.id, true).then(onChanged)}>{t('pro.conn.on')}</button>
          <button aria-pressed={!s.enabled} onClick={() => void window.cth.mcpSetEnabled(s.id, false).then(onChanged)}>{t('pro.conn.off')}</button>
        </div>
        <button className="pro-btn" onClick={() => setEditing(true)}>{t('pro.caps.edit')}</button>
        <button className="pro-btn" onClick={() => void remove()}>{t('pro.conn.remove')}</button>
      </div>
      <code className="pro-mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{transportText(s.transport)}</code>
      {(s.secretEnv.length > 0 || Object.keys(s.env).length > 0 || s.secretHeaders.length > 0 || Object.keys(s.headers).length > 0) && (
        <div className="pro-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {s.secretEnv.map((e) => <span key={e} className="pro-chip pro-mono" style={{ fontSize: 11 }}>{e} {s.secretsStored[e] ? `•••• ${t('pro.env.stored')}` : t('pro.mcp.missing')}</span>)}
          {Object.entries(s.env).map(([k, v]) => <span key={k} className="pro-chip pro-mono" style={{ fontSize: 11 }}>{k}={v}</span>)}
          {s.secretHeaders.map((h) => <span key={`h:${h}`} className="pro-chip pro-mono" style={{ fontSize: 11 }}>{h}: {s.headersStored[h] ? `•••• ${t('pro.env.stored')}` : t('pro.mcp.missing')}</span>)}
          {Object.entries(s.headers).map(([k, v]) => <span key={`h:${k}`} className="pro-chip pro-mono" style={{ fontSize: 11 }}>{k}: {v}</span>)}
        </div>
      )}
      {missing.length > 0 && <span className="pro-sub" style={{ fontSize: 11, color: 'var(--cth-coral)' }}>{t('pro.mcp.missingHint', { names: missing.join(', ') })}</span>}
      {agents.length > 0 && (
        <div className="pro-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.env.for')}</span>
          <button className={`pro-chip${!s.agents?.length ? ' pro-chip-on' : ''}`} onClick={() => void window.cth.mcpSetAgents(s.id, null).then(onChanged)}>{t('pro.env.allAgents')}</button>
          {agents.map((a) => (
            <button key={a.id} className={`pro-chip${s.agents?.includes(a.id) ? ' pro-chip-on' : ''}`} onClick={() => void toggleAgent(a.id)}>{a.name}</button>
          ))}
        </div>
      )}
      <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.mcp.nextStart')}</span>
    </section>
  );
}

type EnvRow = { name: string; value: string; secret: boolean };

function ServerForm({ initial, onDone, onCancel, onError }: { initial?: McpMineView; onDone: () => void; onCancel: () => void; onError: (e: string | null) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<McpTransportView['kind']>(initial?.transport.kind ?? 'stdio');
  const [command, setCommand] = useState(initial?.transport.kind === 'stdio' ? [initial.transport.command, ...initial.transport.args].join(' ') : '');
  const [url, setUrl] = useState(initial?.transport.kind === 'http' ? initial.transport.url : '');
  const [env, setEnv] = useState<EnvRow[]>(() => [
    ...Object.entries(initial?.env ?? {}).map(([n, v]) => ({ name: n, value: v, secret: false })),
    ...(initial?.secretEnv ?? []).map((n) => ({ name: n, value: '', secret: true }))
  ]);
  const [headers, setHeaders] = useState<EnvRow[]>(() => [
    ...Object.entries(initial?.headers ?? {}).map(([n, v]) => ({ name: n, value: v, secret: false })),
    ...(initial?.secretHeaders ?? []).map((n) => ({ name: n, value: '', secret: true }))
  ]);
  const save = async () => {
    onError(null);
    // Simple splitting: quoted parts stay together ("C:\Program Files\…").
    const parts = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((p) => p.replace(/^["']|["']$/g, ''));
    const transport: McpTransportView = kind === 'stdio' ? { kind, command: parts[0] ?? '', args: parts.slice(1) } : { kind, url: url.trim() };
    const rows = env.filter((r) => r.name.trim());
    const hrows = kind === 'http' ? headers.filter((r) => r.name.trim()) : [];
    const r = await window.cth.mcpSave(
      { id: initial?.id, name, transport, env: Object.fromEntries(rows.map((x) => [x.name.trim(), x.value])), headers: Object.fromEntries(hrows.map((x) => [x.name.trim(), x.value])) },
      rows.filter((x) => x.secret).map((x) => x.name.trim()),
      hrows.filter((x) => x.secret).map((x) => x.name.trim())
    );
    if (!r.ok) { onError(r.error ?? t('pro.env.notSaved')); return; }
    onDone();
  };
  const setRow = (i: number, patch: Partial<EnvRow>) => setEnv((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setHeader = (i: number, patch: Partial<EnvRow>) => setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
      <div className="pro-row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input className="pro-input" placeholder={t('pro.mcp.namePh')} value={name} disabled={!!initial} onChange={(e) => setName(e.target.value)} style={{ width: 200 }} />
        <div className="pro-switch" role="group" aria-label={t('pro.env.kind')}>
          <button aria-pressed={kind === 'stdio'} onClick={() => setKind('stdio')}>{t('pro.mcp.localCommand')}</button>
          <button aria-pressed={kind === 'http'} onClick={() => setKind('http')}>{t('pro.mcp.remoteAddress')}</button>
        </div>
      </div>
      {kind === 'stdio'
        ? <input className="pro-input pro-mono" placeholder="npx -y @modelcontextprotocol/server-github" value={command} onChange={(e) => setCommand(e.target.value)} />
        : <input className="pro-input pro-mono" placeholder="https://example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />}
      {kind === 'stdio' && (
        <>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.nav.environment')}</span>
          {env.map((r, i) => (
            <div key={i} className="pro-row" style={{ gap: 6 }}>
              <input className="pro-input pro-mono" placeholder={t('pro.env.namePh')} value={r.name} onChange={(e) => setRow(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} style={{ width: 200 }} />
              <input className="pro-input pro-mono" type={r.secret ? 'password' : 'text'} autoComplete="off" style={{ flex: 1 }}
                placeholder={r.secret ? (initial?.secretsStored[r.name] ? t('pro.env.storedPh') : t('pro.mcp.keyPh')) : t('pro.env.valuePh')}
                value={r.value} onChange={(e) => setRow(i, { value: e.target.value })} />
              <button className={`pro-chip${r.secret ? ' pro-chip-on' : ''}`} onClick={() => setRow(i, { secret: !r.secret })}>{t('pro.env.kind_secret')}</button>
              <button className="pro-btn" onClick={() => setEnv((rows) => rows.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button className="pro-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setEnv((rows) => [...rows, { name: '', value: '', secret: true }])}>+ {t('pro.mcp.variable')}</button>
          <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.mcp.secretHint')}</span>
        </>
      )}
      {kind === 'http' && (
        <>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.mcp.headers')}</span>
          {headers.map((r, i) => (
            <div key={i} className="pro-row" style={{ gap: 6 }}>
              <input className="pro-input pro-mono" placeholder="Authorization" value={r.name} onChange={(e) => setHeader(i, { name: e.target.value.replace(/[^A-Za-z0-9!#$%&'*+.^_`|~-]/g, '-') })} style={{ width: 200 }} />
              <input className="pro-input pro-mono" type={r.secret ? 'password' : 'text'} autoComplete="off" style={{ flex: 1 }}
                placeholder={r.secret ? (initial?.headersStored[r.name] ? t('pro.env.storedPh') : 'Bearer …') : t('pro.env.valuePh')}
                value={r.value} onChange={(e) => setHeader(i, { value: e.target.value })} />
              <button className={`pro-chip${r.secret ? ' pro-chip-on' : ''}`} onClick={() => setHeader(i, { secret: !r.secret })}>{t('pro.env.kind_secret')}</button>
              <button className="pro-btn" onClick={() => setHeaders((rows) => rows.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
          <button className="pro-btn" style={{ alignSelf: 'flex-start' }} onClick={() => setHeaders((rows) => [...rows, { name: '', value: '', secret: true }])}>+ {t('pro.mcp.header')}</button>
          <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.mcp.headerHint')}</span>
        </>
      )}
      <div className="pro-row" style={{ gap: 8 }}>
        <button className="pro-btn pro-btn-primary" disabled={!name.trim() || (kind === 'stdio' ? !command.trim() : !url.trim())} onClick={() => void save()}>{t('common.save')}</button>
        <button className="pro-btn" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </section>
  );
}
