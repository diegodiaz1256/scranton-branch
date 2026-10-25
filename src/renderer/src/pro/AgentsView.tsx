import { terminalUsage } from '@/components/terminalPool';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currentStep, exitedCode } from '@shared/officeActivity';
import { useOfficeActivity } from './activityStore';
import { useActivityText } from './NowView';
import { actionLabel } from '@/scene/office/actionLabel';
import type { TFunction } from 'i18next';
import type { HarnessConfig } from '@/store/config';
import { useStore, type Agent } from '@/store/store';
import { MessageQueueComposer } from '@/components/MessageQueueComposer';
import { waitsOnHuman } from '@/components/TasksKanban';
import { respawnAgent } from '@/hooks/useRestoreTeam';
import { useProStore } from './proStore';
import { CustodianBadge } from './CriticalConnection';
import { ImportAgentButton } from './AgentFileDialogs';
import { UnsandboxedBadge } from './Unsandboxed';
import { unsandboxedAgents } from '@shared/unsandboxed';
import {
  Avatar, Bar, GodBadge, StateBadge, agentState, fmtTokens, stripAnsi, usePoll, useTerminalTail,
  type AgentDirectoryEntry, type KeyedTask
} from './data';

interface Props {
  roster: Agent[];
  tasks: KeyedTask[];
  directory: Record<string, AgentDirectoryEntry>;
  asking: Set<string>;
  config: HarnessConfig;
  onOpen: (id: string) => void;
}

/** The ticket an agent is on: its newest `doing` card, else its newest open one. */
export function currentTicket(tasks: KeyedTask[], agentId: string): KeyedTask | undefined {
  const mine = tasks.filter((t) => t.assignee === agentId && t.status !== 'done');
  const by = (s: string) => mine.filter((t) => t.status === s).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return by('doing') ?? by('blocked') ?? by('todo');
}

/** Floor spend vs the user's budget, for the orchestrator card and his room. */
export function spendLine(directory: Record<string, AgentDirectoryEntry>, config: HarnessConfig, t?: TFunction) {
  const rows = Object.values(directory).filter((d) => !d.archived);
  const usd = rows.reduce((n, d) => n + (d.usd || 0), 0);
  const tokens = rows.reduce((n, d) => n + (d.tokens || 0), 0);
  const tr = (key: string, en: string, params: Record<string, string> = {}) => (t ? t(`pro.spend.${key}`, params) : en);
  if (config.costCapUsd) return { main: `$${usd.toFixed(2)}`, sub: tr('ofCap', `of $${config.costCapUsd} cap`, { cap: String(config.costCapUsd) }), ratio: usd / config.costCapUsd };
  if (config.costCapTokens) return { main: `$${usd.toFixed(2)}`, sub: tr('ofTokens', `${fmtTokens(tokens)} of ${fmtTokens(config.costCapTokens)} tok`, { used: fmtTokens(tokens), cap: fmtTokens(config.costCapTokens) }), ratio: tokens / config.costCapTokens };
  return { main: `$${usd.toFixed(2)}`, sub: tr('noCap', 'no cap set'), ratio: 0 };
}

export function AgentsView({ roster, tasks, directory, asking, config, onOpen }: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const setView = useProStore((s) => s.setView);
  const god = roster.find((a) => a.isGod);
  const workers = roster.filter((a) => !a.isGod);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return workers;
    return workers.filter((a) => `${a.name} ${a.description} ${a.model ?? ''}`.toLowerCase().includes(needle));
  }, [workers, q]);

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.agents.title')}</h2>
        <span className="pro-sub">{t('pro.agents.count', { count: roster.length })}</span>
        <div className="pro-head-end">
          <input className="pro-input" placeholder={t('pro.agents.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="pro-btn" onClick={() => setView({ kind: 'section', section: 'capabilities' })}>{t('pro.nav.capabilities')}</button>
          <ImportAgentButton config={config} />
          <button className="pro-btn pro-btn-primary" onClick={() => useStore.getState().setAddAgentOpen(true)}>{t('pro.agents.add')}</button>
        </div>
      </div>

      {god && <OrchestratorCard god={god} tasks={tasks} directory={directory} config={config} onOpen={onOpen} />}

      <div className="pro-grid">
        {shown.map((a) => (
          <AgentTile key={a.id} agent={a} ticket={currentTicket(tasks, a.id)} dir={directory[a.id]} asksYou={asking.has(a.id)} config={config} onOpen={onOpen} />
        ))}
        <button
          className="pro-card"
          style={{ borderStyle: 'dashed', minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cth-ink-500)' }}
          onClick={() => useStore.getState().setAddAgentOpen(true)}
        >
          + {t('pro.agents.add')}
        </button>
      </div>

      <ArchivedAgents config={config} />
    </div>
  );
}

/** Agents whose terminal was closed. Their workspace (memory, inbox, session)
 *  is kept, so Reopen respawns them with the same id, folder and model and
 *  resumes the conversation where it stopped. */
function ArchivedAgents({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const archived = useStore((s) => s.archivedAgents);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (archived.length === 0) return null;

  const reopen = async (a: Agent) => {
    setBusy(a.id);
    setErrors((e) => ({ ...e, [a.id]: '' }));
    const r = await respawnAgent(a, config, true);
    setBusy(null);
    if (r.ok) useStore.getState().addAgent(r.agent); // addAgent also drops it from the archive
    else if (r.alreadyLive) useStore.getState().removeArchivedAgent(a.id);
    else setErrors((e) => ({ ...e, [a.id]: r.error }));
  };

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <button className="pro-btn" style={{ alignSelf: 'flex-start' }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {t('pro.agents.archived', { count: archived.length })}
      </button>
      {open && archived.map((a) => (
        <article key={a.id} className="pro-card pro-row" style={{ padding: '10px 14px' }}>
          <Avatar agent={a} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="pro-title">{a.name}</p>
            <p className="pro-text" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.description}</p>
            {errors[a.id] && <p className="pro-text" style={{ color: 'var(--cth-coral)' }}>{t('pro.agents.couldNotReopen', { error: errors[a.id] })}</p>}
          </div>
          <span className="pro-sub pro-mono" style={{ fontSize: 11 }}>{a.model ?? a.provider ?? ''}</span>
          <button className="pro-btn" disabled={busy !== null} onClick={() => void reopen(a)}>{busy === a.id ? t('pro.agents.reopening') : t('pro.agents.reopen')}</button>
        </article>
      ))}
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pro-card" style={{ padding: '10px 12px' }}>
      <div className="pro-sub" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 4, display: 'flex', alignItems: 'baseline', gap: 6 }}>{children}</div>
    </div>
  );
}

function OrchestratorCard({ god, tasks, directory, config, onOpen }: {
  god: Agent; tasks: KeyedTask[]; directory: Record<string, AgentDirectoryEntry>; config: HarnessConfig; onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const spend = spendLine(directory, config, t);
  const breaker = directory[god.id]?.breaker || 'healthy';
  const doing = tasks.filter((t) => t.status === 'doing').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const asks = tasks.filter(waitsOnHuman).length;
  const st = agentState(god, false);
  const ctx = god.contextTokens && god.contextLimit ? Math.round((god.contextTokens / god.contextLimit) * 100) : null;
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="pro-row">
        <Avatar agent={god} scale={1.5} />
        <div style={{ minWidth: 0 }}>
          <div className="pro-row" style={{ gap: 8 }}>
            <button className="pro-title" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit' }} onClick={() => onOpen(god.id)}>{god.name}</button>
            <GodBadge />
          </div>
          <div className="pro-sub" style={{ fontSize: 12 }}>
            {[god.model ?? god.provider, ctx !== null ? `ctx ${ctx}%` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span style={{ marginInlineStart: 'auto' }}><StateBadge {...st} /></span>
      </div>
      {god.description && <p className="pro-text">{god.description}</p>}
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Stat label={t('pro.agents.spend')}><strong style={{ fontSize: 18, color: 'var(--cth-peach)' }}>{spend.main}</strong><span className="pro-mono pro-sub">{spend.sub}</span></Stat>
        <Stat label={t('pro.agents.breaker')}><span className="pro-dot" style={{ background: breaker === 'healthy' ? 'var(--cth-mint)' : 'var(--cth-coral)' }} /><strong>{breaker === 'healthy' ? t('pro.agents.healthy') : breaker}</strong></Stat>
        <Stat label={t('pro.nav.tasks')}><strong style={{ fontSize: 18 }}>{doing}</strong><span className="pro-mono pro-sub">{t('pro.agents.doingBlocked', { blocked })}</span></Stat>
        <Stat label={t('pro.agents.waitingOnYou')}><strong style={{ fontSize: 18, color: asks ? 'var(--cth-peach)' : undefined }}>{asks}</strong><span className="pro-mono pro-sub">{t('pro.agents.questions', { count: asks })}</span></Stat>
      </div>
      <MessageQueueComposer agent={god} />
    </section>
  );
}

function AgentTile({ agent, ticket, dir, asksYou, config, onOpen }: {
  agent: Agent; ticket?: KeyedTask; dir?: AgentDirectoryEntry; asksYou: boolean; config: HarnessConfig; onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const feed = useStore((s) => s.feeds[agent.id]);
  const st = agentState(agent, asksYou);
  // The live terminal first: the parser feed only fills while Classic shows that
  // terminal, so on its own the card fell back to `action` and read "idle" while
  // the agent was busy.
  const screen = useTerminalTail(agent.ptyId);
  const usage = usePoll(() => Promise.resolve(terminalUsage(agent.ptyId)), 5000, null as ReturnType<typeof terminalUsage>);
  const lines = screen.length ? screen : (feed ?? []).slice(-3).map(stripAnsi);
  const tail = lines.length ? lines.join('\n') : stripAnsi(agent.recentAssistantText ?? agent.action ?? '').slice(-160);
  const ctxRatio = agent.contextTokens && agent.contextLimit ? agent.contextTokens / agent.contextLimit : 0;
  // Its terminal ended ("— process exited (code 1) —"): say it stopped, not "idle".
  const stoppedCode = exitedCode(tail);
  const badge = stoppedCode ? { label: 'Stopped', tone: 'red' as const } : st;
  // The human's "Run without sandbox" (its red badge replaces "Not sandboxed").
  const unsandboxed = unsandboxedAgents(config.agentUnsandboxed).includes(agent.id);
  // What it is doing right now (its latest step, if recent).
  const now = currentStep(useOfficeActivity(), agent.id, Date.now());
  const sentence = useActivityText();
  return (
    <article className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="pro-row" style={{ alignItems: 'flex-start' }}>
        <Avatar agent={agent} scale={1.5} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <p className="pro-title">{agent.name}</p>
          <div className="pro-sub" style={{ fontSize: 12 }}>{agent.model ?? agent.provider ?? t('pro.agents.cliDefault')}</div>
        </div>
        <CustodianBadge agentId={agent.id} config={config} />
        <StateBadge {...badge} />
      </div>
      {/* Its own line, as the usage badge: beside the state it squeezed the name. */}
      {unsandboxed && <span style={{ alignSelf: 'flex-start' }}><UnsandboxedBadge agentId={agent.id} config={config} /></span>}
      {dir?.osSandbox === 'none' && !unsandboxed && (
        <span className="pro-badge" style={{ alignSelf: 'flex-start', background: 'var(--cth-peach-light)', fontSize: 11 }} title={t('pro.agents.notSandboxedTip')}>{t('pro.agents.notSandboxed')}</span>
      )}
      {usage && usage.percent >= 50 && (
        <span className="pro-badge" title={t('pro.agents.usageTip', { percent: usage.percent, window: usage.window })}
          style={{ alignSelf: 'flex-start', fontSize: 11, background: usage.percent >= 90 ? 'var(--cth-coral-light)' : 'var(--cth-lemon-light)' }}>
          {t('pro.agents.usage', { percent: usage.percent, window: usage.window })}
        </span>
      )}
      {stoppedCode && <p className="pro-text" style={{ color: 'var(--cth-coral)' }}>{t('pro.now.stoppedCard', { code: stoppedCode })}</p>}
      {now && !stoppedCode && (
        <p className="pro-text" style={{ margin: 0 }}>
          <strong>{t('pro.now.nowLabel')}</strong> {t(`pro.steps.${now.key}`, { defaultValue: now.params.tool })}
          {sentence(now).detail && <span className="pro-mono" style={{ display: 'block', fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sentence(now).detail}</span>}
        </p>
      )}
      {ticket ? (
        <button className="pro-card" style={{ padding: '6px 10px', display: 'flex', gap: 8, minWidth: 0 }} onClick={() => useStore.getState().openTaskDetail(ticket.id)}>
          {ticket.key && <span className="pro-ticket">{ticket.key}</span>}
          <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ticket.title}</span>
        </button>
      ) : stoppedCode ? null : (
        <p className="pro-text">{(agent.action && actionLabel(agent.action, t)) || agent.description || t('pro.agents.waitingForWork')}</p>
      )}
      <div>
        <div className="pro-sub" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 4 }}>{t('pro.agents.terminal')}</div>
        <div className="pro-term">{tail || '—'}</div>
      </div>
      <div className="pro-row pro-mono pro-sub" style={{ fontSize: 11 }}>
        <span>{Math.round(ctxRatio * 100)}%</span>
        <div style={{ flex: 1 }}><Bar value={ctxRatio} tone={ctxRatio > 0.8 ? 'red' : 'blue'} /></div>
        <span>{agent.contextLimit ? fmtTokens(agent.contextLimit) : ''}</span>
      </div>
      <div className="pro-row">
        {dir && <span className="pro-chip">{fmtTokens(dir.tokens)} tok</span>}
        {dir && dir.inboxBacklog > 0 && <span className="pro-chip">{t('pro.agents.unread', { count: dir.inboxBacklog })}</span>}
        <button className="pro-btn" style={{ marginInlineStart: 'auto' }} onClick={() => onOpen(agent.id)}>{t('pro.agents.prompt')}</button>
      </div>
    </article>
  );
}
