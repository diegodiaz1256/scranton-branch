import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, providerPreset, tokenizeCommand, type AgentProvider } from '@/store/config';
import { roleForHiveSpawn } from '@shared/agentRole';
import { acquireTerminal, disposeTerminal, resetTerminal } from './terminalPool';

/** True when this agent's CLI can continue its conversation after a restart. */
export function canResumeAgent(a: Pick<Agent, 'command' | 'provider'>): boolean {
  const provider = inferAgentProvider(a.command, a.provider);
  const preset = providerPreset(provider);
  return provider === 'claude' || !!preset.resumeFlag || !!preset.resumeSubcommand;
}

/** Restart several agents one after another, each continuing its conversation
 *  where its CLI can. Resolves the failures by agent id (empty when all went). */
export async function restartAgents(agents: Agent[]): Promise<Record<string, string>> {
  const failed: Record<string, string> = {};
  for (const a of agents) {
    try { await restartAgent(a, a.model, { resume: canResumeAgent(a), resumeOptional: true }); }
    catch (e) { failed[a.id] = e instanceof Error ? e.message : String(e); }
  }
  return failed;
}

export interface RestartOptions {
  resume?: boolean;
  provider?: AgentProvider;
  /** Resume if we can, start fresh if we can't, instead of refusing.
   *  "Restart & Continue" wants the hard failure — continuing is the entire
   *  point, so silently starting a blank session would be worse than an
   *  error. A model change wants the soft one: the user asked to change
   *  model, and an agent with no recorded session still has to get one. */
  resumeOptional?: boolean;
}

/** Restart an agent's PTY in place, without touching any other agent or the
 *  app. `resume:true` reattaches its prior conversation (`--resume <sessionId>`,
 *  resolved from the hive registry by agent id): "Restart & Continue", a clean
 *  re-draw of the TUI in a fresh process WITHOUT losing the thread, which is the
 *  escape hatch for a corrupted/garbled terminal or a wedged CLI. With `resume`
 *  unset it starts a fresh session (a model change). Throws with a readable
 *  reason; the current process is left running when a precondition fails.
 *  Shared by the classic Command Center and the Pro agent page. */
export async function restartAgent(a: Agent, model: string | undefined, opts: RestartOptions = {}): Promise<void> {
  if (!a.ptyId) return;
  const updateAgent = useStore.getState().updateAgent;
  const cfg = await window.cth.getConfig();
  // Respawn on the same CLI this agent already runs on (inferred from its
  // command if not explicitly tagged) so an Antigravity/Codex worker stays
  // on its own binary. tokenizeCommand keeps quoted model labels one arg.
  // opts.provider overrides the inferred provider — used when changing GOD's engine.
  const previousProvider = inferAgentProvider(a.command, a.provider);
  const provider = opts.provider ?? previousProvider;
  let resume = opts.resume === true && provider === previousProvider;
  if (opts.resume && !resume && !opts.resumeOptional) {
    throw new Error('Cannot resume a session through a different provider.');
  }
  let resumeSessionId: string | undefined;
  if (resume) {
    // A precondition miss is fatal for an explicit "continue", and merely
    // means "start fresh" for an opportunistic one (see resumeOptional).
    const giveUpOnResume = (reason: string) => {
      if (!opts.resumeOptional) throw new Error(reason);
      resume = false;
      resumeSessionId = undefined;
    };
    const registry = await window.cth.hiveRegistry();
    resumeSessionId = registry.agents[a.id]?.sessionId;
    if (!resumeSessionId) {
      giveUpOnResume('No recorded session ID; current process was left running.');
    } else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeSessionId))) {
      // The recorded session never got a message (an empty restart): let main
      // resume the newest of this agent's sessions that has a transcript. If
      // none has, the spawn answers resumed:false and this restart fails below.
      resumeSessionId = undefined;
    }
  }
  // Capture the live grid before replacing anything. Restart & Continue
  // recreates only this agent's xterm; model changes retain the old
  // in-place reset behavior.
  const oldEntry = acquireTerminal(a.ptyId);
  let cols = oldEntry.term.cols || 100;
  let rows = oldEntry.term.rows || 30;
  try {
    oldEntry.fit.fit();
    cols = oldEntry.term.cols;
    rows = oldEntry.term.rows;
  } catch { /* host not sized yet */ }

  const killed = await window.cth.killPty(a.ptyId);
  // A pty that is ALREADY gone is the state this kill was trying to reach, so
  // it is not a failure. This is the single most common way to arrive at
  // "Restart & Continue": the session died on its own — a crash, or Ctrl-C
  // twice — main dropped it from the session map, and kill then answers
  // `no pty: <id>`. Treating that as fatal aborted before the respawn and
  // turned the one situation the button exists for into a dead end.
  if (!killed.ok && !/^no pty:/.test(killed.error ?? '')) {
    throw new Error(killed.error ?? 'Could not stop the current process.');
  }
  if (!resume) {
    resetTerminal(a.ptyId);
  }
  const command = buildSpawnCommand(cfg, model, provider);
  const [exe, ...args] = tokenizeCommand(command.trim());
  const hive = {
    id: a.id,
    name: a.name,
    cwd: a.cwd,
    provider,
    isGod: a.isGod,
    isAssistant: a.isAssistant,
    role: roleForHiveSpawn(a)
  };
  const res = await window.cth.spawnPty({
    id: a.ptyId,
    cwd: a.cwd,
    command: exe,
    args,
    provider,
    cols,
    rows,
    hive,
    resume,
    resumeSessionId,
    requireResume: resume
  });
  if (!res.ok) throw new Error(res.error ?? 'Restart failed.');
  // freshStart: main started a new session on purpose (the old one ran in
  // another folder or role, sessionResume.ts), which is not a refusal.
  if (resume && res.resumed !== true && !res.freshStart) {
    throw new Error('Resume was refused; no replacement session was accepted.');
  }
  if (resume) {
    // The replacement is accepted, so NOW it is safe to throw the old
    // terminal away. (It used to run BEFORE spawnPty, so one of the throws
    // above left a fresh blank xterm in the pool with the scrollback gone
    // forever — node-pty keeps none — and the label stuck at
    // 'recreating terminal…'.) A blank xterm can retain corrupt
    // renderer/DOM/subscription state even after its PTY is healthy, which
    // is why the resume path replaces it at all; the spawn answer beat the
    // CLI's first frame, so no startup output can be missed.
    disposeTerminal(a.ptyId);
    const fresh = acquireTerminal(a.ptyId);
    // Main's notice went to the terminal just thrown away: say it again here.
    if (res.freshStart) fresh.term.write(`\x1b[33m  ${res.freshStart}\x1b[0m\r\n`);
    // Bump the key so React remounts only this agent's terminal card; the
    // remount's attach re-requests a PTY redraw for anything it raced.
    updateAgent(a.id, {
      terminalGeneration: (a.terminalGeneration ?? 0) + 1,
      status: 'idle',
      action: 'recreating terminal…'
    });
  }
  if (res.ok) {
    // Record the model even on a resume. A same-provider model change now
    // RESUMES the session (that is the point — you keep the conversation and
    // just swap the model), so "resume ⇒ the model is unchanged" stopped
    // being true. Skipping the patch left the live process on the new model
    // while the selector and the persisted agent kept the old one, and the
    // next restore relaunched the old command. `command` is rebuilt from the
    // selected model above, so on a genuine no-change restart this is a no-op.
    const patch = resume && !res.freshStart
      ? {
          command: command.trim(),
          provider,
          model,
          status: 'idle' as const,
          action: 'continuing…'
        }
      : {
          command: command.trim(),
          provider,
          model,
          status: 'idle' as const,
          action: provider === previousProvider ? 'restarting…' : `switching to ${providerPreset(provider).label}…`
        };
    updateAgent(a.id, patch);
  }
}
