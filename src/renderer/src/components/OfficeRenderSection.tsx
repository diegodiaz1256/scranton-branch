import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelButton } from './PixelButton';
import { useOfficeRender } from '@/store/officeRender';
import { MANY_AGENTS, OFFICE_RENDER_SETTINGS, type OfficeRenderSetting } from '@shared/officeRenderLevel';

/**
 * Settings → General: how much of the office floor to draw. Applies at once,
 * no restart: the floor switches in place, or swaps for the cards.
 */
export function OfficeRenderSection({ headStyle }: { headStyle: CSSProperties }) {
  const { t } = useTranslation();
  const setting = useOfficeRender((s) => s.setting);
  const autoLevel = useOfficeRender((s) => s.autoLevel);
  const setSetting = useOfficeRender((s) => s.setSetting);
  const label = (s: OfficeRenderSetting): string => t(`settings.officeRender.${s}`);

  return (
    <div>
      <div style={headStyle}>{t('settings.officeRender.title')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {OFFICE_RENDER_SETTINGS.map((s) => (
          <PixelButton
            key={s}
            variant={setting === s ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setSetting(s)}
          >
            {label(s)}
          </PixelButton>
        ))}
      </div>
      <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)', marginTop: 8 }}>
        {t(`settings.officeRender.${setting}Desc`, { max: MANY_AGENTS })}
        {setting === 'auto' && ' ' + t('settings.officeRender.autoNow', { level: label(autoLevel) })}
      </div>
    </div>
  );
}
