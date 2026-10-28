import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import type { EnvVarView, MemoryStatus } from '../../../preload/index';
import { MCP_CATALOG, mcpCatalogEntry } from '@shared/mcpCatalog';
import { allRoleBundles, mcpLabel, type RoleBundle } from '@shared/roleBundles';
import {
  agentPowers, connectionState, hasSimpleView, isRiskyPower, memoryState, secretsSummary, sortConnections
} from '@shared/easyConfig';
import { SkillsTab } from '@/components/SkillsTab';
import { Avatar } from './data';
import { effectiveServers } from './AgentView';
import { custodianFor } from './CriticalConnection';
import type { ProSection } from './proStore';

type Connection = Awaited<ReturnType<typeof window.cth.connectionsList>>[number];

/** "Show all options" open for a page, remembered on this machine. */
function useShowAll(page: string): [boolean, (v: boolean) => void] {
  const key = `cth.easy.showAll.${page}`;
  const [open, setOpen] = useState<boolean>(() => {
    try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const set = (v: boolean) => {
    setOpen(v);
    try { window.localStorage.setItem(key, v ? '1' : '0'); } catch { /* storage unavailable */ }
  };
  return [open, set];
}

/**
 * A Manager configuration page in Easy mode (src/shared/easyConfig.ts): the
 * page's plain name, what it is and when to use it, then its few simple
 * decisions, and the unchanged full page behind "Show all options". Pages
 * without a simple view show the explanation and then the full page.
 */
export function EasyPage({ page, full, config, roster }: { page: ProSection; full: JSX.Element; config: HarnessConfig; roster: Agent[] }) {
  const { t } = useTranslation();
  const simple = hasSimpleView(page);
  const [showAll, setShowAll] = useShowAll(page);
  const openAll = () => setShowAll(true);
  let body: ReactNode = null;
  switch (page) {
    case 'connections': body = <EasyConnections config={config} onSetUp={openAll} />; break;
    case 'capabilities': body = <EasyCapabilities config={config} roster={roster} />; break;
    case 'environment': body = <EasyEnvironment onAdd={openAll} />; break;
    case 'memory': body = <EasyMemory />; break;
    case 'skills': body = <EasySkills onMore={openAll} />; break;
  }
  return (
    <div className="pro-page pro-easy">
      <div className="pro-head"><h2>{t(`pro.easy.nav.${page}`)}</h2></div>
      <dl className="pro-easy-intro">
        <dt>{t('pro.easy.whatLabel')}</dt><dd>{t(`pro.easy.page.${page}.what`)}</dd>
        <dt>{t('pro.easy.whenLabel')}</dt><dd>{t(`pro.easy.page.${page}.when`)}</dd>
      </dl>
      {simple && body && <section className="pro-easy-simple">{body}</section>}
      {simple && (
        <button className="pro-btn" style={{ alignSelf: 'flex-start' }} aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? `▴ ${t('pro.easy.hideAll')}` : `▾ ${t('pro.easy.showAll')}`}
        </button>
      )}
      {(!simple || showAll) && (
        <div className="pro-easy-full" aria-label={t('pro.easy.allTitle')}>{full}</div>
      )}
    </div>
  );
}

/** One line of the simple view: a name on the left, its status on the right. */
function Line({ lead, children }: { lead: ReactNode; children: ReactNode }) {
  return (
    <div className="pro-easy-line">
      <span className="pro-row" style={{ minWidth: 0, gap: 8 }}>{lead}</span>
      <span className="pro-row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 }}>{children}</span>
    </div>
  );
}

/** The dot beside a connection's state (the words carry the meaning). */
const STATE_DOT = { connected: 'var(--pro-green)', needsKey: 'var(--cth-peach)', off: 'var(--cth-ink-300)' } as const;

function EasyConnections({ config, onSetUp }: { config: HarnessConfig; onSetUp: () => void }) {
  const { t } = useTranslation();
  const [list, setList] = useState<Connection[] | null>(null);
  useEffect(() => { void window.cth.connectionsList().then(setList).catch(() => setList([])); }, []);
  if (!list) return null;
  // Only what was set up (or is switched on); the catalogue of every app is in all options.
  const shown = sortConnections(list.filter((c) => c.enabled || c.fields.some((f) => f.stored)));
  const connected = shown.filter((c) => connectionState(c) === 'connected').length;
  return (
    <>
      <p className="pro-text"><strong>{shown.length ? t('pro.easy.conn.summary', { connected, total: shown.length }) : t('pro.easy.conn.none')}</strong></p>
      {shown.map((c) => {
        const state = connectionState(c);
        const critical = custodianFor(config, 'mcp', c.id) !== undefined;
        return (
          <Line key={c.id} lead={<span>{c.label}{c.label !== c.serviceLabel && <span className="pro-sub"> · {c.serviceLabel}</span>}</span>}>
            {critical && <span className="pro-sub" title={t('pro.easy.conn.signoffTip')}>{t('pro.easy.conn.signoff')}</span>}
            <span className="pro-row" style={{ gap: 6, fontWeight: 600, color: state === 'off' ? 'var(--pro-muted)' : 'var(--pro-text)' }}><span className="pro-dot" aria-hidden style={{ background: STATE_DOT[state] }} />{t(`pro.easy.conn.${state}`)}</span>
          </Line>
        );
      })}
      <button className="pro-btn pro-btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onSetUp}>+ {t('pro.easy.conn.setUp')}</button>
    </>
  );
}

/** A keyed app is usable only once it was switched on with its key (Connections). */
function usable(config: HarnessConfig, id: string): boolean {
  const e = mcpCatalogEntry(id);
  if (!e) return false;
  return e.tier === 'safe-readonly' || config.mcpDefaults?.[id]?.enabled === true;
}

function EasyCapabilities({ config, roster }: { config: HarnessConfig; roster: Agent[] }) {
  const { t } = useTranslation();
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bundles = allRoleBundles(config.customRoleBundles);
  const bundleName = (b: RoleBundle) => (b.custom ? b.label : t(`pro.caps.bundle.${b.id}`, { defaultValue: b.label }));
  const agents = roster.filter((a) => !a.archived);

  const setRole = async (agent: Agent, value: string) => {
    const b = bundles.find((x) => x.id === value);
    setSaving(true);
    try {
      // '' = back to the office default (no grant of its own).
      await window.cth.setAgentMcpGrant(agent.id, b ? b.servers : undefined, b?.access);
      setNote(t('pro.caps.saved', { name: agent.name }));
    } catch (e) {
      setNote(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!agents.length) return <p className="pro-sub">{t('pro.easy.caps.noAgents')}</p>;
  return (
    <>
      {agents.map((a) => {
        const has = effectiveServers(config, a.id);
        const own = !!config.agentMcpGrants?.[a.id];
        const match = own ? bundles.find((b) => b.servers.length === has.length && b.servers.every((s) => has.includes(s))) : undefined;
        const value = !own ? '' : match ? match.id : '__custom';
        const apps = MCP_CATALOG.filter((e) => has.includes(e.id) && usable(config, e.id)).map((e) => mcpLabel(e.id));
        const powers = agentPowers(config, a.id);
        return (
          <div key={a.id} className="pro-easy-agent">
            <Line lead={<><Avatar agent={a} /><strong style={{ fontSize: 13 }}>{a.name}</strong></>}>
              <label className="pro-row" style={{ gap: 6 }} title={t('pro.easy.caps.roleTip')}>
                <span className="pro-sub">{t('pro.easy.caps.role')}</span>
                <select className="pro-input" value={value} disabled={saving} onChange={(e) => void setRole(a, e.target.value)}>
                  <option value="">{t('pro.easy.caps.officeDefault')}</option>
                  {bundles.map((b) => <option key={b.id} value={b.id}>{bundleName(b)}</option>)}
                  {value === '__custom' && <option value="__custom" disabled>{t('pro.easy.caps.custom')}</option>}
                </select>
              </label>
            </Line>
            <span className="pro-sub">{apps.length ? t('pro.easy.caps.canUse', { names: apps.join(', ') }) : t('pro.easy.caps.usesNothing')}</span>
            <span className="pro-row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {!powers.some(isRiskyPower) && <span className="pro-chip pro-chip-on" title={t('pro.easy.caps.fencedTip')}>{t('pro.easy.caps.fenced')}</span>}
              {powers.map((p) => (
                <span key={p} className={`pro-chip${isRiskyPower(p) ? ' pro-badge-unsandboxed' : ''}`}
                  title={p === 'roam' ? undefined : t(`pro.easy.caps.power_${p}Tip`)}>{t(`pro.easy.caps.power_${p}`)}</span>
              ))}
            </span>
          </div>
        );
      })}
      {note && <span className="pro-sub" role="status">{note}</span>}
      <p className="pro-sub" style={{ margin: 0 }}>{t('pro.easy.caps.powersNote')}</p>
    </>
  );
}

function EasyEnvironment({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation();
  const [vars, setVars] = useState<EnvVarView[] | null>(null);
  useEffect(() => { void window.cth.envList().then((r) => setVars(r.vars)).catch(() => setVars([])); }, []);
  if (!vars) return null;
  const { passwords, settings } = secretsSummary(vars);
  const secrets = vars.filter((v) => v.kind !== 'plain').sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <p className="pro-text"><strong>{passwords ? t('pro.easy.env.summary', { count: passwords }) : t('pro.easy.env.none')}</strong></p>
      {secrets.map((v) => (
        <Line key={v.name} lead={<span>{v.note || v.name}</span>}>
          <span className="pro-sub">{t(`pro.easy.env.kind_${v.kind}`)}</span>
        </Line>
      ))}
      {settings > 0 && <span className="pro-sub">{t('pro.easy.env.settings', { count: settings })}</span>}
      <button className="pro-btn pro-btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onAdd}>+ {t('pro.easy.env.add')}</button>
    </>
  );
}

function EasyMemory() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => { void window.cth.memoryStatus().then(setStatus).catch(() => {}); }, []);
  useEffect(reload, [reload]);
  const state = memoryState(status);
  const flip = async () => {
    if (!status) return;
    setBusy(true);
    try { await window.cth.updateConfig({ semanticMemory: !status.enabled }); } finally { setBusy(false); reload(); }
  };
  return (
    <Line lead={<strong style={{ fontSize: 13 }}>{t('pro.easy.memory.label')}</strong>}>
      <span className="pro-text">{t(`pro.easy.memory.state_${state}`)}</span>
      {status && (
        <button className="pro-btn" disabled={busy} aria-pressed={status.enabled} onClick={() => void flip()}>
          {status.enabled ? t('pro.easy.memory.turnOff') : t('pro.easy.memory.turnOn')}
        </button>
      )}
    </Line>
  );
}

function EasySkills({ onMore }: { onMore: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <strong style={{ fontSize: 13 }}>{t('pro.easy.skills.installed')}</strong>
      <div className="pro-card pro-embed" style={{ padding: 0, height: 280, flex: 'none' }}>
        <SkillsTab mode="installed" />
      </div>
      <button className="pro-btn pro-btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onMore}>+ {t('pro.easy.skills.findMore')}</button>
    </>
  );
}
