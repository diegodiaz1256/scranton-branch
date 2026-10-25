import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FloorEntry } from '../../../preload/index';
import { folderName } from '@shared/folderName';

/**
 * The office this window runs, under the app's name in the sidebar. Opening it
 * lists the other floors (each an office of its own, in its own window) to
 * reopen or forget, and starts a new one. Same actions as the File menu.
 */
export function FloorSwitcher({ office, enabled }: { office: string | null; enabled: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [floors, setFloors] = useState<FloorEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Fixed, from the button: the sidebar clips anything that overflows it.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const load = () => { void window.cth.listFloors().then(setFloors).catch(() => setFloors([])); };
  useEffect(() => { if (open) load(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const name = office ? folderName(office) : t('pro.floors.noOffice');
  if (!enabled) return <span className="pro-sub" style={{ fontSize: 10 }} title={office ?? undefined}>{name}</span>;

  const others = (floors ?? []).filter((f) => !f.current);
  const label = (f: FloorEntry) => f.id === null ? (f.name ? `${t('pro.floors.main')} · ${f.name}` : t('pro.floors.main')) : f.name ?? t('pro.floors.noOffice');
  const forget = async (f: FloorEntry) => {
    if (!f.id) return;
    setError(null);
    const r = await window.cth.removeFloor(f.id);
    if (!r.ok) setError(r.error ?? null);
    load();
  };

  return (
    <div ref={box} className="pro-floor-switch">
      <button className="pro-floor-current" aria-expanded={open} title={office ?? undefined} onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setAt({ top: r.bottom + 6, left: r.left });
        setOpen((o) => !o);
      }}>
        {name} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="pro-floor-menu" role="menu" style={at ? { top: at.top, left: at.left } : undefined}>
          <div className="pro-side-label" style={{ padding: '2px 4px 6px' }}>{t('pro.floors.title')}</div>
          {floors === null ? <div className="pro-sub" style={{ padding: 6 }}>…</div>
            : others.length === 0 ? <div className="pro-sub" style={{ padding: 6 }}>{t('pro.floors.none')}</div>
            : others.map((f) => (
              <div key={f.id ?? 'main'} className="pro-floor-row">
                <button className="pro-floor-open" role="menuitem" title={f.office ?? undefined} onClick={() => { void window.cth.openFloor(f.id); setOpen(false); }}>
                  <span className="pro-floor-name">{label(f)}</span>
                  {f.running && <span className="pro-badge" style={{ fontSize: 10 }}>{t('pro.floors.running')}</span>}
                </button>
                {f.id !== null && !f.running && (
                  <button className="pro-floor-forget" title={t('pro.floors.forgetTitle')} aria-label={t('pro.floors.forgetTitle')} onClick={() => void forget(f)}>×</button>
                )}
              </div>
            ))}
          {error && <div className="pro-sub" style={{ color: 'var(--cth-coral)', padding: 6 }}>{error}</div>}
          <button className="pro-btn pro-btn-primary" style={{ width: '100%', marginTop: 6 }} title={t('pro.floors.newHint')} onClick={() => { void window.cth.newFloor(); setOpen(false); }}>
            + {t('pro.floors.new')}
          </button>
          <div className="pro-sub" style={{ fontSize: 11, padding: '6px 2px 0' }}>{t('pro.floors.newHint')}</div>
        </div>
      )}
    </div>
  );
}
