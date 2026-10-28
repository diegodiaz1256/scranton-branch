import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import { Icon } from '@/components/Icon';
import { MCP_CATALOG, mcpCatalogEntry } from '@shared/mcpCatalog';
import type { Access } from '@shared/connectionAccess';
import { BUNDLE_ICONS, allRoleBundles, mcpLabel, type BundleIcon, type RoleBundle } from '@shared/roleBundles';
import { NATIVE_TOOL_GROUPS } from '@shared/nativeTools';
import { mcpDescription } from '@/i18n/catalogText';
import { useProStore } from './proStore';
import { Avatar } from './data';
import { effectiveServers } from './AgentView';
import { UnsandboxDialog } from './Unsandboxed';
import { unsandboxedAgents } from '@shared/unsandboxed';
import { cleanCriticalMap, custodianships } from '@shared/criticalConnections';
import { SshRelaySection } from './SshRelaySection';
import { CloudCredentialsSection } from './CloudCredentialsSection';
import { DockerSection } from './DockerSection';

/** A write/secret server is usable only once the user switched it on (Connections). */
function consented(config: HarnessConfig, id: string): boolean {
  const e = mcpCatalogEntry(id);
  if (!e) return false;
  return e.tier === 'safe-readonly' || config.mcpDefaults?.[id]?.enabled === true;
}

type Level = Access;
type Draft = { id?: string; label: string; icon: BundleIcon; servers: string[]; access?: Record<string, Level> };

/** Services that hold a key: the ones whose use a role can limit to reading. */
const isKeyed = (id: string): boolean => (mcpCatalogEntry(id)?.secrets ?? []).length > 0;
/** A role's level for a service; one it does not set is read-only. */
const levelOf = (access: Record<string, Level> | undefined, id: string): Level => access?.[id] ?? 'read';

/**
 * Capabilities — what each agent can reach. Grant a role bundle (a set of MCP
 * servers) to an agent in one click, make your own bundles (or start from a
 * built-in one), or adjust single servers per agent. Skills have their own page
 * (SkillsView). Grants apply when the agent next starts; a keyed server stays dimmed until it
 * is switched on with its key in Connections.
 */
export function CapabilitiesView({ roster, config }: { roster: Agent[]; config: HarnessConfig }) {
  const { t } = useTranslation();
  /** A built-in bundle's name in the app language; yours stay as you wrote them. */
  const bundleName = (b: RoleBundle) => (b.custom ? b.label : t(`pro.caps.bundle.${b.id}`, { defaultValue: b.label }));
  const setView = useProStore((s) => s.setView);
  const [target, setTarget] = useState<string | null>(roster.find((a) => !a.isGod)?.id ?? roster[0]?.id ?? null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const targetAgent = roster.find((a) => a.id === target);
  const bundles = allRoleBundles(config.customRoleBundles);
  const custom = bundles.filter((b) => b.custom);

  const grant = async (agentId: string, servers: string[] | undefined, access?: Record<string, Level>) => {
    setSaving(true);
    try {
      await window.cth.setAgentMcpGrant(agentId, servers, access);
      const who = roster.find((a) => a.id === agentId)?.name ?? agentId;
      setNote(t('pro.caps.saved', { name: who }));
    } catch (e) {
      setNote(String(e));
    } finally {
      setSaving(false);
    }
  };

  /** Take a Claude Code tool group away from an agent, or give it back. */
  const toggleTools = async (agentId: string, group: string) => {
    const all = { ...(config.agentToolBlocks ?? {}) };
    const cur = all[agentId] ?? [];
    const next = cur.includes(group) ? cur.filter((g) => g !== group) : [...cur, group];
    if (next.length) all[agentId] = next; else delete all[agentId];
    setSaving(true);
    try {
      await window.cth.updateConfig({ agentToolBlocks: all });
      const who = roster.find((a) => a.id === agentId)?.name ?? agentId;
      setNote(t('pro.caps.saved', { name: who }));
    } catch (e) {
      setNote(String(e));
    } finally {
      setSaving(false);
    }
  };

  /** Let an agent write outside its folders, or fence it back in. */
  const toggleRoam = async (agentId: string) => {
    const cur = config.agentRoam ?? [];
    const next = cur.includes(agentId) ? cur.filter((x) => x !== agentId) : [...cur, agentId];
    setSaving(true);
    try {
      await window.cth.updateConfig({ agentRoam: next });
      const who = roster.find((a) => a.id === agentId)?.name ?? agentId;
      setNote(t('pro.caps.saved', { name: who }));
    } catch (e) {
      setNote(String(e));
    } finally {
      setSaving(false);
    }
  };

  /** "Run without sandbox": off at once; on only after the warning, with the
   *  agent's name typed back (main checks it again and refuses a custodian). */
  const [unsandbox, setUnsandbox] = useState<{ id: string; name: string; error: string | null } | null>(null);
  const setUnsandboxed = async (agentId: string, on: boolean, typed?: string) => {
    const who = roster.find((a) => a.id === agentId)?.name ?? agentId;
    setSaving(true);
    try {
      const r = await window.cth.setAgentUnsandboxed(agentId, on, typed);
      if (!r.ok) {
        if (on) setUnsandbox({ id: agentId, name: who, error: r.error ?? null }); else setNote(r.error ?? null);
        return;
      }
      setUnsandbox(null);
      setNote(t(on ? 'pro.unsandboxed.turnedOn' : 'pro.unsandboxed.turnedOff', { name: who }));
    } catch (e) {
      setNote(String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (agentId: string, id: string) => {
    const cur = effectiveServers(config, agentId);
    // The levels already given stay; a service added by hand starts read-only.
    void grant(agentId, cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], config.agentMcpAccess?.[agentId] as Record<string, Level> | undefined);
  };

  /** Write the user's bundle list (config:changed refreshes `config`). */
  const saveBundles = async (next: Array<Omit<RoleBundle, 'custom'>>, done: string) => {
    setSaving(true);
    try {
      await window.cth.saveRoleBundles(next);
      setNote(done);
      setDraft(null);
    } catch (e) {
      setNote(String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = () => {
    if (!draft || !draft.label.trim()) return;
    const rest = custom.filter((b) => b.id !== draft.id).map(({ custom: _c, ...b }) => b);
    const access = {
      ...Object.fromEntries(draft.servers.filter(isKeyed).map((s) => [s, levelOf(draft.access, s)])),
      // REST API levels (api:<id>) set in the editor.
      ...Object.fromEntries(Object.entries(draft.access ?? {}).filter(([k]) => k.startsWith('api:')))
    };
    const edited = { id: draft.id ?? '', label: draft.label.trim(), icon: draft.icon, servers: draft.servers, access };
    const next = draft.id
      ? custom.map(({ custom: _c, ...b }) => (b.id === draft.id ? edited : b))
      : [...rest, edited];
    void saveBundles(next, t('pro.caps.bundleSaved', { name: edited.label }));
  };

  const remove = async (b: RoleBundle) => {
    if (!(await window.cth.confirm(t('pro.caps.deleteConfirm', { name: b.label }), { detail: t('pro.caps.deleteDetail'), ok: t('pro.caps.delete') }))) return;
    void saveBundles(custom.filter((x) => x.id !== b.id).map(({ custom: _c, ...x }) => x), t('pro.caps.bundleDeleted', { name: b.label }));
  };

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.nav.capabilities')}</h2>
        <span className="pro-sub">{t('pro.caps.sub')}</span>
        <div className="pro-head-end">
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.skills.openFromCaps')}</span>
          <button className="pro-btn" onClick={() => setView({ kind: 'section', section: 'skills' })}>{t('pro.nav.skills')}</button>
        </div>
      </div>

      <div className="pro-row">
        <span className="pro-sub">{t('pro.caps.grantTo')}</span>
        <select className="pro-input" value={target ?? ''} onChange={(e) => setTarget(e.target.value)}>
          {roster.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {note && <span className="pro-sub" style={{ fontSize: 12 }}>{note}</span>}
      </div>

      {draft && (
        <BundleEditor draft={draft} config={config} saving={saving}
          onChange={setDraft} onCancel={() => setDraft(null)} onSave={saveDraft}
          onConnections={() => setView({ kind: 'section', section: 'connections' })} />
      )}

      <div className="pro-grid">
        {bundles.map((b) => {
          const current = target ? effectiveServers(config, target) : [];
          const match = b.servers.length === current.length && b.servers.every((s) => current.includes(s));
          return (
            <article key={b.id} className="pro-card"
              style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 130, ...(match ? { background: 'var(--cth-lemon-light)', borderColor: 'var(--cth-lemon)' } : {}) }}>
              <span className="pro-row">
                <span style={{ display: 'inline-flex', padding: 8, borderRadius: 8, background: 'var(--cth-cream-200)' }}><Icon name={b.icon} /></span>
                <strong style={{ fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{bundleName(b)}</strong>
                {b.custom && <span className="pro-chip" style={{ marginInlineStart: 'auto' }}>{t('pro.caps.yours')}</span>}
              </span>
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1 }}>
                {b.servers.length === 0 && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.noServers')}</span>}
                {b.servers.map((s) => <span key={s} className={`pro-chip${consented(config, s) ? '' : ' pro-chip-off'}`}>{mcpLabel(s)}{isKeyed(s) ? ` · ${levelOf(b.access, s) === 'readwrite' ? t('pro.caps.accessWriteShort') : t('pro.caps.accessReadShort')}` : ''}</span>)}
              </span>
              <span className="pro-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <button className="pro-btn pro-btn-primary" disabled={!target || saving || match} onClick={() => target && void grant(target, b.servers, b.access)}>
                  {match ? t('pro.caps.hasIt', { name: targetAgent?.name ?? t('pro.nav.agent') }) : t('pro.caps.grantBtn', { name: targetAgent?.name ?? '…' })}
                </button>
                {b.custom ? (
                  <>
                    <button className="pro-btn" disabled={saving} onClick={() => setDraft({ id: b.id, label: b.label, icon: b.icon, servers: b.servers, access: b.access })}>{t('pro.caps.edit')}</button>
                    <button className="pro-btn" disabled={saving} onClick={() => remove(b)}>{t('pro.caps.delete')}</button>
                  </>
                ) : (
                  <button className="pro-btn" disabled={saving} title={t('pro.caps.duplicateTitle')}
                    onClick={() => setDraft({ label: t('pro.caps.copyOf', { name: bundleName(b) }), icon: b.icon, servers: b.servers, access: b.access })}>{t('pro.caps.duplicate')}</button>
                )}
              </span>
            </article>
          );
        })}
        <button className="pro-card" disabled={saving}
          style={{ borderStyle: 'dashed', minHeight: 130, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-500)' }}
          onClick={() => setDraft({ label: '', icon: 'mcp', servers: [] })}>
          + {t('pro.caps.newBundle')}
        </button>
      </div>

      {targetAgent && <SshRelaySection key={targetAgent.id} agent={targetAgent} config={config} />}
      {targetAgent && <CloudCredentialsSection key={`creds-${targetAgent.id}`} agent={targetAgent} config={config} />}
      {targetAgent && <DockerSection key={`docker-${targetAgent.id}`} agent={targetAgent} config={config} />}

      <h3 style={{ margin: '6px 0 0', fontSize: 14 }}>{t('pro.caps.whoHasWhat')}</h3>
      {roster.map((a) => {
        const has = effectiveServers(config, a.id);
        const ownGrant = !!config.agentMcpGrants?.[a.id];
        return (
          <div key={a.id} className="pro-card pro-row" style={{ flexWrap: 'wrap' }}>
            <span className="pro-row" style={{ width: 150 }}><Avatar agent={a} /><strong style={{ fontSize: 13 }}>{a.name}</strong></span>
            <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, flex: 1 }}>
              {NATIVE_TOOL_GROUPS.map((g) => {
                // The orchestrator delegates through the office: never Claude's sub-agents.
                const locked = g.id === 'subagents' && a.isGod;
                const on = !locked && !(config.agentToolBlocks?.[a.id] ?? []).includes(g.id);
                return (
                  <button key={g.id}
                    className={`pro-chip${on ? ' pro-chip-on' : ' pro-chip-off'}`}
                    style={{ cursor: locked ? 'default' : 'pointer' }}
                    title={locked ? t('pro.caps.lockedTitle') : `Claude Code: ${t(`pro.caps.tool.${g.id}Desc`, { defaultValue: g.description })}`}
                    disabled={saving || locked}
                    onClick={() => void toggleTools(a.id, g.id)}>
                    {t(`pro.caps.tool.${g.id}`, { defaultValue: g.label })}
                  </button>
                );
              })}
              {(() => {
                const on = (config.agentRoam ?? []).includes(a.id);
                return (
                  <button className={`pro-chip${on ? ' pro-chip-on' : ' pro-chip-off'}`} style={{ cursor: 'pointer' }}
                    title={t('pro.caps.tool.roamDesc')} disabled={saving} onClick={() => void toggleRoam(a.id)}>
                    {t('pro.caps.tool.roam')}
                  </button>
                );
              })()}
              {/* The app sets the OS sandbox for Claude Code and pi only. */}
              {(a.provider ?? 'claude') === 'claude' || a.provider === 'pi' ? (() => {
                const on = unsandboxedAgents(config.agentUnsandboxed).includes(a.id);
                const custodian = custodianships(cleanCriticalMap(config.criticalCustodians), a.id).length > 0;
                return (
                  <button className={`pro-chip${on ? ' pro-badge-unsandboxed' : ' pro-chip-off'}`} style={{ cursor: custodian ? 'default' : 'pointer' }}
                    title={custodian ? t('pro.unsandboxed.chipCustodian') : on ? t('pro.unsandboxed.badgeTip') : t('pro.unsandboxed.chipTip')}
                    aria-pressed={on} disabled={saving || (custodian && !on)}
                    onClick={() => (on ? void setUnsandboxed(a.id, false) : setUnsandbox({ id: a.id, name: a.name, error: null }))}>
                    {on ? `⚠ ${t('pro.unsandboxed.chip')}` : t('pro.unsandboxed.chip')}
                  </button>
                );
              })() : null}
              <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--cth-ink-100)' }} />
              {MCP_CATALOG.map((e) => {
                const on = has.includes(e.id);
                const usable = consented(config, e.id);
                return (
                  <button key={e.id}
                    className={`pro-chip${on && usable ? ' pro-chip-on' : ''}${!on ? ' pro-chip-off' : ''}`}
                    style={{ cursor: 'pointer', borderStyle: on && !usable ? 'dashed' : undefined }}
                    title={on && !usable ? t('pro.caps.notSwitchedOn', { name: e.label }) : mcpDescription(t, e.id, e.description)}
                    disabled={saving}
                    onClick={() => toggle(a.id, e.id)}>
                    {e.label}{on && isKeyed(e.id) ? ` · ${levelOf(config.agentMcpAccess?.[a.id] as Record<string, Level> | undefined, e.id) === 'readwrite' ? t('pro.caps.accessWriteShort') : t('pro.caps.accessReadShort')}` : ''}
                  </button>
                );
              })}
            </span>
            {ownGrant
              ? <button className="pro-btn" disabled={saving} onClick={() => void grant(a.id, undefined)}>{t('pro.caps.useDefaults')}</button>
              : <span className="pro-sub" style={{ fontSize: 11 }}>{t('pro.caps.workspaceDefaults')}</span>}
          </div>
        );
      })}
      <p className="pro-sub" style={{ fontSize: 12 }}>
        {t('pro.caps.footer')}{' '}
        <button className="pro-btn" style={{ padding: '1px 6px' }} onClick={() => setView({ kind: 'section', section: 'connections' })}>{t('pro.nav.connections')}</button>
      </p>
      {/* What the folder and git rules can and cannot see (shared/toolGuard.ts). */}
      <p className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.guardLimits')}</p>
      {unsandbox && (
        <UnsandboxDialog name={unsandbox.name} busy={saving} error={unsandbox.error}
          onCancel={() => setUnsandbox(null)} onConfirm={(typed) => void setUnsandboxed(unsandbox.id, true, typed)} />
      )}
    </div>
  );
}

function BundleEditor({ draft, config, saving, onChange, onCancel, onSave, onConnections }: {
  draft: Draft; config: HarnessConfig; saving: boolean;
  onChange: (d: Draft) => void; onCancel: () => void; onSave: () => void; onConnections: () => void;
}) {
  const { t } = useTranslation();
  const flip = (id: string) =>
    onChange({ ...draft, servers: draft.servers.includes(id) ? draft.servers.filter((s) => s !== id) : [...draft.servers, id] });
  // REST APIs (Connections → REST APIs): the role's level for each. Not set =
  // read-only, as for an agent with no role.
  const [apis, setApis] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => { void window.cth.integrationsList().then((r) => setApis(r.map((x) => ({ id: x.id, label: x.label })))).catch(() => {}); }, []);
  const needsKey = draft.servers.filter((s) => !consented(config, s));
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 12, borderColor: 'var(--cth-lemon)' }}>
      <div className="pro-row">
        <strong style={{ fontSize: 14 }}>{draft.id ? t('pro.caps.editBundle') : t('pro.caps.newBundle')}</strong>
      </div>
      <div className="pro-row" style={{ flexWrap: 'wrap' }}>
        <input className="pro-input" style={{ flex: 1, minWidth: 200 }} placeholder={t('pro.caps.namePlaceholder')} maxLength={40} autoFocus
          value={draft.label} onChange={(e) => onChange({ ...draft, label: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel(); }} />
        <div className="pro-row" role="radiogroup" aria-label={t('pro.caps.icon')} style={{ gap: 4 }}>
          {BUNDLE_ICONS.map((ic) => (
            <button key={ic} role="radio" aria-checked={draft.icon === ic} title={ic}
              className="pro-btn" style={{ padding: 5, background: draft.icon === ic ? 'var(--cth-lemon-light)' : undefined, borderColor: draft.icon === ic ? 'var(--cth-lemon)' : undefined }}
              onClick={() => onChange({ ...draft, icon: ic })}><Icon name={ic} /></button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {MCP_CATALOG.map((e) => {
          const on = draft.servers.includes(e.id);
          return (
            <button key={e.id} aria-pressed={on} title={mcpDescription(t, e.id, e.description)}
              className={`pro-chip${on ? ' pro-chip-on' : ' pro-chip-off'}`} style={{ cursor: 'pointer' }}
              onClick={() => flip(e.id)}>{on ? '✓ ' : ''}{e.label}</button>
          );
        })}
      </div>
      {apis.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.apiHelp')}</span>
          {apis.map((a) => {
            const cur = draft.access?.[`api:${a.id}`] ?? 'read';
            return (
              <div key={a.id} className="pro-row" style={{ gap: 8 }}>
                <span style={{ minWidth: 120, fontSize: 13 }}>{a.label}</span>
                <div className="pro-switch" role="radiogroup" aria-label={a.label}>
                  {(['none', 'read', 'readwrite'] as const).map((lv) => (
                    <button key={lv} role="radio" aria-checked={cur === lv} aria-pressed={cur === lv}
                      onClick={() => onChange({ ...draft, access: { ...(draft.access ?? {}), [`api:${a.id}`]: lv } })}>
                      {lv === 'none' ? t('pro.conn.access_none') : lv === 'read' ? t('pro.caps.accessRead') : t('pro.caps.accessWrite')}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {draft.servers.filter(isKeyed).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.accessHelp')}</span>
          {draft.servers.filter(isKeyed).map((s) => (
            <div key={s} className="pro-row" style={{ gap: 8 }}>
              <span style={{ minWidth: 120, fontSize: 13 }}>{mcpLabel(s)}</span>
              <div className="pro-switch" role="radiogroup" aria-label={mcpLabel(s)}>
                {(['read', 'readwrite'] as const).map((lv) => (
                  <button key={lv} role="radio" aria-checked={levelOf(draft.access, s) === lv} aria-pressed={levelOf(draft.access, s) === lv}
                    onClick={() => onChange({ ...draft, access: { ...(draft.access ?? {}), [s]: lv } })}>
                    {lv === 'read' ? t('pro.caps.accessRead') : t('pro.caps.accessWrite')}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {needsKey.length > 0 && (
        <p className="pro-sub" style={{ fontSize: 12, margin: 0 }}>
          {t(needsKey.length === 1 ? 'pro.caps.needsKeyOne' : 'pro.caps.needsKeyMany', { names: needsKey.map(mcpLabel).join(', ') })}{' '}
          <button className="pro-btn" style={{ padding: '1px 6px' }} onClick={onConnections}>{t('pro.caps.setUpInConnections')}</button>
        </p>
      )}
      <div className="pro-row">
        <button className="pro-btn pro-btn-primary" disabled={saving || !draft.label.trim()} onClick={onSave}>{saving ? t('settings.saving') : t('pro.caps.saveBundle')}</button>
        <button className="pro-btn" disabled={saving} onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </section>
  );
}
