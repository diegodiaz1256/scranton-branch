import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import type { TaskEvent } from '@shared/taskHistory';

type Message = Awaited<ReturnType<typeof window.cth.hiveMessages>>[number];
type Entry = { ts: string; text: string; detail?: string };

/** "Jim", "god" → the orchestrator's name, an unknown id as itself. */
export function useAgentName(): (id?: string) => string {
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  return (id?: string) => {
    if (!id) return '';
    if (id === 'god') return agents.find((a) => a.isGod)?.name ?? id;
    return agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id;
  };
}

/** One task event as a sentence. */
export function describeTaskEvent(e: TaskEvent, name: (id?: string) => string, t: ReturnType<typeof useTranslation>['t']): string {
  const st = (s?: string) => (s ? t(`taskHistory.status_${s}`, { defaultValue: s }) : '');
  switch (e.kind) {
    case 'created': return e.assignee ? t('taskHistory.createdFor', { name: name(e.assignee), status: st(e.status) }) : t('taskHistory.created', { status: st(e.status) });
    case 'assigned': return e.to ? t('taskHistory.assigned', { name: name(e.to) }) : t('taskHistory.unassigned');
    case 'status': return t('taskHistory.status', { from: st(e.from), to: st(e.to) });
    case 'asked': return t('taskHistory.asked');
    case 'answered': return t('taskHistory.answered');
    case 'dismissed': return t('taskHistory.dismissed');
    case 'result': return t('taskHistory.result');
    case 'removed': return t('taskHistory.removed');
    case 'edited': return t('taskHistory.edited', { fields: e.fields.map((f) => t(`taskHistory.field_${f}`, { defaultValue: f })).join(', ') });
  }
}

const detailOf = (e: TaskEvent): string | undefined =>
  e.kind === 'asked' || e.kind === 'dismissed' ? e.q : e.kind === 'answered' ? `${e.q}\n→ ${e.a}` : e.kind === 'result' ? e.text : undefined;

/**
 * Everything that happened to one task, oldest first: its own history (who
 * had it, every status move, each question and answer) interleaved with the
 * messages that name it. Polled while open.
 */
export function TaskTimeline({ taskId, taskKey }: { taskId: string; taskKey?: string }) {
  const { t } = useTranslation();
  const name = useAgentName();
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => {
      void window.cth.hiveTaskHistory?.(taskId).then((e) => { if (alive) setEvents(e); }).catch(() => {});
      void window.cth.hiveMessages({ limit: 2000, history: true }).then((m) => {
        if (!alive) return;
        const keys = [taskId, taskKey].filter((k): k is string => !!k);
        setMessages(m.filter((x) => keys.some((k) => x.subject.includes(k) || x.body.includes(k))));
      }).catch(() => {});
    };
    load();
    const id = setInterval(load, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [taskId, taskKey]);

  const entries: Entry[] = [
    ...events.map((e) => ({ ts: e.ts, text: describeTaskEvent(e, name, t), detail: detailOf(e) })),
    ...messages.map((m) => ({ ts: m.created_at, text: t('taskHistory.message', { from: name(m.from), to: m.to === 'human' ? t('pro.inbox.you') : name(m.to) }), detail: m.subject }))
  ].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>{t('taskHistory.title')}</div>
      {entries.length === 0 && <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{t('taskHistory.empty')}</div>}
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 260, overflowY: 'auto' }}>
        {entries.map((e, i) => (
          <li key={i} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)' }}>
            <span style={{ flexShrink: 0, width: 92, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-mono)', fontSize: 11 }}>
              {new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              {e.text}
              {e.detail && <span style={{ display: 'block', color: 'var(--cth-ink-700)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{e.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
