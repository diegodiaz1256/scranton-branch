import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useOfficeRender } from '@/store/officeRender';
import { MANY_AGENTS, shouldRecommendLighter } from '@shared/officeRenderLevel';
import { PixelButton } from './PixelButton';

/**
 * A crowded full floor costs real CPU and GPU (the numbers are in the PR that
 * added the levels). Past MANY_AGENTS, suggest a lighter level, once: switch
 * now, let Auto decide, or never ask again. It sits in a corner of the floor
 * and blocks nothing.
 */
export function OfficeLevelHint() {
  const { t } = useTranslation();
  const agentCount = useStore((s) => s.agents.length);
  const setting = useOfficeRender((s) => s.setting);
  const dismissed = useOfficeRender((s) => s.hintDismissed);
  if (!shouldRecommendLighter({ setting, agentCount, dismissed })) return null;
  const { setSetting, dismissHint } = useOfficeRender.getState();

  return (
    <div role="status" style={{
      position: 'absolute', left: 12, bottom: 12, zIndex: 25,
      maxWidth: 340,
      background: 'var(--cth-cream-50)',
      boxShadow: '0 0 0 2px var(--cth-ink-900), 4px 5px 0 0 var(--cth-ink-700)',
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 8,
      fontFamily: 'var(--cth-font-ui)'
    }}>
      <span style={{ fontSize: 13, color: 'var(--cth-ink-900)', fontWeight: 600 }}>
        {t('officeHint.title', { count: agentCount })}
      </span>
      <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
        {t('officeHint.body', { max: MANY_AGENTS })}
      </span>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <PixelButton variant="ghost" size="sm" onClick={dismissHint}>{t('officeHint.never')}</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={() => setSetting('auto')}>{t('officeHint.auto')}</PixelButton>
        <PixelButton variant="primary" size="sm" onClick={() => setSetting('still')}>{t('officeHint.still')}</PixelButton>
      </div>
    </div>
  );
}
