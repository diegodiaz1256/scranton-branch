/**
 * The hive protocol, as one short file per topic under <hive>/protocol/ and an
 * index in <hive>/PROTOCOL.md.
 *
 * It used to be a single 9 KB PROTOCOL.md. Agents grepped it for the part they
 * needed ("spawn", "outbox", "hire") or read all of it every time, and a worker
 * paid for the orchestrator's sections on every read. Now the index says which
 * file answers which question and who it is for, so an agent opens only that.
 */

export const GENERATED_DOC_NOTICE =
  '<!-- Generated and managed by Munder Difflin. Local edits may be replaced during hive bootstrap. -->';

export interface ProtocolDoc {
  /** File name under <hive>/protocol/. */
  file: string;
  title: string;
  /** Who needs it: every agent, or only the orchestrator. */
  who: 'everyone' | 'orchestrator';
  /** The question it answers, as the index lists it. */
  when: string;
  body: string;
}

export const PROTOCOL_DIR = 'protocol';

export const PROTOCOL_DOCS: ProtocolDoc[] = [
  {
    file: 'workspace.md',
    title: 'Your workspace',
    who: 'everyone',
    when: 'what is in your own folder, and what you may write',
    body: `Your folder is \`agents/<your-id>/\` in the hive:
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Read it at the start of a task; append to it as you learn.
- \`inbox/\`       — messages addressed to you. Read them at the start of a task.
- \`inbox/.done/\` — move a message here once you've handled it. Re-reading one there is a no-op.
- \`outbox/\`      — drop messages here to send them (see \`messages.md\`). The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the harness routes it.
Every file has a single writer, and only the harness runs git.`
  },
  {
    file: 'messages.md',
    title: 'Sending a message',
    who: 'everyone',
    when: 'the message JSON, which acts expect a reply, how to reach the human',
    body: `Write one JSON file into your \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

- Only \`request\`, \`query\` and \`propose\` expect a reply. \`inform\` and \`done\` are terminal — don't
  reply to them, or two agents loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\`, who answers for the
  human whenever possible.
- There is no separate approval queue. A tool that needs permission prompts in your own session
  (the human can approve it from their phone via \`/remote-control\`). For a human decision, write
  to \`god\`; a message \`"to": "human"\` is routed to god too.`
  },
  {
    file: 'tasks.md',
    title: 'The plan and the task cards',
    who: 'everyone',
    when: 'board.md vs tasks.json, and who may edit them',
    body: `Two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. God is its sole scribe; others \`propose\` edits to god.
- \`tasks.json\` — the task cards (a kanban: \`backlog / todo / doing / blocked / done / cancelled\`, with title,
  assignee, priority, deps, \`deliverable\`, \`parent\` on a subtask: the id of the card it is a piece of, and
  \`ticket\` when the human gave the card its own ticket key, e.g. a Jira key: use it when you name the card).
  Keep the card you're working on in the right status. \`backlog\` is parked work nobody is on
  right now: move a card there when it waits for later, and back to \`todo\`/\`doing\` when picked up.
- \`cancelled\` means the human stopped the task (\`cancelledAt\` says when). Nobody works on a cancelled
  card: stop at once if it was yours, don't move it out of \`cancelled\`, don't dispatch it again, and keep
  it in tasks.json (it is history, not something to delete). Only the human reopens it.
- The human can also edit a card (title, description, assignee, ticket, parent) or give it to another
  agent. Whoever was on it, and god, get an inbox message saying what changed: a card taken from you or
  cancelled is no longer your work; a changed description is the new contract. God keeps the human's
  changes when writing tasks.json.`
  },
  {
    file: 'services.md',
    title: 'Outside services, secrets and deliverables',
    who: 'everyone',
    when: 'Connections, REST APIs, runners, secrets, where deliverables go',
    body: `Never ask the human for a key, a token or a password: the app holds them and adds them for you.
- **Connections** (GitHub, Database, Notion, Sentry…) are MCP tools named \`munder-<id>\`, for agents
  whose CLI takes the office's MCP servers (Claude Code). Your system prompt lists the ones you
  have and whether they are read-only for you; none listed means none.
- **REST APIs** (Jira, Linear, Stripe, your own…) go through \`bin/md-api.cjs\`: run it with no
  arguments to list the ones you may use right now, then \`md-api <api> GET /path\`. A body goes last:
  JSON, or \`a=1&b=2\` for an API that takes a form (Stripe). An API the
  human connects later works at once. A refusal says why (switched off, no key, not for you, read-only).
- **Runners** run commands that need secrets: \`bin/md-run.cjs\` with no arguments lists the ones that
  exist now (also ones added after you started) and the names of the stored secrets, \`md-run <runner>\`
  runs one. The app executes it in your folder and masks every secret in the output. No runner for what
  you need? Propose one: \`md-run --propose <name> --secrets NAME[,NAME] --why "<reason>" -- <command>\`.
  The human sees the exact command and approves it once; a runner must finish (it is not for a server
  that keeps running).
- **The office browser** reads a page with the app's own Chromium when a plain fetch gets nothing
  (403, "enable JavaScript", an empty shell): \`bin/md-browse.cjs <url>\` (\`--links\` for its links),
  \`md-browse --search "<query>"\`; Claude Code agents also have it as the \`munder-browser\` tools. It is
  off when Web is switched off for you. It does not solve captchas or bot challenges: report those.
- **Deliverables** for the human go in \`research/\` (a subfolder per task is fine); say the path
  when you report.`
  },
  {
    file: 'guardrails.md',
    title: 'Circuit breaker and token budgets',
    who: 'everyone',
    when: 'a "Circuit breaker" message reached you, or you worry about spend',
    body: `A circuit breaker watches every agent for runaway behaviour (looping on the same tool, error storms,
overspending). It escalates: \`steer\` → \`constrain\` → \`stop\`. A \`Circuit breaker: steer\` or
\`Circuit breaker: constrain\` message in your inbox means you ARE the problem it caught: stop
repeating, summarise what you tried, and do what it says (constrain = read-only, and god's sign-off
before more tool calls).

Be token-frugal: the floor has a budget and each agent can have its own limit. Prefer references
over pasted content, and \`/compact\` your session when its context gets heavy.`
  },
  {
    file: 'semantic-memory.md',
    title: 'Semantic memory',
    who: 'everyone',
    when: 'recalling what the office already knows (when MemPalace is installed)',
    body: `When \`MEMPALACE_PALACE_PATH\` is set in your environment, the office shares a searchable
MemPalace and you have the \`mempalace\` CLI (Claude Code agents also get it as the
\`munder-memory\` MCP tools):
- \`mempalace search "<query>"\` — recall past knowledge across the whole team by meaning. Add
  \`--wing <agent-id>\` to scope to one agent, \`--results N\` to widen.
- \`mempalace wake-up\` — a short digest of what matters, good at the start of a task.

Every agent's \`memory.md\` is mined into it automatically; you never run \`mine\` yourself.`
  },
  {
    file: 'ask-human.md',
    title: 'Asking the human (the ASK ME card)',
    who: 'orchestrator',
    when: 'a card can only move with the human: how to ask on the card',
    body: `When a card can only move with the human — a question, or an action only they can do (create an
account, approve a spend, hand over credentials, test on their device) — set the card
\`"status": "blocked"\` and append the ask to its \`humanQA\` array:

\`\`\`json
{ "q": "the ask, in markdown", "askedAt": "<iso timestamp>" }
\`\`\`

The ASK ME board shows it; the human's reply lands in the same entry as \`"a"\` and as an inbox
message to you. Keep every past entry: the trail is the card's decision history.

**Short, and in markdown** (the card renders it; over ~700 characters it is a report, not a question):
- open with ONE **bold** sentence saying exactly what you need;
- \`backticks\` for paths, commands, values and identifiers;
- \`-\` bullets or \`1.\` numbers for every option or step;
- a blank line between paragraphs (a single newline is a line break).

Rewrite an ask that comes from another agent's report into that shape; never paste the report. No
separate question files (\`HumanQuestion.md\`), and never sit waiting: move on and pick the answer up
when it arrives.`
  },
  {
    file: 'fleet.md',
    title: 'Watching the floor',
    who: 'orchestrator',
    when: 'who is doing what, live state, costs',
    body: `- \`fleet.json\` — refreshed continuously: each agent's tokens, cost, status, breaker level, last tool,
  last-active time and inbox backlog. Your source of truth for the floor.
- \`registry.json\` — the roster; \`log.jsonl\` — the event feed.
- One agent in depth: its \`agents/<id>/memory.md\` and \`inbox/\`, or send it a \`query\`.

\`claude agents\` does NOT list the office's agents: they are started by the app, not by you.
\`COMMANDS.md\` is the Claude Code command reference (slash commands act only on your own session).`
  },
  {
    file: 'spawn.md',
    title: 'Spawning a temp worker',
    who: 'orchestrator',
    when: 'starting a worker for one job yourself',
    body: `Write ONE JSON file into \`spawn-requests/<id>.json\` in the hive root:

\`\`\`json
{
  "objective": "what the worker must do (required)",
  "cwd": "/absolute/path (required: a registered repo, this office, or an agent's folder)",
  "name": "display name (optional)",
  "provider": "claude | codex | cursor | antigravity | … (optional)",
  "command": "engine CLI (optional; an agent CLI only, no settings/MCP/backend flags)",
  "model": "model override (optional)",
  "isolate": true,
  "tokenCap": 0,
  "slack": { "channel": "C…", "thread_ts": "…" },
  "character": "meredith",
  "accent": "coral"
}
\`\`\`

The harness spawns \`worker-<id>\` and moves the request to \`spawn-requests/.done/\`, or to
\`.failed/\` with a reason. \`isolate\` (default true) gives it its own git worktree; \`slack\` routes its
failures to a thread; \`character\`/\`accent\` set its look (a cast member's name already does).

**It can be switched off** (Settings → Autonomy & limits, off by default). While off, a request
waits in \`spawn-requests/\` untouched; raise it with the human instead of retrying. Route work to an
agent already on the floor first either way. A temp is archived when its job is done (when it sends
its \`done\`, also after an app restart): for a permanent member of the office, see \`hire.md\`.

**Archiving a temp yourself.** When a temp you started is no longer needed (it finished without
sending \`done\`, or its job was dropped), write \`archive-requests/<any-name>.json\` in the hive root:
\`{"id": "worker-<id>"}\`. The harness closes its terminal, archives it (its folder, memory and
committed work are kept), moves the request to \`archive-requests/.done/\` and tells you in your inbox.
Only a temp you hired through \`spawn-requests\` can be archived this way: anyone else is refused
(the request goes to \`.failed/\` and you hear why). The live roster marks temps with \`temp\`.`
  },
  {
    file: 'hire.md',
    title: 'Hiring a permanent employee',
    who: 'orchestrator',
    when: 'the human wants a permanent member of the office, not a temp',
    body: `Write a hire manifest to \`research/hires/<name>.json\`. The app opens the Add-Agent review with it
prefilled and the human confirms; the new agent then appears in \`registry.json\` and you dispatch to
its inbox. An invalid file comes back to your inbox as \`[hire manifest rejected]\` with the reason.

\`\`\`json
{
  "spec": "munder-difflin/hire@1",
  "name": "display name (required)",
  "description": "one-line role",
  "goal": "the standing mission",
  "provider": "claude | codex | cursor | antigravity",
  "model": "model id (optional)",
  "character": "office cast sprite, e.g. dwight (optional)",
  "cwd": "/absolute/path of the folder it works in (optional; defaults to the first project)",
  "sessionId": "a Claude session id to continue with --resume (optional)",
  "isolate": false,
  "tokenCap": 0
}
\`\`\`

\`tokenCap\` 0 means no cap. A \`cwd\` that is not a project yet is added as one when the human
confirms. Write several manifests to propose several hires: the human reviews them one after another,
and any they close without deciding are offered again on the next launch.`
  },
  {
    file: 'skills.md',
    title: 'Giving agents skills',
    who: 'orchestrator',
    when: 'an agent would do a job better with a skill (pdf, docx, xlsx, pptx, web testing...)',
    body: `Office skills come from the skills catalog. Find one with
\`bin/md-skills.cjs search <words>\` (one line per match; your instructions give the full command)
and see who has what with \`md-skills list\`. To add or remove, write ONE JSON file into your own
\`skills/\` folder:

\`\`\`json
{ "action": "add", "skill": "pdf", "agents": ["jim", "pam"] }
{ "action": "add", "skill": "docx", "agents": ["*"] }
{ "action": "remove", "skill": "pdf", "agents": ["jim"] }
\`\`\`

\`"*"\` means every agent, new ones too; \`remove\` without agents takes it from everyone. The app
installs it, copies it into those agents and answers in your inbox (\`[skills updated]\` or
\`[skills request refused]\` with the reason). The human decides what you may add (Capabilities →
Skills): by default only Anthropic's own skills; a refused community skill is theirs to allow.
Give a skill only to the agents whose work needs it: each one costs context.`
  },
  {
    file: 'app-pages.md',
    title: 'The app: layouts and daily pages',
    who: 'orchestrator',
    when: 'the human asks about Now, Tasks, Inbox, Deliverables, Memory, Automations, Team, Factories, Agents or Temps',
    body: `Answer with the exact place to click, in the human's language; say plainly when something is not possible. Never guess a setting that is not here.

## The two layouts
The top bar switches between **Floor** (the pixel office: agents at desks, cards at the bottom,
an agent's terminal and panels on the right) and **Manager** (a sidebar of pages). Both show the
same office. The top bar also has the theme switch (☾), full screen, and Settings (the wrench).

## Manager pages (sidebar)
- **Now** — what the office is doing, newest first. "Right now" lists every agent: its state,
  its current task (ticket + title) and its last step. Tabs: All, Messages, Steps, Problems.
- **Tasks** — the board: Backlog (parked), To do, Doing, Blocked, Done; tickets (DUN-12), subtasks
  under their parent. A card opens its detail, history, questions and deliverables, with **Edit**
  and **Cancel task** (greyed in Done, Cancelled filter, **Reopen**).
- **Inbox** — a chat per agent: messages, questions you asked (with the human's answers inline),
  and an All tab. The human answers your questions here.
- **Deliverables** — what the agents made (\`research/\`, files linked from tasks or written this
  session). Search by ticket, filter, sort. Click a file to preview it (Markdown, wiki, Mermaid,
  CSV, JSON, images, PDF); History shows who changed it and each version's diff.
- **Office** group:
  - **Automations** — scheduled missions and other triggers, with their history.
  - **Memory** — search what the office knows, a graph, "Recently learned", the human's Lists,
    and Entities (people, tickets… the notes mention).
  - **Team** — pairs this office with teammates' offices: who may message you, and how strictly
    those messages are held for the human (Inbox → From outside).
  - **Factories** — external software factories this office sends work to or watches.
- **Agents** — every agent with its terminal tail, current ticket and usage; **Add an agent**; the
  orchestrator's card (spend, breaker, tasks, questions). An agent's own page has its terminal,
  steps, restart, and (for you) the routing map.
- **Temps** — short-lived workers with a job and a folder (desks are limited); they finish and
  leave.`
  },
  {
    file: 'app-setup.md',
    title: 'The app: Capabilities, Connections, Environment, providers, MCP',
    who: 'orchestrator',
    when: 'the human asks about permissions, git, folders, skills, keys, secrets, runners, engines or tool servers',
    body: `Answer with the exact place to click, in the human's language; say plainly when something is not possible. Never guess a setting that is not here.

## Manager → Setup
- **Capabilities** — who has what. Role bundles (a set of tools and servers) granted per agent;
  per-agent chips for web, shell, subagents, each MCP server, **Git** (off: the agent cannot run
  git at all) and **Outside its folders** (off, the default: it writes only in its workspace, its
  hive folder, the hive and the temp folder). These are checked before every command, including
  one-liners in python/node and nested shells, but a script saved in a file is not read in
  advance: it is a fence, not a jail. Tab **Skills**: what you may add (nothing, Anthropic's only,
  Anthropic's plus the human's own marketplaces, or the whole catalog), the skills you gave, and
  **Your marketplaces** (GitHub repositories with skills, added by address).
- **Connections** — accounts and services: MCP connections that need a key (GitHub, Notion,
  Sentry, Brave search…), and REST APIs (Jira, Confluence, Linear, Stripe, HubSpot or a custom
  one) that agents call through \`md-api\` without seeing the key. Each has a Test button and a
  read-only / read & write level.
- **Environment** — variables for agents, secrets they can use but never see (stored encrypted,
  or read from 1Password), and **runners**: commands the human defines that run with secrets and
  give the agent only the masked output. An agent may propose a runner (\`md-run --propose\`); the
  human approves it in a dialog. The secrets it names must already exist here.
- **AI providers** — the engines (Claude Code, Codex, Gemini, Copilot, Cursor, Pi, OpenCode…),
  their sign-in state, custom OpenAI-compatible endpoints (with model list), and certificates
  for company proxies.
- **MCP** — the human's own tool servers (command or URL), and the ones their other tools already
  use (found on this computer) to import.`
  },
  {
    file: 'app-settings.md',
    title: 'The app: Settings, floors, the office picker',
    who: 'orchestrator',
    when: 'the human asks about Settings, updates, freezes, memory model, voice, Slack, another office (floors)',
    body: `Answer with the exact place to click, in the human's language; say plainly when something is not possible. Never guess a setting that is not here.

## Settings (the wrench; has a search)
- **General** — version and updates (checked every 6 hours, install is the human's click), the
  **Freezes** log (stalls over 200 ms the app wrote down by itself, with the cause; "Open log" for
  a report), the office folder (change it: the app relaunches), keep the computer awake, plain
  language mode, notifications, auto-compact, telemetry, language, and Reset (start over). The
  layout (Floor / Manager) and the theme are in the top bar.
- **Setup** — the tools the app relies on (git, Node, uv, mempalace…), with install buttons.
- **Models & API keys** — default model, model and effort per role, provider keys, certificates.
- **Autonomy & limits** — auto mode, token budgets (floor and per agent), the circuit
  breaker (error storms, hard stop).
- **Tools, Slack & webhooks** — default MCP servers, Slack (a channel's messages into your queue, replies in threads) and webhooks
  (public endpoints with a secret, per-trigger JSON schema).
- **Voice** — dictation (Groq, or local Whisper, downloaded once) and talking in real time
  (needs an OpenAI key).
- **Memory & knowledge** — semantic memory on/off, the memory model (download or update it here:
  the only time memory goes online), the knowledge base (documents agents can query).

## Floors (several offices at once)
File → **New Floor** (Ctrl+Shift+N), or the office name under "Scranton Branch" in the sidebar →
**New floor**: another office in its own window and process, with its own orchestrator, starting
from the same settings and keys. File → **Open Floor** (or that sidebar list) reopens or forgets
one (its office folder is kept). One office per floor at a time.

## The office picker
On launch: open the current office, a recent one, another folder, or a new office (Windows or WSL).

## Things that are not possible (say so instead of guessing)
- Agents never see secret values; only the masked output of a runner or the result of an API call.
- Only the app runs git in the hive; agents never commit the hive.
- A floor cannot share an office with another floor.
- Memory never downloads anything on its own: only the Settings button does.`
  }
];

/** <hive>/protocol/<file>: one topic, standalone. */
export function renderProtocolDoc(d: ProtocolDoc): string {
  return `${GENERATED_DOC_NOTICE}\n\n# ${d.title}\n\n_For: ${d.who === 'orchestrator' ? 'the orchestrator (god)' : 'every agent'}._\n\n${d.body}\n`;
}

/** <hive>/PROTOCOL.md: where things are, and which topic file to open. */
export function renderProtocolIndex(): string {
  const row = (d: ProtocolDoc): string => `- \`${PROTOCOL_DIR}/${d.file}\` — ${d.when}.`;
  return [
    GENERATED_DOC_NOTICE,
    '',
    '# Hive protocol — index',
    '',
    'You are one of several agents (Claude Code, Codex, Gemini…) sharing this office. Coordination is',
    'file-based: the harness is the only thing that runs git and moves messages between agents.',
    '',
    '**Open only the topic you need.** Each file below is short and stands alone; you never need to read',
    'them all, and a worker never needs the orchestrator ones.',
    '',
    '## Every agent',
    ...PROTOCOL_DOCS.filter((d) => d.who === 'everyone').map(row),
    '',
    '## Orchestrator (god) only',
    ...PROTOCOL_DOCS.filter((d) => d.who === 'orchestrator').map(row),
    '- `COMMANDS.md` — the Claude Code command reference.',
    '',
    '## Where things are — don\'t search for them',
    'All in this hive folder (paths relative to it); your system prompt gives each one in full.',
    '- `agents/<your-id>/` — your folder (`protocol/workspace.md`).',
    '- `board.md`, `tasks.json` — the plan and the task cards.',
    '- `registry.json`, `fleet.json`, `log.jsonl` — the roster, live state, the event feed.',
    '- `research/` — deliverables for the human; `research/hires/` — hire proposals.',
    '- `lists/` — the human\'s personal lists.',
    '- `spawn-requests/`, `archive-requests/`, `missions.json` — temps started and archived, and scheduled missions.',
    '- `bin/md-api.cjs` (REST APIs), `bin/md-run.cjs` (runners) — no arguments lists what you may use.',
    '',
    'Never hunt for office files or tools across the disk, in other projects, or in Scranton Branch\'s',
    'own installation or source code. If something is not here, in your folder, your working directory',
    'or your prompt, it does not exist for you: ask `god` (god asks the human) instead.',
    ''
  ].join('\n');
}

/** Every protocol file, relative to the hive root. */
export function protocolFiles(): Array<{ filename: string; contents: string }> {
  return [
    { filename: 'PROTOCOL.md', contents: renderProtocolIndex() },
    ...PROTOCOL_DOCS.map((d) => ({ filename: `${PROTOCOL_DIR}/${d.file}`, contents: renderProtocolDoc(d) }))
  ];
}
