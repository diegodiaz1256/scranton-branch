import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { MarkdownPreview } from '@/markdown/MarkdownPreview';
import { openQuestion } from '@/components/TasksKanban';
import { answerOpenQuestion, dismissOpenQuestion } from '@/components/answerQuestion';
import { isComposingKey } from '@shared/imeGuard';
import { dayKey, type ThreadMessage } from '@shared/inboxThreads';
import { delegations, type LogMessage } from '@shared/delegations';
import {
  buildEasyThread, joinPhrases, pendingQuestions, plainText, whereWeAre,
  type EasyEntry, type PendingQuestion, type ThreadHookEvent, type WorkBurst
} from '@shared/easyThread';
import { Avatar, usePoll, type KeyedTask } from './data';

/**
 * Easy mode's first page: the conversation with the orchestrator, readable.
 *
 * On top, "where we are" in three lines; under it, the questions waiting for
 * you, each with its answer box; then the thread: what you said and what came
 * back, in plain text. What the agents said to each other folds into one line
 * per exchange, and each agent's tool work into one sentence per burst. All of
 * it is worked out here from tasks, messages and hook events (src/shared/
 * easyThread.ts), with no model call. Each agent's page (steps, terminal) is
 * one click from its name.
 */

type Message = Awaited<ReturnType<typeof window.cth.hiveMessages>>[number];
type T = ReturnType<typeof useTranslation>['t'];

/** Every agent's hook events, history first, then live. */
function useHookEvents(agentIds: string[]): ThreadHookEvent[] {
  const [events, setEvents] = useState<ThreadHookEvent[]>([]);
  const key = agentIds.slice().sort().join('|');
  useEffect(() => {
    let alive = true;
    const seen = new Set<string>();
    const id = (e: ThreadHookEvent) => `${e.agentId}|${e.ts}|${e.event}|${e.tool ?? ''}`;
    const add = (list: ThreadHookEvent[]) => {
      const fresh = list.filter((e) => { const k = id(e); if (seen.has(k)) return false; seen.add(k); return true; });
      // Kept bounded: main keeps 600 per agent, and the thread only tells recent work.
      if (fresh.length && alive) setEvents((cur) => { const next = [...cur, ...fresh]; return next.length > 8000 ? next.slice(next.length - 8000) : next; });
    };
    setEvents([]);
    const off = window.cth.onHiveHookEvent((e) => { if (e.agentId) add([e]); });
    for (const a of key ? key.split('|') : []) {
      void window.cth.hiveSteps(a).then((h) => add(h.map((e) => ({ ...e, agentId: e.agentId ?? a })))).catch(() => { /* no history */ });
    }
    return () => { alive = false; off(); };
  }, [key]);
  return events;
}

const time = (ms: number): string => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

function dayLabel(ms: number, t: T): string {
  const k = dayKey(new Date(ms).toISOString());
  const now = new Date();
  if (k === dayKey(now.toISOString())) return t('pro.inbox.today');
  if (k === dayKey(new Date(now.getTime() - 86_400_000).toISOString())) return t('pro.inbox.yesterday');
  return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Pam read 3 files and wrote 1 file". */
export function workSentence(b: WorkBurst, who: string, t: T): string {
  const parts = b.parts.map((p) => t(`pro.easyThread.work.${p.kind}`, { count: p.count, service: p.service ?? '' }));
  return t('pro.easyThread.workLine', { who, parts: joinPhrases(parts, t('pro.easyThread.and')) });
}

export function ThreadView({ tasks, roster, onOpen }: { tasks: KeyedTask[]; roster: Agent[]; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const archived = useStore((s) => s.archivedAgents);
  const god = roster.find((a) => a.isGod);
  const godName = god?.name ?? 'god';

  const messages = usePoll(() => window.cth.hiveMessages({ limit: 2000, history: true }), 5000, [] as Message[]);
  // What you typed straight into an agent's terminal counts as said, too.
  const prompts = usePoll(() => window.cth.hiveHumanPrompts(), 5000, [] as Array<{ id: string; agentId: string; ts: string; text: string }>);
  const log = usePoll(() => window.cth.hiveLog(300) as Promise<LogMessage[]>, 4000, [] as LogMessage[]);
  const events = useHookEvents(roster.map((a) => a.id));

  const all = useMemo<ThreadMessage[]>(() => [
    ...messages,
    ...prompts.map((p) => ({ id: p.id, from: 'human', to: p.agentId, act: 'request', subject: '', body: p.text, requires_reply: false, created_at: p.ts }))
  ], [messages, prompts]);
  const entries = useMemo(() => buildEasyThread({ messages: all, tasks, events, godId: god?.id }), [all, tasks, events, god?.id]);
  const pending = useMemo(() => pendingQuestions(tasks), [tasks]);
  const where = useMemo(() => whereWeAre({ messages: all, tasks, delegations: god ? delegations(log, god.id, Date.now()) : [] }), [all, tasks, log, god]);

  const byId = useMemo(() => new Map([...archived, ...roster].map((a) => [a.id, a])), [archived, roster]);
  const name = (id: string): string => (id === 'human' ? t('pro.easyThread.you') : id === 'god' ? godName : byId.get(id)?.name ?? id);
  const agentOf = (id: string): Agent | undefined => (id === 'god' ? god : byId.get(id));

  return (
    <div className="pro-page" style={{ gap: 12 }}>
      <div className="pro-head">
        <h2>{t('pro.nav.thread')}</h2>
        <span className="pro-sub">{t('pro.easyThread.sub', { god: godName })}</span>
      </div>
      <WhereWeAreCard where={where} name={name} onOpen={onOpen} godName={godName} />
      {pending.length > 0 && (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label={t('pro.easyThread.questionsHead')}>
          <div className="pro-sub" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' }}>{t('pro.easyThread.questionsHead')}</div>
          {pending.map((q) => <QuestionCard key={`${q.taskId}:${q.q}`} q={q} tasks={tasks} who={name(q.assignee ?? god?.id ?? 'god')} agent={agentOf(q.assignee ?? god?.id ?? 'god')} />)}
        </section>
      )}
      <Thread entries={entries} name={name} agentOf={agentOf} onOpen={onOpen} godName={godName} />
    </div>
  );
}

function WhereWeAreCard({ where, name, onOpen, godName }: { where: ReturnType<typeof whereWeAre>; name: (id: string) => string; onOpen: (id: string) => void; godName: string }) {
  const { t } = useTranslation();
  const shown = where.working.slice(0, 3);
  const more = where.working.length - shown.length;
  const restLine = [
    where.waitingOnYou > 0 ? t('pro.easyThread.waiting', { count: where.waitingOnYou }) : t('pro.easyThread.nothingWaiting'),
    where.left > 0 ? t('pro.easyThread.left', { count: where.left }) : ''
  ].filter(Boolean).join(' ');
  const allDone = !where.working.length && !where.waitingOnYou && !where.left && where.done > 0;
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }} aria-label={t('pro.easyThread.where')}>
      <div className="pro-sub" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' }}>{t('pro.easyThread.where')}</div>
      <p className="pro-text" style={{ fontSize: 14 }}>
        {where.asked ? t('pro.easyThread.asked', { text: where.asked }) : t('pro.easyThread.notAsked', { god: godName })}
      </p>
      <p className="pro-text" style={{ fontSize: 14 }}>
        {shown.length === 0 ? t('pro.easyThread.nobodyWorking') : shown.map((w, i) => (
          <span key={w.agentId}>
            {i > 0 && '; '}
            <button onClick={() => onOpen(w.agentId)} title={t('pro.easyThread.openAgent', { name: name(w.agentId) })}
              style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--pro-line-strong)' }}>
              {name(w.agentId)}
            </button>{' '}
            {t('pro.easyThread.working', { what: w.what })}
          </span>
        ))}
        {more > 0 && ` ${t('pro.easyThread.workingMore', { count: more })}`}
      </p>
      <p className="pro-text" style={{ fontSize: 14, fontWeight: where.waitingOnYou ? 600 : undefined }}>
        {allDone ? t('pro.easyThread.allDone') : restLine}
      </p>
    </section>
  );
}

function QuestionCard({ q, tasks, who, agent }: { q: PendingQuestion; tasks: KeyedTask[]; who: string; agent?: Agent }) {
  const { t } = useTranslation();
  const drafts = useStore((s) => s.answerDrafts);
  const setDraft = useStore((s) => s.setAnswerDraft);
  const text = drafts[q.taskId] ?? '';
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Answered or set aside: gone at once, not at the next poll of the board.
  const [gone, setGone] = useState(false);
  const run = async (fn: (task: KeyedTask, open: NonNullable<ReturnType<typeof openQuestion>>) => Promise<boolean>) => {
    const task = tasks.find((x) => x.id === q.taskId);
    const open = task ? openQuestion(task) : undefined;
    if (!task || !open || busy) return;
    setBusy(true);
    setFailed(false);
    try { if (await fn(task, open)) { setDraft(q.taskId, ''); setGone(true); } else setFailed(true); } catch { setFailed(true); }
    setBusy(false);
  };
  const answer = () => { const a = text.trim(); if (a) void run(async (task, open) => !!(await answerOpenQuestion(task, open, a))); };
  if (gone) return null;
  return (
    <article className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--cth-peach-light)' }}>
      <div className="pro-row" style={{ fontSize: 12 }}>
        <Avatar agent={agent} />
        <strong>{t('pro.easyThread.needsAnswer', { who })}</strong>
        <span className="pro-sub" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>· {q.taskLabel}</span>
      </div>
      <div style={{ fontSize: 14 }}><MarkdownPreview source={q.q} variant="card" /></div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <textarea className="pro-input" rows={2} value={text} placeholder={t('pro.easyThread.answerPh')} onChange={(e) => setDraft(q.taskId, e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isComposingKey(e)) { e.preventDefault(); answer(); } }}
          style={{ flex: '1 1 240px', resize: 'vertical', minHeight: 40 }} />
        <button className="pro-btn pro-btn-primary" disabled={!text.trim() || busy} onClick={answer}>{busy ? t('pro.easyThread.sending') : t('pro.easyThread.answer')}</button>
        <button className="pro-btn" disabled={busy} title={t('pro.easyThread.notNowTip')} onClick={() => void run(dismissOpenQuestion)}>{t('pro.easyThread.notNow')}</button>
      </div>
      {failed && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12 }}>{t('pro.easyThread.answerFailed')}</span>}
    </article>
  );
}

function Thread({ entries, name, agentOf, onOpen, godName }: {
  entries: EasyEntry[]; name: (id: string) => string; agentOf: (id: string) => Agent | undefined; onOpen: (id: string) => void; godName: string;
}) {
  const { t } = useTranslation();
  const scroller = useRef<HTMLDivElement>(null);
  // Follow the bottom like a chat, unless you scrolled up to read.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  const [open, setOpen] = useState<Set<number>>(new Set());

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setNote(null);
    const res = await window.cth.hiveSend({ to: 'god', act: 'request', subject: t('commandCenter.taskFromHuman'), body }, 'human');
    setSending(false);
    if (res.ok) { setDraft(''); pinned.current = true; } else setNote(t('pro.easyThread.notSent'));
  };

  let lastDay = '';
  return (
    <section className="pro-card" style={{ flex: '1 0 360px', minHeight: 360, display: 'flex', flexDirection: 'column', padding: 0 }}>
      <div ref={scroller} onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {entries.length === 0 && <p className="pro-sub" style={{ margin: 0 }}>{t('pro.easyThread.empty', { god: godName })}</p>}
        {entries.map((e, i) => {
          const d = e.ts ? dayKey(new Date(e.ts).toISOString()) : '';
          const sep = d && d !== lastDay ? <div key={`d${i}`} className="pro-sub" style={{ alignSelf: 'center', fontSize: 11, padding: '4px 0' }}>{dayLabel(e.ts, t)}</div> : null;
          if (d) lastDay = d;
          return [sep, <Entry key={`e${i}`} e={e} name={name} agentOf={agentOf} onOpen={onOpen}
            open={open.has(i)} onToggle={() => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} />];
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--pro-line)', padding: 10, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <textarea className="pro-input" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={t('pro.easyThread.composePh', { god: godName })}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isComposingKey(e)) { e.preventDefault(); void send(); } }}
          style={{ flex: 1, resize: 'vertical', minHeight: 40 }} />
        <button className="pro-btn pro-btn-primary" disabled={!draft.trim() || sending} onClick={() => void send()}>{sending ? t('pro.easyThread.sending') : t('pro.easyThread.send')}</button>
      </div>
      {note && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12, padding: '0 12px 8px' }}>{note}</span>}
    </section>
  );
}

/** A name that opens the agent's page (its steps, and the terminal behind "Show terminal"). */
function AgentLink({ id, name, onOpen }: { id: string; name: string; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  if (id === 'human') return <>{name}</>;
  return (
    <button onClick={() => onOpen(id)} title={t('pro.easyThread.openAgent', { name })}
      style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', fontWeight: 600, cursor: 'pointer' }}>{name}</button>
  );
}

/** Long text folds to a few lines, with "Show more". */
function Clamped({ text, lines = 8 }: { text: string; lines?: number }) {
  const { t } = useTranslation();
  const [more, setMore] = useState(false);
  const long = text.length > 600 || text.split('\n').length > lines;
  return (
    <>
      <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        ...(long && !more ? { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' } : {}) }}>{text}</div>
      {long && <button className="pro-btn" style={{ marginTop: 6, padding: '1px 8px', fontSize: 11 }} onClick={() => setMore((v) => !v)}>{more ? t('pro.easyThread.showLess') : t('pro.easyThread.showMore')}</button>}
    </>
  );
}

function Entry({ e, name, agentOf, onOpen, open, onToggle }: {
  e: EasyEntry; name: (id: string) => string; agentOf: (id: string) => Agent | undefined; onOpen: (id: string) => void; open: boolean; onToggle: () => void;
}) {
  const { t } = useTranslation();
  if (e.kind === 'work') {
    const who = name(e.burst.agentId);
    return (
      <button onClick={() => onOpen(e.burst.agentId)} title={t('pro.easyThread.openAgent', { name: who })} className="pro-sub"
        style={{ display: 'flex', gap: 8, alignItems: 'baseline', alignSelf: 'stretch', border: 'none', background: 'none', padding: '1px 4px', font: 'inherit', fontSize: 12.5, textAlign: 'start', cursor: 'pointer' }}>
        <span aria-hidden>·</span>
        <span style={{ flex: 1, minWidth: 0 }}>{workSentence(e.burst, who, t)}</span>
        <span style={{ fontSize: 11, flexShrink: 0 }}>{time(e.ts)}</span>
      </button>
    );
  }
  if (e.kind === 'exchange') {
    const people = e.people.map(name);
    return (
      <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <button onClick={onToggle} aria-expanded={open}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', border: '1px dashed var(--pro-line)', borderRadius: 8, background: 'transparent', cursor: 'pointer', font: 'inherit', fontSize: 12, color: 'var(--pro-muted)', textAlign: 'start', minWidth: 0 }}>
          <span aria-hidden>{open ? '▾' : '▸'}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            {open ? t('pro.easyThread.hideExchange') : t('pro.easyThread.exchange', { count: e.messages.length })}
            {' · '}{joinPhrases(people, t('pro.easyThread.and'))}
          </span>
          <span style={{ flexShrink: 0, fontSize: 11 }}>{time(e.ts) === time(e.endTs) ? time(e.ts) : `${time(e.ts)}–${time(e.endTs)}`}</span>
        </button>
        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingInlineStart: 14, borderInlineStart: '2px solid var(--pro-line)' }}>
            {e.messages.map((m) => (
              <div key={m.id} style={{ fontSize: 12.5 }}>
                <div className="pro-sub" style={{ fontSize: 11 }}>
                  <AgentLink id={m.from === 'god' ? (agentOf('god')?.id ?? 'god') : m.from} name={name(m.from)} onOpen={onOpen} />
                  {' → '}{m.to === 'broadcast' ? t('pro.easyThread.everyone') : name(m.to)} · {time(Date.parse(m.created_at) || 0)}
                </div>
                {m.subject && <strong style={{ display: 'block' }}>{plainText(m.subject)}</strong>}
                {m.body && <Clamped text={plainText(m.body)} lines={4} />}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (e.kind === 'answered') {
    return (
      <Bubble mine who={t('pro.easyThread.yourAnswer')} when={time(e.ts)}>
        <div style={{ borderInlineStart: '3px solid var(--cth-peach)', background: 'var(--cth-cream-100)', borderRadius: 4, padding: '4px 8px', marginBottom: 6, fontSize: 12, color: 'var(--cth-ink-700)' }}>
          <span className="pro-sub" style={{ display: 'block', fontSize: 10.5 }}>{t('pro.easyThread.askedQ', { task: e.taskLabel })}</span>
          <Clamped text={plainText(e.q)} lines={3} />
        </div>
        <Clamped text={e.a} />
      </Bubble>
    );
  }
  const mine = e.from === 'human';
  const other = mine ? e.to : e.from;
  const otherAgent = agentOf(other);
  const who = mine
    ? (otherAgent?.isGod || other === 'god' ? t('pro.easyThread.you') : t('pro.easyThread.youTo', { name: name(other) }))
    : name(e.from);
  // The generic subject the app gives your requests says nothing; an agent's does.
  const subject = !mine && e.subject ? plainText(e.subject) : '';
  return (
    <Bubble mine={mine} who={who} when={time(e.ts)} agent={mine ? undefined : otherAgent} onWho={mine ? undefined : () => onOpen(otherAgent?.id ?? other)}>
      {subject && <strong style={{ display: 'block', marginBottom: e.text ? 4 : 0 }}>{subject}</strong>}
      {e.text && <Clamped text={plainText(e.text)} />}
    </Bubble>
  );
}

/** A bubble: yours on the end side, everyone else's on the start side. */
function Bubble({ mine, who, when, agent, onWho, children }: { mine: boolean; who: string; when: string; agent?: Agent; onWho?: () => void; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: 'min(680px, 92%)', display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span className="pro-sub" style={{ fontSize: 11, alignSelf: mine ? 'flex-end' : 'flex-start', display: 'flex', alignItems: 'center', gap: 6 }}>
        {agent && <Avatar agent={agent} />}
        {onWho
          ? <button onClick={onWho} title={t('pro.easyThread.openAgent', { name: who })} style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', fontWeight: 600, cursor: 'pointer' }}>{who}</button>
          : who}
        {' · '}{when}
      </span>
      <div style={{
        padding: '8px 11px', borderRadius: 10, fontSize: 14, lineHeight: 1.45,
        border: '1px solid var(--pro-line)',
        background: mine ? 'var(--cth-lemon-light)' : 'var(--cth-paper-100)'
      }}>{children}</div>
    </div>
  );
}
