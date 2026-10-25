import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { cloneTarget, parseAnswerer, TEMP_TARGET } from '@shared/agentTemps';

/** What a "who answers" picker needs to know about an agent. */
export interface AnswerAgent { id: string; name: string; isGod?: boolean }

/** Agents a temp may be cloned from: not the orchestrator, not a temp, not a
 *  custodian of a critical connection (main refuses those too). */
export function clonableAgents(agents: AnswerAgent[], custodians?: Record<string, string>): AnswerAgent[] {
  const held = new Set(Object.values(custodians ?? {}).filter(Boolean));
  return agents.filter((a) => !a.isGod && !a.id.startsWith('worker-') && !held.has(a.id));
}

/**
 * The temp choices of a "who answers" picker (Schedules, webhooks, Slack,
 * Team): "A temp" and "A temp, clone of <agent>". Rendered inside the
 * picker's own <select>, after its agent options, so every trigger offers the
 * same two in the same words.
 */
export function TempAnswerOptions({ agents, custodians }: { agents: AnswerAgent[]; custodians?: Record<string, string> }) {
  const { t } = useTranslation();
  const clonable = clonableAgents(agents, custodians);
  return (
    <>
      <option value={TEMP_TARGET}>{t('tempAnswer.temp')}</option>
      {clonable.length > 0 && (
        <optgroup label={t('tempAnswer.cloneGroup')}>
          {clonable.map((a) => <option key={a.id} value={cloneTarget(a.id)}>{t('tempAnswer.cloneOf', { name: a.name })}</option>)}
        </optgroup>
      )}
    </>
  );
}

/** The words for a stored target that names a temp, or null for an agent. */
export function tempAnswerLabel(to: string, agents: AnswerAgent[], t: TFunction): string | null {
  const a = parseAnswerer(to);
  if (a.kind === 'temp') return t('tempAnswer.temp');
  if (a.kind === 'clone') return t('tempAnswer.cloneOf', { name: agents.find((x) => x.id === a.of)?.name ?? a.of });
  return null;
}
