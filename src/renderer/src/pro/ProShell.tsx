import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { APP_NAME, LAYOUT_LABELS } from '@shared/fork';
import { FloorSwitcher } from './FloorSwitcher';
import type { HarnessConfig } from '@/store/config';
import { useStore } from '@/store/store';
import { ProIcon, type ProIconName } from './ProIcon';
import { waitsOnHuman } from '@/components/TasksKanban';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useProStore, type ProSection } from './proStore';
import { Avatar, TONE_COLOR, askingAgents, isActive, useDirectory, useRoster, useTasks } from './data';
import { TasksView } from './TasksView';
import { InboxView } from './InboxView';
import { AutomationsView } from './AutomationsView';
import { MemoryView } from './MemoryView';
import { CapabilitiesView } from './CapabilitiesView';
import { SkillsView } from './SkillsView';
import { AgentsView } from './AgentsView';
import { AgentView } from './AgentView';
import { TempsView } from './TempsView';
import { ConnectionsView } from './ConnectionsView';
import { TeamView } from './TeamView';
import { FactoriesView } from './FactoriesView';
import { EnvironmentView } from './EnvironmentView';
import { McpView } from './McpView';
import { ProvidersView } from './ProvidersView';
import { DeliverablesView } from './DeliverablesView';
import { BootBanner } from './BootBanner';
import { NowView } from './NowView';
import { ThreadView } from './ThreadView';
import { EASY_HOME, EASY_NAV_ESSENTIALS, isEasyMode, splitForEasyMode } from '@shared/uiMode';
import './pro.css';

/** Sections in the sidebar; their names are `pro.nav.<id>`. */
const TOP: { id: ProSection; icon: ProIconName }[] = [
  // Easy mode only (Full mode's groups below do not list it): the readable thread.
  { id: 'thread', icon: 'thread' },
  { id: 'now', icon: 'now' },
  { id: 'tasks', icon: 'tasks' },
  { id: 'inbox', icon: 'inbox' },
  { id: 'deliverables', icon: 'deliverables' },
  { id: 'automations', icon: 'automations' },
  { id: 'memory', icon: 'memory' },
  { id: 'skills', icon: 'skills' },
  { id: 'capabilities', icon: 'capabilities' },
  { id: 'connections', icon: 'connections' },
  { id: 'environment', icon: 'environment' },
  { id: 'providers', icon: 'providers' },
  { id: 'mcp', icon: 'mcp' },
  { id: 'team', icon: 'team' },
  { id: 'factories', icon: 'factories' }
];

/** The sidebar in groups: the daily pages always shown, the rest folded. Twelve
 *  entries in a row read as clutter; settings-like pages are opened rarely. */
const NAV_GROUPS: Array<{ id: string; label?: string; items: ProSection[] }> = [
  { id: 'main', items: ['now', 'tasks', 'inbox', 'deliverables'] },
  { id: 'office', label: 'group_office', items: ['automations', 'memory', 'skills', 'team', 'factories'] },
  { id: 'setup', label: 'group_setup', items: ['capabilities', 'connections', 'environment', 'providers', 'mcp'] }
];
/** Easy mode (src/shared/uiMode.ts): the daily pages on top, the agents under
 *  them, and every other page (Temps included) in one "Advanced" group, folded
 *  until opened. The same pages as Full mode, none removed. */
const ALL_ITEMS: { id: ProSection; icon: ProIconName }[] = [...TOP, { id: 'temps', icon: 'temps' }];
const EASY_SPLIT = splitForEasyMode(ALL_ITEMS.map((i) => i.id), EASY_NAV_ESSENTIALS);
const EASY_MAIN = { id: 'main', items: EASY_SPLIT.essential };
const EASY_ADVANCED = { id: 'advanced', label: 'group_advanced', items: EASY_SPLIT.advanced };
const LS_GROUPS = 'cth.proNavGroups';
function readGroups(): Record<string, boolean> {
  try { const v = JSON.parse(window.localStorage.getItem(LS_GROUPS) ?? '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/**
 * PRO — the office in a sidebar, one screen at a time. Replaces the Classic
 * floor + detail sidebar + agent strip when the title-bar switch says PRO; the
 * hive underneath (god, routing, PTYs, queues) is the same one, so switching
 * back and forth never touches a running agent.
 */
const LS_SIDE_HIDDEN = 'cth.pro.sideHidden';
/** Easy mode opens on the thread once per app start, whatever page was left open. */
let landed = false;

export function ProShell({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const view = useProStore((s) => s.view);
  const setView = useProStore((s) => s.setView);
  const roster = useRoster();
  const tasks = useTasks();
  const directory = useDirectory();
  const asking = useMemo(() => askingAgents(tasks), [tasks]);
  const openAsks = tasks.filter(waitsOnHuman).length;
  const god = roster.find((a) => a.isGod);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(readGroups);
  // In a small window the sidebar takes width the terminal needs: it can be
  // folded away, and the choice is remembered on this machine.
  const [sideHidden, setSideHidden] = useState<boolean>(() => {
    try { return window.localStorage.getItem(LS_SIDE_HIDDEN) === '1'; } catch { return false; }
  });
  const toggleSide = () => setSideHidden((v) => {
    try { window.localStorage.setItem(LS_SIDE_HIDDEN, v ? '0' : '1'); } catch { /* noop */ }
    return !v;
  });
  const toggleGroup = (id: string): void => setOpenGroups((g) => {
    const next = { ...g, [id]: !g[id] };
    try { window.localStorage.setItem(LS_GROUPS, JSON.stringify(next)); } catch { /* private window */ }
    return next;
  });
  // The boot-time "restore your team" lives in this hook, and Classic mounts it
  // from the agent strip — which PRO replaces. Without it here, opening the app
  // in PRO left every worker from the last session unrestored.
  useRestoreTeam(config);

  const easy = isEasyMode(config);
  useEffect(() => {
    if (landed) return;
    landed = true;
    if (easy) setView({ kind: 'section', section: EASY_HOME });
  }, []); // once, at the first mount

  // An agent view whose agent left the floor falls back to the roster.
  const agentInView = view.kind === 'agent' ? roster.find((a) => a.id === view.agentId) : undefined;
  const section: ProSection | null = view.kind === 'section' ? view.section : agentInView ? null : 'agents';

  const go = (s: ProSection) => setView({ kind: 'section', section: s });
  const openAgent = (id: string) => {
    useStore.getState().select(id);
    setView({ kind: 'agent', agentId: id });
  };

  const renderGroup = (g: { id: string; label?: string; items: ProSection[] }): JSX.Element => {
    const items = ALL_ITEMS.filter((i) => g.items.includes(i.id));
    // The group holding the open page stays open, whatever was saved.
    const open = !g.label || openGroups[g.id] || items.some((i) => i.id === section);
    return (
      <div key={g.id} style={{ display: 'contents' }}>
        {g.label && (
          <button className="pro-nav pro-nav-group" aria-expanded={open} onClick={() => toggleGroup(g.id)}>
            <span aria-hidden style={{ width: 16, textAlign: 'center' }}>{open ? '▾' : '▸'}</span> {t(`pro.nav.${g.label}`)}
          </button>
        )}
        {open && items.map((item) => (
          <button key={item.id} className="pro-nav" aria-current={section === item.id} onClick={() => go(item.id)} style={g.label ? { paddingInlineStart: 22 } : undefined}>
            <ProIcon name={item.icon} /> {t(`pro.nav.${item.id}`)}
            {(item.id === 'inbox' || item.id === 'thread') && openAsks > 0 && <span className="pro-nav-end"><span className="pro-count">{openAsks}</span></span>}
          </button>
        ))}
      </div>
    );
  };

  let page: JSX.Element;
  switch (section) {
    case 'thread': page = <ThreadView tasks={tasks} roster={roster} onOpen={openAgent} />; break;
    case 'now': page = <NowView />; break;
    case 'tasks': page = <TasksView tasks={tasks} roster={roster} />; break;
    case 'inbox': page = <InboxView tasks={tasks} />; break;
    case 'deliverables': page = <DeliverablesView tasks={tasks} roster={roster} />; break;
    case 'automations': page = <AutomationsView />; break;
    case 'memory': page = <MemoryView tasks={tasks} roster={roster} />; break;
    case 'skills': page = <SkillsView roster={roster} config={config} />; break;
    case 'capabilities': page = <CapabilitiesView roster={roster} config={config} />; break;
    case 'temps': page = <TempsView roster={roster} />; break;
    case 'connections': page = <ConnectionsView roster={roster} config={config} />; break;
    case 'team': page = <TeamView />; break;
    case 'factories': page = <FactoriesView />; break;
    case 'environment': page = <EnvironmentView roster={roster} />; break;
    case 'providers': page = <ProvidersView config={config} />; break;
    case 'mcp': page = <McpView roster={roster} config={config} />; break;
    case 'agents': page = <AgentsView roster={roster} tasks={tasks} directory={directory} asking={asking} config={config} onOpen={openAgent} />; break;
    default: page = <AgentView agent={agentInView!} roster={roster} tasks={tasks} directory={directory} config={config} onOpen={openAgent} />;
  }

  return (
    <div className="pro-root">
      {!sideHidden && <nav className="pro-side" aria-label={t('pro.nav.aria')}>
        <div className="pro-brand">
          <Avatar agent={god} />
          <span style={{ display: 'flex', flexDirection: 'column', lineHeight: '15px' }}>
            <span>{APP_NAME}</span>
            <FloorSwitcher office={config.harnessHome ?? null} enabled={config.multiWindow !== false} />
          </span>
          <button className="pro-side-toggle" title={t('pro.nav.hideMenu')} aria-label={t('pro.nav.hideMenu')} onClick={toggleSide}>«</button>
        </div>
        {(easy ? [EASY_MAIN] : NAV_GROUPS).map(renderGroup)}

        <div className="pro-side-label">{t('pro.nav.agents')}</div>
        <button className="pro-nav" aria-current={section === 'agents'} onClick={() => go('agents')}>
          <ProIcon name="agents" /> {t('pro.nav.agents')}
          <span className="pro-nav-end pro-sub" style={{ fontSize: 11 }}>
            {t('pro.nav.active', { count: roster.filter(isActive).length })}
          </span>
        </button>
        {roster.map((a) => {
          const active = isActive(a);
          const ctx = a.contextTokens && a.contextLimit ? Math.round((a.contextTokens / a.contextLimit) * 100) : null;
          return (
            <button
              key={a.id}
              className="pro-nav"
              style={{ paddingBlock: 3 }}
              aria-current={view.kind === 'agent' && view.agentId === a.id}
              onClick={() => openAgent(a.id)}
              title={a.description}
            >
              <Avatar agent={a} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: '15px' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                <span className="pro-sub" style={{ fontSize: 11 }}>
                  {asking.has(a.id) ? t('pro.nav.askedYou')
                    : a.isGod ? `★ ${t('pro.nav.orchestrator')}`
                    : ctx !== null ? `ctx ${ctx}%` : (a.model ?? a.provider ?? t('pro.nav.agent'))}
                </span>
              </span>
              <span className="pro-nav-end">
                <span className="pro-dot" style={{ background: TONE_COLOR[active ? 'green' : 'grey'] }} title={active ? t('pro.nav.activeOne') : t('pro.nav.idle')} />
              </span>
            </button>
          );
        })}
        {easy ? (
          <><div aria-hidden style={{ height: 4, flexShrink: 0 }} />{renderGroup(EASY_ADVANCED)}</>
        ) : (
          <button className="pro-nav" style={{ marginTop: 4 }} aria-current={section === 'temps'} onClick={() => go('temps')}>
            <ProIcon name="temps" /> {t('pro.nav.temps')}
          </button>
        )}
      </nav>}
      <main className="pro-main">
        {sideHidden && (
          <button className="pro-side-toggle pro-side-show" title={t('pro.nav.showMenu')} aria-label={t('pro.nav.showMenu')} onClick={toggleSide}>» {t('pro.nav.menu')}</button>
        )}
        <BootBanner />{page}
      </main>
    </div>
  );
}

/** Floor / Manager switch for the title bar. */
export function LayoutSwitch() {
  const { t } = useTranslation();
  const layout = useProStore((s) => s.layout);
  const setLayout = useProStore((s) => s.setLayout);
  return (
    <div className="pro-switch cth-titlebar-nodrag" role="group" aria-label={t('pro.layout.aria')}>
      <button aria-pressed={layout === 'classic'} onClick={() => setLayout('classic')}>{t('pro.layout.classic', { defaultValue: LAYOUT_LABELS.classic })}</button>
      <button aria-pressed={layout === 'pro'} onClick={() => setLayout('pro')}>{t('pro.layout.pro', { defaultValue: LAYOUT_LABELS.pro })}</button>
    </div>
  );
}
