// Demo mode redirects userData — must load before anything else (see demo.ts).
import { DEMO_HOME } from './demo';
// Copies the data of this fork's old name (Munder Difflin) on first launch — before
// anything reads userData (see legacyMigration.ts).
import { offerLegacyUninstall } from './legacyMigration';
// A floor (another office, its own process) redirects userData too — after the
// legacy copy, which only ever fills the main profile (see floorProfile.ts).
import { BASE_USER_DATA, FLOOR_ID, floorArgs, seedFloor } from './floorProfile';
import { listFloors, removeFloor } from './floors';
import { menuText } from './menuText';
import { claimOffice, officeHolder, releaseOffice } from './officeLock';
// Headless (server) mode sets Chromium switches — must load before ready too.
import { HEADLESS, HEADLESS_SETUP, SERVER } from './headless';
import { APP_NAME } from '../shared/fork';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, protocol, screen, shell, Notification } from 'electron';
import { execFile, spawn } from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import { rootCertificates as tlsRootCertificates } from 'node:tls';
import { buildCaBundle, tlsActive, tlsEnv, WINDOWS_STORE_SCRIPT } from './caBundle';
import {
  rmSync, existsSync, readFileSync, appendFileSync, readdirSync, statSync, cpSync, writeFileSync,
  unlinkSync, mkdirSync, renameSync, createWriteStream, copyFileSync, lstatSync,
  readlinkSync, symlinkSync, chmodSync
} from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve, relative, sep, basename, dirname, isAbsolute } from 'node:path';
import { homedir, hostname } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { PtyManager, type SpawnOptions } from './pty';
import { resolveCommand as resolveCliCommand, resolveCommandAsync, isSafeCommandName, userShellPath } from './shellEnv';
import { initAutoUpdater, abortPendingRestart, repairAppImageLaunchers } from './updater';
import { RealtimeFloorWatcher } from './realtimeFloorWatcher';
import {
  readConfig, writeConfig, setAgentTokenCap, setAgentMcpGrant, resetConfig, onConfigWritten, ensureHarnessHome, ensureClaudePermissionsAccepted,
  modelForRole, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, type HarnessConfig, type ScheduledMission
} from './config';
import { listDir, readFileText, readFileBinary, writeFileText, statAbs, expandTilde } from './fs';
import { DELIVERABLE_SCHEME, DeliverableFiles } from './deliverableFiles';
import { normalizeWeekly, weeklyDelayMs } from '../shared/weeklySchedule';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff, mainRepoRoot,
  addWorktree, removeWorktree, worktreeHasUnintegratedWork, worktreeIsGcSafe,
  getLogGraph, getCommitFiles, getFileAtRev, compareRefs, listWorktrees, checkoutRef
} from './git';
import { linkWorktreeDeps, unlinkWorktreeDeps } from './worktreeDeps';
import { excludeOfficeFromRepo } from './gitExclude';
import { openTerminalAt } from './openTerminal';
import { agentKind, effortArgs } from '../shared/roleModels';
import { formatList, parseList, type PersonalList } from '../shared/lists';
import { HiveManager, type AgentMeta, type HiveMessage, type HiveTask, type MessageAct, type TempHiring } from './hive';
import { HookServer } from './hooks';
import { CircuitBreaker, WarningDedupe, warningKey, workTokensOf, type BreakerInput } from './breaker';
import { capStage, capDispatchNote, capWarningBody, lastOutboxMessage, lastWords } from './workerCap';
import { UsageAlertMonitor, type UsageAlertTarget } from './usageAlerts';
import { normalizeThresholds } from '../shared/usageWindowAlerts';
import { CumulativeSampleGate, type UsageProvider } from './usage';
import { MemoryManager } from './memory';
import { KnowledgeManager } from './knowledge';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { readAgentUsage, readContextTokens, seedSessionTranscript, resolveSessionCwd, hasLocalTranscript } from './transcript';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer, SlackReplyServer, postSlackReply, type SlackEventFile } from './slack';
import {
  WebhookServer,
  type WebhookDispatch, type WebhookEndpointRef, type WebhookInbound, type WebhookTaskStatus
} from './webhook';
import {
  classifyInboundKind, isAutoAllowed,
  DEFAULT_CONTEXT_TRIGGER, DEFAULT_ORG_TRIGGER, DEFAULT_TRIGGER_MODE, DEFAULT_WEBHOOK_SCHEMA, workSwitchRuleFor,
  type ContextRule, type ContextTriggerConfig, type InboundKind, type OrgTriggerConfig,
  type TriggerHistoryEntry, type TriggerMode, type WebhookTrigger
} from '../shared/triggers';
import {
  appendTriggerHistory, clearTriggerHistory, listTriggerHistory, updateTriggerHistory
} from './triggerHistory';
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from './freeflow';
import { WhisperCache, isWhisperModel } from './whisperCache';
import { registerRealtimeIpc } from './realtime';
import { registerRealtimeActionIpc } from './realtimeActions';
import { initCompletionWatcher } from './realtimeCompletionWatcher';
import type { TaskCard, InboxMessage } from './realtimeCompletionWatcher';
import { TelemetryCollector } from './telemetry';
import { CostLedgerTotals } from './costLifetime';
import { fleetUsage } from '../shared/hookUsage';
import { analytics, isRendererMessageSurface } from './analytics';
import type { SpawnFailReason } from './analytics';
import { IntegrationBroker } from './integrationBroker';
import { SshRelay, listSshKeysRaw, parseSshKeys, spawnRelaySsh, parseSshSigner, readSshSignerRaw, runSshSign, sshKeyFingerprint, type SshKeyInfo } from './sshRelay';
import { cleanSshRelayMap, type SshRelayAuditEntry } from '../shared/sshRelay';
import * as integrations from './integrations';
import { applyMissionRequest, type MissionLike } from '../shared/missionRequests';
import { cleanCustomBundles } from '../shared/roleBundles';
import { Factories } from './factories';
import { createWslOffice, describeWslError, distroHomeUnc, fromLinuxPath, runInDistroAsync, listDistros, toWslUnc, mirroredNetworking, parseWslPath, probeInDistro, WSL_INSTALL, wslAgentTmpDir } from './wsl';
import { WslBridge } from './wslBridge';
import { appImageRelaunch } from './appImageLauncher';
import { McpServers } from './mcpServers';
import { EnvVault, fingerprintOf, type ProposalAnswer } from './envVault';
import { addConnection, connectionAccessFor, setConnectionAccess, connectionKeyStored, connectionLaunchEnv, instancesOf, listConnections, removeConnection, renameConnection, serviceOf, setConnectionEnabled, setConnectionScope, setConnectionSecret, testConnection } from './connections';
import { McpGateway, type McpCallRecord } from './mcpGateway';
import { effectiveApiAccess, explainConnection, isAccess, type Access } from '../shared/connectionAccess';
import { blockedMcpServers, cleanToolBlocks } from '../shared/nativeTools';
import { runsUnsandboxed, unsandboxedAgents, unsandboxRefusal } from '../shared/unsandboxed';
import { cleanCloudCredentialIds, cleanCloudCredentialMap } from '../shared/cloudCredentials';
import { ensureVaultRoot } from './vaultRoot';
import { piNoSandboxScript, refusePiWithoutSandbox, type PiSandboxPlace } from '../shared/piSandbox';
import { canBeCustodian, cleanCriticalMap, criticalAllows, criticalRefusal, custodianOf, custodianships, heldIds, isCritical, isCustodian, setCritical, vaultAccess, vaultName, vaultRelPath, VAULT_REQUESTS, VAULT_ROOT, type CriticalKind, type CriticalMap } from '../shared/criticalConnections';
import { redactConfidential, redactionTotal } from '../shared/confidentialRedact';
import { cleanDeliverableName, decide, type Decision, type PendingItem } from '../shared/criticalSignoff';
import { freshSessionNotice, freshSessionReason } from '../shared/sessionResume';
import { projectDir } from './transcript';
import { BrowseCache, browseChars, browseMode, formatBrowsed, formatSearch } from '../shared/browsePage';

/** Pages agents read, kept 10 minutes for their next pages (browsePage.ts). */
const browseCache = new BrowseCache();
import { floorActiveSince } from '../shared/tokenDiet';
import { browsePage, searchWeb, setExternalEngine } from './browser';
import { Fortress } from './fortress';
import { TeamNode, type TeamInbound } from './teamNode';
import { appendTeamLog, disableTeam, enableTeam, loadTeamState, readTeamLog, relayToken, saveTeamState, setRelayToken, teamEnabled, teamPublicStatus } from './team';
import { mcpCatalogEntry } from '../shared/mcpCatalog';
import type { PromptConnection } from '../shared/agentConnections';
import { PROVIDER_BACKENDS, backendForModel, providerKeyEnv } from '../shared/providerBackends';
import { LIST_MODELS, SIGN_IN, authProviders, piOwnModels, cleanCustomProviders, effectiveModel, keyScope, piSettingsWithModel, customKeyEnv, modelsFromListing, opencodeProviders, parseModelList, piModelsJson, type ManagedEngine } from '../shared/engineModels';
import { diffTasks, snapshotOf, type TaskEvent, type TaskSnapshot } from '../shared/taskHistory';
import type { TaskEdit } from '../shared/taskEdit';
import { DELIVERABLES_DIR, addLink, canOpenExternally, currentTaskOf, deliverablePaths, isInside, linkFor, recordElsewhere, writtenFiles, type DeliverableLink, type ElsewhereWrite } from '../shared/deliverables';
import { isDeliverableLike } from '../shared/deliverableOrganize';
import { matchDeliverable } from '../shared/deliverableMatch';
import { scanDeliverables } from './deliverableScan';
import { validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl, secretRefFor, INTEGRATION_TEMPLATES, hasPlaceholderHost, probeSpecFor } from '../shared/integrations';
import { RosterStore } from './roster';
import { buildWorkerLaunch, workerRequestProblem } from './workerLaunch';
import { tokenizeCommand } from '../shared/commandLine';
import { ControlRegistry } from './control';
import { WorkerWakeWatchdog, WORKER_WAKE_REPORT_MS, activityEvidenceAt, type WorkerWakeFacts } from './workerWake';
import { inboxNudgeText } from '../shared/hiveNudge';
import { pastePayload, preEnterDelayMs } from '../shared/ptySubmit';
import { resolveGodName } from '../shared/godIdentity';
import { collectHireManifests, fetchHireManifest, readHireManifestFiles, restoreOfferedHire } from './hire';
import { parseHireDeepLink, type HireManifest } from '../shared/hire';
import { ClosingTimeController } from './closingTime';
import {
  argsWithAutoModeFlag,
  canReceiveInbox,
  defaultCommandForProvider,
  inferAgentProvider,
  isAgentProvider,
  isClaudeProvider,
  isHiveAwareProvider,
  nonInteractiveEnvForProvider,
  providerPreset,
  installInfoForProvider,
  type AgentProvider
} from '../shared/agentProvider';
import { buildMissingCliScript, chooseInstallRung } from './cliInstall';
import { detectNodeVersion, nodeAtLeast, nodeIsUsable, resolveNodeInstaller } from './nodeInstall';
import { toolCatalog, type ToolStatus } from '../shared/toolCatalog';
import { listLocalSkills, loadCatalog, installSkill, installSkillFromFolder, uninstallSkill, type LocalSkill, type CatalogSkill } from './skills';
import { cleanMarketplaces, loadMarketplace, loadMarketplaces, marketplaceProblem, mergeCatalog } from './skillMarketplaces';
import { cleanSkillPolicy, planSkillRequest } from '../shared/skillRequests';
import { loadHero } from './hero';
import { loadModelCatalog } from './modelCatalog';
import {
  CODEX_REMOTE_SOCKET_RELATIVE,
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  withCodexRemoteArgs
} from '../shared/codexRemote';
import { makeSpawnGate } from './spawnGate';
import { clearWorkerScratch } from './workerScratch';
import { speak as speakAloud, stopSpeaking } from './speak';
import { appendWorkLog, terminalTail, workerExitNotice, workLogLine, type WorkLogEntry } from './workLog';
import { WorkSwitchClearer } from './workSwitch';
import { detectWorkSwitches } from '../shared/workSwitch';
import { clearCommandForProvider } from '../shared/providerAutomation';
import { latestDone, archiveRequestProblem, legacyTemps } from './tempWorkers';
import { agentTempProblem, changedAccess, cloneProblem, inheritedAccess, parseAnswerer, tempQuotaOf, tempsAtOnce, withoutAccess, type AccessConfig, type Answerer } from '../shared/agentTemps';
import { FreezeMonitor, instrumentEvents, instrumentIpc, instrumentTimers, type FreezeEntry } from './freezeLog';
import { bothEnv } from '../shared/envName';

// Freeze log (freezeLog.ts): set up before any handler or timer exists, so all
// of them are timed and a stall can name what caused it.
const freezes = new FreezeMonitor({
  file: join(app.getPath('userData'), 'logs', 'freezes.jsonl'),
  extra: () => ({ agents: ptyManager.list().length })
});
instrumentIpc(ipcMain, freezes);
instrumentTimers(freezes);
instrumentEvents(freezes);
// Heartbeats from app-ready on: loading main's own code happens before any
// window exists, so it is not a freeze anyone sees.
void app.whenReady().then(() => freezes.start());

// HTML deliverables render from md-dlv:// (deliverableFiles.ts). Standard, so a
// page's relative links resolve beside it; registered before app-ready, as
// Electron requires.
protocol.registerSchemesAsPrivileged([{ scheme: DELIVERABLE_SCHEME, privileges: { standard: true, secure: true, stream: true } }]);
const deliverableFiles = new DeliverableFiles();
const servingSessions = new WeakSet<Electron.Session>();
function serveDeliverables(ses: Electron.Session): void {
  if (servingSessions.has(ses)) return;
  servingSessions.add(ses);
  ses.protocol.handle(DELIVERABLE_SCHEME, (req) => deliverableFiles.respond(req.url));
}

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// Keep the main process alive on an unexpected throw/rejection. The harness is a
// multi-agent supervisor — a single stray throw (e.g. node-pty's ConPTY console
// helper choking when a fast-exiting agent CLI's console is already gone) must
// NOT take the whole app and every running agent down with it. Log and continue
// rather than letting the default handler exit the process.
// (Restored during the #71 merge — the PR's rebase dropped these handlers.)
// A closed stdout/stderr (the terminal or pipe that launched the app went
// away) makes every console write fail with EPIPE. Unhandled, each failure
// came back here, was logged through the same broken stream, failed again,
// and the main process spun on it: 0% idle, every IPC call ~1 s, the whole
// UI stuttering. Swallow those stream errors; log nothing about them.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => { /* the console is gone; nothing to tell it */ });
}
const isBrokenConsole = (err: unknown): boolean => {
  const code = (err as { code?: string } | null)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'EIO';
};
process.on('uncaughtException', (err) => {
  if (isBrokenConsole(err)) return;
  console.error('[main] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (kept alive):', reason);
});

const ptyManager = new PtyManager();

/** app.relaunch(), except as an AppImage: see appImageRelaunch. Call right
 *  before app.exit(). */
function relaunchApp(): void {
  const r = appImageRelaunch(process.env, process.argv, process.pid);
  if (r) spawn(r.command, r.args, { detached: true, stdio: 'ignore' }).unref();
  else app.relaunch();
}

function runCodexDaemonCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      resolveResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let timer: NodeJS.Timeout;
    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once('error', (e) => finish({ ok: false, error: e.message }));
    child.once('exit', (code) => {
      finish(code === 0
        ? { ok: true }
        : { ok: false, error: stderr.trim() || `Codex exited with code ${code ?? 'unknown'}` });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ ok: false, error: `Codex daemon command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

/** Start/enable one managed remote-control daemon for this isolated Codex home,
 * then point the TUI at its app-server socket. Failure is non-fatal: the worker
 * still starts as a normal local Codex session. */
async function enableCodexRemoteForSpawn(
  opts: SpawnOptions & { hive?: AgentMeta },
  agentId: string
): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const realHome = opts.env?.CODEX_HOME;
  if (!realHome) return false;
  try {
    const alias = codexRemoteAliasPath(realHome, agentId);
    // Bail before touching the filesystem if even the short alias would exceed
    // sun_path — the daemon would start and then die on bind, and the warning
    // below names the real reason instead of a generic readiness timeout.
    if (!codexRemoteSocketFits(alias)) {
      console.warn('[codex-remote] socket path exceeds sun_path; starting local TUI:', alias);
      return false;
    }
    const aliasRoot = dirname(alias);
    mkdirSync(aliasRoot, { recursive: true });
    if (existsSync(alias)) {
      const st = lstatSync(alias);
      if (!st.isSymbolicLink() || resolve(dirname(alias), readlinkSync(alias)) !== resolve(realHome)) {
        console.warn('[codex-remote] short home alias is occupied; starting local TUI:', alias);
        return false;
      }
    } else {
      symlinkSync(realHome, alias, 'dir');
    }

    const socket = join(alias, CODEX_REMOTE_SOCKET_RELATIVE);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      CODEX_HOME: alias
    };
    // shellEnv's resolver mirrors PtyManager's (which is private + returns
    // {path, found}); the daemon just needs the best executable path.
    const executable = resolveCliCommand(opts.command);
    const started = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'start'],
      env
    );
    if (!started.ok) {
      console.warn('[codex-remote] daemon start failed; starting local TUI:', started.error);
      return false;
    }
    const enabled = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'enable-remote-control'],
      env
    );
    if (!enabled.ok) {
      console.warn('[codex-remote] enable failed; starting local TUI:', enabled.error);
      return false;
    }
    if (!existsSync(socket)) {
      console.warn('[codex-remote] daemon returned without a control socket; starting local TUI');
      return false;
    }
    opts.env = { ...(opts.env ?? {}), CODEX_HOME: alias };
    opts.args = withCodexRemoteArgs(opts.args ?? [], codexRemoteEndpoint(alias));
    return true;
  } catch (e) {
    console.warn('[codex-remote] setup failed; starting local TUI:',
      e instanceof Error ? e.message : e);
    return false;
  }
}
/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
/** PTY id → the spawn it should auto restart-and-continue into once a first-time
 *  CLI install finishes. The missing-CLI short-circuit runs the engine's installer
 *  in this PTY; when it exits cleanly the exit handler re-runs the SAME spawn (with
 *  install disabled) so the freshly-installed CLI launches in the SAME pty/window —
 *  no user click. Cleared the moment it's consumed, so it can never loop installs. */
const pendingInstallRelaunch = new Map<string, { opts: AgentSpawnOptions; owner: Electron.WebContents | null; bin: string; rung: string }>();
/** One install per engine CLI at a time. Restoring a team with several agents of
 *  a CLI that was missing started one global `npm install -g` per agent at once;
 *  they overwrote each other and left a package with an empty bin/ behind. The
 *  first agent installs; the others wait for it, then start normally. */
const installsInFlight = new Map<string, { done: Promise<void>; resolve: () => void }>();
/** Take the install slot for `bin`. Synchronous on purpose: the next spawn of
 *  the same CLI must see it before this one awaits anything (a network lookup
 *  for the Node installer), or both start installing. */
function claimInstall(bin: string): void {
  if (installsInFlight.has(bin)) return;
  let resolve = (): void => {};
  const done = new Promise<void>((r) => { resolve = r; });
  installsInFlight.set(bin, { done, resolve });
}
function finishInstall(bin: string): void {
  const f = installsInFlight.get(bin);
  if (f) { installsInFlight.delete(bin); f.resolve(); }
}
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => {
    const wc = liveWebContents();
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  }
);
// Hive commits run queued and async in the app, never blocking this thread.
hive.setAsyncCommits(true);
// #7C — operator control state (pause/gate/steer/halt), read by the HookServer
// when deciding hook returns.
const control = new ControlRegistry();
// Stage 7A — the live observability tap. Receives Claude Code's first-party OTel
// over loopback OTLP/JSON and exposes the locked usage-provider seam. resolveCwd
// lets the transcript fallback find an agent's cwd from the hive registry.
const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null,
  // D11: scopes the transcript fallback to this agent's own session instead of
  // summing every transcript in a (routinely shared) cwd.
  resolveSessionId: (agentId) => hive.lastSession(agentId)
});
// Usage provider (Seam 1) — the INTEGRATION swap: Oscar's telemetry collector (#7)
// IS the provider, replacing Lane A's interim StubUsageProvider. Same
// getAgentUsage(agentId) pull seam, so the breaker + cost ledger consumers are
// untouched; telemetry has a transcript fallback built in, so it works before any
// live OTel arrives.
const usageProvider: UsageProvider = telemetry;
// Grok agents are costed from a cumulative file snapshot (telemetry.ts
// `grokFallback`), so an idle one re-reads identical totals every beat. Their
// session id is real, so the liveness gate below cannot filter that — this
// does, by admitting a row only when the numbers move. Claude's live OTel path
// does not consult it.
const grokLedgerGate = new CumulativeSampleGate();
// Circuit breaker (Lane A #6.6b) — the REAL policy (replaces Lane C's interim
// glue). POLICY only; the heartbeat beat feeds it signals (via usageProvider) +
// enforces its decisions. Config read live so a settings change applies next beat.
const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return { ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps };
});
/** The steer/constrain messages the breaker beat already sent, per agent. */
const breakerWarnings = new WarningDedupe();
// Always-on beats (decoupled from the optional heartbeat): the live fleet snapshot
// Michael reads + the breaker beat, so guardrails + monitoring work even when the
// heartbeat mission is disabled (it ships off).
let fleetTimer: ReturnType<typeof setInterval> | null = null;
let breakerBeatTimer: ReturnType<typeof setInterval> | null = null;
// Feed the breaker's api_error-storm trip from Oscar's OTel api_error spans —
// Jim's one breaker input with no on-branch source (telemetry.onApiError seam).
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// Shared roster on disk — created early so HookServer can re-read standing goals
// on every UserPromptSubmit (Edit Agent saves land here via persistAgents).
const roster = new RosterStore(() => readConfig().harnessHome);
function standingGoalFromRoster(agentId: string): string | null {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as { id?: unknown; goal?: unknown };
    if (a.id !== agentId) continue;
    return typeof a.goal === 'string' && a.goal.trim() ? a.goal.trim() : null;
  }
  return null;
}
// Worker inbox-wake watchdog (#151): finds idle workers with undrained inbox mail
// and types the same guarded nudge the renderer would have (so a throttled
// background window can't leave a worker parked on an unread inbox forever).
// HookServer feeds it the hook stream so a permission/HITL prompt blocks nudges.
const workerWake = new WorkerWakeWatchdog();
// HookServer needs BOTH: Oscar's control registry (HITL pause/gate/steer/halt via
// hook returns) AND Jim's breaker (feed recordToolUse on each PostToolUse).
const hookServer = new HookServer(
  hive,
  () => liveWebContents(),
  () => readConfig(),
  control,
  breaker,
  standingGoalFromRoster,
  (agentId, event, message) => workerWake.noteHook(agentId, event, message)
);
// Subagents agents start (Task/Agent tool), for Temps.
hookServer.onSubagentsChanged = () => { try { liveWebContents()?.send('subagents:changed', hookServer.subagents.list()); } catch { /* window gone */ } };
ipcMain.handle('subagents:list', () => hookServer.subagents.list());
// Subscription usage windows: when one nears its limit, each live agent on that
// account gets one inbox notice, and the orchestrator is told to stop dispatching
// (usageAlerts.ts, protocol/usage-windows.md).
const usageAlerts = new UsageAlertMonitor({
  root: () => hive.root(),
  thresholds: () => normalizeThresholds(readConfig().usageWindowAlerts),
  targets: (provider) => {
    const reg = hive.registry();
    const out: UsageAlertTarget[] = [];
    for (const a of Object.values(reg.agents)) {
      if (a.archived || a.isAssistant) continue;
      const orchestrator = a.id === reg.godId || !!a.isGod;
      // The orchestrator hears it whatever engine it runs on: it dispatches the work.
      if (orchestrator || (a.provider ?? 'claude') === provider) out.push({ id: a.id, orchestrator });
    }
    return out;
  },
  accountName: (provider) => (isAgentProvider(provider) ? providerPreset(provider).label : provider),
  send: (to, subject, body) => { hive.send({ to, act: 'inform', subject, body }, 'usage'); },
  onChange: (alerts) => { try { liveWebContents()?.send('hive:usageAlerts', alerts); } catch { /* window gone */ } }
});
hookServer.onRateLimits = (agentId, rl) => {
  let provider = 'claude';
  try { provider = (agentId && hive.registry().agents[agentId]?.provider) || 'claude'; } catch { /* no office open */ }
  usageAlerts.observe(provider, rl);
};
ipcMain.handle('usage:alerts', () => usageAlerts.active());
// Offline talk: read the orchestrator's reply with the OS's own voices.
ipcMain.handle('voice:speak', (_evt, text: unknown, lang: unknown) =>
  typeof text === 'string' && text.trim() ? speakAloud(text.slice(0, 4000), typeof lang === 'string' ? lang : 'en') : { ok: false, error: 'nothing to say' });
ipcMain.handle('voice:stopSpeaking', () => { stopSpeaking(); return { ok: true }; });
hookServer.notifyAs = (agentId) => ({
  name: hive.registry().agents?.[agentId]?.name,
  icon: agentFaces.get(agentId)
});
const memory = new MemoryManager(
  () => readConfig().harnessHome,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; },
  // A custodian's memory stays out of the shared palace (criticalConnections.ts).
  (id) => isCustodian(criticalMap(), id)
);
// Enterprise Knowledge Graph — file-backed store + agent CLI (default OFF).
const knowledge = new KnowledgeManager();
/** Reads the reflect tunables from config each tick (defaults baked in here so a
 *  pre-existing config.json without the keys still gets sane values). */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// Finishes the janitor's missing condense half: bounds each agent's memory.md
// (Haiku tail-summary, backup→verify→atomic-swap) so it never grows unbounded.
const reflector = new MemoryReflector(
  () => readConfig().harnessHome,
  () => readConfig().defaultCommand ?? 'claude',
  () => memory.env(),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } }
);
// Durable harness state (SQLite, main process). Phase A: window bounds (kv) +
// net-new command history. Opened in whenReady, closed in the teardown blocks.
const persist = new PersistStore();
/** The PRIMARY window — the one running the hive/god orchestration and the sink
 *  for process-global timer events (missions, breaker, Slack ingestion). It is
 *  the most-recently-focused live window, so global events follow the user.
 *  Additional "floor" windows are tracked in `allWindows` below. */
let mainWindow: BrowserWindow | null = null;
/** Every open window (primary + floors). A registry, not a single handle, so
 *  multi-window lifecycle (focus tracking, quit fan-out) is correct. */
const allWindows = new Set<BrowserWindow>();
/** Monotonic floor counter → a stable, unique session partition per floor so
 *  each floor's renderer state (localStorage: agents, queues, selection) is
 *  isolated from every other window's. */
let floorSeq = 0;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/** A live god-triggered ephemeral worker, tracked from spawn to teardown. */
interface WorkerRec {
  workerId: string;       // == the PTY id == hive agent id (`worker-<reqId>`)
  reqId: string;          // the spawn-request id
  name?: string;          // display name (for the worker tab)
  objective?: string;     // what it was asked to do (for the orchestrator's work log)
  slack?: { channel: string; thread_ts: string };
  baseBranch: string;     // the branch its worktree was cut from (for ahead-of-base)
  spawnedAt: number;      // epoch ms
  releasing?: boolean;    // kill issued; awaiting teardownPty (skip re-processing)
  /** Per-worker WORK-token cap from the spawn-request (overrides the config
   *  default). 0/undefined = no per-request cap. P4 plumbing — unlimited today. */
  tokenCap?: number;
  /** Sent its one wrap-up request on nearing the cap (workerCap.capStage). */
  capWarned?: boolean;
  /** The floor card broadcast at spawn (hive:agentSpawned). Kept so a renderer
   *  that was not listening yet (a request processed while the app boots) can
   *  card the worker later through workers:cards. */
  card?: Record<string, unknown>;
  /** The PTY id when it is not the worker id: a temp brought back by Restore
   *  team runs in the renderer's `pty-<id>`. Unset = same as workerId. */
  ptyId?: string;
  /** The lasting agent that started it (its own spawn-requests/): its done,
   *  failures and refusals go there instead of to the orchestrator. */
  parent?: string;
}
/** Live ephemeral workers by id. Populated by the spawn-request watcher; consulted
 *  by teardownPty so a finished/crashed/reaped worker's worktree is PRESERVED (not
 *  force-removed) when it holds unintegrated work — god is the sole integrator. */
const liveWorkers = new Map<string, WorkerRec>();
/** The PTY a worker runs in. */
const workerPty = (rec: WorkerRec): string => rec.ptyId ?? rec.workerId;
/** The live worker running in PTY `ptyId`, if any. */
function workerByPty(ptyId: string): WorkerRec | undefined {
  const direct = liveWorkers.get(ptyId);
  if (direct && workerPty(direct) === ptyId) return direct;
  for (const rec of liveWorkers.values()) if (workerPty(rec) === ptyId) return rec;
  return undefined;
}
/** Whether each agent runs in an OS sandbox (its CLI's own, the app's bubblewrap,
 *  or none), as of its last spawn. For its card. */
const osSandboxes = new Map<string, 'cli' | 'app' | 'none' | 'off'>();

/** The loopback secret broker (Phase 2). Workers reach registered integrations through
 *  it without ever seeing a credential. getRecord/getSecret are injected so the broker
 *  stays electron-free + unit-testable. Started in bootstrapHiveServices; each worker is
 *  granted a per-worker capability token at spawn (revoked in teardownPty). */
/** The last tool calls agents made through the gateway (memory only): who, which
 *  connection, which tool, allowed or refused. Shown under each Connection. */
const mcpCalls: McpCallRecord[] = [];
const mcpGateway = new McpGateway({
  serviceOf: (id) => serviceOf(id),
  onCall: (e) => {
    mcpCalls.push(e); if (mcpCalls.length > 1000) mcpCalls.splice(0, mcpCalls.length - 1000);
    if (isCritical(criticalMap(), 'mcp', e.serverId)) criticalAudit({ ts: e.ts, kind: 'mcp', id: e.serverId, agentId: e.agentId, call: e.tool, allowed: e.allowed, ok: e.ok });
  },
  // Critical connections: the custodian only, on every call (criticalConnections.ts).
  refuse: (agentId, serverId) => criticalRefusalFor('mcp', serverId, agentId),
  resolveSpec: (serverId) => {
    if (serverId.startsWith('custom--')) {
      const remote = mcpServers.remoteSpec(serverId);
      if (remote) return remote;
      const spec = mcpServers.launchSpec(serverId);
      if (!spec) return null;
      const path = process.platform === 'win32' ? (process.env.PATH ?? '') : userShellPath();
      return { command: spec.command, args: spec.args, env: { ...spec.env, PATH: path } };
    }
    // A connection id may be an added instance (github-token--work): launch
    // its service's server with that instance's keys.
    const entry = mcpCatalogEntry(serviceOf(serverId) ?? '');
    const keys = connectionLaunchEnv(serverId);
    if (!entry || !keys) return null;
    // npx/uvx need the user's PATH; a Finder-launched app has launchd's bare one.
    const path = process.platform === 'win32' ? (process.env.PATH ?? '') : userShellPath();
    return { command: entry.spec.command, args: entry.spec.args, env: { ...keys, PATH: path }, uvOverrides: entry.spec.uvOverrides };
  }
});

// Your own MCP servers + the ones set up for other tools (mcpServers.ts).
const mcpServers = new McpServers({
  readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
  home: homedir(),
  appData: () => app.getPath('appData'),
  readCustom: () => readConfig().customMcp ?? [],
  writeCustom: (list) => writeConfig({ customMcp: list }),
  getSecret: (ref) => integrations.getSecret(ref),
  setSecret: (ref, v) => integrations.setSecret(ref, v),
  deleteSecret: (ref) => integrations.deleteSecret(ref),
  // Where the agents run (their folder, a Codex agent's own CODEX_HOME), so what they set up for themselves is seen.
  // A WSL floor's agents keep their own Claude Code / Codex / Cursor settings in the distro's home.
  extraHomes: () => {
    const w = hive.enabled() ? hive.wslRoot() : null;
    const h = w ? distroHomeUnc(w.distro) : null;
    return w && h ? [{ label: `WSL ${w.distro}`, home: h }] : [];
  },
  agentPlaces: () => {
    const root = hive.root();
    const reg = hive.enabled() ? hive.registry() : null;
    return reg ? Object.values(reg.agents).filter((a) => a.status !== 'gone' && a.cwd).map((a) => ({ name: a.name, cwd: a.cwd, ...(root && a.provider === 'codex' ? { codexHome: join(root, 'agents', a.id, '.codex') } : {}) })) : [];
  }
});

// Fortress as the office browser's engine (fortress.ts), opt-in. Off, missing
// or failing, the office browser uses the built-in Chromium.
const fortress = new Fortress({
  baseDir: join(app.getPath('userData'), 'fortress'),
  uvPath: () => {
    try { const r = resolveCliCommand('uv'); return r !== 'uv' && existsSync(r) ? r : null; } catch { return null; }
  },
  tilionPath: () => {
    try { const r = resolveCliCommand('tilion'); return r !== 'tilion' && existsSync(r) ? r : null; } catch { return null; }
  },
  env: () => ({ ...process.env, PATH: process.platform === 'win32' ? (process.env.PATH ?? '') : userShellPath() }),
  log: (m) => console.log('[fortress]', m)
});
function applyOfficeBrowserEngine(): void {
  const on = readConfig().officeBrowserEngine === 'fortress';
  if (!on) { setExternalEngine(null); fortress.stop(); return; }
  setExternalEngine(
    () => (fortress.launcherPath() ? fortress.ensureEngine() : null),
    (e) => console.warn('[fortress] fell back to the built-in engine:', e instanceof Error ? e.message : e)
  );
}
applyOfficeBrowserEngine();
// The window's own long tasks (it measures them; main writes them down).
ipcMain.on('diag:longTask', (_evt, ms: unknown, screen: unknown) => {
  if (typeof ms === 'number' && ms >= 200 && ms < 600_000) freezes.record({ where: 'renderer', ms: Math.round(ms), screen: typeof screen === 'string' ? screen.slice(0, 80) : undefined });
});
ipcMain.handle('diag:freezes', (): FreezeEntry[] => freezes.recent(50));
ipcMain.handle('diag:openFreezeLog', () => shell.showItemInFolder(join(app.getPath('userData'), 'logs', 'freezes.jsonl')));
ipcMain.handle('fortress:status', async () => ({ ...(await fortress.status()), enabled: readConfig().officeBrowserEngine === 'fortress', bytes: fortress.diskUsage() }));
ipcMain.handle('fortress:install', () => fortress.install());
ipcMain.handle('fortress:activate', async () => {
  const r = await fortress.activate();
  // The link is the user's own sign-in: open it in their browser.
  if (r.ok && r.url) void shell.openExternal(r.url);
  return r;
});
ipcMain.handle('fortress:refreshLicense', () => fortress.license(true));
ipcMain.handle('fortress:license', (_evt, which: unknown) => (which === 'refresh' || which === 'logout' ? fortress.licenseCommand(which) : { ok: false, error: 'bad request' }));
ipcMain.handle('fortress:setEnabled', (_evt, on: unknown) => {
  writeConfig({ officeBrowserEngine: on === true ? 'fortress' : 'builtin' });
  applyOfficeBrowserEngine();
  return { ok: true };
});
ipcMain.handle('fortress:uninstall', () => {
  writeConfig({ officeBrowserEngine: 'builtin' });
  applyOfficeBrowserEngine();
  fortress.uninstall();
  return { ok: true };
});

// Environment & secrets (envVault.ts): agents use secrets, never see them.
/** Runner proposals waiting for the human in the window, by id. */
interface RunnerProposalRequest { id: string; agentName: string; proposal: { name: string; command: string; secrets: string[]; description?: string }; missing: string[] }
const pendingProposals = new Map<string, { req: RunnerProposalRequest; settle: (a: ProposalAnswer) => void }>();

const envVault = new EnvVault({
  readVars: () => readConfig().envVars ?? [],
  writeVars: (v) => writeConfig({ envVars: v }),
  readRunners: () => readConfig().runners ?? [],
  writeRunners: (r) => writeConfig({ runners: r }),
  getSecret: (ref) => integrations.getSecret(ref),
  setSecret: (ref, v) => integrations.setSecret(ref, v),
  deleteSecret: (ref) => integrations.deleteSecret(ref),
  approve: async ({ runner, agentName, cwd, changed }) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const opts = {
      type: 'question' as const,
      buttons: ['Run once', 'Always for this runner', 'Deny'],
      defaultId: 0, cancelId: 2, noLink: true,
      title: 'Run with secrets?',
      message: `${agentName} wants to run "${runner.name}"`,
      detail: `${runner.command}\n\nIn: ${cwd}\nWith secrets: ${runner.secrets.join(', ') || 'none'}${changed ? '\n\nFiles in this worktree changed since you last allowed it: the command runs code the agent may have edited.' : ''}\n\nThe agent only gets the output, with every secret masked.`
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    refocusAfterDialog(win);
    return response === 0 ? 'once' : response === 1 ? 'always' : 'deny';
  },
  approveProposal: async ({ proposal, agentName, missing }) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    // In the app's own window: translated, and the human can create the
    // secrets the runner needs right there (renderer: RunnerProposalModal).
    if (win && !win.webContents.isDestroyed()) {
      const id = randomUUID();
      const req: RunnerProposalRequest = { id, agentName, proposal, missing };
      return new Promise<ProposalAnswer>((resolve) => {
        const timer = setTimeout(() => settle(false), 15 * 60_000);
        const settle = (a: ProposalAnswer) => { clearTimeout(timer); pendingProposals.delete(id); resolve(a); };
        pendingProposals.set(id, { req, settle });
        try { win.webContents.send('env:proposal', req); } catch { settle(false); return; }
        if (win.isMinimized()) win.restore();
        win.flashFrame(true);
      });
    }
    // No window: a native prompt can say yes or no, but cannot take a secret.
    if (missing.length) return false;
    const opts = {
      type: 'question' as const,
      buttons: ['Add runner', 'Decline'],
      defaultId: 1, cancelId: 1, noLink: true,
      title: 'Add a runner?',
      message: `${agentName} asks for a runner "${proposal.name}"`,
      detail: `${proposal.command}

With secrets: ${proposal.secrets.join(', ') || 'none'}${proposal.description ? `
Why: ${proposal.description}` : ''}

It runs in the asking agent's own folder. The agent gets only the output, with every secret masked, and you are asked again before a run whenever its files changed. You can edit or remove it in Environment.`
    };
    const { response } = await dialog.showMessageBox(opts);
    return response === 0;
  },
  log: (m) => console.log('[env]', m)
});

// ─── SSH through the office (sshRelay.ts) ────────────────────────────────────
// Where agents run (a WSL floor's distro, or this machine): its ssh-agent
// socket and the keys the human can choose. Looked up again after a minute.
let sshFloorCache: { key: string; at: number; info: Promise<{ sock: string; keys: SshKeyInfo[] }> } | null = null;
function sshFloorInfo(fresh = false): Promise<{ sock: string; keys: SshKeyInfo[] }> {
  const distro = hive.enabled() ? hive.wslRoot()?.distro ?? null : null;
  const key = distro ?? 'local';
  if (fresh || !sshFloorCache || sshFloorCache.key !== key || Date.now() - sshFloorCache.at > 60_000) {
    sshFloorCache = { key, at: Date.now(), info: listSshKeysRaw(distro).then((out) => {
      const r = parseSshKeys(out);
      // Here (not a WSL floor) the app's own ssh-agent is the human's.
      return { sock: r.sock || (distro ? '' : process.env.SSH_AUTH_SOCK ?? ''), keys: r.keys };
    }) };
  }
  return sshFloorCache.info;
}
// How the human signs there (their global gpg.ssh.program and user.signingkey).
let sshSignerCache: { key: string; at: number; info: Promise<{ program: string; signingKey: string }> } | null = null;
function sshSignerInfo(): Promise<{ program: string; signingKey: string }> {
  const distro = hive.enabled() ? hive.wslRoot()?.distro ?? null : null;
  const key = distro ?? 'local';
  if (!sshSignerCache || sshSignerCache.key !== key || Date.now() - sshSignerCache.at > 60_000) {
    sshSignerCache = { key, at: Date.now(), info: readSshSignerRaw(distro).then(parseSshSigner) };
  }
  return sshSignerCache.info;
}
function sshAuditPath(): string { return join(app.getPath('userData'), 'ssh-relay-audit.jsonl'); }
function readSshAudit(agentId?: string, limit = 50): SshRelayAuditEntry[] {
  let text = '';
  try { text = readFileSync(sshAuditPath(), 'utf8'); } catch { return []; }
  const out: SshRelayAuditEntry[] = [];
  for (const line of text.split('\n').reverse()) {
    if (out.length >= limit) break;
    try { const e = JSON.parse(line) as SshRelayAuditEntry; if (!agentId || e.agentId === agentId) out.push(e); } catch { /* partial line */ }
  }
  return out;
}
const sshRelay = new SshRelay({
  grant: (agentId) => cleanSshRelayMap(readConfig().agentSshRelay)[agentId] ?? null,
  custodian: (agentId) => isCustodian(criticalMap(), agentId),
  sandboxed: (agentId) => hive.isOsSandboxed(agentId),
  agentName: (agentId) => (hive.enabled() ? hive.registry().agents?.[agentId]?.name : undefined),
  identities: async (fps) => {
    const { keys } = await sshFloorInfo();
    const out: string[] = [];
    for (const fp of fps) {
      const k = keys.find((x) => x.fingerprint === fp);
      if (k?.file) out.push(k.file.replace(/\.pub$/, ''));
      else if (k?.pub) {
        // A key in the ssh-agent: ssh picks it by its public half, written
        // where agents cannot change it (the office's controls).
        const dir = hive.sshWrapperDir();
        if (!dir) continue;
        const f = join(dir, 'keys', `${createHash('sha256').update(fp).digest('hex').slice(0, 16)}.pub`);
        try { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, `${k.pub}\n`, 'utf8'); } catch { continue; }
        out.push(hive.forAgent(f).replace(/\\/g, '/'));
      }
    }
    return out;
  },
  run: async (argv, env) => {
    const distro = hive.enabled() ? hive.wslRoot()?.distro ?? null : null;
    const { sock } = await sshFloorInfo();
    return spawnRelaySsh(distro, argv, env, sock);
  },
  ask: async (agentName, r) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const verb = r.service === 'git-receive-pack' || r.operation === 'upload' ? 'push to' : 'fetch from';
    const opts = {
      type: 'question' as const,
      buttons: ['Allow once', 'Deny'],
      defaultId: 1, cancelId: 1, noLink: true,
      title: 'Use your SSH key?',
      message: `${agentName} wants to ${verb} ${r.host}:${r.path} with your SSH key`,
      detail: `The office runs ssh for it (${r.service}); the agent never sees the key. Only git transfers go through.`
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    refocusAfterDialog(win);
    return response === 0;
  },
  audit: (e) => {
    try { appendFileSync(sshAuditPath(), JSON.stringify(e) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch (err) { console.error('[ssh-relay] audit write failed:', err); }
  },
  // Signing: the keys where agents run, plus the human's own user.signingkey
  // (a key only 1Password's op-ssh-sign may hold), signed with their own
  // gpg.ssh.program from their global config.
  signKeys: async () => {
    const [{ keys }, signer] = await Promise.all([sshFloorInfo(), sshSignerInfo()]);
    const fp = signer.signingKey ? sshKeyFingerprint(signer.signingKey) : null;
    return fp && !keys.some((k) => k.fingerprint === fp) ? [...keys, { fingerprint: fp, label: 'user.signingkey', source: 'agent' as const, pub: signer.signingKey.replace(/^key::/, '') }] : keys;
  },
  sign: async (key, payload) => {
    const distro = hive.enabled() ? hive.wslRoot()?.distro ?? null : null;
    const [{ sock }, signer] = await Promise.all([sshFloorInfo(), sshSignerInfo()]);
    return runSshSign(distro, signer.program, key, payload, sock);
  },
  askSign: async (agentName, w) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const opts = {
      type: 'question' as const,
      buttons: ['Allow once', 'Deny'],
      defaultId: 1, cancelId: 1, noLink: true,
      title: 'Sign with your SSH key?',
      message: `${agentName} wants to sign a ${w.kind} with your SSH key: ${w.subject || '(no message)'}`,
      detail: `${w.repo ? `In ${w.repo}. ` : ''}Key ${w.fingerprint}. The office signs it for the agent (namespace "git" only); the agent never sees the key.`
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    refocusAfterDialog(win);
    return response === 0;
  }
});

ipcMain.handle('sshRelay:keys', async () => {
  // A Windows floor: agents have no OS sandbox, so nothing to relay to.
  if (!hive.sshWrapperDir()) return { available: false, keys: [] };
  const { keys, sock } = await sshFloorInfo(true);
  return { available: true, agentSocket: !!sock, keys: keys.map(({ fingerprint, label, source }) => ({ fingerprint, label, source })) };
});
ipcMain.handle('sshRelay:audit', (_evt, agentId: unknown) => readSshAudit(typeof agentId === 'string' ? agentId : undefined));
// The human's own switch, like "Run without sandbox": only this handler sets
// agentSshRelay (the generic config write drops it), a custodian is refused,
// and every change goes to the hive's log.
// ─── Cloud CLI logins (shared/cloudCredentials.ts) ──────────────────────────
// Hidden from every sandboxed agent; the human may expose some to one agent.
// Like "Use my SSH keys": only cloudCreds:set writes agentCloudCredentials
// (the generic config write drops it), never for a custodian, every change
// in the hive's log. It applies at the agent's next start.
ipcMain.handle('cloudCreds:status', async () => {
  if (!hive.enabled() || !hive.sshWrapperDir()) return { available: false, present: [] };
  return { available: true, present: await hive.credentialSetsPresent() };
});
ipcMain.handle('cloudCreds:set', (_evt, agentId: unknown, ids: unknown) => {
  if (typeof agentId !== 'string' || !agentId || (ids !== null && !Array.isArray(ids))) return { ok: false, error: 'bad request' };
  const a = hive.enabled() ? hive.registry().agents?.[agentId] : undefined;
  if (!a) return { ok: false, error: 'unknown agent' };
  const next = cleanCloudCredentialIds(ids);
  if (next.length && isCustodian(criticalMap(), agentId)) return { ok: false, error: `${a.name ?? agentId} holds a critical connection: a custodian never reads your cloud logins.` };
  const map = cleanCloudCredentialMap(readConfig().agentCloudCredentials);
  if (next.length) map[agentId] = next; else delete map[agentId];
  writeConfig({ agentCloudCredentials: map });
  try { hive.appendLog({ kind: 'cloud-credentials', agentId, name: a.name, exposed: next, by: 'human' }); } catch { /* the config change stands */ }
  return { ok: true };
});

ipcMain.handle('sshRelay:set', (_evt, agentId: unknown, grant: unknown) => {
  if (typeof agentId !== 'string' || !agentId) return { ok: false, error: 'bad request' };
  const a = hive.enabled() ? hive.registry().agents?.[agentId] : undefined;
  if (!a) return { ok: false, error: 'unknown agent' };
  const map = cleanSshRelayMap(readConfig().agentSshRelay);
  if (grant === null) delete map[agentId];
  else {
    if (isCustodian(criticalMap(), agentId)) return { ok: false, error: `${a.name ?? agentId} holds a critical connection: a custodian never uses your SSH keys.` };
    const clean = cleanSshRelayMap({ [agentId]: grant })[agentId];
    if (!clean) return { ok: false, error: 'bad request' };
    map[agentId] = clean;
  }
  writeConfig({ agentSshRelay: map });
  try { hive.appendLog({ kind: 'ssh-relay', agentId, name: a.name, on: grant !== null, keys: map[agentId]?.keys ?? [], ask: !!map[agentId]?.ask, sign: !!map[agentId]?.sign, by: 'human' }); } catch { /* the config change stands */ }
  return { ok: true };
});

const integrationBroker = new IntegrationBroker({
  ssh: { upgrade: (agentId, req, socket, head) => sshRelay.upgrade(agentId, req, socket, head) },
  getRecord: integrations.getRecord,
  getSecret: integrations.getSecret,
  // Looked up on every request: an API switched on (or its key saved) after an
  // agent started is usable at once — capabilities used to be frozen at spawn,
  // so an agent started a moment too early never got it (issue: Jira 403).
  live: (agentId) => apisFor(agentId),
  whyNot: (agentId, id) => apiDenyReason(agentId, id),
  // Critical APIs: the custodian only, on every request, whatever was granted.
  refuse: (agentId, id) => criticalRefusalFor('api', id, agentId),
  onRequest: (e) => {
    if (isCritical(criticalMap(), 'api', e.integrationId)) criticalAudit({ ts: e.ts, kind: 'api', id: e.integrationId, agentId: e.agentId ?? `worker:${e.workerId}`, call: `${e.method} ${e.path}`, allowed: e.allowed });
  },
  runners: {
    describe: () => envVault.describeRunners(),
    secretNames: () => envVault.secretNames(),
    propose: (workerId, proposal) => {
      const agentId = ptyToAgent.get(workerId);
      const name = (agentId && hive.registry().agents?.[agentId]?.name) || agentId || workerId;
      return envVault.proposeRunner(proposal, { agentName: name });
    },
    run: async (workerId, runnerId) => {
      // The worktree is the one the app started this agent in — never a path
      // the agent names.
      const pty = ptyManager.list().find((p) => p.id === workerId);
      if (!pty) return { ok: false, error: 'unknown agent' };
      const agentId = ptyToAgent.get(workerId);
      const name = (agentId && hive.registry().agents?.[agentId]?.name) || agentId || workerId;
      const head = await gitRun(pty.cwd, ['rev-parse', 'HEAD']);
      const status = await gitRun(pty.cwd, ['status', '--porcelain']);
      // Files hidden from `status` with skip-worktree / assume-unchanged still
      // count: their flags (and so any change to them) join the fingerprint.
      const hidden = (await gitRun(pty.cwd, ['ls-files', '-v']))
        .split('\n').filter((l) => /^[a-zS]/.test(l)).join('\n');
      return envVault.run(runnerId, { agentName: name, cwd: pty.cwd, fingerprint: fingerprintOf(head, hidden ? `${status}\n${hidden}` : status) });
    }
  },
  // The office browser (browser.ts). Web switched off for an agent in
  // Capabilities closes this too, checked here as well as in its MCP list.
  browser: {
    blocked: (agentId) => (agentId && toolBlocksFor(agentId).includes('web')
      ? 'Web is switched off for this agent (Capabilities), so the office browser is too.'
      : null),
    browse: async (url, o) => {
      // Page 1 is read fresh; the next pages come from what was just read, so
      // reading on costs only the new text, not the whole page again.
      const page = Math.max(1, Math.floor(o.page ?? 1) || 1);
      let read = page > 1 ? browseCache.get(url) : undefined;
      if (!read) { read = await browsePage(url); browseCache.set(url, read); }
      return formatBrowsed(read, { page, size: browseChars(o.maxChars || undefined), mode: browseMode(o.mode), withLinks: o.links });
    },
    search: async (query) => { const r = await searchWeb(query); return formatSearch(query, r.results, r.text); }
  }
});

/** Best-effort git output for runner fingerprints ('' outside a repo). */
function gitRun(cwd: string, argsIn: string[]): Promise<string> {
  return new Promise((resolve) => {
    // This fingerprint is a security gate, and the agent can write its repo's
    // .git/config: a core.fsmonitor hook could answer `status` for it. Off.
    const args = ['-c', 'core.fsmonitor=', '-c', 'core.untrackedCache=false', ...argsIn];
    // A WSL floor's repo is read by git inside the distro (Windows git on
    // \\wsl.localhost is missing or refuses it, which left the fingerprint
    // empty). Started with --exec and NO login shell: ~/.profile, ~/.bashrc and
    // nvm are agent-writable and could put a fake git first on PATH.
    const w = process.platform === 'win32' ? parseWslPath(cwd) : null;
    const p = w
      ? spawn('wsl.exe', ['-d', w.distro, '--cd', w.linuxPath, '--exec', '/usr/bin/env', 'PATH=/usr/local/bin:/usr/bin:/bin', 'git', ...args], { windowsHide: true })
      : spawn('git', args, { cwd, windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(''));
    p.on('close', () => resolve(out.trim()));
  });
}

/** BYOK backend model-providers whose API keys the non-Claude CLI engines
 *  (OpenCode/Crush/pi/qwen) read from standard env vars. Keys are stored
 *  WRITE-ONLY in the same encrypted secret broker as integrations, under
 *  `apikey:<backend>`, and materialized MAIN-ONLY at spawn (never over IPC). */
const BACKEND_KEY_ENV: Record<string, string> = Object.fromEntries(PROVIDER_BACKENDS.map((b) => [b.id, b.envVar]));
const providerKeyRef = (backend: string): string => `apikey:${backend}`;

/** A worker worktree that teardown PRESERVED because it held unintegrated work.
 *  Tracked so the GC sweep can reclaim it (+ its scratch dir) once the work lands
 *  in base or the worktree is removed by hand — see gcPreservedWorktrees(). */
interface PreservedWorktree {
  workerId: string;
  wtPath: string;
  origCwd: string;        // the parent repo to run `git worktree remove` from
  baseBranch: string;     // re-checked against this for "integrated yet?"
  scratchDir: string | null; // HIVE_ROOT/agents/<workerId> — removed alongside the worktree
  slack?: { channel: string; thread_ts: string };
  preservedAt: number;    // epoch ms
}
/** Preserved worker worktrees awaiting integration, keyed by worktree path. The GC
 *  sweep drains this: an entry is removed (worktree + scratch GC'd) only when the
 *  work is provably integrated, or when the worktree is already gone from disk. */
const preservedWorktrees = new Map<string, PreservedWorktree>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so a double call is a harmless no-op. NOTE: an explicit
 * `ptyManager.kill()` does NOT reach here via onExit — kill() deletes the
 * session synchronously, so node-pty's later async exit callback fails the
 * session-identity guard and is swallowed. Every kill site must therefore call
 * teardownPty itself right after the kill (all of them do). Best-effort — every
 * step is wrapped so a teardown error can never crash the caller (an IPC
 * handler or node-pty's onExit).
 */
function teardownPty(id: string): void {
  // Ephemeral-worker flag, read BEFORE the cleanup below deletes the entry. All
  // worker deaths (done-release, idle/token reap, manual stop, crash) funnel
  // through here, so this is the one place their floor card gets archived
  // (workers card via the hive:agentSpawned broadcast in processSpawnRequest).
  // pty id == worker id == agent id for a fresh worker; a restored temp keeps
  // its renderer pty id (WorkerRec.ptyId).
  const workerRec = workerByPty(id);
  // 0) Revoke this id's broker capability (if any). Idempotent + harmless for a
  //    non-worker PTY; ensures a dead worker's token can never reach an integration.
  try { integrationBroker.revoke(id); } catch { /* best-effort */ }
  // …and its MCP gateway capability, which also stops its keyed servers.
  { const aid = ptyToAgent.get(id); if (aid) { try { mcpGateway.revoke(aid); } catch { /* best-effort */ } } }
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    // Drop watchdog state so a dead agent can't get nudged or leak its grace.
    try { workerWake.forget(agentId, id); } catch { /* best-effort */ }
    try { workSwitch.forget(agentId); } catch { /* best-effort */ }
    // Drop breaker state so a dead agent can't leak/zombie a tripped level.
    try { breaker.forget(agentId); breakerWarnings.forget(agentId); } catch { /* best-effort */ }
    // A replacement using this id needs a new usage counter, not the dead PTY's.
    try { telemetry.forgetAgent(agentId); } catch { /* best-effort */ }
    // Same reason, for the Grok ledger gate: a respawned agent's first sample
    // must be admitted rather than matched against the dead one's last row.
    try { grokLedgerGate.forget(agentId); } catch { /* best-effort */ }
    // W1 — kill this agent's proxy-bridge sidecar (qwen), if any, so a dead
    // PTY never leaves an orphan loopback listener. No-op for non-proxy agents.
    try { hive.stopProxyBridge(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
    if (hive.enabled()) {
      try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    // Ephemeral workers get a SAFETY-GATED teardown: never auto-remove a worktree
    // that holds unintegrated work. This sits INSIDE teardownPty so it covers ALL
    // teardown routes — a worker that finished (controller kill), crashed, or was
    // idle-reaped all land here. Normal agents get the same rule (below).
    const worker = workerRec;
    if (worker) {
      liveWorkers.delete(worker.workerId);
      void finalizeWorkerWorktree(wtPath, origCwd, worker);
    } else {
      void finalizeAgentWorktree(wtPath, origCwd, agentId ?? id);
    }
  }
  // A worker whose isolation failed (non-repo cwd) has no worktree to gate above —
  // still clear its tracking entry so the controller stops watching a dead PTY.
  if (workerRec && liveWorkers.get(workerRec.workerId) === workerRec) liveWorkers.delete(workerRec.workerId);
  // Archive the dead worker's floor card (mirrors killAgent's voice-kill path;
  // the renderer's archiveAgent is a no-op if the card is already gone). NOT
  // done for regular agents: their kill flows already manage their own card.
  if (workerRec) {
    try { liveWebContents()?.send('hive:agentArchived', { id: workerRec.workerId }); } catch { /* window torn down */ }
    // A temp let go for good (done, reaped, archived, stopped) forgets the
    // access it was given; one that merely died with the app keeps it for
    // its restore, which applies its parent's again anyway.
    if (workerRec.releasing) forgetTempAccess(workerRec.workerId);
  }
  syncKeepAwake();
}

/** Send an inform to the god agent (the human's proxy). The ephemeral-worker
 *  controller uses this to surface every terminal failure AND to carry the Slack
 *  {channel,thread_ts} so god can post a 'couldn't complete' reply — closing the
 *  Slack loop (the success path is the worker replying in-thread itself). */
/** One line in the orchestrator's work log (main/workLog.ts). Best-effort. */
function logWork(rec: WorkerRec, outcome: WorkLogEntry['outcome'], extra: Partial<WorkLogEntry> = {}): void {
  const root = hive.root();
  if (!root) return;
  try {
    const reg = hive.registry();
    // A temp another agent started is in that agent's log, not the orchestrator's.
    const ownerId = rec.parent ?? reg.godId ?? 'god';
    const owner = reg.agents[ownerId]?.name ?? ownerId;
    appendWorkLog(join(root, 'agents', ownerId), owner, workLogLine({ who: rec.name ?? rec.workerId, objective: rec.objective, outcome, ...extra }));
  } catch (e) { console.error('[worker] work log failed:', e); }
}

/** Tell whoever started a temp: the lasting agent that asked for it, or the
 *  orchestrator (its own temps, the human's and the triggers'). */
function informOwner(parent: string | undefined, subject: string, body: string, slack?: { channel: string; thread_ts: string }): void {
  if (!parent) { informGod(subject, body, slack); return; }
  try {
    hive.send({ to: parent, act: 'inform', subject, body }, 'ephemeral-worker');
  } catch (e) {
    console.error('[worker] informOwner failed:', e);
  }
}

/** The text of a worker's newest done (after it spawned): its report. */
function workerDoneText(workerId: string, spawnedAt: number): string {
  const root = hive.root();
  if (!root) return '';
  return latestDone(join(root, 'agents', workerId), spawnedAt)?.text ?? '';
}

function informGod(subject: string, body: string, slack?: { channel: string; thread_ts: string }): void {
  try {
    const slackLine = slack
      // The bundled-node launcher, spelled as an ABSOLUTE PATH — NOT bare `node`
      // (absent from the PATH of any machine whose node comes from nvm) and NOT
      // `$HIVE_NODE` (POSIX-only: cmd.exe/PowerShell expand it to nothing, so the
      // whole reply command was dead on Windows).
      ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${hive.nodeCommand()}" "${slackReplyScriptPath()}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"`
      : '';
    hive.send({ to: 'god', act: 'inform', subject, body: body + slackLine }, 'ephemeral-worker');
  } catch (e) {
    console.error('[worker] informGod failed:', e);
  }
}

// ─── Team: paired installs, sealed end to end over a public relay ───────────
// (teamCrypto.ts / teamNode.ts / team.ts). Inbound mail passes the same trust
// gate and ledger as webhooks (orgTrigger.mode, source 'org').

let teamNode: TeamNode | null = null;

function notifyTeam(): void {
  try { liveWebContents()?.send('team:updated'); } catch { /* window gone */ }
}

/** The orchestrator's folder for messages to teammates. */
function teamRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'agents', hive.registry().godId ?? 'god', 'team') : null;
}

/** Mirror of who the orchestrator can write to (names only, nothing secret). */
function writeTeamMirror(): void {
  const root = hive.root();
  if (!root) return;
  const st = teamPublicStatus();
  try {
    writeFileSync(join(root, 'team.json'), JSON.stringify({
      note: 'Teammates\' offices you can message. Write a request into your team/ folder (see your instructions).',
      enabled: st.enabled,
      me: st.me?.name ?? null,
      teammates: st.peers.map((p) => ({ name: p.name, ready: p.confirmed }))
    }, null, 2), 'utf8');
  } catch { /* best-effort */ }
}

function routeTeamToGod(peerName: string, subject: string, body: string, kind: InboundKind): void {
  // A temp answers a directive instead when Team says so. Only the
  // orchestrator writes to teammates, so the temp's done goes to it and it
  // replies; with no temp available it gets the message as before.
  const answer = parseAnswerer(readConfig().teamAnswer);
  if (answer.kind !== 'agent' && kind === 'directive') {
    void hireTempForTrigger(answer, {
      objective: `${peerName} asked over Team (from their office, sealed end to end): ${subject || '(no subject)'}\n\n${body}\n\n(Put your answer in your done message: the orchestrator sends it back to ${peerName}.)`,
      name: `Team: ${peerName}`,
      source: `${peerName}'s Team message`
    }).then((ok) => { if (!ok) deliverTeamToGod(peerName, subject, body, kind); }, () => deliverTeamToGod(peerName, subject, body, kind));
    return;
  }
  deliverTeamToGod(peerName, subject, body, kind);
}

function deliverTeamToGod(peerName: string, subject: string, body: string, kind: InboundKind): void {
  const dir = teamRequestsDir();
  try {
    hive.send({
      to: 'god',
      act: kind === 'directive' ? 'request' : 'inform',
      subject: `[team: ${peerName}] ${subject || '(no subject)'}`,
      body: `${body}\n\n(From ${peerName}'s office over Team, sealed end to end. To answer, write {"to":"${peerName}","subject":"…","body":"…"} as a JSON file into ${dir ?? 'your team/ folder'}.)`,
      requires_reply: false
    }, `team:${peerName}`);
  } catch (e) {
    console.error('[team] could not route to god:', e);
  }
}

function onTeamMessage(m: TeamInbound): void {
  appendTeamLog({ id: m.id, peerId: m.from.id, peerName: m.from.name, direction: 'in', subject: m.subject, body: m.body, at: m.sentAt });
  notifyTeam();
  // The member's own setting, else their team's: messages queue for the human
  // or reach the orchestrator according to what you granted that person.
  const mode: TriggerMode = m.mode;
  const kind: InboundKind = classifyInboundKind(`${m.subject}\n${m.body}`);
  const base = {
    source: 'org' as const, sourceId: m.from.id, sourceName: m.team ? `${m.from.name} (${m.team.name})` : m.from.name, direction: 'inbound' as const,
    peer: m.from.name, title: m.subject || m.body.slice(0, 80), body: m.body, kind
  };
  if (!isAutoAllowed(mode, kind)) {
    appendTriggerHistory({ ...base, decision: 'pending' });
    notifyTriggerHistoryUpdated();
    return;
  }
  appendTriggerHistory({ ...base, decision: 'auto-allowed' });
  notifyTriggerHistoryUpdated();
  routeTeamToGod(m.from.name, m.subject, m.body, kind);
}

function startTeam(): void {
  if (teamNode || !teamEnabled()) return;
  teamNode = new TeamNode({
    load: loadTeamState,
    save: saveTeamState,
    onMessage: onTeamMessage,
    onChange: () => { writeTeamMirror(); notifyTeam(); },
    log: (msg) => console.log('[team]', msg),
    relayToken
  });
  teamNode.start();
  writeTeamMirror();
}

function stopTeam(): void {
  teamNode?.stop();
  teamNode = null;
}

async function sendToTeammate(to: string, subject: string, body: string, by: 'you' | 'agent'): Promise<{ ok: boolean; error?: string }> {
  if (!teamNode) return { ok: false, error: 'Team is off' };
  const res = await teamNode.send(to, subject, body);
  if (res.ok && res.id) {
    const peer = loadTeamState().peers.find((p) => p.id === to || p.name.toLowerCase() === to.toLowerCase());
    appendTeamLog({ id: res.id, peerId: peer?.id ?? to, peerName: peer?.name ?? to, direction: 'out', by, subject, body, at: new Date().toISOString() });
    notifyTeam();
  }
  return res;
}

/** The orchestrator's outgoing team mail: one JSON file per message. */
async function processTeamRequests(): Promise<void> {
  const dir = teamRequestsDir();
  if (!dir || !existsSync(dir)) return;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  for (const f of files) {
    const fp = join(dir, f);
    let result: { ok: boolean; error?: string };
    try {
      const r = JSON.parse(readFileSync(fp, 'utf8')) as { to?: unknown; subject?: unknown; body?: unknown };
      if (typeof r.to !== 'string' || typeof r.body !== 'string' || !r.body.trim()) result = { ok: false, error: '"to" and "body" are required' };
      else result = await sendToTeammate(r.to, typeof r.subject === 'string' ? r.subject : '', r.body, 'agent');
    } catch (e) {
      result = { ok: false, error: `could not read ${f}: ${e instanceof Error ? e.message : String(e)}` };
    }
    try {
      const sub = join(dir, result.ok ? '.done' : '.failed');
      mkdirSync(sub, { recursive: true });
      renameSync(fp, join(sub, f));
    } catch { try { unlinkSync(fp); } catch { /* never loop on it */ } }
    if (!result.ok) {
      try { hive.send({ to: 'god', act: 'inform', subject: `[team] message not sent: ${f}`, body: result.error ?? 'unknown error' }, 'scheduler'); } catch { /* best-effort */ }
    }
  }
}

ipcMain.handle('team:status', () => teamPublicStatus());
ipcMain.handle('team:enable', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { name?: unknown; relay?: unknown };
  const r = enableTeam(typeof p.name === 'string' ? p.name : '', typeof p.relay === 'string' ? p.relay : undefined);
  if (r.ok) { stopTeam(); startTeam(); notifyTeam(); }
  return r;
});
ipcMain.handle('team:disable', () => { stopTeam(); disableTeam(); writeTeamMirror(); notifyTeam(); return { ok: true }; });
ipcMain.handle('team:createInvite', (_evt, teamId: unknown) =>
  teamNode && typeof teamId === 'string' ? teamNode.createInvite(teamId) : { ok: false, error: 'Team is off' });
ipcMain.handle('team:createTeam', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { name?: unknown; relay?: unknown };
  return teamNode ? teamNode.createTeam(typeof p.name === 'string' ? p.name : '', typeof p.relay === 'string' ? p.relay : undefined) : { ok: false, error: 'Team is off' };
});
ipcMain.handle('team:updateTeam', (_evt, id: unknown, patch: unknown) => {
  if (!teamNode || typeof id !== 'string' || !patch || typeof patch !== 'object') return { ok: false, error: 'Team is off' };
  const p = patch as Record<string, unknown>;
  const level = p.level === 'message' || p.level === 'view' || p.level === 'manage' ? p.level : undefined;
  const mode = p.mode === 'strict' || p.mode === 'communication-only' || p.mode === 'allow-all' ? p.mode : undefined;
  return teamNode.updateTeam(id, {
    ...(typeof p.name === 'string' ? { name: p.name } : {}),
    ...(typeof p.relay === 'string' ? { relay: p.relay } : {}),
    ...(level ? { level } : {}),
    ...(mode ? { mode } : {})
  });
});
ipcMain.handle('team:removeTeam', (_evt, id: unknown) => { if (teamNode && typeof id === 'string') teamNode.removeTeam(id); return { ok: true }; });
ipcMain.handle('team:setMember', (_evt, id: unknown, patch: unknown) => {
  if (!teamNode || typeof id !== 'string' || !patch || typeof patch !== 'object') return { ok: false };
  const p = patch as Record<string, unknown>;
  const level = p.level === null ? null : p.level === 'message' || p.level === 'view' || p.level === 'manage' ? p.level : undefined;
  const mode = p.mode === null ? null : p.mode === 'strict' || p.mode === 'communication-only' || p.mode === 'allow-all' ? p.mode : undefined;
  teamNode.setMember(id, { ...(level !== undefined ? { level } : {}), ...(mode !== undefined ? { mode } : {}) });
  return { ok: true };
});
ipcMain.handle('team:join', async (_evt, code: unknown) =>
  teamNode && typeof code === 'string' ? teamNode.join(code) : { ok: false, error: 'Team is off' });
// Write-only: a token goes into the encrypted store and is never read back out.
ipcMain.handle('team:setRelayToken', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { relay?: unknown; token?: unknown };
  const r = setRelayToken(p.relay, p.token);
  if (r.ok) { teamNode?.reconnect(); notifyTeam(); }
  return r;
});
ipcMain.handle('team:removePeer', (_evt, id: unknown) => { if (teamNode && typeof id === 'string') teamNode.removePeer(id); return { ok: true }; });
ipcMain.handle('team:send', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { to?: unknown; subject?: unknown; body?: unknown };
  if (typeof p.to !== 'string' || typeof p.body !== 'string' || !p.body.trim()) return { ok: false, error: 'a teammate and a message are required' };
  return sendToTeammate(p.to, typeof p.subject === 'string' ? p.subject : '', p.body, 'you');
});
ipcMain.handle('team:log', () => readTeamLog());

/** Where the orchestrator drops Automations requests: its OWN folder, the
 *  single-writer rule every agent already follows. */
function scheduleRequestsDir(): string | null {
  const root = hive.root();
  if (!root) return null;
  return join(root, 'agents', hive.registry().godId ?? 'god', 'schedule');
}

/** Mirror of the missions the orchestrator can read (and the ids it needs). */
function writeMissionsMirror(missions: unknown[]): void {
  const root = hive.root();
  if (!root) return;
  try {
    writeFileSync(join(root, 'missions.json'), JSON.stringify({
      note: 'Read-only mirror of Automations. To change them, write a request into your schedule/ folder (see your instructions).',
      missions: missions.map((m) => {
        const { lastFiredAt, ...rest } = m as Record<string, unknown>;
        return { ...rest, lastFiredAt: typeof lastFiredAt === 'number' ? new Date(lastFiredAt).toISOString() : null };
      })
    }, null, 2), 'utf8');
  } catch { /* best-effort */ }
}

/** Apply every pending Automations request, archive it, and tell the
 *  orchestrator what happened (or why not). Pure logic in shared/missionRequests. */
function processScheduleRequests(): void {
  const dir = scheduleRequestsDir();
  if (!dir || !existsSync(dir)) return;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  for (const f of files) {
    const fp = join(dir, f);
    let result: { ok: boolean; message: string; missions?: MissionLike[] };
    try {
      const req = JSON.parse(readFileSync(fp, 'utf8')) as unknown;
      const reg = hive.registry();
      const agents = new Set<string>([reg.godId ?? 'god', ...Object.entries(reg.agents).filter(([, a]) => !a.archived).map(([id]) => id)]);
      result = applyMissionRequest((readConfig().missions ?? []) as unknown as MissionLike[], req, agents);
    } catch (e) {
      result = { ok: false, message: `Could not read ${f}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (result.ok && result.missions) {
      writeConfig({ missions: result.missions as unknown as ScheduledMission[] });
      syncMissions();
      try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
    }
    try {
      const sub = join(dir, result.ok ? '.done' : '.failed');
      mkdirSync(sub, { recursive: true });
      renameSync(fp, join(sub, f));
    } catch { try { unlinkSync(fp); } catch { /* poison file must not loop */ } }
    try { hive.appendLog({ kind: 'schedule_request', file: f, ok: result.ok, message: result.message }); } catch { /* best-effort */ }
    try {
      hive.send({ to: 'god', act: 'inform', subject: `[automations ${result.ok ? 'updated' : 'request refused'}] ${f}`, body: result.message }, 'scheduler');
    } catch { /* best-effort */ }
  }
}

/** Office skills: the orchestrator's requests in its own skills/ folder
 *  (shared/skillRequests.ts). Installed once into the hive's store, copied to
 *  the agents named, answered in its inbox. */
const SKILL_CATALOG_CACHE = () => join(app.getPath('userData'), 'skill-catalog.json');
const MARKETPLACE_CACHE = () => join(app.getPath('userData'), 'skill-marketplaces');
/** The public catalog plus your own marketplaces. */
async function fullSkillCatalog(force = false): Promise<{ skills: Array<CatalogSkill & { marketplace?: string }>; fetchedAt: number; stale: boolean; error?: string }> {
  const [catalog, markets] = await Promise.all([
    loadCatalog(SKILL_CATALOG_CACHE(), { force }).catch((e) => ({ skills: [] as CatalogSkill[], fetchedAt: 0, stale: true, error: String(e) })),
    loadMarketplaces(cleanMarketplaces(readConfig().skillMarketplaces), MARKETPLACE_CACHE(), force).catch(() => [])
  ]);
  return { ...catalog, skills: mergeCatalog(catalog.skills, markets) };
}
let skillMirrorAt = 0;
async function processSkillRequests(): Promise<void> {
  const root = hive.root();
  if (!root) return;
  const policy = cleanSkillPolicy(readConfig().orchestratorSkills);
  const dir = join(root, 'agents', hive.registry().godId ?? 'god', 'skills');
  let files: string[] = [];
  try { files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []; } catch { files = []; }
  // The catalog the orchestrator searches: refreshed when it is asked for
  // (a request) and at most every hour otherwise. loadCatalog serves a day-old
  // cache, so this rarely touches the network.
  const stale = Date.now() - skillMirrorAt > 3_600_000 || !existsSync(join(root, 'skills', 'catalog.json'));
  if (!files.length && !stale) return;
  const catalog = await fullSkillCatalog().catch(() => ({ skills: [] as CatalogSkill[] }));
  hive.writeSkillCatalogMirror(catalog.skills, policy);
  skillMirrorAt = Date.now();
  for (const f of files) {
    const fp = join(dir, f);
    let message: string;
    let ok = false;
    try {
      const req = JSON.parse(readFileSync(fp, 'utf8')) as unknown;
      const reg = hive.registry();
      const agents = new Set<string>(Object.entries(reg.agents).filter(([, a]) => !a.archived).map(([id]) => id));
      const plan = planSkillRequest(req, { state: hive.officeSkills(), catalog: catalog.skills, policy, agents });
      message = plan.message;
      if (plan.ok) {
        const store = hive.officeSkillStore()!;
        if (plan.install) {
          const dest = plan.next.skills[plan.install.name].dir;
          const r = existsSync(join(store, dest)) ? { ok: true as const } : await installSkill(plan.install.url, plan.install.name, agentsHome(), { root: store, dir: dest });
          if (!r.ok) throw new Error(`could not install ${plan.install.name}: ${r.error}`);
        }
        hive.writeOfficeSkills(plan.next);
        if (plan.drop) { try { rmSync(join(store, plan.drop), { recursive: true, force: true }); } catch { /* best-effort */ } }
        for (const id of agents) hive.syncOfficeSkills(id);
        ok = true;
        try { liveWebContents()?.send('skills:officeChanged'); } catch { /* window gone */ }
      }
    } catch (e) {
      message = `Could not apply ${f}: ${e instanceof Error ? e.message : String(e)}`;
    }
    try {
      const sub = join(dir, ok ? '.done' : '.failed');
      mkdirSync(sub, { recursive: true });
      renameSync(fp, join(sub, f));
    } catch { try { unlinkSync(fp); } catch { /* poison file must not loop */ } }
    try { hive.appendLog({ kind: 'skill_request', file: f, ok, message }); } catch { /* best-effort */ }
    try { hive.send({ to: 'god', act: 'inform', subject: `[skills ${ok ? 'updated' : 'request refused'}] ${f}`, body: message }, 'scheduler'); } catch { /* best-effort */ }
  }
}

/** Gated worktree teardown for a regular (non-worker) isolated agent. This used
 *  to be an unconditional `git worktree remove --force`, so stopping or closing
 *  an agent threw away whatever it had not committed or merged. Now: remove only
 *  a worktree with nothing to lose; otherwise keep it, log it in the hive and
 *  tell the user. Reopen re-enters a kept worktree (the restore path reuses an
 *  existing one), so the agent resumes with its work intact. The base is the
 *  parent repo's current branch, which the worktree was cut from. Fail-safe:
 *  any uncertainty keeps it. */
async function finalizeAgentWorktree(wtPath: string, origCwd: string, agentId: string): Promise<void> {
  try {
    const deps = await unlinkWorktreeDeps(origCwd, wtPath);
    // Like the temp-worker GC: a link still in place is kept, never deleted
    // through (Git for Windows would take the base's node_modules with it).
    if (!deps.ok) { console.error('[worktree] dependency unlink failed (worktree kept):', deps.error); return; }
    const br = await getBranch(origCwd);
    const base = 'current' in br && br.current ? br.current : 'HEAD';
    const work = await worktreeHasUnintegratedWork(wtPath, base);
    if (work.keep) {
      console.warn(`[worktree] KEEPING ${agentId}'s worktree with unsaved work: ${wtPath} (${work.detail})`);
      try { hive.appendLog({ kind: 'worktree_kept', agentId, path: wtPath, branch: work.branch, base, dirty: work.dirty, ahead: work.ahead }); } catch { /* best-effort */ }
      breakerToast('Kept an agent’s unsaved work',
        `${agentId} stopped with ${work.dirty ? 'uncommitted changes' : `${work.ahead} unmerged commit(s)`} on ${work.branch}. `
        + `Its worktree was kept at ${wtPath}; reopening the agent picks it up again.`);
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error);
  } catch (e) {
    console.error('[worktree] finalizeAgentWorktree failed (worktree kept):', e);
  }
}

/** Gated worktree teardown for an ephemeral worker: remove it ONLY when it holds no
 *  unintegrated work; otherwise leave it (and its branch) in place and ping god, the
 *  sole integrator. Async + best-effort; on any uncertainty it KEEPS the worktree
 *  (fail-safe — never auto-discard possibly-valuable work). */
async function finalizeWorkerWorktree(wtPath: string, origCwd: string, worker: WorkerRec): Promise<void> {
  try {
    const deps = await unlinkWorktreeDeps(origCwd, wtPath);
    if (!deps.ok) { console.error('[worktree] dependency unlink failed (worktree kept):', deps.error); return; }
    const work = await worktreeHasUnintegratedWork(wtPath, worker.baseBranch);
    if (work.keep) {
      console.warn(`[worker] PRESERVING worktree with unintegrated work: ${wtPath} (${work.detail})`);
      // Track it so the GC sweep can reclaim it (+ scratch dir) once integrated —
      // the worker is gone from liveWorkers by now, so its identity lives here.
      preservedWorktrees.set(wtPath, {
        workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
        scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
      });
      informGod(
        `[worker worktree preserved] ${worker.workerId}`,
        `Ephemeral worker ${worker.workerId} ended but its worktree holds unintegrated work, so it was NOT auto-removed (you are the sole integrator).\n`
        + `Worktree: ${wtPath}\nBranch: ${work.branch}\nState: ${work.detail}\n`
        + `Review/merge it — it will be auto-reclaimed once its work lands in ${worker.baseBranch}, or remove it now with: git -C "${origCwd}" worktree remove "${wtPath}"`,
        worker.slack
      );
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) { console.error('[worker] removeWorktree failed:', r.error); return; }
    // Worktree is gone (clean/integrated at teardown), but DEFER its scratch-dir
    // cleanup to the throttled GC sweep rather than deleting it synchronously here:
    // HIVE_ROOT/agents/<id> holds the worker's memory.md and the MemPalace miner
    // ingests it asynchronously, so an immediate delete can beat the miner and
    // permanently lose the worker's durable notes from the shared palace. Register
    // it (its worktree path is now absent) so the sweep's path-gone branch reclaims
    // the scratch after a window — same throttled path the preserved case uses.
    preservedWorktrees.set(wtPath, {
      workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
      scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
    });
  } catch (e) {
    console.error('[worker] finalizeWorkerWorktree threw (worktree left in place):', e);
  }
}

/** The hive scratch dir for a worker (its inbox/outbox/memory): HIVE_ROOT/agents/<id>.
 *  Null when there's no hive root. */
function workerScratchDir(workerId: string): string | null {
  const root = hive.root();
  return root ? join(root, 'agents', workerId) : null;
}

/** Best-effort removal of a worker's scratch (hive agent) dir. Guarded to ONLY ever
 *  delete a path that resolves to exactly HIVE_ROOT/agents/<workerId> and never a
 *  still-live worker — so a crafted/mismatched id can't escape the agents root. */
function removeWorkerScratch(workerId: string): void {
  if (liveWorkers.has(workerId)) return; // never wipe a live worker's mailbox
  const dir = workerScratchDir(workerId);
  const root = hive.root();
  if (!dir || !root) return;
  const agentsRoot = join(root, 'agents');
  // Path-safety: the resolved dir must sit directly under agents/ with basename == id.
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir)) || basename(dir) !== workerId) return;
  try { clearWorkerScratch(dir); }
  catch (e) { console.error('[worker] removeWorkerScratch failed:', e); }
}
// A natural PTY exit must run the same teardown as an explicit kill — EXCEPT when
// the PTY was the missing-CLI installer: a clean exit there means the engine CLI was
// just installed, so auto restart-and-continue by re-running the SAME spawn into the
// SAME pty/window (no user click). Provider-agnostic. Idempotent by construction: the
// relaunch carries `noAutoInstall`, so the installer can never fire (let alone loop) a
// second time — a binary that's somehow still missing just spawns and exits normally.
ptyManager.setExitHandler((id, exitCode, info) => {
  // Record an ABNORMAL death before teardown — teardownPty drops the
  // pty->agent mapping, so after it runs we can no longer say WHOSE process
  // died. Only abnormal exits are recorded (recordAgentExit returns early on a
  // clean one), so this adds no noise to a normal archive.
  // Whatever subagents that agent had running ended with it.
  { const owner = ptyToAgent.get(id); if (owner && hookServer.subagents.endFor(owner)) hookServer.onSubagentsChanged?.(); }
  // A temp whose process ended before it reported done (crash, refused start).
  const exitingWorker = workerByPty(id);
  if (exitingWorker && !exitingWorker.releasing) {
    logWork(exitingWorker, 'exited', { exitCode });
    // Its job is nobody's now: the orchestrator hears it (unless the temp sent
    // its done first and simply quit).
    if (workerDoneAt(exitingWorker.workerId, exitingWorker.spawnedAt) === null) {
      const notice = workerExitNotice(exitingWorker.workerId, exitCode, info?.tail);
      informGod(notice.subject, notice.body, exitingWorker.slack);
    }
  }
  try {
    const dyingAgent = ptyToAgent.get(id);
    if (dyingAgent) {
      hive.recordAgentExit(dyingAgent, {
        exitCode,
        signal: info?.signal,
        tail: info?.tail,
        command: info?.command
      });
    }
  } catch (e) { console.error('[pty] recordAgentExit failed:', e); }

  const pending = pendingInstallRelaunch.get(id);
  if (pending) {
    pendingInstallRelaunch.delete(id);
    // Whatever the outcome, agents waiting on this install may go ahead now.
    finishInstall(pending.bin);
    // Activation funnel: did the auto-installer actually complete? A non-zero exit
    // is the Linux-installer-cannot-finish-unattended signal that used to be silent.
    const provider = pending.opts.provider ?? inferAgentProvider(pending.opts.command, undefined);
    // A clean exit is not proof: an installer can "succeed" without leaving the
    // CLI where we look. Relaunching then started a missing binary through
    // cmd.exe ("the command line is too long") and wiped the installer's output.
    const installed = exitCode === 0 && ptyManager.isCommandAvailable(pending.bin);
    if (exitCode === 0 && !installed) {
      const wc = (pending.owner && !pending.owner.isDestroyed()) ? pending.owner : liveWebContents();
      const msg = `\r\n\x1b[31m  [x] The installer finished, but "${pending.bin}" still cannot be found.\x1b[0m\r\n` +
        '  Close and reopen Scranton Branch (a fresh install is only on the PATH of new programs),\r\n' +
        '  or install it by hand, then restart the agent.\r\n';
      try { wc?.send(`pty:data:${id}`, msg); } catch { /* window gone */ }
    }
    if (installed) {
      analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'agent_launched' });
      // Re-arm the renderer's pooled terminal (clear the "process exited" line +
      // re-enable input) so the freshly-spawned CLI paints onto a clean, typeable
      // grid, then re-run the normal spawn — which now finds the installed binary.
      const wc = (pending.owner && !pending.owner.isDestroyed()) ? pending.owner : liveWebContents();
      try { wc?.send(`pty:relaunch:${id}`); } catch { /* window gone */ }
      void spawnAgentCore({ ...pending.opts, noAutoInstall: true }, pending.owner);
      return; // an install PTY has no agent/worktree to tear down
    }
    // Non-zero exit = install failed; leave its honest manual-fix message on screen.
    analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'install_failed' });
  }
  teardownPty(id);
});

/** Keep the system from suspending the harness while agents are running.
 *  Windows Modern Standby suspends desktop apps (and their child `claude`
 *  processes!) shortly after the display sleeps/locks — the whole hive froze
 *  mid-turn until unlock. `prevent-app-suspension` blocks exactly that while
 *  still letting the display turn off and the session lock. Held only while at
 *  least one PTY is alive, so an idle harness doesn't pin a laptop awake.
 *
 *  Opt-in `config.strongKeepalive` escalates to `prevent-display-sleep`, which on
 *  macOS ALSO blocks true system sleep (lid-close/idle) so timers & PTYs keep
 *  firing on time while away — at a battery cost. The default ('prevent-app-
 *  suspension') still lets the Mac truly sleep; we survive that and catch up once
 *  on resume (see onSystemResume). Re-evaluated on every call so toggling the
 *  flag while agents run swaps the blocker mode live. */
type KeepAwakeMode = 'prevent-app-suspension' | 'prevent-display-sleep';
let keepAwakeId: number | null = null;
let keepAwakeMode: KeepAwakeMode | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  const desired: KeepAwakeMode | null = live
    ? (readConfig().strongKeepalive ? 'prevent-display-sleep' : 'prevent-app-suspension')
    : null;
  if (desired === keepAwakeMode) return; // no change — avoid stop/start churn + log spam
  // Tear down the current blocker (mode change, or going idle with no agents).
  if (keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* noop */ }
    keepAwakeId = null;
  }
  keepAwakeMode = desired;
  if (desired) {
    keepAwakeId = powerSaveBlocker.start(desired);
    console.log(`[power] keep-awake ON (${desired}) — agents running`);
  } else {
    console.log('[power] keep-awake off — no agents');
  }
}

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission honoring its lastFiredAt — a setTimeout for the
 *  time remaining until its next due fire, which then settles into a steady
 *  interval. Each tick dispatches the mission to its target agent and stamps
 *  lastFiredAt back into config. Called on boot (after the router starts) and
 *  after every missions:save. */
function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled) continue;
    // A weekly mission (day-of-week + time) is armed below and does NOT need an
    // interval, so the interval guard has to come after that branch — it used to
    // be folded into the line above and would have rejected every one of them.
    const weekly = m.kind === 'heartbeat' ? null : normalizeWeekly(m.weekly);
    if (!weekly && !(m.intervalMs > 0)) continue;
    // Heartbeat (Lane A #1) opts out of the fixed setInterval and self-reschedules
    // with an adaptive cadence. Registered into the same missionTimers map so
    // clearMissionTimers() tears it down identically on quit/reset.
    if (m.kind === 'heartbeat') { armHeartbeat(m); continue; }
    const fire = (): void => {
      try {
        // A 'compact' maintenance mission (maint-1) is compaction-ONLY: it carries
        // no dispatch body/target, so skip the hive.send and just fire auto-compact.
        // Gate on `kind!=='compact'` ALONE — that already excludes the compact mission;
        // we deliberately do NOT add `&& m.body`, so other (dispatch) missions keep
        // their prior behaviour, including the historical empty-body send (Pam N1).
        // The hourly standup on a floor where nothing has happened since the last
        // one only cost the orchestrator a turn to find that out (tokenDiet.ts).
        const idleStandup = m.id === 'ops-standup' && !floorBusySince(m.lastFiredAt ?? 0);
        if (m.kind !== 'compact' && hive.enabled() && !idleStandup) {
          const answer = parseAnswerer(m.to);
          if (answer.kind !== 'agent') {
            // "Sends to: a temp" — one temp per run, archived when it is done;
            // with no temp available the orchestrator gets the run instead.
            const toGod = (): void => { try { hive.send({ to: 'god', act: 'request', subject: m.label, body: m.body }, 'scheduler'); } catch { /* best-effort */ } };
            void hireTempForTrigger(answer, { objective: m.body, name: m.label, source: `The scheduled mission "${m.label}"` })
              .then((ok) => { if (!ok) toGod(); }, () => toGod());
          } else {
            hive.send({ to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler');
          }
        }
        // Auto-compact: do NOT jam /compact into busy terminals. Hand it to the
        // renderer, which queues a /compact per agent (deduped — never two at
        // once) and delivers it only when that agent goes idle (its drain loop),
        // so a working agent compacts between steps, never mid-step.
        //
        // The CADENCE now belongs to the context trigger, not to a mission — but
        // the legacy per-mission `autoCompact` flag keeps working, routed through
        // the same emit so there is exactly ONE path from main to the renderer.
        // It carries the context trigger's current rule so a mission-driven
        // compaction obeys the same pressure thresholds as a trigger-driven one.
        if (m.autoCompact || m.kind === 'compact') {
          emitContextTrigger('compact', contextRule('compact'));
        }
        const current = readConfig().missions ?? [];
        const next = current.map((x) =>
          x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x
        );
        writeConfig({ missions: next });
        // Let the SCHEDULES panel refresh its "last fired" without a reload (#2.3).
        try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    const entry: MissionTimer = {};
    if (weekly) {
      // Weekly self-reschedules: there is no steady interval to settle into,
      // because the gap between two slots varies (Fri to Mon is not Mon to Wed,
      // and the week the clocks change is not 168 hours long).
      //
      // `justFired` is a spin guard, not a nicety. weeklyDelayMs returns 0 for a
      // slot that was missed and not yet run, and it learns "already run" from
      // the persisted lastFiredAt — so if fire()'s writeConfig ever failed, the
      // next computation would return 0 again, forever. Passing `now` as the
      // last-fired floor after a fire makes the catch-up branch unreachable, so
      // the worst case is a lost stamp rather than a hot loop.
      const rearm = (justFired: boolean): void => {
        const now = Date.now();
        const persisted = (readConfig().missions ?? []).find((x) => x.id === m.id)?.lastFiredAt ?? 0;
        const delay = weeklyDelayMs(weekly, now, justFired ? Math.max(persisted, now) : persisted);
        if (delay === null) return;
        entry.timeout = setTimeout(() => { fire(); rearm(true); }, delay);
      };
      rearm(false);
      missionTimers.set(m.id, entry);
      continue;
    }
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

// ─── Context trigger (auto-compact / auto-clear own their own timers) ────────
// Compaction used to ride on a mission (`compact-maintenance`), which meant the
// operator had TWO competing controls for one behaviour — a schedule with an
// interval and a trigger with a cadence. The mission is retired (see the
// retirement migration in ensureDefaultMissions); these timers are the single
// remaining source of scheduled context maintenance.
//
// Main owns only the CADENCE. The pressure gate (`minContextPct`) needs each
// agent's live context usage, which only the renderer has, so the whole rule
// rides along in the event and the renderer decides which agents actually get
// the command. That split is why the payload carries the rule rather than a bare
// "go" signal.

/** Timers for the two halves, keyed by action. Same two-phase shape as
 *  `missionTimers` (a setTimeout for the remaining time, then a steady interval)
 *  so a partially-elapsed cadence survives a re-arm. */
const contextTimers = new Map<'compact' | 'clear', MissionTimer>();

/** `ContextRule` has no `lastFiredAt` (unlike `ScheduledMission`), so the last-run
 *  instants live in the durable kv store instead. Without them every re-arm —
 *  boot, a settings edit, a wake from sleep — would restart a 2h cadence from
 *  zero, and an operator who edits the rule twice a day would never see it fire. */
const CONTEXT_LAST_RUN_KV_KEY = 'triggers.context.lastRun';
let contextLastRun: Record<string, number> | null = null;

function contextRunMap(): Record<string, number> {
  if (!contextLastRun) {
    try { contextLastRun = persist.getKv<Record<string, number>>(CONTEXT_LAST_RUN_KV_KEY) ?? {}; }
    catch { contextLastRun = {}; }
  }
  return contextLastRun;
}

/** When the rule last ran. An UNRECORDED half is stamped NOW rather than read as
 *  the epoch: `remaining` would otherwise clamp to 0 and compact every terminal
 *  the instant the app boots. It is the same trap `ensureDefaultMissions` avoids
 *  by stamping `lastFiredAt` when it seeds a mission — a first launch should wait
 *  a full cadence, not open with an interruption. */
function contextLastRunAt(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const v = map[action];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return stampContextRun(action);
}

function stampContextRun(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const at = Date.now();
  map[action] = at;
  try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
  return at;
}

/** The live rule for one half, deep-filled. `readConfig` already fills both
 *  halves, so the default is only a belt-and-braces fallback. */
function contextRule(action: 'compact' | 'clear'): ContextRule {
  return readConfig().contextTrigger?.[action] ?? DEFAULT_CONTEXT_TRIGGER[action];
}

/** Clear and forget both context timers (setTimeout + setInterval handles). */
function clearContextTimers(): void {
  for (const t of contextTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  contextTimers.clear();
}

/** Ask the renderer to run one half of the context trigger.
 *
 *  Both callers funnel through here — the legacy per-mission `autoCompact` flag
 *  and the context trigger's own timer — so there is exactly one path from main
 *  to the renderer for each action. */
function emitContextTrigger(action: 'compact' | 'clear', rule: ContextRule): void {
  try { liveWebContents()?.send('trigger:context', { action, rule }); } catch { /* window gone */ }
  // TRANSITIONAL ALIAS: the renderer still carries the pre-Triggers
  // `mission:autoCompact` listener as a fallback. Both fire for compact until
  // every consumer has moved to `trigger:context`; then this line goes.
  if (action === 'compact') {
    try { liveWebContents()?.send('mission:autoCompact'); } catch { /* window gone */ }
  }
}

/** (Re)arm both context timers from persisted config. Clear-then-arm, so calling
 *  it after a settings change, on boot, or on wake from sleep can never stack
 *  duplicates. Honors elapsed-time-since-last-run exactly like mission arming:
 *  an overdue rule fires ONCE and then settles into its steady cadence. */
function syncContextTriggers(): void {
  clearContextTimers();
  for (const action of ['compact', 'clear'] as const) {
    const rule = contextRule(action);
    if (!rule.enabled || !(rule.everyMs > 0)) continue;
    const fire = (): void => {
      try {
        stampContextRun(action);
        // Re-read: the operator may have edited the message/thresholds since the
        // timer was armed, and the renderer should act on what's current.
        emitContextTrigger(action, contextRule(action));
      } catch (e) {
        console.error('[triggers] context', action, e);
      }
    };
    const remaining = Math.max(0, rule.everyMs - (Date.now() - contextLastRunAt(action)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, rule.everyMs);
    }, remaining);
    contextTimers.set(action, entry);
  }
}

/** Startup migration (#57/#58): archive every agent entry that is `archived:false`
 *  but has NO live PTY. This runs in bootstrapHiveServices, BEFORE the renderer can
 *  respawn anything, so at this point NO agent owns a PTY — every `archived:false`
 *  entry is therefore a stale carry-over from a prior session that quit/crashed
 *  WITHOUT archiving (e.g. the pre-acc13a3 'assistant' Dwight entry). Left as-is
 *  they have no live PTY, so the breaker beat steers them and the steer bounces to
 *  GOD as a requires_reply GOD can't clear → inbox flood.
 *
 *  "No live PTY" = ptyForAgent(id) === undefined (ptyToAgent is populated only at
 *  spawn and pruned on teardown). God is never archived. A user's real agents are
 *  unaffected: the "restore team" flow respawns them through ensureAgent, which
 *  re-clears `archived` — restorability does not depend on the archived flag. */
function archiveOrphanedAgents(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    for (const [id, a] of Object.entries(reg.agents)) {
      if (a.archived) continue;
      if (id === reg.godId) continue;        // god is never archived
      if (ptyForAgent(id)) continue;         // has a live PTY → genuinely active
      hive.setArchived(id, true);            // stale archived:false orphan → archive
      console.log('[migration] archived orphaned agent (no live PTY):', id);
    }
  } catch (e) {
    console.error('[migration] archiveOrphanedAgents failed:', e);
  }
}

/** One-time migration: ensure the built-in hourly ops standup exists for installs
 *  that predate it. Guarded by `opsStandupSeeded` so a user who later deletes the
 *  mission doesn't get it re-added on every boot. Stamps lastFiredAt = now so the
 *  first standup waits a full interval instead of firing (and compacting every
 *  terminal) immediately on launch. */
function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  // Seed the built-in heartbeat (Lane A #1) once. Shipped DISABLED, so it just
  // appears in the SCHEDULES panel for the user to turn on; lastFiredAt = now so
  // it doesn't fire on the very first launch after a user enables it.
  const cfg2 = readConfig();
  if (!cfg2.heartbeatSeeded) {
    const missions = cfg2.missions ?? [];
    const has = missions.some((m) => m.id === HEARTBEAT_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...HEARTBEAT_MISSION, lastFiredAt: Date.now() }],
      heartbeatSeeded: true
    });
  }

  // maint-1 RETIREMENT: `compact-maintenance` is no longer a mission. Scheduled
  // compaction is now the CONTEXT TRIGGER's job, so the operator has exactly one
  // control (a cadence + a pressure gate + an editable message) instead of two
  // that could disagree — a mission saying "hourly" while the trigger said "2h"
  // was a real, unresolvable conflict.
  //
  // The carry-over preserves the operator's decisions: whether compaction was ON
  // and how often. It runs at most once per install, and its guard is the
  // mission's own ABSENCE — nothing seeds `compact-maintenance` any more, so once
  // this has removed it there is nothing left to carry and a later hand-edit of
  // the trigger can never be clobbered. That keeps the `*Seeded` convention's
  // promise (exactly once, ever) without a config flag that would only ever be
  // read here; `compactMaintenanceSeeded` is left set so nothing re-seeds it.
  const cfg3 = readConfig();
  const missions3 = cfg3.missions ?? [];
  const retiring = missions3.find((m) => m.id === COMPACT_MAINTENANCE_MISSION.id);
  if (retiring) {
    const current = cfg3.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    writeConfig({
      missions: missions3.filter((m) => m.id !== COMPACT_MAINTENANCE_MISSION.id),
      contextTrigger: {
        ...current,
        compact: {
          ...current.compact,
          enabled: retiring.enabled,
          // A hand-tuned interval is a decision; only a missing/absurd one falls
          // back to whatever the trigger already carries.
          everyMs: retiring.intervalMs > 0 ? retiring.intervalMs : current.compact.everyMs
        }
      },
      compactMaintenanceSeeded: true
    });
    // …and its elapsed time, so retiring the mission mid-cycle doesn't restart a
    // 2h cadence from zero (the timers honour last-run exactly as arming did).
    if (typeof retiring.lastFiredAt === 'number' && retiring.lastFiredAt > 0) {
      const map = contextRunMap();
      map.compact = retiring.lastFiredAt;
      try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
    }
    console.log('[triggers] retired the compact-maintenance mission into contextTrigger.compact',
      `(enabled: ${retiring.enabled}, everyMs: ${retiring.intervalMs})`);
  }

  // autoCompact RETIREMENT: the flag above was only ever half-removed. Retiring
  // `compact-maintenance` left `autoCompact: true` sitting on the ops standup, so
  // a default install still asked for compaction on TWO cadences — hourly from the
  // standup, 2-hourly from the trigger — which is precisely the disagreement that
  // retirement claims to have ended. (config.ts even documented a migration that
  // strips this; it did not exist.)
  //
  // Strip it wherever it survives. This is a pure de-duplication, not a behaviour
  // change: contextTrigger.compact still runs, still on the user's own cadence and
  // pressure gate, and it is what actually performed every one of these
  // compactions already — both paths have called emitContextTrigger since Triggers
  // landed. Idempotent, so it costs one no-op scan per boot once clean.
  const cfg4 = readConfig();
  const missions4 = cfg4.missions ?? [];
  if (missions4.some((m) => m.autoCompact)) {
    writeConfig({
      missions: missions4.map(({ autoCompact, ...rest }) => {
        void autoCompact;
        return rest;
      })
    });
    console.log('[triggers] dropped the legacy per-mission autoCompact flag —',
      'contextTrigger.compact is now the only schedule that compacts');
  }
}

// ─── Heartbeat (Lane A #1) + circuit-breaker beat (#6.6b) ────────────────────

/** Is the floor quiet? Derived ONLY from signals the main process owns or can
 *  stat — log.jsonl mtime (the master signal: every routed msg/drain/spawn/task
 *  append touches it), each agent's inbox + outbox/.sent mtimes, and every live
 *  PTY's lastOutputAt (an agent printing/thinking counts as activity). Crucially
 *  NOT registry.status, which is written 'idle' once at spawn and never
 *  transitions in main — reading it would see the floor quiet forever. */
function isFloorQuiet(thresholdMs: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const times: number[] = [];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  pushMtime(join(root, 'log.jsonl'));
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      pushMtime(join(agentsDir, id, 'inbox'));
      pushMtime(join(agentsDir, id, 'outbox', '.sent'));
    }
  }
  for (const t of ptyManager.list()) times.push(t.lastOutputAt);
  if (times.length === 0) return false; // nothing to judge → don't fire
  return Date.now() - Math.max(...times) > thresholdMs;
}

/** Newest coordination-file mtime for one agent (inbox + inbox/.done, outbox +
 *  outbox/.sent, memory.md) — FILES only, deliberately excluding PTY output, so
 *  "no-progress" means "not coordinating" even while the agent is busy printing
 *  tokens. inbox/.done and the outbox dir count because handling mail (moving a
 *  message to .done, drafting an outbox message) IS coordination — without them
 *  an inbox-ack turn reads as no-progress (issue #109's second trigger). */
function lastCoordinationAt(agentId: string): number {
  const root = hive.root();
  if (!root) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  const dir = join(root, 'agents', agentId);
  pushMtime(join(dir, 'inbox'));
  pushMtime(join(dir, 'inbox', '.done'));
  pushMtime(join(dir, 'outbox'));
  pushMtime(join(dir, 'outbox', '.sent'));
  pushMtime(join(dir, 'memory.md'));
  return Math.max(...times);
}

/** Newest mtime among `paths`, read off the main thread (0 when none exist).
 *  The breaker beat stats a dozen paths per agent every 30 s; with an
 *  antivirus scanning each access that was ~0.4 s of blocked main thread. */
async function newestMtime(paths: string[]): Promise<number> {
  const { stat } = await import('node:fs/promises');
  const times = await Promise.all(paths.map((p) => stat(p).then((s) => s.mtimeMs, () => 0)));
  return Math.max(0, ...times);
}
function coordinationPaths(agentId: string): string[] {
  const root = hive.root();
  if (!root) return [];
  const dir = join(root, 'agents', agentId);
  return [join(dir, 'inbox'), join(dir, 'inbox', '.done'), join(dir, 'outbox'), join(dir, 'outbox', '.sent'), join(dir, 'memory.md')];
}
function workPaths(agentId: string): string[] {
  const cwd = hive.registry().agents[agentId]?.cwd;
  if (!cwd) return [];
  const git = join(cwd, '.git');
  return [cwd, join(git, 'index'), join(git, 'logs', 'HEAD'), join(git, 'FETCH_HEAD'), join(git, 'refs', 'remotes'), join(git, 'packed-refs')];
}

/** Newest mtime of the agent's OWN WORKING DIRECTORY — the work
 *  `lastCoordinationAt` cannot see. 0 when there is nothing to read.
 *
 *  Provider neutral by construction: `cwd` is the agent's registry entry, the
 *  same field every supported CLI is spawned into, and none of the paths below
 *  is specific to any one of them. An agent whose `cwd` is not a git checkout
 *  simply falls back to the directory's own mtime; an agent with no `cwd` at
 *  all returns 0 and behaves exactly as it does today.
 *
 *  Cheap by construction: a handful of `stat` calls on fixed paths, never a
 *  directory walk. This runs for every agent on every beat, and a working
 *  directory can hold hundreds of thousands of files. Git is what makes it
 *  affordable — each of these is rewritten by ordinary work:
 *
 *    cwd                  a file or directory added or removed at the top level
 *    .git/index           any `git add`, `git status`, `git checkout`
 *    .git/logs/HEAD       the reflog: commit, checkout, reset, merge, rebase
 *    .git/FETCH_HEAD      fetch and pull
 *    .git/packed-refs     and `.git/refs/remotes`: a push updating a tracking ref
 *
 *  Its honest limit: editing a file deep in the tree while running no git
 *  command moves none of these. That case is already covered by the breaker's
 *  own distinct-tool clock, so the two signals are complementary rather than
 *  redundant — this one exists for the window where tool events do not reach
 *  the breaker but the work is unmistakably real.
 */
function lastWorkAt(agentId: string): number {
  const cwd = hive.registry().agents[agentId]?.cwd;
  if (!cwd) return 0;
  const times: number[] = [0];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  pushMtime(cwd);
  const git = join(cwd, '.git');
  pushMtime(join(git, 'index'));
  pushMtime(join(git, 'logs', 'HEAD'));
  pushMtime(join(git, 'FETCH_HEAD'));
  pushMtime(join(git, 'refs', 'remotes'));
  pushMtime(join(git, 'packed-refs'));
  return Math.max(...times);
}

/** PTY id owning a given agent id, or undefined. */
function ptyForAgent(agentId: string): string | undefined {
  for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
  return undefined;
}

/** "Stuck" = some worker's PTY is actively printing (recent output) while its
 *  coordination files have gone stale — working-but-not-coordinating. Tightens
 *  the heartbeat cadence so we notice a wedged agent sooner. */
function looksStuck(windowMs: number): boolean {
  const reg = hive.registry();
  const now = Date.now();
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || id === reg.godId) continue;
    const ptyId = ptyForAgent(id);
    if (!ptyId) continue;
    const idle = ptyManager.idleFor(ptyId) ?? Infinity;
    if (idle < 15_000 && now - lastCoordinationAt(id) > windowMs) return true;
  }
  return false;
}

/** Bounded digest for god — paths + counts, never full files (reference-passing,
 *  #6.2). A few hundred tokens at most. */
function buildHeartbeatDigest(quietMs: number, actionable = 0): string {
  const reg = hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(', ') || '—';
  const boardHead = hive.board().split('\n').slice(0, 10).join('\n').trim();
  const log = hive.logTail(8).map((e) => { try { return JSON.stringify(e); } catch { return ''; } }).filter(Boolean).join('\n');
  const withInbox = active.filter(([id]) => hive.inbox(id).length > 0).map(([, a]) => a.name);
  // When real agent/human mail is waiting, lead with an explicit call-to-action
  // instead of the "quiet" line — this beat fired BECAUSE of unread actionable
  // inbox, not because the floor went quiet, and god must read it now.
  const header = actionable > 0
    ? `Floor heartbeat — ${actionable} actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.`
    : `Floor heartbeat — quiet ~${Math.round(quietMs / 60000)}m.`;
  return [
    header,
    `Active agents (${active.length}): ${names}.`,
    withInbox.length ? `Undrained inbox: ${withInbox.join(', ')}.` : 'No undrained inboxes.',
    '',
    'Board (head):',
    boardHead || '(empty)',
    '',
    'Recent log:',
    log || '(none)',
    '',
    'Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done.'
  ].join('\n');
}

/** Anything on the floor since `since`: a log event that is not the
 *  scheduler's own, or a worker active in the meantime (fleet.json). */
function floorBusySince(since: number): boolean {
  const root = hive.root();
  if (!root || !since) return true;
  try {
    const log = readFileSync(join(root, 'log.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-500);
    if (floorActiveSince(log, since)) return true;
    const fleet = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as { agents?: Array<{ isGod?: boolean; lastActiveSecAgo?: number | null }> };
    const window = (Date.now() - since) / 1000;
    return (fleet.agents ?? []).some((a) => !a.isGod && typeof a.lastActiveSecAgo === 'number' && a.lastActiveSecAgo < window);
  } catch { return true; }
}

/** Senders whose mail is the scheduler's OWN noise (heartbeat beats, ops-standup
 *  via 'scheduler', breaker steers, generic 'system') — never a reason to wake
 *  god. Everything else (a worker agent id, 'webhook', a human reply) is real
 *  mail god must act on. Kept narrow so any future real sender counts by default. */
const SYSTEM_SENDERS = new Set(['heartbeat', 'scheduler', 'breaker', 'system']);

/** Count of UNREAD actionable messages in god's inbox — real agent/human mail,
 *  excluding the scheduler's own beats. Drives an inbox-aware re-engage so a
 *  worker's reply (or a human answer) doesn't sit unread while the floor is busy:
 *  the floor-quiet gate alone misses that case — any active agent keeps the floor
 *  "loud", so god was never re-engaged until everything else went idle. */
function godActionableInboxCount(): number {
  try {
    const godId = hive.registry().godId;
    if (!godId) return 0;
    return hive.inbox(godId).filter((m) => !SYSTEM_SENDERS.has(m.from)).length;
  } catch { return 0; }
}

/** Re-engage a quiet floor: drop a durable digest into god's inbox. We never
 *  type directly into god's PTY here — if he's busy that would jam mid-step. The
 *  inbox message is delivered by the renderer's busy-aware inbox-wake (it nudges
 *  god to read his inbox only once he's idle), so the heartbeat defers around a
 *  working god instead of interrupting him. */
function reengageGod(digest: string): void {
  if (!hive.enabled()) return;
  hive.send({ to: 'god', act: 'request', subject: 'Heartbeat', body: digest }, 'heartbeat');
}

/** A native toast for breaker constrain/stop, gated on the notifications setting. */
function breakerToast(title: string, body: string, agentId?: string): void {
  if (!readConfig().notifications) return;
  const icon = agentId ? agentFaces.get(agentId) : undefined;
  try { if (Notification.isSupported()) new Notification({ title, body, ...(icon ? { icon } : {}) }).show(); }
  catch { /* unsupported platform */ }
}

// Agents' faces for desktop notifications: the renderer paints each cast
// portrait and sends it here (keyed by agent id and by lower-case name).
const agentFaces = new Map<string, Electron.NativeImage>();
ipcMain.handle('notify:setFaces', (_evt, faces: unknown) => {
  if (!faces || typeof faces !== 'object') return;
  for (const [key, url] of Object.entries(faces as Record<string, unknown>)) {
    if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,') || url.length > 200_000) continue;
    try { agentFaces.set(key, nativeImage.createFromDataURL(url)); } catch { /* bad image */ }
  }
});

/** One circuit-breaker beat: pull a fresh usage sample per active agent, append
 *  it to the durable cost ledger (the SOLE durable cost store), tick the breaker,
 *  emit each BreakerState on control:breakerState (Seam 2), and enforce any
 *  escalation. God is in the LEDGER (cost visibility) but NOT the breaker inputs
 *  (the heartbeat manages god; we never auto-steer/kill the orchestrator). */
let breakerBeatRunning = false;
async function runBreakerBeat(progressWindowMs: number): Promise<void> {
  if (!hive.enabled() || breakerBeatRunning) return;
  breakerBeatRunning = true;
  try {
  const reg = hive.registry();
  // Every live agent's file times, read in parallel off the main thread first.
  const watched = Object.entries(reg.agents).filter(([id, a]) => !a.archived && !a.isAssistant && id !== reg.godId && ptyForAgent(id)).map(([id]) => id);
  const mtimes = new Map(await Promise.all(watched.map(async (id) =>
    [id, { coordination: await newestMtime(coordinationPaths(id)), work: await newestMtime(workPaths(id)) }] as const)));
  const now = Date.now();
  const inputs: BreakerInput[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived) continue;
    // #57/#58: skip assistant + orphaned shells. The breaker must only evaluate
    // live, real agents. An assistant entry (e.g. the pre-acc13a3 headless
    // 'Dwight') or any orphaned entry left archived:false with NO live PTY would
    // otherwise be steered, and that steer bounces to GOD as a requires_reply GOD
    // can't clear → inbox flood. ptyForAgent(id) === undefined means no live PTY.
    // God is exempt from this orphan check (it keeps its own flow + the godId skip
    // below) so its ledger row is unaffected. Live real agents always own a PTY
    // (ptyToAgent is set at spawn), so their breaker behavior is unchanged.
    if (a.isAssistant) continue;
    if (id !== reg.godId && !ptyForAgent(id)) continue;
    const sample = usageProvider.getAgentUsage(id);
    // #56: only append a ledger row for a LIVE session sample. A dead/orphaned
    // agent with a frozen transcript still yields a sample via the transcript
    // fallback, but with an EMPTY sessionId (aggregateLive returns null → no live
    // OTel session). Appending it every ~30s rewrote the identical row forever
    // (2,417 dupes observed). A truthy sessionId is set only by a live session
    // (aggregateLive picks the most-recent live session id), so this gates on
    // "is there a live session" without changing any live-agent behavior.
    if (sample?.sessionId) {
      // A Grok sample's session id is always truthy, so for that provider #56's
      // duplicate-row risk moves from "is there a live session" to "did anything
      // change". Short-circuits before the gate for everyone else, leaving the
      // live-OTel path exactly as it was.
      const moved = a.provider !== 'grok' || grokLedgerGate.admits(sample);
      if (moved) hive.appendCostLedger(sample); // ledger covers everyone incl. god
    }
    // Second source for the resume key. recordSession() is otherwise reachable
    // ONLY from the hook shim, so any window where hooks don't land leaves the
    // registry with no sessionId and "Restart & Continue" refuses to continue —
    // while this very sample proves the app knew the live session id all along
    // (it was already being written to the cost ledger one line above). Same id,
    // same liveness gate; recordSession writes only on change, so this is a
    // no-op once the hooks are flowing.
    if (sample?.sessionId) hive.recordSession(id, sample.sessionId);
    if (id === reg.godId) continue;            // breaker skips god
    // Progress = fresh coordination files OR a recent OTel tool span. The span
    // leg closes the background-work blind spot: subagent/Workflow tool calls
    // never reach the parent session's PostToolUse hook (so the breaker's own
    // distinct-tool clock stays stale) but their spans DO flow through the
    // collector under this agent's id — an idle parent supervising a hard-
    // working background fleet is progressing, not wedged. Observed live: the
    // one residual no-progress false positive after the #109 fixes.
    const spans = telemetry.getSpans(id);
    const lastSpanAt = spans.length ? spans[spans.length - 1].ts : 0;
    inputs.push({
      agentId: id,
      sample,
      progressing: now - (mtimes.get(id)?.coordination ?? lastCoordinationAt(id)) < progressWindowMs || now - lastSpanAt < progressWindowMs,
      // Work, as distinct from coordination. The breaker decides what to do
      // with it; the beat only reports it.
      lastWorkAt: mtimes.get(id)?.work ?? lastWorkAt(id)
    });
  }
  for (const d of breaker.tick(inputs, now)) {
    try { liveWebContents()?.send('control:breakerState', d.state); } catch { /* window gone */ }
    if (d.action === 'none') continue;
    const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
    const reason = d.state.reason;
    // The same warning to the same agent goes out once per window: a level
    // that recovers and trips again re-escalates, and resending the message
    // each time only fills the agent's inbox.
    if ((d.action === 'steer' || d.action === 'constrain')
      && !breakerWarnings.shouldSend(d.state.agentId, warningKey(`Circuit breaker: ${d.action}`, reason), now)) continue;
    if (d.action === 'steer') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
        body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask god for direction.` }, 'breaker');
    } else if (d.action === 'constrain') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
        body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to god for sign-off BEFORE running more tools.` }, 'breaker');
      breakerToast(`${name} constrained`, reason, d.state.agentId);
    } else if (d.action === 'stop') {
      const ptyId = ptyForAgent(d.state.agentId);
      if (ptyId) { try { ptyManager.kill(ptyId); } catch { /* already gone */ } teardownPty(ptyId); }
      breakerToast(`${name} stopped by circuit breaker`, reason, d.state.agentId);
    }
  }
  } finally { breakerBeatRunning = false; }
}

/** Lifetime spend, folded from cost-ledger.jsonl. `telemetry`'s usd counter is
 *  cumulative-since-process-start and restarts at ~0 on every app restart, so
 *  it cannot answer "what has this agent cost us". See costLifetime.ts. */
const costTotals = new CostLedgerTotals();

let fleetBusy = false;
/** Build + write the live fleet snapshot Michael reads (`<hive>/fleet.json`).
 *  Always-on (independent of the heartbeat) since `claude agents` can't see the
 *  hive's sibling sessions. PII-free; never throws (called from a timer). */
function writeFleetSnapshot(): void {
  if (!hive.enabled() || fleetBusy) return;
  fleetBusy = true;
  void buildAndWriteFleetSnapshot().finally(() => { fleetBusy = false; });
}

/** Disk work (inbox counts, the write) is async: a sync pass froze the main
 *  process for 4.8 s once on a slow disk. One pass at a time. */
async function buildAndWriteFleetSnapshot(): Promise<void> {
  try {
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    // Async + incremental; returns immediately and never throws into the timer.
    const hiveRoot = hive.root();
    if (hiveRoot) void costTotals.refresh(join(hiveRoot, 'cost-ledger.jsonl'));
    const live = Object.entries(reg.agents).filter(([, a]) => !a.archived);
    const backlogs = await Promise.all(live.map(([id]) => hive.inboxBacklogAsync(id)));
    const agents = live
      .map(([id, a], i) => {
        const spans = snap.spans[id] ?? [];
        // Claude's live OTel first; every other engine reports through its hook
        // bridge (CostSample, tool events). `usd` is LIFETIME (reset-corrected)
        // once the ledger holds this agent; until then the session figure rather
        // than a cold $0. Nothing reported at all stays null, not 0.
        const fu = fleetUsage({
          live: usageById.get(id),
          hook: hookServer.usage.usageFor(id),
          spanTool: spans.length ? spans[spans.length - 1].tool : null,
          activity: hookServer.usage.activityFor(id),
          lifetimeUsd: costTotals.has(id) ? costTotals.usdFor(id) : null,
          now
        });
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
          cwd: a.cwd,
          isGod: !!a.isGod,
          breaker: breaker.levelFor(id),
          ...fu,
          inboxBacklog: backlogs[i],
          onHold: !!a.onHold
        };
      });
    // `hooks` is the control plane's own health (#277): god and the operator
    // can read from fleet.json whether hooks are being enforced at all.
    await hive.writeFleetSnapshotAsync({ ts: now, agents, hooks: hookServer.health() });
  } catch (e) {
    console.error('[fleet] snapshot failed:', e);
  }
}

/** Arm the heartbeat with an adaptive, self-rescheduling cadence (recursive
 *  setTimeout instead of a fixed setInterval). Each beat runs the cost/breaker
 *  pass, re-engages a quiet floor, stamps lastFiredAt, then re-arms: ~base on a
 *  normal beat, base/4 (min 30s) when an agent looks stuck, base*2.5 right after
 *  a re-engage. Registered into missionTimers so shutdown tears it down. */
function armHeartbeat(m: ScheduledMission): void {
  const base = m.intervalMs;
  const quiet = m.quietThresholdMs ?? 300_000;
  const beat = (): void => {
    let next = base;
    try {
      // (the breaker beat + cost ledger now run on their own always-on timer)
      // Re-engage god when the floor is quiet OR when real agent/human mail is
      // waiting in god's inbox — the latter is independent of floor-quiet so a
      // worker's reply doesn't sit unread while other agents keep the floor busy.
      const actionable = godActionableInboxCount();
      if (isFloorQuiet(quiet) || actionable > 0) {
        reengageGod(buildHeartbeatDigest(quiet, actionable));
        next = Math.round(base * 2.5);            // back off after re-engaging
      } else if (looksStuck(quiet)) {
        next = Math.max(30_000, Math.round(base / 4)); // tighten when an agent is wedged
      }
      const cur = readConfig().missions ?? [];
      writeConfig({ missions: cur.map((x) => (x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x)) });
      try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
    } catch (e) {
      console.error('[heartbeat]', e);
    }
    const entry = missionTimers.get(m.id) ?? {};
    entry.timeout = setTimeout(beat, next);
    missionTimers.set(m.id, entry);
  };
  const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
  missionTimers.set(m.id, { timeout: setTimeout(beat, remaining) });
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) return wc;
  // Primary gone (closed/destroyed): fall back to any other live window so a
  // global event still reaches a renderer instead of being silently dropped.
  for (const w of allWindows) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
  }
  return null;
}

// ─── Slack webhook server (Slack message → Michael's queue) ──────────────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;
/** The loopback-only reply endpoint (lets the bundled helper post back to Slack
 *  without ever seeing the bot token). Lifecycle is tied to `slackServer`. */
let slackReplyServer: SlackReplyServer | null = null;
/** The reply endpoint's loopback port (bridged into WSL floors). */
let slackReplyPort: number | null = null;
/** Last public tunnel URL handed out — persisted so Settings can re-show the
 *  Request URL after a reopen (Slack reuses it until the server is stopped). */
let lastSlackUrl: string | undefined;

/** AUTONOMOUS REQUEST PROTOCOL — built PER MESSAGE (not a static const) so it can
 *  embed the request's concrete `channel`, `thread_ts`, and the resolved helper
 *  path. Prepended (server-side, authoritatively) to the working instruction god
 *  reads for any Slack-origin request: there is no interactive human at the
 *  keyboard, so god must route fast, delegate WITH the exact reply command (so the
 *  worker posts its real result back into THIS thread itself), stay autonomous,
 *  and only block on enumerated high-severity actions. Prepended to god's PROMPT
 *  only — the human-facing kanban card TITLE stays the user's raw text (the
 *  renderer keeps them split). Trailing space is intentional so the user's message
 *  reads naturally after it. */
function buildAutonomousRequestProtocol(channel: string, threadTs: string, helperPath: string): string {
  return `[AUTONOMOUS REQUEST PROTOCOL — this request arrived via Slack; no interactive human is watching] Handle it under this protocol:
1. ROUTE FAST — triage and hand this to the single most-relevant agent right away. CHECK THE LIVE ROSTER FIRST (active agents in registry.json + their state in fleet.json) and prefer an EXISTING agent that fits — especially when the request names one ("ask Pam…", "have Jim…"): route to that agent and only spawn a new one if none is a sensible fit. Decompose only if it genuinely needs several. Don't sit on it.
2. DELEGATE WITH THE REPLY HANDLE — tell that agent to do the work autonomously AND to post its result back to THIS Slack thread itself when done, using exactly: "${hive.nodeCommand()}" "${helperPath}" --channel ${channel} --thread ${threadTs} --text "<substantive result>" (that first path is the harness's bundled Node, already resolved for this machine — pass it verbatim; bare "node" is not on the hook/agent PATH on many machines.)
3. AUTONOMOUS EXECUTION — no interactive questions. PAUSE/ask ONLY for high-severity actions: pushing to main or any remote; buying or spawning infrastructure or paid services; deleting an existing repo, file, or folder it did not create. Stay READ-ONLY at critical infrastructure and git-push-type changes unless explicitly approved.
4. DIRECT, SUBSTANTIVE REPLY — the agent posts a real Slack-mrkdwn answer (short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done"/":white_check_mark:".
5. REPORT TO GOD — the agent then tells you (the orchestrator) what it did.
6. ASYNC QUESTIONS — if a decision is genuinely needed, don't block: post the question + numbered OPTIONS to the thread via that reply command, and record {q, options, askedAt (ISO + day & time), thread_ts ${threadTs}} so the threaded human reply correlates back and resumes.
The user's message starts now: `;
}

// ─── Slack done-notifier (Slack-origin task → done → one summary reply) ───────
/** Polls the shared kanban (hive/tasks.json) for Slack-origin tasks that reach
 *  'done' and posts ONE summary reply into the originating thread. Lifecycle is
 *  tied to `slackServer`. OUTBOUND-only: it never touches inbound queue/lanes. */
let slackDoneTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow post can't overlap the next tick. */
let slackDonePolling = false;
/** Task ids already notified — exactly-once across re-reads AND restarts. Lazily
 *  loaded from / persisted to `slackDoneNotifiedPath()`. */
let slackDoneNotified: Set<string> | null = null;
/** Ids already 'done' when the observer started — baselined (never notified) so a
 *  summary only ever fires on a live …→done transition, not on pre-existing dones. */
let slackDoneBaseline: Set<string> | null = null;
/** thread_ts values an agent has ALREADY answered directly via the loopback
 *  `/reply` endpoint. The done-summary poller skips these — the agent's own
 *  substantive reply already landed in-thread, so the poller is a fallback, not a
 *  duplicator (this is what stops the bare/duplicate `:white_check_mark:` posts). */
const directlyRepliedThreads = new Set<string>();

/** Absolute path to the bundled `md-slack-reply.cjs` helper. Packaged: under
 *  `process.resourcesPath` (electron-builder extraResources). Dev: the repo's
 *  `resources/` dir, resolved from the app path. */
function slackReplyScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'md-slack-reply.cjs')
    : join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
}

/** W3 — the bundled read-only `skills/` source dir copied into each agent's
 *  `.claude/skills/` at spawn. Same packaged/dev resolution as the helpers above.
 *  Tolerated-missing until lp-manifest (Kevin) populates it (the hive copy is a
 *  no-op on an absent dir). */
function skillsResourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills');
}

/** Where the helper discovers `{ port, token }` for the loopback endpoint. Kept
 *  under userData (NOT the git repo, NOT mined into MemPalace). */
function slackReplyConfigPath(): string {
  return join(app.getPath('userData'), 'slack-reply.json');
}

/** Ledger of task ids whose done-summary has already been posted. Ids ONLY — no
 *  secret ever lands here. Under userData (out of the repo, out of MemPalace). */
function slackDoneNotifiedPath(): string {
  return join(app.getPath('userData'), 'slack-done-notified.json');
}

/** Directory where downloaded Slack attachments are saved (out of repo, out of MemPalace). */
function slackFilesDir(): string {
  return join(app.getPath('userData'), 'slack-files');
}

/** Per-file download size cap — reject files larger than 10 MB before writing. */
const SLACK_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Socket inactivity timeout for Slack file downloads (matches fetchText.ts's 12s). */
const SLACK_DOWNLOAD_TIMEOUT_MS = 12_000;

/** Sanitize a Slack filename: keep only the basename, replace non-safe chars,
 *  prefix with a random hex tag to prevent collisions and path-traversal attacks. */
function sanitizeSlackFilename(name: string | undefined, tag: string): string {
  const safe = (typeof name === 'string' && name)
    ? basename(name).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file'
    : 'file';
  return `${tag}-${safe}`;
}

/**
 * Download a single Slack private file into slackFilesDir() using the bot token.
 * Returns the local path on success, null on any failure (size limit, network, etc.).
 * The bot token is used only in the Authorization header and is NEVER logged.
 */
function downloadSlackFile(
  file: SlackEventFile,
  botToken: string,
  destDir: string
): Promise<{ path: string; name: string; mimetype: string } | null> {
  return new Promise((resolve) => {
    const tag = randomBytes(4).toString('hex');
    const filename = sanitizeSlackFilename(file.name, tag);
    const destPath = join(destDir, filename);
    const name = file.name ?? filename;
    const mimetype = file.mimetype ?? 'application/octet-stream';

    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      resolve(null);
      return;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(file.url_private);
    } catch {
      resolve(null);
      return;
    }
    if (urlObj.protocol !== 'https:') { resolve(null); return; }

    const req = httpsRequest(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET',
        headers: { authorization: `Bearer ${botToken}` } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume(); // drain response body
          resolve(null);
          return;
        }
        let written = 0;
        let aborted = false;
        const stream = createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          written += chunk.length;
          if (written > SLACK_FILE_MAX_BYTES) {
            aborted = true;
            stream.destroy();
            try { unlinkSync(destPath); } catch { /* best-effort cleanup */ }
            res.destroy();
            resolve(null);
            return;
          }
          stream.write(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          stream.end(() => resolve({ path: destPath, name, mimetype }));
        });
        res.on('error', () => { stream.destroy(); resolve(null); });
        stream.on('error', () => { res.destroy(); resolve(null); });
      }
    );
    req.on('error', () => resolve(null));
    // Node has no default socket timeout: a peer that accepts the connection but
    // never responds would leave this promise pending forever, and onMessage
    // awaits the download — after the webhook already 200-acked Slack — so the
    // inbound message would be silently dropped. Destroy with an error so the
    // 'error' handler resolves null (a dropped attachment, not a dropped message).
    req.setTimeout(SLACK_DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.end();
  });
}

/**
 * Download all raw Slack files (up to cap) and return the local-path file list.
 * Failures are silently dropped — a partial list is still useful to the agent.
 */
async function downloadSlackFiles(
  rawFiles: SlackEventFile[],
  botToken: string | undefined
): Promise<{ path: string; name: string; mimetype: string }[]> {
  if (!rawFiles.length || !botToken) return [];
  const destDir = slackFilesDir();
  const results = await Promise.all(
    rawFiles.map((f) => downloadSlackFile(f, botToken, destDir))
  );
  return results.filter((r): r is { path: string; name: string; mimetype: string } => r !== null);
}

function loadSlackDoneNotified(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(slackDoneNotifiedPath(), 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { /* missing/corrupt → start empty */ }
  return new Set();
}

function persistSlackDoneNotified(set: Set<string>): void {
  try { writeFileSync(slackDoneNotifiedPath(), JSON.stringify([...set])); }
  catch (e) { console.error('[slack] could not persist done-notify ledger:', e); }
}

/** Slack `chat.postMessage` errors that are permanent for this config — retrying
 *  can never make them succeed, so a failed post with one of these is recorded
 *  (not retried) to avoid flooding the log every 5s. Anything else is treated as
 *  transient and left to retry. */
const TERMINAL_SLACK_ERRORS = new Set<string>([
  'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
  'token_revoked', 'token_expired', 'no_permission', 'channel_not_found',
  'not_in_channel', 'is_archived', 'restricted_action', 'org_login_required',
]);

/** The single in-thread summary for a finished task. Sourced from the task's
 *  result/description (falling back to the title), trimmed Slack-friendly. */
function slackDoneSummary(task: HiveTask): string {
  const body = (task.result ?? task.description ?? '').trim();
  const head = `:white_check_mark: *${task.title}*`;
  const text = body ? `${head}\n\n${body}` : head;
  return text.length > 2800 ? `${text.slice(0, 2799)}…` : text;
}

/** One observation pass over the kanban. Posts a summary for any Slack-origin
 *  task that has newly reached 'done'. Best-effort and self-guarding — it must
 *  never throw into the timer, and the bot token never leaves this function. */
async function pollSlackDoneTasks(): Promise<void> {
  if (slackDonePolling) return;
  const botToken = readConfig().slackBotToken;
  if (!botToken) return; // can't post without the token — nothing to do
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick

  const notified = slackDoneNotified ?? (slackDoneNotified = loadSlackDoneNotified());

  // First tick seeds the baseline (ids already done) and posts nothing — so we
  // only ever fire on a transition observed live this session.
  if (slackDoneBaseline === null) {
    slackDoneBaseline = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return;
  }
  const baseline = slackDoneBaseline;

  slackDonePolling = true;
  try {
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      if (baseline.has(t.id) || notified.has(t.id)) continue; // already handled
      const slack = t.slack;
      if (!slack || !slack.channel || !slack.thread_ts) continue; // non-Slack-origin → leave alone
      // FALLBACK-ONLY: if the agent already posted a DIRECT reply into this thread
      // (loopback /reply), the human has its substantive answer — don't double-post.
      if (directlyRepliedThreads.has(slack.thread_ts)) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      // Never post a bare `:white_check_mark: *title*` with no substance: if the card
      // carries neither a result nor a description, there is nothing meaningful to
      // deliver — skip it (still under the FALLBACK contract).
      if (!(t.result ?? t.description ?? '').trim()) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      const res = await postSlackReply({
        botToken, channel: slack.channel, thread_ts: slack.thread_ts, text: slackDoneSummary(t)
      });
      if (res.ok) {
        notified.add(t.id);
        persistSlackDoneNotified(notified); // mark-on-success → exactly one delivered reply
      } else if (res.error && TERMINAL_SLACK_ERRORS.has(res.error)) {
        // A permanent config/auth error (e.g. the bot token lacks `chat:write`)
        // will NEVER succeed — record the id so we stop hammering every tick, and
        // log the reason once. Never log the token or message body.
        notified.add(t.id);
        persistSlackDoneNotified(notified);
        console.error('[slack] done-summary post for task', t.id,
          '— giving up (terminal error:', res.error + '). Fix the Slack bot scope/permissions; later tasks post once resolved.');
      } else {
        // Transient (network / rate-limit / unknown) → leave unmarked so a later
        // tick retries. Log the id + error only; never the token or message body.
        console.error('[slack] done-summary post failed for task', t.id, '-', res.error, '(will retry)');
      }
    }
  } finally {
    slackDonePolling = false;
  }
}

/** Begin watching the kanban for Slack-origin done-transitions (idempotent). */
function startSlackDoneObserver(): void {
  if (slackDoneTimer) return;
  slackDoneNotified = loadSlackDoneNotified();
  slackDoneBaseline = null; // re-seed on the first tick of this session
  slackDoneTimer = setInterval(() => { void pollSlackDoneTasks(); }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopSlackDoneObserver(): void {
  if (slackDoneTimer) { clearInterval(slackDoneTimer); slackDoneTimer = null; }
  slackDoneBaseline = null;
}

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    // Downloads any file attachments (bot token stays in main; local paths go to IPC).
    onMessage: async (m) => {
      const localFiles = await downloadSlackFiles(
        m._rawFiles ?? [],
        readConfig().slackBotToken
      );
      // `text` stays the user's RAW Slack text → drives the readable kanban card
      // title. `autonomyPreamble` is the authoritative policy block the renderer
      // prepends ONLY to god's working instruction (his PTY prompt), keeping the
      // card title human-facing-clean. Built PER MESSAGE so the AUTONOMOUS REQUEST
      // PROTOCOL carries THIS request's concrete channel, thread_ts, and the
      // resolved helper path — god hands the worker an exact reply command.
      // Server-side so it applies to every session.
      const ipcMsg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble: string; files?: typeof localFiles } = {
        text: m.text, channel: m.channel, ts: m.ts, thread_ts: m.thread_ts,
        autonomyPreamble: buildAutonomousRequestProtocol(m.channel, m.thread_ts, slackReplyScriptPath())
      };
      if (localFiles.length > 0) ipcMsg.files = localFiles;
      // A temp answers in the thread instead when Slack says so; with no temp
      // available the message goes to the orchestrator's queue as before.
      const answer = parseAnswerer(readConfig().slackAnswer);
      if (answer.kind !== 'agent') {
        const files = localFiles.length ? `\n\nAttached files (downloaded for you):\n${localFiles.map((f) => `- ${f.path}`).join('\n')}` : '';
        const started = await hireTempForTrigger(answer, {
          objective: `${m.text}${files}`,
          name: 'Slack',
          slack: { channel: m.channel, thread_ts: m.thread_ts },
          source: 'A Slack message'
        }).catch(() => false);
        if (started) return;
      }
      try { liveWebContents()?.send('slack:incomingMessage', ipcMsg); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) { slackServer = null; return res; }
  if (res.url) lastSlackUrl = res.url;
  // Bring up the loopback reply endpoint (token-gated, never tunneled) and drop
  // the discovery file for the bundled helper. Best-effort: reply path being
  // unavailable must not sink ingestion.
  await startSlackReplyServer();
  // Begin watching the kanban for Slack-origin tasks that reach 'done', to post
  // their one summary reply in-thread. OUTBOUND-only; never touches ingestion.
  startSlackDoneObserver();
  analytics.trackFeature('slack_trigger');
  return res;
}

/** Start the loopback reply endpoint and write its `{ port, token }` to userData
 *  so `md-slack-reply.cjs` can reach it. The bot token is read lazily from config
 *  at reply time and never written to this file. */
async function startSlackReplyServer(): Promise<void> {
  slackReplyServer?.stop();
  const token = randomBytes(24).toString('hex');
  slackReplyServer = new SlackReplyServer({
    token,
    getBotToken: () => readConfig().slackBotToken,
    // An agent posted a DIRECT substantive reply into this thread → record it so the
    // done-summary poller skips it (the poller is a fallback, not a duplicator).
    onReplied: (thread_ts) => { directlyRepliedThreads.add(thread_ts); }
  });
  const r = await slackReplyServer.start();
  if (!r.ok || r.port === undefined) {
    console.error('[slack] reply endpoint failed to start:', r.error);
    slackReplyServer = null;
    return;
  }
  slackReplyPort = r.port;
  try {
    writeFileSync(slackReplyConfigPath(), JSON.stringify({ port: r.port, token }), { mode: 0o600 });
  } catch (e) {
    console.error('[slack] could not write reply config:', e);
  }
}

/** Stop and forget the Slack server (+ reply endpoint). Best-effort; safe to call
 *  when not running. The last tunnel URL is retained so Settings keeps showing it. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
  try { slackReplyServer?.stop(); } catch (e) { console.error('[slack] reply stop failed:', e); }
  slackReplyServer = null;
  stopSlackDoneObserver();
  try { if (existsSync(slackReplyConfigPath())) unlinkSync(slackReplyConfigPath()); } catch { /* noop */ }
}

// ─── Generic inbound webhook + status API (multi-endpoint) ───────────────────
/** The running generic-webhook server, or null when disabled/stopped. A PUBLIC
 *  (tunnel-forwarded) surface — secret-gated, unlike the loopback /reply. ONE
 *  server and ONE tunnel serve EVERY configured endpoint; the id in the request
 *  path picks which. Adding a webhook therefore costs no port and no tunnel, and
 *  never disturbs a caller already pointed at another endpoint's URL. */
let webhookServer: WebhookServer | null = null;
/** Last public tunnel URL handed out — retained so Settings can re-show the
 *  endpoint after a reopen (the tunnel rotates it per restart). */
let lastWebhookUrl: string | undefined;

/** Local port the shared server binds to. The port is a property of the SERVER,
 *  not of any one trigger — `webhookPort` stays the (legacy) override. */
const WEBHOOK_DEFAULT_PORT = 3849;

/** The endpoints the operator has switched on. A disabled webhook is not merely
 *  rejected at the door — it is never handed to the server, so its id does not
 *  exist on the wire and its secret is not in memory on the request path. */
function enabledWebhookEndpoints(): WebhookTrigger[] {
  return (readConfig().webhookTriggers ?? []).filter((t) => t.enabled && !!t.secret);
}

/** SHA-256 hex of a capability token. The raw token is returned to the caller
 *  exactly once (the POST response) and never persisted; only this digest lands
 *  on the kanban card, so a GET can match without the raw token ever resting. */
function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** tokenHash → id of the `pending` history entry it belongs to.
 *
 *  A message the mode gate held has NO kanban card (the card is what approval
 *  creates), so this map is the only way its caller's GET can be answered — and
 *  answered HONESTLY, as "awaiting-approval" rather than a lie about queued work.
 *  It stores the token's DIGEST, never the token, exactly like the card stamp,
 *  and it is mirrored into the durable kv store so a restart doesn't 404 every
 *  caller that is still politely waiting on the operator. */
let heldWebhookTokens: Map<string, string> | null = null;
const HELD_TOKENS_KV_KEY = 'triggers.webhook.heldTokens';

function heldTokens(): Map<string, string> {
  if (heldWebhookTokens) return heldWebhookTokens;
  let stored: Record<string, string> | undefined;
  try { stored = persist.getKv<Record<string, string>>(HELD_TOKENS_KV_KEY); }
  catch { stored = undefined; }
  const entries = stored && typeof stored === 'object' ? Object.entries(stored) : [];
  heldWebhookTokens = new Map(entries.filter((e): e is [string, string] => typeof e[1] === 'string'));
  return heldWebhookTokens;
}

function persistHeldTokens(): void {
  try { persist.setKv(HELD_TOKENS_KV_KEY, Object.fromEntries(heldTokens())); }
  catch (e) { console.error('[webhook] could not persist held-token map:', e); }
}

/** Drop mappings whose history entry has aged out of the (capped) ledger — the
 *  operator can no longer decide them, so their tokens are dead weight. */
function pruneHeldTokens(): void {
  const map = heldTokens();
  if (map.size === 0) return;
  const live = new Set(listTriggerHistory().map((e) => e.id));
  let changed = false;
  for (const [hash, entryId] of [...map]) {
    if (!live.has(entryId)) { map.delete(hash); changed = true; }
  }
  if (changed) persistHeldTokens();
}

/** The token digest a held history entry was accepted under, if we still have it. */
function heldTokenHashFor(entryId: string): string | undefined {
  for (const [hash, id] of heldTokens()) if (id === entryId) return hash;
  return undefined;
}

/** Tell the Triggers tab its ledger moved, so history live-refreshes instead of
 *  waiting for the operator to re-open the tab. */
function notifyTriggerHistoryUpdated(): void {
  try { liveWebContents()?.send('triggerHistory:updated'); } catch { /* window gone */ }
}

/**
 * Create the stamped kanban card for an inbound message and route it to god.
 *
 * Split out of `handleWebhookMessage` because the APPROVAL path takes exactly
 * this route later — an operator saying yes must produce the same card and the
 * same god request an auto-allowed message would have, or the two paths drift
 * and "approved" quietly means something weaker than "allowed".
 *
 * Returns false only when the card — the thing the caller polls — could not be
 * written. The god routing is best-effort: the card already exists and is
 * pollable even if the send hiccups.
 */
function dispatchWebhookWork(arg: {
  taskId: string;
  title: string;
  message: string;
  /** Stamped onto the card so a GET can match the caller's token. */
  tokenHash?: string;
  /** 'webhook' | 'org' — only for the subject line and the god-facing note. */
  origin: 'webhook' | 'org';
  /** The endpoint's "who answers" (WebhookTrigger.answer): unset = the orchestrator. */
  answer?: string;
}): boolean {
  try {
    const card: HiveTask = {
      id: arg.taskId,
      title: arg.title,
      description: arg.message,
      status: 'todo',
      dependsOn: [],
      priority: 1,
      createdAt: new Date().toISOString(),
      ...(arg.tokenHash ? { webhook: { tokenHash: arg.tokenHash } } : {})
    };
    // addTask appends against the latest on-disk ledger and is idempotent by task
    // id, so a concurrent card writer (Slack, god, voice, another webhook) can't
    // have its card lost to our stale whole-ledger overwrite. (writeTasks(...existing)
    // recreated exactly that race.) A fresh taskId never collides, so this always adds.
    hive.addTask(card);
  } catch (e) {
    console.error('[webhook] could not create task card:', e instanceof Error ? e.message : e);
    return false;
  }
  // Body carries ONLY the sender's message + the card id (so whoever finishes it
  // updates that card's status/result for the caller's GET) — never the secret,
  // never the raw token.
  const toGod = (): void => {
    try {
      hive.send({
        to: 'god',
        act: 'request',
        subject: `[${arg.origin}] ${arg.title}`,
        body: `${arg.message}\n\n(Inbound via the generic ${arg.origin} API, tracked as kanban card ${arg.taskId}. When this work is finished, set that card's status to 'done' and fill its 'result' so the caller's status check reflects the outcome.)`,
        requires_reply: false
      }, 'webhook');
    } catch (e) {
      console.error('[webhook] could not route to god:', e instanceof Error ? e.message : e);
    }
  };
  // A temp answers instead when the endpoint says so. Its done reaches the
  // orchestrator, who closes the card; if no temp can start, the orchestrator
  // gets the job as before.
  const answer = parseAnswerer(arg.answer);
  if (answer.kind !== 'agent') {
    void hireTempForTrigger(answer, {
      objective: `${arg.message}\n\n(Inbound via the generic ${arg.origin} API, tracked as kanban card ${arg.taskId}. Put the outcome in your done message: the orchestrator records it on that card for the caller.)`,
      name: arg.title,
      source: `The ${arg.origin} message "${arg.title}"`
    }).then((ok) => { if (!ok) toGod(); }, () => toGod());
  } else {
    toGod();
  }
  return true;
}

/**
 * A verified POST, run through the endpoint's TriggerMode.
 *
 * `isAutoAllowed(mode, kind)` is the whole gate. When it says yes this behaves
 * exactly as the single-endpoint server always did — card, god request, capability
 * token. When it says no NOTHING reaches the hive: the message is written to the
 * ledger as `pending` and sits there until the operator decides, and the caller
 * is handed its token plus a 202 so it can watch the hold rather than believe
 * work started.
 *
 * Either way an `inbound` history row is recorded. The secret never reaches here
 * (the server hands over `{id,name}` only) and no credential is ever written to
 * the ledger.
 */
function handleWebhookMessage(msg: WebhookInbound, endpoint: WebhookEndpointRef): WebhookDispatch | null {
  // 192-bit unguessable token, returned once; only its hash is stored.
  const token = randomBytes(24).toString('hex');
  const tokenHash = hashWebhookToken(token);
  const full = msg.title ?? msg.message;
  const title = full.length > 80 ? `${full.slice(0, 79)}…` : full;

  const trigger = (readConfig().webhookTriggers ?? []).find((t) => t.id === endpoint.id);
  // An endpoint that vanished between the request and this lookup falls back to
  // the STRICTEST mode, never the most permissive one.
  const mode: TriggerMode = trigger?.mode ?? DEFAULT_TRIGGER_MODE;
  // The caller's own declaration wins; `classifyInboundKind` is the conservative
  // guess for callers that don't declare (it leans 'directive' on purpose).
  const kind: InboundKind = msg.kind ?? classifyInboundKind(msg.message);
  const peer = msg.from?.trim() || endpoint.name || endpoint.id;
  // Minted here, not derived from the task id, because a HELD message has no task
  // id yet and must still be pairable with the reply it eventually earns.
  const correlationId = randomBytes(8).toString('hex');

  const base = {
    source: 'webhook' as const,
    sourceId: endpoint.id,
    sourceName: endpoint.name,
    direction: 'inbound' as const,
    peer,
    title,
    body: msg.message,
    kind,
    correlationId
  };

  if (!isAutoAllowed(mode, kind)) {
    const entry = appendTriggerHistory({ ...base, decision: 'pending' });
    heldTokens().set(tokenHash, entry.id);
    persistHeldTokens();
    notifyTriggerHistoryUpdated();
    return { token, pending: true };
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  if (!dispatchWebhookWork({ taskId, title, message: msg.message, tokenHash, origin: 'webhook', answer: trigger?.answer })) return null;
  appendTriggerHistory({ ...base, decision: 'auto-allowed', taskId });
  notifyTriggerHistoryUpdated();
  return { token, taskId, pending: false };
}

/** Resolve a capability token to its task's public status — scoped to the ONE
 *  card (or the ONE held message) whose stored hash matches; never lists or leaks
 *  any other task. Returns null for any non-match (the server answers 404 either
 *  way, so a probe can't tell "unknown" from "malformed"). */
function lookupWebhookStatus(token: string): WebhookTaskStatus | null {
  const hash = hashWebhookToken(token);

  // Held messages first — they have no card, and the O(1) hit keeps the common
  // "still waiting" poll off the task scan entirely.
  const heldEntryId = heldTokens().get(hash);
  if (heldEntryId) {
    const entry = listTriggerHistory().find((e) => e.id === heldEntryId);
    if (!entry) { heldTokens().delete(hash); persistHeldTokens(); return null; }
    if (entry.decision === 'pending') {
      return { status: 'awaiting-approval', title: entry.title ?? '' };
    }
    if (entry.decision === 'rejected') {
      return { status: 'rejected', title: entry.title ?? '' };
    }
    // Approved: the release stamped this hash onto a real card, so fall through.
  }

  const wanted = Buffer.from(hash);
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return null; }
  for (const t of tasks) {
    const h = t.webhook?.tokenHash;
    if (!h) continue;
    const have = Buffer.from(h);
    // Both are fixed-length sha-256 hex; compare in constant time defensively.
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) {
      return { status: t.status, title: t.title, result: t.result };
    }
  }
  return null;
}

// ─── Webhook done-observer (the OUTBOUND half of the trigger ledger) ─────────
// Mirrors `pollSlackDoneTasks`: watch the kanban for webhook-origin cards that
// reach 'done' and write the reply side of the conversation, tagged with the
// inbound row's correlationId so the UI can pair request ↔ response.
//
// Unlike the Slack poller there is no "baseline" of already-done ids: the LEDGER
// is the record of what we've already paired, so a card that finished while the
// app was closed still gets its outbound row on the next boot, and re-seeding
// from the ledger makes a duplicate impossible.
let webhookDoneTimer: ReturnType<typeof setInterval> | null = null;
let webhookOutboundRecorded: Set<string> | null = null;

function seedWebhookOutbound(): Set<string> {
  const seen = new Set<string>();
  try {
    for (const e of listTriggerHistory()) {
      if (e.direction === 'outbound' && e.taskId) seen.add(e.taskId);
    }
  } catch { /* unreadable ledger → treat as empty; appends are still deduped by taskId */ }
  return seen;
}

function pollWebhookDoneTasks(): void {
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick
  const done = tasks.filter((t) =>
    t.status === 'done' && (t.webhook != null || t.id.startsWith('webhook-')));
  if (done.length === 0) return;
  const recorded = webhookOutboundRecorded ?? (webhookOutboundRecorded = seedWebhookOutbound());
  const fresh = done.filter((t) => !recorded.has(t.id));
  if (fresh.length === 0) return;

  const history = listTriggerHistory();
  let wrote = false;
  for (const t of fresh) {
    const inbound = history.find((e) => e.direction === 'inbound' && e.taskId === t.id);
    // No inbound row = a card from before the ledger existed. Nothing to pair it
    // with, so mark it handled rather than writing a half of a conversation.
    if (!inbound) { recorded.add(t.id); continue; }
    appendTriggerHistory({
      source: inbound.source,
      sourceId: inbound.sourceId,
      sourceName: inbound.sourceName,
      direction: 'outbound',
      peer: inbound.peer,
      title: t.title,
      body: (t.result ?? '').trim() || '(finished with no result recorded)',
      kind: inbound.kind,
      correlationId: inbound.correlationId,
      taskId: t.id
    });
    recorded.add(t.id);
    wrote = true;
  }
  if (wrote) notifyTriggerHistoryUpdated();
}

/** Begin watching the kanban for webhook-origin done-transitions (idempotent). */
function startWebhookDoneObserver(): void {
  if (webhookDoneTimer) return;
  webhookOutboundRecorded = seedWebhookOutbound();
  webhookDoneTimer = setInterval(() => {
    try { pollWebhookDoneTasks(); } catch (e) { console.error('[webhook] done-observer:', e); }
  }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopWebhookDoneObserver(): void {
  if (webhookDoneTimer) { clearInterval(webhookDoneTimer); webhookDoneTimer = null; }
  webhookOutboundRecorded = null;
}

/** Build the shared WebhookServer from the enabled endpoints and start it. A
 *  server that is already up is RE-POINTED rather than restarted (see
 *  `reconcileWebhookServer`): restarting would mint a fresh tunnel URL and break
 *  every other endpoint's caller. The public tunnel is opened only here — never
 *  on a default; a webhook reaches the wire only once the operator enables it. */
async function startWebhookServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) return { ok: false, error: 'no enabled webhook endpoints' };
  if (webhookServer) {
    webhookServer.setEndpoints(endpoints);
    return { ok: true, url: webhookServer.publicUrl() ?? lastWebhookUrl };
  }
  pruneHeldTokens();
  const cfg = readConfig();
  const server = new WebhookServer({
    port: cfg.webhookPort && cfg.webhookPort > 0 ? cfg.webhookPort : WEBHOOK_DEFAULT_PORT,
    endpoints,
    onMessage: handleWebhookMessage,
    lookupStatus: lookupWebhookStatus
  });
  webhookServer = server;
  const res = await server.start();
  // ok:false covers BOTH "never bound the port" (fatal → drop the instance) and
  // "bound fine, tunnel unavailable" (the security boundary is live and must stay
  // reachable/stoppable — dropping it there would leak an unstoppable listener).
  if (!res.ok && !server.listening()) { webhookServer = null; return res; }
  analytics.trackFeature('webhook_trigger');
  if (res.url) lastWebhookUrl = res.url;
  startWebhookDoneObserver();
  return res;
}

/** Bring the running server in line with config after any webhook mutation.
 *  Live endpoint swap when it's up, start when the enabled set becomes non-empty,
 *  stop when it empties. Never restarts a healthy server. */
function reconcileWebhookServer(): void {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) { stopWebhookServer(); return; }
  if (webhookServer) { webhookServer.setEndpoints(endpoints); return; }
  void startWebhookServer().then((r) => {
    if (!r.ok) console.error('[webhook] start failed:', r.error);
    else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
  });
}

/** Per-endpoint public URLs for the settings surface's copy button. Empty string
 *  when no tunnel has ever come up — the UI shows the endpoint, just not a URL
 *  it could hand out yet. */
function webhookEndpointUrls(): { id: string; url: string }[] {
  const base = (webhookServer?.publicUrl() ?? lastWebhookUrl ?? '').replace(/\/+$/, '');
  return (readConfig().webhookTriggers ?? []).map((t) => ({
    id: t.id,
    url: base ? `${base}/${encodeURIComponent(t.id)}` : ''
  }));
}

/** Stop and forget the webhook server. Best-effort; safe when not running. The
 *  last tunnel URL is retained so Settings keeps showing it. */
function stopWebhookServer(): void {
  try { webhookServer?.stop(); } catch (e) { console.error('[webhook] stop failed:', e); }
  webhookServer = null;
  // The done-observer deliberately OUTLIVES the server (it is a ledger concern,
  // not a transport one) — it is torn down with the process/hive, not here.
}

/** The persisted main-window geometry (kv key `window.bounds`). */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** Validate + clamp restored bounds: enforce the minimum size, and drop a
 *  position that no longer lands on any connected display (monitor unplugged) so
 *  the window can't open off-screen. Returns null for unusable input. */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // Keep the position only if the window rect overlaps some display's work area.
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** Minimal trailing-edge debounce for the move/resize flood. */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

/** Cascade a new floor off the focused window so it doesn't stack exactly on
 *  top, clamped on-screen (clampBounds drops an off-display position). */
function floorCascade(): WindowBounds | null {
  const base = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow
    : [...allWindows].find((w) => !w.isDestroyed());
  if (!base) return null;
  const b = base.getBounds();
  const OFFSET = 36;
  return clampBounds({ x: b.x + OFFSET, y: b.y + OFFSET, width: b.width, height: b.height });
}

// ─── Shareable hires: munderdifflin:// deep link + file import ──────────────
// A hire manifest NEVER auto-spawns: it is validated, then handed to the
// renderer, which pre-fills the Add-Agent modal for human review. See
// src/shared/hire.ts for the spec + security model.

/** Manifests that arrived before the renderer was ready to receive them.
 *  The renderer PULLS these via hire:drainPending once its subscription is
 *  mounted — main never pushes blind, so a fast-loading packaged renderer
 *  can't lose a deep link to a startup race. */
const pendingHires: HireManifest[] = [];
let rendererReadyForHires = false;

function deliverHire(manifest: HireManifest): void {
  if (rendererReadyForHires && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('hire:import', manifest);
  } else {
    pendingHires.push(manifest);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

/**
 * The orchestrator may propose a permanent hire by writing a manifest into
 * research/hires/ (in the hive, or the office). Its prompt has always said
 * the human confirms it in the UI, but nothing looked there, so the
 * proposal sat unseen. Each one now opens the Add-Agent review, prefilled.
 */
// Task history (shared/taskHistory.ts): the orchestrator rewrites tasks.json
// whole, so who moved which card, and when, was never kept. Each tick compares
// the ledger with the last read and appends the difference to
// taskHistory.jsonl. The last read is kept on disk too, so a change made while
// the app was closed is still recorded (dated when the app sees it).
const TASK_HISTORY_EVERY_MS = 5000;
let taskHistoryAt = 0;
let taskHistoryState: { root: string; snapshot: TaskSnapshot[] | null; raw: string } | null = null;
function recordTaskHistory(): void {
  const now = Date.now();
  if (now - taskHistoryAt < TASK_HISTORY_EVERY_MS) return;
  taskHistoryAt = now;
  const root = hive.enabled() ? hive.root() : null;
  if (!root) return;
  let raw = '';
  try { raw = readFileSync(join(root, 'tasks.json'), 'utf8'); } catch { return; }
  const snapPath = join(root, 'taskHistory.snapshot.json');
  if (!taskHistoryState || taskHistoryState.root !== root) {
    let snapshot: TaskSnapshot[] | null = null;
    try { snapshot = JSON.parse(readFileSync(snapPath, 'utf8')) as TaskSnapshot[]; } catch { /* first run */ }
    taskHistoryState = { root, snapshot: Array.isArray(snapshot) ? snapshot : null, raw: '' };
  }
  if (raw === taskHistoryState.raw) return;
  let list: unknown[] = [];
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown } | unknown[];
    list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  } catch { return; } // mid-write: try again next tick
  const next = list.map(snapshotOf).filter((t): t is TaskSnapshot => !!t);
  const events = diffTasks(taskHistoryState.snapshot, next, new Date(now).toISOString());
  try { noteLedgerForWorkSwitch(taskHistoryState.snapshot, next); } catch (e) { console.error('[work-switch] ledger:', e); }
  try {
    if (events.length) appendFileSync(join(root, 'taskHistory.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(snapPath, JSON.stringify(next));
    taskHistoryState = { root, snapshot: next, raw };
  } catch (e) { console.error('[tasks] could not record history:', e); }
}

// Clear on a switch of work (main/workSwitch.ts). The ledger reading above is
// the signal; the queue (renderer drain) is the only way anything is typed.
let workSwitchCurrent: Record<string, string> = {};
let workSwitchTasks: TaskSnapshot[] = [];
const workSwitch = new WorkSwitchClearer({
  now: () => Date.now(),
  rule: () => readConfig().contextTrigger?.workSwitch ?? DEFAULT_CONTEXT_TRIGGER.workSwitch,
  agent: (id) => {
    if (!hive.enabled() || !ptyForAgent(id)) return null;
    const a = hive.registry().agents[id];
    if (!a || a.archived) return null;
    const provider = a.provider ?? 'claude';
    return {
      name: a.name ?? id,
      isGod: a.isGod || id === hive.registry().godId,
      isAssistant: a.isAssistant,
      canWriteHandoff: canReceiveInbox(provider),
      clearCommand: clearCommandForProvider(provider, contextRule('clear').message)
    };
  },
  handoffPath: (id) => {
    const host = join(hive.agentFolder(id), 'handoff.md');
    return { host, agent: hive.forAgent(host) };
  },
  inboxPath: (id) => hive.forAgent(join(hive.agentFolder(id), 'inbox')),
  standingPath: (id) => {
    const a = hive.registry().agents[id];
    // Claude's hive instructions ride in its system prompt and survive a clear;
    // the other engines got them as their first prompt (session-prompt.md).
    if (!a || isHiveAwareProvider(a.provider)) return undefined;
    const host = join(hive.agentFolder(id), 'session-prompt.md');
    return existsSync(host) ? hive.forAgent(host) : undefined;
  },
  fileMtime: (p) => { try { return statSync(p).mtimeMs; } catch { return null; } },
  writeFile: (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, hive.forAgent(text), 'utf8'); },
  busyReason: (id) => {
    if (readPending().some((x) => x.from === id)) return 'waiting for the human\'s sign-off';
    if (hive.outbox(id).length) return 'outbox not sent yet';
    if (isCustodian(criticalMap(), id)) {
      try { if (readdirSync(join(hive.agentFolder(id), 'outgoing')).length) return 'outgoing files not taken in yet'; } catch { /* none */ }
    }
    return null;
  },
  task: (taskId) => workSwitchTasks.find((t) => t.id === taskId),
  taskHistory: (taskId) => {
    const root = hive.root();
    if (!root) return [];
    let lines: string[] = [];
    try { lines = readFileSync(join(root, 'taskHistory.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
    const out: string[] = [];
    for (const l of lines) {
      try {
        const e = JSON.parse(l) as TaskEvent;
        if (e.taskId !== taskId) continue;
        const what = e.kind === 'status' ? `status ${e.from ?? '?'} → ${e.to ?? '?'}`
          : e.kind === 'assigned' ? `assigned ${e.from ?? '-'} → ${e.to ?? '-'}`
          : e.kind === 'asked' ? `asked the human: ${e.q}`
          : e.kind === 'answered' ? `the human answered: ${e.a}`
          : e.kind === 'result' ? `result: ${e.text}`
          : e.kind;
        out.push(`${e.ts}: ${what}`);
      } catch { /* torn line */ }
    }
    return out;
  },
  terminalTail: (id) => { const p = ptyForAgent(id); return p ? terminalTail(ptyManager.tail(p), 15, 1500) : ''; },
  recentlyFiled: (id, since) => {
    const dir = join(hive.agentFolder(id), 'inbox', '.done');
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
    return names
      .map((n) => { try { return { n, m: statSync(join(dir, n)).mtimeMs }; } catch { return null; } })
      .filter((x): x is { n: string; m: number } => !!x && x.m >= since)
      .sort((a, b) => b.m - a.m)
      .map((x) => hive.forAgent(join(dir, x.n)));
  },
  enqueue: (agentId, text) => { try { liveWebContents()?.send('workSwitch:queue', { agentId, text, op: 'enqueue' }); } catch { /* window gone */ } },
  withdraw: (agentId, text) => { try { liveWebContents()?.send('workSwitch:queue', { agentId, text, op: 'withdraw' }); } catch { /* window gone */ } },
  holdNudges: (agentId, on) => { try { liveWebContents()?.send('workSwitch:queue', { agentId, text: '', op: on ? 'hold' : 'release' }); } catch { /* window gone */ } },
  log: (line) => console.log(line)
});
setInterval(() => { try { workSwitch.tick(); } catch (e) { console.error('[work-switch] tick:', e); } }, 5000).unref?.();

/** One new reading of the ledger: who moved to different work. */
function noteLedgerForWorkSwitch(prev: TaskSnapshot[] | null, next: TaskSnapshot[]): void {
  workSwitchTasks = next;
  if (!hive.enabled()) return;
  const agents = hive.registry().agents;
  const byName = new Map(Object.values(agents).filter((a) => !a.archived && a.name).map((a) => [a.name.toLowerCase(), a.id]));
  const r = detectWorkSwitches(workSwitchCurrent, prev, next, (who) => (agents[who] ? who : byName.get(who.toLowerCase()) ?? null));
  workSwitchCurrent = r.current;
  if (r.switches.length) workSwitch.onSwitches(r.switches);
}

ipcMain.handle('hive:taskHistory', (_evt, taskId: unknown, limit: unknown) => {
  const root = hive.enabled() ? hive.root() : null;
  if (!root) return [];
  let lines: string[] = [];
  try { lines = readFileSync(join(root, 'taskHistory.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const max = typeof limit === 'number' && limit > 0 ? Math.min(5000, Math.round(limit)) : 500;
  const out: TaskEvent[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    try {
      const e = JSON.parse(lines[i]) as TaskEvent;
      if (typeof taskId !== 'string' || e.taskId === taskId) out.push(e);
    } catch { /* torn line */ }
  }
  return out.reverse();
});

/** A local manifest's folder as this machine opens it, the same way a worker
 *  request's is (spawn-requests): a WSL floor's orchestrator writes Linux
 *  paths, so they go through \\wsl.localhost; a network path is dropped (even
 *  checking that it exists makes Windows offer the user's NTLM hash). */
function localHireCwd(m: HireManifest): HireManifest {
  if (!m.cwd) return m;
  const floorWsl = hive.wslRoot();
  const cwd = floorWsl ? fromLinuxPath(m.cwd, floorWsl.distro, () => distroHomeUnc(floorWsl.distro)) : m.cwd;
  if (!uncAllowed(cwd)) return { ...m, cwd: undefined };
  return { ...m, cwd };
}

/** reviewToken → the research/hires/ file an offered manifest came from. */
const offeredHireSources = new Map<string, { dir: string; file: string }>();
/** Manifests the human closed without deciding: back in research/hires/, not
 *  offered again until the next launch (or the review would pop right back). */
const deferredHireFiles = new Set<string>();
// Checked every 5 s rather than every worker tick (1.5 s): each look is a
// directory read, which on a WSL office crosses \\wsl.localhost.
let hiresCheckedAt = 0;
function offerOrchestratorHires(): void {
  const now = Date.now();
  if (now - hiresCheckedAt < 5000) return;
  hiresCheckedAt = now;
  const root = hive.root();
  const home = readConfig().harnessHome;
  const dirs = [root ? join(root, 'research', 'hires') : null, home ? join(home, 'research', 'hires') : null]
    .filter((d): d is string => !!d && existsSync(d));
  if (!dirs.length) return;
  const { offered, sources, invalid } = collectHireManifests(dirs, deferredHireFiles);
  offered.forEach((m, i) => {
    const reviewToken = randomUUID();
    offeredHireSources.set(reviewToken, sources[i]);
    deliverHire({ ...localHireCwd(m), reviewToken });
  });
  for (const bad of invalid) {
    informGod('[hire manifest rejected]', `research/hires/${bad.file} is not a valid hire manifest: ${bad.error}`);
  }
}

async function handleHireLink(link: string): Promise<void> {
  const src = parseHireDeepLink(link);
  if (!src) { console.warn('[hire] ignoring malformed deep link'); return; }
  const res = await fetchHireManifest(src);
  if (!res.ok) {
    console.error('[hire] deep link rejected:', res.error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hire:error', { error: res.error });
    }
    return;
  }
  // A remote manifest never picks a folder on this disk or a session to resume.
  deliverHire({ ...res.manifest, cwd: undefined, sessionId: undefined });
  analytics.trackFeature('hire_install');
}

// Register the protocol. In dev (electron .) Windows needs the explicit
// exe+args form or the registration points at electron.exe with no entry.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('munderdifflin', process.execPath, [resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('munderdifflin');
}

// Deep links on Windows/Linux arrive as the argv of a SECOND process — take the
// single-instance lock and forward them to the running instance. (macOS gets
// the 'open-url' event instead.) The lock also rules out two harnesses fighting
// over the same hive, which was previously possible but never useful.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  allowQuit = true;
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const link = argv.find((a) => a.startsWith('munderdifflin://'));
    if (link) void handleHireLink(link);
  });
}

app.on('open-url', (evt, url) => {
  evt.preventDefault();
  void handleHireLink(url);
});

// IPC: the renderer signals readiness and PULLS anything queued (deep links
// that arrived before the window/subscription existed, incl. cold starts).
ipcMain.handle('hire:drainPending', () => {
  rendererReadyForHires = true;
  const out = pendingHires.splice(0, pendingHires.length);
  return out;
});

// IPC: the human closed the review with research/hires/ manifests still
// unreviewed. Put them back, so they are offered again on the next launch
// instead of sitting in .offered/ where nobody looks.
ipcMain.handle('hire:defer', (_evt, tokens: unknown) => {
  if (!Array.isArray(tokens)) return;
  for (const t of tokens) {
    if (typeof t !== 'string') continue;
    const src = offeredHireSources.get(t);
    if (!src) continue;
    offeredHireSources.delete(t);
    const restored = restoreOfferedHire(src.dir, src.file);
    if (restored) deferredHireFiles.add(restored);
  }
});
// IPC: a research/hires/ manifest was spawned or skipped: forget its token.
ipcMain.handle('hire:reviewed', (_evt, token: unknown) => {
  if (typeof token === 'string') offeredHireSources.delete(token);
});

// IPC: "import hires…" file picker in the Add-Agent modal. Every selected file
// is validated independently; valid neighbours survive an invalid manifest.
ipcMain.handle('hire:openFile', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Import hire manifests',
    filters: [{ name: 'Hire manifest', extensions: ['json'] }],
    properties: ['openFile', 'multiSelections']
  });
  refocusAfterDialog(mainWindow);
  if (res.canceled || res.filePaths.length === 0) {
    return { ok: false, manifests: [], errors: [], error: 'cancelled' };
  }
  const batch = readHireManifestFiles(res.filePaths);
  return {
    ok: batch.manifests.length > 0,
    ...batch,
    manifests: batch.manifests.map(localHireCwd),
    error: batch.manifests.length === 0 ? 'no valid hire manifests selected' : undefined
  };
});

/**
 * Create a window. The PRIMARY window (no opts) restores saved geometry, uses
 * the default session, runs the hive, and keeps the existing app-quit warning.
 * A FLOOR window (`{ floor: true }`) gets its own persistent session partition
 * — isolating its renderer state (agents/queues/selection) from every other
 * window — cascades its position, and on close stops only its OWN terminals
 * while the app keeps running.
 */
function createWindow(opts: { floor?: boolean } = {}): BrowserWindow {
  const isFloor = opts.floor === true;

  // Primary restores saved geometry; floors cascade off the focused window.
  let saved: WindowBounds | null = null;
  if (!isFloor) { try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; } }
  const cascade = isFloor ? floorCascade() : null;
  const geom = cascade ?? saved;

  const win = new BrowserWindow({
    width: geom?.width ?? DEFAULT_WIN.width,
    height: geom?.height ?? DEFAULT_WIN.height,
    ...(geom && geom.x !== undefined && geom.y !== undefined ? { x: geom.x, y: geom.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: windowTitle(),
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Tells the preload (and so the renderer) that no one is looking: skip
      // the launch picker, never pop anything up.
      // --md-lang: the language to start in when this profile's own storage has
      // none yet (a new floor), so it does not open in English.
      additionalArguments: [...(HEADLESS ? ['--md-headless'] : []), ...(readConfig().uiLanguage ? [`--md-lang=${readConfig().uiLanguage}`] : [])],
      // Keep Chromium's OS renderer sandbox active; privileged work stays behind
      // the narrow contextBridge/IPC surface owned by the main process.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs the hive's heartbeat loops (inbox nudge, message
      // flush, telemetry polls). Chromium throttles timers in occluded windows
      // — incl. behind the LOCK SCREEN — which silently stalls the hive while
      // the user is away. Don't.
      backgroundThrottling: false,
      // Each floor gets its OWN persistent session partition → isolated
      // localStorage so floors never share or stomp each other's office state.
      // The primary keeps the DEFAULT session so existing persisted state loads.
      ...(isFloor ? { partition: `persist:floor-${++floorSeq}` } : {})
    }
  });

  // Capture the webContents once: after 'closed' the window is gone, but this
  // reference stays valid as the per-PTY ownership key.
  const wc = win.webContents;
  // Each floor has its own session: each serves deliverables itself.
  serveDeliverables(wc.session);
  // A deliverable's page (an iframe in Deliverables) moves only inside its own
  // folder; a web link in it opens in the browser instead of inside the app.
  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame || !e.frame?.url.startsWith(`${DELIVERABLE_SCHEME}:`) || e.url.startsWith(`${DELIVERABLE_SCHEME}:`)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(e.url)) void shell.openExternal(e.url);
  });
  // The title names the office, so floors tell apart in the taskbar and Task
  // Manager; the page's own <title> would overwrite it.
  win.on('page-title-updated', (e) => e.preventDefault());

  allWindows.add(win);
  // Global timer events follow the user — the most-recently-focused window is
  // primary. The primary is also seeded synchronously so boot events route now.
  win.on('focus', () => { mainWindow = win; });
  if (!isFloor) mainWindow = win;

  // Permission gate for the renderer (our own trusted, local content). The only
  // permission we constrain is microphone capture: it's allowed ONLY while a mic
  // feature is actually live — Free Flow dictation (`freeflowEnabled`) OR a
  // Realtime Michael voice session (`realtimeVoiceEnabled`, flipped on by the
  // session at start() before getUserMedia, off at stop()). With both flags off,
  // there's zero mic access even at the Electron layer. We deliberately do NOT
  // gate on OpenAI-key presence: that key (`apikey:openai`) is shared with the CLI
  // engines, so a CLI-only user must not have the mic gate opened. Every other
  // permission keeps the app's prior permissive behavior (e.g. clipboard for
  // xterm/editor copy must keep working).
  const micFeatureLive = (): boolean => {
    const cfg = readConfig();
    return cfg.freeflowEnabled === true || cfg.realtimeVoiceEnabled === true;
  };
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const mediaTypes = details && 'mediaTypes' in details ? details.mediaTypes : undefined;
      const wantsAudio = !mediaTypes || mediaTypes.includes('audio');
      callback(micFeatureLive() && wantsAudio);
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return micFeatureLive();
    return true;
  });

  // Only the primary persists geometry (kv `window.bounds`); floors cascade
  // fresh each launch. Skip while maximized/minimized so a restore doesn't save
  // the fullscreen rect.
  if (!isFloor) {
    const saveBounds = debounce(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    }, 400);
    win.on('resized', saveBounds);
    win.on('moved', saveBounds);
    win.on('close', () => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    });
  }


  // Headless: the window exists (the renderer runs the floor) but is never shown.
  win.once('ready-to-show', () => { if (!HEADLESS) win.show(); });

  // Never opens a window; hands the URL to the OS browser instead.
  //
  // Scheme-checked, because this is now reachable from AUTHOR-CONTROLLED markup:
  // a release drop's iframe has `allow-popups`, so a target="_blank" link in a
  // release body arrives here. http(s) only — an unguarded openExternal will
  // happily launch file://, or a registered custom scheme, on the user's machine.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Close interception when live PTYs exist. The red-X destroys the window;
  // intercept it the same way before-quit does so PTY users aren't surprised.
  win.on('close', (e) => {
    if (allowQuit) return;
    if (isFloor) {
      // A floor's close is NOT an app quit — confirm only its OWN terminals,
      // via a self-contained native dialog (no renderer modal). Confirming lets
      // the window close; its PTYs are stopped in the 'closed' handler.
      const owned = ptyManager.countByOwner(wc);
      if (owned > 0) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Close floor', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Close this floor? ${owned} running terminal${owned === 1 ? '' : 's'} on it will be stopped.`,
          detail: 'Other floors keep running.'
        });
        if (choice === 1) { e.preventDefault(); refocusAfterDialog(win); }
      }
      return;
    }
    // Primary window: existing app-wide quit warning (renderer modal).
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    wc.send('app:closeRequested', { ptyCount: count });
  });

  // The primary is the default PTY sink; floors route purely by per-PTY owner.
  if (!isFloor) ptyManager.attachWebContents(wc);

  // A main-frame reload unmounts the renderer's hire subscription — queue again
  // until the fresh renderer drains. Guard on isMainFrame: a stray sub-frame
  // navigation must NOT flip readiness off (the renderer only drains on mount,
  // so a later deep link would otherwise queue and sit until a full reload).
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) rendererReadyForHires = false;
  });
  // The preload (window.cth: spawn, fs, git…) runs in whatever the main frame
  // shows, so it must only ever show the app. A dropped link or .html file, or
  // a page an agent wrote, would otherwise navigate here and get it. Web links
  // open in the browser instead.
  const sameApp = (url: string): boolean => {
    const strip = (u: string): string => u.replace(/[?#].*$/, '');
    return strip(url) === strip(wc.getURL());
  };
  const guardNavigation = (e: Electron.Event, url: string): void => {
    if (sameApp(url)) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    allWindows.delete(win);
    // A closed floor must not leave its terminals running headless. (Natural
    // onExit teardown — archive + worktree cleanup — still runs per PTY.)
    if (isFloor) { try { ptyManager.killByOwner(wc); } catch { /* best-effort */ } }
    if (mainWindow === win) {
      mainWindow = null;
      for (const w of allWindows) { if (!w.isDestroyed()) { mainWindow = w; break; } }
    }
    syncKeepAwake();
  });

  return win;
}

/** Open a new floor window — gated by the multiWindow flag. Returns the window,
 *  or null when the feature is off (the entry points are hidden in that case,
 *  but the IPC stays defensive). */
/** "Scranton Branch — <office>", or just the app's name before one is open. */
function windowTitle(): string {
  const office = readConfig().harnessHome;
  return office ? `${APP_NAME} — ${basename(office)}` : APP_NAME;
}

/** New Floor: another office, run by its own copy of the app (floorProfile.ts).
 *  It starts from these settings and keys and opens on the office picker.
 *  With an id (or null, the main profile) it reopens a floor that exists; if
 *  that floor is already running, its own single-instance lock hands the
 *  launch to it and it comes to the front. */
function openFloor(existing?: string | null): boolean {
  if (!readConfig().multiWindow) return false;
  const id = existing === undefined ? randomBytes(5).toString('hex') : existing;
  if (id === FLOOR_ID) { mainWindow?.focus(); return true; }
  try {
    if (existing === undefined && id) seedFloor(id);
    const child = spawn(process.execPath, floorArgs(process.argv, id), { detached: true, stdio: 'ignore', env: process.env });
    child.on('error', (e) => console.error('[floor] could not start:', e));
    child.unref();
    // The Open Floor list gains it (and, a moment later, its office).
    setTimeout(() => { refreshAppMenu(); }, 4000);
    return true;
  } catch (e) {
    console.error('[floor] could not start:', e);
    return false;
  }
}

ipcMain.handle('floors:list', () => listFloors(BASE_USER_DATA, FLOOR_ID));
ipcMain.handle('floors:open', (_evt, id: unknown) =>
  ({ ok: openFloor(typeof id === 'string' && /^[0-9a-f]{6,32}$/.test(id) ? id : id === null ? null : undefined) }));
ipcMain.handle('floors:remove', (_evt, id: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'unknown floor' };
  const r = removeFloor(BASE_USER_DATA, id, FLOOR_ID);
  if (r.ok) refreshAppMenu();
  return r;
});
// The renderer's language: the menu is rebuilt in it, and new floors start in it.
ipcMain.handle('app:uiLanguage', (_evt, lng: unknown) => {
  if ((lng === 'en' || lng === 'es') && readConfig().uiLanguage !== lng) {
    writeConfig({ uiLanguage: lng });
    refreshAppMenu();
  }
});

let appMenuInstalled = false;
function refreshAppMenu(): void { if (appMenuInstalled) installAppMenu(); }

/** Build + install the application menu. Only called when multiWindow is on, so
 *  flag-off keeps Electron's default menu (zero behavior change). Uses standard
 *  role-based items so copy/paste/quit/etc. work per-platform, and adds the
 *  "New Floor" item (Cmd/Ctrl+Shift+N). */
function installAppMenu(): void {
  appMenuInstalled = true;
  const isMac = process.platform === 'darwin';
  const m = menuText(readConfig().uiLanguage);
  const newFloorItem = {
    label: m.newFloor,
    accelerator: 'CmdOrCtrl+Shift+N',
    click: () => { openFloor(); }
  };
  const others = listFloors(BASE_USER_DATA, FLOOR_ID).filter((f) => !f.current);
  const openFloorItem: Electron.MenuItemConstructorOptions = {
    label: m.openFloor,
    submenu: others.length
      ? others.map((f) => ({
          label: `${f.id === null ? m.mainFloor : f.name ?? m.noOffice}${f.id === null && f.name ? ` · ${f.name}` : ''}${f.running ? `  (${m.running})` : ''}`,
          click: () => { openFloor(f.id); }
        }))
      : [{ label: m.noOtherFloors, enabled: false }]
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: m.file,
      submenu: [newFloorItem, openFloorItem, { type: 'separator' as const }, isMac ? { role: 'close' as const, label: m.close } : { role: 'quit' as const, label: m.quit }]
    },
    // The Edit menu is spelled out rather than `{ role: 'editMenu' }` for one
    // reason: `registerAccelerator: false` on the clipboard items.
    //
    // A registered accelerator is claimed by the MENU, which then replays the
    // action through `webContents.paste()` — an async hop that runs a beat after
    // the keystroke. Dictation tools (Muesli, Wispr Flow, …) insert text by
    // stashing the clipboard, writing the transcript, sending the paste key, and
    // restoring the old clipboard immediately; the menu's late paste therefore
    // read the RESTORED clipboard and typed the user's previous copy instead of
    // what they had just said. It hit the terminal and the composer alike,
    // because both were downstream of the same replay.
    //
    // With registerAccelerator false the item still shows its shortcut, but the
    // key is left for the focused element to handle inline — xterm's own paste
    // handler and the textarea's native paste event both read the clipboard
    // synchronously, inside the keystroke, before any restore can land.
    {
      label: m.edit,
      submenu: [
        { role: 'undo' as const, label: m.undo, registerAccelerator: false },
        { role: 'redo' as const, label: m.redo, registerAccelerator: false },
        { type: 'separator' as const },
        { role: 'cut' as const, label: m.cut, registerAccelerator: false },
        { role: 'copy' as const, label: m.copy, registerAccelerator: false },
        { role: 'paste' as const, label: m.paste, registerAccelerator: false },
        { role: 'selectAll' as const, label: m.selectAll, registerAccelerator: false }
      ]
    },
    {
      label: m.view,
      submenu: [
        { role: 'reload' as const, label: m.reload },
        { role: 'forceReload' as const, label: m.forceReload },
        { role: 'toggleDevTools' as const, label: m.devTools },
        { type: 'separator' as const },
        { role: 'resetZoom' as const, label: m.resetZoom },
        { role: 'zoomIn' as const, label: m.zoomIn },
        { role: 'zoomOut' as const, label: m.zoomOut },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const, label: m.fullScreen }
      ]
    },
    {
      label: m.window,
      submenu: [
        { role: 'minimize' as const, label: m.minimize },
        { role: 'zoom' as const, label: m.zoom },
        { role: 'close' as const, label: m.close }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
/** Codex stores its rollout transcripts under a PER-AGENT CODEX_HOME
 *  (<hive>/agents/<id>/.codex/sessions/<Y>/<M>/<D>/rollout-*-<sessionId>.jsonl).
 *  A NEWLY added agent gets an empty CODEX_HOME, so `codex resume <sid>` finds
 *  nothing and silently opens a BLANK session — which is exactly what the Add
 *  Agent "resume session" field looked like it was doing. Find the agent whose
 *  CODEX_HOME owns this rollout and RETURN that home so the resumed agent can be
 *  pointed at it (the rollout AND its state_5.sqlite index live there together). */
function findCodexHomeForSession(sessionId: string, siblingsRoot: string): string | null {
  try {
    if (!sessionId || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(sessionId)) return null;
    let fallbackHome: string | null = null;
    // Walk each sibling agent's CODEX_HOME (<agent>/.codex) looking for the
    // rollout that owns this session. We RETURN that home rather than copy the
    // rollout out of it: Codex indexes sessions in its state_5.sqlite, so a lone
    // rollout file in a fresh home is invisible to `codex resume`. Pointing the
    // resumed agent at the OWNING home gives it the rollout AND the index.
    let agents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      agents = readdirSync(siblingsRoot, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
    } catch { return null; }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const home = join(siblingsRoot, a.name, '.codex');
      const sessions = join(home, 'sessions');
      if (!existsSync(sessions)) continue;
      const stack = [sessions];
      let hasRollout = false;
      while (stack.length && !hasRollout) {
        const d = stack.pop() as string;
        let ents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          ents = readdirSync(d, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch { continue; }
        for (const e of ents) {
          const pth = join(d, e.name);
          if (e.isDirectory()) stack.push(pth);
          else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) { hasRollout = true; break; }
        }
      }
      if (!hasRollout) continue;
      // Prefer the home whose Codex state DB actually INDEXES this session — a
      // fresh/seeded home may carry only a stray rollout copy (no index), which
      // `codex resume` can't open. Match the id as raw bytes in state_5.sqlite
      // (+ its WAL). Homes with the rollout but no index are a last-resort fallback.
      const idBuf = Buffer.from(sessionId);
      let indexed = false;
      for (const db of ['state_5.sqlite', 'state_5.sqlite-wal']) {
        try { if (readFileSync(join(home, db)).includes(idBuf)) { indexed = true; break; } } catch { /* no db */ }
      }
      if (indexed) return home;
      if (!fallbackHome) fallbackHome = home;
    }
    return fallbackHome;
  } catch (e) {
    console.error('[resume] findCodexHomeForSession failed:', e);
    return null;
  }
}

/** Spawn options shared by the `pty:spawn` IPC handler and the god-triggered
 *  ephemeral-worker watcher. */
type AgentSpawnOptions = SpawnOptions & { hive?: AgentMeta; temp?: boolean; isolate?: boolean; resume?: boolean; requireResume?: boolean; resumeSessionId?: string; provider?: AgentProvider; noAutoInstall?: boolean; reopen?: boolean };

/** Map a `ptyManager.spawn` failure string to the closed `agent_spawn_failed.reason`
 *  enum (analytics.ts). The two known strings come from PtyManager.spawn; anything
 *  else is a generic `spawn_error`. The raw message never leaves the machine — only
 *  the enum value does, per TELEMETRY.md. */
function spawnFailReason(error?: string): SpawnFailReason {
  if (error?.startsWith('cwd does not exist')) return 'cwd_missing';
  if (error?.includes('already exists')) return 'already_running';
  return 'spawn_error';
}

const spawnTurn = makeSpawnGate();
ipcMain.handle('pty:spawn', async (evt, opts: AgentSpawnOptions) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Record the spawning window as the PTY's owner so its output routes ONLY back
  // to that floor, then run the shared spawn core.
  const owner = BrowserWindow.fromWebContents(evt.sender)?.webContents ?? null;
  // A temp the orchestrator hired outlives an app restart as a temp (its hiring
  // is in the registry). Restore team used to bring it back as a regular agent
  // that nothing ever released: a finished temp sat on the roster for 3 days.
  // Now a finished one stays archived instead of being respawned (unless the
  // human reopens it by hand, which keeps it as a regular agent), and an
  // unfinished one goes back under the worker controller below.
  const tempId = opts.hive?.id;
  let temp: TempHiring | undefined;
  try { temp = tempId && hive.enabled() ? hive.registry().agents[tempId]?.temp : undefined; } catch { temp = undefined; }
  if (tempId && temp && workerDoneAt(tempId, temp.spawnedAt) !== null) {
    if (!opts.reopen) {
      hive.setArchived(tempId, true);
      console.log(`[worker] not restoring ${tempId}: it already signaled done`);
      return { ok: false, error: 'its job is done (a finished temp is archived, not restored)', finishedTemp: true };
    }
    hive.setTemp(tempId, null);
    temp = undefined;
  }
  // A start that never finishes used to leave the UI waiting forever (the
  // orchestrator never appeared, and nothing said why). Give up after 90 s
  // with the step it was stuck on; the core keeps its own log of steps.
  let timer: NodeJS.Timeout | undefined;
  const watchdog = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(() => {
      const at = spawnSteps.get(opts.id) ?? 'starting';
      console.error(`[spawn ${opts.id}] still not started after 90 s (at: ${at})`);
      resolve({ ok: false, error: `it did not start within 90 s (stuck at: ${at})` });
    }, 90_000);
  });
  // A temp given another agent's access gets it again from that agent, as it
  // is NOW: never more than its parent, even if the human narrowed the parent
  // while the app was closed.
  if (tempId && temp?.accessFrom) applyTempAccess(temp.accessFrom, tempId);
  try {
    // One at a time (spawnGate.ts): a team coming up no longer freezes the app.
    const res = await Promise.race([spawnTurn(() => spawnAgentCore(opts, owner)), watchdog]);
    if (res.ok && tempId && temp && !liveWorkers.has(tempId)) {
      // Tracked again: released on its done, reaped idle or over its cap, and
      // archived at teardown, measured from the ORIGINAL hiring.
      liveWorkers.set(tempId, {
        workerId: tempId, reqId: temp.reqId, name: opts.hive?.name, objective: temp.objective, slack: temp.slack,
        baseBranch: temp.baseBranch, spawnedAt: temp.spawnedAt, tokenCap: temp.tokenCap, ptyId: opts.id,
        ...(temp.hiredBy === 'agent' && temp.parent ? { parent: temp.parent } : {})
      });
      console.log(`[worker] restored temp ${tempId} is tracked again (pty ${opts.id})`);
    }
    return res;
  } finally {
    clearTimeout(timer);
    spawnStepsDone(opts.id);
  }
});

/** The step each agent start is on, for the watchdog and the log. */
const spawnSteps = new Map<string, string>();
/** When each start entered its current step. A step that took long goes to the
 *  freeze log, so a stall during a start names the step: an agent start froze
 *  the app for ~0.9 s on a real install and the log only said "pty:spawn". */
const spawnStepAt = new Map<string, number>();
function spawnStep(id: string, step: string): void {
  const now = performance.now();
  const prev = spawnSteps.get(id);
  const at = spawnStepAt.get(id);
  if (prev && at !== undefined) freezes.noteOp(`spawn: ${prev}`, now - at);
  spawnSteps.set(id, step);
  spawnStepAt.set(id, now);
  console.log(`[spawn ${id}] ${step}`);
}
function spawnStepsDone(id: string): void {
  spawnSteps.delete(id);
  spawnStepAt.delete(id);
}

/** Core agent-spawn logic — provider inference, the missing-CLI installer
 *  short-circuit, git-worktree isolation, hive provisioning, model/resume flags,
 *  and the final PTY spawn. Extracted VERBATIM from the `pty:spawn` IPC handler so
 *  it can ALSO be invoked by the god-triggered ephemeral-worker watcher (which has
 *  no renderer `evt`). `owner` is the window that should receive this PTY's output
 *  (null → the primary window). Behavior-identical to the prior inline handler. */
async function spawnAgentCore(opts: AgentSpawnOptions, owner: Electron.WebContents | null): Promise<{ ok: boolean; error?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; freshStart?: string; seedPrompt?: string }> {
  // ── cwd INGESTION — expand `~` exactly once, here ───────────────────────────
  // This is the single door every agent spawn comes through (`pty:spawn` IPC and
  // the god-triggered ephemeral-worker watcher), so it is where a user-typed
  // `~/dev/foo` becomes an absolute path. Only a shell expands `~`; Node treats it
  // as a literal dir, so without this every downstream existsSync/statSync fails
  // with `cwd does not exist`. Expanding BEFORE hive provisioning is what makes the
  // registry store an ABSOLUTE cwd (and `cwdValid: true`). The resolved value is
  // returned to the caller so the renderer records the same absolute path.
  // On a WSL floor a typed `/home/u/repo` or `~/repo` is a path inside the
  // distro (that is where its agents run), not on Windows.
  // A fresh timeline (the worker watcher also starts agents, without the IPC cleanup).
  spawnStepsDone(opts.id);
  spawnStep(opts.id, 'checking the command and folder');
  const floorWslIn = process.platform === 'win32' ? hive.wslRoot() : null;
  const ingest = (p: string): string => (floorWslIn && typeof p === 'string' && /^(\/|~(\/|$))/.test(p.trim())
    ? fromLinuxPath(p, floorWslIn.distro, () => distroHomeUnc(floorWslIn.distro))
    : expandTilde(p));
  opts.cwd = ingest(opts.cwd);
  if (opts.hive) opts.hive = { ...opts.hive, cwd: ingest(opts.hive.cwd) };
  // Which CLI is this? Explicit wins; else inferred from the binary
  // (claude/codex/grok/agy). Non-Claude providers skip every Claude-only spawn step
  // below. Persist the resolved provider onto opts (+ hive meta) so the registry
  // record and downstream provider-aware steps agree on one value.
  const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
  // A custodian works in its own hive folder, never in a project: nothing it
  // writes can land in shared code, and its transcripts get a folder of their own.
  if (opts.hive && hive.enabled() && canBeCustodian(provider, { osSandbox: await hive.sandboxAvailable() }) && isCustodian(criticalMap(), opts.hive.id)) {
    const own = hive.agentFolder(opts.hive.id);
    mkdirSync(own, { recursive: true });
    opts.cwd = own;
    opts.hive = { ...opts.hive, cwd: own };
    opts.isolate = false;
  }
  const claudeProvider = isClaudeProvider(provider);
  opts.provider = provider;
  if (opts.hive) opts.hive = { ...opts.hive, provider };
  // Activation-funnel entry (v0.4.6): every spawn REQUEST, so (attempted − spawned)
  // measures the fallout the whole rebuild exists to see. Gated on !noAutoInstall so
  // the missing-CLI relaunch (the only re-entry, index.ts install-exit handler) does
  // NOT double-count a single user attempt — it is the SAME attempt continuing.
  if (!opts.noAutoInstall) analytics.track('agent_spawn_attempted', { provider });
  // pi has no sandbox of its own. Where the app cannot build one (no bubblewrap,
  // or not Linux/WSL) and the human asked to refuse that (Settings → AI
  // providers), the agent is not started: its terminal says why and how to
  // install bubblewrap. Off (the default), it runs with the "Not sandboxed" badge.
  // Before the missing-CLI installer: no point installing a CLI that may not run.
  if (opts.hive && hive.enabled() && refusePiWithoutSandbox(provider, readConfig().piRequireSandbox, await hive.sandboxAvailable())) {
    const wslFloor = hive.wslRoot();
    const place: PiSandboxPlace = wslFloor ? 'wsl' : process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'mac' : 'windows';
    try { hive.appendLog({ kind: 'spawn-refused', agentId: opts.hive.id, reason: 'pi without an OS sandbox (piRequireSandbox)' }); } catch { /* log is best-effort */ }
    const res = ptyManager.spawn(
      { id: opts.id, cwd: opts.cwd, command: opts.command, cols: opts.cols, rows: opts.rows, shellScript: piNoSandboxScript(place, wslFloor?.distro) },
      owner
    );
    syncKeepAwake();
    return res;
  }
  // ── Missing engine CLI → run its installer visibly (pre-spawn) ───────────────
  // If the agent's engine binary (claude/codex/…) isn't installed, spawning it
  // just dies with "— process exited (code 1) —" and the user has no idea why.
  // Detect the absent binary BEFORE spawning and, in this SAME terminal, print a
  // banner + RUN the provider's install command so the user can watch it (and
  // complete any interactive sign-in). On a CLEAN install exit the PTY-exit handler
  // auto restart-and-continues — it re-runs THIS spawn (with noAutoInstall) so the
  // freshly-installed CLI launches in the SAME pty/window, no user click. STRICTLY
  // pre-spawn: a non-zero exit from a CLI that DID start never reaches here, so there
  // is no install loop; and the relaunch's noAutoInstall guarantees the installer
  // can't fire twice. Providers with no known installer get a manual hint only (and
  // are NOT armed for relaunch) — nothing arbitrary is ever auto-run. We short-circuit
  // BEFORE worktree/hive/Claude-flag setup: ptyToAgent + worktreePaths stay unset for
  // this id, so when the install PTY exits teardownPty is a harmless no-op (the agent
  // isn't archived and no worktree is torn down) before the relaunch takes over.
  {
    const bin = opts.command.trim().split(/\s+/)[0] || opts.command;
    const onWsl = process.platform === 'win32' && !!parseWslPath(opts.cwd);
    // Another agent is already installing this CLI: wait for it instead of
    // starting a second install over the same files.
    const inFlight = bin && !opts.noAutoInstall && !onWsl ? installsInFlight.get(bin) : undefined;
    if (inFlight) {
      spawnStep(opts.id, `waiting for ${bin} to finish installing`);
      await inFlight.done;
    }
    if (bin && !opts.noAutoInstall && !onWsl && !ptyManager.isCommandAvailable(bin)) {
      claimInstall(bin);
      // The installer commands are `npm install -g …`. Probe for npm the same way
      // we probe for the engine CLI, so a no-Node machine gets the node-free rung
      // (or an honest manual hint) instead of watching `npm: not found` scroll by.
      // An npm whose Node is BELOW the floor counts as unavailable: founder rule
      // (2026-08-07) is "their Node newer than ours → leave it alone; absent or
      // older → install the latest stable for them".
      const npmAvailable =
        ptyManager.isCommandAvailable('npm') &&
        nodeIsUsable(detectNodeVersion(ptyManager.commandPath('node')));
      // Only reach the network when we actually need to (npm missing/too old);
      // resolveNodeInstaller is timeout-bounded and returns null offline, which
      // simply drops the ladder to the native/manual rung.
      const nodeInstaller = npmAvailable ? null : await resolveNodeInstaller();
      const rung = chooseInstallRung(installInfoForProvider(provider), npmAvailable, nodeInstaller);
      const res = ptyManager.spawn(
        {
          id: opts.id,
          cwd: opts.cwd,
          command: bin,
          cols: opts.cols,
          rows: opts.rows,
          shellScript: buildMissingCliScript(bin, provider, npmAvailable, process.platform, nodeInstaller)
        },
        owner
      );
      // Arm auto restart-and-continue: when this installer PTY exits cleanly, the
      // exit handler re-runs the spawn so the just-installed CLI launches in place
      // (no user click). Only when an installer actually RAN (a provider with no
      // bundled installer just prints a manual hint and exits 0 — relaunching there
      // would spawn the still-missing binary and die) and the PTY actually started.
      // …keyed on the RUNG, not on `installCommand`: the manual rung prints a hint
      // and exits 0, and relaunching there would just respawn the still-missing
      // binary and die with the bare "process exited (code 1)" this whole path exists
      // to replace.
      // No installer running (manual hint, or the PTY failed): free the slot now.
      if (!(res.ok && rung.command)) finishInstall(bin);
      if (res.ok && rung.command) {
        pendingInstallRelaunch.set(opts.id, { opts, owner, bin, rung: rung.kind });
        // The auto-installer PTY is running; agent_install_finished on its exit says
        // whether it actually produced an agent (rung is non-manual here by construction).
        analytics.track('agent_install_started', { provider, rung: rung.kind });
      } else if (res.ok) {
        // Manual rung: the PTY only printed a hint (no installer to run, no relaunch
        // armed), so no agent will start. This is the Mode 2 case that used to send
        // NOTHING — an absent engine with no unattended install path.
        analytics.track('agent_spawn_failed', { provider, reason: 'cli_missing' });
      } else {
        // The install PTY itself failed to spawn (cwd gone, id clash, throw).
        analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
      }
      syncKeepAwake();
      return res;
    }
    // ── Engine CLI present, but this Node is too old for it ─────────────────────
    // Pi 1.x on Node 20 dies at startup with a SyntaxError and the worker is
    // archived with nothing but a stack trace. Same remedy as a missing Node:
    // install the current one visibly in this terminal, then relaunch in place.
    const minNode = providerPreset(provider).minNode;
    if (bin && minNode && !opts.noAutoInstall && !onWsl) {
      const have = detectNodeVersion(ptyManager.commandPath('node'));
      if (have && !nodeAtLeast(have, minNode)) {
        claimInstall(bin);
        const nodeInstaller = await resolveNodeInstaller();
        const rung = chooseInstallRung(installInfoForProvider(provider), false, nodeInstaller);
        const res = ptyManager.spawn(
          {
            id: opts.id, cwd: opts.cwd, command: bin, cols: opts.cols, rows: opts.rows,
            shellScript: buildMissingCliScript(bin, provider, false, process.platform, nodeInstaller, { have, need: minNode })
          },
          owner
        );
        if (res.ok && rung.command) pendingInstallRelaunch.set(opts.id, { opts, owner, bin, rung: rung.kind });
        else finishInstall(bin);
        syncKeepAwake();
        return res;
      }
    }
  }
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  // NOTE (tracked, not yet hardened): the restore flow passes isolate:false and
  // re-enters the existing worktree by cwd, so it never reaches here. But a stale
  // `isolate:true` recipe spawned against an already-existing worktree path would
  // make addWorktree below conflict (path/branch exists) and fall back to the base
  // cwd — reuse-existing-worktree handling here is the follow-up.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(readConfig().harnessHome ?? origCwd, 'worktrees');
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
          const deps = await linkWorktreeDeps(origCwd, wtPath);
          if (!deps.ok) console.error('[worktree] dependency link failed:', deps.error);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // Proxy-tier CLIs (qwen/crush) route their LLM traffic through a loopback sidecar
  // whose UPSTREAM is read from the preset's bridge.baseUrlEnv inside hive.ensureAgent.
  // For the local-LLM path, feed the user's configured base URL as that upstream so the
  // proxy forwards to their endpoint (Ollama/LM Studio/vLLM). Handed to ensureAgent
  // directly: it used to be set on process.env, which every agent spawned after it
  // inherited (and kept after the field was cleared). (Crush's baseUrlEnv is an inert sentinel used ONLY as this
  // upstream source; its real routing is the per-agent CRUSH_GLOBAL_CONFIG base_url.)
  const proxyUpstream = opts.hive && (provider === 'crush' || provider === 'qwen')
    ? readConfig().providerBaseUrls?.[provider]?.trim() || undefined
    : undefined;
  // Certificates (Settings → AI Engines): the CA bundle and/or "don't verify",
  // for every agent's HTTPS and for the qwen/crush proxy's upstream. An agent's
  // own env still wins.
  const tlsCfg = readConfig().tls;
  spawnStep(opts.id, 'certificates');
  const caBundle = tlsActive(tlsCfg) ? (await ensureCaBundle()).path : null;
  if (tlsActive(tlsCfg)) opts.env = { ...tlsEnv(tlsCfg, caBundle), ...(opts.env ?? {}) };
  const proxyTls = { caFile: caBundle ?? undefined, insecure: tlsCfg?.verify === false };
  // If the agent carries hive metadata, provision its workspace and add
  // provider-specific spawn injection. Non-Claude providers get shared AGENT_*
  // env only; Claude Code also gets prompt/settings hook args.
  // Protocol seed that must be TYPED into a bare TUI after boot (Crush —
  // seedDelivery:'type-into-tui') rather than passed on argv. Surfaced in the spawn
  // result so the renderer types it through the per-pty write-chain. (ondev-b)
  let seedPrompt: string | undefined;
  // Set when the agent's recorded session ran in another folder or role
  // (sessionResume.ts): a restore then starts fresh instead of resuming it.
  let freshReason: string | null = null;
  if (opts.hive && hive.enabled()) {
    // REST integrations for EVERY hive agent, not only god-hired temps: a broker
    // capability token keyed by this PTY id (teardownPty revokes it on exit),
    // unless the caller already granted one (the worker path does), plus the list
    // for its prompt. Before this only temps got a token, and no agent was ever
    // told how to use it.
    // Environment: PLAIN variables only (envVault.plainEnvFor); a value the
    // agent's own spawn already sets wins. Secrets never go in here.
    const plainEnv = envVault.plainEnvFor(opts.hive.id);
    opts.env = { ...plainEnv, ...(opts.env ?? {}) };
    // The connections this agent can really call, so its prompt names them: only
    // Claude Code has the gateway's MCP servers wired in (hive.ensureAgent). OpenCode
    // was listed too, with nothing configuring them, and went looking for the tools.
    const connCfg = readConfig();
    const connectionsForAgent: PromptConnection[] = provider === 'claude'
      ? (() => {
          const ids = new Set(hive.keyedConnectionsFor(connCfg.mcpDefaults, connCfg.agentMcpGrants?.[opts.hive!.id], opts.hive!.id, connCfg.connectionScopes, toolBlocksFor(opts.hive!.id)));
          return listConnections().filter((c) => ids.has(c.id)).map((c) => ({ id: c.id, label: c.label, serviceLabel: c.serviceLabel, description: c.description, examples: c.examples, access: connectionAccessFor(opts.hive!.id, c.id) === 'readwrite' ? 'readwrite' as const : 'read' as const }));
        })()
      : [];
    let brokerIntegrations: Array<{ id: string; label: string }> | undefined;
    const runnersForAgent = envVault.describeRunners();
    if (integrationBroker.running()) {
      const { ids, access } = apisFor(opts.hive.id);
      // Every agent gets the broker, even with no API enabled yet: what it may use
      // is looked up per request (broker `live`), so an API connected later works
      // without restarting it. Re-granting revokes a worker's earlier token.
      const token = integrationBroker.grant(opts.id, ids, access, opts.hive.id);
      opts.env = { ...(opts.env ?? {}), ...bothEnv('BROKER_URL', integrationBroker.url()), ...bothEnv('BROKER_TOKEN', token) };
      const labels = new Map(integrations.listRecords().map((r) => [r.id, r.label]));
      brokerIntegrations = ids.map((id) => ({ id, label: `${labels.get(id) ?? id}${access[id] === 'read' ? ', read-only: GET and searches' : ''}` }));
      // For diagnosis: which APIs this agent had when it started (log.jsonl).
      try { hive.appendLog({ kind: 'broker-grant', agentId: opts.hive.id, apis: ids.map((id) => `${id}:${access[id]}`) }); } catch { /* log is best-effort */ }
    }
    // Confidential vaults: its own (a custodian), and the ones it may not read.
    const spawnVaults = await prepareVaults(opts.hive.id, provider);
    // Read before ensureAgent records this spawn's folder and role.
    freshReason = freshSessionReason(hive.sessionContext(opts.hive.id), { cwd: opts.cwd, custodian: !!spawnVaults.custodian });
    try {
      spawnStep(opts.id, 'preparing the agent in the hive');
      const inj = await hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        {
          semanticMemory: memory.active(),
          knowledgeGraph: knowledge.active(),
          // Bake the ABSOLUTE KG CLI path into the agent's prompt. The prompt used
          // to spell it `$KG_CLI`, which is POSIX-only: under cmd.exe/PowerShell it
          // expands to nothing, so every knowledge-graph instruction was dead on a
          // Windows floor. Empty when the KG is off (the line isn't emitted then).
          kgCliPath: knowledge.env().KG_CLI,
          proxyUpstream,
          tls: proxyTls,
          integrations: brokerIntegrations,
          runners: runnersForAgent,
          connections: connectionsForAgent,
          envNames: Object.keys(plainEnv),
          theme: readConfig().terminalTheme ?? 'light',
          // W3 — default-MCP consent state + the bundled skills source dir.
          mcpDefaults: readConfig().mcpDefaults,
          mcpGrant: readConfig().agentMcpGrants?.[opts.hive.id],
          toolBlocks: toolBlocksFor(opts.hive.id),
          critical: criticalLabelsFor(opts.hive.id, provider),
          vaults: spawnVaults.own,
          denyDirs: spawnVaults.deny,
          denyOwners: spawnVaults.denyOwners,
          lockdown: spawnVaults.custodian ? { outgoing: join(hive.agentFolder(opts.hive.id), 'outgoing') } : undefined,
          modelHosts: readConfig().piModelHosts,
          piCustomBaseUrls: cleanCustomProviders(readConfig().customModelProviders).map((p) => p.baseUrl),
          mcpScopes: readConfig().connectionScopes,
          mcpOnlyManaged: readConfig().mcpOnlyManaged !== false,
          skillsDir: skillsResourceDir(),
          // The shared palace is mutated by the agent's own `mempalace` calls, so
          // the OS sandbox must let it through (empty when memory is off).
          extraWritableDirs: [memory.env().MEMPALACE_PALACE_PATH, ...spawnVaults.own].filter((p): p is string => !!p),
          // Its folders (toolGuard.ts): the orchestrator also writes in the
          // office's repos (it integrates branches); the human may let anyone out.
          writableRoots: opts.hive.isGod ? (readConfig().registeredRepos ?? []) : [],
          roam: (readConfig().agentRoam ?? []).includes(opts.hive.id),
          // The human's "Run without sandbox" (never for a custodian).
          unsandboxed: runsUnsandboxed(readConfig().agentUnsandboxed, readConfig().criticalCustodians, opts.hive.id),
          // Its sandboxed shell may reach this broker port (sb-api, sb-run…).
          brokerUrl: opts.env?.SB_BROKER_URL,
          // Cloud CLI logins the human exposed to it (never a custodian's).
          exposeCredentials: isCustodian(criticalMap(), opts.hive.id) ? [] : cleanCloudCredentialMap(readConfig().agentCloudCredentials)[opts.hive.id] ?? []
        }
      );
      opts.args = [...(opts.args ?? []), ...inj.args];
      // The app's OS sandbox for a CLI without one that holds (pi, agy): the CLI runs inside
      // bubblewrap. If bubblewrap then fails to start, so does the agent: it
      // never falls back to running unconfined.
      if (inj.wrap) {
        opts.args = [...inj.wrap, '--', opts.command, ...opts.args];
        opts.command = inj.wrapCommand ?? 'bwrap';
      }
      if (inj.osSandbox) osSandboxes.set(opts.hive.id, inj.osSandbox); else osSandboxes.delete(opts.hive.id);
      seedPrompt = inj.seedPrompt;
      // A degraded spawn (proxy bridge never bound) is told to the user the same
      // way breaker escalations are: a native toast, gated on the notifications
      // setting. The hive already logged it and pushed hive:degraded to the floor.
      if (inj.degraded) breakerToast('Agent running degraded', inj.degraded);
      // Point the agent's mempalace CLI at the shared palace + the `kg` CLI at the
      // enterprise knowledge store (both no-ops / empty when their flags are off).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env(), ...knowledge.env() };
    } catch (e) {
      // Not started: without its preparation the agent would run with no
      // sandbox, no guard and no hooks (in auto mode, free to write anywhere).
      // That is how agents got out when the hive had a problem.
      console.error('[hive] ensureAgent failed:', e);
      try { integrationBroker.revoke(opts.id); } catch { /* best-effort */ }
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `${opts.hive.name ?? opts.hive.id} was not started: the office could not prepare it (${why}). It never runs without its sandbox and guard. Try again in a moment; if it keeps failing, check that the office folder is reachable.` };
    }
  }
  // Long-run guardrails + tiering (Lane A #6.4/#6.6). All additive to the args
  // already assembled (incl. the hive injection); an explicit choice always wins.
  // Set when an explicit Add Agent "resume session" id couldn't be located and we
  // silently fell back to a fresh session — returned so the dialog can surface it.
  let resumeNotFound = false;
  // Set when `--resume` was actually attached (explicit id or restore-on-restart),
  // so the renderer can skip re-orienting a god/assistant that resumed its thread.
  let didResume = false;
  // Restoring this agent's OWN session (a restart, Restore team, a restart that
  // names its recorded id) in another folder or role: start fresh, for every
  // CLI. pi asks "Session found in different project… Fork?" and exits on the
  // app's first typed prompt; a custodian's session must not follow it out of
  // the role, nor an older one into it. An id the human typed in Add Agent for
  // a session from elsewhere is still honoured.
  let freshStart: string | undefined;
  if (freshReason && opts.hive) {
    const typed = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const restoring = typed ? hive.recentSessions(opts.hive.id).includes(typed) : opts.resume === true;
    if (restoring) {
      freshStart = freshSessionNotice(freshReason);
      opts.resume = false;
      opts.resumeSessionId = undefined;
    }
  }
  // Claude-only — these are Claude Code flags; other CLIs carry their own flags
  // in the command string the renderer already built.
  if (opts.hive && claudeProvider) {
    const cfg = readConfig();
    // Permission posture (D9): only a GUI hire (Add Agent) builds its command
    // through buildSpawnCommand, which bakes autoMode's bypass flag into the
    // command STRING before this function ever sees it. A main-only spawn (the
    // ephemeral-worker watcher, a voice hire) skips that step entirely, so it
    // previously reached here with neither the flag nor any equivalent — every
    // other Claude spawn path got the user's autoMode posture and this one
    // didn't. argsWithAutoModeFlag is idempotent (a GUI spawn's args already has
    // the flag, so this is a no-op for it) and is the SAME check spawnAgentCore
    // already applies for opencode/crush et al a few lines below via
    // HIVE_AUTO_APPROVE — one global toggle, one posture, every spawn path.
    // Confirmed live: a worker spawned without this flag deadlocked — a
    // cross-session message to it came back "held for the recipient user's
    // approval" with no surface for anyone to ever grant that approval.
    const args = argsWithAutoModeFlag(opts.args ?? [], cfg.autoMode, provider);
    // Model precedence: an explicit per-agent --model (from the renderer) wins;
    // else the user's global defaultModel; else the role-based default tier. The
    // GOD is special-cased: it has its own engine config (godProvider/godModel), so
    // modelForRole resolves it and that wins over the worker-oriented defaultModel.
    // Temps can have their own model (Settings → Agents & Models, per role).
    const kind = agentKind(opts.hive, opts.temp);
    if (!args.includes('--model')) {
      const m = kind === 'god'
        ? modelForRole(opts.hive, cfg)
        : (kind === 'temp' && cfg.tempModel) || (cfg.defaultModel ?? modelForRole(opts.hive, cfg));
      if (m) args.push('--model', m);
    }
    // Effort per role; unset leaves Claude Code's own default (often "high").
    args.push(...effortArgs(args, kind, cfg));
    // Name the Remote Control session after the agent (Michael, Jim, Dev1…) so it
    // is identifiable in claude.ai / the mobile app. Otherwise Claude defaults the
    // prefix to the machine hostname (e.g. "vyapaks-macbook-pro-…"), which is
    // opaque when several agents run at once — especially with remoteControlAtStartup
    // on, where RC auto-enables for every session. Slugify the friendly name into a
    // single safe token; Claude still appends its own random suffix for uniqueness.
    if (!args.includes('--remote-control-session-name-prefix')) {
      const label = (opts.hive.name || opts.hive.id || '')
        .trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
      if (label) args.push('--remote-control-session-name-prefix', label);
    }
    // Coarse runaway cap.
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    // Resume: an explicit session id (Add Agent "resume session" field, #2) wins,
    // else this agent's last recorded session (#1 restore-on-restart / #6.6a).
    // Seed the transcript into the target cwd's Claude project dir first — Claude
    // keys sessions by cwd, so a session started elsewhere is invisible until its
    // `.jsonl` is copied across. Only attach `--resume` if the transcript is
    // actually present (already or after the copy); otherwise fall back to a fresh
    // session rather than launching a `--resume` against a missing id.
    const explicitSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    // Restore: the newest of this agent's sessions that still has a transcript.
    const sid = explicitSid || (opts.resume === true
      ? (() => {
          // Cheap first: a transcript already in this folder (one check each).
          // Only then the full search of every project folder, which crosses
          // \\wsl.localhost per folder on a WSL office.
          const ids = hive.recentSessions(opts.hive!.id);
          return ids.find((x) => hasLocalTranscript(opts.cwd!, x))
            ?? ids.find((x) => seedSessionTranscript(opts.cwd!, x))
            ?? hive.lastSession(opts.hive!.id);
        })()
      : undefined);
    if (sid && !args.includes('--resume')) {
      if (seedSessionTranscript(opts.cwd, sid)) {
        args.push('--resume', sid);
        didResume = true;
      } else if (explicitSid) {
        // The user typed a session id in the Add Agent dialog but it isn't in any
        // Claude project dir — we fall back to a FRESH session rather than a broken
        // `--resume`. Make that non-silent: warn on the floor and flag it back to
        // the renderer so the dialog can tell the user 'started fresh'.
        console.warn(`[resume] session "${explicitSid}" not found in any Claude project dir — starting a fresh session`);
        resumeNotFound = true;
      }
    }
    opts.args = args;
  }
  // Idempotent session resume on respawn (#6.6a) — provider-aware: Claude
  // `--resume <sid>`, Grok `--resume <sid>`, Antigravity `--conversation <id>`.
  // The recorded session id comes from hook payloads, so
  // a restored worker continues its prior CLI session. Only when requested AND a
  // prior id exists for this agent.
  // Claude resume — incl. transcript seeding + only-attach-when-present — is
  // handled in the Claude-only block above; this generic flag path covers the
  // other CLIs (it must not blindly attach `--resume` when the seed failed).
  if (opts.hive && !claudeProvider) {
    const preset = providerPreset(provider);
    const rf = preset.resumeFlag;
    const rsub = preset.resumeSubcommand;
    // An id typed into Add Agent's "resume session" field wins; otherwise fall
    // back to this agent's own recorded session (restart-in-place). Previously
    // resumeSessionId was read ONLY in the Claude branch, so a Codex agent
    // silently ignored it and started a brand-new empty session.
    const typedSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    const sid = typedSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    if (sid && rf) {
      const args = opts.args ?? [];
      if (!args.includes(rf)) { args.push(rf, sid); opts.args = args; didResume = true; }
    } else if (sid && rsub) {
      // Subcommand form (Codex): `codex resume [OPTIONS] [SESSION_ID]` — the
      // subcommand MUST be argv[0], the id trails the flags. Codex indexes
      // sessions in state_5.sqlite, so a fresh agent's empty CODEX_HOME can't
      // resume by id. If this agent's own home already has the session, resume in
      // place; otherwise point CODEX_HOME at the agent home that OWNS it (that
      // home has both the rollout and the sqlite index).
      const myHome = (opts.env ?? {}).CODEX_HOME;
      const agentsRoot = myHome ? dirname(dirname(myHome)) : '';
      const ownerHome = agentsRoot ? findCodexHomeForSession(sid, agentsRoot) : null;
      if (!ownerHome) {
        console.warn(`[resume] codex session "${sid}" not found in any agent CODEX_HOME - starting fresh`);
        if (typedSid) resumeNotFound = true;
      } else {
        if (ownerHome !== myHome) opts.env = { ...(opts.env ?? {}), CODEX_HOME: ownerHome };
        const args = opts.args ?? [];
        // Positional order matters: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`.
        // The hive identity prompt rides in `args` as a POSITIONAL (codex has no
        // prompt flag), so the id must come BEFORE it — appending the id last made
        // codex read the prompt as SESSION_ID ("No saved session found with ID
        // You are \"Dev2\"…") and the id as the prompt.
        if (args[0] !== rsub) { opts.args = [rsub, sid, ...args]; didResume = true; }
        console.log('[resume] codex resume', sid, 'in', ownerHome);
      }
    }
  }
  if (opts.requireResume === true && !didResume && !freshStart) {
    return {
      ok: false,
      error: 'Existing session could not be resumed; no replacement process was started.',
      ...(resumeNotFound ? { resumeNotFound: true } : {})
    };
  }
  // Remember which agent owns this PTY so closing the tab can archive it. A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) {
    ptyToAgent.set(opts.id, opts.hive.id);
    // A new session, for the work-switch rule's minimum session age.
    workSwitch.noteSessionStart(opts.hive.id);
    // Worker inbox-wake watchdog (#151): boot grace starts at spawn so the
    // initial orientation prompt is never mistaken for an idle agent.
    workerWake.noteSpawn(opts.id);
  }
  // Pre-accept Claude Code's bypass-mode warning + folder-trust dialog so the
  // agent (spawned with --permission-mode bypassPermissions) doesn't stall on an
  // interactive prompt it can't answer and exit code 1. Best-effort, never blocks.
  // Claude-only — other CLIs handle their own permission UX.
  if (claudeProvider) {
    try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* never block spawn */ }
  }
  // Suppress first-run interactive prompts for providers that need it (e.g. Codex
  // directory-trust gate via CODEX_NON_INTERACTIVE). Merges into any env already
  // set on opts.
  spawnStep(opts.id, 'keys, connections and engine settings');
  const nonInteractiveEnv = nonInteractiveEnvForProvider(provider);
  if (Object.keys(nonInteractiveEnv).length > 0) {
    opts.env = { ...(opts.env ?? {}), ...nonInteractiveEnv };
  }
  // ── BYOK keys + per-provider config for the non-Claude CLI engines (v0.3.1) ──
  // OpenCode / Crush / pi / qwen read BYOK API keys from standard env vars and, for
  // the local-LLM path, a per-provider base URL. Keys are write-only in the broker
  // (read MAIN-ONLY here, never logged); base URLs ride HarnessConfig. Claude/codex
  // use their own login, so they skip this. Pam guardrails #3/#4/#5.
  if (opts.hive && (provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen')) {
    const cfg = readConfig();
    const extra: Record<string, string> = {};
    // 1) BYOK keys — LEAST-PRIVILEGE (Pam/Jim NIT-2): inject ONLY the key for the
    //    spawned model's provider prefix when we can identify it; fall back to all
    //    stored keys when the model/prefix is unknown (default model, qwen slugs,
    //    custom). Reduces the blast radius vs handing every CLI all keys.
    const modelIdx = (opts.args ?? []).indexOf('--model');
    const argModel = modelIdx >= 0 ? (opts.args?.[modelIdx + 1] ?? '') : '';
    // The model is pinned per agent: a restart without --model (standup
    // compaction, resume) gets it back instead of the engine's own default.
    const pinFile = hive.root() ? join(hive.root()!, 'agents', opts.hive.id, 'engine-model.json') : null;
    let pinned: string | undefined;
    if (pinFile) {
      try { const j = JSON.parse(readFileSync(pinFile, 'utf8')) as { model?: unknown }; if (typeof j.model === 'string') pinned = j.model; } catch { /* none yet */ }
      if (argModel && argModel !== pinned) { try { mkdirSync(dirname(pinFile), { recursive: true }); writeFileSync(pinFile, JSON.stringify({ model: argModel }), 'utf8'); } catch { /* best-effort */ } }
    }
    const piDirEarly = provider === 'pi' ? opts.env?.PI_CODING_AGENT_DIR : undefined;
    let piDefaultProvider: string | undefined;
    if (piDirEarly) { try { const j = JSON.parse(readFileSync(join(piDirEarly, 'settings.json'), 'utf8')) as { defaultProvider?: unknown }; if (typeof j.defaultProvider === 'string') piDefaultProvider = j.defaultProvider; } catch { /* none */ } }
    const eff = effectiveModel(argModel, pinned, piDefaultProvider);
    if (!argModel && eff.model) opts.args = ['--model', eff.model, ...(opts.args ?? [])];
    const modelSlug = eff.model ?? '';
    const prefix = eff.provider ?? '';
    // Keys follow the model: its backend's key only; a provider of your own (or
    // one the engine defines itself) gets none — it brings its own.
    const scope = keyScope(eff.provider, (p) => !!backendForModel(`${p}/x`));
    if (scope !== 'none') Object.assign(extra, providerKeyEnv(scope === 'one' ? `${eff.provider}/x` : '', (backend) => integrations.getSecret(providerKeyRef(backend))));
    // 1b) Keys of your own OpenAI-compatible providers, by env var name (the
    //     configs below point at it; no key is written into a file).
    for (const p of cleanCustomProviders(cfg.customModelProviders)) {
      const key = integrations.getSecret(customKeyRef(p.id));
      if (key) extra[customKeyEnv(p.id)] = key;
    }
    // Pi: your models.json (already copied into its agent dir) plus those providers,
    // and the agent's model as its default so a resumed session keeps it.
    const piDir = opts.env?.PI_CODING_AGENT_DIR;
    if (provider === 'pi' && piDir && eff.model) {
      const file = join(piDir, 'settings.json');
      let existing: string | null = null;
      try { existing = readFileSync(file, 'utf8'); } catch { /* none yet */ }
      try { writeFileSync(file, piSettingsWithModel(existing, eff.model), 'utf8'); } catch (e) { console.error('[pi] could not write settings.json:', e); }
    }
    if (provider === 'pi' && piDir) {
      const custom = cleanCustomProviders(cfg.customModelProviders);
      if (custom.length) {
        const file = join(piDir, 'models.json');
        let existing: string | null = null;
        try { existing = readFileSync(file, 'utf8'); } catch { /* none yet */ }
        try { writeFileSync(file, piModelsJson(existing, custom, (id) => !!extra[customKeyEnv(id)]), 'utf8'); }
        catch (e) { console.error('[pi] could not write models.json:', e); }
      }
    }
    // 2) Floor auto-state for pi's bundled extension auto-allow (guardrail #5): it
    //    only auto-approves tool calls when this is '1' (i.e. floor auto mode on).
    extra.HIVE_AUTO_APPROVE = cfg.autoMode ? '1' : '0';
    // 3) OpenCode's auto-approve + local provider live in its single config-injection
    //    env var, built dynamically so permission:allow is GATED on autoMode (#2).
    if (provider === 'opencode') {
      const oc: Record<string, unknown> = { autoupdate: false };
      if (cfg.autoMode) oc.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow' };
      const baseUrl = cfg.providerBaseUrls?.opencode;
      if (baseUrl) {
        // Register the model id the user actually selects (the part after 'local/')
        // so `--model local/<id>` resolves; default to 'local'. Without this the
        // dropdown's `local/llama3` failed against a config that only declared model
        // 'local' (Jim verify-opencode MUST-FIX #2).
        const localModel = (prefix === 'local' && modelSlug.slice(6)) || 'local';
        oc.provider = {
          local: { npm: '@ai-sdk/openai-compatible', name: 'Local (self-hosted)', options: { baseURL: baseUrl }, models: { [localModel]: { name: localModel } } }
        };
      }
      // Your own OpenAI-compatible providers (AI providers → Local & compatible).
      const custom = cleanCustomProviders(cfg.customModelProviders);
      if (custom.length) oc.provider = { ...((oc.provider as Record<string, unknown>) ?? {}), ...opencodeProviders(custom, (id) => !!extra[customKeyEnv(id)]) };
      // Connections (keyed MCP servers) through main's gateway, as OpenCode
      // remote servers: only a capability token, never the key. Same list the
      // agent's prompt names (hive.keyedConnectionsFor).
      if (mcpGateway.running()) {
        const ids = hive.keyedConnectionsFor(cfg.mcpDefaults, cfg.agentMcpGrants?.[opts.hive.id], opts.hive.id, cfg.connectionScopes, toolBlocksFor(opts.hive.id));
        if (ids.length) {
          const token = mcpGateway.grant(opts.hive.id, ids, hive.mcpAccessMap(opts.hive.id, ids));
          oc.mcp = Object.fromEntries(ids.map((id) => [`munder-${id}`, {
            type: 'remote', url: `${mcpGateway.url()}/mcp/${id}`, enabled: true, headers: { Authorization: `Bearer ${token}` }
          }]));
        }
      }
      extra.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
    }
    opts.env = { ...(opts.env ?? {}), ...extra };
  }
  // Codex Remote is daemon-based (there is no `/remote-control` slash command).
  // Start/enable the daemon under this agent's isolated CODEX_HOME and connect
  // the TUI to it so the thread is visible in ChatGPT mobile. Best-effort: an
  // unavailable/older Codex install still gets a normal local terminal.
  if (provider === 'codex' && opts.hive?.id) {
    spawnStep(opts.id, 'Codex remote');
    await enableCodexRemoteForSpawn(opts, opts.hive.id);
  }
  // A WSL floor: its agents reach the hook server, MCP gateway, key broker and
  // telemetry through this distro's bridge (wslBridge.ts) — no mirrored
  // networking needed. The hook server is a named pipe on Windows, so agents get
  // the bridge's TCP port instead.
  const wslLoc = process.platform === 'win32' ? parseWslPath(opts.cwd) : null;
  if (wslLoc) {
    try {
      const bridge = wslBridgeFor(wslLoc.distro);
      // Every service as it is NOW (one that started after the first agent, the
      // Slack reply endpoint, this agent's own proxy sidecar) — a new one is
      // added to the running bridge. Same port numbers inside WSL where free.
      const proxy = hive.proxyPortFor(opts.id);
      const listeners = [
        ...wslBridgeListeners(),
        ...(slackReplyServer && slackReplyPort ? [{ name: `slack:${slackReplyPort}`, port: slackReplyPort, target: { port: slackReplyPort } }] : []),
        ...(proxy ? [{ name: `proxy:${proxy}`, port: proxy, target: { port: proxy } }] : [])
      ];
      // "Port already taken inside WSL" means the Windows service is reachable
      // directly ONLY with mirrored networking. Otherwise some other program
      // holds that port and agents would hand it their tokens and API keys:
      // refuse to start rather than point the agent there.
      const mirrored = mirroredNetworking();
      for (const l of listeners) {
        spawnStep(opts.id, `WSL bridge: ${l.name}`);
        const p = await bridge.ensure(l);
        spawnStep(opts.id, `WSL bridge: ${l.name} → ${p}`);
        if (l.name === 'hooks' && typeof p === 'number') opts.env = { ...(opts.env ?? {}), HIVE_SOCK: `tcp://127.0.0.1:${p}` };
        if (typeof p === 'number' || (p === 'direct' && mirrored)) continue;
        console.warn(`[wsl-bridge] ${l.name}: ${p}`);
        const what = l.name.split(':')[0];
        return {
          ok: false,
          error: p === 'direct'
            ? `Could not start the agent in WSL (${wslLoc.distro}): port ${l.port} (${what}) is already in use inside WSL by another program. Close it, or turn on mirrored networking, and try again.`
            : `Could not start the agent in WSL (${wslLoc.distro}): the bridge could not open port ${l.port} (${what}): ${p}.`
        };
      }
      // Set on the app's own env for Windows agents; a WSL agent only gets what
      // its spawn carries (pty.ts), so hand it over here (as a /mnt path).
      if (process.env.MD_SLACK_REPLY_CONFIG && !(opts.hive && isCustodian(criticalMap(), opts.hive.id))) opts.env = { ...(opts.env ?? {}), ...bothEnv('SLACK_REPLY_CONFIG', process.env.MD_SLACK_REPLY_CONFIG) };
      // Claude's temp folder in the user's own cache, not /tmp (wsl.ts
      // AGENT_TMP_SCRIPT): made and repaired before every spawn.
      if (provider === 'claude' && !opts.env?.CLAUDE_CODE_TMPDIR) {
        spawnStep(opts.id, 'WSL temp folder');
        const tmp = await wslAgentTmpDir(wslLoc.distro);
        if (tmp) opts.env = { ...(opts.env ?? {}), CLAUDE_CODE_TMPDIR: tmp };
      }
      // Its temp folder (and Claude's scratchpad in it) is one of its folders.
      if (opts.hive && opts.env?.CLAUDE_CODE_TMPDIR) hive.noteAgentTmp(opts.hive.id, opts.env.CLAUDE_CODE_TMPDIR);
    } catch (e) {
      console.error('[wsl-bridge] start failed:', e);
      return { ok: false, error: `Could not start the agent in WSL (${wslLoc.distro}): ${e instanceof Error ? e.message : describeWslError(e, wslLoc.distro)}` };
    }
  }
  spawnStep(opts.id, 'starting the terminal');
  const res = ptyManager.spawn(opts, owner);
  spawnStep(opts.id, res.ok ? 'started' : `failed: ${res.error}`);
  if (res.ok) analytics.track('agent_spawned', { provider });
  else analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
  // Said where the human looks (the agent's terminal) and kept in the log.
  if (res.ok && freshStart && opts.hive) {
    console.warn(`[resume] ${opts.hive.id}: ${freshStart}`);
    try { hive.appendLog({ kind: 'session-fresh', agentId: opts.hive.id, reason: freshReason }); } catch { /* log is best-effort */ }
    const wc = (owner && !owner.isDestroyed()) ? owner : liveWebContents();
    try { wc?.send(`pty:data:${opts.id}`, `\r\n\x1b[33m  ${freshStart}\x1b[0m\r\n`); } catch { /* window gone */ }
  }
  syncKeepAwake(); // arm the power-save blocker while ≥1 agent PTY is alive (#18)
  // Hand the resolved worktree path back to the renderer so it can persist it on
  // the agent (only set when isolation actually provisioned a worktree above).
  // The restore flow re-enters this exact worktree (cwd = worktreePath) so a
  // restored isolated agent resumes in the CORRECT checkout, not the base repo.
  const worktreePath = worktreePaths.get(opts.id);
  // `cwd` echoes back the TILDE-EXPANDED absolute path so the renderer's agent
  // record matches what the registry and the PTY actually used.
  return { ...res, cwd: opts.cwd, ...(worktreePath ? { worktreePath } : {}), ...(resumeNotFound ? { resumeNotFound: true } : {}), ...(didResume ? { resumed: true } : {}), ...(freshStart ? { freshStart } : {}), ...(seedPrompt ? { seedPrompt } : {}) };
}
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:redraw', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  return ptyManager.redraw(id);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: analytics (the ONE renderer-facing seam) ──────────────────────────
/** Count one human-sent message (TELEMETRY.md → `message_sent`). A COUNT, and
 *  nothing else: this channel takes no text, no length and no id, so there is
 *  no shape in which message content could cross it.
 *
 *  This is the only analytics event the renderer can cause. It exists because
 *  two of the four send surfaces — a line typed into the agent's terminal, and
 *  the queue composer — are submits main cannot observe: the `pty:write` handler
 *  above fires on EVERY KEYSTROKE, so counting there would produce a keystroke
 *  meter, not a message count. `steer` and `hive` are counted at their own IPC
 *  handlers in this file and are rejected here (isRendererMessageSurface) so
 *  they can never be counted twice. The event name is fixed here, not passed
 *  in: the renderer chooses a surface, never an event. */
ipcMain.handle('analytics:messageSent', (_evt, surface: unknown) => {
  if (!isRendererMessageSurface(surface)) return { ok: false };
  analytics.trackMessageSent(surface);
  return { ok: true };
});

// Resolve a pasted Claude session id to the cwd it originally ran in, so the Add
// Agent dialog can auto-fill the folder for a resume (#2 zero-step resume). Reads
// the cwd from a transcript record; null when the id is invalid/unknown.
ipcMain.handle('session:resolveCwd', (_evt, sessionId: unknown) =>
  (typeof sessionId === 'string' ? resolveSessionCwd(sessionId) : null));

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
// Electron 44 made the main-process clipboard async (W3C-style promises).
ipcMain.handle('app:copyToClipboard', async (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { await clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('app:readClipboard', async () => {
  try { return await clipboard.readText(); } catch { return ''; }
});
// Same read, SYNCHRONOUS, for the terminal's paste shortcut.
//
// Dictation tools (muesli.works, Wispr Flow, …) type by stashing the user's
// clipboard, writing the transcript, sending the paste key, then restoring the
// old clipboard immediately. An `invoke` read returns a tick or two later — by
// which point the restore has already landed and we paste the PREVIOUS text.
// A `sendSync` read completes inside the keydown handler, before the tool gets
// a chance to put the old contents back.
//
// The main-process read is async since Electron 44, but the renderer stays
// blocked in sendSync until returnValue is set, so the guarantee holds.
ipcMain.on('app:readClipboardSync', async (evt) => {
  try { evt.returnValue = await clipboard.readText(); } catch { evt.returnValue = ''; }
});
// NOTE: the terminal theme is mirrored into each agent's per-session Claude
// settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
// `claude config set -g theme`, which would also restyle the user's own
// Claude sessions outside the app.

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  // On a WSL floor start in the distro user's home (\\wsl.localhost\<distro>\
  // home\<you>): projects for its agents live there, not on a Windows drive.
  const floorWsl = process.platform === 'win32' ? hive.wslRoot() : null;
  // Elsewhere start in the home folder: since Electron 43 dialogs default to
  // Downloads, which is no place for a project.
  const defaultPath = (floorWsl ? distroHomeUnc(floorWsl.distro) : null) ?? app.getPath('home');
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder',
    ...(defaultPath ? { defaultPath } : {})
  });
  refocusAfterDialog(win);
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: a terminal at a folder (any platform; a WSL folder opens in its distro) ─
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return openTerminalAt(cwd);
});

// ─── IPC: integrations (Phase 2 registry — backend for Ryan's Settings UI) ────
// Records are metadata only (config-backed); secrets are encrypted at rest and NEVER
// returned over IPC. `list` redacts secretRef to a `hasSecret` boolean.
ipcMain.handle('integrations:list', () => integrations.listRecordsRedacted());
ipcMain.handle('integrations:templates', () => INTEGRATION_TEMPLATES);
ipcMain.handle('integrations:upsert', (_evt, record: unknown) => integrations.upsertRecord(record));
ipcMain.handle('integrations:setSecret', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; secret?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  if (typeof p.secret !== 'string' || !p.secret) return { ok: false, error: 'secret required' };
  return integrations.setSecret(secretRefFor(p.id), p.secret);
});
ipcMain.handle('integrations:remove', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  writeConfig({ criticalCustodians: setCritical(criticalMap(), 'api', p.id, false) });
  return integrations.removeRecord(p.id);
});
// ─── IPC: per-CLI-provider BYOK keys (write-only) ────────────────────────────
// API keys for the backend model-providers the non-Claude CLIs use are stored
// WRITE-ONLY under `apikey:<backend>` in the same encrypted broker. The renderer
// can SET a key and ASK whether one is set (boolean) — it can never read the
// plaintext back. Keys are materialized MAIN-ONLY at spawn (spawnAgentCore). Base
// URLs are non-secret and ride HarnessConfig.providerBaseUrls (normal config save).
ipcMain.handle('providerKey:set', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { backend?: unknown; key?: unknown };
  if (typeof p.backend !== 'string' || !(p.backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
  return integrations.setSecret(providerKeyRef(p.backend), p.key);
});
// Engines the app drives (Pi, OpenCode): where they sign in, and the models their
// own CLI lists. Names only — never a token.
function engineAuthFile(engine: ManagedEngine): string {
  return engine === 'pi' ? hive.piAuthStatus().file : join(agentsHome(), '.local', 'share', 'opencode', 'auth.json');
}
ipcMain.handle('engines:status', (_evt, engine: unknown) => {
  if (engine !== 'pi' && engine !== 'opencode') return { ok: false };
  const file = engineAuthFile(engine);
  let providers: Array<{ id: string; kind: string }> = [];
  try { providers = authProviders(readFileSync(file, 'utf8')); } catch { /* not signed in */ }
  // Pi: the models your own ~/.pi/agent/models.json declares (offered in Add Agent).
  let ownModels: string[] = [];
  if (engine === 'pi') { try { ownModels = piOwnModels(readFileSync(join(dirname(file), 'models.json'), 'utf8')); } catch { /* none */ } }
  return { ok: true, home: agentsHome(), file, providers, signIn: SIGN_IN[engine], ownModels };
});
ipcMain.handle('engines:models', async (_evt, engine: unknown) => {
  if (engine !== 'pi' && engine !== 'opencode') return { ok: false, models: [], error: 'unknown engine' };
  const { cmd, args } = LIST_MODELS[engine];
  const w = hive.enabled() ? hive.wslRoot() : null;
  try {
    let out: string;
    if (w) {
      // A WSL floor's engines live in the distro: a login shell finds npm's bin.
      out = await runInDistroAsync(w.distro, 'sh', ['-lc', [cmd, ...args].join(' ')]);
    } else {
      out = await new Promise<string>((resolve, reject) => {
        // The stored model keys too, so an engine lists what those keys unlock.
        const env = { ...process.env, PATH: userShellPath(), ...providerKeyEnv('', (b) => integrations.getSecret(providerKeyRef(b))) };
        execFile(cmd, args, { env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
          if (err && !String(stdout).trim()) reject(new Error((String(stderr).trim() || err.message).split('\n')[0]));
          else resolve(String(stdout));
        });
      });
    }
    const models = parseModelList(out);
    return models.length ? { ok: true, models } : { ok: false, models: [], error: 'the CLI listed no models (sign in or add a key first)' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, models: [], error: /ENOENT|not found|not recognized/i.test(msg) ? `${cmd} is not installed` : msg };
  }
});
// Your own OpenAI-compatible providers for OpenCode and Pi (local models).
const customKeyRef = (id: string): string => `apikey:custom:${id}`;
ipcMain.handle('customProviders:save', (_evt, list: unknown) => {
  const clean = cleanCustomProviders(list);
  // A provider that is gone takes its key with it.
  for (const old of readConfig().customModelProviders ?? []) if (!clean.some((p) => p.id === old.id)) { try { integrations.deleteSecret(customKeyRef(old.id)); } catch { /* none */ } }
  writeConfig({ customModelProviders: clean });
  return clean;
});
ipcMain.handle('customProviders:setKey', (_evt, id: unknown, key: unknown) => {
  if (typeof id !== 'string' || !(readConfig().customModelProviders ?? []).some((p) => p.id === id)) return { ok: false, error: 'unknown provider' };
  if (typeof key !== 'string' || !key.trim()) { try { integrations.deleteSecret(customKeyRef(id)); } catch { /* none */ } return { ok: true }; }
  return integrations.setSecret(customKeyRef(id), key.trim());
});
ipcMain.handle('customProviders:hasKey', (_evt, id: unknown) => typeof id === 'string' && integrations.hasSecret(customKeyRef(id)));
// The models an OpenAI-compatible endpoint serves (GET <base>/models; Ollama's
// /api/tags as a fallback). The key, when stored, goes in the request only.
ipcMain.handle('customProviders:fetchModels', async (_evt, baseUrl: unknown, id: unknown) => {
  if (typeof baseUrl !== 'string') return { ok: false, models: [], error: 'bad request' };
  let base: URL;
  try { base = new URL(baseUrl.trim().replace(/\/+$/, '')); if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('x'); }
  catch { return { ok: false, models: [], error: 'the base URL must start with http:// or https://' }; }
  const key = typeof id === 'string' ? integrations.getSecret(customKeyRef(id)) : undefined;
  const get = async (u: string) => {
    const r = await fetch(u, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8000), redirect: 'manual' });
    if (!r.ok) { void r.body?.cancel().catch(() => undefined); return { status: r.status, body: null }; }
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try {
    let r = await get(`${base.href.replace(/\/+$/, '')}/models`);
    let models = modelsFromListing(r.body);
    if (!models.length) { r = await get(`${base.origin}/api/tags`).catch(() => r); models = modelsFromListing(r.body); }
    return models.length ? { ok: true, models } : { ok: false, models: [], error: `no models listed (HTTP ${r.status})` };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'TimeoutError' ? 'no answer in 8 s' : e instanceof Error ? e.message : String(e);
    return { ok: false, models: [], error: `could not reach it: ${msg}` };
  }
});
// Pi's own sign-in (`pi` → /login), as provider names only.
ipcMain.handle('providers:piStatus', () => hive.piAuthStatus());
ipcMain.handle('providerKey:has', (_evt, backend: unknown) =>
  typeof backend === 'string' ? integrations.hasSecret(providerKeyRef(backend)) : false);
ipcMain.handle('providerKey:clear', (_evt, backend: unknown) => {
  if (typeof backend !== 'string' || !(backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  try { integrations.deleteSecret(providerKeyRef(backend)); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
// Probe an integration's reachability through the broker's own auth path (admin-only;
// runs in main, so the secret is used but never returned — only the upstream status).
ipcMain.handle('integrations:test', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; path?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  const rec = integrations.getRecord(p.id);
  if (!rec) return { ok: false, error: 'unknown integration' };
  const probe = validateBaseUrl(rec.baseUrl);
  if (!probe.ok) return { ok: false, error: probe.error };
  if (hasPlaceholderHost(rec.baseUrl)) return { ok: false, error: 'Replace "your-domain" in the base URL with your own site first.' };
  // An explicit path wins; otherwise the service's own cheap authenticated read
  // (a bare baseUrl such as Jira's /rest/api/3 is not an endpoint: it is a 404).
  const spec = typeof p.path === 'string' && p.path ? { method: 'GET' as const, path: p.path } : probeSpecFor(rec.baseUrl);
  // Confine the probe path through the SAME gate as the worker forward() path, so an
  // absolute URL / backslash-host / traversal in p.path can't override the origin and
  // exfiltrate the secret to an attacker host. Resolve (and reject) BEFORE the secret
  // is ever materialized, so a bad path never even decrypts it.
  const target = resolveUpstreamUrl(rec.baseUrl, spec.path);
  if (!target) return { ok: false, error: 'path escapes the integration baseUrl', code: 'bad_request' };
  const secret = integrations.getSecret(rec.secretRef);
  const headers = { ...(('headers' in spec && spec.headers) || {}), ...buildAuthHeaders(rec.authType, rec.authHeader, secret) };
  try {
    const r = await fetch(target, { method: spec.method, headers, body: 'body' in spec ? spec.body : undefined, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    void r.body?.cancel().catch(() => undefined); // only the status is wanted; free the connection
    // The service said no: say which request, so a 404/401 can be read, not guessed.
    return { ok: r.ok, status: r.status, ...(r.ok ? {} : { error: `${spec.method} ${target.pathname}${target.search} `.trim() }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
// Subscription usage windows, as last reported by an agent's status line.
ipcMain.handle('usage:rateLimits', () => hookServer.rateLimits);
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => {
  // FIRST RUN: every hive-bound service is started by bootstrapHiveServices(),
  // which runs once at app-ready and early-returns on `!hive.enabled()` — i.e.
  // whenever harnessHome is still null, which is exactly the state a fresh
  // install boots in. Onboarding then sets harnessHome through THIS handler and
  // nothing re-bootstrapped, so the hook server, message router, telemetry
  // collector and mission scheduler all stayed dead for the rest of the session.
  //
  // Symptom: agents spawn and run (the PTY is not hive-bound), but no hook ever
  // reaches the app — no `hooks.sock` on disk, so no SessionStart, which means
  // recordSession() is never called and "Restart & Continue" fails with "No
  // recorded session ID"; the cards also sit on "ctx no status tick yet" and 0
  // tool calls. Everything healed on the next app launch, which is what hid it.
  //
  // changeHome() has always handled this by relaunching; onboarding does not
  // relaunch, so bootstrap here on the null → set transition. Gated on the
  // transition so ordinary config writes never re-enter it.
  const hiveWasEnabled = hive.enabled();
  const wasOnboarded = readConfig().onboardingComplete;
  // "Run without sandbox" is set only by agent:setUnsandboxed (its typed
  // confirmation, custodian check and audit line); never through here. Nor is
  // "Use my SSH keys through the office" (sshRelay:set), nor the cloud logins
  // an agent may read (cloudCreds:set).
  const { agentUnsandboxed: _unsandboxed, agentSshRelay: _sshRelay, agentCloudCredentials: _cloudCreds, ...safePatch } = patch ?? {};
  const next = writeConfig(safePatch);
  // Live opt-in/out from Settings → Privacy (TELEMETRY.md).
  if (typeof patch?.telemetryEnabled === 'boolean') analytics.setEnabled(patch.telemetryEnabled);
  // Activation funnel (v0.4.6): onboarding just finished (false → true) — the top of
  // the launch → first-agent funnel. `provider` is the engine chosen in the wizard.
  // Fired here (main), not in the renderer, so it rides the same allowlist as the rest.
  if (!wasOnboarded && next.onboardingComplete) {
    analytics.track('onboarding_completed', { provider: next.godProvider ?? 'claude' });
  }
  // Keep the hive's mirror of the spawn gate current. The queue itself reads
  // config per tick so it gates immediately; this is for the PROMPT, which is
  // built per spawn, so flipping the toggle reaches god the next time he starts.
  if (typeof patch?.orchestratorMaySpawn === 'boolean') hive.setOrchestratorMaySpawn(patch.orchestratorMaySpawn);
  if (!hiveWasEnabled && hive.enabled()) {
    console.log('[hive] harnessHome configured — bootstrapping hive services');
    try { bootstrapHiveServices(); } catch (e) { console.error('[hive] bootstrap after onboarding:', e); }
  }
  return next;
});
ipcMain.handle('config:setAgentMcpGrant', (_evt, agentId: unknown, servers: unknown, access: unknown) =>
  setAgentMcpGrant(agentId, servers, access)
);
// Manager → Connections: keyed MCP servers. Values go one way into the encrypted
// store; nothing here ever returns one (see connections.ts).
// Keyed MCP servers run under MAIN, never under an agent: the gateway holds
// the key and an agent gets a capability token (mcpGateway.ts).
hive.setMcpKeyCheck(connectionKeyStored);
hive.setMemoryMcp(() => memory.mcpServer());
hive.setCustomMcp((agentId) => mcpServers.forAgent(agentId));
hive.setMcpInstances(instancesOf);
hive.setMcpAccess(connectionAccessFor);
hive.setCritical(criticalMap);
hive.setMcpGateway((agentId, serverIds, access) =>
  mcpGateway.running() ? { url: mcpGateway.url(), token: mcpGateway.grant(agentId, serverIds, access) } : null);
ipcMain.handle('connections:list', () => listConnections());
ipcMain.handle('connections:add', (_evt, service: unknown, label: unknown) => addConnection(service, label));

// ─── Factories (FACTORY-MCP.md) ──────────────────────────────────────────────
// Software factories this office watches or sends work to. The token is
// write-only from the renderer and used only here; the renderer gets what the
// factory offers and may call only the profile's tools (factories.ts).
const factories = new Factories({
  list: () => readConfig().factories ?? [],
  save: (list) => writeConfig({ factories: list }),
  token: (id) => integrations.getSecret(`factory:${id}`),
  setToken: (id, token) => integrations.setSecret(`factory:${id}`, token),
  deleteToken: (id) => integrations.deleteSecret(`factory:${id}`),
  log: (m) => console.log('[factories]', m)
});
const factoryError = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
// ─── WSL floors (wsl.ts): a floor created inside a distro runs there ─────────
const wslBridges = new Map<string, WslBridge>();
/** The bridge into one distro, created on first use. Listener ports inside WSL
 *  match the Windows services, so URLs in agents' env work unchanged; the hook
 *  server (a named pipe here) gets any free port. */
function wslBridgeFor(distro: string): WslBridge {
  let b = wslBridges.get(distro);
  if (b) return b;
  b = new WslBridge(distro, [], (m) => console.log(m));
  wslBridges.set(distro, b);
  return b;
}
/** The app's services as they stand right now. Named with their port, so a
 *  service that restarts on a new port is bridged anew. */
function wslBridgeListeners(): Array<{ name: string; port: number; target: { port: number } | { path: string } }> {
  const listeners: Array<{ name: string; port: number; target: { port: number } | { path: string } }> = [];
  const sock = hive.sockPath();
  if (sock) listeners.push({ name: 'hooks', port: 0, target: { path: sock } });
  const portOf = (url: string | null | undefined): number => { const m = url ? /:(\d+)\/?$/.exec(url) : null; return m ? Number(m[1]) : 0; };
  const gw = portOf(mcpGateway.url());
  if (gw) listeners.push({ name: `gateway:${gw}`, port: gw, target: { port: gw } });
  const br = integrationBroker.running() ? portOf(integrationBroker.url()) : 0;
  if (br) listeners.push({ name: `broker:${br}`, port: br, target: { port: br } });
  const tel = portOf(telemetry.endpoint?.() ?? null);
  if (tel) listeners.push({ name: `telemetry:${tel}`, port: tel, target: { port: tel } });
  return listeners;
}

/** Is `p` safe to open as far as UNC goes: not a UNC path at all, or a path
 *  into the current floor's own WSL distro. Paths that agents or hook payloads
 *  supply go through this before any fs call. */
function uncAllowed(p: string): boolean {
  if (!/^[\\/]{2}/.test(p)) return true;
  const w = parseWslPath(p);
  const floor = hive.wslRoot();
  return !!(w && floor && w.distro.toLowerCase() === floor.distro.toLowerCase());
}

/** The home folder the floor's agents use: the Windows profile, or the
 *  distro user's home (as a UNC path) on a WSL floor. */
function agentsHome(): string {
  const w = hive.wslRoot();
  return (w && distroHomeUnc(w.distro)) || homedir();
}

ipcMain.handle('wsl:distros', async () => {
  if (process.platform !== 'win32') return { ok: false, distros: [], error: 'WSL is a Windows feature' };
  const r = await listDistros();
  return { ...r, mirrored: mirroredNetworking() };
});
ipcMain.handle('wsl:createOffice', (_evt, distro: unknown, name: unknown) => {
  if (process.platform !== 'win32' || typeof distro !== 'string' || typeof name !== 'string') return { ok: false, error: 'invalid' };
  return createWslOffice(distro, name);
});
// Environment & secrets: values go in, never come out (envVault.ts).
ipcMain.handle('env:list', () => ({ vars: envVault.listVars(), runners: envVault.listRunners() }));
ipcMain.handle('env:setVar', (_evt, v: unknown, secret: unknown) => envVault.setVar(v, secret));
ipcMain.handle('env:removeVar', (_evt, name: unknown) => envVault.removeVar(name));
ipcMain.handle('env:setRunner', (_evt, r: unknown) => envVault.setRunner(r));
ipcMain.handle('env:removeRunner', (_evt, id: unknown) => envVault.removeRunner(id));
// Runner proposals shown in the window. `pending` lets a reloaded window pick up
// the ones still waiting. The answer carries only the secrets the proposal is
// missing; anything else in it is ignored.
ipcMain.handle('env:proposalsPending', () => [...pendingProposals.values()].map((p) => p.req));
ipcMain.handle('env:proposalAnswer', (_evt, id: unknown, answer: unknown) => {
  const p = typeof id === 'string' ? pendingProposals.get(id) : undefined;
  if (!p) return { ok: false };
  const a = (answer ?? {}) as { ok?: unknown; secrets?: Record<string, { kind?: unknown; value?: unknown }> };
  const secrets: Record<string, { kind: 'secret' | 'op'; value: string }> = {};
  for (const name of p.req.missing) {
    const s = a.secrets?.[name];
    if (s && typeof s.value === 'string') secrets[name] = { kind: s.kind === 'op' ? 'op' : 'secret', value: s.value };
  }
  p.settle({ ok: a.ok === true, secrets });
  return { ok: true };
});
ipcMain.handle('env:opStatus', () => new Promise((resolve) => {
  // Is the 1Password CLI installed? (Signing in happens through the desktop app.)
  const p = spawn('op', ['--version'], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => resolve({ installed: false }));
  p.on('close', (code) => resolve({ installed: code === 0, version: out.trim() || undefined }));
}));

// Manager → MCP: your own servers and the ones set up for other tools. Keys
// go one way into the encrypted store (mcpServers.ts).
const mcpErr = (e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) });
// What each agent really gets, decided here — never by the agent. Grants nothing.
ipcMain.handle('mcp:overview', () => {
  if (!hive.enabled()) return [];
  const cfg = readConfig();
  // Archived agents (earlier hires since replaced) keep their registry entry
  // but get nothing: listing them showed every re-hire as a duplicate.
  return Object.values(hive.registry().agents).filter((a) => a.status !== 'gone' && !a.isAssistant && !(a as { archived?: boolean }).archived).map((a) => ({
    agentId: a.id, name: a.name, provider: a.provider ?? 'claude',
    servers: hive.managedMcpFor(a.id, a.cwd, cfg.mcpDefaults, cfg.agentMcpGrants?.[a.id], cfg.connectionScopes, toolBlocksFor(a.id))
  }));
});
ipcMain.handle('mcp:list', () => ({ mine: mcpServers.listCustom(), found: mcpServers.scanForUi() }));
ipcMain.handle('mcp:import', (_evt, source: unknown, name: unknown, secretNames: unknown) => {
  if (typeof source !== 'string' || typeof name !== 'string') return mcpErr('bad request');
  try {
    return mcpServers.import(source, name, Array.isArray(secretNames) ? secretNames.filter((x): x is string => typeof x === 'string') : undefined);
  } catch (e) { return mcpErr(e); }
});
ipcMain.handle('mcp:save', (_evt, input: unknown, secretNames: unknown, secretHeaderNames: unknown) => {
  const i = (input ?? {}) as { id?: unknown; name?: unknown; transport?: unknown; env?: unknown; headers?: unknown };
  const t = (i.transport ?? {}) as { kind?: unknown; command?: unknown; args?: unknown; url?: unknown };
  const transport = t.kind === 'http'
    ? { kind: 'http' as const, url: String(t.url ?? '').trim() }
    : { kind: 'stdio' as const, command: String(t.command ?? '').trim(), args: Array.isArray(t.args) ? t.args.map(String) : [] };
  const strings = (v: unknown): Record<string, string> => v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x ?? '')])) : {};
  const names = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  try {
    return mcpServers.save({ id: typeof i.id === 'string' && i.id.startsWith('custom--') ? i.id : undefined, name: String(i.name ?? ''), transport, env: strings(i.env), headers: strings(i.headers) },
      names(secretNames), names(secretHeaderNames));
  } catch (e) { return mcpErr(e); }
});
ipcMain.handle('mcp:setEnabled', (_evt, id: unknown, on: unknown) => { if (typeof id === 'string') mcpServers.setEnabled(id, on === true); return { ok: true }; });
ipcMain.handle('mcp:setAgents', (_evt, id: unknown, agents: unknown) => {
  if (typeof id === 'string') mcpServers.setAgents(id, Array.isArray(agents) ? agents.filter((x): x is string => typeof x === 'string') : null);
  return { ok: true };
});
ipcMain.handle('mcp:remove', (_evt, id: unknown) => {
  if (typeof id === 'string') { mcpServers.remove(id); writeConfig({ criticalCustodians: setCritical(criticalMap(), 'mcp', id, false) }); }
  return { ok: true };
});

ipcMain.handle('factories:list', () => factories.list());
ipcMain.handle('factories:add', (_evt, arg: unknown) => {
  const a = (arg ?? {}) as { name?: unknown; url?: unknown; token?: unknown };
  return factories.add(a.name, a.url, a.token);
});
ipcMain.handle('factories:remove', (_evt, id: unknown) => factories.remove(id));
ipcMain.handle('factories:test', (_evt, id: unknown) => typeof id === 'string' ? factories.test(id) : factoryError('no such factory'));
ipcMain.handle('factories:floor', async (_evt, id: unknown) => {
  try { return { ok: true, floor: typeof id === 'string' ? await factories.floor(id) : null }; } catch (e) { return factoryError(e); }
});
ipcMain.handle('factories:events', async (_evt, id: unknown, since: unknown) => {
  try { return { ok: true, feed: typeof id === 'string' ? await factories.events(id, typeof since === 'string' ? since : '0') : null }; } catch (e) { return factoryError(e); }
});
ipcMain.handle('factories:call', async (_evt, id: unknown, tool: unknown, args: unknown, confirmed: unknown) => {
  try { return { ok: true, result: typeof id === 'string' ? await factories.call(id, tool, args, confirmed === true) : null }; } catch (e) { return factoryError(e); }
});
ipcMain.handle('connections:rename', (_evt, id: unknown, label: unknown) => renameConnection(id, label));
ipcMain.handle('connections:remove', (_evt, id: unknown) => {
  const r = removeConnection(id);
  if (r.ok && typeof id === 'string') writeConfig({ criticalCustodians: setCritical(criticalMap(), 'mcp', id, false) });
  return r;
});
// Pro Capabilities: the user's own role bundles, validated (shared/roleBundles).
ipcMain.handle('config:saveRoleBundles', (_evt, bundles: unknown) => {
  const clean = cleanCustomBundles(bundles);
  writeConfig({ customRoleBundles: clean.map(({ custom: _c, ...b }) => b) });
  return clean;
});
ipcMain.handle('connections:setSecret', (_evt, id: unknown, env: unknown, value: unknown) => setConnectionSecret(id, env, value));
ipcMain.handle('connections:setEnabled', (_evt, id: unknown, on: unknown) => setConnectionEnabled(id, on));
// Who has a connection, with what access, and if not, why — and what they did with it.
ipcMain.handle('connections:agents', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !hive.enabled()) return [];
  const conn = listConnections().find((c) => c.id === id);
  if (!conn) return [];
  const cfg = readConfig();
  return Object.values(hive.registry().agents).filter((a) => a.status !== 'gone' && !a.isAssistant).map((a) => {
    const provider = a.provider ?? 'claude';
    const r = explainConnection(a.id, {
      service: conn.service, enabled: conn.enabled, ready: conn.ready, scope: conn.scope,
      grant: cfg.agentMcpGrants?.[a.id], webBlocked: blockedMcpServers(toolBlocksFor(a.id)).has(conn.service),
      ceiling: cfg.connectionPolicy?.[id], record: cfg.agentMcpAccess?.[a.id], mcpCapable: provider === 'claude',
      custodian: custodianOf(criticalMap(), 'mcp', id)
    });
    return { agentId: a.id, name: a.name, ...r };
  });
});
ipcMain.handle('connections:activity', (_evt, id: unknown) => {
  if (typeof id !== 'string') return [];
  const names = new Map(hive.enabled() ? Object.values(hive.registry().agents).map((a) => [a.id, a.name] as const) : []);
  return mcpCalls.filter((c) => c.serverId === id).slice(-50).reverse().map((c) => ({ ...c, agentName: names.get(c.agentId) ?? c.agentId }));
});
// REST APIs: the most any agent may do with one, and which agents get it.
ipcMain.handle('integrations:setAccess', (_evt, id: unknown, level: unknown) => {
  if (typeof id !== 'string' || !integrations.getRecord(id) || !isAccess(level)) return { ok: false, error: 'bad request' };
  writeConfig({ integrationPolicy: { ...(readConfig().integrationPolicy ?? {}), [id]: level } });
  return { ok: true };
});
ipcMain.handle('integrations:setScope', (_evt, id: unknown, agentIds: unknown) => {
  if (typeof id !== 'string' || !integrations.getRecord(id)) return { ok: false, error: 'bad request' };
  const scopes = { ...(readConfig().integrationScopes ?? {}) };
  if (agentIds === null) delete scopes[id];
  else if (Array.isArray(agentIds) && agentIds.every((a) => typeof a === 'string')) scopes[id] = [...new Set(agentIds as string[])];
  else return { ok: false, error: 'bad request' };
  writeConfig({ integrationScopes: scopes });
  return { ok: true };
});
ipcMain.handle('connections:setAccess', (_evt, id: unknown, access: unknown) => setConnectionAccess(id, access));
ipcMain.handle('connections:setScope', (_evt, id: unknown, agentIds: unknown) => setConnectionScope(id, agentIds));
ipcMain.handle('connections:test', (_evt, id: unknown) => testConnection(id));
ipcMain.handle('hive:taskKeys', () => hive.taskKeys());
ipcMain.handle('config:setAgentTokenCap', (_evt, agentId: unknown, tokenCap: unknown) =>
  setAgentTokenCap(agentId, tokenCap)
);
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// Change the harnessHome folder. Because every derived path (hive root, palace,
// sock, agent dirs) resolves lazily through getHome(), the only real work is
// optionally MOVING the existing hive + palace and relaunching so every service
// re-binds against the new root. mode: 'move' copies the data (old kept as a
// safety net), 'fresh' just re-points and bootstraps an empty home.
ipcMain.handle('config:officesInUse', (_evt, paths: unknown) =>
  Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && !!p && officeHolder(resolve(expandTilde(p))) !== null) : []);
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  // expandTilde BEFORE resolve: both UI callers feed a folder-dialog result
  // (always absolute), but the hive picker's recents list can serve a literal
  // "~/…" persisted by a pre-#140 build — resolve() would anchor that at cwd
  // and the app would relaunch against a real directory named "~". Same
  // defence-in-depth-at-the-consumer rule as expandTilde's own doc.
  const newHome = resolve(expandTilde(p.newHome));
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // Guard against same-folder / nested-folder (a move would self-copy forever).
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;
  if (officeHolder(newHome) !== null) {
    return { ok: false, error: 'That office is already open on another floor. Switch to that window to use it.' };
  }

  // Tear down everything bound to the OLD root before copying, so nothing writes
  // mid-copy — a live git commit into hive/.git would otherwise be copied as a
  // half-written object and corrupt the moved repo.
  try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[changeHome] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[changeHome] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[changeHome] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[changeHome] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[changeHome] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[changeHome] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }

  if (mode === 'move' && oldHome) {
    try {
      // roster.json + its backups ride along with hive/palace: the roster is the
      // renderer's half of the same state, and leaving it behind would move the
      // agents' sessions and memory to the new home while their names, notes and
      // worktree paths stayed at the old one.
      for (const sub of ['hive', 'palace', 'roster.json', 'roster-backups']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
        // renameSync, which throws EXDEV across volumes). We COPY, never delete —
        // the old folder stays as a safety net the user removes manually.
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // Copy failed: recover IN PLACE against the unchanged old home (config never
      // repointed) so the user loses nothing, and surface the error — no relaunch.
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      reconcileWebhookServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Repoint config and relaunch so every service re-bootstraps against newHome.
  // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  try { ptyManager.killAll(); } catch (e) { console.error('[changeHome] killAll:', e); }
  releaseClaimedOffice();
  relaunchApp();
  app.exit(0);
  return { ok: true as const }; // unreachable (process exits) — typed for the renderer
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
// Raw bytes for files the text reader refuses (images). The renderer cannot
// load them off disk itself — the CSP has no `file:` source and no file
// protocol is registered — so the bytes come through here and become a `blob:`
// URL on the other side. Same root confinement as every other fs handler.
ipcMain.handle('fs:readBinary', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileBinary(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});
// v0.3.4: existence check for the terminal ⌘-click markdown flow (metadata only).
ipcMain.handle('fs:statAbs', (_evt, p: unknown) => {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) {
    return { exists: false, isFile: false, path: '' };
  }
  // On a WSL floor agents print Linux paths (/home/u/…, ~/…). Seen from
  // Windows those do not exist, so a clicked file did nothing: read them
  // through the distro's \\wsl.localhost share.
  const floor = process.platform === 'win32' ? parseWslPath(readConfig().harnessHome) : null;
  if (floor && /^(\/|~(\/|$))/.test(p)) {
    const home = p.startsWith('~') ? distroHomeUnc(floor.distro) : null;
    const unc = p.startsWith('~')
      ? (home ? home + p.slice(1).replace(/\//g, '\\') : null)
      : toWslUnc(floor.distro, p);
    if (unc) return statAbs(unc);
  }
  return statAbs(p);
});

/** Reveal a path in the OS file browser — Finder, Explorer, or whatever the
 *  Linux desktop registers. Backs ⌘-click on a terminal path we cannot open
 *  ourselves (an image, an archive, an unknown extension).
 *
 *  `showItemInFolder`, NEVER `shell.openPath`, for a file. The path arrives
 *  from agent output, and openPath hands an arbitrary file to its default
 *  application: a printed `installer.dmg` or `.desktop` would be one click from
 *  executing. Revealing only ever opens a file browser, so the worst an agent
 *  can achieve by printing a path is a window at a folder the user could
 *  already open themselves.
 *
 *  openPath IS used for a directory, and only after statAbs has confirmed it is
 *  one — a directory has no default application to launch, so the execution
 *  argument above does not apply, and revealing a folder inside its parent is
 *  not what "open this folder" means to anyone. */
ipcMain.handle('fs:revealPath', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
    return { ok: false, error: 'bad request' };
  }
  const st = await statAbs(p);
  if (!st.exists) return { ok: false, error: 'not found' };
  const err = st.isFile ? await revealFile(st.path) : await openFolder(st.path);
  return err ? { ok: false, error: err } : { ok: true };
});

/** The app itself running inside WSL (WSLg), where xdg-open often has no file
 *  browser to hand a folder to, but Windows Explorer is one call away. */
const RUNNING_IN_WSL = process.platform === 'linux'
  && (!!process.env.WSL_DISTRO_NAME || (() => { try { return /microsoft/i.test(readFileSync('/proc/version', 'utf8')); } catch { return false; } })());

/** Open a folder in the OS file browser. Resolves an error message, or ''. */
async function openFolder(dir: string): Promise<string> {
  if (RUNNING_IN_WSL) {
    const win = await new Promise<string>((res) => {
      execFile('wslpath', ['-w', dir], { timeout: 5000 }, (e, out) => res(e ? '' : String(out).trim()));
    });
    if (win) {
      // explorer.exe exits 1 even when it opened the window, so only a spawn failure counts.
      return new Promise((res) => {
        const c = spawn('explorer.exe', [win], { detached: true, stdio: 'ignore' });
        c.once('error', (e) => res(e.message));
        c.once('spawn', () => { c.unref(); res(''); });
      });
    }
  }
  const err = await shell.openPath(dir);
  if (err && process.platform === 'linux') return `${err} (no file browser is set for folders: try \`xdg-mime default <your-file-manager>.desktop inode/directory\`)`;
  return err;
}

/** Show a file in its folder. Electron's showItemInFolder reports nothing: on
 *  a Linux desktop with no FileManager1 D-Bus service (most tiling setups) it
 *  silently does nothing, and Explorer can refuse a \\wsl.localhost path the
 *  same way. So: Explorer's own /select on Windows, the parent folder on Linux
 *  (a file browser opened there, with an error if there is none). */
async function revealFile(file: string): Promise<string> {
  if (process.platform === 'darwin') { shell.showItemInFolder(file); return ''; }
  if (process.platform === 'win32') {
    return new Promise((res) => {
      // A Windows path cannot contain '"', so quoting it verbatim is safe.
      const c = spawn('explorer.exe', [`/select,"${file}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
      c.once('error', (e) => res(e.message));
      c.once('spawn', () => { c.unref(); res(''); });
    });
  }
  return openFolder(dirname(file));
}

// ─── IPC: git ───────────────────────────────────────────────────────────────
// Repositories inside a folder that is not one itself (a projects folder of
// several repos, one or two levels down), for the Git tab's picker.
ipcMain.handle('git:nestedRepos', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd || !uncAllowed(cwd) || !existsSync(cwd)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2 || out.length >= 50) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, '.git'))) out.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(cwd, 1);
  return out.sort((a, b) => a.localeCompare(b));
});
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});

// The repo a cwd belongs to, following a linked worktree back to its main
// checkout — the renderer groups the agent roster by this.
ipcMain.handle('git:mainRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return null;
  return mainRepoRoot(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});
ipcMain.handle('git:diff', (_evt, cwd: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getDiff(cwd, relPath);
});
// ─── v0.3.4: history / compare / checkout (git visualization) ───────────────
ipcMain.handle('git:logGraph', (_evt, cwd: unknown, n: unknown, skip: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  const count = Math.min(500, Math.max(1, typeof n === 'number' ? n : 200));
  const off = Math.max(0, typeof skip === 'number' ? skip : 0);
  return getLogGraph(cwd, count, off);
});
ipcMain.handle('git:commitFiles', (_evt, cwd: unknown, sha: unknown) => {
  if (typeof cwd !== 'string' || typeof sha !== 'string') return { error: 'invalid args' };
  return getCommitFiles(cwd, sha);
});
ipcMain.handle('git:showFile', (_evt, cwd: unknown, rev: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof rev !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getFileAtRev(cwd, rev, relPath);
});
ipcMain.handle('git:compareRefs', (_evt, cwd: unknown, base: unknown, head: unknown, mode: unknown) => {
  if (typeof cwd !== 'string' || typeof base !== 'string' || typeof head !== 'string') {
    return { error: 'invalid args' };
  }
  return compareRefs(cwd, base, head, mode === 'two' ? 'two' : 'three');
});
ipcMain.handle('git:worktrees', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  return listWorktrees(cwd);
});
ipcMain.handle('git:checkout', async (_evt, cwd: unknown, ref: unknown, detach: unknown) => {
  if (typeof cwd !== 'string' || typeof ref !== 'string') return { ok: false, error: 'invalid args' };
  // Guard: never swap files under an actively-working agent. Objective signal
  // owned by main — any live pty whose cwd sits in this tree and emitted output
  // in the last 10s is treated as mid-run. (Idle-but-open terminals are fine:
  // checkoutRef additionally requires a clean tree, and TUIs redraw on fs
  // changes gracefully.)
  const busy = ptyManager.list().find((p) =>
    (p.cwd === cwd || p.cwd.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) &&
    Date.now() - p.lastOutputAt < 10_000
  );
  if (busy) {
    return { ok: false, error: `an agent is actively working in this repo (${busy.id}) — try again when it goes quiet` };
  }
  return checkoutRef(cwd, ref, detach === true);
});

// ─── IPC: roster mirror (shared between dev and a packaged build) ───────────
// The renderer's store is built synchronously at module load, before any async
// IPC could resolve, so the read is `ipcMain.on` + `returnValue` — one blocking
// round trip at boot, in exchange for the roster being correct on first paint
// instead of flashing an empty floor and then filling in.
// (`roster` itself is constructed earlier so HookServer can read standing goals.)
ipcMain.on('roster:readSync', (evt) => { evt.returnValue = roster.read(); });
ipcMain.on('config:homeSync', (evt) => { evt.returnValue = readConfig().harnessHome ?? null; });
ipcMain.handle('roster:read', () => roster.read());
ipcMain.handle('roster:write', (_evt, snap: unknown) => roster.write(snap));

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
ipcMain.handle('hive:renameAgent', (_evt, id: unknown, name: unknown) => {
  if (typeof id !== 'string' || typeof name !== 'string') {
    return { ok: false, error: 'Invalid rename request' };
  }
  return hive.renameAgent(id, name);
});
ipcMain.handle('hive:setAgentHold', (_evt, id: unknown, hold: unknown) => {
  if (typeof id !== 'string' || typeof hold !== 'boolean') {
    return { ok: false, error: 'Invalid hold request' };
  }
  return hive.setAgentHold(id, hold);
});
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
// ─── Critical connections (shared/criticalConnections.ts) ───────────────────
// One custodian agent per critical connection or REST API. Everyone else is
// left out at spawn AND refused by the gateway / broker on every call.

/** Whether the app can build an OS sandbox where this floor's agents run
 *  (bubblewrap on Linux or in the WSL distro): what a pi custodian needs.
 *  Refreshed whenever a custodian is chosen or an agent starts. */
let appSandbox = false;

function criticalMap(): CriticalMap {
  return cleanCriticalMap(readConfig().criticalCustodians);
}

function agentProviderOf(agentId: string | undefined): string | undefined {
  if (!agentId || !hive.enabled()) return undefined;
  return hive.registry().agents?.[agentId]?.provider ?? 'claude';
}

function criticalLabel(kind: CriticalKind, id: string): string {
  if (kind === 'api') return integrations.getRecord(id)?.label ?? id;
  if (id.startsWith('custom--')) return (readConfig().customMcp ?? []).find((c) => c.id === id)?.name ?? id;
  return listConnections().find((c) => c.id === id)?.label ?? id;
}

/** Why this agent may not use a critical connection right now, or null (not
 *  critical, or it is the custodian, on an engine that qualifies). */
function criticalRefusalFor(kind: CriticalKind, id: string, agentId: string | undefined): string | null {
  const map = criticalMap();
  const custodian = custodianOf(map, kind, id);
  if (custodian === undefined) return null;
  const reg = custodian && hive.enabled() ? hive.registry().agents?.[custodian] : undefined;
  const name = reg ? reg.name : undefined;
  if (!criticalAllows(map, kind, id, agentId)) return criticalRefusal(criticalLabel(kind, id), name);
  // The custodian itself, on an engine the app cannot lock down: refused too.
  if (!canBeCustodian(agentProviderOf(agentId), { osSandbox: appSandbox })) return `${criticalLabel(kind, id)} is a critical connection, and only a Claude Code agent, or a pi agent on a Linux or WSL floor with bubblewrap, can hold one. Ask the human to choose another custodian under Connections.`;
  return null;
}

/** The tool groups taken from an agent: what Capabilities says, plus Web for
 *  the custodian of a critical connection (always, so its data cannot be
 *  posted to the open web). */
function toolBlocksFor(agentId: string): string[] {
  const blocks = cleanToolBlocks(readConfig().agentToolBlocks?.[agentId]);
  if (isCustodian(criticalMap(), agentId) && !blocks.includes('web')) blocks.push('web');
  return blocks;
}

/** The names of the critical connections an agent holds, for its prompt. */
function criticalLabelsFor(agentId: string, provider: string | undefined): string[] {
  if (!canBeCustodian(provider, { osSandbox: appSandbox })) return [];
  const map = criticalMap();
  return [...heldIds(map, agentId, 'mcp').map((id) => criticalLabel('mcp', id)), ...heldIds(map, agentId, 'api').map((id) => criticalLabel('api', id))];
}

/** Audit of every call to a critical connection: who, what, when, allowed.
 *  Never arguments, queries or bodies. Kept in the app's own folder, outside
 *  the hive (agents are not given it). */
interface CriticalAuditEntry { ts: number; kind: CriticalKind; id: string; agentId: string; call: string; allowed: boolean; ok?: boolean }
function criticalAuditPath(): string { return join(app.getPath('userData'), 'critical-audit.jsonl'); }
function criticalAudit(e: CriticalAuditEntry): void {
  try {
    const name = hive.enabled() ? hive.registry().agents?.[e.agentId]?.name : undefined;
    appendFileSync(criticalAuditPath(), JSON.stringify({ time: new Date(e.ts).toISOString(), ...e, ...(name ? { agentName: name } : {}) }) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (err) { console.error('[critical] audit write failed:', err); }
}
function readCriticalAudit(kind: CriticalKind, id: string, limit = 100): Array<CriticalAuditEntry & { time: string; agentName?: string }> {
  let text = '';
  try { text = readFileSync(criticalAuditPath(), 'utf8'); } catch { return []; }
  const out: Array<CriticalAuditEntry & { time: string; agentName?: string }> = [];
  for (const line of text.split('\n').reverse()) {
    if (out.length >= limit) break;
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e.kind === kind && e.id === id) out.push(e); } catch { /* torn line */ }
  }
  return out;
}

ipcMain.handle('critical:set', async (_evt, kind: unknown, id: unknown, critical: unknown, custodian: unknown) => {
  if ((kind !== 'mcp' && kind !== 'api') || typeof id !== 'string' || !id) return { ok: false, error: 'bad request' };
  const known = kind === 'api' ? !!integrations.getRecord(id) : (id.startsWith('custom--') ? (readConfig().customMcp ?? []).some((c) => c.id === id) : !!serviceOf(id));
  if (!known) return { ok: false, error: 'unknown connection' };
  let who = '';
  if (critical === true && typeof custodian === 'string' && custodian) {
    const a = hive.enabled() ? hive.registry().agents?.[custodian] : undefined;
    if (!a || a.status === 'gone' || a.archived) return { ok: false, error: 'unknown agent' };
    if (a.isGod) return { ok: false, error: 'the orchestrator routes everyone\'s work; choose another agent as custodian' };
    if (a.temp) return { ok: false, error: 'a temp is gone after one job and never holds a critical connection; choose a lasting agent as custodian' };
    if (a.provider === 'pi' && !(appSandbox = await hive.sandboxAvailable())) return { ok: false, error: 'a pi agent can be a custodian only where the app can sandbox it: a Linux or WSL floor with bubblewrap. Use a WSL floor, or a Claude Code agent.' };
    if (!canBeCustodian(a.provider, { osSandbox: appSandbox })) return { ok: false, error: 'only a Claude Code agent, or a pi agent on a Linux or WSL floor, can be a custodian' };
    if (unsandboxedAgents(readConfig().agentUnsandboxed).includes(custodian)) return { ok: false, error: `${a.name ?? custodian} runs without its sandbox (Capabilities). Turn that off first: a custodian always runs sandboxed.` };
    who = custodian;
  }
  writeConfig({ criticalCustodians: setCritical(criticalMap(), kind, id, critical === true, who) });
  return { ok: true };
});

// ─── Run without sandbox (shared/unsandboxed.ts) ────────────────────────────
// The human's own switch: only this handler sets agentUnsandboxed (the generic
// config write drops it), turning it on needs the agent's name typed back, a
// custodian is refused, and every change is written to the hive's log.
ipcMain.handle('agent:setUnsandboxed', (_evt, agentId: unknown, on: unknown, typed: unknown) => {
  if (typeof agentId !== 'string' || !agentId || typeof on !== 'boolean') return { ok: false, error: 'bad request' };
  const a = hive.enabled() ? hive.registry().agents?.[agentId] : undefined;
  const name = a?.name ?? agentId;
  const why = unsandboxRefusal({ on, name, typed, custodian: isCustodian(criticalMap(), agentId), known: !!a });
  if (why) return { ok: false, error: why };
  const cur = unsandboxedAgents(readConfig().agentUnsandboxed);
  const next = on ? [...new Set([...cur, agentId])] : cur.filter((x) => x !== agentId);
  writeConfig({ agentUnsandboxed: next });
  try { hive.appendLog({ kind: 'unsandboxed', agentId, name, on, by: 'human' }); hive.commit(`hive: ${name} ${on ? 'runs without its sandbox' : 'runs in its sandbox again'}`); } catch { /* the config change stands */ }
  console.warn(`[hive] ${name} (${agentId}) ${on ? 'will run WITHOUT its OS sandbox' : 'runs in its OS sandbox again'} from its next start`);
  return { ok: true };
});
// ─── Confidential vaults (criticalConnections.ts) ───────────────────────────
// <office home>/confidential/<kind>-<id>: the custodian's raw material and the
// human's full reports. Outside the hive's git repo, never indexed, denied to
// every other agent (guard + sandbox denyRead + permission rules).

function vaultRoot(): string | null {
  const home = readConfig().harnessHome;
  return home ? join(expandTilde(home), VAULT_ROOT) : null;
}

function vaultDir(kind: CriticalKind, id: string): string | null {
  const root = vaultRoot();
  return root ? join(root, vaultName(kind, id)) : null;
}

/** Create a vault with owner-only permissions: chmod 700 on Linux/macOS and,
 *  for a WSL floor, inside the distro. On Windows the folder inherits the
 *  user profile's ACL (only this user). */
async function ensureVault(dir: string): Promise<void> {
  mkdirSync(join(dir, VAULT_REQUESTS), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'reports'), { recursive: true, mode: 0o700 });
  const w = parseWslPath(dir);
  if (w) {
    try { await runInDistroAsync(w.distro, 'chmod', ['-R', 'go-rwx', w.linuxPath], '/'); } catch (e) { console.error('[critical] chmod vault in WSL failed:', e); }
  } else if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o700); chmodSync(dirname(dir), 0o700); } catch { /* best effort */ }
  }
}

/** What an agent gets at spawn: the vaults it may write (its own, created
 *  now) and the folders it may not read. */
async function prepareVaults(agentId: string, provider: string | undefined): Promise<{ own: string[]; deny: string[]; denyOwners: Record<string, string[]>; custodian: boolean }> {
  const root = vaultRoot();
  const map = criticalMap();
  const custodian = canBeCustodian(provider, { osSandbox: appSandbox = await hive.sandboxAvailable() }) && isCustodian(map, agentId);
  // Every other custodian's own folder (its memory, notes, held mail) and its
  // Claude Code transcripts are as confidential as its vault.
  const others = hive.enabled() ? [...new Set(Object.values(map))].filter((id) => id && id !== agentId) : [];
  // Who a refused agent may ask about each folder (toolGuard.ts); none: not for agents.
  const denyOwners: Record<string, string[]> = {};
  // Its name and the id its mail goes to ("Dwight (worker-dwight)").
  const who = (id: string): string => {
    const name = hive.enabled() ? hive.registry().agents?.[id]?.name : undefined;
    return name && name !== id ? `${name} (${id})` : id;
  };
  const theirs = others.flatMap((id) => { const d = hive.agentFolder(id); denyOwners[d] = [who(id)]; denyOwners[projectDir(d)] = [who(id)]; return [d, projectDir(d)]; });
  if (!root) return { own: [], deny: theirs, denyOwners, custodian };
  // A real folder before anyone is denied it: see vaultRoot.ts.
  try { if (!ensureVaultRoot(root)) console.error('[critical] vault root is not a folder:', root); } catch (e) { console.error('[critical] vault root', e); }
  const access = vaultAccess(map, custodian ? agentId : undefined);
  const own: string[] = [];
  for (const name of access.own) {
    const dir = join(root, name);
    try { await ensureVault(dir); own.push(dir); } catch (e) { console.error('[critical] vault', name, e); }
  }
  if (custodian) {
    try { mkdirSync(join(hive.agentFolder(agentId), 'outgoing'), { recursive: true }); } catch { /* made on first use */ }
  }
  // A custodian never reads the Slack reply key (an agent posting to Slack is a way out).
  const slackKey = custodian ? [slackReplyConfigPath()] : [];
  const holders = (name?: string) => [...new Set(Object.entries(map)
    .filter(([k, v]) => v && v !== agentId && (name === undefined || vaultName(k.slice(0, 3) as CriticalKind, k.slice(4)) === name))
    .map(([, v]) => who(v)))];
  const vaults = access.denyAll ? [root] : access.denyOthers.map((n) => join(root, n));
  if (access.denyAll) denyOwners[root] = holders();
  else for (const n of access.denyOthers) denyOwners[join(root, n)] = holders(n);
  return { own, deny: [...vaults, ...theirs, ...slackKey], denyOwners, custodian };
}

/** Hosts of the critical connections an agent holds: links to them are redacted. */
function criticalHosts(agentId: string): string[] {
  const map = criticalMap();
  const hosts = new Set<string>();
  const add = (u: string | undefined) => { try { if (u) hosts.add(new URL(u).hostname); } catch { /* not a URL */ } };
  for (const id of heldIds(map, agentId, 'api')) add(integrations.getRecord(id)?.baseUrl);
  for (const id of heldIds(map, agentId, 'mcp')) {
    const c = (readConfig().customMcp ?? []).find((x) => x.id === id);
    if (c?.transport.kind === 'http') add(c.transport.url);
  }
  return [...hosts];
}

// What a custodian sends is redacted (the safety net under its prompt) and
// then held: nothing leaves without the human's sign-off, whatever it says.
hive.setOutgoing((msg) => {
  if (!isCustodian(criticalMap(), msg.from)) return { msg };
  const hosts = criticalHosts(msg.from);
  const subject = redactConfidential(msg.subject, { hosts });
  const body = redactConfidential(msg.body, { hosts });
  const total = redactionTotal(subject) + redactionTotal(body);
  const counts: Record<string, number> = {};
  for (const c of [subject.counts, body.counts]) for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] ?? 0) + (v ?? 0);
  const kinds = Object.keys(counts).join(', ');
  holdForSignoff({
    id: `msg-${msg.id}`, kind: 'message', from: msg.from, createdAt: Date.now(), to: msg.to, act: msg.act,
    subject: subject.text, text: body.text, redactions: counts,
    messageId: msg.id, conversation: msg.conversation, inReplyTo: msg.in_reply_to
  });
  return { msg, hold: true, note: total ? `${total} redaction(s): ${kinds}` : undefined };
});

// ─── Sign-off (shared/criticalSignoff.ts) ───────────────────────────────────
// Everything a custodian sends out waits here, in the app's own folder (no
// agent reads it), until the human approves, edits or rejects it. Nothing
// times out into sending.

function pendingPath(): string { return join(app.getPath('userData'), 'critical-pending.json'); }
function readPending(): PendingItem[] {
  try { const j = JSON.parse(readFileSync(pendingPath(), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}
function writePending(items: PendingItem[]): void {
  writeFileSync(pendingPath(), JSON.stringify(items, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function auditFor(agentId: string, call: string, allowed: boolean): void {
  for (const k of custodianships(criticalMap(), agentId)) criticalAudit({ ts: Date.now(), kind: k.slice(0, 3) as CriticalKind, id: k.slice(4), agentId, call, allowed });
}
function holdForSignoff(item: PendingItem): void {
  const items = readPending().filter((x) => x.id !== item.id);
  items.push(item);
  writePending(items);
  auditFor(item.from, `held for sign-off: ${item.kind === 'message' ? `message to ${item.to}` : `file ${item.file}`}`, true);
  const name = hive.registry().agents?.[item.from]?.name ?? item.from;
  try { liveWebContents()?.send('critical:pending', { count: items.length }); } catch { /* window gone */ }
  try {
    if (Notification.isSupported()) new Notification({ title: `${name} needs your sign-off`, body: item.kind === 'message' ? `A message to ${item.to}, held until you approve it (Inbox → For you).` : `A file for the deliverables, held until you approve it (Inbox → For you).` }).show();
    const w = mainWindow; if (w && !w.isDestroyed()) w.flashFrame(true);
  } catch { /* notifications are best effort */ }
}

/** Files a custodian puts in its outgoing/ folder for research/: taken in,
 *  redacted and held for sign-off (the file itself is removed). */
function scanCustodianOutgoing(): void {
  if (!hive.enabled()) return;
  for (const id of new Set(Object.values(criticalMap()))) {
    if (!id) continue;
    const dir = join(hive.agentFolder(id), 'outgoing');
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const file = cleanDeliverableName(n);
      const abs = join(dir, n);
      try {
        const st = statSync(abs);
        if (!st.isFile()) continue;
        // A file still being written: wait a beat.
        if (Date.now() - st.mtimeMs < 2000) continue;
        if (!file || st.size > 2 * 1024 * 1024) { rmSync(abs, { force: true }); auditFor(id, `outgoing file refused: ${n}`, false); continue; }
        const r = redactConfidential(readFileSync(abs, 'utf8'), { hosts: criticalHosts(id) });
        rmSync(abs, { force: true });
        holdForSignoff({ id: `file-${Date.now().toString(36)}-${file}`, kind: 'deliverable', from: id, createdAt: Date.now(), file, text: r.text, redactions: r.counts });
      } catch (e) { console.error('[critical] outgoing', abs, e); }
    }
  }
}
setInterval(() => { try { scanCustodianOutgoing(); } catch (e) { console.error('[critical] scan', e); } }, 5000).unref?.();

ipcMain.handle('critical:pendingList', () => readPending().map((p) => ({ ...p, fromName: (hive.enabled() ? hive.registry().agents?.[p.from]?.name : undefined) ?? p.from })));
ipcMain.handle('critical:decide', (_evt, itemId: unknown, decision: unknown) => {
  const items = readPending();
  const item = items.find((x) => x.id === itemId);
  if (!item || !decision || typeof decision !== 'object') return { ok: false, error: 'bad request' };
  const out = decide(item, decision as Decision, Date.now(), (t) => createHash('sha256').update(t).digest('hex'));
  if (out.deliver) {
    if (item.kind === 'message') {
      hive.send({ to: item.to, act: item.act as MessageAct, subject: out.deliver.subject ?? '', body: out.deliver.text, conversation: item.conversation, in_reply_to: item.inReplyTo ?? null }, item.from);
    } else {
      const root = hive.root();
      if (!root) return { ok: false, error: 'no office' };
      const research = join(root, DELIVERABLES_DIR);
      mkdirSync(research, { recursive: true });
      let target = join(research, item.file!);
      for (let i = 2; existsSync(target); i++) target = join(research, item.file!.replace(/(\.[^.]*)?$/, `-${i}$1`));
      writeFileSync(target, out.deliver.text, 'utf8');
      queueDeliverableCommit(item.from, root, [target]);
    }
  } else if (out.bounce) {
    hive.send({ to: item.from, act: 'inform', subject: out.bounce.subject, body: out.bounce.body }, 'human');
  }
  const a = out.audit;
  auditFor(item.from, `${a.action} by the human: ${item.kind === 'message' ? `message to ${item.to}` : `file ${item.file}`}${a.sha256 ? ` sha256=${a.sha256}` : ''}`, a.action !== 'rejected');
  writePending(items.filter((x) => x.id !== item.id));
  try { liveWebContents()?.send('critical:pending', { count: items.length - 1 }); } catch { /* window gone */ }
  return { ok: true };
});

function vaultFiles(dir: string): Array<{ rel: string; size: number; mtime: number }> {
  const out: Array<{ rel: string; size: number; mtime: number }> = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    if (depth > 4 || out.length >= 500) return;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const a = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(a, r, depth + 1);
      else if (e.isFile()) { try { const st = statSync(a); out.push({ rel: r, size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ } }
    }
  };
  walk(dir, '', 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

const vaultArgs = (kind: unknown, id: unknown): string | null =>
  (kind === 'mcp' || kind === 'api') && typeof id === 'string' && isCritical(criticalMap(), kind, id) ? vaultDir(kind, id) : null;

// The human only: these are renderer IPC (the app window), never reachable by
// an agent, which talks to the app through hooks, the gateway and the broker.
ipcMain.handle('critical:vaultList', (_evt, kind: unknown, id: unknown) => {
  const dir = vaultArgs(kind, id);
  return dir ? { dir, files: vaultFiles(dir) } : { dir: null, files: [] };
});
ipcMain.handle('critical:vaultRead', (_evt, kind: unknown, id: unknown, rel: unknown) => {
  const dir = vaultArgs(kind, id);
  const clean = vaultRelPath(rel);
  if (!dir || !clean) return { ok: false, error: 'bad request' };
  const abs = join(dir, ...clean.split('/'));
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > 20 * 1024 * 1024) return { ok: false, error: 'not a readable file' };
    const buf = readFileSync(abs);
    const binary = /\.pdf$/i.test(clean) || buf.subarray(0, 4096).includes(0);
    return binary ? { ok: true, base64: buf.toString('base64') } : { ok: true, text: buf.toString('utf8') };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('critical:vaultReveal', async (_evt, kind: unknown, id: unknown) => {
  const dir = vaultArgs(kind, id);
  if (!dir) return { ok: false, error: 'bad request' };
  await ensureVault(dir);
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true };
});
// The human asks the custodian for a full, unredacted report: the request is
// filed in the vault (the only channel that is the human's alone) and the
// custodian is told where it is. The report goes back into the vault.
ipcMain.handle('critical:requestReport', async (_evt, kind: unknown, id: unknown, text: unknown) => {
  const dir = vaultArgs(kind, id);
  const custodian = (kind === 'mcp' || kind === 'api') && typeof id === 'string' ? custodianOf(criticalMap(), kind, id) : undefined;
  if (!dir || !custodian || typeof text !== 'string' || !text.trim()) return { ok: false, error: 'bad request' };
  await ensureVault(dir);
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  const file = join(dir, VAULT_REQUESTS, name);
  writeFileSync(file, `# Full report requested by the human\n\n${text.trim().slice(0, 4000)}\n`, { encoding: 'utf8', mode: 0o600 });
  criticalAudit({ ts: Date.now(), kind: kind as CriticalKind, id: id as string, agentId: 'human', call: `full report requested: ${VAULT_REQUESTS}/${name}`, allowed: true });
  const where = hive.forAgent(file);
  try { liveWebContents()?.send('hive:enqueueToAgent', { targetId: custodian, text: `The human filed a full-report request in your confidential vault: ${where}. Read it, write the unredacted report into the vault's reports/ folder only, and answer with a pointer to the file.` }); } catch { /* window gone */ }
  return { ok: true, file: `${VAULT_REQUESTS}/${name}` };
});
ipcMain.handle('critical:audit', (_evt, kind: unknown, id: unknown) =>
  (kind === 'mcp' || kind === 'api') && typeof id === 'string' ? readCriticalAudit(kind, id) : []);
ipcMain.handle('critical:revealAudit', () => {
  const p = criticalAuditPath();
  if (!existsSync(p)) return { ok: false, error: 'no calls yet' };
  shell.showItemInFolder(p);
  return { ok: true };
});

/** The REST APIs one agent may use, and how (Connections → REST APIs): enabled,
 *  its "who" list, and the lower of the API's limit and the agent's role. */
function apisFor(agentId: string): { ids: string[]; access: Record<string, Access> } {
  const cfg = readConfig();
  const ids: string[] = [];
  const access: Record<string, Access> = {};
  const critical = cleanCriticalMap(cfg.criticalCustodians);
  const held = isCustodian(critical, agentId) ? new Set(heldIds(critical, agentId, 'api')) : null;
  for (const id of integrations.enabledIds()) {
    // Critical: its custodian only; a custodian only its critical APIs.
    if (criticalRefusalFor('api', id, agentId) || (held && !held.has(id))) continue;
    const scope = cfg.integrationScopes?.[id];
    if (Array.isArray(scope) && !scope.includes(agentId)) continue;
    const a = effectiveApiAccess(cfg.integrationPolicy?.[id], cfg.agentMcpAccess?.[agentId], id);
    if (a === 'none') continue;
    ids.push(id);
    access[id] = a;
  }
  return { ids, access };
}

/** Why an agent may not use a REST API right now, in the words the agent (and
 *  the human reading its log) need to fix it. */
function apiDenyReason(agentId: string, id: string): string | undefined {
  const rec = integrations.getRecord(id);
  if (!rec) return `there is no REST API "${id}" in Connections`;
  if (!rec.enabled) return 'it is switched off in Connections → REST APIs';
  if (rec.authType !== 'none' && !integrations.hasSecret(rec.secretRef)) return 'its key has not been saved in Connections → REST APIs';
  const cfg = readConfig();
  const critical = criticalRefusalFor('api', id, agentId);
  if (critical) return critical;
  const scope = cfg.integrationScopes?.[id];
  if (Array.isArray(scope) && !scope.includes(agentId)) return 'it is limited to other agents (Connections → Who may use each REST API)';
  if (effectiveApiAccess(cfg.integrationPolicy?.[id], cfg.agentMcpAccess?.[agentId], id) === 'none') return 'its limit, or this agent\'s role, gives it no access';
  return undefined;
}

// Deliverables ↔ tasks: when an agent writes a file in research/, it is linked
// to the task the agent has in "doing". Kept in deliverableLinks.json, which only
// main writes — tasks.json stays the orchestrator's.
function readDeliverableLinks(): DeliverableLink[] {
  const root = hive.enabled() ? hive.root() : null;
  if (!root) return [];
  try {
    const raw = JSON.parse(readFileSync(join(root, 'deliverableLinks.json'), 'utf8')) as { links?: unknown };
    return Array.isArray(raw.links) ? raw.links.filter((l): l is DeliverableLink => !!l && typeof l.path === 'string' && typeof l.taskId === 'string') : [];
  } catch { return []; }
}
function readElsewhereWrites(root: string): ElsewhereWrite[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'deliverableElsewhere.json'), 'utf8')) as { files?: unknown };
    return Array.isArray(raw.files) ? raw.files.filter((f): f is ElsewhereWrite => !!f && typeof f.path === 'string' && typeof f.ts === 'number') : [];
  } catch { return []; }
}
function recordElsewhereWrites(root: string, agentId: string, paths: string[], ts: number): void {
  const before = readElsewhereWrites(root);
  const name = hive.registry().agents?.[agentId]?.name ?? agentId;
  const next = recordElsewhere(before, paths.map((path) => ({ path, agentId, name, ts, created: false })));
  if (next === before) return;
  try { writeFileSync(join(root, 'deliverableElsewhere.json'), JSON.stringify({ files: next }, null, 2)); }
  catch (err) { console.error('[deliverables] could not record a file written elsewhere:', err); }
}
// Deliverables keep a history with an author: what an agent writes in
// research/ is committed as that agent a few seconds later (several writes in
// a row become one commit), so `git log` says who changed each file and when.
const pendingDeliverableCommits = new Map<string, { rels: Set<string>; timer: ReturnType<typeof setTimeout> }>();
function hiveRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/').replace(/\\/g, '/');
}
function queueDeliverableCommit(agentId: string, root: string, abs: string[]): void {
  const entry = pendingDeliverableCommits.get(agentId) ?? { rels: new Set<string>(), timer: undefined as unknown as ReturnType<typeof setTimeout> };
  for (const p of abs) entry.rels.add(hiveRel(root, p));
  hive.holdDeliverables([...entry.rels]);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    pendingDeliverableCommits.delete(agentId);
    const name = hive.registry().agents?.[agentId]?.name ?? agentId;
    try { hive.commitDeliverables([...entry.rels], { id: agentId, name }); }
    catch (err) { console.error('[deliverables] could not commit:', err); }
  }, 3000);
  pendingDeliverableCommits.set(agentId, entry);
}

hookServer.onStep = (agentId, e) => {
  // Any CLI: the files main worked out for this call (Write, apply_patch, write_to_file…).
  const written = writtenFiles([e]).map((f) => f.path);
  if (!written.length) return;
  const root = hive.enabled() ? hive.root() : null;
  if (!root) return;
  const wsl = hive.wslRoot();
  const research = join(root, DELIVERABLES_DIR);
  const host = written.map((p) => (wsl ? fromLinuxPath(p, wsl.distro, () => distroHomeUnc(wsl.distro)) : p));
  // Documents written anywhere else (the hive's own files aside) are kept too,
  // so "written elsewhere" outlives the session.
  const elsewhere = host.filter((p) => !isInside(p, root) && isDeliverableLike(p));
  if (elsewhere.length) recordElsewhereWrites(root, agentId, elsewhere, e.ts ?? Date.now());
  const paths = host.filter((p) => isInside(p, research));
  if (!paths.length) return;
  queueDeliverableCommit(agentId, root, paths);
  const taskId = currentTaskOf((hive.tasks() as { tasks?: Array<{ id: string; assignee?: string; status?: string; createdAt?: string }> }).tasks ?? [], agentId);
  if (!taskId) return;
  let links = readDeliverableLinks();
  const before = links;
  for (const path of paths) if (linkFor(links, path)?.taskId !== taskId) links = addLink(links, { path, taskId, agentId, ts: e.ts ?? Date.now() });
  if (links === before) return;
  try { writeFileSync(join(root, 'deliverableLinks.json'), JSON.stringify({ links }, null, 2)); }
  catch (err) { console.error('[deliverables] could not record a link:', err); }
};

// Deliverables (shared/deliverables.ts): the office's research/ folder, newest
// first, the files each agent wrote this session (from its tool calls), and the
// documents agents wrote elsewhere (kept in the hive across restarts).
// Metadata only; the viewer reads a file through the root-confined fs IPC.
ipcMain.handle('deliverables:list', async () => {
  const root = hive.enabled() ? hive.root() : null;
  if (!root) return { root: null, dir: null, distro: null, files: [], written: [], links: [], elsewhere: [], total: 0, truncated: false };
  // A WSL floor: agents write Linux paths; the app opens them through \\wsl.localhost.
  const wsl = hive.wslRoot();
  const toHost = (p: string): string => (wsl ? fromLinuxPath(p, wsl.distro, () => distroHomeUnc(wsl.distro)) : p);
  const { stat } = await import('node:fs/promises');
  const dir = join(root, DELIVERABLES_DIR);
  const { files, total, truncated } = await scanDeliverables(dir, { skipTop: ['hires'] });
  // An agent's own hive folder (memory, inbox) is bookkeeping, not a deliverable.
  const agentsDir = join(root, 'agents');
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
  const written = Object.values(hive.registry().agents).flatMap((a) =>
    writtenFiles(hookServer.stepsFor(a.id))
      .map((f) => ({ ...f, path: toHost(f.path) }))
      .filter((f) => !norm(f.path).startsWith(norm(agentsDir) + '/'))
      .map((f) => ({ ...f, agentId: a.id, name: a.name }))
  ).sort((x, y) => y.ts - x.ts).slice(0, 200);
  // Who changed each research/ file, from its git history (agents only).
  let authors: Record<string, { authors: string[]; last: string; lastTs: string }> = {};
  try { authors = await hive.fileAuthorsAsync(DELIVERABLES_DIR); } catch { /* no history yet */ }
  // Written elsewhere: the kept list plus this session's, documents only; a
  // file deleted since drops out.
  const kept = recordElsewhere(readElsewhereWrites(root), written
    .filter((w) => !isInside(w.path, root) && isDeliverableLike(w.path))
    .map((w) => ({ path: w.path, agentId: w.agentId, name: w.name, ts: w.ts, created: w.created })));
  const elsewhere = (await Promise.all(kept.slice(-200).map(async (w) => {
    try { const s = await stat(w.path); return s.isFile() ? { ...w, size: s.size, mtime: s.mtimeMs } : null; } catch { return null; }
  }))).filter((w): w is NonNullable<typeof w> => !!w).reverse();
  return { root, dir, distro: wsl?.distro ?? null, files, total, truncated, written, elsewhere, links: readDeliverableLinks(), hidden: readHiddenDeliverables(), authors };
});
/** A deliverable path as the hive repo names it, or null when outside research/. */
function deliverableRel(p: unknown): string | null {
  const root = hive.enabled() ? hive.root() : null;
  if (!root || typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) return null;
  const abs = resolve(p);
  return isInside(abs, resolve(root, DELIVERABLES_DIR)) ? hiveRel(root, abs) : null;
}
ipcMain.handle('deliverables:history', (_evt, p: unknown) => {
  const rel = deliverableRel(p);
  return rel ? hive.fileHistory(rel) : [];
});
ipcMain.handle('deliverables:diff', (_evt, p: unknown, hash: unknown) => {
  const rel = deliverableRel(p);
  if (!rel || typeof hash !== 'string') return { ok: false, error: 'bad request' };
  const diff = hive.fileDiff(rel, hash);
  return diff === null ? { ok: false, error: 'that version is not in the history' } : { ok: true, diff };
});
ipcMain.handle('deliverables:version', (_evt, p: unknown, hash: unknown) => {
  const rel = deliverableRel(p);
  if (!rel || typeof hash !== 'string') return { ok: false, error: 'bad request' };
  const text = hive.fileAt(rel, hash);
  return text === null ? { ok: false, error: 'that version is not in the history' } : { ok: true, text };
});

// Hidden deliverables: paths the human put out of sight. Only the listing
// changes; the file stays. Kept in the hive beside deliverableLinks.json.
function readHiddenDeliverables(): string[] {
  const root = hive.enabled() ? hive.root() : null;
  if (!root) return [];
  try {
    const raw = JSON.parse(readFileSync(join(root, 'deliverableHidden.json'), 'utf8')) as { paths?: unknown };
    return Array.isArray(raw.paths) ? raw.paths.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
ipcMain.handle('deliverables:setHidden', (_evt, p: unknown, hidden: unknown) => {
  const root = hive.enabled() ? hive.root() : null;
  if (!root || typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) return { ok: false, error: 'bad request' };
  const key = (x: string) => x.replace(/\\/g, '/').toLowerCase();
  const next = readHiddenDeliverables().filter((x) => key(x) !== key(p));
  if (hidden === true) next.push(p);
  try { writeFileSync(join(root, 'deliverableHidden.json'), JSON.stringify({ paths: next.slice(-5000) }, null, 2)); }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  return { ok: true };
});
// Delete a deliverable: only a file in the office's research/ folder (what an
// agent wrote into a project is the project's, so that can only be hidden).
// To the trash first; `permanent` only after the human confirmed that the
// trash is not available here (common on a WSL path or a bare Linux desktop).
ipcMain.handle('deliverables:delete', async (_evt, p: unknown, permanent: unknown) => {
  const root = hive.enabled() ? hive.root() : null;
  if (!root || typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) return { ok: false, error: 'bad request' };
  const target = resolve(p);
  if (!isInside(target, resolve(root, DELIVERABLES_DIR))) return { ok: false, error: 'only files in the office deliverables folder can be deleted' };
  try { if (!lstatSync(target).isFile()) return { ok: false, error: 'not a file' }; } catch { return { ok: false, error: 'not found' }; }
  if (permanent === true) {
    try { unlinkSync(target); return { ok: true }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  try { await shell.trashItem(target); return { ok: true }; }
  catch (e) { return { ok: false, noTrash: true, error: e instanceof Error ? e.message : String(e) }; }
});
// Open a deliverable in its default program. Only document types (see
// canOpenExternally): the path comes from an agent, and fs:revealPath's rule
// stands for everything else — reveal, never run.
ipcMain.handle('deliverables:openExternal', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) return { ok: false, error: 'bad request' };
  if (!canOpenExternally(p)) return { ok: false, error: 'this kind of file is only shown in its folder' };
  const st = await statAbs(p);
  if (!st.exists || !st.isFile) return { ok: false, error: 'not found' };
  const err = await shell.openPath(st.path);
  return err ? { ok: false, error: err } : { ok: true };
});
// The URL an HTML deliverable renders from (deliverableFiles.ts): its links
// resolve inside the research/ folder for a file there, else inside its own
// folder. HTML only: everything else has its own viewer.
ipcMain.handle('deliverables:fileUrl', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0') || !/\.html?$/i.test(p)) return null;
  const st = await statAbs(p);
  if (!st.exists || !st.isFile) return null;
  const root = hive.enabled() ? hive.root() : null;
  const research = root ? resolve(root, DELIVERABLES_DIR) : null;
  return deliverableFiles.urlFor(research && isInside(st.path, research) ? research : dirname(st.path), st.path);
});
// A path clicked in an agent's terminal: the deliverable it is (as the list
// spells it), or null for any other file (the IDE opens those). The same files
// deliverables:list shows: research/, task links and cards, written elsewhere.
ipcMain.handle('deliverables:match', (_evt, p: unknown) => {
  const root = hive.enabled() ? hive.root() : null;
  if (!root || typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) return null;
  const distro = hive.wslRoot()?.distro ?? null;
  const toHost = (x: string): string => (distro ? fromLinuxPath(x, distro, () => distroHomeUnc(distro)) : x);
  const session = Object.values(hive.registry().agents).flatMap((a) => writtenFiles(hookServer.stepsFor(a.id)).map((f) => toHost(f.path)));
  const cards = ((hive.tasks() as { tasks?: Array<{ deliverable?: unknown }> }).tasks ?? [])
    .flatMap((x) => (typeof x?.deliverable === 'string' ? deliverablePaths(x.deliverable, root, distro) : []));
  const known = [
    ...readDeliverableLinks().map((l) => l.path),
    ...cards,
    ...[...readElsewhereWrites(root).map((w) => w.path), ...session].filter((x) => !isInside(x, root) && isDeliverableLike(x))
  ];
  return matchDeliverable(p, { researchDir: join(root, DELIVERABLES_DIR), distro, known });
});
// What the human typed straight into an agent's terminal, kept for the Inbox
// (the renderer knows which prompts were typed by a person). Main-only file.
ipcMain.handle('hive:keepHumanPrompt', (_evt, agentId: unknown) => {
  const root = hive.enabled() ? hive.root() : null;
  if (!root || typeof agentId !== 'string') return { ok: false };
  const p = hookServer.lastPrompt(agentId);
  if (!p) return { ok: false };
  try {
    appendFileSync(join(root, 'humanPrompts.jsonl'), JSON.stringify({ id: `hp-${agentId}-${p.ts}`, agentId, ts: new Date(p.ts).toISOString(), text: p.text }) + '\n');
    return { ok: true };
  } catch { return { ok: false }; }
});
ipcMain.handle('hive:humanPrompts', () => {
  const root = hive.enabled() ? hive.root() : null;
  if (!root) return [];
  try {
    return readFileSync(join(root, 'humanPrompts.jsonl'), 'utf8').split('\n').filter(Boolean).slice(-2000)
      .map((l) => { try { return JSON.parse(l) as { id: string; agentId: string; ts: string; text: string }; } catch { return null; } })
      .filter((x): x is { id: string; agentId: string; ts: string; text: string } => !!x);
  } catch { return []; }
});
ipcMain.handle('hive:steps', (_evt, agentId: unknown) => (typeof agentId === 'string' ? hookServer.stepsFor(agentId) : []));
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
// The memory graph's source (shared/memoryGraph.ts): every agent's memory.md
// and the research/ deliverables. Read asynchronously and capped: on a WSL
// floor each file is a slow read over \\wsl.localhost.
/**
 * The project an agent's memory belongs to: the repository its folder is in
 * (a worktree resolves to its main repository, through the `gitdir:` line of
 * its .git file), or "office" for the office itself. Async: on a WSL floor
 * each of these reads crosses \\wsl.localhost.
 */
async function memoryProjectOf(cwd: string | undefined, home: string): Promise<string> {
  if (!cwd) return 'office';
  const { readFile, stat } = await import('node:fs/promises');
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  if (home && (norm(cwd) === norm(home) || norm(cwd).startsWith(norm(join(home, 'hive'))))) return 'office';
  let cur = cwd;
  for (let i = 0; i < 32; i++) {
    const dotGit = join(cur, '.git');
    try {
      const st = await stat(dotGit);
      if (st.isDirectory()) return basename(cur);
      // A worktree: "gitdir: <repo>/.git/worktrees/<name>".
      const m = /gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/.exec(await readFile(dotGit, 'utf8'));
      return m ? basename(m[1].trim()) : basename(cur);
    } catch { /* not here: go up */ }
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return home && norm(cwd).startsWith(norm(home)) ? 'office' : basename(cwd);
}

// Personal lists (shared/lists.ts): hive/lists/<slug>.md, read and written
// asynchronously, only inside that folder, by a validated slug.
const listsDir = (): string | null => { const r = hive.root(); return r ? join(r, 'lists') : null; };
const validSlug = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(s);
ipcMain.handle('lists:all', async () => {
  const dir = listsDir();
  if (!dir) return [];
  const { readdir, readFile } = await import('node:fs/promises');
  let files: string[] = [];
  try { files = (await readdir(dir)).filter((f) => /^[a-z0-9][a-z0-9-]*\.md$/.test(f)); } catch { return []; }
  const out = await Promise.all(files.map(async (f) => {
    try { return parseList(f.replace(/\.md$/, ''), await readFile(join(dir, f), 'utf8')); } catch { return null; }
  }));
  return out.filter(Boolean).sort((a, b) => a!.title.localeCompare(b!.title));
});
ipcMain.handle('lists:save', async (_evt, list: unknown) => {
  const dir = listsDir();
  const l = list as PersonalList;
  if (!dir || !l || !validSlug(l.slug) || typeof l.title !== 'string' || !Array.isArray(l.sections)) return { ok: false, error: 'invalid list' };
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${l.slug}.md`), formatList(l), 'utf8');
  return { ok: true };
});
ipcMain.handle('lists:remove', async (_evt, slug: unknown) => {
  const dir = listsDir();
  if (!dir || !validSlug(slug)) return { ok: false };
  const { rm } = await import('node:fs/promises');
  await rm(join(dir, `${slug}.md`), { force: true });
  return { ok: true };
});

ipcMain.handle('hive:memoryCorpus', async () => {
  const root = hive.root();
  if (!root) return [];
  const { readFile, readdir } = await import('node:fs/promises');
  const PER_FILE = 64 * 1024;
  const out: Array<{ id: string; kind: 'agent' | 'doc'; label: string; agentId?: string; project: string; projectType: string; text: string }> = [];
  const reg = hive.registry();
  const home = readConfig().harnessHome ?? '';
  await Promise.all(Object.values(reg.agents ?? {}).map(async (a) => {
    try {
      const text = await readFile(join(root, 'agents', a.id, 'memory.md'), 'utf8');
      const project = await memoryProjectOf(a.cwd, home);
      out.push({ id: `agent:${a.id}`, kind: 'agent', label: a.name, agentId: a.id, project, projectType: hive.projectTypeOf(a.cwd), text: text.slice(0, PER_FILE) });
    } catch { /* no memory yet */ }
    // The orchestrator's work log (main/workLog.ts), written by the app.
    if (a.id === (reg.godId ?? 'god')) {
      try {
        const log = await readFile(join(root, 'agents', a.id, 'worklog.md'), 'utf8');
        out.push({ id: `agent:${a.id}:worklog`, kind: 'agent', label: a.name, agentId: a.id, project: await memoryProjectOf(a.cwd, home), projectType: hive.projectTypeOf(a.cwd), text: log.slice(-PER_FILE) });
      } catch { /* no work handed out yet */ }
    }
  }));
  try {
    const files = (await readdir(join(root, 'research'))).filter((f) => /\.(md|txt)$/i.test(f)).slice(0, 40);
    await Promise.all(files.map(async (f) => {
      try {
        const text = await readFile(join(root, 'research', f), 'utf8');
        out.push({ id: `doc:research/${f}`, kind: 'doc', label: f, project: 'office', projectType: hive.projectTypeOf(readConfig().harnessHome ?? undefined), text: text.slice(0, PER_FILE) });
      } catch { /* gone */ }
    }));
  } catch { /* no research yet */ }
  return out.sort((x, y) => x.id.localeCompare(y.id));
});
ipcMain.handle('hive:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inboxAsync(id) : []));
// Voice read-layer: recent message CONTENT (inbox/outbox bodies), REDACTED
// main-side by hive.voiceMessages(). The renderer/voice layer never sees a raw
// body — secrets are stripped here, before the result crosses IPC.
ipcMain.handle('hive:messages', (_evt, opts: unknown) =>
  hive.voiceMessages(opts && typeof opts === 'object' ? (opts as Parameters<typeof hive.voiceMessages>[0]) : {})
);
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const sender = typeof from === 'string' ? from : 'system';
  const msg = hive.send(partial ?? {}, sender);
  // Count only what a PERSON sent. Every renderer surface that dispatches on a
  // human's behalf passes 'human' (Command Center dispatch, thread replies, ASK
  // ME answers); agent-to-agent traffic passes the agent id and would swamp the
  // number. Counted AFTER the send so a rejected message is never counted.
  if (sender === 'human') analytics.trackMessageSent('hive');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:addTask', (_evt, task: unknown) => {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || typeof (task as { id?: unknown }).id !== 'string') {
    return { ok: false, error: 'invalid task' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.addTask(task as HiveTask) };
});
ipcMain.handle('hive:patchTask', (_evt, id: unknown, patch: unknown) => {
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid task patch' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>) };
});
ipcMain.handle('hive:deleteTask', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid task id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return { ok: hive.deleteTask(id) };
});
// The human edits / cancels cards; the agents on them are told by inbox.
ipcMain.handle('hive:editTasks', (_evt, edits: unknown) => {
  if (!Array.isArray(edits) || !edits.length || edits.some((e) => !e || typeof e !== 'object'
    || typeof (e as { id?: unknown }).id !== 'string' || !(e as { edit?: unknown }).edit || typeof (e as { edit?: unknown }).edit !== 'object')) {
    return { ok: false, error: 'invalid task edit' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return hive.editTasks(edits as Array<{ id: string; edit: TaskEdit }>);
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});
ipcMain.handle('hive:patchAgentRole', (_evt, id: unknown, role: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (typeof role !== 'string') return { ok: false, error: 'invalid role' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return hive.patchAgentRole(id, role);
});

// ─── IPC: Settings hero payload (remote data, cached) ───────────────────────
/** Plan copy and sponsor, fetched from the repo so they can change without a
 *  release. Validated in shared/heroPayload before it reaches the renderer. */
ipcMain.handle('hero:payload', async (_evt, force: unknown) =>
  loadHero(join(app.getPath('userData'), 'hero.json'), { force: force === true }));

// ─── IPC: model catalog (remote data, cached) ───────────────────────────────
/** The agent model presets, fetched from docs/model-catalog.json on main so a
 *  new model reaches installed copies without a release. Validated in
 *  shared/modelCatalogPayload; a null catalog means "keep the baked one". */
const MODEL_CATALOG_CACHE = () => join(app.getPath('userData'), 'model-catalog.json');
ipcMain.handle('models:catalog', async (_evt, force: unknown) =>
  loadModelCatalog(MODEL_CATALOG_CACHE(), { force: force === true }));

// ─── IPC: skills (installed locally, and the browsable catalog) ─────────────
/** Skills the CLIs on this machine can already use. Scans the registered repos
 *  plus the agent's own cwd, so a project-scoped skill shows up where it applies. */
ipcMain.handle('skills:local', (_evt, cwd: unknown): LocalSkill[] => {
  const cfg = readConfig();
  const cwds = [
    ...(typeof cwd === 'string' && cwd ? [cwd] : []),
    ...(cfg.registeredRepos ?? [])
  ];
  try {
    return listLocalSkills({ cwds, bundledDir: skillsResourceDir(), home: agentsHome() });
  } catch (e) {
    console.error('[skills] local scan failed:', e);
    return [];
  }
});
/** The skills catalog, parsed from its README and cached in userData.
 *  `force` is the explicit refresh button; everything else is served from a
 *  day-old cache so opening the tab never waits on the network. */
ipcMain.handle('skills:catalog', async (_evt, force: unknown) => fullSkillCatalog(force === true));

// Your own skill marketplaces (skillMarketplaces.ts): listed with their skills
// count (and the last error), added after one successful read, removed by URL.
ipcMain.handle('skills:marketplaces', async (_evt, force: unknown) =>
  (await loadMarketplaces(cleanMarketplaces(readConfig().skillMarketplaces), MARKETPLACE_CACHE(), force === true))
    .map((m) => ({ url: m.url, label: m.label, count: m.skills.length, fetchedAt: m.fetchedAt, error: m.error })));
ipcMain.handle('skills:addMarketplace', async (_evt, url: unknown, label: unknown) => {
  if (typeof url !== 'string') return { ok: false, error: 'invalid address' };
  const problem = marketplaceProblem(url);
  if (problem) return { ok: false, error: problem };
  const list = cleanMarketplaces(readConfig().skillMarketplaces);
  if (list.some((m) => m.url === url.trim())) return { ok: false, error: 'That marketplace is already added.' };
  const m = { url: url.trim(), ...(typeof label === 'string' && label.trim() ? { label: label.trim().slice(0, 60) } : {}) };
  const read = await loadMarketplace(m, MARKETPLACE_CACHE(), true);
  if (read.error && !read.skills.length) return { ok: false, error: `Could not read it: ${read.error}` };
  if (!read.skills.length) return { ok: false, error: 'No skills found there (each skill is a folder with a SKILL.md).' };
  writeConfig({ skillMarketplaces: [...list, m] });
  skillMirrorAt = 0;
  return { ok: true, count: read.skills.length };
});
ipcMain.handle('skills:removeMarketplace', (_evt, url: unknown) => {
  if (typeof url !== 'string') return { ok: false };
  writeConfig({ skillMarketplaces: cleanMarketplaces(readConfig().skillMarketplaces).filter((m) => m.url !== url.trim()) });
  skillMirrorAt = 0;
  return { ok: true };
});

/** Install one catalog skill into ~/.claude/skills. Structured refusals, never a
 *  throw: the UI distinguishes "not installable" from "install failed". */
ipcMain.handle('skills:install', async (_evt, url: unknown, name: unknown) => {
  if (typeof url !== 'string' || typeof name !== 'string') {
    return { ok: false as const, error: 'bad request' };
  }
  return installSkill(url, name, agentsHome());
});
/** Pick a folder holding SKILL.md and copy it into the agents' skills
 *  directory (the distro's on a WSL floor), under the download's rules. */
ipcMain.handle('skills:installFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Choose a skill folder (it holds SKILL.md)' });
  refocusAfterDialog(win);
  if (res.canceled || !res.filePaths[0]) return { ok: false as const, cancelled: true, error: 'cancelled' };
  return installSkillFromFolder(res.filePaths[0], agentsHome());
});
/** Office skills (given by the orchestrator, or taken away here by the human). */
ipcMain.handle('skills:office', () => hive.officeSkills());
ipcMain.handle('skills:officeRemove', (_evt, name: unknown) => {
  if (typeof name !== 'string') return { ok: false };
  const state = hive.officeSkills();
  const cur = state.skills[name];
  if (!cur) return { ok: false };
  delete state.skills[name];
  hive.writeOfficeSkills(state);
  const store = hive.officeSkillStore();
  if (store) { try { rmSync(join(store, cur.dir), { recursive: true, force: true }); } catch { /* best-effort */ } }
  for (const id of Object.keys(hive.registry().agents)) hive.syncOfficeSkills(id);
  return { ok: true };
});

/** Delete an installed skill. The guard rails live in uninstallSkill — it refuses
 *  any path it cannot prove is a skill folder inside a skills root. */
ipcMain.handle('skills:uninstall', (_evt, path: unknown) => {
  if (typeof path !== 'string') return { ok: false as const, error: 'bad request' };
  const cfg = readConfig();
  return uninstallSkill(path, { cwds: cfg.registeredRepos ?? [], home: agentsHome() });
});
/** Reveal a skill on disk. `openExternal` is deliberately https-only, so a
 *  file:// URL cannot (and should not) be smuggled through it. */
ipcMain.handle('skills:reveal', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'bad request' };
  const skillRoots = [join(homedir(), '.claude', 'skills'), join(homedir(), '.config', 'opencode')];
  const target = resolve(path);
  const inRoot = skillRoots.some((r) => target.startsWith(resolve(r) + sep))
    || (readConfig().registeredRepos ?? []).some((c) => target.startsWith(resolve(c) + sep));
  if (!inRoot) return { ok: false, error: 'outside a managed skills directory' };
  shell.showItemInFolder(target);
  return { ok: true };
});

// ─── IPC: setup catalog (which external tools are actually here) ────────────
/**
 * Probe every catalog row against THIS machine.
 *
 * Presence is a PATH resolution, not a spawn: running each candidate to read a
 * --version would be a dozen process launches on every panel open, and several of
 * these CLIs boot a TUI when invoked bare. `resolveCommand` returns its input
 * unchanged when it finds nothing, so "resolved to a real, existing path that is
 * not just the bare name" is the found test.
 *
 * mempalace is the one row that does NOT come from PATH: the memory subsystem
 * already resolves it (including uv/pip locations PATH may not carry for a
 * Finder-launched app) and knows whether the palace is initialised, so it is
 * authoritative and reused rather than re-probed differently here.
 */
ipcMain.handle('tools:status', async (): Promise<ToolStatus[]> => {
  const win = process.platform === 'win32';
  // Look for mempalace again without blocking: the sync `where` held the main
  // process for 1.2 s each time Settings opened (freezes.jsonl: ipc tools:status).
  memory.resetBinCache();
  await memory.binAsync().catch(() => null);
  const mem = (() => { try { return memory.status(); } catch { return null; } })();
  // A WSL floor: its agents and tools run inside the distro, so look there and
  // give Linux install commands (memory finds mempalace inside the distro too).
  const wslLoc = win ? parseWslPath(readConfig().harnessHome) : null;
  if (wslLoc) {
    const specs = toolCatalog();
    let probeError: string | null = null;
    const found = await probeInDistro(wslLoc.distro, specs.map((s) => s.bin).filter((b): b is string => !!b), (m) => { probeError = m; });
    return specs.map((spec): ToolStatus => {
      if (spec.id === 'mempalace') {
        return {
          ...spec,
          installCommand: spec.install.posix,
          found: !!mem?.available,
          path: mem?.bin ?? null,
          detail: mem?.available
            ? `${mem.initialized ? 'palace initialised' : 'installed — palace not built yet'} (inside WSL ${wslLoc.distro})`
            : `not installed inside WSL (${wslLoc.distro}); mempalace on Windows does not count for a WSL floor`
        };
      }
      // Fortress runs beside the app, not inside the distro.
      if (spec.managed === 'fortress') {
        const launcher = fortress.launcherPath();
        return { ...spec, installCommand: '', found: !!launcher, path: launcher };
      }
      const installCommand = WSL_INSTALL[spec.id] ?? spec.install.posix.replace(/^xcode-select --install\s+# macOS · or: /, '');
      const path = spec.bin ? found[spec.bin] ?? null : null;
      const missingSandbox = spec.id === 'bubblewrap' && !path && !probeError;
      return { ...spec, installCommand, found: !!path, path, detail: probeError ? `could not check inside WSL (${wslLoc.distro}): ${probeError}` : missingSandbox ? `not in WSL (${wslLoc.distro}): agents on this floor run with no OS sandbox` : `inside WSL (${wslLoc.distro})` };
    });
  }
  // The sandbox row is about Linux: Windows has none to install, macOS has its own.
  return Promise.all(toolCatalog().filter((spec) => !spec.linuxOnly || process.platform === 'linux').map(async (spec): Promise<ToolStatus> => {
    const installCommand = win ? spec.install.win32 : spec.install.posix;
    if (spec.id === 'mempalace') {
      return {
        ...spec,
        installCommand,
        found: !!mem?.available,
        path: mem?.bin ?? null,
        detail: mem?.available
          ? (mem.initialized ? 'palace initialised' : 'installed — palace not built yet')
          : undefined
      };
    }
    if (spec.managed === 'fortress') {
      const launcher = fortress.launcherPath();
      return { ...spec, installCommand, found: !!launcher, path: launcher };
    }
    if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
    let path: string | null = null;
    try {
      // Async: a sync `where` (a login shell on macOS) per row held the app for over a second.
      const resolved = await resolveCommandAsync(spec.bin);
      if (resolved !== spec.bin) path = resolved;
    } catch { /* a probe must never take the panel down */ }
    return { ...spec, installCommand, found: !!path, path };
  }));
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
// refresh() = resetBinCache + an idempotent start(). The poll is the one thing
// that reliably notices mempalace being installed after boot, so it is what arms
// the mine loop that boot's start() had to skip — otherwise the pill reads
// "getting ready" until the app is restarted.
ipcMain.handle('hive:memoryStatus', () => memory.refresh());
ipcMain.handle('hive:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('hive:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('hive:mineNow', () => { memory.mineNow(); return { ok: true }; });
// The one way the memory model goes online (memory.ts OFFLINE_ENV).
ipcMain.handle('hive:memoryDownloadModel', () => memory.downloadModel());
// Condense memory.md on demand: an explicit id condenses that one agent (skips
// the size trigger — a "condense now" button); no id runs a full threshold scan.
ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
  reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: enterprise Knowledge Graph (multimodal context for agents) ─────────
ipcMain.handle('kg:status', () => knowledge.status());
ipcMain.handle('kg:list', () => knowledge.list());
ipcMain.handle('kg:search', (_evt, query: unknown, limit: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return [];
  return knowledge.search(query, typeof limit === 'number' ? limit : undefined);
});
ipcMain.handle('kg:get', (_evt, id: unknown) =>
  (typeof id === 'string' && id ? knowledge.get(id) : null));
ipcMain.handle('kg:remove', (_evt, id: unknown) =>
  ({ ok: typeof id === 'string' && id ? knowledge.remove(id) : false }));
// Ingest one or more files from disk. Best-effort per file; returns per-file
// results so the UI can report partial success.
ipcMain.handle('kg:ingestFiles', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { paths?: unknown; tags?: unknown };
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
  const tags = Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === 'string') : undefined;
  const results = paths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath, { tags });
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { results };
});
// Open a multi-file picker and ingest the chosen artifacts in one round-trip.
ipcMain.handle('kg:addFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Add documents to the Knowledge Graph'
  });
  refocusAfterDialog(win);
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  const results = res.filePaths.map((srcPath) => {
    try {
      const r = knowledge.ingestFile(srcPath);
      return { ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount };
    } catch (e) {
      return { ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return { ok: true as const, results };
});

// ─── IPC: composer attachments (images + arbitrary files, attached by PATH) ──
// The message queue pipes raw text into a Claude CLI PTY, so attachments travel
// as a file PATH the agent reads with its Read tool (same convention as Slack).
// Picker offers an Images group + All Files.
// ─── Certificates for agents (caBundle.ts) ──────────────────────────────────
let caBuild: Promise<{ path: string | null; count: number; errors: string[] }> | null = null;
let caBuildKey = '';
/** Build (once per settings change) the CA bundle agents are pointed at. */
function ensureCaBundle(): Promise<{ path: string | null; count: number; errors: string[] }> {
  const t = readConfig().tls ?? {};
  const key = JSON.stringify(t);
  if (caBuild && key === caBuildKey) return caBuild;
  caBuildKey = key;
  const needsBundle = !!(t.caFile || t.trustWindows || t.trustWsl);
  caBuild = !needsBundle ? Promise.resolve({ path: null, count: 0, errors: [] }) : (async () => {
    const win = process.platform === 'win32';
    const run = (file: string, args: string[]): Promise<string> => new Promise((res, rej) => {
      execFile(file, args, { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) rej(file === 'wsl.exe' ? new Error(describeWslError(errOut || err)) : new Error(String(errOut ?? '').trim().split(/\r?\n/)[0] || err.message));
        else res(String(out));
      });
    });
    const floor = hive.wslRoot();
    const r = await buildCaBundle(t, {
      nodeRoots: tlsRootCertificates,
      readCaFile: (p) => readFileSync(p, 'utf8'),
      windowsStore: () => (win
        ? run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_STORE_SCRIPT])
        : Promise.reject(new Error('only on Windows'))),
      wslStore: () => (win
        ? run('wsl.exe', [...(floor ? ['-d', floor.distro] : []), '--exec', 'cat', '/etc/ssl/certs/ca-certificates.crt'])
        : Promise.resolve(readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8')))
    });
    for (const e of r.errors) console.warn('[tls]', e);
    const file = join(app.getPath('userData'), 'ca', 'bundle.pem');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, r.pem, 'utf8');
    return { path: file, count: r.count, errors: r.errors };
  })().catch((e) => ({ path: null, count: 0, errors: [e instanceof Error ? e.message : String(e)] }));
  return caBuild;
}
ipcMain.handle('tls:status', async () => {
  caBuild = null; // the user asked: look again (a CA may have been installed)
  const r = await ensureCaBundle();
  return { count: r.count, errors: r.errors, path: r.path };
});
// Settings → AI providers → pi: the model hosts the app detects from the
// user's pi settings (a custodian's network allows them, plus the human's).
ipcMain.handle('pi:modelHosts', () => {
  try { return { detected: hive.enabled() ? hive.detectedPiModelHosts(cleanCustomProviders(readConfig().customModelProviders).map((p) => p.baseUrl)) : [] }; } catch { return { detected: [] }; }
});
ipcMain.handle('tls:pickCaFile', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    title: 'CA certificate (PEM)',
    filters: [{ name: 'Certificates', extensions: ['pem', 'crt', 'cer'] }, { name: 'All Files', extensions: ['*'] }]
  });
  refocusAfterDialog(win);
  if (res.canceled || !res.filePaths[0]) return { ok: false as const };
  return { ok: true as const, path: res.filePaths[0] };
});
/** Try an endpoint with the current certificate settings: `<url>/models`. */
ipcMain.handle('tls:test', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return { ok: false, error: 'enter an http(s) URL' };
  let target: URL;
  try { target = new URL(url.trim().replace(/\/+$/, '') + '/models'); } catch { return { ok: false, error: 'invalid URL' }; }
  const t = readConfig().tls;
  const bundle = tlsActive(t) ? (await ensureCaBundle()).path : null;
  const lib = target.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request(target, {
      method: 'GET',
      timeout: 10_000,
      ...(target.protocol === 'https:' ? {
        ...(bundle ? { ca: readFileSync(bundle) } : {}),
        rejectUnauthorized: t?.verify !== false
      } : {})
    }, (res) => {
      res.resume();
      resolve({ ok: true, status: res.statusCode ?? 0 });
    });
    req.on('timeout', () => { req.destroy(new Error('timed out')); });
    req.on('error', (e) => resolve({ ok: false, error: (e as NodeJS.ErrnoException).code ? `${(e as NodeJS.ErrnoException).code}: ${e.message}` : e.message }));
    req.end();
  });
});

ipcMain.handle('dialog:attachFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach images or files',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff', 'avif'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  refocusAfterDialog(win);
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, files: res.filePaths.map((p) => ({ path: p, name: basename(p) })) };
});

// Persist the current native clipboard image to a temp PNG so a pasted
// screenshot can be attached by PATH. Returns an error result when the
// clipboard holds no image (e.g. a normal text paste).
ipcMain.handle('clipboard:saveImage', async () => {
  try {
    // Electron 44 removed readImage(): read the items and take the image one.
    let image: Blob | null = null;
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t === 'image/png') ?? item.types.find((t) => t.startsWith('image/'));
      if (type) { image = await item.getType(type) as Blob; break; }
    }
    if (!image || image.size === 0) return { ok: false as const, error: 'no image in clipboard' };
    const ext = image.type === 'image/jpeg' ? 'jpg' : image.type.replace(/^image\//, '').replace(/[^a-z0-9]/g, '') || 'png';
    const dir = join(app.getPath('temp'), 'cth-pastes');
    mkdirSync(dir, { recursive: true });
    const name = `paste-${Date.now()}.${ext}`;
    const dest = join(dir, name);
    writeFileSync(dest, Buffer.from(await image.arrayBuffer()));
    return { ok: true as const, file: { path: dest, name } };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

// A preview of an attached image for the composer, as a data URL. The renderer
// cannot show the file itself (it is sandboxed, and a dev build is not even on
// file://), so main reads it. Images only, bounded in size, scaled down: a
// preview, never a way to read arbitrary files back.
const PREVIEW_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
ipcMain.handle('attachments:preview', (_evt, path: unknown, size: unknown) => {
  if (typeof path !== 'string' || !PREVIEW_EXT.test(path)) return null;
  try {
    if (statSync(path).size > 25 * 1024 * 1024) return null;
    const img = nativeImage.createFromPath(path);
    if (img.isEmpty()) return null;
    const max = typeof size === 'number' && size > 0 && size <= 1600 ? Math.round(size) : 160;
    const { width, height } = img.getSize();
    const scaled = width > max || height > max
      ? img.resize(width >= height ? { width: max, quality: 'good' } : { height: max, quality: 'good' })
      : img;
    return scaled.toDataURL();
  } catch {
    return null;
  }
});

// ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
/** Tear the harness down and quit. Shared by the hard "kill all & quit" path
 *  and the closing-time conclusion (after the god confirmed the floor saved). */
/** Claude Code, by the command a pty was started with (claude, claude.exe, a
 *  path to either). Matched on the program, not the provider setting, so a
 *  custom command that runs Claude Code is included. */
const CLAUDE_CLI = /(^|[\\/\s"])claude(\.exe|\.cmd|\.ps1)?("|\s|$)/i;

let quitting = false;
function teardownAndQuit(): void {
  if (quitting) return;
  quitting = true;
  allowQuit = true;
  // Claude Code first gets the chance to exit by itself (double Ctrl+C, its own
  // quit), so it closes its Remote Control session instead of leaving it
  // listed in the Claude app. Whatever is still running after that is killed
  // below, as before. Bounded: the quit never waits more than a few seconds.
  void ptyManager.exitGracefully((pt) => CLAUDE_CLI.test(pt.command), ['\x03', '\x03', '\x03'], 4000)
    .then((n) => { if (n) console.log(`[quit] ${n} Claude Code session(s) exited on their own`); })
    .catch((e) => console.error('[quit] graceful exit:', e))
    .finally(finishTeardown);
}

function finishTeardown(): void {
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[quit] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[quit] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[quit] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[quit] broker.stop:', e); }
  try { mcpGateway.stop(); } catch (e) { console.error('[quit] mcpGateway.stop:', e); }
  try { void factories.closeAll(); } catch (e) { console.error('[quit] factories.closeAll:', e); }
  for (const b of wslBridges.values()) { try { b.stop(); } catch (e) { console.error('[quit] wsl bridge:', e); } }
  try { stopTeam(); } catch (e) { console.error('[quit] stopTeam:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[quit] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { hive.stopAllProxyBridges(); } catch (e) { console.error('[quit] stopAllProxyBridges:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[quit] killAll:', e); }
  app.quit();
}
/** Give the page its keyboard back after a native dialog: on Windows the
 *  webContents can come back unfocused, so text boxes stop taking input. */
function refocusAfterDialog(win: BrowserWindow | null | undefined): void {
  if (!win || win.isDestroyed()) return;
  win.focus();
  win.webContents.focus();
}
// A yes/no question for the renderer, instead of window.confirm(): Chromium's
// native confirm on Windows leaves the page without keyboard focus afterwards —
// text boxes look fine but no longer take input until the window is refocused
// ("the invite box is locked after deleting a team"). This asks through main
// and hands focus back to the page when the dialog closes.
// The renderer saw a click on a text box while the page had no keyboard focus.
ipcMain.handle('app:refocus', (evt) => { refocusAfterDialog(BrowserWindow.fromWebContents(evt.sender)); });
ipcMain.handle('app:confirm', async (evt, message: unknown, detail: unknown, ok: unknown) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  const opts = {
    type: 'question' as const,
    buttons: [typeof ok === 'string' && ok ? ok.slice(0, 40) : 'OK', 'Cancel'],
    defaultId: 0, cancelId: 1, noLink: true,
    message: typeof message === 'string' ? message.slice(0, 500) : 'Are you sure?',
    detail: typeof detail === 'string' ? detail.slice(0, 1000) : undefined
  };
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  refocusAfterDialog(win);
  return response === 0;
});

ipcMain.handle('app:confirmClose', () => {
  closingTime.cancel(); // a hard quit overrides a closing time in progress
  teardownAndQuit();
});
ipcMain.handle('app:cancelClose', () => {
  // The modal closes on the renderer side. The one thing main owes anybody here
  // is the truth about a restart-to-install: if this quit was one, it has just
  // been called off, and whoever is waiting on it needs to hear that rather than
  // sit disabled forever waiting for a process that is not going to die.
  abortPendingRestart();
});

// Open a new floor (independent office window). Gated by the multiWindow flag
// inside openFloor(); returns whether a window opened so a renderer button can
// reflect availability. The app-menu "New Floor" item calls openFloor() directly.
ipcMain.handle('window:newFloor', () => {
  return { ok: openFloor() };
});

// ─── IPC: closing time (graceful, data-loss-free shutdown) ──────────────────
// The third quit-dialog button. The god broadcasts closing time, every worker
// saves its memory and ACKs, the god concludes with CLOSING-TIME-COMPLETE —
// only then does the harness tear down. See closingTime.ts for the protocol.
const closingTime = new ClosingTimeController(
  hive,
  // Roster source: agents with a live PTY right now (ptyToAgent is pruned on
  // every teardown). The registry alone would include ghost workers from
  // sessions that ended with a hard quit — never archived, never able to ACK.
  () => [...new Set(ptyToAgent.values())],
  () => liveWebContents(),
  () => teardownAndQuit(),
  // #7C.2 steering — the graceful interrupt that reaches deeply busy agents
  // at their next hook boundary instead of waiting for a Stop.
  control
);
hive.setRoutedObserver((msg, targets) => closingTime.onRouted(msg, targets));
ipcMain.handle('app:startClosingTime', () => closingTime.start());
ipcMain.handle('app:cancelClosingTime', () => closingTime.cancel());

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[reset] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[reset] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[reset] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[reset] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  try { memory.stop(); } catch (e) { console.error('[reset] memory.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  try { ptyManager.killAll(); } catch (e) { console.error('[reset] killAll:', e); }
  try { hive.removeExposedCodexData(); } catch (e) { console.error('[reset] removeExposedCodexData:', e); }
  // Erase the hive (Michael's + every agent's memory, inboxes, tasks, board,
  // git history) and the semantic-memory palace. Only these harness-created
  // subdirs are removed — never the user's whole harnessHome folder.
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // The roster is the renderer's half of the same state, so it retires with the
  // hive — archived into roster-backups/ rather than deleted, and cleared as the
  // active file so re-selecting this folder later doesn't resurrect agents whose
  // sessions and memory are gone.
  try { roster.archive(); }
  catch (e) { console.error('[reset] roster.archive:', e); }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  releaseClaimedOffice();
  relaunchApp();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
// Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
// bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);
// Current context size (tokens) of an agent's LIVE session — the transcript
// path is learned from the agent's hook payloads (SessionStart fires right at
// spawn), so this works even when several agents share one cwd. Null until the
// first hook fires; a known-but-empty transcript reads as 0 so a freshly
// (re)started session zeroes the gauge instead of leaving a stale value up.
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  // An agent on a WSL floor reports the Linux path of its transcript.
  const floorWsl = hive.wslRoot();
  const file = floorWsl && tp.startsWith('/') ? fromLinuxPath(tp, floorWsl.distro) : tp;
  // The path comes from a hook payload: no network paths (see uncAllowed).
  if (!uncAllowed(file)) return null;
  return readContextTokens(file) ?? 0;
});

// A consolidated, NON-SENSITIVE per-agent directory for the voice read-layer
// (Realtime Michael's get_agent_detail / list_agents). One read that joins
// everything the office-floor sidebar + telemetry know per agent: the registry
// record (name/role/provider/cwd/status/archived/isGod/isAssistant/sessionId/
// cwdValid), live token + breaker + last-tool telemetry, and the current context
// window fill. Includes ARCHIVED agents (unlike the heartbeat's fleet.json, which
// is live-only) so Michael can speak to inactive agents — their cwd and memory
// stay reachable. PII-free: no secrets, env, or API keys ever leave main; cost is
// carried as tokens (+ a usd field the voice layer deliberately never speaks).
// Two screens poll this every 4 s; with an antivirus its per-agent file reads
// (memory, inbox) were ~0.2 s of blocked main thread each time. They run in
// parallel off the main thread, and asks that land together share one run.
let agentDirectoryRun: Promise<unknown> | null = null;
ipcMain.handle('hive:agentDirectory', () => {
  if (agentDirectoryRun) return agentDirectoryRun;
  agentDirectoryRun = agentDirectory().finally(() => { setTimeout(() => { agentDirectoryRun = null; }, 500); });
  return agentDirectoryRun;
});
async function agentDirectory() {
  if (!hive.enabled()) return { godId: null, agents: [] };
  const reg = hive.registry();
  const files = new Map(await Promise.all(Object.keys(reg.agents).map(async (id) =>
    [id, { memory: await hive.hasMemoryAsync(id), backlog: await hive.inboxBacklogAsync(id) }] as const)));
  const snap = telemetry.snapshot();
  const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
  const now = Date.now();
  const agents = Object.entries(reg.agents).map(([id, a]) => {
    const u = usageById.get(id);
    const spans = snap.spans[id] ?? [];
    const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
    const ctx = hookServer.contextFor(id);
    return {
      id,
      name: a.name,
      role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
      provider: a.provider ?? 'claude',
      model: u?.model ?? null,
      status: a.status ?? 'idle',
      cwd: a.cwd ?? null,
      cwdValid: a.cwdValid ?? null,
      osSandbox: osSandboxes.get(id) ?? null,
      archived: !!a.archived,
      isGod: !!a.isGod,
      isAssistant: !!a.isAssistant,
      sessionId: a.sessionId ?? null,
      hasMemory: files.get(id)?.memory ?? false,
      inboxBacklog: files.get(id)?.backlog ?? 0,
      breaker: breaker.levelFor(id),
      tokens,
      usd: u ? Number(u.usd.toFixed(4)) : 0,
      lastTool: spans.length ? spans[spans.length - 1].tool : null,
      lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
      contextTokens: ctx?.tokens ?? null,
      contextLimit: ctx?.limit ?? null,
      contextPct: ctx && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null
    };
  });
  return { godId: reg.godId, agents };
}

// ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
// The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
// consumes getAgentUsage in-process via the provider, not over IPC.
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

// ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
// Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
// on `control:breakerState`, where the avatar adapter gives it precedence over
// hook-derived status (#5C looping/zombie). Defined here so the channel exists
// before Jim's policy lands; he produces, this lane consumes.
ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
  try { liveWebContents()?.send('control:breakerState', state); } catch { /* window tore down */ }
  return { ok: true };
});

// ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
// All return the agent's fresh control snapshot so the UI can reflect state.
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.pause(agentId, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
  if (typeof agentId !== 'string') return null;
  const on = paused === true;
  control.pauseAutoDelivery(agentId, on);
  const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
  if (on) current.add(agentId); else current.delete(agentId);
  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
  return control.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.resume(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  control.gateTool(agentId, tool, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  control.steer(agentId, text);
  // A steer typed into the control strip is a human message. Counted HERE, at
  // the IPC seam, and deliberately not inside control.steer(): closingTime and
  // the voice action layer call that directly, and neither is a person typing.
  analytics.trackMessageSent('steer');
  return control.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.halt(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? control.snapshot(agentId) : null);

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prevLastFired = persistedById.get(m.id)?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    return { ...m, lastFiredAt };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));
// An agent's CLI showing a menu in its terminal (renderer reads its screen).
ipcMain.handle('app:notifyMenu', (_evt, agent: unknown, question: unknown) => {
  if (!readConfig().notifications || !Notification.isSupported()) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (win?.isFocused()) return;
  try {
    const icon = agentFaces.get(String(agent).trim().toLowerCase());
    const n = new Notification({ title: `${String(agent).slice(0, 60)} is asking you`, body: String(question).slice(0, 200), ...(icon ? { icon } : {}) });
    n.on('click', () => { if (win) { win.show(); win.focus(); } });
    n.show();
  } catch { /* unsupported */ }
});

// ─── IPC: onboarding reliability — open Settings deep-link + login-item toggle ─
/** Open a System Settings deep-link (or https URL) in the OS default handler.
 *  Restricted to Settings panes / https so the renderer can't shell arbitrary
 *  schemes. macOS uses `x-apple.systempreferences:`, Windows uses `ms-settings:`
 *  (Linux has no universal settings URI, so the renderer never sends one there).
 *  Used by the onboarding "Permissions & reliability" step. */
ipcMain.handle('app:openExternal', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|ms-settings:|https:\/\/)/.test(url)) {
    return { ok: false, error: 'blocked url' };
  }
  await shell.openExternal(url);
  return { ok: true };
});
/** Toggle macOS "Open at Login" — fully programmatic, no permission prompt.
 *  Returns the resulting state so the renderer toggle reflects reality. */
ipcMain.handle('app:setLoginItem', (_evt, enabled: unknown) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true });
  return app.getLoginItemSettings().openAtLogin;
});

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
/** Stop must survive a restart. Boot re-arms from `slackEnabled`, so stopping
 *  without clearing it silently brought the server back on the next launch —
 *  the user pressed Stop and Slack was live again.
 *
 *  Persist BEFORE tearing down. If the write throws (read-only volume, ENOSPC)
 *  the server is still up and the UI stays truthful; the other order leaves a
 *  dead server that still reads as Connected with the flag set, which is this
 *  same bug again with no error to show for it.
 *
 *  Only this handler clears the flag. changeHome / quit / reset call
 *  `stopSlackServer()` directly and must not: they are lifecycle, not a user
 *  turning the integration off. (Start persists the flag from the renderer, in
 *  `SettingsModal.startSlack`, not here.) */
ipcMain.handle('slack:stop', () => {
  writeConfig({ slackEnabled: false });
  stopSlackServer();
  return { ok: true };
});
/** Current connection state + last Request URL — lets Settings hydrate the
 *  "Connected" badge and re-show the persisted tunnel URL on reopen. */
ipcMain.handle('slack:status', () => ({ running: slackServer != null, url: lastSlackUrl }));
/** Absolute path to the bundled reply helper, for the prompt the office worker
 *  runs to post its summary back in-thread. No secret crosses this boundary. */
ipcMain.handle('slack:replyScriptPath', () => slackReplyScriptPath());
/** Renderer's immediate "queued" ack into the triggering Slack thread. The bot
 *  token stays in main — only channel/thread/text cross IPC. */
ipcMain.handle('slack:reply', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { channel?: unknown; thread_ts?: unknown; text?: unknown };
  const cfg = readConfig();
  // CLAUSE-3 (human: "stop posting into Slack by default"): this is the ONLY
  // app/voice-INITIATED proactive Slack post (the renderer's "queued" ack). It is
  // OFF unless the user opts in via Settings → Slack. The Slack-ORIGIN done-reply
  // round-trip (done-poller) and an agent's own direct /reply are NOT routed
  // through here, so they are unaffected and always stay on.
  if (!cfg.slackProactivePosting) return { ok: false, error: 'app-initiated Slack posting disabled (enable in Settings → Slack)' };
  const botToken = cfg.slackBotToken;
  if (!botToken) return { ok: false, error: 'no bot token' };
  if (typeof p.channel !== 'string' || typeof p.thread_ts !== 'string' || typeof p.text !== 'string') {
    return { ok: false, error: 'channel, thread_ts, text required' };
  }
  // CLAUSE-1 (fix-slack-integration): an app-initiated send must target an
  // EXPLICIT thread — reject a blank/whitespace channel or thread rather than
  // letting it fall through to an implicit destination (the channel root).
  if (!p.channel.trim() || !p.thread_ts.trim()) {
    return { ok: false, error: 'explicit channel + thread_ts required' };
  }
  return postSlackReply({ botToken, channel: p.channel, thread_ts: p.thread_ts, text: p.text });
});
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
    proactivePosting?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  if (typeof p.proactivePosting === 'boolean') next.slackProactivePosting = p.proactivePosting;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

// ─── IPC: Triggers — context (auto-compact / auto-clear) ────────────────────
ipcMain.handle('triggers:getContext', () => readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
ipcMain.handle('triggers:setContext', (_evt, arg: unknown) => {
  const current = readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
  const p = (arg ?? {}) as Partial<ContextTriggerConfig>;
  const next: ContextTriggerConfig = {
    compact: sanitizeContextRule(p.compact, current.compact),
    clear: sanitizeContextRule(p.clear, current.clear),
    // Same clamp the config read applies; a missing half keeps what is saved.
    workSwitch: workSwitchRuleFor({
      workSwitch: {
        enabled: typeof p.workSwitch?.enabled === 'boolean' ? p.workSwitch.enabled : current.workSwitch.enabled,
        minSessionMs: typeof p.workSwitch?.minSessionMs === 'number' ? p.workSwitch.minSessionMs : current.workSwitch.minSessionMs
      }
    }, false)
  };
  writeConfig({ contextTrigger: next });
  // The timers ARE the setting — a cadence saved but not re-armed would keep
  // firing on the old rhythm until the next boot.
  syncContextTriggers();
  return next;
});

/** Clamp one half of the context trigger. The renderer is not trusted with the
 *  arming maths: a zero/negative/NaN `everyMs` would arm a runaway timer, and an
 *  out-of-range percentage would silently disable (or permanently trip) the
 *  pressure gate. */
function sanitizeContextRule(patch: Partial<ContextRule> | undefined, current: ContextRule): ContextRule {
  const p = (patch ?? {}) as Partial<ContextRule>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    everyMs: num(p.everyMs, current.everyMs, 60_000, 86_400_000),
    minContextPct: num(p.minContextPct, current.minContextPct, 0, 100),
    minContextPctLargeWindow: num(p.minContextPctLargeWindow, current.minContextPctLargeWindow, 0, 100),
    message: typeof p.message === 'string' ? p.message : current.message
  };
}

// ─── IPC: Triggers — webhooks (many endpoints, one server, one tunnel) ──────
ipcMain.handle('webhooks:list', () => readConfig().webhookTriggers ?? []);
ipcMain.handle('webhooks:save', (_evt, arg: unknown) => {
  const incoming = Array.isArray(arg) ? arg : [];
  const existing = readConfig().webhookTriggers ?? [];
  const list: WebhookTrigger[] = [];
  const seen = new Set<string>();
  for (const raw of incoming) {
    const t = sanitizeWebhookTrigger(raw, existing);
    if (!t || seen.has(t.id)) continue; // an id is a URL path segment — one owner each
    seen.add(t.id);
    list.push(t);
  }
  writeConfig({ webhookTriggers: list });
  reconcileWebhookServer();
  return list;
});
ipcMain.handle('webhooks:delete', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg : '';
  const list = (readConfig().webhookTriggers ?? []).filter((t) => t.id !== id);
  writeConfig({ webhookTriggers: list });
  // Revoking one endpoint must not disturb the others: the live server is
  // re-pointed, not restarted, so every remaining caller's URL keeps working.
  reconcileWebhookServer();
  return list;
});
/** Mint a strong (256-bit) secret for the operator to paste into their caller.
 *  Not persisted here — it belongs to whichever endpoint the UI saves it onto. */
ipcMain.handle('webhooks:generateSecret', () => randomBytes(32).toString('hex'));
/** Server state + the tunnel root + one public URL per configured endpoint (the
 *  UI offers a copy button per webhook, so the root alone isn't enough). */
ipcMain.handle('webhooks:status', () => ({
  running: webhookServer != null,
  url: lastWebhookUrl,
  endpoints: webhookEndpointUrls()
}));

/** Normalise one endpoint coming back from the renderer. Unknown/blank fields
 *  fall back to what is already persisted, so a UI that round-trips a partially
 *  filled row can never blank a live secret or silently widen a mode. */
function sanitizeWebhookTrigger(raw: unknown, existing: WebhookTrigger[]): WebhookTrigger | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WebhookTrigger>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  // The id is spliced into a public URL path. Restrict it to a boring charset
  // rather than escaping later: no slashes (which would forge a nested route),
  // no encoded traversal, nothing that could make two endpoints alias.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null;
  const prior = existing.find((t) => t.id === id);
  const secret = typeof r.secret === 'string' && r.secret.trim() ? r.secret.trim() : prior?.secret ?? '';
  const mode = isTriggerMode(r.mode) ? r.mode : prior?.mode ?? DEFAULT_TRIGGER_MODE;
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : prior?.name ?? id,
    secret,
    // A secretless endpoint can never be enabled — it would be an open door.
    enabled: secret ? (typeof r.enabled === 'boolean' ? r.enabled : prior?.enabled ?? false) : false,
    mode,
    schema: typeof r.schema === 'string' && r.schema.trim() ? r.schema : prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: typeof r.createdAt === 'number' && r.createdAt > 0 ? r.createdAt : prior?.createdAt ?? Date.now(),
    // Who answers: the orchestrator (no entry), or a temp / a clone of an agent.
    ...(typeof r.answer === 'string' && r.answer.trim() && r.answer.trim() !== 'god' ? { answer: r.answer.trim().slice(0, 120) } : {})
  };
}

function isTriggerMode(v: unknown): v is TriggerMode {
  return v === 'strict' || v === 'allow-all' || v === 'communication-only';
}

// ─── IPC: Triggers — organisation (persistence only; no transport yet) ──────
ipcMain.handle('org:getTrigger', () => readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER);
ipcMain.handle('org:setTrigger', (_evt, arg: unknown) => {
  const current = readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER;
  const p = (arg ?? {}) as Partial<OrgTriggerConfig>;
  // PERSIST ONLY — the peer messaging service does not exist yet, so nothing
  // reads `apiKey` beyond the settings surface that shows it. Deliberately no
  // start/stop, no network, no side effect of any kind.
  const next: OrgTriggerConfig = {
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : current.apiKey,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    mode: isTriggerMode(p.mode) ? p.mode : current.mode
  };
  writeConfig({ orgTrigger: next });
  return next;
});

// ─── IPC: Triggers — history ledger + the approval gate ─────────────────────
ipcMain.handle('triggerHistory:list', () => listTriggerHistory());
ipcMain.handle('triggerHistory:clear', (_evt, arg: unknown) => {
  const source = arg === 'webhook' || arg === 'org' ? arg : undefined;
  clearTriggerHistory(source);
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return { ok: true };
});
/**
 * The operator's verdict on a held message.
 *
 * 'approved' RELEASES it: it takes the identical path an auto-allowed message
 * would have taken (card + god request), then the entry flips. 'rejected' just
 * flips — nothing is ever dispatched.
 *
 * Idempotent by construction: only an entry still sitting at `pending` can be
 * decided, so a double-click (or two windows deciding at once) cannot dispatch
 * the same message twice.
 */
ipcMain.handle('triggerHistory:decide', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { id?: unknown; decision?: unknown };
  const id = typeof p.id === 'string' ? p.id : '';
  const decision = p.decision === 'approved' ? 'approved' : p.decision === 'rejected' ? 'rejected' : null;
  if (!id || !decision) return null;
  const entry: TriggerHistoryEntry | undefined = listTriggerHistory().find((e) => e.id === id);
  if (!entry) return null;
  if (entry.decision !== 'pending') return entry; // already decided → no-op, not a re-dispatch

  if (decision === 'rejected') {
    const next = updateTriggerHistory(id, { decision: 'rejected' });
    notifyTriggerHistoryUpdated();
    return next;
  }

  if (entry.source === 'org') {
    // A held teammate message: the same delivery an allowed one gets.
    // `peer` is the teammate's own name (what a reply is addressed to);
    // sourceName also carries the team, for the ledger.
    routeTeamToGod(entry.peer, entry.title ?? '', entry.body, entry.kind);
    const next = updateTriggerHistory(id, { decision: 'approved' });
    notifyTriggerHistoryUpdated();
    return next;
  }
  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  const tokenHash = heldTokenHashFor(id);
  const title = entry.title ?? (entry.body.length > 80 ? `${entry.body.slice(0, 79)}…` : entry.body);
  const answer = entry.source === 'webhook' ? (readConfig().webhookTriggers ?? []).find((t) => t.id === entry.sourceId)?.answer : undefined;
  if (!dispatchWebhookWork({ taskId, title, message: entry.body, tokenHash, origin: entry.source, answer })) {
    // The card is what the caller polls and what god works from. Leave the entry
    // pending so the operator can approve again once the hive is writable.
    return entry;
  }
  // The hash now lives on the card, so the caller's GET resolves through the
  // normal task lookup from here on.
  if (tokenHash) { heldTokens().delete(tokenHash); persistHeldTokens(); }
  const next = updateTriggerHistory(id, { decision: 'approved', taskId });
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return next;
});

// ─── IPC: Generic webhook (LEGACY single-endpoint channels) ─────────────────
// Kept alive for Settings → Webhook, which still speaks the one-secret shape.
// They are now THIN SHIMS over the multi-endpoint engine: the legacy secret and
// enabled flag map onto the `legacy` WebhookTrigger the config migration created,
// so the two surfaces can never disagree about whether the endpoint is live.
ipcMain.handle('webhook:start', () => startWebhookServer());
ipcMain.handle('webhook:stop', () => { stopWebhookServer(); return { ok: true }; });
/** Current state + last public endpoint URL, for the Settings badge/URL field. */
ipcMain.handle('webhook:status', () => ({ running: webhookServer != null, url: lastWebhookUrl }));
/** Mint a strong (256-bit) secret, persist it, and return it so Settings can show
 *  it for the user to copy into their client. The previous secret is replaced. */
ipcMain.handle('webhook:generateSecret', () => {
  const secret = randomBytes(32).toString('hex');
  writeConfig({ webhookSecret: secret });
  upsertLegacyWebhookTrigger({ secret });
  return { ok: true, secret };
});
ipcMain.handle('webhook:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { secret?: unknown; port?: unknown; enabled?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
  if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
  writeConfig(next);
  upsertLegacyWebhookTrigger({
    secret: typeof p.secret === 'string' ? p.secret.trim() : undefined,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined
  });
  // Disabling (or clearing the secret) stops the public surface immediately; the
  // reconcile also picks up the case where OTHER endpoints are still enabled, in
  // which case the server stays up minus the legacy one.
  reconcileWebhookServer();
  return { ok: true };
});

/** Mirror a legacy `webhook:setConfig` / `webhook:generateSecret` edit onto the
 *  `legacy` WebhookTrigger. Creates the row only once a secret exists — an
 *  enabled endpoint without a secret would be an open door, so a bare "enable"
 *  against a never-configured webhook is deliberately a no-op. */
function upsertLegacyWebhookTrigger(patch: { secret?: string; enabled?: boolean }): void {
  const list = readConfig().webhookTriggers ?? [];
  const prior = list.find((t) => t.id === 'legacy');
  const secret = patch.secret !== undefined ? patch.secret : prior?.secret ?? '';
  if (!secret) return;
  const row: WebhookTrigger = {
    id: 'legacy',
    name: prior?.name ?? 'Default webhook',
    secret,
    enabled: patch.enabled !== undefined ? patch.enabled : prior?.enabled ?? false,
    mode: prior?.mode ?? DEFAULT_TRIGGER_MODE,
    schema: prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: prior?.createdAt ?? Date.now()
  };
  writeConfig({
    webhookTriggers: prior ? list.map((t) => (t.id === 'legacy' ? row : t)) : [...list, row]
  });
}

// ─── IPC: Free Flow (voice dictation → message queue) ────────────────────────
// Entry point B is hold-Option-to-talk, handled entirely in the renderer
// (capture-phase key listeners) — no globalShortcut here. macOS doesn't deliver
// the Fn key to Electron (electron#16714) and a faithful native Fn helper
// (CGEventTap) is deferred; hold-Option is the human-chosen v1 activation.

ipcMain.handle('freeflow:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { enabled?: unknown; apiKey?: unknown; model?: unknown; engine?: unknown; localModel?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.enabled === 'boolean') next.freeflowEnabled = p.enabled;
  // Trim string fields; an emptied key clears back to undefined.
  if (typeof p.apiKey === 'string') next.groqApiKey = p.apiKey.trim() || undefined;
  if (typeof p.model === 'string') next.freeflowModel = p.model.trim() || DEFAULT_GROQ_MODEL;
  if (p.engine === 'groq' || p.engine === 'local') next.freeflowEngine = p.engine;
  if (isWhisperModel(p.localModel)) next.freeflowLocalModel = p.localModel;
  writeConfig(next);
  return { ok: true };
});

// Local Whisper: the renderer's model-file cache, kept under userData/whisper.
let whisperCacheInst: WhisperCache | null = null;
const whisperCache = (): WhisperCache => (whisperCacheInst ??= new WhisperCache(join(app.getPath('userData'), 'whisper')));
ipcMain.handle('whisper:cacheMatch', (_evt, key: unknown) => whisperCache().match(key));
ipcMain.handle('whisper:cachePut', (_evt, key: unknown, bytes: unknown) => whisperCache().put(key, bytes));
ipcMain.handle('whisper:status', () => ({ small: whisperCache().isReady('small'), bytes: whisperCache().size() }));
ipcMain.handle('whisper:remove', () => { whisperCache().removeAll(); });
ipcMain.handle('whisper:markReady', (_evt, model: unknown, ready: unknown) => { if (isWhisperModel(model)) whisperCache().markReady(model, ready === true); });

/** Transcribe one captured audio clip via Groq. Gated on the flag + a key being
 *  present, so a disabled feature can NEVER reach the network. The Groq key stays
 *  in main — only the audio bytes cross IPC inbound and the transcript outbound. */
ipcMain.handle('freeflow:transcribe', async (_evt, arg: unknown) => {
  const cfg = readConfig();
  if (!cfg.freeflowEnabled) return { ok: false, error: 'Free Flow is disabled' };
  if (!cfg.groqApiKey) return { ok: false, error: 'no Groq API key set' };
  const a = (arg ?? {}) as { audio?: unknown; mimeType?: unknown; filename?: unknown; language?: unknown };
  if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) {
    return { ok: false, error: 'no audio' };
  }
  const out = await transcribeWithGroq({
    apiKey: cfg.groqApiKey,
    audio: a.audio,
    mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
    filename: typeof a.filename === 'string' ? a.filename : undefined,
    model: cfg.freeflowModel || DEFAULT_GROQ_MODEL,
    language: typeof a.language === 'string' && a.language ? a.language : undefined
  });
  if (out.ok) analytics.trackFeature('voice_dictation');
  return out;
});

// ─── IPC: Realtime Michael (voice orchestrator — ephemeral token mint, rt-1) ──
// MAIN owns the BYOK OpenAI key (encrypted broker, apikey:openai) and mints a
// short-lived EPHEMERAL client secret; the real key never crosses IPC. All wiring
// lives in ./realtime so this stays a single registration line.
registerRealtimeIpc();

// ─── IPC: Realtime Michael voice ACTIONS (rt-5, Phase 2) ─────────────────────
// Thin adapters over the SAME main fns the god PTY already uses. ALL of the safety
// spine — soft-vs-destructive tiering, the two-step verbal echo-back confirm, the
// distinct-token rule, the hard allowlist (kill-god / mass-ops forbidden), and the
// michael-voice attribution — lives in ./realtimeActions. This site only injects
// the existing functions; it adds NO new orchestration logic.
// ─── IPC: Realtime Michael completion watcher (rt-12, Phase 2) ───────────────
// Jim's net-new engine (realtimeCompletionWatcher.ts) detects a voice-dispatched
// task finishing (card→done OR a done-reply in michael-voice's inbox) and EMITS it;
// I own the seam — inject the hive read deps, push completions to the live session
// (so Michael speaks them unprompted), and bridge waitFor / queue-drain over IPC.
const completionWatcher = initCompletionWatcher({
  readTasks: () => { const t = hive.tasks() as { tasks?: TaskCard[] }; return Array.isArray(t?.tasks) ? t.tasks : []; },
  // Voice dispatches go out as from:michael-voice, so assignee done-replies land here.
  readInbox: () => {
    // Voice dispatches go out from:michael-voice, so done-replies normally land in its
    // inbox — but an assignee may address god out of habit. Merge both inboxes (de-dupe
    // by id) so a god-addressed completion isn't missed; the detector filters by sender.
    try {
      const mv = hive.inbox('michael-voice') as unknown as InboxMessage[];
      const godId = hive.registry().godId;
      const god = godId ? (hive.inbox(godId) as unknown as InboxMessage[]) : [];
      const seen = new Set<string>();
      return [...mv, ...god].filter((m) => !!m?.id && !seen.has(m.id) && seen.add(m.id) !== undefined);
    } catch {
      return [];
    }
  },
  onNotify: (evt) => {
    try {
      if (!Notification.isSupported()) return;
      const reg = hive.registry();
      const title = resolveGodName(reg.agents[reg.godId ?? 'god']?.name);
      const icon = agentFaces.get(reg.godId ?? 'god');
      new Notification({ title, body: evt.summary, ...(icon ? { icon } : {}) }).show();
    } catch { /* best-effort */ }
  }
});

registerRealtimeActionIpc({
  hiveEnabled: () => hive.enabled(),
  hiveSend: (partial, from) => hive.send(partial, from),
  hiveTasks: () => hive.tasks(),
  hiveAddTask: (task) => hive.addTask(task as HiveTask),
  hivePatchTask: (id, patch) => hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>),
  hiveDeleteTask: (id) => hive.deleteTask(id),
  hiveRegistry: () => hive.registry(),
  hiveLog: (event) => hive.appendLog(event),
  controlPause: (id, on) => control.pause(id, on),
  controlSteer: (id, text) => control.steer(id, text),
  controlHalt: (id) => control.halt(id),
  controlSnapshot: (id) => control.snapshot(id),
  killAgent: (id) => {
    const r = ptyManager.kill(id);
    teardownPty(id);
    // A voice (MAIN-initiated) kill: the renderer never removed the card itself
    // (unlike a UI kill), so tell the floor to archive it. Mirrors hive:agentSpawned.
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
    return r;
  },
  spawnAgent: async (opts) => {
    const o = opts as AgentSpawnOptions;
    const res = await spawnAgentCore(o, null);
    // The renderer roster is only mutated by renderer-initiated hires (AddAgentModal),
    // so a MAIN-initiated spawn is invisible on the floor until we broadcast it. The
    // renderer (useHive) builds the Agent card from this descriptor; addAgent is
    // idempotent so a renderer-initiated hire is never double-carded.
    if (res.ok) {
      try {
        liveWebContents()?.send('hive:agentSpawned', {
          id: o.id,
          name: o.hive?.name ?? o.id,
          provider: o.provider ?? o.hive?.provider ?? 'claude',
          cwd: res.worktreePath ?? o.cwd,
          command: o.command,
          role: o.hive?.role,
          worktreePath: res.worktreePath
        });
      } catch { /* window torn down */ }
    }
    return res;
  },
  listMissions: () => readConfig().missions ?? [],
  // The spec carries lastFiredAt through from listMissions(), so a wholesale write
  // preserves the scheduler's stamps; edit_schedule is deliberate + rare.
  saveMissions: (missions) => { writeConfig({ missions }); },
  // rt-12: register each voice dispatch so the watcher can detect its completion.
  trackDispatch: (d) => { try { completionWatcher.track({ ...d, kind: 'dispatch' }); } catch { /* watcher unavailable */ } },
  // ── v0.3.4 full-control extensions ──
  controlResume: (id) => control.resume(id),
  controlAutoDelivery: (id, paused) => control.pauseAutoDelivery(id, paused),
  controlGateTool: (id, toolName, on) => control.gateTool(id, toolName, on),
  setArchived: (id, archived) => {
    if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
    hive.setArchived(id, archived);
    try { liveWebContents()?.send(archived ? 'hive:agentArchived' : 'hive:agentSpawned', { id }); } catch { /* window gone */ }
    return { ok: true };
  },
  // clear_context: hand the text to the renderer's queue so delivery rides every
  // existing gate (idle-only, boot grace, draft/picker safety).
  enqueueToAgent: (id, text) => {
    try { liveWebContents()?.send('realtime:enqueue', { agentId: id, text }); } catch { /* window gone */ }
  },
  getConfigValue: (key) => (readConfig() as unknown as Record<string, unknown>)[key],
  patchConfig: (patch) => { writeConfig(patch as Partial<HarnessConfig>); }
});

// rt-12 seam: push detected completions to the live floor; bridge live-flag, queue
// drain (closed-session warm-start), and wait_for over IPC. Then start polling.
completionWatcher.onCompletion((evt) => { try { liveWebContents()?.send('realtime:completion', evt); } catch { /* window gone */ } });
// v0.3.4: the floor delta watcher shares the session-live flag — while a voice
// session is open it pushes coalesced floor updates the renderer injects as
// silent conversation items (snapshot-at-connect + append-only deltas).
const floorWatcher = new RealtimeFloorWatcher({
  enabled: () => hive.enabled(),
  registry: () => hive.registry(),
  tasks: () => hive.tasks(),
  ptys: () => ptyManager.list().map((p) => ({ id: p.id, lastOutputAt: p.lastOutputAt })),
  push: (text) => { try { liveWebContents()?.send('realtime:floorDelta', { text }); } catch { /* window gone */ } }
});
floorWatcher.start();
ipcMain.handle('realtime:setSessionLive', (_e, live: unknown) => {
  completionWatcher.setSessionLive(live === true);
  floorWatcher.setSessionLive(live === true);
  return { ok: true };
});
// v0.3.4: app self-knowledge for the voice get_app_info tool — version + the
// newest CHANGELOG sections. Read-only; ships CHANGELOG.md with the app.
ipcMain.handle('app:info', () => {
  let changelog = '';
  for (const p of [join(app.getAppPath(), 'CHANGELOG.md'), join(process.cwd(), 'CHANGELOG.md')]) {
    try { changelog = readFileSync(p, 'utf8'); if (changelog) break; } catch { /* try next */ }
  }
  const top = changelog
    ? changelog.split(/\n## /).slice(1, 3).map((s) => `## ${s}`).join('\n').slice(0, 8000)
    : '';
  return { version: app.getVersion(), changelog: top };
});
ipcMain.handle('realtime:drainCompletions', () => completionWatcher.drainQueuedCompletions());
ipcMain.handle('realtime:waitFor', (_e, taskId: unknown, timeoutMs: unknown) =>
  typeof taskId === 'string'
    ? completionWatcher.waitFor(taskId, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120_000)
    : Promise.resolve({ timedOut: true as const, taskId: '' }));
completionWatcher.start();

// ─── god-triggered ephemeral Slack workers ──────────────────────────────────
// god drops a spawn-request JSON into HIVE_ROOT/spawn-requests/; MAIN polls that
// queue (same cadence + atomic-rename archival as the hive router — reliability
// over latency, no fs.watch/dedup needed), spins up a FRESH ISOLATED worker via
// the shared spawnAgentCore, dispatches the objective through the standard inbox
// path, then watches each worker for a terminal `act:"done"` (success → release)
// or excessive idleness (reap). All teardown flows through teardownPty's
// safety-gate, so a worker's worktree is never auto-removed while it holds
// unintegrated work. Every terminal failure informs god WITH the Slack coords so
// god closes the Slack loop; the success path is the worker replying in-thread.

/** A spawn-request god drops into HIVE_ROOT/spawn-requests/<id>.json. god authors
 *  these directly; `objective` and `cwd` are the only required fields. */
interface SpawnRequest {
  id?: string;
  objective?: string;
  command?: string;                                   // engine CLI; default = config.defaultCommand
  provider?: AgentProvider;                           // optional explicit provider
  model?: string;                                     // optional --model override (Claude)
  cwd?: string;                                        // repo the worker (and its worktree) runs in
  name?: string;                                       // display name
  slack?: { channel: string; thread_ts: string };     // reply target + where failures surface
  isolate?: boolean;                                   // default true (fresh worktree)
  tokenCap?: number;                                   // optional per-worker token cap (advisory P1)
  // Appearance on the office floor. Both optional and both validated renderer-side
  // against the real cast and accent lists, so a bad value degrades to the default
  // rather than breaking the card.
  //
  // Naming a worker after a cast member ALREADY gets you their avatar: the floor
  // card infers it from the name. These two exist for the case that inference
  // cannot express, an agent called something else that should still look like a
  // particular character, and picking the accent instead of taking the one hashed
  // from the worker id.
  character?: string;
  accent?: string;
}

/** Polling cadence — matches the hive router. */
const WORKER_TICK_MS = 1500;
let workerWatchTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow tick (await spawn / git checks) never overlaps. */
let workerTickRunning = false;

/** HIVE_ROOT/spawn-requests — the queue dir god drops requests into. */
function spawnRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'spawn-requests') : null;
}

/** Requests already put to the operator, so one is asked about once. */
const spawnAsked = new Set<string>();
let spawnAsking = false;

/**
 * "Orchestrator may start workers" is off: show each waiting request to the
 * operator once — start it, always allow, or decline (the orchestrator is
 * told either way). Before, the request sat in the queue with nobody aware
 * of it, and an orchestrator left waiting looked broken.
 */
async function askToSpawnPending(): Promise<void> {
  if (spawnAsking) return;
  const queue = spawnRequestsDir();
  if (!queue || !existsSync(queue)) return;
  let files: string[] = [];
  try { files = readdirSync(queue).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  const next = files.find((f) => !spawnAsked.has(f));
  if (!next) return;
  spawnAsked.add(next);
  const filePath = join(queue, next);
  let req: SpawnRequest = {};
  try { req = JSON.parse(readFileSync(filePath, 'utf8')) as SpawnRequest; } catch { return; }
  const reg = hive.registry();
  const who = resolveGodName(reg.agents[reg.godId ?? 'god']?.name);
  const name = typeof req.name === 'string' && req.name.trim() ? req.name.trim() : basename(next, '.json');
  const objective = typeof req.objective === 'string' ? req.objective.trim() : '';
  spawnAsking = true;
  try {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const opts = {
      type: 'question' as const,
      buttons: ['Start it', 'Always allow', 'Decline'],
      defaultId: 0, cancelId: 2, noLink: true,
      title: 'Start a worker?',
      message: `${who} wants to start a worker: ${name}`,
      detail: `${objective.length > 600 ? objective.slice(0, 600) + '…' : objective}\n\nTo stop being asked, turn on "Orchestrator may start workers" in Settings → Autonomy & limits.`
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    refocusAfterDialog(win);
    if (!existsSync(filePath)) return;
    if (response === 2) {
      informGod('[worker spawn declined]', `The operator declined to start the worker in ${next}. Do the work another way or ask them.`);
      archiveRequest(filePath, '.failed');
      return;
    }
    if (response === 1) writeConfig({ orchestratorMaySpawn: true });
    await processSpawnRequest(filePath);
  } catch (e) {
    console.error('[worker] spawn question failed:', e);
  } finally {
    spawnAsking = false;
  }
}

/** Move a processed request out of its queue so it's never reprocessed. The
 *  queue is the hive's spawn-requests/ unless given (an agent's own). */
function archiveRequest(filePath: string, sub: '.done' | '.failed', queueDir?: string): void {
  const queue = queueDir ?? spawnRequestsDir();
  try {
    if (!queue) throw new Error('no hive root');
    const dir = join(queue, sub);
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    // Last resort: delete it so a poison file can't loop forever.
    try { unlinkSync(filePath); } catch { /* noop */ }
    console.error('[worker] archiveRequest failed:', e);
  }
}

/** HIVE_ROOT/archive-requests — where the orchestrator asks to archive a temp. */
function archiveRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'archive-requests') : null;
}

/** Archive requests: `archive-requests/<any>.json` holding {"id":"worker-…"}.
 *  The orchestrator had no way to let go of a temp it hired: a temp that never
 *  sent its done (or was restored as a regular agent) stayed on the floor until
 *  the human closed it. Same shape as spawn-requests: the file is untrusted, so
 *  only a temp the requester started is archived (archiveRequestProblem); each
 *  request moves to .done/ or .failed/ and the requester hears the outcome in
 *  its inbox. Work committed on the temp's branch is preserved by the usual
 *  teardown. `requester` unset is the orchestrator and the hive's
 *  archive-requests/; an agent's own requests are in its own folder. */
function processArchiveRequests(dir = archiveRequestsDir(), requester?: string): void {
  if (!dir || !existsSync(dir)) return;
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return; }
  for (const f of files) {
    const fp = join(dir, f);
    let id = '';
    try {
      const raw = JSON.parse(readFileSync(fp, 'utf8')) as { id?: unknown };
      id = typeof raw.id === 'string' ? raw.id.trim() : '';
    } catch { /* unparseable → refused below as missing id */ }
    const problem = hive.enabled() ? archiveRequestProblem(hive.registry(), id, requester) : 'no hive is open';
    const sub = problem ? '.failed' : '.done';
    try {
      mkdirSync(join(dir, sub), { recursive: true });
      renameSync(fp, join(dir, sub, f));
    } catch { try { unlinkSync(fp); } catch { /* noop */ } }
    if (problem) {
      informOwner(requester, `[archive request refused] ${id || f}`, `archive-requests/${f} was refused: ${problem}.`);
      continue;
    }
    const rec = liveWorkers.get(id);
    const pty = rec ? workerPty(rec) : ptyForAgent(id);
    if (rec && !rec.releasing) {
      rec.releasing = true;
      logWork(rec, 'archived');
    }
    if (pty) {
      ptyManager.kill(pty);
      teardownPty(pty);
      // teardownPty archives a tracked worker's card; an untracked one (a temp
      // restored before its hiring was persisted) needs it said here.
      if (!rec) { try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ } }
    }
    hive.setArchived(id, true);
    forgetTempAccess(id);
    console.log(`[worker] archived ${id} at the request of ${requester ?? 'the orchestrator'}`);
    informOwner(requester, `[temp archived] ${id}`, `${id} was archived as you asked${pty ? ' (its terminal was closed)' : ''}. Work committed on its branch is preserved${requester ? '' : ' for you'}.`, rec?.slack);
  }
}

/** Every lasting agent's own queues, `agents/<id>/spawn-requests/` and
 *  `agents/<id>/archive-requests/`: any agent, not only the orchestrator, may
 *  start a temp for one job, within the quota the human gave it ("Temps per
 *  agent", default 0 = none) and the office's "Max temps at once". The folder
 *  says who asked (an agent writes only its own), so the temp reports to that
 *  agent and runs with at most its access. A request over quota is refused
 *  with the reason in the agent's inbox, never left waiting unseen. */
async function processAgentTempRequests(): Promise<void> {
  const root = hive.root();
  if (!root || !hive.enabled()) return;
  const reg = hive.registry();
  const cfg = readConfig();
  const officeMax = tempsAtOnce(cfg.maxConcurrentWorkers);
  const critical = criticalMap();
  for (const [id, a] of Object.entries(reg.agents ?? {})) {
    if (a.archived || a.isGod || id === reg.godId) continue;
    const base = join(root, 'agents', id);
    const quota = tempQuotaOf(cfg.agentTempQuota, id);
    const queue = join(base, 'spawn-requests');
    // The folders exist once the human gives the agent temps, so its first
    // request does not fail on a missing directory.
    if (quota > 0 && !a.temp) {
      for (const d of [queue, join(base, 'archive-requests')]) {
        if (!existsSync(d)) { try { mkdirSync(d, { recursive: true }); } catch { /* best-effort */ } }
      }
    }
    processArchiveRequests(join(base, 'archive-requests'), id);
    if (!existsSync(queue)) continue;
    let files: string[] = [];
    try { files = readdirSync(queue).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
    for (const f of files) {
      const mine = [...liveWorkers.values()].filter((w) => w.parent === id && !w.releasing).length;
      const problem = agentTempProblem(
        { id, temp: !!a.temp, custodian: isCustodian(critical, id) },
        quota, mine, liveWorkers.size, officeMax
      );
      if (problem) {
        console.log(`[worker] refused ${id}'s temp request ${f}: ${problem}`);
        informOwner(id, `[temp refused] ${f}`, `Your spawn request spawn-requests/${f} was refused: ${problem}.`);
        archiveRequest(join(queue, f), '.failed', queue);
        continue;
      }
      await processSpawnRequest(join(queue, f), { parent: id, queueDir: queue });
    }
  }
}

/** A trigger whose "who answers" is a temp (Schedules, webhooks, Slack, Team):
 *  start one for this job, a plain temp or a clone of an agent. False when it
 *  could not (no free desk, an agent that cannot be cloned, a refused spawn);
 *  the caller then hands the job to the orchestrator as before, so a trigger
 *  never goes unanswered. Its results go to the orchestrator. */
async function hireTempForTrigger(answer: Answerer, job: { objective: string; name?: string; slack?: { channel: string; thread_ts: string }; source: string }): Promise<boolean> {
  if (answer.kind === 'agent' || !hive.enabled()) return false;
  const queue = spawnRequestsDir();
  if (!queue) return false;
  const cfg = readConfig();
  if (liveWorkers.size >= tempsAtOnce(cfg.maxConcurrentWorkers)) {
    informGod(`[no temp desk free] ${job.source}`, `${job.source} is set to be answered by a temp, but every temp desk is taken (${liveWorkers.size} at once). It was handed to you instead.`);
    return false;
  }
  const reg = hive.registry();
  const of = answer.kind === 'clone' ? answer.of : undefined;
  if (of) {
    const why = cloneProblem(reg.agents[of], isCustodian(criticalMap(), of));
    if (why) {
      informGod(`[temp not started] ${job.source}`, `${job.source} is set to be answered by a temp cloned from ${of}, but ${why}. It was handed to you instead.`);
      return false;
    }
  }
  // A plain temp works where the orchestrator does (the office); a clone
  // where its agent does (processSpawnRequest takes that from the agent).
  const cwd = of ? '' : (reg.agents[reg.godId ?? 'god']?.cwd ?? cfg.harnessHome ?? '');
  const id = `${of ? 'clone' : 'temp'}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  const dir = join(queue, 'trigger');
  const file = join(dir, `${id}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ id, objective: job.objective, ...(cwd ? { cwd } : {}), ...(job.name ? { name: job.name.slice(0, 40) } : {}), ...(job.slack ? { slack: job.slack } : {}) }, null, 2), 'utf8');
  } catch (e) {
    console.error('[worker] could not write a trigger temp request:', e);
    return false;
  }
  return processSpawnRequest(file, { cloneOf: of, trigger: true });
}

/** Mark temps hired before their hiring was persisted (legacyTemps), so Restore
 *  team stops bringing them back as permanent agents. Boot-time, best-effort. */
function markLegacyTemps(): void {
  const queue = spawnRequestsDir();
  if (!queue || !hive.enabled()) return;
  try {
    for (const [id, temp] of Object.entries(legacyTemps(hive.registry(), join(queue, '.done')))) {
      hive.setTemp(id, temp);
      console.log('[migration] marked temp hired before its hiring was persisted:', id);
    }
  } catch (e) {
    console.error('[migration] markLegacyTemps failed:', e);
  }
}

/** When did this worker post its terminal `act:"done"` — or null when it has
 *  not yet. Scans its own outbox AND outbox/.sent (the router archives delivered
 *  mail there ~every 1.5s), so the signal is caught whether or not it's been
 *  routed out yet. The timestamp (the newest done, if several) is the cut-off
 *  for settling its inbox: mail that arrived after it is still pending.
 *
 *  Stale-done guard: agent dirs persist after teardown, so REUSING a reqId would
 *  leave a PRIOR worker's `done` sitting in this same dir. Without a guard that
 *  stale signal would release the new worker on its very first tick — before it
 *  does anything or replies — causing a silent Slack hang. So we only count a
 *  `done` authored AFTER this worker spawned: by its `created_at` (the message's
 *  own timestamp), falling back to the file's mtime when `created_at` is missing
 *  or unparseable. When neither yields a usable timestamp we DON'T count it
 *  (fail toward keeping the worker alive — the idle reaper is the backstop). */
function workerDoneAt(workerId: string, spawnedAt: number): number | null {
  const root = hive.root();
  if (!root) return null;
  return latestDone(join(root, 'agents', workerId), spawnedAt)?.at ?? null;
}

/** Who a spawn request comes from, beyond the file itself. Set by main from
 *  WHERE the file sits or which trigger fired, never read from the request. */
interface SpawnCtx {
  /** A lasting agent's own request (agents/<id>/spawn-requests/): it hears
   *  the refusals and the temp's done, and the temp runs in its folder, on its
   *  engine unless the request picks another, with at most its access. */
  parent?: string;
  /** A trigger's "A temp, clone of <agent>": the temp takes that agent's
   *  engine, model, role and access, for one job. */
  cloneOf?: string;
  /** Started by a trigger whose "who answers" is a temp (results go to the
   *  orchestrator). */
  trigger?: boolean;
  /** Where the request is filed once processed (default the hive's spawn-requests/). */
  queueDir?: string;
}

/** What the renderer's roster (roster.json) knows about an agent that the
 *  registry does not: its engine, model, look and standing goal. */
function rosterEntry(agentId: string): { provider?: AgentProvider; model?: string; character?: string; accent?: string; goal?: string; cwd?: string; worktreePath?: string } | null {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    if (a.id !== agentId) continue;
    const s = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
      provider: isAgentProvider(a.provider) ? a.provider : undefined,
      model: s(a.model), character: s(a.character), accent: s(a.accent), goal: s(a.goal), cwd: s(a.cwd), worktreePath: s(a.worktreePath)
    };
  }
  return null;
}

/** Give temp `tempId` the access of agent `fromId` and no more
 *  (shared/agentTemps.ts). Best-effort; written before the temp spawns. */
function applyTempAccess(fromId: string, tempId: string): void {
  try {
    const cfg = readConfig() as unknown as AccessConfig;
    const patch = changedAccess(cfg, inheritedAccess(cfg, fromId, tempId));
    if (Object.keys(patch).length) writeConfig(patch as unknown as Partial<HarnessConfig>);
  } catch (e) { console.error('[worker] could not apply a temp\'s access:', e); }
}

/** Forget every per-agent grant for a temp that is gone for good. */
function forgetTempAccess(tempId: string): void {
  try {
    const cfg = readConfig() as unknown as AccessConfig;
    const patch = changedAccess(cfg, withoutAccess(cfg, tempId));
    if (Object.keys(patch).length) writeConfig(patch as unknown as Partial<HarnessConfig>);
  } catch (e) { console.error('[worker] could not clear a temp\'s access:', e); }
}

/** Spin up one ephemeral worker from a spawn-request. Terminal failures (bad
 *  request, missing CLI, spawn error) archive to .failed and inform whoever
 *  asked (the orchestrator WITH the Slack coords so it can post a 'couldn't
 *  start' reply, or the agent whose request it was). On success the worker is
 *  registered (for done-scan / reaping / safe teardown) and dispatched its
 *  objective via the standard inbox path. True when it started. */
async function processSpawnRequest(filePath: string, ctx: SpawnCtx = {}): Promise<boolean> {
  const owner = ctx.parent;
  const queueDir = ctx.queueDir;
  let raw: SpawnRequest;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as SpawnRequest;
  } catch (e) {
    console.error('[worker] unparseable spawn-request:', filePath, e);
    informOwner(owner, '[worker spawn rejected] unparseable request', `Could not parse spawn-request ${basename(filePath)} — ${String(e)}`);
    archiveRequest(filePath, '.failed', queueDir);
    return false;
  }
  // An agent's own temp does not post to Slack: the agent that asked answers
  // its thread itself once the temp's done reaches it.
  const slack = !owner && raw.slack && typeof raw.slack.channel === 'string' && typeof raw.slack.thread_ts === 'string'
    ? { channel: raw.slack.channel, thread_ts: raw.slack.thread_ts } : undefined;
  const fail = (reason: string): false => {
    informOwner(owner, `[worker spawn rejected] ${reason}`, `Spawn-request ${basename(filePath)} rejected: ${reason}.`, slack);
    archiveRequest(filePath, '.failed', queueDir);
    return false;
  };

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
  if (!objective) return fail('missing "objective"');

  // The agent whose access (and, unless the request says otherwise, engine) the
  // temp gets: the one that asked for it, or the one a trigger clones.
  const accessFrom = owner ?? ctx.cloneOf;
  const reg = hive.registry();
  const src = accessFrom ? reg.agents[accessFrom] : undefined;
  if (accessFrom && !src) return fail(`there is no agent "${accessFrom}"`);
  if (ctx.cloneOf) {
    const why = cloneProblem(src, isCustodian(criticalMap(), ctx.cloneOf));
    if (why) return fail(why);
  }
  const srcEntry = accessFrom ? rosterEntry(accessFrom) : null;

  const baseId = (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : basename(filePath).replace(/\.json$/i, ''));
  // An agent's request ids are its own: two agents both asking for "review"
  // must not collide, and the id says whose temp it is.
  const reqId = (owner ? `${owner}-${baseId}` : baseId).replace(/[^A-Za-z0-9._-]/g, '-');
  const workerId = `worker-${reqId}`;
  if (liveWorkers.has(workerId)) return fail(`worker "${workerId}" already running`);

  // Worker request files are hand/LLM-authored, so `~/…` shows up here too — expand
  // before the existence check (Node reads `~` literally).
  // A WSL floor's god runs inside the distro, so it writes Linux paths
  // (`/home/u/repo`, `~/repo`): open them through \\wsl.localhost.
  const floorWsl = hive.wslRoot();
  // An agent's temp works in the agent's own folder unless it names one inside
  // it; a clone works where the agent it copies does.
  const rawCwd = ctx.cloneOf ? '' : typeof raw.cwd === 'string' ? raw.cwd.trim() : '';
  const cwd = !rawCwd ? (src?.cwd ?? '')
    : floorWsl ? fromLinuxPath(rawCwd, floorWsl.distro, () => distroHomeUnc(floorWsl.distro))
    : expandTilde(rawCwd);
  // A network path is refused before anything touches it: even existsSync on
  // \\host\share makes Windows connect and offer the user's NTLM hash. The
  // only UNC paths allowed are this floor's own distro.
  if (cwd && !uncAllowed(cwd)) return fail(`"cwd" may not be a network path (${cwd})`);
  if (!cwd || !existsSync(cwd)) return fail(`"cwd" missing or not found (${cwd || 'unset'})`);

  // Request line → executable + argv (auto-mode inheritance, tokenization,
  // model-flag dedupe). Pure and unit-tested — see workerLaunch.ts for why this
  // translation earned a test. A clone runs on its agent's engine and model; an
  // agent's temp on the agent's own unless the request picks one.
  const cfgSpawn = readConfig();
  const picksEngine = !ctx.cloneOf && (!!raw.command || !!raw.provider);
  const asked = isAgentProvider(raw.provider) ? raw.provider : undefined;
  const provider: AgentProvider | undefined = picksEngine ? asked : (srcEntry?.provider ?? src?.provider ?? asked);
  const launch = buildWorkerLaunch({
    requestCommand: ctx.cloneOf ? undefined : raw.command,
    requestProvider: provider,
    requestModel: ctx.cloneOf ? srcEntry?.model : (raw.model ?? (picksEngine ? undefined : srcEntry?.model)),
    defaultCommand: cfgSpawn.defaultCommand,
    autoMode: !!cfgSpawn.autoMode
  });
  const bin = launch.bin;
  // Validate the executable name on the spawn path. A spawn-request file is
  // untrusted input (authored by the orchestrator, reachable by anything that can
  // write HIVE_ROOT/spawn-requests), so the bin must be a plain command token or
  // an absolute path — never a string a downstream shell `which`/`where` could
  // reinterpret. Rejected here, before any resolution; the resolver guards behind
  // it validate the same thing in depth.
  if (!isSafeCommandName(bin) && !isAbsolute(bin)) {
    return fail(`refusing spawn: engine command "${bin}" is not a plain command name or an absolute path`);
  }
  // The request file is untrusted (any agent can write the hive): only an agent
  // CLI, with no settings/MCP/backend flags, in a folder the user set up. An
  // agent's temp stays inside that agent's own working folder.
  {
    const providers: AgentProvider[] = ['claude', 'codex', 'grok', 'kimi', 'gemini', 'antigravity', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor'];
    const bins = [
      ...providers.map((pr) => tokenizeCommand(defaultCommandForProvider(pr))[0] ?? ''),
      tokenizeCommand(cfgSpawn.defaultCommand ?? '')[0] ?? ''
    ];
    const roots = src
      ? [src.cwd, srcEntry?.cwd ?? '', srcEntry?.worktreePath ?? '']
      : [
        ...(cfgSpawn.registeredRepos ?? []),
        cfgSpawn.harnessHome ?? '',
        ...Object.values(reg.agents ?? {}).map((a) => (a as { cwd?: string }).cwd ?? '')
      ];
    const problem = workerRequestProblem(launch, cwd, { bins, roots, caseInsensitive: process.platform === 'win32' });
    if (problem) return fail(`refusing spawn: ${src && problem.includes('is not a registered repo') ? `"${cwd}" is outside ${src.name ?? accessFrom}'s working folder (${src.cwd})` : problem}`);
  }
  // Missing-CLI → FAIL FAST. A headless worker has no human to watch an installer,
  // so we never run the cc49e1e install banner here — we reject and tell god.
  // On a WSL floor the worker runs inside the distro: look for the CLI there.
  const cwdWsl = process.platform === 'win32' ? parseWslPath(cwd) : null;
  if (cwdWsl) {
    const there = bin.startsWith('/')
      ? existsSync(toWslUnc(cwdWsl.distro, bin))
      : !!(await probeInDistro(cwdWsl.distro, [bin]))[bin];
    if (!there) return fail(`engine CLI "${bin}" is not installed inside WSL (${cwdWsl.distro})`);
  } else if (!ptyManager.isCommandAvailable(bin)) return fail(`engine CLI "${bin}" is not installed`);

  const isolate = raw.isolate !== false; // default true
  // Base branch the worktree will be cut from (for the ahead-of-base safety check).
  let baseBranch = 'main';
  try { const br = await getBranch(cwd); if ('current' in br && br.current) baseBranch = br.current; } catch { /* keep default */ }

  const requestedName = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : '';
  const meta: AgentMeta = {
    id: workerId,
    name: requestedName || (ctx.cloneOf && src ? `${src.name} (temp)` : `Worker ${reqId.slice(0, 12)}`),
    provider,
    // A clone does its agent's job: same role and capabilities.
    role: ctx.cloneOf && src?.role ? src.role : 'worker',
    ...(ctx.cloneOf && src?.capabilities?.length ? { capabilities: [...src.capabilities] } : {}),
    cwd
  };
  // Never more than the agent it comes from: copied before the spawn reads the
  // config (MCP grants, tool blocks, scopes, the broker grant below).
  if (accessFrom) applyTempAccess(accessFrom, workerId);
  // Phase 2: grant this worker a broker capability over the currently-enabled
  // integrations and inject the broker URL + a per-worker capability TOKEN (a handle,
  // never a secret) into its env, so it can reach registered REST integrations through
  // the loopback secret broker without ever seeing a credential. Only when the broker
  // is up; the grant is revoked in teardownPty (and below if the spawn fails).
  const brokerEnv: Record<string, string> = {};
  if (integrationBroker.running()) {
    const apis = apisFor(workerId);
    const token = integrationBroker.grant(workerId, apis.ids, apis.access, workerId);
    Object.assign(brokerEnv, bothEnv('BROKER_URL', integrationBroker.url()), bothEnv('BROKER_TOKEN', token));
  }
  const spawnOpts: AgentSpawnOptions = {
    id: workerId, cwd, command: bin, cols: 120, rows: 32,
    args: launch.args,
    hive: meta, temp: true, isolate, provider, env: brokerEnv
  };

  let res: { ok: boolean; error?: string; worktreePath?: string };
  try {
    res = await spawnAgentCore(spawnOpts, liveWebContents());
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res.ok) {
    integrationBroker.revoke(workerId);
    if (accessFrom) forgetTempAccess(workerId);
    return fail(`spawn failed — ${res.error ?? 'unknown error'}`);
  }

  // A god-hired worker is a MAIN-initiated spawn, so the renderer would never
  // card it on its own (same reason as the voice-spawn broadcast): without this
  // the worker is invisible on the floor, never enters the roster, and after a
  // restart nothing offers to restore it. The card rides the normal agent
  // lifecycle from here — teardownPty broadcasts the matching archive. A card
  // RESTORED after an app quit revives through the renderer's normal spawn path;
  // the hiring is persisted in the registry (setTemp below), so pty:spawn puts
  // an unfinished temp back under this controller and refuses a finished one.
  const card = {
    id: workerId,
    name: meta.name,
    provider: provider ?? 'claude',
    cwd: res.worktreePath ?? cwd,
    command: launch.command,
    role: meta.role,
    worktreePath: res.worktreePath,
    character: typeof raw.character === 'string' ? raw.character : (ctx.cloneOf ? srcEntry?.character : undefined),
    accent: typeof raw.accent === 'string' ? raw.accent : (ctx.cloneOf ? srcEntry?.accent : undefined)
  };
  try {
    liveWebContents()?.send('hive:agentSpawned', card);
  } catch { /* window torn down */ }

  // Register for done-scan / idle-reap / token-cap / safe teardown (pty id == workerId).
  // tokenCap is optional plumbing (default unlimited) — only a positive finite cap is kept.
  const tokenCap = typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0
    ? raw.tokenCap : undefined;
  const spawnedAt = Date.now();
  liveWorkers.set(workerId, { workerId, reqId, name: meta.name, objective, slack, baseBranch, spawnedAt, tokenCap, card, parent: owner });
  // …and on disk, so a restart does not turn it into a permanent agent.
  const hiredBy: TempHiring['hiredBy'] = owner ? 'agent' : ctx.trigger ? 'trigger' : basename(dirname(filePath)) === 'human' ? 'human' : 'orchestrator';
  hive.setTemp(workerId, { reqId, spawnedAt, baseBranch, tokenCap, objective, slack, hiredBy, ...(owner ? { parent: owner } : {}), ...(accessFrom ? { accessFrom } : {}) });

  // Dispatch the objective via the standard inbox path (zero new transport),
  // reusing the autonomous-request preamble so the worker gets the exact Slack
  // reply command + autonomy policy. From whoever started it (god for its own,
  // the human's and the triggers'), so the worker treats it as a dispatch from
  // them and its done goes back there.
  const boss = owner ?? 'god';
  try {
    const prefix = slack
      ? buildAutonomousRequestProtocol(slack.channel, slack.thread_ts, slackReplyScriptPath())
      : '[AUTONOMOUS WORKER TASK — no interactive human is watching. Work autonomously; do not ask interactive questions.] The task starts now: ';
    const goal = ctx.cloneOf ? srcEntry?.goal : undefined;
    const cloneNote = ctx.cloneOf && src
      ? `[TEMP COPY] You are a one-job copy of ${src.name} (${src.id})${src.role ? `, whose job is: ${src.role}` : ''}.${goal ? ` Their standing goal: ${goal}.` : ''} Work as they would, on this one job; you are archived when you send your done.\n\n`
      : '';
    const ownerNote = owner && src
      ? `[TEMP] ${src.name} (${owner}) started you for this one job. Report to them, not to god.\n\n`
      : '';
    const suffix = `\n\n[CAPABILITIES] Before you start, consult your capability catalog — run the \`/capabilities\` skill (or read \`$AGENT_DIR/.claude/skills/capabilities/SKILL.md\`). It lists your temporal date-range skills (\`/today\`, \`/last30Days\`, \`/lastQuarter\`, …) and the integrations available to you (reached via the loopback broker) and how to call each. For any time-scoped work, resolve the dates with those skills instead of computing them by hand.\n\n[WORKER COMPLETION] When finished, signal done by sending ONE outbox message to ${boss} with "act":"done" and a short result summary — that releases this ephemeral worker (terminal closed; your branch is handed to ${owner ? src?.name ?? owner : 'god'}). Do NOT push to any remote; god is the sole integrator.`;
    // The cap the tick will hold it to (per-request, else the config default).
    const effectiveCap = tokenCap ?? (typeof cfgSpawn.defaultWorkerTokenCap === 'number' && cfgSpawn.defaultWorkerTokenCap > 0 ? cfgSpawn.defaultWorkerTokenCap : 0);
    const capNote = effectiveCap > 0 ? `\n\n${capDispatchNote(effectiveCap)}` : '';
    hive.send({ to: workerId, conversation: `worker-${reqId}`, act: 'request', subject: meta.name, body: `${ownerNote}${cloneNote}${prefix}${objective}${suffix}${capNote}` }, boss);
  } catch (e) {
    console.error('[worker] dispatch send failed:', e);
  }

  console.log(`[worker] spawned ${workerId} (cwd=${cwd}, base=${baseBranch}${slack ? ', slack' : ''}${owner ? `, for ${owner}` : ''}${ctx.cloneOf ? `, clone of ${ctx.cloneOf}` : ''})`);
  // The agent that asked hears which temp it got (the id to archive it by).
  if (owner) informOwner(owner, `[temp started] ${workerId}`, `${meta.name} (${workerId}) started for your request ${basename(filePath)}. Its done comes back to your inbox; no need to poll.`);
  archiveRequest(filePath, '.done', queueDir);
  return true;
}

/** WORK tokens (input+output+cache writes, no cached reads) a worker has burned
 *  so far, from the usage provider — 0 when unknown. The breaker's per-agent
 *  budget figure (`workTokensOf`). Used by the (default-off) per-worker token cap. */
function workerTokensUsed(workerId: string): number {
  return workTokensOf(usageProvider.getAgentUsage(workerId));
}

/** Throttle for the GC sweep — git checks are cheap but pointless every 1.5s tick. */
const GC_SWEEP_MS = 60_000;
let lastGcSweepAt = 0;
let gcSweepRunning = false;

/** Reclaim preserved worker worktrees (+ their scratch dirs) whose work is now
 *  integrated, or whose worktree was already removed by hand. Fail-safe: a worktree
 *  is removed ONLY when `worktreeIsGcSafe` proves it clean AND integrated; any doubt
 *  KEEPS it (never discards un-integrated work — god is the sole integrator). Runs
 *  inside the worker tick, throttled to GC_SWEEP_MS, and is a no-op when nothing is
 *  preserved (the common case → zero cost). */
async function gcPreservedWorktrees(): Promise<void> {
  if (gcSweepRunning || preservedWorktrees.size === 0) return;
  gcSweepRunning = true;
  try {
    for (const [key, e] of [...preservedWorktrees]) {
      // A worker id that is live again (reqId reuse) → never GC its worktree or
      // scratch out from under the new run; leave the stale entry for a later sweep.
      if (liveWorkers.has(e.workerId)) continue;
      // (a) Worktree already gone (removed at clean teardown, or god removed it by
      //     hand per the preserve note) → just reclaim the scratch dir + drop tracking.
      if (!existsSync(e.wtPath)) {
        removeWorkerScratch(e.workerId);
        preservedWorktrees.delete(key);
        console.log(`[worker gc] ${e.workerId}: worktree already gone — reclaimed scratch`);
        continue;
      }
      // (b) Still on disk → reclaim ONLY when provably integrated + clean.
      const deps = await unlinkWorktreeDeps(e.origCwd, e.wtPath);
      if (!deps.ok) { console.error('[worker gc] dependency unlink failed (keeping):', deps.error); continue; }
      let safe: { gc: boolean; detail: string };
      try { safe = await worktreeIsGcSafe(e.wtPath, e.baseBranch); }
      catch (err) { console.error('[worker gc] gc-safe check threw (keeping):', err); continue; }
      if (!safe.gc) continue; // keep — fail-safe
      const r = await removeWorktree(e.origCwd, e.wtPath);
      if (!r.ok) { console.error(`[worker gc] removeWorktree failed (keeping ${e.workerId}):`, r.error); continue; }
      removeWorkerScratch(e.workerId);
      preservedWorktrees.delete(key);
      console.log(`[worker gc] reclaimed ${e.workerId} (${safe.detail})`);
      informGod(
        `[worker worktree reclaimed] ${e.workerId}`,
        `The preserved worktree for ${e.workerId} is now integrated (${safe.detail}), so it and its scratch dir were garbage-collected.\nWorktree: ${e.wtPath}`,
        e.slack
      );
    }
  } finally {
    gcSweepRunning = false;
  }
}

/** One controller tick: (1) finish/reap live workers (frees slots), then (2) pull
 *  new requests up to the concurrency cap. Order matters so a freed slot is reused
 *  the same tick. */
async function ephemeralWorkerTick(): Promise<void> {
  if (workerTickRunning) return;
  workerTickRunning = true;
  try {
    const cfg = readConfig();
    offerOrchestratorHires();
    recordTaskHistory();
    const maxWorkers = tempsAtOnce(cfg.maxConcurrentWorkers);
    const idleTimeoutMs = Math.max(1, cfg.workerIdleTimeoutMinutes ?? 20) * 60_000;
    // Per-worker token cap. 0 = UNLIMITED (the default — wired but never throttles
    // unless a positive cap is set per-request or via defaultWorkerTokenCap).
    const defaultTokenCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;

    // (1) Finish or reap. Each release calls teardownPty EXPLICITLY after the
    //     kill, like every other kill site: ptyManager.kill() deletes the session
    //     synchronously, so when node-pty's async onExit later fires it fails the
    //     session-identity guard and the global exit handler (→ teardownPty)
    //     never runs. Relying on onExit here left released workers un-torn-down:
    //     no hive archive, no hive:agentArchived, frozen floor cards, and god
    //     kept mailing dead agents (seen live 2026-08-16 with worker-business/
    //     worker-qa/worker-bizreview). A double teardown is a harmless no-op.
    for (const [workerId, rec] of [...liveWorkers]) {
      if (rec.releasing) continue;
      const doneAt = workerDoneAt(workerId, rec.spawnedAt);
      if (doneAt !== null) {
        // Success: the worker already replied in-thread; just release it.
        rec.releasing = true;
        console.log(`[worker] ${workerId} signaled done — releasing`);
        logWork(rec, 'done', { result: workerDoneText(workerId, rec.spawnedAt) });
        // A temp another agent started reports to that agent. Its done usually
        // already went there (it was dispatched from them); one addressed
        // elsewhere (god, by habit) is forwarded so the result is not lost.
        if (rec.parent) {
          const root = hive.root();
          const done = root ? latestDone(join(root, 'agents', workerId), rec.spawnedAt) : null;
          if (done && done.to !== rec.parent) {
            try {
              hive.send({ to: rec.parent, conversation: `worker-${rec.reqId}`, act: 'done', subject: `[temp done] ${rec.name ?? workerId}`, body: done.text || '(no summary)' }, workerId);
            } catch (e) { console.error('[worker] forwarding a temp\'s done failed:', e); }
          }
        }
        // Its mailbox is finished with too. Workers seldom file their own work
        // order before signaling done, and the id is reused on every re-hire of
        // the same name, so anything left unread here would greet the next
        // incarnation as "pending" work (seen live 2026-09-07: 13 of 30 worker
        // inboxes carried finished orders; a re-hired worker spent its first
        // turns re-triaging yesterday's, and the watchdog read it as mail
        // unanswered for 21h). Only the DONE path settles — an idle/token-cap
        // reap never signaled completion, so its unread mail stays pending —
        // and only mail from BEFORE the done signal: a follow-up that crossed
        // the worker's done is still nobody's, so it stays pending. God hears
        // which requests/queries were filed unread, so none vanishes silently.
        const settled = hive.settleInbox(workerId, doneAt);
        if (settled.moved > 0) console.log(`[worker] ${workerId}: filed ${settled.moved} unread inbox message(s) under inbox/.done`);
        if (settled.kept > 0) console.log(`[worker] ${workerId}: left ${settled.kept} message(s) that arrived after its done signal pending`);
        // The worker's own work order is dispatched in conversation
        // `worker-<reqId>` (processSpawnRequest) and is exactly what it just
        // completed: reporting it "filed unread" on every release would cost
        // god a turn each time for nothing. Only OTHER requests/queries count.
        // Subjects are agent-written: keep each on its own line.
        const unanswered = settled.unanswered.filter((m) => m.conversation !== `worker-${rec.reqId}`);
        if (unanswered.length > 0) {
          const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');
          const lines = unanswered.map((m) => `- ${m.act} ${oneLine(m.id)} from ${oneLine(m.from)}: "${oneLine(m.subject)}"`);
          informOwner(
            rec.parent,
            `[worker released — mail filed unread] ${workerId}`,
            `Worker ${workerId} signaled done and was released. These messages were still unread in its inbox and were filed under inbox/.done without an answer:\n`
            + lines.join('\n')
            + `\nIf one of them is not the order it just completed, nobody is working on it — resend it to another agent or re-hire the worker.`,
            rec.slack
          );
        }
        ptyManager.kill(workerPty(rec));
        teardownPty(workerPty(rec));
        continue;
      }
      // Token cap (default-off plumbing). An effective cap > 0 → at 80% the worker
      // is asked once to wrap up; above the cap it is reaped, and god hears its
      // last outbox message. Its committed work is preserved.
      const tokenCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : defaultTokenCap;
      const used = tokenCap > 0 ? workerTokensUsed(workerId) : 0;
      const stage = capStage(used, tokenCap, !!rec.capWarned);
      if (stage === 'warn') {
        rec.capWarned = true;
        console.warn(`[worker] ${workerId} near its token cap (${used.toLocaleString()} of ${tokenCap.toLocaleString()}) — asking it to wrap up`);
        try {
          hive.send({ to: workerId, conversation: `worker-${rec.reqId}`, act: 'request', subject: 'Token budget almost spent: wrap up', body: capWarningBody(used, tokenCap) }, rec.parent ?? 'god');
        } catch (e) { console.error('[worker] cap warning send failed:', e); }
      } else if (stage === 'reap') {
        rec.releasing = true;
        console.warn(`[worker] reaping ${workerId} — token cap (${used.toLocaleString()} > ${tokenCap.toLocaleString()})`);
        logWork(rec, 'tokens');
        const root = hive.root();
        const last = root ? lastWords(lastOutboxMessage(join(root, 'agents', workerId), rec.spawnedAt)) : lastWords(null);
        informOwner(
          rec.parent,
          `[worker reaped — token cap] ${workerId}`,
          `Worker ${workerId} used ${used.toLocaleString()} tokens (> its cap of ${tokenCap.toLocaleString()}) and was reaped. Any committed work on its branch is preserved for you.\n${last}`,
          rec.slack
        );
        ptyManager.kill(workerPty(rec));
        teardownPty(workerPty(rec));
        continue;
      }
      const idleMs = ptyManager.idleFor(workerPty(rec));
      if (idleMs === undefined) continue; // PTY already gone; teardownPty cleans up
      if (idleMs > idleTimeoutMs) {
        rec.releasing = true;
        console.warn(`[worker] reaping idle ${workerId} (${Math.round(idleMs / 60000)}min idle)`);
        logWork(rec, 'idle');
        informOwner(
          rec.parent,
          `[worker reaped — idle] ${workerId}`,
          `Worker ${workerId} produced no output for ${Math.round(idleMs / 60000)} min (> the ${Math.round(idleTimeoutMs / 60000)} min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.`,
          rec.slack
        );
        ptyManager.kill(workerPty(rec));
        teardownPty(workerPty(rec));
      }
    }

    // (2) Process new requests, honoring the concurrency cap (backpressure: leave
    //     the rest in the queue for a later tick).
    //
    //     Gated on config.orchestratorMaySpawn (default OFF): letting the
    //     orchestrator spin up agents unprompted is a SPEND decision, so the
    //     operator opts in. The gate sits HERE, on intake, and not on the watcher
    //     itself, because step (1) above owns the lifecycle of workers that are
    //     already running — reaping, teardown, the Slack failure notice — and
    //     turning the toggle off mid-flight must not strand them.
    //
    //     Declining also means declining to CONSUME. A request dropped in while
    //     this is off stays in the queue and runs when it is turned on, rather
    //     than being eaten and failed for a reason god never asked about.
    const dir = readConfig().orchestratorMaySpawn ? spawnRequestsDir() : null;
    // Off: ask the operator instead of leaving the request waiting unseen
    // (the orchestrator only knew it was stuck because nothing happened).
    if (!dir) void askToSpawnPending();
    if (dir && existsSync(dir)) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* dir vanished */ }
      for (const f of files) {
        if (liveWorkers.size >= maxWorkers) break;
        await processSpawnRequest(join(dir, f));
      }
    }

    // (2b) The orchestrator's Automations requests (create/update/delete a
    //      scheduled mission). Not gated by orchestratorMaySpawn: every change
    //      shows up in Automations and is reported back to the orchestrator.
    processScheduleRequests();
    // (2c) The orchestrator archiving a temp it hired. Not gated either: it
    //      only ever lets go of a worker, which costs nothing.
    processArchiveRequests();
    // (2d) Every other lasting agent's own temps: its spawn and archive
    //      requests, under the quota the human gave it.
    await processAgentTempRequests();
    await processTeamRequests();
    await processSkillRequests().catch((e) => console.error('[skills] requests failed:', e));

    // (3) GC preserved worktrees whose work has since integrated. Throttled to
    //     GC_SWEEP_MS and a no-op when nothing is preserved (the common case).
    const now = Date.now();
    if (preservedWorktrees.size > 0 && now - lastGcSweepAt >= GC_SWEEP_MS) {
      lastGcSweepAt = now;
      await gcPreservedWorktrees();
    }
  } catch (e) {
    console.error('[worker] tick error:', e);
  } finally {
    workerTickRunning = false;
  }
}

function startEphemeralWorkerWatcher(): void {
  if (workerWatchTimer || !hive.enabled()) return;
  // Both queues exist up front: an orchestrator writing its first archive
  // request into a missing folder got "No such file or directory".
  for (const dir of [spawnRequestsDir(), archiveRequestsDir()]) {
    if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { /* noop */ } }
  }
  workerWatchTimer = setInterval(() => { void ephemeralWorkerTick(); }, WORKER_TICK_MS);
}

function stopEphemeralWorkerWatcher(): void {
  if (workerWatchTimer) { clearInterval(workerWatchTimer); workerWatchTimer = null; }
}

/** Snapshot of one live ephemeral worker for the renderer Workers tab. */
interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY already gone
  tokensUsed: number;
  tokenCap: number | null;      // effective cap (per-request or config default); null = unlimited
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working';
}
/** Snapshot of a preserved-but-not-yet-GC'd worktree for the tab. */
interface PreservedSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

/** List live ephemeral workers (+ preserved worktrees awaiting GC) for the tab. */
/** Floor cards of the live workers — the renderer replays these on mount so a
 *  worker spawned before it subscribed to hive:agentSpawned is not invisible. */
ipcMain.handle('workers:cards', () =>
  [...liveWorkers.values()].filter((w) => !w.releasing && w.card).map((w) => w.card));
ipcMain.handle('workers:list', (): { live: WorkerSnapshot[]; preserved: PreservedSnapshot[]; maxWorkers: number } => {
  const cfg = readConfig();
  const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
    ? cfg.defaultWorkerTokenCap : 0;
  const now = Date.now();
  const live: WorkerSnapshot[] = [...liveWorkers.values()].map((rec) => {
    const idle = ptyManager.idleFor(workerPty(rec));
    const effCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : (defaultCap > 0 ? defaultCap : 0);
    return {
      workerId: rec.workerId,
      reqId: rec.reqId,
      name: rec.name ?? rec.workerId,
      baseBranch: rec.baseBranch,
      spawnedAt: rec.spawnedAt,
      ageMs: Math.max(0, now - rec.spawnedAt),
      idleMs: idle === undefined ? null : idle,
      tokensUsed: workerTokensUsed(rec.workerId),
      tokenCap: effCap > 0 ? effCap : null,
      hasSlack: !!rec.slack,
      releasing: !!rec.releasing,
      status: rec.releasing ? 'releasing' : 'working'
    };
  });
  const preserved: PreservedSnapshot[] = [...preservedWorktrees.values()].map((e) => ({
    workerId: e.workerId, wtPath: e.wtPath, baseBranch: e.baseBranch, preservedAt: e.preservedAt
  }));
  return { live, preserved, maxWorkers: tempsAtOnce(cfg.maxConcurrentWorkers) };
});

/** Manually stop a live ephemeral worker. Mirrors the done-release path: mark
 *  releasing, then kill + teardownPty runs the SAFETY-GATED worktree teardown
 *  (committed work is preserved, never force-discarded). Idempotent. teardownPty
 *  is called explicitly (D10) rather than left to the PTY's natural exit: kill()
 *  frees the manager's id slot synchronously, so by the time the process's real
 *  exit arrives the exit-handler's stale-id guard already misreads it as a
 *  reclaimed id and skips teardown — the worker would stay "live" in registry.json
 *  and fleet.json forever after this call. */
ipcMain.handle('workers:stop', (_evt, workerId: string): { ok: boolean; error?: string } => {
  if (typeof workerId !== 'string' || !workerId) return { ok: false, error: 'invalid worker id' };
  const rec = liveWorkers.get(workerId);
  if (!rec) return { ok: false, error: 'no such live worker' };
  if (rec.releasing) return { ok: true }; // already stopping
  rec.releasing = true;
  console.log(`[worker] manual stop requested for ${workerId}`);
  try { ptyManager.kill(workerPty(rec)); } catch (e) { return { ok: false, error: String(e) }; }
  teardownPty(workerPty(rec));
  return { ok: true };
});

/** Pro Temps: the HUMAN hires a temp for one job. Same path as a god
 *  spawn-request (fresh worktree, objective through the inbox, released on
 *  `done`), minus the orchestratorMaySpawn gate: that toggle governs god spending
 *  unprompted, and here the human is the one asking. The concurrency cap still
 *  holds. Human requests sit in their own subfolder so the god queue's intake
 *  never picks them up a second time. */
ipcMain.handle('workers:hire', async (_evt, req: unknown): Promise<{ ok: boolean; workerId?: string; error?: string }> => {
  const r = (req && typeof req === 'object' ? req : {}) as { objective?: unknown; cwd?: unknown; name?: unknown };
  const objective = typeof r.objective === 'string' ? r.objective.trim() : '';
  const cwd = typeof r.cwd === 'string' ? r.cwd.trim() : '';
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : '';
  if (!objective) return { ok: false, error: 'Say what the job is.' };
  if (!cwd) return { ok: false, error: 'Pick the folder the temp works in.' };
  const queue = spawnRequestsDir();
  if (!queue) return { ok: false, error: 'No hive is open.' };
  const cfg = readConfig();
  if (liveWorkers.size >= tempsAtOnce(cfg.maxConcurrentWorkers)) {
    return { ok: false, error: 'Every temp desk is taken. Wait for one to finish or stop one.' };
  }
  const id = `temp-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;
  const dir = join(queue, 'human');
  const file = join(dir, `${id}.json`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ id, objective, cwd, ...(name ? { name } : {}) }, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: String(e) };
  }
  await processSpawnRequest(file);
  const workerId = `worker-${id}`;
  return liveWorkers.has(workerId)
    ? { ok: true, workerId }
    : { ok: false, error: 'The temp did not start; the orchestrator has the details in its inbox.' };
});

/** Start every hive-bound background service against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). No-op without a home. */
/** The office this process runs (officeLock.ts), so quitting gives it back. */
let claimedOffice: string | null = null;
function releaseClaimedOffice(): void {
  releaseOffice(claimedOffice);
  claimedOffice = null;
}
process.on('exit', releaseClaimedOffice);

/** Another floor already runs this office: say so, and leave it alone. */
function officeTakenElsewhere(home: string): void {
  const show = () => {
    const opts = {
      type: 'warning' as const,
      message: 'This office is already open on another floor',
      detail: `${home}

One office runs in one window at a time, so two orchestrators never share its inbox and history. Use the other window, or pick a different office here.`,
      buttons: ['Pick another office', 'Close this window'],
      defaultId: 0,
      cancelId: 1
    };
    const w = BrowserWindow.getAllWindows()[0];
    void (w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts)).then(({ response }) => {
      allowQuit = true;
      if (response === 0) { writeConfig({ harnessHome: null }); relaunchApp(); }
      app.exit(0);
    });
  };
  if (app.isReady()) show(); else void app.whenReady().then(show);
}

function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  const home = readConfig().harnessHome;
  if (home && claimedOffice !== resolve(home)) {
    const claim = claimOffice(resolve(home));
    if (!claim.ok) { officeTakenElsewhere(home); return; }
    claimedOffice = resolve(home);
  }
  freezes.time('boot: hive.ensureHive', () => hive.ensureHive());
  // Off the main thread, and only the docs that changed (agents read them later).
  void hive.refreshGeneratedDocsAsync().catch((e) => console.error('[hive] refreshing protocol docs failed:', e));
  // An office inside a project's repo: keep its files out of that repo's git.
  const officeDir = readConfig().harnessHome;
  if (officeDir) void excludeOfficeFromRepo(officeDir);
  // Tell the hive what it is running inside, BEFORE anything spawns: the prompt
  // builder reads this, so an agent spawned earlier would never learn it.
  hive.setRuntimeInfo({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() });
  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  // Each agent's "Temps per agent", read when its prompt is built.
  hive.setTempQuota((id) => tempQuotaOf(readConfig().agentTempQuota, id));
  // An app-start marker in the event log. log.jsonl had twelve event kinds and
  // none of them meant "the app restarted", so a relaunch, and more importantly a
  // switch between a packaged build and a local one, was invisible to every agent
  // reading the feed. That gap cost a multi-hour investigation whose answer was
  // exactly this: a local build inherits the launching shell's umask, a
  // Finder-launched app does not.
  hive.appendLog({
    kind: 'app-start',
    version: app.getVersion(),
    packaged: app.isPackaged,
    // WHICH bundle, not just which version. Version plus packaged is not enough
    // to tell two builds apart: a stale copy in /Applications and a fresh one in
    // dist/ can report the same version and both be packaged, and picking the
    // wrong one by habit looks exactly like the new build being broken. Cost us
    // twice before this line existed.
    appPath: app.getAppPath(),
    exePath: process.execPath,
    electron: process.versions.electron,
    platform: process.platform
  });
  control.replaceAutoDeliveryPauses(readConfig().autoDeliveryPausedAgents ?? []);
  freezes.time('boot: markLegacyTemps', () => markLegacyTemps()); // temps hired before the hiring was persisted
  freezes.time('boot: archiveOrphanedAgents', () => archiveOrphanedAgents()); // #57/#58: archive stale archived:false entries with no live PTY
  freezes.time('boot: hive.startRouter', () => hive.startRouter());
  freezes.time('boot: startEphemeralWorkerWatcher', () => startEphemeralWorkerWatcher()); // poll HIVE_ROOT/spawn-requests → ephemeral workers
  // Phase 2: the loopback secret broker. Bind it BEFORE workers spawn so each spawn can
  // be granted a capability token + the broker URL in its env. Loopback-only, idempotent.
  // Headless: --team-join pairs this office with yours (an invite made in your
  // desktop's Manager → Team). Team is switched on first if needed.
  // Servers: SB_RELAY_TOKEN="https://relay.example.com=tk_…[,…]" stores each
  // token in the encrypted store (set before joining, which talks to the relay).
  // headless.ts already took it out of the environment agents inherit.
  for (const entry of HEADLESS_SETUP?.relayTokens ?? []) {
    const i = entry.lastIndexOf('=');
    const r = i > 0 ? setRelayToken(entry.slice(0, i), entry.slice(i + 1)) : { ok: false, error: 'expected <relay>=<token>' };
    if (!r.ok) console.error('[headless] relay token not stored:', r.error);
  }
  if (HEADLESS_SETUP?.teamJoin) {
    if (!teamEnabled()) {
      const r = enableTeam(HEADLESS_SETUP.name ?? `${hostname()} (server)`);
      if (!r.ok) console.error('[headless] could not turn Team on:', r.error);
    }
  }
  freezes.time('boot: startTeam', () => startTeam());
  // An invite is single-use and SB_TEAM_JOIN stays in a unit file or compose
  // file across restarts: join each code once, then remember it was used.
  const joinKey = HEADLESS_SETUP?.teamJoin ? `team.joined.${createHash('sha256').update(HEADLESS_SETUP.teamJoin).digest('hex').slice(0, 16)}` : null;
  if (joinKey && teamNode && !persist.getKv(joinKey)) {
    void teamNode.join(HEADLESS_SETUP!.teamJoin!).then((r) => {
      console.log(r.ok ? `[headless] joined the team; ${r.peer?.name} will see this office once both are online` : `[headless] team join failed: ${r.error}`);
      if (r.ok) { try { persist.setKv(joinKey, Date.now()); } catch { /* DB best-effort */ } }
    });
  }
  void mcpGateway.start().then((r) => {
    if (!r.ok) console.error('[mcp-gateway] failed to start (keyed MCP servers disabled):', r.error);
  });
  void integrationBroker.start().then((r) => {
    if (r.ok) console.log('[broker] integration broker listening on', integrationBroker.url());
    else console.error('[broker] failed to start:', r.error);
  });
  freezes.time('boot: ensureDefaultMissions', () => ensureDefaultMissions()); // one-time: seed the built-in hourly ops standup
  freezes.time('boot: syncMissions', () => syncMissions()); // arm recurring auto-dispatch missions now the router is live
  writeMissionsMirror(readConfig().missions ?? []);
  syncContextTriggers(); // …and the context trigger's own compact/clear cadences
  // Pair replies to inbound webhook messages in the ledger. Tied to the FEATURE
  // (any endpoint configured), not to the server: an approved message's card can
  // finish long after the operator switched the public surface back off, and its
  // reply still belongs in the history.
  if ((readConfig().webhookTriggers ?? []).length > 0) startWebhookDoneObserver();
  freezes.time('boot: hookServer.start', () => hookServer.start());
  // Bind the telemetry collector BEFORE the renderer spawns any agent, then point
  // the hive at it so every subsequent spawn is instrumented. Best-effort — a bind
  // failure just leaves telemetry off (transcript reconciler stays). No breaker.start():
  // the breaker is POLICY-only, ticked by the heartbeat beat (#1, ships disabled).
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) {
      hive.setOtelEndpoint(r.endpoint);
      // Demo agents are hookless `custom` CLIs, so the hive never hands them the
      // OTel endpoint; they find it here (PTYs inherit process.env).
      if (DEMO_HOME) Object.assign(process.env, bothEnv('DEMO_OTEL', r.endpoint));
      console.log('[telemetry] collector listening', r.endpoint);
    }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  // The mempalace CLI is looked for without blocking, then the palace and mine loop start (no-op without it).
  void memory.startSoon().catch((e) => console.error('[memory] start failed:', e));
  freezes.time('boot: reflector.start', () => reflector.start()); // bound oversized memory.md files on a timer (no-op until threshold)

  armAlwaysOnBeats();
}

/** Cadence of the worker inbox-wake watchdog (#151). Well under the renderer's
 *  own nudge cooldown so a throttled window is caught within ~15s of a stall. */
const WORKER_WAKE_POLL_MS = 15_000;
/** How often the beat verifies the hook socket is bound AND still ours (#277). */
const HOOK_HEALTH_MS = 15_000;
let workerWakeTimer: ReturnType<typeof setInterval> | null = null;
let hookHealthTimer: ReturnType<typeof setInterval> | null = null;

/** Type the renderer's guarded nudge into one worker's PTY — text first, Enter a
 *  moment later, the text in bracketed paste for CLIs that take it (the same
 *  bytes and timing as the renderer's submitToPty, shared/ptySubmit.ts: an Enter
 *  that reaches the CLI in the same read as raw text lands inside the input box
 *  and never submits). Best-effort + never throws. */
function nudgeWorker(ptyId: string, provider: AgentProvider, ids: string[] = []): void {
  // Same text the renderer queues (#187's inboxNudgeText), so the two wake paths
  // produce byte-identical nudges: the queue's one-pending rule recognises either
  // via isInboxNudge, and a watchdog nudge names its ids so the agent can still
  // tell "I filed this last turn" from "woken for nothing".
  const text = inboxNudgeText(ids);
  const wrote = ptyManager.write(ptyId, pastePayload(text, provider));
  if (!wrote.ok) { console.warn(`[worker-wake] write failed for ${ptyId}: ${wrote.error}`); return; }
  setTimeout(() => {
    try {
      const submitted = ptyManager.write(ptyId, '\r');
      if (!submitted.ok) console.warn(`[worker-wake] submit failed for ${ptyId}: ${submitted.error}`);
    } catch (e) { console.error('[worker-wake] submit threw:', e); }
  }, preEnterDelayMs(text));
}

/** Main-process inbox-wake beat (issue #151, fix A): the renderer's idle nudge
 *  (useHive.ts) is the only path that wakes a worker parked on an undrained
 *  inbox — and it lives on a setInterval in the renderer, which a throttled or
 *  occluded window stops honoring. This beat is the renderer-INDEPENDENT fallback:
 *  it gathers live-worker facts (PTY quiescence, inbox depth, control flags) and
 *  lets WorkerWakeWatchdog.decide apply the exact renderer guards (idle-only,
 *  post-boot-grace, not paused/halted, no pending HITL, cooldown), then types the
 *  same nudge the renderer would have. God is never a candidate (its heartbeat
 *  path already re-engages it). */
function runWorkerWakeBeat(): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  if (!reg?.agents || !reg.godId) return;
  const now = Date.now();
  const facts: WorkerWakeFacts[] = [];
  for (const [agentId, a] of Object.entries(reg.agents)) {
    if (agentId === reg.godId || a?.archived) continue;
    // Being asked for its handoff note (main/workSwitch.ts): the resume sends it
    // to its inbox once its context is cleared.
    if (workSwitch.holdsNudges(agentId)) continue;
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    const snap = control.snapshot(agentId);
    const mail = hive.inbox(agentId);
    // Oldest pending message: the stall rule measures how long the worker has
    // ignored its mail, and telemetry says whether it has done ANY turn since.
    let oldestMailAt = 0;
    for (const m of mail) {
      const t = Date.parse(m.created_at ?? '');
      if (Number.isFinite(t) && (oldestMailAt === 0 || t < oldestMailAt)) oldestMailAt = t;
    }
    // One telemetry read per worker per beat: with no live OTel the collector
    // falls back to the transcript (registry + transcript directory reads).
    const usage = telemetry.getAgentUsage(agentId);
    facts.push({
      agentId,
      isGod: agentId === reg.godId,
      ptyId,
      lastOutputAt: ptyManager.lastOutputAt(ptyId) ?? 0,
      inboxIds: mail.map((message) => message.id).filter(Boolean),
      autoDeliveryPaused: snap.autoDeliveryPaused,
      paused: snap.paused,
      halted: snap.halted,
      // A turn the CLI demonstrably took: a tool span, or a usage sample WITH
      // tokens. The zero-token sample stamped at session start is not one —
      // but it does prove the CLI exports telemetry (Claude Code only), which
      // is what lets the stall rule read "no turn" as evidence. Other engines
      // show their turns through hook events, which the watchdog hears itself.
      lastActivityAt: activityEvidenceAt({ usage, spans: telemetry.getSpans(agentId) }),
      hasTelemetry: usage !== null,
      oldestMailAt
    });
  }
  const nudged = new Set(workerWake.decide(facts, now));
  for (const agentId of nudged) {
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) continue;
    // Re-read at delivery time, not from the facts snapshot: the agent may have
    // drained the mail during the beat, and a nudge naming ids it already filed
    // is the exact staleness #187 exists to stop.
    const ids = hive.inbox(agentId).map((m) => m.id).filter(Boolean);
    if (!ids.length) { console.log(`[worker-wake] ${agentId} drained before delivery, skipping`); continue; }
    console.log(`[worker-wake] nudging ${agentId} on ${ptyId} (${ids.length} pending)`);
    nudgeWorker(ptyId, reg.agents[agentId]?.provider ?? 'claude', ids);
  }
  // A worker sitting on old mail without a nudge is the failure this watchdog
  // exists for — say WHY it is being held, once per cooldown, so the log can
  // never again read "nothing happened" while a worker starves on its inbox.
  for (const f of facts) {
    if (nudged.has(f.agentId) || f.inboxIds.length === 0) continue;
    const mailAge = f.oldestMailAt && f.oldestMailAt > 0 ? now - f.oldestMailAt : 0;
    if (mailAge < WORKER_WAKE_REPORT_MS) continue;
    if (!workerWake.shouldReportHold(f.agentId, now)) continue;
    const hold = workerWake.explain(f, now);
    const quiet = f.lastOutputAt > 0 ? `${Math.round((now - f.lastOutputAt) / 1000)}s` : 'never';
    const activeAt = Math.max(f.lastActivityAt ?? 0, workerWake.turnHookAt(f.agentId));
    const active = activeAt > 0 ? `${Math.round((now - activeAt) / 1000)}s ago` : 'never';
    console.warn(`[worker-wake] holding ${f.agentId}: ${hold} (mail pending ${Math.round(mailAge / 1000)}s, pty quiet ${quiet}, last activity ${active})`);
  }
}

/** (Re)arm the always-on beats (decoupled from the optional heartbeat): the live
 *  fleet snapshot Michael reads (~8s) + the breaker/cost-ledger beat (~30s).
 *  Guarded (clear-then-set) so a re-bootstrap (changeHome recovery) OR a
 *  powerMonitor resume can't stack duplicate timers — these are setInterval
 *  handles that freeze during true system sleep and must be re-armed on wake. */
function armAlwaysOnBeats(): void {
  if (fleetTimer) clearInterval(fleetTimer);
  writeFleetSnapshot();
  fleetTimer = setInterval(writeFleetSnapshot, 8_000);
  if (breakerBeatTimer) clearInterval(breakerBeatTimer);
  breakerBeatTimer = setInterval(() => { runBreakerBeat(300_000).catch((e) => console.error('[breaker beat]', e)); }, 30_000);
  if (workerWakeTimer) clearInterval(workerWakeTimer);
  workerWakeTimer = setInterval(() => { try { runWorkerWakeBeat(); } catch (e) { console.error('[worker-wake beat]', e); } }, WORKER_WAKE_POLL_MS);
  runWorkerWakeBeat(); // catch-up on arm — power-resume re-arms and drains the backlog
  // The hook socket is the whole control plane; a session where it is silently
  // unbound looks exactly like "no workers have spawned yet" (#277). Verify it
  // — bound, and the path still ours — and re-bind when it is not.
  if (hookHealthTimer) clearInterval(hookHealthTimer);
  hookHealthTimer = setInterval(() => { hookServer.ensureListening().catch((e) => console.error('[hooks beat]', e)); }, HOOK_HEALTH_MS);
}

/** Wall-clock instant we last observed the machine suspend or lock, so a resume
 *  can report how long we were out. Best-effort context for the renderer follow-on
 *  (auto-revive); null until the first suspend/lock of the session. */
let lastSuspendAt: number | null = null;
/** Single pending post-resume PTY health check, so overlapping resume+unlock
 *  events collapse to ONE check (the latest) instead of stacking. */
let resumeHealthTimer: NodeJS.Timeout | null = null;

/** After the machine wakes, probe each live PTY for liveness and surface any that
 *  didn't survive. macOS can wedge a child `claude` process/socket across a long
 *  sleep while node-pty still holds the fd (its exit event never fired) — so a
 *  dead PTY can linger in our list. `process.kill(pid, 0)` is a pure existence
 *  probe (signal 0 never touches the process); ESRCH means the process is gone.
 *  We only LOG + NOTIFY here (no auto-kill/respawn — true revive is renderer-owned
 *  via pty:spawn) and emit `power:resume` as the integration point for the
 *  follow-on renderer auto-revive card. */
function healthCheckPtys(reason: string, awayMs: number | null): void {
  const ptys = ptyManager.list();
  const dead: string[] = [];
  for (const p of ptys) {
    if (typeof p.pid === 'number' && p.pid > 0) {
      try { process.kill(p.pid, 0); }   // liveness probe only — never kills
      catch { dead.push(p.id); }        // ESRCH: process gone but PTY still registered
    }
  }
  const away = awayMs != null ? ` (away ~${Math.round(awayMs / 1000)}s)` : '';
  if (dead.length) {
    console.warn(`[power] ${reason}${away}: ${dead.length}/${ptys.length} PTY(s) look wedged (process gone):`, dead.join(', '));
    breakerToast('Agents need a restart', `${dead.length} agent terminal(s) didn't survive sleep — re-open them to resume.`);
  } else {
    console.log(`[power] ${reason}${away}: ${ptys.length} PTY(s) healthy`);
  }
  // Single integration point for the (separate) renderer auto-revive card: it can
  // listen for 'power:resume' and respawn the `dead` PTYs with --resume.
  try { liveWebContents()?.send('power:resume', { reason, awayMs, dead, total: ptys.length }); } catch { /* window gone */ }
}

/** Re-arm everything that runs on a frozen libuv timer after the machine slept,
 *  and surface any PTY that didn't survive. macOS pauses setTimeout/setInterval
 *  during true system sleep (the monotonic clock halts) — on wake they resume
 *  where they paused, shifted by the whole sleep, so missions due during sleep
 *  never fired and never replay. We rebuild the scheduler (syncMissions reuses its
 *  remaining=max(0,…) semantics → each overdue mission fires exactly ONCE then
 *  re-settles, never N replays), re-arm the always-on beats, re-evaluate the
 *  power blocker, then — after a short grace for PTYs to wake their pipes —
 *  health-check the terminals. Idempotent: overlapping resume+unlock events
 *  collapse safely (clear-then-arm everywhere; at most one catch-up fire). */
function onSystemResume(reason: string): void {
  console.log(`[power] ${reason} — re-arming scheduler, beats, router, keep-awake`);
  try { syncMissions(); } catch (e) { console.error('[power] syncMissions on resume', e); }
  // Same freeze, same catch-up: the context timers honour elapsed-time-since-last-
  // run, so a compact/clear that came due while the machine slept fires ONCE here
  // rather than being lost or replayed N times.
  try { syncContextTriggers(); } catch (e) { console.error('[power] syncContextTriggers on resume', e); }
  try { armAlwaysOnBeats(); } catch (e) { console.error('[power] armAlwaysOnBeats on resume', e); }
  // The hive message router (outbox→inbox drain) is a setInterval that freezes
  // during true system sleep exactly like the beats above — but it was the one
  // always-on timer never re-armed on wake. Symptom: after a long sleep the
  // scheduler→god path recovered (it injects straight into god's inbox), while
  // every agent's outbox silently stopped draining, so god→worker and
  // worker↔worker mail piled up undelivered. Re-arm the poll loop (clear-then-set,
  // idempotent) and immediately drain the backlog that accrued while we were out
  // instead of waiting for the first post-wake tick. The renderer's idle inbox-wake
  // nudge (useHive.ts) then wakes each parked recipient once its mail lands.
  try {
    hive.stopRouter();
    hive.startRouter();
    const drained = hive.routeOnce();
    if (drained > 0) console.log(`[power] ${reason} — flushed ${drained} queued hive message(s)`);
  } catch (e) { console.error('[power] router re-arm on resume', e); }
  try { syncKeepAwake(); } catch (e) { console.error('[power] syncKeepAwake on resume', e); }
  const awayMs = lastSuspendAt != null ? Date.now() - lastSuspendAt : null;
  // Give PTYs a beat to resume their pipes before judging them wedged; reset any
  // pending check so a resume quickly followed by unlock runs the probe just once.
  if (resumeHealthTimer) clearTimeout(resumeHealthTimer);
  resumeHealthTimer = setTimeout(() => {
    resumeHealthTimer = null;
    healthCheckPtys(reason, awayMs);
  }, 15_000);
}

app.whenReady().then(() => {
  // Headless first run from the command line: --office sets the office and
  // skips onboarding (an explicit --office always wins over a saved one).
  if (HEADLESS_SETUP?.office) {
    const ensured = ensureHarnessHome(HEADLESS_SETUP.office);
    if (!ensured.ok) console.error('[headless] cannot use --office:', ensured.error);
    else {
      const cfg = readConfig();
      if (!cfg.onboardingComplete || cfg.harnessHome !== HEADLESS_SETUP.office) {
        writeConfig({ onboardingComplete: true, harnessHome: HEADLESS_SETUP.office, notifications: false });
      }
    }
  }
  if (HEADLESS_SETUP?.maxWorkers && HEADLESS_SETUP.maxWorkers !== readConfig().maxConcurrentWorkers) {
    writeConfig({ maxConcurrentWorkers: Math.max(1, Math.min(64, Math.floor(HEADLESS_SETUP.maxWorkers))) });
  }
  if (HEADLESS) {
    console.log(`[headless] office: ${readConfig().harnessHome ?? '(none — pass --office <dir>)'}`);
    // systemd stop / Ctrl+C: the same full teardown as closing the window.
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { console.log(`[headless] ${sig}, shutting down`); teardownAndQuit(); });
  }
  // Realtime Michael mic-gate hygiene (rt-8 / Pam rt-10 nit): the voice session
  // opens the mic permission gate by persisting realtimeVoiceEnabled=true and
  // closes it on disconnect — but a hard crash/reload mid-session skips that
  // teardown, leaving the flag stuck true so the gate would boot PRE-OPEN with no
  // live session. Force it closed at startup (a real session re-opens it via
  // setMicGate(true)); macOS TCC stays a second gate regardless.
  if (readConfig().realtimeVoiceEnabled) writeConfig({ realtimeVoiceEnabled: false });

  // Anonymous product analytics (PostHog) — the full contract lives in
  // TELEMETRY.md. No-op unless a build-time key was injected (official releases
  // only), and gated on DO_NOT_TRACK + the telemetryEnabled config (opt-out).
  analytics.init({
    stateDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    enabled: readConfig().telemetryEnabled !== false
  });

  // Warm the model catalog cache before any picker opens. The renderer reads
  // the same cache over IPC on load; doing the network hop here means the file
  // is already fresh on disk by the time a modal is opened, and a failure is
  // silent by construction (the baked catalog is the floor).
  void loadModelCatalog(MODEL_CATALOG_CACHE()).catch(() => { /* never fatal */ });

  // A cold-start deep link (Windows/Linux) rides in on OUR argv.
  const startupHireLink = process.argv.find((a) => a.startsWith('munderdifflin://'));
  if (startupHireLink) void handleHireLink(startupHireLink);

  // Hand every spawned agent the path to the Slack reply discovery file via the
  // inherited env (pty merges process.env). The path is stable whether or not the
  // server is running; the FILE only exists while it is, so the helper degrades
  // to "endpoint not running" cleanly. NO secret is in the env — only the path.
  process.env.MD_SLACK_REPLY_CONFIG = slackReplyConfigPath();
  // Open the durable store first — createWindow() reads the saved window bounds.
  // Guarded: a DB failure (e.g. a bad native build) must degrade to defaults,
  // never block app startup.
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // Auto-update from GitHub releases (packaged builds only; gated on the
  // `autoUpdate` config flag). Download-in-background + restart-to-apply toast;
  // never restarts on its own. Falls back to a notify-only releases/latest
  // check where native updating isn't possible (win-portable, dev-ish builds).
  // The server is updated by its package (npm, docker pull), never in place.
  if (!SERVER) repairAppImageLaunchers();
  if (!SERVER) initAutoUpdater(() => liveWebContents());
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  // Each slow boot step is named in the freeze log (freezeLog.ts).
  freezes.time('boot: bootstrapHiveServices', () => bootstrapHiveServices());
  // Survive sleep/lock. macOS freezes libuv timers during true system sleep, so a
  // locked/idle/slept Mac stops firing schedules and can wedge PTYs. On wake we
  // re-arm the scheduler (catching up missed missions ONCE) + beats + keep-awake,
  // then health-check terminals. App-lifetime listeners — powerMonitor outlives
  // every window, so there is nothing to tear down on quit.
  powerMonitor.on('resume', () => onSystemResume('resume'));
  powerMonitor.on('unlock-screen', () => onSystemResume('unlock-screen'));
  powerMonitor.on('suspend', () => { lastSuspendAt = Date.now(); console.log('[power] suspend — system sleeping'); });
  powerMonitor.on('lock-screen', () => { lastSuspendAt = Date.now(); console.log('[power] lock-screen'); });
  // Multi-window floors (opt-in): install the menu carrying "New Floor". When
  // off, the app keeps Electron's default menu — zero behavior change.
  if (readConfig().multiWindow) installAppMenu();
  const firstWin = createWindow();
  // The fork used to install as Munder Difflin: offer to remove that old copy.
  if (!HEADLESS) firstWin.once('ready-to-show', () => {
    setTimeout(() => void offerLegacyUninstall(firstWin, {
      ask: (k) => { try { return persist.getKv(k); } catch { return undefined; } },
      remember: (k, v) => { try { persist.setKv(k, v); } catch { /* DB best-effort */ } }
    }), 4000);
  });
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  // Auto-start the generic webhook only for endpoints the user has explicitly
  // enabled (each with its own secret) — never a default-on public surface.
  // Opt-in, like Slack; an install with no enabled endpoint opens no tunnel.
  if (enabledWebhookEndpoints().length > 0) {
    void startWebhookServer().then((r) => {
      if (!r.ok) console.error('[webhook] auto-start failed:', r.error);
      else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  }
});

// Every window loads the config once at start-up, so tell them all when a
// setting is saved — a floor left out would keep showing what it opened with.
onConfigWritten((config) => {
  writeMissionsMirror(config.missions ?? []);
  hive.refreshGuards(config);
  skillMirrorAt = 0; // what the orchestrator may add can have changed
  for (const w of allWindows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    w.webContents.send('config:changed', config);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Full teardown, not a bare killAll: this path must also stop the proxy
    // sidecars and helper servers — on Windows a child is NOT killed when its
    // parent exits, so anything skipped here outlives the app.
    teardownAndQuit();
  }
});

// Final analytics flush (session_ended + drain the send queue), bounded so a
// hung network can never wedge quit: preventDefault ONCE, race the flush
// against a short timeout, then exit hard.
//
// finish MUST be app.exit(), not a re-entrant app.quit(): when the quit was
// initiated while a window was still open (the "kill all & quit" confirm path
// calls teardownAndQuit → app.quit() and the window closes DURING that quit),
// Electron is left with its internal is-quitting state set after this
// preventDefault, and the later app.quit() is silently a no-op — no before-quit,
// no will-quit, no quit; the main process idles forever with zero windows. On
// Windows that stranded the whole Electron process group (main + GPU + network
// service) after every agents-running quit. By this point teardown has already
// run and the flush has finished or timed out, so an unconditional exit is
// exactly what's left to do.
let analyticsFlushed = false;
app.on('will-quit', (e) => {
  fortress.stop();
  releaseClaimedOffice();
  // What is still queued reaches the hive history before the process goes.
  try { hive.flushCommitsSync(); } catch { /* best-effort */ }
  if (analyticsFlushed) return;
  analyticsFlushed = true;
  e.preventDefault();
  const finish = (): void => app.exit(0);
  Promise.race([
    analytics.endSession(),
    new Promise<void>((r) => setTimeout(r, 1200))
  ]).then(finish, finish);
});
