import { useState, useEffect, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { HarnessConfig, AgentProvider } from '@/store/config';
import { PixelButton } from './PixelButton';
import { ProviderLogo } from './ProviderLogo';
import { useStore } from '@/store/store';
import { PROVIDER_BACKENDS } from '@shared/providerBackends';
import { normalizeModelHost, resolvePiModelHosts, type PiModelHostsConfig } from '@shared/piModelHosts';

/**
 * AiEnginesSettings — the v0.3.1 per-provider config surface for the BYOK CLI
 * engines (OpenCode · Crush · pi.dev · Qwen). Two stores by what the datum is:
 *  - API keys → WRITE-ONLY in the secret broker (`providerKey:*` IPC). Keyed by the
 *    BACKEND model-provider (anthropic/openai/…). The field shows only set/not-set;
 *    the plaintext is never read back to the renderer (materialized MAIN-only at spawn).
 *  - Local base-URL + default model → HarnessConfig (`providerBaseUrls` /
 *    `providerDefaultModels`), keyed by CLI provider. Non-secret; normal config save.
 * See hive/shared/cli-agents/settings-ui-schema.md.
 */

/** Backend model-providers whose keys the CLIs read from standard env vars. Must
 *  match BACKEND_KEY_ENV in src/main/index.ts. */
const BACKENDS = PROVIDER_BACKENDS;

/** CLI engines that take a per-provider local base-URL + default model. `hint`
 *  values are technical endpoint descriptions — kept English (technical data). */
const CLIS: Array<{ id: AgentProvider; label: string; hint: string }> = [
  { id: 'opencode', label: 'OpenCode', hint: 'http://localhost:11434/v1 (Ollama) — injected as a local provider' },
  { id: 'crush', label: 'Crush', hint: 'OpenAI-compatible endpoint — used as the proxy upstream' },
  { id: 'qwen', label: 'Qwen', hint: 'OpenAI-compatible endpoint — used as the proxy upstream' }
];

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 13,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};
const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};
const headStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 2
};

export function AiEnginesSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  // Keep the global "OpenAI key present" signal (boolean only) live so the Talk
  // button's missing-key warning clears the instant the user saves their OpenAI key
  // here — without it the gate only refreshes on next app start. apikey:openai is
  // the same key the Realtime mint reads; saving/clearing it flips the gate.
  const setHasOpenAiKey = useStore((s) => s.setHasOpenAiKey);
  // Which backends already have a key stored (boolean only — never the value).
  const [hasKey, setHasKey] = useState<Record<string, boolean>>({});
  const [draftKey, setDraftKey] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  // Base-URL + default-model drafts, seeded from config.
  const [baseUrls, setBaseUrls] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerBaseUrls ?? {}
  );
  const [models, setModels] = useState<Partial<Record<AgentProvider, string>>>(
    config.providerDefaultModels ?? {}
  );

  // Reseed set/not-set flags on mount (write-only — only the boolean is fetched).
  useEffect(() => {
    let alive = true;
    (async () => {
      const out: Record<string, boolean> = {};
      for (const b of BACKENDS) {
        try { out[b.id] = await window.cth.providerKeyHas(b.id); } catch { out[b.id] = false; }
      }
      if (alive) setHasKey(out);
    })();
    return () => { alive = false; };
  }, []);

  const saveKey = async (backend: string) => {
    const key = (draftKey[backend] ?? '').trim();
    if (!key) return;
    try {
      const r = await window.cth.providerKeySet({ backend, key });
      if (r.ok) {
        setHasKey((s) => ({ ...s, [backend]: true }));
        setDraftKey((s) => ({ ...s, [backend]: '' }));
        setNote((s) => ({ ...s, [backend]: t('aiEngines.saved') }));
        // OpenAI key gates Talk — mirror presence to the store so the warning clears now.
        if (backend === 'openai') setHasOpenAiKey(true);
      } else setNote((s) => ({ ...s, [backend]: r.error ?? t('aiEngines.failed') }));
    } catch (e) { setNote((s) => ({ ...s, [backend]: e instanceof Error ? e.message : String(e) })); }
  };
  const clearKey = async (backend: string) => {
    try {
      await window.cth.providerKeyClear(backend);
      setHasKey((s) => ({ ...s, [backend]: false }));
      setNote((s) => ({ ...s, [backend]: t('aiEngines.cleared') }));
      // OpenAI key gates Talk — clearing it disables Talk; reflect that immediately.
      if (backend === 'openai') setHasOpenAiKey(false);
    } catch { /* noop */ }
  };

  const saveBaseUrl = async (id: AgentProvider, value: string) => {
    const next = { ...baseUrls, [id]: value.trim() || undefined };
    setBaseUrls(next);
    try { await window.cth.updateConfig({ providerBaseUrls: next }); } catch { /* noop */ }
  };
  const saveModel = async (id: AgentProvider, value: string) => {
    const next = { ...models, [id]: value.trim() || undefined };
    setModels(next);
    try { await window.cth.updateConfig({ providerDefaultModels: next }); } catch { /* noop */ }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={headStyle}>{t('aiEngines.providers')}</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '18px' }}>
          {t('aiEngines.providersDesc')}
        </div>
      </div>

      {/* Backend API keys (write-only) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={headStyle}>{t('aiEngines.apiKeys')}</div>
        {BACKENDS.map((b) => (
          <div key={b.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={labelStyle}>
              {b.label} {hasKey[b.id] ? `· ${t('aiEngines.setCheck')}` : ''} <span style={{ opacity: 0.6 }}>({b.envVar})</span>
            </label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="password"
                autoComplete="off"
                placeholder={hasKey[b.id] ? t('aiEngines.keyStoredPlaceholder') : t('aiEngines.keyPlaceholder', { label: b.label })}
                value={draftKey[b.id] ?? ''}
                onChange={(e) => setDraftKey((s) => ({ ...s, [b.id]: e.target.value }))}
                style={inputStyle}
              />
              <PixelButton variant="secondary" size="sm" onClick={() => saveKey(b.id)}>{t('common.save')}</PixelButton>
              {hasKey[b.id] && (
                <PixelButton variant="secondary" size="sm" onClick={() => clearKey(b.id)}>{t('common.delete')}</PixelButton>
              )}
            </div>
            {note[b.id] && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{note[b.id]}</div>}
          </div>
        ))}
      </div>

      {/* Per-CLI local endpoint + default model */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={headStyle}>{t('aiEngines.localEndpoint')}</div>
        {CLIS.map((c) => (
          <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 6 }}>
              <ProviderLogo provider={c.id} size={12} /> {c.label}
            </label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder={`base-URL — ${c.hint}`}
                defaultValue={baseUrls[c.id] ?? ''}
                onBlur={(e) => saveBaseUrl(c.id, e.target.value)}
                style={inputStyle}
              />
              <input
                placeholder={t('aiEngines.defaultModelPlaceholder')}
                defaultValue={models[c.id] ?? ''}
                onBlur={(e) => saveModel(c.id, e.target.value)}
                style={{ ...inputStyle, maxWidth: 220 }}
              />
            </div>
          </div>
        ))}
      </div>

      <PiSandboxSettings config={config} />

      <CertificatesSettings config={config} />

      {/* Unsandboxed-in-auto caveat (Pam guardrail #6) */}
      <div style={{
        fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px',
        padding: 8, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', background: 'var(--cth-paper-100)'
      }}>
        {t('aiEngines.autoModeCaveat')}
      </div>
    </div>
  );
}

/** pi has no OS sandbox of its own (the app builds one with bubblewrap on
 *  Linux and WSL floors): refuse pi agents where it cannot (shared/piSandbox.ts),
 *  and the hosts a pi custodian may reach over HTTPS besides the app's loopback
 *  services (sb-netgate, shared/piModelHosts.ts). */
function PiSandboxSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [refuse, setRefuse] = useState(config.piRequireSandbox === true);
  const [hosts, setHosts] = useState<PiModelHostsConfig>({ hosts: config.piModelHosts?.hosts ?? [], mode: config.piModelHosts?.mode === 'replace' ? 'replace' : 'add' });
  const [detected, setDetected] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void window.cth.piModelHosts().then((r) => { if (alive) setDetected(r.detected); }, () => { if (alive) setDetected([]); });
    return () => { alive = false; };
  }, []);

  const saveRequire = async (on: boolean) => {
    setRefuse(on);
    try { await window.cth.updateConfig({ piRequireSandbox: on }); } catch { /* noop */ }
  };
  const saveHosts = async (next: PiModelHostsConfig) => {
    setHosts(next);
    try { await window.cth.updateConfig({ piModelHosts: next }); } catch { /* noop */ }
  };
  const add = () => {
    const n = normalizeModelHost(draft);
    if (!n.ok) { setError(t(`aiEngines.piHostError.${n.error}`)); return; }
    setError('');
    setDraft('');
    if (!hosts.hosts.includes(n.host)) void saveHosts({ ...hosts, hosts: [...hosts.hosts, n.host] });
  };

  const resolved = resolvePiModelHosts(detected ?? [], hosts);
  const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--cth-ink-900)' };
  const chip: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 6px', fontSize: 12, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-900)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={headStyle}>{t('aiEngines.piSandbox')}</div>
      <label style={row}>
        <input type="checkbox" checked={refuse} onChange={(e) => void saveRequire(e.target.checked)} />
        {t('aiEngines.piRequireSandbox')}
      </label>
      <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>{t('aiEngines.piRequireSandboxDesc')}</div>

      <label style={{ ...labelStyle, marginTop: 6 }}>{t('aiEngines.piHosts')}</label>
      <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>{t('aiEngines.piHostsDesc')}</div>
      <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
        {detected === null ? t('aiEngines.piHostsLoading') : detected.length ? t('aiEngines.piHostsDetected', { list: detected.join(', ') }) : t('aiEngines.piHostsNoneDetected')}
      </div>
      <label style={row}>
        <input type="radio" name="pi-model-hosts-mode" checked={hosts.mode === 'add'} onChange={() => void saveHosts({ ...hosts, mode: 'add' })} />
        {t('aiEngines.piHostsModeAdd')}
      </label>
      <label style={row}>
        <input type="radio" name="pi-model-hosts-mode" checked={hosts.mode === 'replace'} onChange={() => void saveHosts({ ...hosts, mode: 'replace' })} />
        {t('aiEngines.piHostsModeReplace')}
      </label>
      {hosts.hosts.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {hosts.hosts.map((h) => (
            <span key={h} style={chip}>
              {h}
              <button
                type="button"
                aria-label={t('aiEngines.piHostRemove', { host: h })}
                title={t('aiEngines.piHostRemove', { host: h })}
                onClick={() => void saveHosts({ ...hosts, hosts: hosts.hosts.filter((x) => x !== h) })}
                style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--cth-ink-700)', font: 'inherit' }}
              >×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          placeholder={t('aiEngines.piHostPlaceholder')}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          style={inputStyle}
        />
        <PixelButton variant="secondary" size="sm" onClick={add} disabled={!draft.trim()}>{t('aiEngines.piHostAdd')}</PixelButton>
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--cth-ink-900)', padding: '4px 8px', background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)' }}>{error}</div>}
      <div style={{ fontSize: 12, color: 'var(--cth-ink-900)' }}>
        {resolved.length ? t('aiEngines.piHostsResolved', { list: resolved.join(', ') }) : t('aiEngines.piHostsResolvedNone')}
      </div>
    </div>
  );
}

type TlsCfg = NonNullable<HarnessConfig['tls']>;

/** Certificates for agents' HTTPS to a custom endpoint (src/main/caBundle.ts):
 *  trust the Windows / WSL stores and/or an extra CA file, verification on/off,
 *  and a connection test against an endpoint with those settings. */
function CertificatesSettings({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [tls, setTls] = useState<TlsCfg>({ verify: true, ...(config.tls ?? {}) });
  const [bundle, setBundle] = useState<{ count: number; errors: string[] } | null>(null);
  const [testUrl, setTestUrl] = useState(config.providerBaseUrls?.qwen ?? config.providerBaseUrls?.crush ?? config.providerBaseUrls?.opencode ?? '');
  const [testNote, setTestNote] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setBundle(await window.cth.tlsStatus()); } catch { /* noop */ }
  };
  const save = async (patch: Partial<TlsCfg>) => {
    const next = { ...tls, ...patch };
    setTls(next);
    try { await window.cth.updateConfig({ tls: next }); } catch { /* noop */ }
    if (next.caFile || next.trustWindows || next.trustWsl) void refresh(); else setBundle(null);
  };
  useEffect(() => { if (tls.caFile || tls.trustWindows || tls.trustWsl) void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const browse = async () => {
    const r = await window.cth.tlsPickCaFile();
    if (r.ok) void save({ caFile: r.path });
  };
  const test = async () => {
    setBusy(true);
    setTestNote('');
    try {
      const r = await window.cth.tlsTest(testUrl);
      setTestNote(r.ok ? t('aiEngines.certsTestOk', { status: r.status }) : t('aiEngines.certsTestFail', { error: r.error }));
    } finally { setBusy(false); }
  };

  const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--cth-ink-900)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={headStyle}>{t('aiEngines.certs')}</div>
      <div style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>{t('aiEngines.certsDesc')}</div>
      <label style={row}>
        <input type="checkbox" checked={!!tls.trustWindows} onChange={(e) => void save({ trustWindows: e.target.checked })} />
        {t('aiEngines.certsTrustWindows')}
      </label>
      <label style={row}>
        <input type="checkbox" checked={!!tls.trustWsl} onChange={(e) => void save({ trustWsl: e.target.checked })} />
        {t('aiEngines.certsTrustWsl')}
      </label>
      <label style={labelStyle}>{t('aiEngines.certsCaFile')}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          key={tls.caFile ?? ''}
          placeholder={t('aiEngines.certsCaFilePlaceholder')}
          defaultValue={tls.caFile ?? ''}
          onBlur={(e) => { if ((e.target.value.trim() || undefined) !== tls.caFile) void save({ caFile: e.target.value.trim() || undefined }); }}
          style={inputStyle}
        />
        <PixelButton variant="secondary" size="sm" onClick={() => void browse()}>{t('aiEngines.certsBrowse')}</PixelButton>
      </div>
      <label style={row}>
        <input type="checkbox" checked={tls.verify !== false} onChange={(e) => void save({ verify: e.target.checked })} />
        {t('aiEngines.certsVerify')}
      </label>
      {tls.verify === false && (
        <div style={{ fontSize: 12, lineHeight: '17px', color: 'var(--cth-ink-900)', padding: 8, background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)' }}>
          {t('aiEngines.certsVerifyOffWarning')}
        </div>
      )}
      {bundle && (
        <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
          {t('aiEngines.certsBundle', { count: bundle.count })}
          {bundle.errors.map((e) => <div key={e}>⚠ {e}</div>)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          placeholder="https://your-endpoint/v1"
          value={testUrl}
          onChange={(e) => setTestUrl(e.target.value)}
          style={inputStyle}
        />
        <PixelButton variant="secondary" size="sm" onClick={() => void test()} disabled={busy || !testUrl.trim()}>{t('aiEngines.certsTest')}</PixelButton>
        {(tls.caFile || tls.trustWindows || tls.trustWsl) && (
          <PixelButton variant="secondary" size="sm" onClick={() => void refresh()}>{t('aiEngines.certsCheck')}</PixelButton>
        )}
      </div>
      {testNote && <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-word' }}>{testNote}</div>}
    </div>
  );
}
