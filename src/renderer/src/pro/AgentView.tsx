import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { canResumeAgent, restartAgent } from '@/components/restartAgent';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import { mcpLabel } from '@shared/roleBundles';
import { useProStore } from './proStore';
import { Avatar, Bar, GodBadge, StateBadge, agentState, fmtTokens, isActive, type AgentDirectoryEntry, type KeyedTask } from './data';
import { CustodianBadge } from './CriticalConnection';
import { currentTicket, spendLine } from './AgentsView';
import { StepsView } from './StepsView';
import { delegations, envelopeReturning, type Delegation, type LogMessage } from '@shared/delegations';

interface Props {
  agent: Agent;
  roster: Agent[];
  tasks: KeyedTask[];
  directory: Record<string, AgentDirectoryEntry>;
  config: HarnessConfig;
  onOpen: (id: string) => void;
}

/** MCP servers an agent gets on its next spawn: its grant, else the defaults. */
export function effectiveServers(config: HarnessConfig, agentId: string): string[] {
  const grant = config.agentMcpGrants?.[agentId];
  if (grant) return grant;
  return MCP_CATALOG.filter((e) => config.mcpDefaults?.[e.id]?.enabled ?? e.defaultEnabled).map((e) => e.id);
}

/**
 * An agent's room: the live terminal (the same AgentDetailPanel Classic uses,
 * so the queue, the command bar and every tab keep working) with the agent's
 * facts beside it. The orchestrator's room opens on who he is routing to and
 * the floor's spend against its cap.
 */
export function AgentView({ agent, roster, tasks, directory, config, onOpen }: Props) {
  const { t } = useTranslation();
  const setView = useProStore((s) => s.setView);
  const dir = directory[agent.id];
  const st = agentState(agent, false);
  const cap = config.agentTokenCaps?.[agent.id];
  const servers = effectiveServers(config, agent.id);
  // The terminal is for typing to the agent; the steps are for reading what it is doing.
  const [pane, setPane] = useState<'terminal' | 'steps' | 'both'>('terminal');
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const canResume = canResumeAgent(agent);
  /** Restart only this agent's process: the rest of the office keeps running.
   *  Continues its conversation when its CLI can, else starts it fresh. Also
   *  how a changed environment variable reaches a running agent. */
  const restart = async () => {
    if (!agent.ptyId || restarting) return;
    const ok = await window.cth.confirm(t('pro.agent.restartConfirm', { name: agent.name }), {
      detail: t(canResume ? 'pro.agent.restartDetailResume' : 'pro.agent.restartDetailFresh'),
      ok: t('pro.agent.restart')
    });
    if (!ok) return;
    setRestarting(true);
    setRestartError(null);
    try { await restartAgent(agent, agent.model, { resume: canResume, resumeOptional: true }); }
    catch (e) { setRestartError(e instanceof Error ? e.message : String(e)); }
    finally { setRestarting(false); }
  };

  return (
    <div className="pro-page" style={{ gap: 12 }}>
      <div className="pro-head">
        <Avatar agent={agent} />
        <h2>{agent.name}</h2>
        {agent.isGod
          ? <GodBadge />
          : <StateBadge {...st} />}
        <CustodianBadge agentId={agent.id} config={config} />
        <div className="pro-head-end" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {agent.ptyId && (
          <button className="pro-btn" disabled={restarting} title={t('pro.agent.restartTip')} onClick={() => void restart()}>
            {restarting ? t('common.restarting') : t('pro.agent.restart')}
          </button>
        )}
        <div className="pro-switch" role="group" aria-label={t('pro.agent.view')}>
          {(['terminal', 'steps', 'both'] as const).map((p) => (
            <button key={p} aria-pressed={pane === p} onClick={() => setPane(p)}>{t(`pro.agent.view_${p}`)}</button>
          ))}
        </div>
        </div>
        {restartError && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12, flexBasis: '100%' }}>{restartError}</span>}
      </div>

      {agent.isGod && <RoutingMap god={agent} roster={roster} tasks={tasks} directory={directory} config={config} onOpen={onOpen} />}

      {/* Wraps when the window is narrow: the terminal keeps the full width and
          the facts move below it, instead of everything squeezing side by side. */}
      <div style={{ flex: 1, minHeight: 420, display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {pane !== 'steps' && (
          <div className="pro-embed" style={{ minWidth: 0, minHeight: 420, flex: pane === 'both' ? '1 1 420px' : '999 1 520px' }}>
            <AgentDetailPanel agent={agent} />
          </div>
        )}
        {pane !== 'terminal' && (
          <div style={{ flex: pane === 'both' ? '1 1 420px' : '999 1 520px', minWidth: 0, minHeight: 320, display: 'flex' }}>
            <StepsView agentId={agent.id} />
          </div>
        )}
        {/* Side by side, terminal and steps need the width more than the facts do. */}
        {pane !== 'both' && <aside style={{ flex: '1 1 220px', maxWidth: 280, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Fact label={t('pro.agent.goal')}>{agent.goal || agent.description || '—'}</Fact>
          <Fact label={t('pro.agent.engine')}>{[agent.provider ?? 'claude', agent.model].filter(Boolean).join(' · ')}</Fact>
          <Fact label={t('pro.agent.usage')}>
            {dir ? `${fmtTokens(dir.tokens)} tokens · $${dir.usd.toFixed(2)}` : '—'}
            <div className="pro-sub" style={{ fontSize: 12 }}>{cap ? t('pro.agent.cap', { cap: fmtTokens(cap) }) : t('pro.agent.workspaceBudget')}</div>
          </Fact>
          <Fact label={t('pro.nav.capabilities')}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {servers.length ? servers.map((id) => <span key={id} className="pro-chip">{mcpLabel(id)}</span>) : '—'}
            </div>
            <button className="pro-btn" style={{ marginTop: 8 }} onClick={() => setView({ kind: 'section', section: 'capabilities' })}>{t('pro.agent.manage')}</button>
          </Fact>
          {agent.worktreePath && <Fact label={t('pro.agent.worktree')}><span className="pro-mono" style={{ wordBreak: 'break-all' }}>{agent.worktreePath}</span></Fact>}
        </aside>}
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // A goal can carry a long word without spaces (a/b/c/d, a URL): it wraps
    // inside the card instead of running past the side column.
    <div className="pro-card" style={{ padding: '10px 12px', fontSize: 13, minWidth: 0, overflowWrap: 'anywhere' }}>
      <div className="pro-sub" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

/** The hive's message log, polled: what the orchestrator handed to whom. */
function useDelegations(godId: string): { list: Delegation[]; now: number } {
  const [log, setLog] = useState<LogMessage[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.cth.hiveLog(300).then((l) => { if (alive) setLog(l as LogMessage[]); }).catch(() => {});
      setNow(Date.now());
    };
    load();
    const id = setInterval(load, 2000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return { list: delegations(log, godId, now), now };
}

/** God on the left; to the right everyone he handed work to, or who is at
 *  work. An envelope travels out when he delegates and back when the agent
 *  answers; in between the line runs and he waits. The floor spend under it. */
function RoutingMap({ god, roster, tasks, directory, config, onOpen }: Omit<Props, 'agent'> & { god: Agent }) {
  const { t: tr } = useTranslation();
  const { list: handed, now } = useDelegations(god.id);
  const byId = new Map(handed.map((d) => [d.agentId, d]));
  const shown = new Set<string>(handed.map((d) => d.agentId));
  for (const a of roster) if (!a.isGod && (isActive(a) || currentTicket(tasks, a.id)?.status === 'doing')) shown.add(a.id);
  const others = roster.filter((a) => !a.isGod && shown.has(a.id));
  const waitingOn = others.filter((a) => byId.get(a.id)?.phase === 'working' || byId.get(a.id)?.phase === 'sent');
  const spend = spendLine(directory, config, tr);
  const breaker = directory[god.id]?.breaker || 'healthy';
  const godTicket = currentTicket(tasks, god.id);
  const rowH = 56;
  const h = Math.max(130, others.length * rowH + 16);
  const godY = h / 2;
  const rowY = (i: number) => 8 + i * rowH + rowH / 2;
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ position: 'relative', height: h }}>
        <svg width="100%" height={h} style={{ position: 'absolute', inset: 0 }} aria-hidden="true" preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
          {others.map((a, i) => {
            const d = byId.get(a.id);
            const live = d && d.phase !== 'returned';
            return (
              <line key={a.id} x1={22} y1={godY} x2={62} y2={rowY(i)}
                className={live ? 'pro-route-live' : undefined}
                stroke={d ? (live ? 'var(--cth-lemon)' : 'var(--cth-mint)') : 'var(--cth-ink-300)'}
                strokeDasharray={live ? '4 3' : '2 2'} strokeWidth={live ? 0.8 : 0.3} vectorEffect="non-scaling-stroke" />
            );
          })}
        </svg>
        {others.map((a, i) => {
          const d = byId.get(a.id);
          if (!d) return null;
          const out = d.phase === 'sent';
          const back = envelopeReturning(d, now);
          if (!out && !back) return null;
          const from = out ? { x: '22%', y: godY } : { x: '62%', y: rowY(i) };
          const to = out ? { x: '62%', y: rowY(i) } : { x: '22%', y: godY };
          return (
            <span key={`env-${a.id}-${out ? d.sentAt : d.repliedAt}`} className="pro-envelope" title={out ? d.subject : d.reply}
              style={{ ['--x1' as string]: from.x, ['--y1' as string]: `${from.y - 7}px`, ['--x2' as string]: to.x, ['--y2' as string]: `${to.y - 7}px` }}>✉</span>
          );
        })}
        <button className="pro-card" onClick={() => onOpen(god.id)}
          style={{ position: 'absolute', insetInlineStart: '4%', top: godY - 46, width: '18%', minWidth: 110, height: 92, background: 'var(--cth-lemon-light)', borderColor: 'var(--cth-lemon)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
          {godTicket?.key && <TicketChip id={godTicket.key} live={isActive(god)} />}
          <Avatar agent={god} />
          <strong style={{ fontSize: 13 }}>{god.name}</strong>
          {waitingOn.length > 0 && !isActive(god) && (
            <span className="pro-sub" style={{ fontSize: 11 }}>{tr('pro.agent.waitingOn', { names: waitingOn.map((a) => a.name).join(', ') })}</span>
          )}
        </button>
        {others.map((a, i) => {
          const t = currentTicket(tasks, a.id);
          const d = byId.get(a.id);
          const line = d ? (d.phase === 'returned' ? `↩ ${d.reply || d.replyAct || tr('pro.agent.answered')}` : d.subject) : t?.title;
          return (
            <button key={a.id} className="pro-card" onClick={() => onOpen(a.id)}
              style={{ position: 'absolute', insetInlineStart: '62%', top: rowY(i) - (rowH - 8) / 2, height: rowH - 8, width: '34%', padding: '0 10px', display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
                borderColor: d && d.phase !== 'returned' ? 'var(--cth-lemon)' : undefined }}>
              <Avatar agent={a} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, textAlign: 'start' }}>
                <strong style={{ fontSize: 13 }}>{a.name}</strong>
                {line && <span className="pro-sub" style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</span>}
              </span>
              {t?.key && <span style={{ marginInlineStart: 'auto' }}><TicketChip id={t.key} live={isActive(a)} /></span>}
            </button>
          );
        })}
      </div>
      <div className="pro-card" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="pro-row" style={{ fontSize: 13 }}>
          <span>{spend.main} <span className="pro-sub">{spend.sub}</span></span>
          <span className="pro-badge" style={{ marginInlineStart: 'auto', background: breaker === 'healthy' ? 'var(--cth-mint-light)' : 'var(--cth-coral-light)' }}>
            <span className="pro-dot" style={{ background: breaker === 'healthy' ? 'var(--cth-mint)' : 'var(--cth-coral)' }} /> {tr('pro.agents.breaker')}
          </span>
        </div>
        <Bar value={spend.ratio} tone={spend.ratio > 0.85 ? 'red' : 'gold'} />
      </div>
      {others.length === 0 && <p className="pro-sub" style={{ margin: 0 }}>{tr('pro.agent.nobodyWorking')}</p>}
    </section>
  );
}

/** A ticket key on the map: yellow while its agent is working on it. */
function TicketChip({ id, live }: { id: string; live: boolean }) {
  return (
    <span className="pro-chip" style={{
      borderColor: live ? 'var(--cth-lemon)' : 'var(--cth-mint)',
      background: live ? 'var(--cth-lemon-light)' : 'var(--cth-mint-light)',
      color: 'var(--cth-ink-900)'
    }}>{id}</span>
  );
}
