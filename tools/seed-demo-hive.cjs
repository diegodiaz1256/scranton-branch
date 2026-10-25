#!/usr/bin/env node
'use strict';
/**
 * Seed a self-contained demo office for `npm run demo` (see tools/demo.cjs).
 *
 * Everything lands under one folder (default `<repo>/.demo`, gitignored):
 *
 *   .demo/userData/       Electron userData for the demo run — config.json,
 *                         trigger-history.json, localStorage. The app points
 *                         userData here when SB_DEMO_HOME is set (src/main/demo.ts).
 *   .demo/Dunder Mifflin/ harnessHome: roster.json + hive/ (registry, tasks,
 *                         mailboxes, memory, spawn-requests). The space is on
 *                         purpose: the demo doubles as a paths-with-spaces check.
 *   .demo/project/        a small git repo the agents "work" in, and the repo a
 *                         demo temp gets its worktree from.
 *
 * Every agent runs tools/demo-agent.cjs instead of a real CLI, so nothing here
 * spends tokens. Re-running replaces the folder from scratch (`--reset` is the
 * same thing, spelled out); `seedDemo` is exported for the test.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DEMO_HOME = path.join(REPO_ROOT, '.demo');

/** The demo cast. `god` is the orchestrator's fixed hive id. */
const CAST = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'lemon', role: 'orchestrator (god)', isGod: true },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint', role: 'Backend engineer: API, database, auth' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky', role: 'Frontend engineer: React UI and accessibility' },
  { id: 'pam', name: 'Pam', character: 'pam', accent: 'lilac', role: 'Designer: tokens, icons, marketing pages' },
  { id: 'angela', name: 'Angela', character: 'angela', accent: 'coral', role: 'QA: test plans, regression suite, release checks' },
  { id: 'oscar', name: 'Oscar', character: 'oscar', accent: 'peach', role: 'Analyst: pricing, usage data, weekly reports' }
];
/** Closed before the demo started — shows up as archived, not on the floor. */
const ARCHIVED = { id: 'toby', name: 'Toby', character: 'toby', accent: 'sky', role: 'Compliance review (finished)' };

const iso = (ms) => new Date(ms).toISOString();

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

/** The command line every demo agent runs. Forward slashes + quotes keep it one
 *  token through tokenizeCommand on every OS, spaces in the path included. */
function demoAgentCommand(repoRoot) {
  const script = path.join(repoRoot, 'tools', 'demo-agent.cjs').split(path.sep).join('/');
  return `node "${script}"`;
}

function buildTasks(now) {
  const h = 3_600_000;
  return [
    { id: 't-auth', title: 'Add password reset flow to the API', assignee: 'dwight', status: 'done', dependsOn: [], priority: 1,
      createdAt: iso(now - 30 * h), description: 'POST /auth/reset + signed email token, 30 min expiry.',
      result: 'Shipped behind `RESET_FLOW=1`. 14 new tests, all green.' },
    { id: 't-schema', title: 'Migrate invoices table to cents', assignee: 'dwight', status: 'doing', dependsOn: ['t-auth'], priority: 1,
      createdAt: iso(now - 20 * h), description: 'Store amounts as integer cents; backfill existing rows.' },
    { id: 't-ui', title: 'Invoice list: sortable columns + empty state', assignee: 'jim', status: 'doing', dependsOn: [], priority: 2,
      createdAt: iso(now - 18 * h), description: 'Sort by date, client, amount. Keyboard accessible.' },
    { id: 't-icons', title: 'Redraw sidebar icons as 1.5px strokes', assignee: 'pam', status: 'todo', dependsOn: [], priority: 3,
      createdAt: iso(now - 10 * h), description: 'Inbox, Automations, Memory, Capabilities, Temps.' },
    { id: 't-pricing', title: 'Pick the price for the Team plan', assignee: 'oscar', status: 'blocked', dependsOn: [], priority: 1,
      createdAt: iso(now - 8 * h), description: 'Usage analysis done; needs a decision.',
      humanQA: [{
        q: '**Which price should the Team plan launch at?**\n\nUsage says teams of 3–8 run ~40 agent-hours a week.\n\n- `$29` per seat: matches competitors, lower margin\n- `$39` per seat: covers the heavy users\n- `$49` flat for up to 5 seats',
        askedAt: iso(now - 2 * h)
      }] },
    { id: 't-regress', title: 'Regression pass on the billing flow', assignee: 'angela', status: 'todo', dependsOn: ['t-schema', 't-ui'], priority: 2,
      createdAt: iso(now - 6 * h), description: 'Blocked by the cents migration and the new list.' },
    { id: 't-report', title: 'Weekly usage report', assignee: 'oscar', status: 'done', dependsOn: [], priority: 3,
      createdAt: iso(now - 50 * h), result: 'Posted to #metrics. Agent-hours up 18% week over week.' },
    { id: 't-plan', title: 'Plan the v2 billing milestone', assignee: 'god', status: 'doing', dependsOn: [], priority: 1,
      createdAt: iso(now - 4 * h), description: 'Split into tickets, assign, track.' }
  ];
}

let msgSeq = 0;
function message(now, minsAgo, from, to, act, subject, body, extra = {}) {
  msgSeq += 1;
  const created = now - minsAgo * 60_000;
  return {
    id: `demo-${String(msgSeq).padStart(3, '0')}`,
    conversation: extra.conversation ?? `conv-${from}-${to}`,
    in_reply_to: extra.in_reply_to ?? null,
    from, to, act, subject, body,
    hops: 0,
    requires_reply: !!extra.requires_reply,
    needs_human: !!extra.needs_human,
    created_at: iso(created)
  };
}

/** Each delivered message lives in the sender's outbox/.sent AND the recipient's
 *  inbox (unread) or inbox/.done (handled), exactly as the router leaves them. */
function buildMail(now) {
  msgSeq = 0;
  return [
    { msg: message(now, 240, 'god', 'dwight', 'request', 'Cents migration', 'Move `invoices.amount` to integer cents and backfill. Ping Angela when it is on staging.'), read: true },
    { msg: message(now, 200, 'god', 'jim', 'request', 'Invoice list polish', 'Sortable columns and a proper empty state. Keep it keyboard friendly.'), read: true },
    { msg: message(now, 120, 'dwight', 'god', 'inform', 'Password reset shipped', 'Behind `RESET_FLOW=1`. 14 tests added, all passing.'), read: true },
    { msg: message(now, 95, 'oscar', 'god', 'propose', 'Team plan pricing options', 'Three options in the card on the board. I lean towards $39/seat.', { requires_reply: true }), read: true },
    { msg: message(now, 60, 'webhook', 'god', 'inform', 'Deploy alert: staging', '**staging** deploy `a41c9e2` finished in 3m12s. 0 failing checks.'), read: false },
    { msg: message(now, 42, 'jim', 'dwight', 'query', 'Amount field shape', 'Will the API return cents as a number or a string? Need it for the formatter.', { requires_reply: true }), read: false },
    { msg: message(now, 30, 'god', 'human', 'inform', 'Morning summary', '- Dwight: cents migration 60% done\n- Jim: list UI in review\n- Oscar is waiting on **you** for the Team plan price'), read: true },
    { msg: message(now, 12, 'angela', 'god', 'query', 'Regression scope', 'Do you want the full billing suite or only invoices this round?', { requires_reply: true }), read: false }
  ];
}

function memoryFor(member, now) {
  const day = iso(now).slice(0, 10);
  const lines = {
    god: ['Team plan pricing is the open decision; Oscar owns the analysis.', 'v2 billing milestone: cents migration -> list UI -> regression pass.', 'Dwight prefers small PRs; Angela gates every billing release.'],
    dwight: ['Invoices use integer cents from migration 0042 onwards.', 'Password reset tokens expire after 30 minutes (signed, single use).', 'Run `npm test -- billing` before pushing anything in api/billing.'],
    jim: ['Invoice list uses the shared <DataTable>; sorting is client side under 500 rows.', 'Empty states follow the illustration set in docs/design.'],
    pam: ['Sidebar icons: 1.5px stroke, round caps, 16px box.', 'Brand maroon #6E1423 only for chrome, never for body text.'],
    angela: ['Billing regression suite lives in e2e/billing; takes ~6 minutes.', 'Never sign off a release with a skipped billing test.'],
    oscar: ['Teams of 3-8 average ~40 agent-hours a week.', 'Weekly usage report goes out Mondays at 09:00.']
  }[member.id] ?? [];
  return `# ${member.name} — memory\n\n## Facts\n${lines.map((l) => `- ${l}`).join('\n')}\n\n## Log\n- ${day}: joined the demo office.\n`;
}

function rosterAgent(member, cwd, command) {
  return {
    id: member.id,
    name: member.name,
    character: member.character,
    accent: member.accent,
    description: member.role,
    project: 'demo',
    tmuxTarget: '',
    cwd,
    status: 'idle',
    action: '',
    progress: 0,
    ptyId: `pty-${member.id}`,
    command,
    provider: 'custom'
  };
}

function initProjectRepo(dir) {
  writeText(path.join(dir, 'README.md'), '# Demo billing app\n\nA stand-in project for the Scranton Branch demo office.\n');
  writeText(path.join(dir, 'src', 'invoices.js'), 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.amountCents, 0);\n}\n');
  const git = (...args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' }).status === 0;
  return git('init', '-q', '-b', 'main')
    && git('add', '-A')
    // A throwaway fixture: no identity or signing setup of the user's (a GPG or
    // 1Password signer that wants a prompt) may decide whether the demo seeds.
    && git('-c', 'user.name=Demo', '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'Initial demo project');
}

/**
 * Write the demo office. Wipes `home` first, so it is always a clean seed.
 * @returns the paths the launcher needs.
 */
function seedDemo({ home = DEFAULT_DEMO_HOME, repoRoot = REPO_ROOT, now = Date.now(), git = true } = {}) {
  home = path.resolve(home);
  // Never wipe something that is not obviously a demo folder.
  if (fs.existsSync(home) && !fs.existsSync(path.join(home, '.md-demo')) && fs.readdirSync(home).length > 0) {
    throw new Error(`refusing to replace ${home}: it exists and is not a demo folder`);
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  writeText(path.join(home, '.md-demo'), 'Seeded by tools/seed-demo-hive.cjs. Safe to delete.\n');

  const userData = path.join(home, 'userData');
  const office = path.join(home, 'Dunder Mifflin');
  const hive = path.join(office, 'hive');
  const project = path.join(home, 'project');
  const command = demoAgentCommand(repoRoot);

  const hasRepo = git ? initProjectRepo(project) : (fs.mkdirSync(project, { recursive: true }), false);

  // ── config ────────────────────────────────────────────────────────────────
  const h = 3_600_000;
  writeJson(path.join(userData, 'config.json'), {
    onboardingComplete: true,
    demoMode: true,
    audience: 'technical',
    harnessHome: office,
    recentHives: [office],
    registeredRepos: [project],
    autoMode: true,
    orchestratorMaySpawn: hasRepo,
    defaultCommand: command,
    godProvider: 'custom',
    notifications: false,
    terminalTheme: 'light',
    maxConcurrentWorkers: 4,
    defaultWorkerTokenCap: 2_000_000,
    missions: [
      { id: 'ops-standup', label: 'Hourly ops standup', intervalMs: h, to: 'god', enabled: true,
        body: 'Hourly ops standup. Review every agent and keep the board accurate.', lastFiredAt: now - 20 * 60_000 },
      { id: 'demo-weekly-report', label: 'Weekly usage report', intervalMs: 7 * 24 * h, weekly: { days: [1], minute: 9 * 60 },
        to: 'oscar', enabled: true, body: 'Compile the weekly usage report and post the summary.' },
      { id: 'demo-nightly-regression', label: 'Nightly regression run', intervalMs: 24 * h, to: 'angela', enabled: false,
        body: 'Run the billing regression suite and report failures to Michael.' },
      { id: 'heartbeat', label: 'Floor heartbeat', intervalMs: 120_000, to: 'god', enabled: false, kind: 'heartbeat',
        quietThresholdMs: 300_000, body: 'Floor heartbeat: the team has gone quiet.' }
    ],
    compactMaintenanceSeeded: true,
    triggersMigratedV1: true,
    contextTrigger: {
      compact: { enabled: true, everyMs: 2 * h, minContextPct: 60, minContextPctLargeWindow: 40,
        message: 'Keep the current task, recent decisions, open questions, and file paths in play.' },
      clear: { enabled: true, everyMs: 4 * h, minContextPct: 90, minContextPctLargeWindow: 80,
        message: 'Write your next step to memory.md before the clear.' }
    },
    webhookTriggers: [
      { id: 'demo-deploys', name: 'Deploy alerts', secret: 'demo-not-a-real-secret', enabled: false,
        mode: 'communication-only', schema: '{"type":"object","required":["message"]}', createdAt: now - 72 * h }
    ],
    circuitBreaker: { enabled: true, hardStop: false },
    costCapUsd: 25
  });

  writeJson(path.join(userData, 'trigger-history.json'), [
    { id: 'demo-th-2', source: 'webhook', sourceId: 'demo-deploys', sourceName: 'Deploy alerts', direction: 'inbound',
      peer: 'ci.example.invalid', title: 'Roll back production?', body: 'Error rate on prod is 2.4% after deploy `a41c9e2`. Roll back?',
      kind: 'directive', decision: 'pending', at: now - 15 * 60_000 },
    { id: 'demo-th-1', source: 'webhook', sourceId: 'demo-deploys', sourceName: 'Deploy alerts', direction: 'inbound',
      peer: 'ci.example.invalid', title: 'Deploy alert: staging', body: 'staging deploy `a41c9e2` finished in 3m12s.',
      kind: 'communication', decision: 'auto-allowed', at: now - 60 * 60_000 }
  ]);

  // ── hive ──────────────────────────────────────────────────────────────────
  const registry = { godId: 'god', agents: {} };
  for (const m of [...CAST, ARCHIVED]) {
    registry.agents[m.id] = {
      id: m.id,
      name: m.name,
      provider: 'custom',
      role: m.role,
      cwd: m.isGod ? office : project,
      isGod: !!m.isGod,
      status: 'idle',
      lastSeen: now - (m === ARCHIVED ? 26 * h : 60_000),
      cwdValid: true,
      ...(m === ARCHIVED ? { archived: true } : {})
    };
  }
  writeJson(path.join(hive, 'registry.json'), registry);
  writeJson(path.join(hive, 'tasks.json'), { tasks: buildTasks(now) });
  writeText(path.join(hive, 'board.md'), '# Board\n\n## Now\n- v2 billing: cents migration (Dwight), list UI (Jim)\n\n## Waiting on the human\n- Team plan price (Oscar)\n');

  for (const m of [...CAST, ARCHIVED]) {
    const dir = path.join(hive, 'agents', m.id);
    for (const sub of ['inbox/.done', 'outbox/.sent']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    writeText(path.join(dir, 'memory.md'), memoryFor(m, now));
  }
  // The activity log is what the Memory graph draws its edges from: one
  // `message` line per delivery, the same shape the router appends.
  const log = [];
  for (const { msg, read } of buildMail(now)) {
    log.push({ ts: Date.parse(msg.created_at), kind: 'message', from: msg.from, to: msg.to, act: msg.act,
      subject: msg.subject, id: msg.id, delivered: [msg.to] });
    const file = `${msg.created_at.replace(/[:.]/g, '-')}-${msg.id}.json`;
    if (msg.from !== 'webhook' && registry.agents[msg.from]) {
      writeJson(path.join(hive, 'agents', msg.from, 'outbox', '.sent', file), msg);
    }
    if (registry.agents[msg.to]) {
      writeJson(path.join(hive, 'agents', msg.to, 'inbox', read ? '.done' : '', file), msg);
    }
  }
  writeText(path.join(hive, 'log.jsonl'), log.map((l) => JSON.stringify(l)).join('\n') + '\n');

  // A temp the orchestrator "hired": the main process picks this up on its
  // spawn-request sweep (orchestratorMaySpawn is on) and starts a demo agent in
  // a fresh worktree of the project. Needs git for the worktree.
  if (hasRepo) {
    writeJson(path.join(hive, 'spawn-requests', 'demo-temp.json'), {
      id: 'demo-temp',
      objective: 'Check every link in the project README and fix the broken ones.',
      cwd: project,
      name: 'Ryan',
      character: 'ryan',
      tokenCap: 2_000_000
    });
  }

  // ── roster ────────────────────────────────────────────────────────────────
  // Workers go in `restorable`: the app auto-restores that list on boot, which
  // spawns each one through the normal path. Michael is spawned by useHive.
  writeJson(path.join(office, 'roster.json'), {
    version: 1,
    savedAt: iso(now),
    agents: [],
    archived: [{ ...rosterAgent(ARCHIVED, project, command), archived: true, ptyId: undefined }],
    restorable: CAST.filter((m) => !m.isGod).map((m) => rosterAgent(m, project, command)),
    queues: {},
    selectedId: 'god'
  });

  return { home, userData, office, hive, project, hasRepo };
}

module.exports = { seedDemo, CAST, DEFAULT_DEMO_HOME, demoAgentCommand };

if (require.main === module) {
  const homeArg = process.argv.find((a) => a.startsWith('--home='));
  const out = seedDemo({ home: homeArg ? homeArg.slice('--home='.length) : DEFAULT_DEMO_HOME });
  console.log(`[demo] seeded ${out.home}${out.hasRepo ? '' : ' (git not found: no temp, no worktrees)'}`);
}
