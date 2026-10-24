import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import { SkillsTab } from '@/components/SkillsTab';
import type { LocalSkill } from '../../../preload';
import { skillReach } from '@shared/skillReach';

/**
 * Skills — its own page, not a tab under Capabilities, because it answers
 * questions people ask on their own: what is a skill, which ones do my agents
 * have, where do I get more, and what is the orchestrator allowed to add.
 * One section per question, in that order.
 */
export function SkillsView({ roster, config }: { roster: Agent[]; config: HarnessConfig }) {
  const { t } = useTranslation();
  /** Bumped when the catalog installs something, so the installed list rescans. */
  const [installs, setInstalls] = useState(0);
  const nameOf = (id: string) => roster.find((a) => a.id === id)?.name ?? id;
  const providerName = (p: LocalSkill['provider']) => t(`pro.skills.provider_${p}`);

  /** "Used by" for an installed skill: every agent of its CLI, or the ones
   *  working in its project (shared/skillReach.ts). */
  const usedBy = (s: LocalSkill) => {
    const r = skillReach(s, roster);
    const text = r.everyone
      ? t('pro.skills.usedByEveryone', { cli: providerName(s.provider), count: r.agents.length })
      : r.agents.length
        ? t('pro.skills.usedBy', { names: r.agents.map(nameOf).join(', ') })
        : t('pro.skills.usedByNone');
    return <span style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>{text}</span>;
  };

  return (
    <div className="pro-page">
      <div className="pro-head">
        <h2>{t('pro.nav.skills')}</h2>
        <span className="pro-sub">{t('pro.skills.sub')}</span>
      </div>

      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{t('pro.skills.whatTitle')}</strong>
        <p className="pro-text">{t('pro.skills.what')}</p>
        <ul className="pro-text" style={{ margin: 0, paddingInlineStart: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <li>{t('pro.skills.whereUser')}</li>
          <li>{t('pro.skills.whereProject')}</li>
          <li>{t('pro.skills.whereOffice')}</li>
        </ul>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="pro-row">
          <strong style={{ fontSize: 14 }}>{t('pro.skills.installedTitle')}</strong>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.skills.installedSub')}</span>
        </span>
        <div className="pro-card pro-embed" style={{ padding: 0, height: 340, flex: 'none' }}>
          <SkillsTab mode="installed" refreshKey={installs} rowExtra={usedBy} />
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="pro-row">
          <strong style={{ fontSize: 14 }}>{t('pro.skills.catalogTitle')}</strong>
          <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.skills.catalogSub')}</span>
        </span>
        <div className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <SkillMarketplaces />
        </div>
        <div className="pro-card pro-embed" style={{ padding: 0, height: 520, flex: 'none' }}>
          <SkillsTab mode="browse" onInstalled={() => setInstalls((n) => n + 1)} />
        </div>
      </section>

      <OfficeSkills config={config} roster={roster} />
    </div>
  );
}

/** What the orchestrator may add as skills, in plain words, and what it has
 *  given whom (shared/skillRequests.ts applies the policy). */
function OfficeSkills({ config, roster }: { config: HarnessConfig; roster: Agent[] }) {
  const { t } = useTranslation();
  const [state, setState] = useState<Awaited<ReturnType<typeof window.cth.skillsOffice>> | null>(null);
  const load = () => { void window.cth.skillsOffice?.().then(setState).catch(() => setState({ skills: {} })); };
  useEffect(load, []);
  const policy = config.orchestratorSkills ?? 'official';
  const nameOf = (id: string) => (id === '*' ? t('pro.caps.skills.everyone') : roster.find((a) => a.id === id)?.name ?? id);
  const rows = Object.entries(state?.skills ?? {});
  return (
    <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="pro-row" style={{ flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14 }}>{t('pro.caps.skills.title')}</strong>
        <span className="pro-sub" style={{ fontSize: 12, flex: 1, minWidth: 200 }}>{t('pro.caps.skills.sub')}</span>
        <select className="pro-input" value={policy} aria-label={t('pro.caps.skills.policy')}
          onChange={(e) => void window.cth.updateConfig({ orchestratorSkills: e.target.value as 'off' | 'official' | 'mine' | 'catalog' })}>
          <option value="off">{t('pro.caps.skills.policy_off')}</option>
          <option value="official">{t('pro.caps.skills.policy_official')}</option>
          <option value="mine">{t('pro.caps.skills.policy_mine')}</option>
          <option value="catalog">{t('pro.caps.skills.policy_catalog')}</option>
        </select>
      </span>
      <p className="pro-text" style={{ padding: '8px 10px', background: 'var(--cth-cream-200)', borderRadius: 6 }}>
        {t(`pro.skills.policyExplain_${policy}`)}
      </p>
      {rows.length === 0
        ? <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.caps.skills.none')}</span>
        : rows.map(([name, s]) => (
          <span key={name} className="pro-row" style={{ flexWrap: 'wrap', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>{name}</strong>
            <span className="pro-chip">{s.owner}</span>
            <span className="pro-sub" style={{ fontSize: 12, flex: 1 }}>{s.agents.map(nameOf).join(', ')}</span>
            <button className="pro-btn" onClick={() => void window.cth.skillsOfficeRemove(name).then(load)}>{t('pro.caps.skills.remove')}</button>
          </span>
        ))}
    </section>
  );
}

/** Your own skill marketplaces: GitHub repos whose skills join the catalog
 *  (main/skillMarketplaces.ts). The catalog below and the orchestrator see them. */
function SkillMarketplaces() {
  const { t } = useTranslation();
  const [list, setList] = useState<Awaited<ReturnType<typeof window.cth.skillMarketplaces>> | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = (force = false) => { void window.cth.skillMarketplaces(force).then(setList).catch(() => setList([])); };
  useEffect(() => load(), []);
  const add = async () => {
    if (!url.trim()) return;
    setBusy(true); setNote(null);
    const r = await window.cth.addSkillMarketplace(url.trim());
    setBusy(false);
    if (r.ok) { setUrl(''); setNote({ ok: true, text: t('pro.caps.skills.mktAdded', { count: r.count ?? 0 }) }); load(); }
    else setNote({ ok: false, text: r.error ?? t('pro.caps.skills.mktFailed') });
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="pro-row" style={{ gap: 8 }}>
        <span className="pro-side-label" style={{ padding: 0 }}>{t('pro.caps.skills.mktTitle')}</span>
        <span className="pro-sub" style={{ fontSize: 12, flex: 1 }}>{t('pro.caps.skills.mktSub')}</span>
        {!!list?.length && <button className="pro-btn" style={{ padding: '1px 8px' }} onClick={() => load(true)}>{t('pro.caps.skills.mktRefresh')}</button>}
      </span>
      {list?.map((m) => (
        <span key={m.url} className="pro-row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{m.label}</strong>
          <span className="pro-chip">{t('pro.caps.skills.mktCount', { count: m.count })}</span>
          <span className="pro-sub pro-mono" style={{ fontSize: 11, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.url}>{m.url}</span>
          {m.error && <span className="pro-sub" style={{ fontSize: 11, color: 'var(--cth-coral)' }} title={m.error}>{t('pro.caps.skills.mktStale')}</span>}
          <button className="pro-btn" onClick={() => void window.cth.removeSkillMarketplace(m.url).then(() => load())}>{t('pro.caps.skills.remove')}</button>
        </span>
      ))}
      <span className="pro-row" style={{ gap: 8 }}>
        <input className="pro-input pro-mono" style={{ flex: 1, minWidth: 0 }} placeholder="https://github.com/your-org/skills" value={url}
          onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
        <button className="pro-btn pro-btn-primary" disabled={busy || !url.trim()} onClick={() => void add()}>{busy ? t('pro.caps.skills.mktReading') : t('pro.caps.skills.mktAdd')}</button>
      </span>
      {note && <span className="pro-sub" style={{ fontSize: 12, color: note.ok ? 'var(--cth-mint)' : 'var(--cth-coral)' }}>{note.text}</span>}
    </div>
  );
}
