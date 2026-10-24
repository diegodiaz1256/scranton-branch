import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { AskMeTab } from '@/components/AskMeTab';
import { TriggerHistoryTab } from '@/components/triggers/TriggerHistoryTab';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { waitsOnHuman } from '@/components/TasksKanban';
import { Avatar, usePoll, type KeyedTask } from './data';
import { ConversationsView } from './ConversationsView';
import { SignoffQueue, usePendingCount } from './SignoffQueue';

type Tab = 'chats' | 'you' | 'everyone' | 'outside';
type Message = Awaited<ReturnType<typeof window.cth.hiveMessages>>[number];

/** Senders that are the outside world rather than an agent on the floor. */
const OUTSIDE = new Set(['webhook', 'slack', 'org', 'github', 'linear', 'telegram']);
/** Harness beats, not conversation. */
const SYSTEM = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);

/**
 * Inbox — every conversation in one place. Conversations: one chat per agent
 * (its messages and the questions on its cards, with your answers). For you:
 * the questions waiting on you (the Ask me board) and what the orchestrator
 * addressed to you. Everyone: every routed message. Outside: Slack
 * threads waiting in the queue, webhook mail, and held webhook requests to
 * approve or reject (the trigger history, which owns that decision).
 */
/** Today: "19:42". Before: "8 Oct, 19:42". The full date is in the tooltip. */
function shortWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${hm}`;
}

export function InboxView({ tasks }: { tasks: KeyedTask[] }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('chats');
  const agents = useStore((s) => s.agents);
  const queues = useStore((s) => s.messageQueues);
  // The whole history (main caps an ordinary read at 40, for voice briefings).
  const messages = usePoll(() => window.cth.hiveMessages({ limit: 2000, history: true }), 5000, [] as Message[]);
  // What you typed straight into an agent's terminal, as your messages to it.
  const prompts = usePoll(() => window.cth.hiveHumanPrompts(), 5000, [] as Array<{ id: string; agentId: string; ts: string; text: string }>);
  const typed = useMemo(() => prompts.map((p) => ({
    id: p.id, conversation: p.id, from: 'human', to: p.agentId, act: 'request' as Message['act'],
    subject: '', body: p.text, requires_reply: false, in_reply_to: null,
    direction: 'outbox' as const, owner: p.agentId, archived: true, created_at: p.ts
  })), [prompts]);
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const asks = tasks.filter(waitsOnHuman).length + usePendingCount();

  const real = messages.filter((m) => !SYSTEM.has(m.from));
  const forYou = real.filter((m) => m.to === 'human');
  const outsideMail = real.filter((m) => OUTSIDE.has(m.from) || m.from.startsWith('team:'));
  const slackWaiting = Object.entries(queues).flatMap(([id, q]) => q.filter((m) => m.slack).map((m) => ({ ...m, agentId: id })));

  const name = (id: string) => byId.get(id)?.name ?? (id === 'human' ? t('pro.inbox.you') : id);

  const list = (rows: Message[]) => rows.length === 0
    ? <p className="pro-sub">{t('pro.inbox.nothing')}</p>
    : rows.slice().sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')).slice(0, 120).map((m) => (
      <article key={`${m.id}-${m.direction}`} className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="pro-row" style={{ fontSize: 12 }}>
          <Avatar agent={byId.get(m.from)} />
          <strong>{name(m.from)}</strong><span className="pro-sub">→ {name(m.to)}</span>
          <span className="pro-chip">{m.act}</span>
          {m.requires_reply && <span className="pro-badge" style={{ background: 'var(--cth-peach-light)' }}>{t('pro.inbox.needsReply')}</span>}
          <span className="pro-sub" style={{ marginInlineStart: 'auto' }} title={new Date(m.created_at).toLocaleString()}>{shortWhen(m.created_at)}</span>
        </div>
        <strong style={{ fontSize: 13 }}>{m.subject}</strong>
        {m.body && <div style={{ fontSize: 13, maxHeight: 160, overflow: 'auto' }}><MarkdownPreview source={m.body} variant="card" /></div>}
      </article>
    ));

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.nav.inbox')}</h2>
        <div className="pro-tabs" role="tablist" style={{ marginInlineStart: 8 }}>
          <button role="tab" aria-selected={tab === 'chats'} onClick={() => setTab('chats')}>{t('pro.inbox.conversations')}</button>
          <button role="tab" aria-selected={tab === 'you'} onClick={() => setTab('you')}>{t('pro.inbox.forYou')}{asks ? ` · ${asks}` : ''}</button>
          <button role="tab" aria-selected={tab === 'everyone'} onClick={() => setTab('everyone')}>{t('pro.inbox.everyone')}</button>
          <button role="tab" aria-selected={tab === 'outside'} onClick={() => setTab('outside')}>{t('pro.inbox.outside')}</button>
        </div>
      </div>

      {tab === 'you' && (
        <>
          <SignoffQueue />
          <div className="pro-embed" style={{ minHeight: 280 }}><AskMeTab /></div>
          {forYou.length > 0 && <h3 style={{ margin: '8px 0 0', fontSize: 14 }}>{t('pro.inbox.addressedToYou')}</h3>}
          {forYou.length > 0 && list(forYou)}
        </>
      )}

      {tab === 'chats' && <ConversationsView agents={agents.filter((a) => !a.isAssistant && !a.archived)} messages={[...messages, ...typed]} tasks={tasks} />}

      {tab === 'everyone' && list(real)}

      {tab === 'outside' && (
        <>
          {slackWaiting.length > 0 && <h3 style={{ margin: 0, fontSize: 14 }}>{t('pro.inbox.slackWaiting')}</h3>}
          {slackWaiting.map((m) => (
            <article key={m.id} className="pro-card">
              <div className="pro-row" style={{ fontSize: 12 }}>
                <span className="pro-chip">slack</span><span className="pro-sub">{t('pro.inbox.queuedFor', { name: name(m.agentId), time: new Date(m.ts).toLocaleTimeString() })}</span>
              </div>
              <p className="pro-text" style={{ marginTop: 6 }}>{m.text}</p>
            </article>
          ))}
          {outsideMail.length > 0 && <h3 style={{ margin: 0, fontSize: 14 }}>{t('pro.inbox.webhookMail')}</h3>}
          {outsideMail.length > 0 && list(outsideMail)}
          <h3 style={{ margin: 0, fontSize: 14 }}>{t('pro.inbox.requests')}</h3>
          <div className="pro-embed" style={{ minHeight: 320 }}><TriggerHistoryTab /></div>
        </>
      )}
    </div>
  );
}
