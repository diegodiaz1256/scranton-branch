import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { ProviderLogo } from './ProviderLogo';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import { type AccentColorName } from '@/design/tokens';
import type { HireManifest } from '@shared/hire';
import { hireQueueProgress } from '@shared/hireQueue';
import { MCP_CATALOG } from '@shared/mcpCatalog';
import { folderName } from '@shared/folderName';
import {
  OSS_LOCAL_PICKS,
  OSS_PROVIDER_PICKS,
  localSlugFor,
  hasOssQuickPicks
} from '@shared/ossModels';
import {
  type AgentProvider,
  type HarnessConfig,
  AGENT_PROVIDER_PRESETS,
  buildSpawnCommand,
  tokenizeCommand,
  modelsForProvider,
  ownModelsFor,
  inferAgentProvider,
  providerPreset,
  isClaudeProvider
} from '@/store/config';
import { useRtl } from '@/i18n/useDirection';
import { isEasyMode } from '@shared/uiMode';
import { EASY_HIRE_ENGINE, EASY_HIRE_ROLES, easyHireRole, type EasyHireRole } from '@shared/easyHire';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

// OSS quick-pick chip styling (ondev-c) — mirrors the model-picker chips.
const ossChip = (active: boolean, accent: AccentColorName): CSSProperties => ({
  padding: '3px 8px 1px',
  background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
  boxShadow: active ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12,
  color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
});
const ossGroupHead: CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 4
};

// One-click briefing templates — fill Description + Goal with a sharp, ready-to-run
// role so a user isn't staring at a blank field (item 7). The template BRIEFINGS
// stay English (they become agent prompts — see the i18n report); only the
// picker labels are translated.
const DESCRIPTION_TEMPLATES: { labelKey: string; description: string; goal: string }[] = [
  {
    labelKey: 'addAgent.templatesHint.repoJanitor.label',
    description: 'keeps the codebase tidy and healthy',
    goal: 'Continuously hunt for dead code, lint errors, flaky tests, and small safe refactors. Fix the safe ones and leave a note for anything risky. Never change behavior without flagging it.'
  },
  {
    labelKey: 'addAgent.templatesHint.docsWriter.label',
    description: 'keeps docs in sync with the code',
    goal: 'Watch for code changes that outdate the README and docs, then update them. Write for newcomers and prefer concrete examples over prose.'
  },
  {
    labelKey: 'addAgent.templatesHint.bugTriager.label',
    description: 'investigates and root-causes bugs',
    goal: 'For each reported issue: reproduce it, find the root cause, then propose a minimal fix with evidence. No fixes without a confirmed root cause.'
  },
  {
    labelKey: 'addAgent.templatesHint.researchAssistant.label',
    description: 'gathers and summarizes information',
    goal: 'Research the questions you are given across multiple sources, verify the key claims, and return a concise, cited summary.'
  },
  {
    labelKey: 'addAgent.templatesHint.releaseManager.label',
    description: 'prepares and ships releases',
    goal: 'Track what has shipped since the last release, update the changelog and version, and draft clear release notes.'
  }
];

// Copy-paste prompt the user hands to any AI to generate a hire manifest. It pins
// the exact JSON shape the importer accepts and ends with a fill-in section so the
// user adds their own details (item 7). Kept in sync with the HireManifest schema
// (src/shared/hire.ts) — provider allowlist is claude | codex | antigravity | cursor.
const HIRE_PROMPT = `You are designing a "hire" — a ready-to-spawn AI agent for Scranton Branch, an app that runs a team of CLI coding agents. Output ONE JSON object (a hire manifest) and nothing else.

Make the agent genuinely useful: give it a sharp role, a concrete standing goal, and a description that makes it behave like an expert operator of its CLI engine (Claude Code, Codex, or Antigravity/Gemini). It should know how to use the terminal, read and edit files, run and inspect commands, lean on available skills and MCP tools, keep notes in memory, and work autonomously toward its goal without hand-holding.

Return EXACTLY this shape (omit optional fields you don't need; keep the spec string verbatim):

{
  "spec": "munder-difflin/hire@1",
  "name": "Jim",
  "description": "one-line role — what this agent is for",
  "goal": "standing directive injected on every prompt — specific and outcome-oriented",
  "provider": "claude",
  "model": "claude-opus-4-8[1m]",
  "capabilities": ["code-review", "docs"],
  "isolate": false,
  "tokenCap": 2000000,
  "author": "your name"
}

Rules:
- "provider" MUST be one of: cursor | claude | codex | antigravity. "model" must be a real model id for that provider (e.g. gpt-5.6-luna-high, claude-opus-4-8[1m], gpt-5-codex, "Gemini 3.1 Pro (High)").
- Do NOT include shell commands or any flags beyond these fields.
- Make "description" + "goal" concrete enough that the agent knows exactly what to do on its first turn.

--- ADD YOUR DETAILS BELOW (the AI should use these) ---
Role / what I want this agent to do:
Preferred engine (claude / codex / antigravity), if any:
Repos, tools, style, or constraints to respect:
`;

// The Add Agent form has 11+ fields, so it's grouped into sections the user jumps
// between via a left sidebar index (one section shown at a time). Engine carries
// Command (it's the spawn command assembled from provider+model+flags); Workspace
// clusters Folder + Git isolation + Resume (all "where/how it runs"). Capabilities
// isn't a field here — it rides an imported hire manifest (the pinned banner).
type SectionKey = 'identity' | 'workspace' | 'engine' | 'briefing';
const SECTIONS: { key: SectionKey; labelKey: string; hintKey: string }[] = [
  { key: 'identity',  labelKey: 'addAgent.sections.identity.label',  hintKey: 'addAgent.sections.identity.hint' },
  { key: 'workspace', labelKey: 'addAgent.sections.workspace.label', hintKey: 'addAgent.sections.workspace.hint' },
  { key: 'engine',    labelKey: 'addAgent.sections.engine.label',    hintKey: 'addAgent.sections.engine.hint' },
  { key: 'briefing',  labelKey: 'addAgent.sections.briefing.label',  hintKey: 'addAgent.sections.briefing.hint' }
];

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
}

export interface AddAgentModalProps {
  onClose: () => void;
  config: HarnessConfig;
  /** Lift config changes (e.g. a project registered from this modal) back up to
   *  App so the rest of the UI — and the next time this modal opens — sees them. */
  onConfigChange?: (config: HarnessConfig) => void;
}

export function AddAgentModal({ onClose, config, onConfigChange }: AddAgentModalProps) {
  const { t: tr } = useTranslation();
  const rtl = useRtl();
  const addAgent = useStore(s => s.addAgent);
  // Deep links and file batches share one FIFO. The head alone seeds the form;
  // every item still requires an explicit spawn or skip.
  const hireQueue = useStore(s => s.hireQueue);
  const enqueuePendingHires = useStore(s => s.enqueuePendingHires);
  const finishPendingHire = useStore(s => s.finishPendingHire);
  const pendingHire = hireQueue.pending[0];
  const reviewProgress = hireQueueProgress(hireQueue);

  const knownCharacter = (c?: string): OfficeCharacterName =>
    (OFFICE_CAST.some(m => m.name === c) ? (c as OfficeCharacterName) : DEFAULT_CHARACTER);
  const knownAccent = (a?: string): AccentColorName =>
    (ACCENTS.includes(a as AccentColorName) ? (a as AccentColorName) : 'sky');
  /** The cast member a typed name refers to, if any.
   *
   *  The character tiles already set the name (clicking Meredith names the agent
   *  Meredith), but the coupling ran ONE WAY, so typing "Meredith" left the
   *  avatar on whatever was selected, in practice the Jim default. Same missing
   *  default as issue #191 from the other direction, where a manifest that omits
   *  `character` always lands on Jim.
   *
   *  Returns null on no match, and the caller leaves the avatar alone, so a
   *  deliberate pick is never overwritten by continuing to type. */
  const characterForName = (n: string): OfficeCharacterName | null => {
    const q = n.trim().toLowerCase();
    if (!q) return null;
    const hit = OFFICE_CAST.find(c => c.displayName.toLowerCase() === q || c.name === q);
    return hit ? hit.name : null;
  };
  /** The locally-built spawn command for a manifest: provider preset + model
   *  from the LOCAL config builder, with the manifest's validated flags
   *  appended. A manifest can never name the binary itself. */
  const hireCommand = (m: HireManifest): string => {
    const prov: AgentProvider = m.provider ?? inferAgentProvider(config.defaultCommand);
    const base = buildSpawnCommand(config, m.model, prov);
    return m.commandFlags?.length ? `${base} ${m.commandFlags.join(' ')}` : base;
  };

  // Default provider follows whatever the global default command is (claude
  // unless the user reconfigured it); the model only carries over for Claude.
  // Easy mode (a fresh hire, not a manifest under review) asks what the agent is
  // for and starts on Claude Code with Sonnet 5.5; the engine moves under Advanced.
  const easyHire = isEasyMode(config) && !pendingHire;
  const initialProvider: AgentProvider = easyHire ? EASY_HIRE_ENGINE.provider : inferAgentProvider(config.defaultCommand);
  const initialModel = easyHire ? EASY_HIRE_ENGINE.model : isClaudeProvider(initialProvider) ? config.defaultModel : undefined;

  const [name, setName] = useState(pendingHire?.name ?? 'Jim');
  // Pi's own ~/.pi/agent/models.json, offered beside the catalog models.
  const [piOwn, setPiOwn] = useState<string[]>([]);
  useEffect(() => {
    void window.cth.engineStatus?.('pi')?.then((s) => setPiOwn(s.ownModels ?? [])).catch(() => undefined);
  }, []);
  const [character, setCharacter] = useState<OfficeCharacterName>(knownCharacter(pendingHire?.character));
  const [accent, setAccent] = useState<AccentColorName>(knownAccent(pendingHire?.accent));
  // No project registered yet (a new office): the office folder itself, so a
  // hire is never stopped at "Pick a folder first" with nothing to pick.
  const [cwd, setCwd] = useState<string>(pendingHire?.cwd ?? config.registeredRepos[0] ?? config.harnessHome ?? '');
  // Local mirror of the registered projects so one added from here shows as a
  // quick-pick immediately (the `config` prop is a snapshot taken at open time).
  const [repos, setRepos] = useState<string[]>(config.registeredRepos);
  const [provider, setProvider] = useState<AgentProvider>(pendingHire?.provider ?? initialProvider);
  const [model, setModel] = useState<string | undefined>(
    pendingHire ? pendingHire.model : initialModel
  );
  const [command, setCommand] = useState(
    pendingHire ? hireCommand(pendingHire) : buildSpawnCommand(config, initialModel, initialProvider)
  );
  const [description, setDescription] = useState(pendingHire?.description ?? 'a fresh harness');
  const [hireMeta, setHireMeta] = useState<HireManifest | null>(pendingHire);
  /** A hire opens as a CV to read; "Edit details" switches to the full form. */
  const [cvMode, setCvMode] = useState<boolean>(!!pendingHire);

  // Picking a model rebuilds the command; the command field stays editable for
  // power users (it's the source of truth for the actual spawn).
  const pickModel = (id?: string) => {
    setModel(id);
    setCommand(buildSpawnCommand(config, id, provider));
  };
  // Switching provider resets the model to that CLI's default and rebuilds the
  // command from the provider's preset binary (so Antigravity spawns `agy` and
  // Codex spawns `codex`, not the configured `claude`). For 'custom' we keep the
  // user's typed command rather than blanking it.
  const pickProvider = (id: AgentProvider) => {
    setProvider(id);
    // Seed the model: Claude from the global defaultModel; other engines from the
    // per-engine default set in Settings → AI Engines (providerDefaultModels), else
    // the CLI default. This is what makes that Settings field live (Dwight NIT-1).
    const nextModel = isClaudeProvider(id) ? config.defaultModel : config.providerDefaultModels?.[id];
    setModel(nextModel);
    const nextPreset = providerPreset(id);
    if (!isClaudeProvider(id) && !nextPreset.resumeFlag && !nextPreset.resumeSubcommand) {
      setResumeSessionId('');
      setFolderNote(undefined);
    }
    if (id === 'custom') {
      setCommand(command.trim() || config.defaultCommand || '');
      return;
    }
    setCommand(buildSpawnCommand(config, nextModel, id));
  };
  const preset = providerPreset(provider);
  const [goal, setGoal] = useState(pendingHire?.goal ?? '');
  const [isolate, setIsolate] = useState(pendingHire?.isolate ?? false);
  // #2 — optional Claude session id to continue. When set, the spawn seeds that
  // session's transcript into the cwd's project dir and launches `--resume`.
  const [resumeSessionId, setResumeSessionId] = useState('');
  const resuming = resumeSessionId.trim().length > 0;
  // Note shown when the folder was auto-filled from the pasted session id.
  const [folderNote, setFolderNote] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  // Which config section the left sidebar index is showing.
  const [section, setSection] = useState<SectionKey>('identity');
  // Easy mode: the role picked from "What do you want it for?", and whether the
  // Advanced part of the index (the engine) is unfolded.
  const [easyRole, setEasyRole] = useState<EasyHireRole | null>(null);
  const [easyAdvancedOpen, setEasyAdvancedOpen] = useState(false);
  const pickEasyRole = (id: EasyHireRole): void => {
    setEasyRole(id);
    const r = easyHireRole(id);
    setDescription(r.description);
    setGoal(r.goal);
    if (!r.description) setSection('briefing'); // "Something else": say it in your own words
  };
  // "Generate a hire with AI" helper — reveals a copy-paste prompt (item 7).
  const [showHirePrompt, setShowHirePrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const copyHirePrompt = async () => {
    try {
      await navigator.clipboard.writeText(HIRE_PROMPT);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 1500);
    } catch { /* clipboard blocked — the textarea below is selectable as a fallback */ }
  };

  // Close only the modal on Esc. Capture prevents the fullscreen terminal's
  // window-level handler from also closing the view underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Zero-step resume: when a session id is entered, look up the cwd it originally
  // ran in (from the transcript) and pre-fill the Folder so the user doesn't have
  // to find the worktree. They can still override the folder afterwards. Runs on
  // blur so we don't hit the resolver on every keystroke.
  const resolveFolderFromSession = async () => {
    const sid = resumeSessionId.trim();
    if (!sid) { setFolderNote(undefined); return; }
    const resolved = await window.cth.resolveSessionCwd(sid);
    if (resolved) { setCwd(resolved); setFolderNote(tr('addAgent.folderFromSession', { path: resolved })); }
    else setFolderNote(undefined);
  };

  const pickFolder = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setCwd(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** Register `path` as a project (folder quick-pick) right now: dedupe-prepend,
   *  select it, persist to config, and lift the change up so it sticks. */
  const registerProject = async (path: string) => {
    const p = path.trim();
    if (!p) return;
    const next = [p, ...repos.filter((r) => r !== p)];
    setRepos(next);
    setCwd(p);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      // Main expands `~` when it persists registeredRepos, so adopt the stored
      // (absolute) list — otherwise a typed "~/dev/foo" stays literal in this
      // modal's state and rides along into the spawn.
      const stored = updated.registeredRepos ?? next;
      setRepos(stored);
      if (stored[0]) setCwd(stored[0]);
      onConfigChange?.(updated);
    } catch { /* best-effort persist */ }
  };

  /** Drop `path` from the project quick-picks.
   *
   *  Removes it from the LISTING only. The folder on disk is never touched, which
   *  is the whole point: a project you are done with should stop cluttering the
   *  picker without anything being deleted. */
  const unregisterProject = async (path: string) => {
    const next = repos.filter((r) => r !== path);
    setRepos(next);
    try {
      const updated = await window.cth.updateConfig({ registeredRepos: next });
      setRepos(updated.registeredRepos ?? next);
      onConfigChange?.(updated);
    } catch { /* best-effort persist */ }
  };

  /** Pick a brand-new folder and register it as a project in one step. */
  const addProject = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) await registerProject(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  /** Apply an imported manifest to every form field (file import path). The
   *  command is rebuilt locally from the provider preset + validated flags — a
   *  manifest can never inject the spawn binary. Import never spawns. */
  const applyManifest = (m: HireManifest) => {
    setHireMeta(m);
    setCvMode(true);
    // A local manifest may name its folder; otherwise keep the current pick.
    setCwd((c) => m.cwd || c || config.harnessHome || '');
    setName(m.name);
    // A manifest that names an agent but omits `character` should get the
    // matching avatar rather than the Jim default (issue #191).
    setCharacter(m.character ? knownCharacter(m.character) : (characterForName(m.name ?? '') ?? knownCharacter(undefined)));
    setAccent(knownAccent(m.accent));
    setProvider(m.provider ?? initialProvider);
    setModel(m.model);
    setCommand(hireCommand(m));
    setDescription(m.description ?? 'a fresh harness');
    setGoal(m.goal ?? '');
    setIsolate(m.isolate ?? false);
    setResumeSessionId(m.sessionId ?? '');
    setFolderNote(undefined);
    setSection('identity');
    // A session to continue and no folder given: use the folder it ran in.
    if (m.sessionId && !m.cwd) {
      void window.cth.resolveSessionCwd(m.sessionId).then((resolved) => {
        if (resolved) { setCwd(resolved); setFolderNote(tr('addAgent.folderFromSession', { path: resolved })); }
      });
    }
  };

  // Advancing a batch keeps this modal mounted. Re-seed every form field when
  // the queue head changes so edits made while reviewing one hire cannot leak
  // into the next.
  useLayoutEffect(() => {
    if (pendingHire) applyManifest(pendingHire);
  // applyManifest intentionally closes over the config snapshot used by this
  // open modal; queue advances do not replace that snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingHire]);

  const advanceHireReview = () => {
    const next = hireQueue.pending[1];
    // The pendingHire effect re-seeds every form field from the new queue head.
    finishPendingHire();
    if (!next) onClose();
  };

  const importHire = async () => {
    setError(undefined);
    const res = await window.cth.importHireFiles();
    if (res.manifests.length > 0) enqueuePendingHires(res.manifests);
    if (res.errors.length > 0) {
      const noun = res.errors.length === 1 ? 'file' : 'files';
      setError(`Skipped ${res.errors.length} invalid ${noun}: ${res.errors.join(' · ')}`);
    } else if (!res.ok && res.error && res.error !== 'cancelled') {
      setError(res.error);
    }
  };

  const skipHire = () => {
    if (!pendingHire) return;
    setError(undefined);
    advanceHireReview();
  };

  const submit = async () => {
    setError(undefined);
    // A required field can live in a section the user hasn't opened, so jump to
    // the offending section as we surface the error — the field is never hidden.
    if (!name.trim()) { setError(tr('addAgent.errName')); setSection('identity'); return; }
    if (!cwd) { setError(tr('addAgent.errFolder')); setSection('workspace'); return; }
    if (!command.trim()) { setError(tr('addAgent.errCommand')); setSection('engine'); return; }

    setBusy(true);
    const id = uniqueId(name);
    const ptyId = `pty-${id}`;
    // Split the editable command field into argv-style pieces for node-pty.
    // Quote-aware so an agy model label like "Gemini 3.1 Pro (High)" — or any
    // auto-mode flags appended to the command — stays one argument.
    const [exe, ...args] = tokenizeCommand(command.trim());
    const spawnRes = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      provider,
      args,
      cols: 100,
      rows: 30,
      // When set, the main process spawns this agent in its own git worktree.
      // Forced OFF when resuming a session — `--resume` needs the real cwd's
      // transcript, not a fresh worktree with a different (empty) project dir.
      isolate: resuming ? false : isolate,
      // #2 — continue an existing Claude session in this agent's cwd.
      resumeSessionId: resuming ? resumeSessionId.trim() : undefined,
      // Provision this agent in the hive (memory + mailbox + identity/protocol).
      hive: {
        id,
        name: name.trim(),
        provider,
        cwd,
        role: description.trim() || undefined,
        // A hire manifest may carry validated capability tags (routing hints).
        capabilities: hireMeta?.capabilities
      }
    });
    if (!spawnRes.ok) {
      setBusy(false);
      setError(spawnRes.error ?? 'spawn failed');
      return;
    }
    // #2 — the requested resume session id wasn't found anywhere; main fell back
    // to a fresh session. Don't block the spawn, but make it visible.
    if (resuming && spawnRes.resumeNotFound) {
      console.warn(`[add-agent] resume session "${resumeSessionId.trim()}" not found — started a fresh session`);
    }

    // Main expands `~` at ingestion and echoes back the absolute path it actually
    // spawned into — record THAT, so this agent's cwd matches the hive registry
    // (and survives a restart, where nothing re-expands it).
    const spawnedCwd = spawnRes.cwd || cwd;
    // With git isolation the agent RUNS in its own worktree, but its PROJECT is
    // still the folder the user picked. Labelling the agent with the worktree's
    // name was the visible half; the damaging half was promoting that worktree
    // into registeredRepos below, which turned the project quick-picks into a
    // list of throwaway worktrees. Mirrors the `isolate` sent to main, which is
    // forced off while resuming.
    const projectCwd = (!resuming && isolate) ? cwd.trim() : spawnedCwd;
    const agent: Agent = {
      id,
      name: name.trim(),
      character,
      accent,
      description: description.trim() || 'a fresh harness',
      project: folderName(projectCwd),
      tmuxTarget: '',
      cwd: spawnedCwd,
      goal: goal.trim() || undefined,
      status: 'idle',
      action: resuming && spawnRes.resumeNotFound ? 'session not found — fresh start' : 'starting up',
      progress: 0,
      currentStation: 'desk',
      ptyId,
      command: command.trim(),
      provider,
      model,
      // Persist the resolved worktree path (set only when isolation provisioned
      // one) so a restart can re-enter this exact worktree — see restoreTeam.
      worktreePath: spawnRes.worktreePath,
      // Crush (seedDelivery:'type-into-tui') hands its hive protocol back here
      // instead of on argv; useHive types it into the TUI after boot. (ondev-b)
      seedPrompt: spawnRes.seedPrompt,
      recentTextTs: Date.now()
    };
    addAgent(agent);
    // Remember the folder for the next hire: promote it to the front of the
    // registeredRepos quick-picks (the modal's default cwd) so back-to-back
    // hires land in the same project without re-picking.
    if (projectCwd && repos[0] !== projectCwd) {
      const nextRepos = [projectCwd, ...repos.filter((r) => r !== projectCwd && r !== cwd)];
      try {
        const updated = await window.cth.updateConfig({ registeredRepos: nextRepos });
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    // A hire manifest may carry a per-agent token budget — apply it to the
    // latest agentTokenCaps map in main. Await it before advancing a batch: the
    // next hire reuses this mounted modal and must not race a stale config write.
    if (hireMeta?.tokenCap) {
      try {
        const updated = await window.cth.setAgentTokenCap(id, hireMeta.tokenCap);
        onConfigChange?.(updated);
      } catch { /* best-effort */ }
    }
    setBusy(false);
    if (pendingHire) {
      advanceHireReview();
    } else {
      onClose();
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Must sit above fullscreen terminal/file overlays (250/280) and their
        // hover popovers. The fullscreen Add Agent button uses this same modal.
        zIndex: 500
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 940, maxWidth: '95vw' }}>
        <PixelPanel
          variant="dialog"
          title={tr('addAgent.title')}
          style={{ padding: 16 }}
          noPadding
        >
          {/* Sectioned config with a left sidebar index. The form has 11+ fields,
              so they're grouped into 4 sections (Identity / Workspace / Engine /
              Briefing) shown one at a time; the sidebar jumps between them. The
              hire-import review banner, the error, and the footer stay pinned
              around the section pane. maxHeight keeps the dialog within the
              viewport (title bar stays pinned). */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, maxHeight: '86vh', overflowY: 'auto' }}>
            {hireMeta && cvMode && (
              <HireCv
                m={hireMeta}
                character={character}
                accent={accent}
                engine={[provider, model].filter(Boolean).join(' · ')}
                cwd={cwd}
                onPickFolder={async () => { const r = await window.cth.chooseFolder(); if (r.ok) setCwd(r.path); }}
                progress={reviewProgress ? tr('addAgent.hireProgress', { current: reviewProgress.current, total: reviewProgress.total }) : undefined}
              />
            )}
            {hireMeta && !cvMode && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-lemon-light, #fdf3cf)',
                boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                fontSize: 12,
                color: 'var(--cth-ink-900)',
                display: 'flex', flexDirection: 'column', gap: 2
              }}>
                <span>
                  📋 {tr('addAgent.hireImported')} <strong>{hireMeta.name}</strong>
                  {hireMeta.author ? <> · {tr('addAgent.byAuthor', { author: hireMeta.author })}</> : null}
                  {reviewProgress ? <> · {tr('addAgent.hireProgress', { current: reviewProgress.current, total: reviewProgress.total })}</> : null}
                </span>
                <span>{tr('addAgent.reviewFields')}</span>
                {hireMeta.commandFlags && hireMeta.commandFlags.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>{tr('addAgent.hireFlags')}</span>
                    {hireMeta.commandFlags.map((f, i) => (
                      <code
                        key={`${f}-${i}`}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-paprika-light, #f6d3c4)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {f}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.skills && hireMeta.skills.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap', marginTop: 2 }}>
                    <span style={{ fontSize: 12 }}>{tr('addAgent.hireSkills')}</span>
                    {hireMeta.skills.map((s) => (
                      <code
                        key={s}
                        style={{
                          fontFamily: 'var(--cth-font-mono)',
                          fontSize: 12,
                          padding: '0 4px',
                          background: 'var(--cth-mint-light, #d0f0e0)',
                          boxShadow: 'inset 0 0 0 1px var(--cth-mint-700, #1f7a4d)',
                          color: 'var(--cth-ink-900)'
                        }}
                      >
                        {s}
                      </code>
                    ))}
                  </span>
                )}
                {hireMeta.mcpServers && hireMeta.mcpServers.length > 0 && (() => {
                  const safe = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier === 'safe-readonly'
                  );
                  const consent = hireMeta.mcpServers!.filter(
                    (id) => MCP_CATALOG.find((e) => e.id === id)?.tier !== 'safe-readonly'
                  );
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 2 }}>
                      {safe.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>{tr('addAgent.mcpSafe')}:</span>
                          {safe.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-sky-light, #d0e8f8)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-sky-700, #1f5a8a)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                        </span>
                      )}
                      {consent.length > 0 && (
                        <span style={{ display: 'flex', gap: 4, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 12 }}>{tr('addAgent.mcpConsent')}:</span>
                          {consent.map((id) => (
                            <code key={id} style={{
                              fontFamily: 'var(--cth-font-mono)', fontSize: 12, padding: '0 4px',
                              background: 'var(--cth-paprika-light, #f6d3c4)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-paprika-700, #b3502e)',
                              color: 'var(--cth-ink-900)'
                            }}>{id}</code>
                          ))}
                          <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
                            {tr('addAgent.mcpEnableInSettings')}
                          </span>
                        </span>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Easy mode: what is it for? A role fills the description and goal. */}
            {easyHire && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px', color: 'var(--cth-ink-700)' }}>
                  {tr('addAgent.easy.ask')}
                </span>
                <div role="radiogroup" aria-label={tr('addAgent.easy.ask')} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {EASY_HIRE_ROLES.map((r) => {
                    const on = easyRole === r.id;
                    return (
                      <button
                        key={r.id}
                        role="radio"
                        aria-checked={on}
                        onClick={() => pickEasyRole(r.id)}
                        style={{
                          flex: '1 1 150px', textAlign: 'left', padding: '6px 9px', border: 'none', cursor: 'pointer',
                          background: on ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                          boxShadow: on ? 'inset 0 0 0 1.5px var(--cth-ink-500)' : 'inset 0 0 0 1px var(--cth-ink-100)',
                          display: 'flex', flexDirection: 'column', gap: 2
                        }}
                      >
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, fontWeight: 600, color: 'var(--cth-ink-900)' }}>{tr(`addAgent.easy.role_${r.id}`)}</span>
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{tr(`addAgent.easy.role_${r.id}Desc`)}</span>
                      </button>
                    );
                  })}
                </div>
                <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{tr('addAgent.easy.engineNote')}</span>
              </div>
            )}

            {/* sidebar index + the active section's fields (hidden behind the CV) */}
            <div style={{ display: hireMeta && cvMode ? 'none' : 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* LEFT — section index. Capabilities isn't a nav item: it isn't a
                  user field, it rides the imported hire manifest (banner above). */}
              <nav style={{ width: 168, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(() => {
                const navItem = (s: (typeof SECTIONS)[number], i: number): JSX.Element => {
                  const active = section === s.key;
                  return (
                    <button
                      key={s.key}
                      onClick={() => setSection(s.key)}
                      style={{
                        textAlign: 'left', padding: '6px 9px 5px', border: 'none', cursor: 'pointer',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                          : 'inset 0 0 0 1px var(--cth-ink-100)',
                        display: 'flex', flexDirection: 'column', gap: 1
                      }}
                    >
                      <span style={{
                        fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '13px',
                        color: 'var(--cth-ink-900)', textTransform: 'uppercase',
                        display: 'flex', alignItems: 'baseline', gap: 6
                      }}>
                        <span style={{ color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)' }}>{i + 1}</span>
                        {tr(s.labelKey)}
                      </span>
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-500)' }}>
                        {tr(s.hintKey)}
                      </span>
                    </button>
                  );
                };
                if (!easyHire) return SECTIONS.map(navItem);
                // Easy mode: the engine (engine, model, command) folds under Advanced.
                const basic = SECTIONS.filter((s) => s.key !== 'engine');
                const engine = SECTIONS.filter((s) => s.key === 'engine');
                const open = easyAdvancedOpen || section === 'engine';
                return (
                  <>
                    {basic.map(navItem)}
                    <button
                      aria-expanded={open}
                      onClick={() => setEasyAdvancedOpen(!open)}
                      style={{
                        textAlign: 'left', padding: '6px 9px 5px', marginTop: 4, border: 'none', cursor: 'pointer',
                        background: 'transparent', boxShadow: 'inset 0 1px 0 var(--cth-ink-100)',
                        fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '13px',
                        color: 'var(--cth-ink-700)', textTransform: 'uppercase'
                      }}
                    >
                      {open ? '▾' : '▸'} {tr('addAgent.easy.advanced')}
                    </button>
                    {open && engine.map((s) => navItem(s, basic.length))}
                  </>
                );
                })()}
              </nav>

              {/* RIGHT — the active section's fields */}
              <div style={{ flex: 1, minWidth: 0, minHeight: 260, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {section === 'identity' && (
                  <>
                    <Row label={tr('addAgent.name')}>
                      <input
                        value={name}
                        onChange={(e) => {
                          const next = e.target.value;
                          setName(next);
                          const match = characterForName(next);
                          if (match) setCharacter(match);
                        }}
                        placeholder={tr('addAgent.namePlaceholder')}
                        style={inputStyle}
                      />
                    </Row>

                    <Row label={tr('addAgent.character')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {OFFICE_CAST.map(c => (
                          <button
                            key={c.name}
                            onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                            title={c.blurb}
                            style={{
                              padding: 4,
                              background: character === c.name ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                              boxShadow: character === c.name
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                : 'inset 0 0 0 1px var(--cth-ink-100)',
                              cursor: 'pointer',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                              border: 'none', width: 56
                            }}
                          >
                            <div style={{ width: 44, height: 56, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                              <SpritePortrait character={c.name} scale={2} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                          </button>
                        ))}
                      </div>
                    </Row>

                    <Row label={tr('addAgent.color')}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {ACCENTS.map(a => (
                          <button
                            key={a}
                            onClick={() => setAccent(a)}
                            style={{
                              width: 32, height: 32,
                              background: `var(--cth-${a})`,
                              boxShadow: accent === a
                                ? 'inset 0 0 0 1.5px var(--cth-ink-500), 0 0 0 2px var(--cth-ink-900)'
                                : 'inset 0 0 0 1px var(--cth-ink-300)',
                              cursor: 'pointer',
                              border: 'none'
                            }}
                            aria-label={a}
                          />
                        ))}
                      </div>
                    </Row>
                  </>
                )}

                {section === 'workspace' && (
                  <>
                    <Row label={tr('addAgent.project')}>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                        <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                          {repos.length > 0 ? tr('addAgent.pickProject') : tr('addAgent.noProjects')}
                        </span>
                        <button
                          onClick={addProject}
                          title={tr('addAgent.addProjectTitle')}
                          style={{
                            flexShrink: 0, padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> {tr('addAgent.addProject')}
                        </button>
                      </div>
                      {repos.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                          {repos.map((r) => (
                            /* Two buttons per chip: pick the project, or drop it
                               from this list. Nested in a span rather than one
                               button so the remove control is not a button inside
                               a button. */
                            <span
                              key={r}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'stretch',
                                background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: cwd === r
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)'
                              }}
                            >
                              <button
                                onClick={() => setCwd(r)}
                                title={r}
                                style={{
                                  padding: '3px 4px 1px 8px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                {folderName(r)}
                              </button>
                              <button
                                onClick={() => unregisterProject(r)}
                                title={`Remove ${folderName(r)} from this list. The folder itself is left alone.`}
                                aria-label={`Remove ${folderName(r)} from the project list`}
                                style={{
                                  padding: '3px 6px 1px 2px',
                                  background: 'transparent',
                                  fontFamily: 'var(--cth-font-ui)',
                                  fontSize: 12,
                                  lineHeight: 1,
                                  color: 'var(--cth-ink-500)',
                                  cursor: 'pointer',
                                  border: 'none'
                                }}
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input
                          value={cwd}
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder={tr('addAgent.projectPlaceholder')}
                          style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                        />
                        <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                            <Icon name="folder" /> {tr('addAgent.pick')}
                          </span>
                        </PixelButton>
                      </div>
                      {cwd.trim() && !repos.includes(cwd.trim()) && (
                        <button
                          onClick={() => registerProject(cwd)}
                          title={tr('addAgent.saveAsProjectTitle')}
                          style={{
                            alignSelf: 'flex-start', marginTop: 2,
                            padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                            background: 'var(--cth-mint-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
                            display: 'inline-flex', alignItems: 'center', gap: 4
                          }}
                        >
                          <Icon name="plus" /> {tr('addAgent.saveAsProject')}
                        </button>
                      )}
                    </Row>

                    <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: resuming ? 'not-allowed' : 'pointer', opacity: resuming ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={resuming ? false : isolate}
                        disabled={resuming}
                        onChange={(e) => setIsolate(e.target.checked)}
                        style={{ width: 16, height: 16, cursor: resuming ? 'not-allowed' : 'pointer' }}
                      />
                      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
                        {tr('addAgent.gitIsolation')}
                      </span>
                    </label>

                    <Row label={tr('addAgent.resumeSession')}>
                      <input
                        value={resumeSessionId}
                        onChange={(e) => { setResumeSessionId(e.target.value); setFolderNote(undefined); }}
                        onBlur={resolveFolderFromSession}
                        placeholder={tr('addAgent.resumePlaceholder')}
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }}
                      />
                      {folderNote && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-mint, var(--cth-ink-700))' }}>
                          {folderNote}
                        </span>
                      )}
                      {resuming && (
                        <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>
                          {tr('addAgent.resumeNote')}
                        </span>
                      )}
                    </Row>
                  </>
                )}

                {section === 'engine' && (
                  <>
                    <Row label={tr('addAgent.provider')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {AGENT_PROVIDER_PRESETS.map((p) => {
                          const active = provider === p.id;
                          return (
                            <button
                              key={p.id}
                              onClick={() => pickProvider(p.id)}
                              title={
                                p.id === 'antigravity'
                                  ? tr('addAgent.providerAntigravity')
                                  : p.id === 'codex'
                                    ? tr('addAgent.providerCodex')
                                    : p.id === 'custom'
                                      ? tr('addAgent.providerCustom')
                                      : p.label
                              }
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none',
                                display: 'inline-flex', alignItems: 'center', gap: 6
                              }}
                            >
                              <ProviderLogo provider={p.id} size={14} />
                              {p.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>

                    {preset.supportsModel && <Row label={tr('addAgent.model')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {(() => {
                          // An imported hire may name a model newer than this picker's
                          // hardcoded list (e.g. claude-fable-5). Surface it as a real,
                          // selected card instead of leaving the picker looking unset —
                          // the command field already carries it either way.
                          const catalog = modelsForProvider(provider);
                          const known = [...catalog, ...ownModelsFor(config, provider, piOwn).filter((o) => !catalog.some((m) => m.id === o.id))];
                          return model && !known.some((m) => m.id === model)
                            ? [...known, { id: model, label: tr('addAgent.fromHire', { model }) }]
                            : known;
                        })().map((m) => {
                          const active = (model ?? '') === (m.id ?? '');
                          return (
                            <button
                              key={m.label}
                              onClick={() => pickModel(m.id)}
                              title={m.id ?? tr('addAgent.cliDefaultModel')}
                              style={{
                                padding: '3px 8px 1px',
                                background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                                boxShadow: active
                                  ? 'inset 0 0 0 1.5px var(--cth-ink-500)'
                                  : 'inset 0 0 0 1px var(--cth-ink-100)',
                                fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                                color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                              }}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    </Row>}

                    {/* OSS-model quick-picks (ondev-c) — local + third-party-provider
                        shortlists from the verified catalog. Clicking sets the
                        engine-correct slug (OpenCode `local/<tag>`, Crush/pi
                        `ollama/<tag>`; provider slugs are identical across engines)
                        and rebuilds the command. */}
                    {hasOssQuickPicks(provider) && (
                      <Row label={tr('addAgent.ossModels')}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <div>
                            <div style={ossGroupHead}>{tr('addAgent.ossLocal')}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_LOCAL_PICKS.map((p) => {
                                const slug = localSlugFor(provider, p.tag);
                                const active = (model ?? '') === slug;
                                return (
                                  <button
                                    key={p.tag}
                                    onClick={() => pickModel(slug)}
                                    title={tr('addAgent.ossLocalTitle', { slug, ram: p.minRam, tag: p.tag })}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                          <div>
                            <div style={ossGroupHead}>{tr('addAgent.ossByok')}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {OSS_PROVIDER_PICKS.map((p) => {
                                const active = (model ?? '') === p.slug;
                                return (
                                  <button
                                    key={p.slug}
                                    onClick={() => pickModel(p.slug)}
                                    title={tr('addAgent.ossByokTitle', { slug: p.slug, keyEnv: p.keyEnv })}
                                    style={ossChip(active, accent)}
                                  >
                                    {p.label}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </Row>
                    )}

                    {(provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen') && (
                      <div style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px', margin: '2px 0 6px' }}>
                        {tr('addAgent.byokNote')}
                      </div>
                    )}

                    <Row label={config.autoMode && preset.autoFlag ? tr('addAgent.commandAuto') : tr('addAgent.command')}>
                      <input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder={
                          provider === 'antigravity'
                            ? 'agy'
                            : provider === 'codex'
                              ? 'codex'
                              : provider === 'custom'
                                ? 'your-agent-cli'
                                : 'claude'
                        }
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                      />
                    </Row>
                  </>
                )}

                {section === 'briefing' && (
                  <>
                    <Row label={tr('addAgent.templates')}>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {DESCRIPTION_TEMPLATES.map((t) => (
                          <button
                            key={t.labelKey}
                            onClick={() => { setDescription(t.description); setGoal(t.goal); }}
                            title={t.goal}
                            style={{
                              padding: '3px 8px 1px',
                              background: 'var(--cth-cream-100)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                              fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                              color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                            }}
                          >
                            {tr(t.labelKey)}
                          </button>
                        ))}
                      </div>
                    </Row>

                    <Row label={tr('addAgent.description')}>
                      <input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={tr('addAgent.descriptionPlaceholder')}
                        style={inputStyle}
                      />
                    </Row>

                    <Row label={tr('addAgent.goal')}>
                      <textarea
                        dir={rtl ? 'auto' : undefined}
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        placeholder={tr('addAgent.goalPlaceholder')}
                        rows={2}
                        style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'none' }}
                      />
                    </Row>
                  </>
                )}
              </div>
            </div>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 13,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            {/* Import-hire explainer + AI prompt generator (item 7) */}
            <div style={{
              padding: '8px 10px',
              background: 'var(--cth-cream-100)',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              display: 'flex', flexDirection: 'column', gap: 6
            }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: '17px' }}>
                  {tr('addAgent.importHireDesc')}
                </span>
                <button
                  onClick={() => setShowHirePrompt((v) => !v)}
                  style={{
                    flexShrink: 0,
                    padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
                    background: showHirePrompt ? 'var(--cth-lemon-light)' : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                  }}
                >
                  {showHirePrompt ? tr('addAgent.hideAIPrompt') : tr('addAgent.generateWithAI')}
                </button>
              </div>
              {showHirePrompt && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'var(--cth-ink-500)', lineHeight: '16px' }}>
                    {tr('addAgent.aiPromptHint')}
                  </span>
                  <textarea
                    readOnly
                    value={HIRE_PROMPT}
                    onFocus={(e) => e.currentTarget.select()}
                    rows={10}
                    style={{
                      ...inputStyle,
                      width: '100%',
                      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
                      resize: 'vertical', background: 'var(--cth-paper-100)'
                    }}
                  />
                  <div>
                    <PixelButton variant="secondary" size="sm" onClick={copyHirePrompt}>
                      {copiedPrompt ? tr('addAgent.copied') : tr('addAgent.copyPrompt')}
                    </PixelButton>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton
                variant="secondary"
                size="md"
                onClick={importHire}
                disabled={busy}
                title={tr('addAgent.importHireBtnTitle')}
              >
                {tr('addAgent.importHireBtn')}
              </PixelButton>
              <div style={{ flex: 1 }} />
              {hireMeta && cvMode && (
                <PixelButton variant="secondary" size="md" onClick={() => setCvMode(false)} disabled={busy}>{tr('addAgent.cv.edit')}</PixelButton>
              )}
              {pendingHire && (
                <PixelButton variant="secondary" size="md" onClick={skipHire} disabled={busy}>{tr('addAgent.skipHire')}</PixelButton>
              )}
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>{tr('common.cancel')}</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? tr('addAgent.spawning') : hireMeta && cvMode ? tr('addAgent.cv.hire', { name }) : tr('addAgent.spawn')}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

/** A hire read like a CV: who they are, what they will do, what they need.
 *  Everything comes from the manifest already applied to the form. */
function HireCv({ m, character, accent, engine, cwd, onPickFolder, progress }: {
  m: HireManifest; character: OfficeCharacterName; accent: AccentColorName; engine: string;
  cwd: string; onPickFolder: () => void; progress?: string;
}) {
  const { t: tr } = useTranslation();
  const skills = [...(m.capabilities ?? []), ...(m.skills ?? [])];
  const head: React.CSSProperties = {
    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
    color: 'var(--cth-ink-700)', textTransform: 'uppercase', marginBottom: 4
  };
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'stretch', minHeight: 300 }}>
      <div style={{
        width: 190, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        padding: '16px 10px', background: `var(--cth-${accent}-light)`, boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}>
        <SpritePortrait character={character} scale={4} />
        <strong style={{ fontFamily: 'var(--cth-font-display)', fontSize: 14, color: 'var(--cth-ink-900)', textAlign: 'center' }}>{m.name}</strong>
        {m.description && <span style={{ fontSize: 12, color: 'var(--cth-ink-700)', textAlign: 'center', lineHeight: 1.4 }}>{m.description}</span>}
        {m.author && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', textAlign: 'center' }}>{tr('addAgent.cv.proposedBy', { author: m.author })}</span>}
        {progress && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{progress}</span>}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {m.goal && (
          <div>
            <div style={head}>{tr('addAgent.cv.mission')}</div>
            <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--cth-ink-900)', maxHeight: 150, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>{m.goal}</div>
          </div>
        )}
        {skills.length > 0 && (
          <div>
            <div style={head}>{tr('addAgent.cv.skills')}</div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {skills.map((s) => (
                <span key={s} style={{ fontSize: 12, padding: '1px 6px', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', color: 'var(--cth-ink-900)' }}>{s}</span>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13, alignItems: 'baseline' }}>
          <span style={head}>{tr('addAgent.cv.engine')}</span>
          <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}>{engine || '—'}</span>
          <span style={head}>{tr('addAgent.cv.worksIn')}</span>
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{cwd || '—'}</span>
            <button type="button" onClick={onPickFolder} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', fontSize: 12, color: 'var(--cth-ink-700)', textDecoration: 'underline' }}>{tr('addAgent.cv.change')}</button>
          </span>
          <span style={head}>{tr('addAgent.cv.budget')}</span>
          <span style={{ fontSize: 12 }}>{m.tokenCap ? tr('addAgent.cv.tokens', { count: m.tokenCap.toLocaleString() }) : tr('addAgent.cv.noCap')}</span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 'auto' }}>{tr('addAgent.cv.hint')}</span>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}
