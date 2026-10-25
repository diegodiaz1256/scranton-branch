#!/usr/bin/env node
'use strict';
/**
 * A pretend coding agent for the demo office (`npm run demo`). Spends no tokens.
 *
 * It loops through believable turns — think, run a few tools, summarise, go
 * idle — printing coding-agent-style output to its terminal, and reports each
 * step to the harness the way a real agent's hooks would:
 *
 *   - hook events (UserPromptSubmit / PreToolUse / PostToolUse / Stop / Status)
 *     to the hive's hook socket, so floor states and context gauges move;
 *   - OTLP/JSON token + cost metrics and tool spans to the embedded collector
 *     (SB_DEMO_OTEL, exported by main in demo mode), so spend and tokens show.
 *
 * Identity comes from the hive env (AGENT_ID / AGENT_NAME / HIVE_ROOT), or argv[2]
 * when run by hand. Typing a line into its terminal starts a turn about it.
 */
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const AGENT_ID = process.env.AGENT_ID || process.argv[2] || 'demo';
const AGENT_NAME = process.env.AGENT_NAME || AGENT_ID;
const HIVE_ROOT = process.env.HIVE_ROOT || '';
const OTEL = process.env.SB_DEMO_OTEL || process.env.MD_DEMO_OTEL || '';
const SESSION_ID = `demo-${AGENT_ID}-${crypto.randomBytes(4).toString('hex')}`;
const MODEL = AGENT_ID === 'god' ? 'claude-opus-4-8' : 'claude-sonnet-4-6';
const CONTEXT_LIMIT = 200_000;

/** Same derivation as HiveManager.sockPath() in src/main/hive.ts. */
function hookSocket() {
  if (process.env.HIVE_SOCK) return process.env.HIVE_SOCK;
  if (!HIVE_ROOT) return null;
  if (process.platform === 'win32') {
    const id = crypto.createHash('sha1').update(HIVE_ROOT).digest('hex').slice(0, 12);
    return `\\\\.\\pipe\\munder-difflin-${id}`;
  }
  return path.join(HIVE_ROOT, 'hooks.sock');
}
const SOCK = hookSocket();

// ── terminal output ─────────────────────────────────────────────────────────
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`
};
const out = (s = '') => process.stdout.write(s + '\r\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = (a, b) => a + Math.floor(Math.random() * (b - a));
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

// ── harness reporting (all best-effort, never throws) ───────────────────────
function hook(event, extra = {}) {
  if (!SOCK) return;
  const payload = { hook_event_name: event, agent_id: AGENT_ID, session_id: SESSION_ID, cwd: process.cwd(), ...extra };
  try {
    // A WSL floor hands agents the bridge's TCP port (tcp://127.0.0.1:<port>).
    const target = SOCK.startsWith('tcp://') ? { host: '127.0.0.1', port: Number(SOCK.slice(SOCK.lastIndexOf(':') + 1)) } : SOCK;
    const conn = net.createConnection(target, () => conn.end(JSON.stringify(payload) + '\n'));
    conn.on('data', () => {});
    conn.on('error', () => {});
    conn.setTimeout(3000, () => conn.destroy());
  } catch { /* harness not listening */ }
}

function otlp(route, body) {
  if (!OTEL) return;
  try {
    const url = new URL(route, OTEL.endsWith('/') ? OTEL : OTEL + '/');
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } });
    req.on('error', () => {});
    req.setTimeout(3000, () => req.destroy());
    req.end(data);
  } catch { /* collector not up */ }
}

const attr = (key, v) => ({ key, value: typeof v === 'number' ? { doubleValue: v } : { stringValue: String(v) } });
const resource = { attributes: [attr('agent.id', AGENT_ID), attr('agent.name', AGENT_NAME)] };

let contextTokens = between(18_000, 40_000);
/** Report one model response: token deltas, its cost, and the new context size. */
function usage(input, output, cacheRead) {
  const usd = (input * 3 + output * 15 + cacheRead * 0.3) / 1_000_000 * (MODEL.includes('opus') ? 5 : 1);
  const point = (value, type) => ({ asDouble: value, attributes: [attr('session.id', SESSION_ID), attr('model', MODEL), ...(type ? [attr('type', type)] : [])] });
  otlp('v1/metrics', {
    resourceMetrics: [{ resource, scopeMetrics: [{ metrics: [
      { name: 'claude_code.token.usage', sum: { dataPoints: [point(input, 'input'), point(output, 'output'), point(cacheRead, 'cacheRead')] } },
      { name: 'claude_code.cost.usage', sum: { dataPoints: [point(usd)] } }
    ] }] }]
  });
  contextTokens = Math.min(CONTEXT_LIMIT - 5_000, contextTokens + input / 4 + output);
  hook('Status', { context_window: { total_input_tokens: Math.round(contextTokens), context_window_size: CONTEXT_LIMIT } });
}

function toolSpan(tool, success, durationMs) {
  otlp('v1/logs', {
    resourceLogs: [{ resource, scopeLogs: [{ logRecords: [{ attributes: [
      attr('event.name', 'tool_result'), attr('agent.id', AGENT_ID), attr('session.id', SESSION_ID),
      attr('tool_name', tool), attr('success', success ? 'true' : 'false'), attr('duration_ms', durationMs)
    ] }] }] }]
  });
}

// ── personas ────────────────────────────────────────────────────────────────
// Each turn: a goal line, then tool steps [tool, input, output lines, ok?], then a summary.
const T = (goal, steps, summary) => ({ goal, steps, summary });
const PERSONAS = {
  god: [
    T('Morning standup: check the floor and the board', [
      ['Read', 'hive/fleet.json', ['6 agents live · 0 breaker trips · $3.10 spent today']],
      ['Read', 'hive/tasks.json', ['8 cards · 3 doing · 1 blocked on the human']],
      ['Write', 'hive/agents/angela/outbox/req-regression.json', ['queued: regression scope for Angela']]
    ], 'Floor is healthy. Oscar is waiting on the Team plan price; I asked the human on the board.'),
    T('Triage the staging deploy alert from the webhook', [
      ['Read', 'hive/agents/god/inbox/deploy-alert.json', ['staging a41c9e2 · 0 failing checks']],
      ['Edit', 'hive/board.md', ['+ staging green, Angela can start the regression pass']]
    ], 'Staging is green. Unblocked the regression card once the cents migration lands.'),
    T('Rebalance work for the v2 billing milestone', [
      ['Read', 'hive/registry.json', ['dwight: doing · jim: doing · pam: idle']],
      ['Edit', 'hive/tasks.json', ['t-icons → pam (priority 3)', 't-regress depends on t-schema, t-ui']]
    ], 'Pam picks up the icon redraw while engineering finishes the migration.')
  ],
  dwight: [
    T('Write the invoices cents migration', [
      ['Bash', 'npx knex migrate:make invoices_to_cents', ['Created migration: migrations/0042_invoices_to_cents.js']],
      ['Edit', 'migrations/0042_invoices_to_cents.js', ['+ ALTER TABLE invoices ADD COLUMN amount_cents BIGINT', '+ UPDATE invoices SET amount_cents = ROUND(amount * 100)']],
      ['Bash', 'npm test -- billing', ['PASS  test/billing/invoices.test.js (14 tests)', 'PASS  test/billing/totals.test.js (9 tests)', 'Tests: 23 passed, 23 total']]
    ], 'Migration written and tested. Backfill runs in batches of 5k rows.'),
    T('Answer Jim about the amount field', [
      ['Grep', 'amountCents api/routes', ['api/routes/invoices.js:41:  amountCents: row.amount_cents,']],
      ['Write', 'outbox/reply-jim.json', ['→ jim: cents come back as an integer number']]
    ], 'Told Jim the API returns integer cents.'),
    T('Harden the password reset endpoint', [
      ['Read', 'api/auth/reset.js', ['118 lines']],
      ['Bash', 'npm test -- auth', ['FAIL  test/auth/reset.test.js', '  ✕ rejects a reused token (12 ms)', 'Tests: 1 failed, 13 passed'], false],
      ['Edit', 'api/auth/reset.js', ['+ if (token.usedAt) throw new HttpError(410, "token already used")']],
      ['Bash', 'npm test -- auth', ['PASS  test/auth/reset.test.js (14 tests)']]
    ], 'Reused reset tokens now return 410. All auth tests green.')
  ],
  jim: [
    T('Sortable columns on the invoice list', [
      ['Read', 'web/src/invoices/InvoiceList.tsx', ['212 lines']],
      ['Edit', 'web/src/invoices/InvoiceList.tsx', ['+ const [sort, setSort] = useState<SortKey>("date")', '+ <th aria-sort={ariaSort("amount")}>']],
      ['Bash', 'npm run test -- InvoiceList', ['PASS  InvoiceList.test.tsx', '  ✓ sorts by amount (31 ms)', '  ✓ keyboard toggles sort (18 ms)']]
    ], 'Columns sort by date, client and amount, with aria-sort for screen readers.'),
    T('Empty state for the invoice list', [
      ['Write', 'web/src/invoices/EmptyInvoices.tsx', ['+ export function EmptyInvoices() { … }']],
      ['Bash', 'npm run lint', ['✔ No problems found']]
    ], 'Added the empty state with the illustration Pam drew.')
  ],
  pam: [
    T('Redraw the sidebar icons as strokes', [
      ['Read', 'docs/design/icons.md', ['16px box · 1.5px stroke · round caps']],
      ['Write', 'web/src/icons/inbox.svg', ['+ <path d="M2 9h3l1.5 2h3L11 9h3" stroke-width="1.5"/>']],
      ['Write', 'web/src/icons/automations.svg', ['+ <circle cx="8" cy="8" r="5.5" stroke-width="1.5"/>']]
    ], 'Inbox and Automations redrawn; three icons to go.'),
    T('Check the brand colours on the pricing page', [
      ['Grep', '#6E1423 web/src', ['web/src/pricing/Hero.tsx:12  color: #6E1423  ← body text']],
      ['Edit', 'web/src/pricing/Hero.tsx', ['- color: #6E1423', '+ color: var(--ink-900)']]
    ], 'Maroon is back to chrome only.')
  ],
  angela: [
    T('Draft the billing regression plan', [
      ['Read', 'e2e/billing/README.md', ['42 scenarios · ~6 min']],
      ['Write', 'e2e/billing/PLAN-v2.md', ['+ 1. invoices in cents render as currency', '+ 2. sorting survives pagination']]
    ], 'Plan ready; waiting for the migration on staging before I run it.'),
    T('Run the smoke suite on staging', [
      ['Bash', 'npx playwright test e2e/smoke', ['Running 12 tests using 4 workers', '  ✓ login (1.2s)', '  ✘ invoice totals (2.9s)', '  1 failed, 11 passed'], false],
      ['Write', 'outbox/bug-totals.json', ['→ god: invoice totals off by 100x on staging (cents not migrated yet)']]
    ], 'Totals are off on staging until the cents migration lands. Reported to Michael.')
  ],
  oscar: [
    T('Model the Team plan price options', [
      ['Bash', 'python analysis/usage_by_team.py --weeks 8', ['teams 3-8 seats: median 40.2 agent-hours/week', 'p90: 71.5 agent-hours/week']],
      ['Write', 'analysis/team-plan.md', ['+ $29/seat: 61% margin', '+ $39/seat: 72% margin', '+ $49 flat (5 seats): 68% margin']]
    ], 'Three options with margins are on the card. Waiting for the human to pick.'),
    T('Refresh the weekly usage numbers', [
      ['Bash', 'python analysis/weekly.py', ['agent-hours: 1,284 (+18% w/w)', 'spend: $412.60']]
    ], 'Weekly numbers refreshed for Monday’s report.')
  ]
};
const GENERIC = [
  T('Work through the objective', [
    ['Read', 'README.md', ['41 lines']],
    ['Bash', 'npx markdown-link-check README.md', ['✓ https://example.com/docs', '✖ https://example.com/old-guide → 404'], false],
    ['Edit', 'README.md', ['- https://example.com/old-guide', '+ https://example.com/guide']],
    ['Bash', 'npx markdown-link-check README.md', ['12 links checked, 0 dead']]
  ], 'All README links resolve now.')
];
const turns = PERSONAS[AGENT_ID] ?? GENERIC;

// ── the loop ────────────────────────────────────────────────────────────────
let busy = false;
let queued = null;
let turnIndex = between(0, turns.length);

async function think(ms) {
  const frames = ['·  ', '·· ', '···', ' ··', '  ·', '   '];
  const label = pick(['Thinking', 'Pondering', 'Planning', 'Reading the code']);
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) {
    process.stdout.write(`\r${c.magenta('✻')} ${label}${frames[i++ % frames.length]} ${c.dim('(esc to interrupt)')}`);
    await sleep(180);
  }
  process.stdout.write('\r\x1b[2K');
}

async function runTurn(goal, steps, summary) {
  busy = true;
  hook('UserPromptSubmit', { prompt: goal });
  out();
  out(`${c.bold('>')} ${goal}`);
  await think(between(1500, 4000));
  for (const [tool, input, lines, ok = true] of steps) {
    hook('PreToolUse', { tool_name: tool, tool_input: { target: input, n: Math.random() } });
    out(`${c.green('⏺')} ${c.bold(tool)}(${input})`);
    const started = Date.now();
    for (const line of lines) {
      await sleep(between(250, 900));
      const coloured = /FAIL|✕|✘|failed|404/.test(line) ? c.red(line) : /PASS|✓|✔|passed|0 dead/.test(line) ? c.green(line) : c.dim(line);
      out(`  ${c.dim('⎿')}  ${coloured}`);
    }
    hook('PostToolUse', { tool_name: tool, tool_input: { target: input, n: Math.random() } });
    toolSpan(tool, ok, Date.now() - started);
    usage(between(800, 3_000), between(150, 700), between(2_000, 8_000));
    await sleep(between(600, 1500));
    if (between(0, 3) === 0) await think(between(800, 2000));
  }
  out(`${c.cyan('⏺')} ${summary}`);
  usage(between(500, 1_500), between(150, 500), between(2_000, 6_000));
  hook('Stop', { stop_hook_active: false });
  out();
  process.stdout.write(c.dim('> '));
  busy = false;
}

async function main() {
  out(c.bold(`✻ ${AGENT_NAME}`) + c.dim(`  demo agent · ${MODEL} · no tokens spent`));
  out(c.dim(`  cwd: ${process.cwd()}`));
  if (!SOCK) out(c.yellow('  (not in a hive: status hooks off)'));
  hook('SessionStart', { source: 'startup' });
  usage(between(4_000, 8_000), 200, 0);
  await sleep(between(1500, 6000));
  for (;;) {
    if (queued) {
      const prompt = queued;
      queued = null;
      await runTurn(prompt, [['Read', 'memory.md', ['picked up the request']], ['Write', 'outbox/ack.json', ['→ god: on it']]], `On it: "${prompt.slice(0, 60)}".`);
    } else {
      const t = turns[turnIndex++ % turns.length];
      await runTurn(t.goal, t.steps, t.summary);
    }
    // Idle between turns, so the floor shows a mix of states.
    const idleUntil = Date.now() + between(AGENT_ID === 'god' ? 15_000 : 8_000, 35_000);
    while (Date.now() < idleUntil && !queued) await sleep(250);
  }
}

// Typed input (from you, or the harness typing a prompt): start a turn about it.
let line = '';
process.stdin.on('data', (buf) => {
  for (const ch of buf.toString('utf8')) {
    if (ch === '\r' || ch === '\n') {
      const text = line.trim();
      line = '';
      if (text && !text.startsWith('/')) queued = text;
      else if (text) out(c.dim(`  ${text}: not available in the demo agent`));
    } else if (ch === '\x03') {
      process.exit(0);
    } else if (ch === '\x7f' || ch === '\b') {
      line = line.slice(0, -1);
    } else {
      line += ch;
    }
  }
  if (!busy && queued) process.stdout.write('\r\x1b[2K');
});
process.stdin.resume();

main().catch((e) => { out(c.red(String(e && e.stack || e))); process.exit(1); });
