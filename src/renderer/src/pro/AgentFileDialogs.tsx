import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type AgentProvider, type HarnessConfig } from '@/store/config';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import type { AccentColorName } from '@/design/tokens';
import { DEFAULT_EXPORT_PARTS, EXPORT_PARTS, fillPlaceholders, type AgentFile, type ExportPart, type ExportParts, type ImportPlan } from '@shared/agentFile';
import { mcpLabel } from '@shared/roleBundles';
import { folderName } from '@shared/folderName';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

/** What an export reads from the roster (main reads the rest from the config). */
function fieldsOf(a: Agent) {
  return {
    id: a.id, name: a.name, description: a.description, goal: a.goal, character: a.character, accent: a.accent,
    provider: a.provider, model: a.model, command: a.command, cwd: a.cwd, worktreePath: a.worktreePath
  };
}

/**
 * Export an agent to a file (shared/agentFile.ts): tick what goes in, read
 * the file main would write, save it. Main builds it from the config; this
 * dialog never holds a secret to leave out.
 */
export function ExportAgentDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { t } = useTranslation();
  const [parts, setParts] = useState<ExportParts>(DEFAULT_EXPORT_PARTS);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void window.cth.agentFilePreview(fieldsOf(agent), parts).then((r) => {
      if (!alive) return;
      if (r.ok && r.json) { setJson(r.json); setError(null); } else setError(r.error ?? 'export failed');
    });
    return () => { alive = false; };
  }, [agent, parts]);
  const flip = (p: ExportPart) => setParts((cur) => ({ ...cur, [p]: !cur[p], ...(p === 'skills' && cur.skills ? { skillFiles: false } : {}) }));
  const save = async () => {
    setBusy(true);
    setSaved(null);
    const r = await window.cth.agentFileSave(fieldsOf(agent), parts);
    setBusy(false);
    if (r.ok) setSaved(r.fileName ?? '');
    else if (r.error !== 'cancelled') setError(r.error ?? 'export failed');
  };
  return (
    <div className="pro-modal-back" role="presentation" onClick={onClose}>
      <div className="pro-card pro-modal" role="dialog" aria-modal="true" aria-labelledby="agent-export-title" style={{ width: 860 }}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <strong id="agent-export-title" style={{ fontSize: 15 }}>{t('pro.agentFile.exportTitle', { name: agent.name })}</strong>
        <span className="pro-text">{t('pro.agentFile.exportIntro')}</span>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', minHeight: 0 }}>
          <div style={{ flex: '1 1 300px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {EXPORT_PARTS.map((p) => (
              <label key={p} className="pro-text" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingInlineStart: p === 'skillFiles' ? 22 : 0 }}>
                <input type="checkbox" checked={parts[p]} disabled={p === 'skillFiles' && !parts.skills} onChange={() => flip(p)} />
                <span>
                  {t(`pro.agentFile.part_${p}`)}
                  {p === 'memory' && parts.memory && <span className="pro-sub" style={{ display: 'block', fontSize: 12, color: 'var(--cth-coral)' }}>⚠ {t('pro.agentFile.memoryWarn')}</span>}
                  {p === 'skillFiles' && parts.skillFiles && <span className="pro-sub" style={{ display: 'block', fontSize: 12 }}>{t('pro.agentFile.skillFilesWarn')}</span>}
                </span>
              </label>
            ))}
            <span className="pro-sub" style={{ fontSize: 12, marginTop: 4 }}>{t('pro.agentFile.never')}</span>
          </div>
          <div style={{ flex: '2 1 380px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="pro-sub" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' }}>{t('pro.agentFile.preview')}</span>
            <pre className="pro-mono" style={{ margin: 0, maxHeight: '52vh', overflow: 'auto', padding: 10, background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{json}</pre>
          </div>
        </div>
        {error && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12 }}>{error}</span>}
        {saved !== null && <span className="pro-text" style={{ fontSize: 12 }}>{t('pro.agentFile.saved', { file: saved })}</span>}
        <div className="pro-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="pro-btn" onClick={onClose}>{saved !== null ? t('common.close') : t('common.cancel')}</button>
          <button className="pro-btn pro-btn-primary" disabled={busy || !json} onClick={() => void save()}>{busy ? t('pro.agentFile.saving') : t('pro.agentFile.save')}</button>
        </div>
      </div>
    </div>
  );
}

export interface OpenedAgentFile { fileName: string; file: AgentFile; plan: ImportPlan }

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'}-${Date.now().toString(36)}`;
}

/**
 * Hire from an agent file: what it sets up, what is missing here, the
 * human's choices, then Hire. Main applies the plan for the new id before the
 * spawn (agentFile:apply); the command comes from this office's own preset.
 */
export function ImportAgentDialog({ opened, config, onClose }: { opened: OpenedAgentFile; config: HarnessConfig; onClose: () => void }) {
  const { t } = useTranslation();
  const { plan, file } = opened;
  const addAgent = useStore((s) => s.addAgent);
  const [name, setName] = useState(plan.name);
  const [cwd, setCwd] = useState(config.registeredRepos[0] ?? config.harnessHome ?? '');
  const [skills, setSkills] = useState(plan.skills.install.length + plan.skills.present.length > 0);
  const [skillFiles, setSkillFiles] = useState(false);
  const [memory, setMemory] = useState(false);
  const [bundle, setBundle] = useState(!!plan.bundle && !plan.bundle.exists);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);
  const provider: AgentProvider = plan.provider ?? inferAgentProvider(config.defaultCommand);
  let command = buildSpawnCommand(config, plan.model, provider);
  if (provider === 'claude' && plan.effort && !/(?:^|\s)--effort\b/.test(command)) command = `${command} --effort ${plan.effort}`;
  const filesHere = plan.skills.withFiles.filter((n) => plan.skills.unavailable.includes(n));
  const list = (xs: string[]) => xs.join(', ');

  const pickFolder = async () => {
    const r = await window.cth.chooseFolder();
    if (r.ok) setCwd(r.path);
  };
  const hire = async () => {
    setError(null);
    if (!name.trim()) { setError(t('pro.agentFile.errName')); return; }
    if (!cwd) { setError(t('pro.agentFile.errFolder')); return; }
    setBusy(true);
    const id = uniqueId(name.trim());
    const ptyId = `pty-${id}`;
    const applied = await window.cth.agentFileApply(id, file, { project: cwd, skills, skillFiles, memory, bundle });
    if (!applied.ok) { setBusy(false); setError(applied.error ?? 'import failed'); return; }
    const [exe, ...args] = tokenizeCommand(command);
    const res = await window.cth.spawnPty({
      id: ptyId, cwd, command: exe, provider, args, cols: 100, rows: 30, isolate: plan.isolate,
      hive: { id, name: name.trim(), provider, cwd, role: plan.role, capabilities: plan.tags.length ? plan.tags : undefined }
    });
    if (!res.ok) { setBusy(false); setError(res.error ?? 'spawn failed'); return; }
    const character: OfficeCharacterName = OFFICE_CAST.some((m) => m.name === plan.character) ? (plan.character as OfficeCharacterName) : DEFAULT_CHARACTER;
    const accent: AccentColorName = ACCENTS.includes(plan.accent as AccentColorName) ? (plan.accent as AccentColorName) : 'sky';
    const spawnedCwd = res.cwd || cwd;
    addAgent({
      id, name: name.trim(), character, accent,
      description: plan.role || 'a fresh harness',
      project: folderName(plan.isolate ? cwd : spawnedCwd),
      tmuxTarget: '', cwd: spawnedCwd,
      goal: plan.goal ? fillPlaceholders(plan.goal, applied.places ?? { project: cwd }) : undefined,
      status: 'idle', action: 'starting up', progress: 0, currentStation: 'desk',
      ptyId, command, provider, model: plan.model, worktreePath: res.worktreePath, seedPrompt: res.seedPrompt,
      recentTextTs: Date.now()
    });
    setBusy(false);
    // Hired; what could not be set up stays on screen until it is read.
    if (applied.notes?.length) setNotes(applied.notes);
    else onClose();
  };

  const missing: React.ReactNode[] = [];
  if (plan.needsConsent.length) missing.push(<li key="consent">{t('pro.agentFile.needsConsent', { names: list(plan.needsConsent.map(mcpLabel)) })}</li>);
  if (plan.connections.missing.length) missing.push(<li key="conn">{t('pro.agentFile.connMissing', { names: list(plan.connections.missing.map((c) => c.label)) })}</li>);
  if (plan.envMissing.length) missing.push(<li key="env">{t('pro.agentFile.envMissing', { names: list(plan.envMissing) })}</li>);
  if (plan.skills.unavailable.length) missing.push(<li key="sk">{t('pro.agentFile.skillsUnavailable', { names: list(plan.skills.unavailable) })}</li>);
  if (plan.unknownServers.length) missing.push(<li key="unk">{t('pro.agentFile.unknownServers', { names: list(plan.unknownServers) })}</li>);
  if (plan.mcpManual.length) missing.push(
    <li key="mcp">{t('pro.agentFile.mcpManual')}
      <ul style={{ margin: '2px 0 0', paddingInlineStart: 16 }}>
        {plan.mcpManual.map((m) => (
          <li key={m.name}><strong>{m.name}</strong> <span className="pro-mono" style={{ overflowWrap: 'anywhere' }}>{m.detail}</span>
            {m.secretNames.length > 0 && <span className="pro-sub" style={{ fontSize: 12 }}> · {t('pro.agentFile.mcpNeeds', { names: list(m.secretNames) })}</span>}</li>
        ))}
      </ul>
    </li>
  );

  const fact = (label: string, value: React.ReactNode) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 13, minWidth: 0 }}>
      <span className="pro-sub" style={{ flex: '0 0 130px', fontSize: 12 }}>{label}</span>
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );

  return (
    <div className="pro-modal-back" role="presentation" onClick={onClose}>
      <div className="pro-card pro-modal" role="dialog" aria-modal="true" aria-labelledby="agent-import-title" style={{ width: 760, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <strong id="agent-import-title" style={{ fontSize: 15 }}>{t('pro.agentFile.importTitle', { name: plan.name })}</strong>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.agentFile.importFrom', { file: opened.fileName })}{file.hire?.author ? ` · ${file.hire.author}` : ''}</span>
        <span className="pro-text">{t('pro.agentFile.importIntro')}</span>

        <label className="pro-sub" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {t('pro.agentFile.name')}
          <input className="pro-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="pro-sub" style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {t('pro.agentFile.folder')}
          <div className="pro-row">
            <span className="pro-mono" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', color: 'var(--cth-ink-900)' }}>{cwd || '—'}</span>
            <button className="pro-btn" onClick={() => void pickFolder()}>{t('pro.agentFile.pickFolder')}</button>
          </div>
        </div>

        <div className="pro-card" style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {fact(t('pro.agentFile.engine'), <span className="pro-mono">{command}</span>)}
          {plan.role && fact(t('pro.agentFile.role'), plan.role)}
          {plan.goal && fact(t('pro.agentFile.goal'), <span style={{ whiteSpace: 'pre-wrap' }}>{fillPlaceholders(plan.goal, { project: cwd, office: config.harnessHome ?? undefined })}</span>)}
          {plan.tags.length > 0 && fact(t('pro.agentFile.tags'), list(plan.tags))}
          {fact(t('pro.agentFile.grant'), plan.grant
            ? <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>{plan.grant.map((s) => <span key={s} className={`pro-chip ${plan.needsConsent.includes(s) ? 'pro-chip-off' : ''}`}>{mcpLabel(s)}{plan.access?.[s] === 'readwrite' ? ' · rw' : ''}</span>)}</span>
            : t('pro.agentFile.officeDefaults'))}
          {plan.toolBlocks.length > 0 && fact(t('pro.agentFile.toolBlocks'), list(plan.toolBlocks))}
          {plan.tokenCap && fact(t('pro.agentFile.tokenCap'), plan.tokenCap.toLocaleString())}
          {plan.isolate && fact(t('pro.agentFile.isolate'), '✓')}
        </div>

        {(plan.skills.install.length + plan.skills.present.length > 0) && (
          <label className="pro-text" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={skills} onChange={() => setSkills((v) => !v)} />
            <span>{t('pro.agentFile.skillsInstall', { names: list([...plan.skills.present, ...plan.skills.install.map((s) => `${s.name} (${s.owner})`)]) })}</span>
          </label>
        )}
        {filesHere.length > 0 && (
          <label className="pro-text" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={skillFiles} onChange={() => setSkillFiles((v) => !v)} />
            <span>{t('pro.agentFile.skillFilesInstall', { names: list(filesHere) })}
              <span className="pro-sub" style={{ display: 'block', fontSize: 12, color: 'var(--cth-coral)' }}>⚠ {t('pro.agentFile.skillFilesWarnImport')}</span></span>
          </label>
        )}
        {plan.memory && (
          <label className="pro-text" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={memory} onChange={() => setMemory((v) => !v)} />
            <span>{t('pro.agentFile.memoryImport')}
              <span className="pro-sub" style={{ display: 'block', fontSize: 12, color: 'var(--cth-coral)' }}>⚠ {t('pro.agentFile.memoryWarnImport')}</span></span>
          </label>
        )}
        {plan.bundle && !plan.bundle.exists && (
          <label className="pro-text" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={bundle} onChange={() => setBundle((v) => !v)} />
            <span>{t('pro.agentFile.bundleAdd', { label: plan.bundle.bundle.label })}</span>
          </label>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span className="pro-sub" style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase' }}>{t('pro.agentFile.missing')}</span>
          {missing.length
            ? <ul className="pro-text" style={{ margin: 0, paddingInlineStart: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>{missing}</ul>
            : <span className="pro-text">{t('pro.agentFile.nothingMissing')}</span>}
        </div>
        <span className="pro-sub" style={{ fontSize: 12 }}>{t('pro.agentFile.neverImported')}</span>

        {error && <span className="pro-text" style={{ color: 'var(--cth-coral)', fontSize: 12 }}>{error}</span>}
        {notes && <span className="pro-text" role="status" style={{ fontSize: 12 }}>{t('pro.agentFile.notes', { notes: notes.join(' · ') })}</span>}
        <div className="pro-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {notes
            ? <button className="pro-btn pro-btn-primary" onClick={onClose}>{t('common.close')}</button>
            : <>
              <button className="pro-btn" onClick={onClose}>{t('common.cancel')}</button>
              <button className="pro-btn pro-btn-primary" disabled={busy} onClick={() => void hire()}>{busy ? t('pro.agentFile.hiring') : t('pro.agentFile.hire')}</button>
            </>}
        </div>
      </div>
    </div>
  );
}

/** The Agents page's "Import agent" button: pick a file, then the preview. */
export function ImportAgentButton({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const [opened, setOpened] = useState<OpenedAgentFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setError(null);
    const r = await window.cth.agentFileOpen();
    if (r.ok && r.file && r.plan) setOpened({ fileName: r.fileName ?? '', file: r.file, plan: r.plan });
    else if (r.error !== 'cancelled') setError(t('pro.agentFile.openFailed', { file: r.fileName ?? '', error: r.error ?? '' }));
  };
  return (
    <>
      <button className="pro-btn" title={t('pro.agentFile.importTip')} onClick={() => void open()}>{t('pro.agentFile.import')}</button>
      {error && (
        <div className="pro-modal-back" role="presentation" onClick={() => setError(null)}>
          <div className="pro-card pro-modal pro-modal-danger" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setError(null); }}>
            <span className="pro-text" role="alert" style={{ overflowWrap: 'anywhere' }}>{error}</span>
            <div className="pro-row" style={{ justifyContent: 'flex-end' }}>
              <button className="pro-btn" autoFocus onClick={() => setError(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
      {opened && <ImportAgentDialog opened={opened} config={config} onClose={() => setOpened(null)} />}
    </>
  );
}
