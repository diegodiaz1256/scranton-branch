import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { SpritePortrait } from './SpritePortrait';
import { PixelBadge } from './PixelBadge';
import { actionLabel } from '@/scene/office/actionLabel';
import { useDirectory } from '@/pro/data';

/**
 * The "no office" level (src/shared/officeRenderLevel.ts): what the floor shows
 * when the Pixi scene is not started at all. No WebGL context, no textures, no
 * ticker — one plain card per agent with what the floor would have told you:
 * who, what they do, their state, the tool in hand, context used, spend and
 * their last words. A card opens that agent's terminal in focus mode.
 */
export function OfficeCards() {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const directory = useDirectory();
  // The orchestrator first, as on the floor (his room is the top-left corner).
  const shown = agents.filter((a) => !a.isAssistant).slice()
    .sort((a, b) => Number(!!b.isGod) - Number(!!a.isGod));

  return (
    <div
      data-office-level="cards"
      style={{
        width: '100%', height: '100%',
        boxShadow: 'var(--cth-panel-border)',
        background: 'var(--cth-ink-900)',
        overflowY: 'auto', overflowX: 'hidden',
        padding: 'var(--cth-space-4)',
        boxSizing: 'border-box'
      }}
    >
      <div style={{
        display: 'grid', gap: 'var(--cth-space-3)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        alignContent: 'start'
      }}>
        {shown.map((a) => (
          <OfficeCard
            key={a.id}
            agent={a}
            usd={directory[a.id]?.usd}
            selected={a.id === selectedId}
            roleFallback={a.isGod ? t('officeCards.god') : ''}
          />
        ))}
      </div>
    </div>
  );
}

const OfficeCard = memo(function OfficeCard({ agent, usd, selected, roleFallback }: {
  agent: Agent; usd?: number; selected: boolean; roleFallback: string;
}) {
  const { t } = useTranslation();
  const ctx = agent.contextTokens !== undefined && agent.contextLimit
    ? Math.round((agent.contextTokens / agent.contextLimit) * 100)
    : null;
  const doing = (agent.action && actionLabel(agent.action, t)) || '';
  const last = lastLine(agent.recentAssistantText);
  const open = (): void => {
    const st = useStore.getState();
    st.select(agent.id);
    if (agent.ptyId) st.setFullscreen(agent.id);
  };

  return (
    <button
      onClick={open}
      title={agent.ptyId ? t('officeCards.open', { name: agent.name }) : agent.name}
      style={{
        all: 'unset', boxSizing: 'border-box', cursor: 'pointer',
        display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)',
        minWidth: 0, padding: 'var(--cth-space-3)',
        background: agent.isGod ? 'var(--cth-lemon-light)' : 'var(--cth-cream-50)',
        boxShadow: selected
          ? 'inset 0 0 0 2px var(--cth-ink-900), 0 0 0 2px var(--cth-lemon)'
          : 'inset 0 0 0 2px var(--cth-ink-900), 3px 3px 0 0 var(--cth-ink-700)',
        opacity: agent.status === 'ghost' ? 0.55 : 1,
        fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--cth-space-3)', alignItems: 'flex-start', minWidth: 0 }}>
        <span style={{ lineHeight: 0, flexShrink: 0, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <SpritePortrait character={agent.character} scale={2} />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
          <span style={{
            fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
            lineHeight: 'var(--cth-lh-display-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>{agent.name}</span>
          <span style={{
            fontSize: 'var(--cth-text-body-sm)', lineHeight: 'var(--cth-lh-body-sm)', color: 'var(--cth-ink-500)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }} title={agent.description}>{agent.description || roleFallback}</span>
          <span><PixelBadge status={agent.status} /></span>
        </div>
      </div>

      <Row label={t('officeCards.tool')} value={agent.carrying || doing || '—'} title={doing} mono />
      <div style={{ display: 'flex', gap: 'var(--cth-space-3)' }}>
        <Row label={t('officeCards.context')} value={ctx === null ? '—' : `${ctx}%`} mono />
        <Row label={t('officeCards.cost')} value={usd === undefined ? '—' : `$${usd.toFixed(2)}`} mono />
      </div>
      <span style={{
        fontSize: 'var(--cth-text-body-sm)', lineHeight: 'var(--cth-lh-body-sm)', color: 'var(--cth-ink-700)',
        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        minHeight: 32, wordBreak: 'break-word'
      }} title={last}>{last || t('officeCards.noMessage')}</span>
    </button>
  );
});

function Row({ label, value, title, mono }: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0, fontSize: 'var(--cth-text-body-sm)' }}>
      <span style={{ color: 'var(--cth-ink-500)', flexShrink: 0 }}>{label}</span>
      <span title={title} style={{
        fontFamily: mono ? 'var(--cth-font-mono)' : undefined,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0
      }}>{value}</span>
    </span>
  );
}

/** The last non-empty line of the agent's latest message, trimmed for a card. */
function lastLine(text: string | undefined): string {
  if (!text) return '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const l = lines[lines.length - 1] ?? '';
  return l.length > 180 ? l.slice(0, 179) + '…' : l;
}
