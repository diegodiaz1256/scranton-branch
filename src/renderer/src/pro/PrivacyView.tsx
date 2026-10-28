import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig } from '@/store/config';
import type { Agent } from '@/store/store';
import { ANON_CATEGORIES, TERM_CATEGORIES, type AnonCategory, type TermCategory } from '@shared/anonymize';
import {
  anonCategories, anonCoverage, anonEnabledFor,
  type AnonAgentStatus, type AnonDictionaryEntry, type AnonSettings, type AnonState
} from '@shared/anonSettings';
import { StateBadge, type Tone } from './data';
import { PreviewCard, SuggestionsCard } from './AnonymizeParts';

/**
 * Privacy → Anonymization (main/anonProxy.ts). Between an agent's CLI and its
 * model API, names from your dictionary, secrets and (if you want) emails and
 * IPs become codenames; the answers come back with the real values. Only the
 * human edits this: the generic config write drops it, and the dictionary is
 * kept encrypted in the app's data folder, never in a repo.
 */

const STATUS_TONE: Record<AnonAgentStatus, Tone> = { on: 'green', local: 'blue', off: 'grey', 'not-covered': 'amber' };

interface Row extends AnonDictionaryEntry { key: number; aliasText: string }

let rowKey = 0;
const toRows = (terms: AnonDictionaryEntry[]): Row[] => terms.map((t) => ({ ...t, key: ++rowKey, aliasText: (t.aliases ?? []).join(', ') }));
const fromRows = (rows: Row[]): AnonDictionaryEntry[] => rows
  .filter((r) => r.term.trim())
  .map((r) => ({
    term: r.term.trim(),
    category: r.category ?? 'other',
    aliases: r.aliasText.split(',').map((a) => a.trim()).filter(Boolean),
    ...(r.as?.trim() ? { as: r.as.trim() } : {})
  }));

export function PrivacyView({ roster }: { roster: Agent[]; config: HarnessConfig }) {
  const { t } = useTranslation();
  const [state, setState] = useState<AnonState | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [prefixes, setPrefixes] = useState('');
  const [secret, setSecret] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    const s = await window.cth.anonGet();
    setState(s);
    setRows(toRows(s.dictionary.terms));
    setPrefixes(s.dictionary.ticketPrefixes.join(', '));
    setDirty(false);
  }, []);
  useEffect(() => { void reload().catch((e) => setError(String(e))); }, [reload]);

  if (!state) return <div className="pro-page"><div className="pro-head"><h2>{t('pro.nav.privacy')}</h2></div></div>;
  const settings = state.settings;
  const cats = anonCategories(settings);
  const agents = roster.filter((a) => !a.archived);

  const saveSettings = async (next: AnonSettings) => {
    setError(null);
    try { const r = await window.cth.anonSetSettings(next); setState({ ...state, settings: r.settings }); }
    catch (e) { setError(String(e)); }
  };
  const setCategory = (c: AnonCategory, on: boolean) => void saveSettings({ ...settings, categories: { ...(settings.categories ?? {}), [c]: on } });
  const setOverride = (id: string, v: 'office' | 'on' | 'off') => {
    const agentsMap = { ...(settings.agents ?? {}) };
    if (v === 'office') delete agentsMap[id]; else agentsMap[id] = v === 'on';
    void saveSettings({ ...settings, agents: agentsMap });
  };

  const edit = (key: number, patch: Partial<Row>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setDirty(true); setSaved(false); };
  const saveDictionary = async () => {
    setBusy(true); setError(null);
    try {
      const r = await window.cth.anonSetDictionary({ terms: fromRows(rows), ticketPrefixes: prefixes.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean) });
      if (!r.ok) setError(r.error ?? t('integrations.couldNotSave'));
      else { await reload(); setSaved(true); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const addSecret = async () => {
    if (!secret) return;
    setBusy(true); setError(null);
    try {
      const r = await window.cth.anonAddSecret(secret);
      if (!r.ok) setError(r.error ?? t('integrations.couldNotSave'));
      else { setSecret(''); setState({ ...state, dictionary: { ...state.dictionary, secretCount: r.secretCount } }); }
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const clearSecrets = async () => {
    if (!(await window.cth.confirm(t('pro.privacy.clearSecretsConfirm'), { ok: t('pro.privacy.clearSecrets') }))) return;
    const r = await window.cth.anonClearSecrets();
    if (r.ok) setState({ ...state, dictionary: { ...state.dictionary, secretCount: r.secretCount } });
  };

  const coverageText = (a: Agent): string => {
    const p = a.provider ?? 'claude';
    if (p === 'opencode' || p === 'pi') return t('pro.privacy.coverDepends');
    const c = anonCoverage(p);
    return c.covered === false ? t('pro.privacy.coverNo', { why: t(`pro.privacy.reason_${c.reason}`) }) : t('pro.privacy.coverYes');
  };

  return (
    <div className="pro-page" style={{ gap: 12 }}>
      <div className="pro-head"><h2>{t('pro.nav.privacy')}</h2></div>
      <p className="pro-text" style={{ margin: 0 }}>{t('pro.privacy.intro')}</p>

      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <label className="pro-row" style={{ gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={settings.enabled === true} onChange={(e) => void saveSettings({ ...settings, enabled: e.target.checked })} />
          <strong style={{ fontSize: 14 }}>{t('pro.privacy.officeOn')}</strong>
        </label>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.officeOnBody')}</span>
        <label className="pro-row pro-sub" style={{ gap: 8, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={settings.refuseUncovered === true} onChange={(e) => void saveSettings({ ...settings, refuseUncovered: e.target.checked })} />
          {t('pro.privacy.refuseUncovered')}
        </label>
        <span className="pro-sub" style={{ fontSize: 11.5 }}>
          {t(state.proxy === 'running' ? 'pro.privacy.proxyRunning' : 'pro.privacy.proxyStopped')}
          {' · '}
          {t(state.encrypted ? 'pro.privacy.storedEncrypted' : 'pro.privacy.storedPlain')}
        </span>
        {state.dictionaryError && <span className="pro-text" style={{ fontSize: 12, color: 'var(--cth-coral)' }}>{t('pro.privacy.dictionaryError', { error: state.dictionaryError })}</span>}
      </section>

      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <strong style={{ fontSize: 14 }}>{t('pro.privacy.categories')}</strong>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.categoriesBody')}</span>
        {ANON_CATEGORIES.map((c) => (
          <label key={c} className="pro-row pro-sub" style={{ gap: 8, fontSize: 12, cursor: 'pointer', alignItems: 'baseline' }}>
            <input type="checkbox" checked={cats[c]} onChange={(e) => setCategory(c, e.target.checked)} />
            <span style={{ fontWeight: 600 }}>{t(`pro.privacy.cat_${c}`)}</span>
            <span style={{ fontSize: 11.5 }}>{t(`pro.privacy.catHint_${c}`)}</span>
          </label>
        ))}
      </section>

      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{t('pro.privacy.dictionary')}</strong>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.dictionaryBody')}</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => (
            <div key={r.key} className="pro-row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <input className="pro-input" style={{ flex: '2 1 160px' }} placeholder={t('pro.privacy.termPh')} aria-label={t('pro.privacy.term')} value={r.term} onChange={(e) => edit(r.key, { term: e.target.value })} />
              <input className="pro-input" style={{ flex: '2 1 160px' }} placeholder={t('pro.privacy.aliasesPh')} aria-label={t('pro.privacy.aliases')} value={r.aliasText} onChange={(e) => edit(r.key, { aliasText: e.target.value })} />
              <select className="pro-input" style={{ flex: '1 1 110px' }} aria-label={t('pro.privacy.category')} value={r.category ?? 'other'} onChange={(e) => edit(r.key, { category: e.target.value as TermCategory })}>
                {TERM_CATEGORIES.map((c) => <option key={c} value={c}>{t(`pro.privacy.tcat_${c}`)}</option>)}
              </select>
              <input className="pro-input" style={{ flex: '1 1 120px' }} placeholder={t('pro.privacy.codenamePh')} aria-label={t('pro.privacy.codename')} value={r.as ?? ''} onChange={(e) => edit(r.key, { as: e.target.value })} />
              <button className="pro-btn" onClick={() => { setRows((rs) => rs.filter((x) => x.key !== r.key)); setDirty(true); }}>{t('pro.privacy.remove')}</button>
            </div>
          ))}
          <div className="pro-row" style={{ gap: 6 }}>
            <button className="pro-btn" onClick={() => { setRows((rs) => [...rs, { key: ++rowKey, term: '', category: 'other', aliasText: '' }]); setDirty(true); }}>{t('pro.privacy.addTerm')}</button>
          </div>
        </div>
        <label className="pro-sub" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          {t('pro.privacy.ticketPrefixes')}
          <input className="pro-input pro-mono" placeholder="INFOSEC, OPS" value={prefixes} onChange={(e) => { setPrefixes(e.target.value.toUpperCase()); setDirty(true); setSaved(false); }} />
        </label>
        <div className="pro-row" style={{ gap: 8 }}>
          <button className="pro-btn pro-btn-primary" disabled={busy || !dirty} onClick={() => void saveDictionary()}>{t('pro.privacy.saveDictionary')}</button>
          {saved && !dirty && <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.saved')}</span>}
        </div>
        <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.privacy.liveNote')}</span>
      </section>

      <SuggestionsCard
        onAdd={(terms, prefixesAdded) => {
          if (terms.length) setRows((rs) => [...rs, ...toRows(terms)]);
          if (prefixesAdded.length) setPrefixes((p) => [...new Set([...p.split(/[,\s]+/).filter(Boolean), ...prefixesAdded])].join(', '));
          if (terms.length || prefixesAdded.length) { setDirty(true); setSaved(false); }
        }}
        onSecretCount={(n) => setState((s) => (s ? { ...s, dictionary: { ...s.dictionary, secretCount: n } } : s))}
      />

      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>{t('pro.privacy.secrets')}</strong>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.secretsBody')}</span>
        <div className="pro-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <input className="pro-input pro-mono" type="password" autoComplete="off" style={{ flex: '1 1 220px' }} placeholder={t('pro.privacy.secretPh')} value={secret} onChange={(e) => setSecret(e.target.value)} />
          <button className="pro-btn" disabled={busy || secret.length < 4} onClick={() => void addSecret()}>{t('pro.privacy.addSecret')}</button>
          {state.dictionary.secretCount > 0 && <button className="pro-btn" onClick={() => void clearSecrets()}>{t('pro.privacy.clearSecrets')}</button>}
        </div>
        <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.privacy.secretCount', { count: state.dictionary.secretCount })}</span>
      </section>

      <PreviewCard />

      <section className="pro-card" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <strong style={{ fontSize: 14 }}>{t('pro.privacy.agents')}</strong>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.privacy.agentsBody')}</span>
        {agents.map((a) => {
          const own = settings.agents?.[a.id];
          const last = state.statuses[a.id];
          return (
            <div key={a.id} className="pro-row" style={{ gap: 8, flexWrap: 'wrap', padding: '4px 0', borderBottom: '1px solid var(--pro-line)' }}>
              <span style={{ fontWeight: 600, fontSize: 13, minWidth: 120 }}>{a.name}</span>
              <span className="pro-sub pro-mono" style={{ fontSize: 11.5 }}>{a.provider ?? 'claude'}</span>
              <span className="pro-sub" style={{ fontSize: 11.5, flex: 1, minWidth: 160 }}>{coverageText(a)}</span>
              {last
                ? <StateBadge label={t(`pro.privacy.status_${last.status}`)} tone={STATUS_TONE[last.status]} />
                : <span className="pro-sub" style={{ fontSize: 11.5 }}>{t(anonEnabledFor(settings, a.id) ? 'pro.privacy.nextStartOn' : 'pro.privacy.nextStartOff')}</span>}
              <div className="pro-switch" role="group" aria-label={t('pro.privacy.override')}>
                {(['office', 'on', 'off'] as const).map((v) => (
                  <button key={v} aria-pressed={(v === 'office' && own === undefined) || (v === 'on' && own === true) || (v === 'off' && own === false)} onClick={() => setOverride(a.id, v)}>{t(`pro.privacy.override_${v}`)}</button>
                ))}
              </div>
            </div>
          );
        })}
        <span className="pro-sub" style={{ fontSize: 11.5 }}>{t('pro.privacy.restartNote')}</span>
      </section>

      {error && <span className="pro-text" style={{ color: 'var(--cth-coral)' }}>{error}</span>}
    </div>
  );
}
