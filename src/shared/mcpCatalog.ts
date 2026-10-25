/**
 * Default MCP server catalog (Workstream 3). A dependency-free, importable-by-both
 * (main + renderer) registry of the MCP servers Scranton Branch can wire into each
 * agent's per-session `settings.json`. Keep it free of electron/UI/node imports.
 *
 * Tiers gate consent:
 *   - 'safe-readonly' → no secret, no destructive write OUTSIDE the agent cwd; shipped
 *                       ON by default (`defaultEnabled:true`). `filesystem`/`git` are
 *                       scoped to the agent cwd at merge time (never whole-disk).
 *   - 'write'         → can mutate state beyond the workspace; OFF by default,
 *                       consent-gated.
 *   - 'secret'        → needs an API key / token / connection string; OFF by default,
 *                       consent-gated.
 *
 * The actual merge (catalog ∩ enabled, cwd-scoping of filesystem/git, id namespacing,
 * non-fatal resolution) is Workstream 3's `buildDefaultMcpServers`/`hookSettings`
 * job — this module only declares the entries, their tiers, and the seed defaults.
 *
 * NOTE: several reference servers ship as Python (uvx) rather than npm (npx). The
 * commands below reflect each server's real transport; entries that couldn't be
 * verified against an installed server are flagged `// TODO-verify`. Workstream 3
 * makes a server that fails to resolve non-fatal to the agent.
 */

export type McpTier = 'safe-readonly' | 'write' | 'secret';

/** One credential a keyed server needs (Manager → Connections). The value lives in
 *  the encrypted secret store, never in config or in any file the hive writes:
 *  the per-agent MCP config carries `${ENV}` and the value rides in the agent
 *  process environment (see HiveManager.buildDefaultMcpServers). */
export interface McpSecretField {
  /** The env var the server reads. Also the key in `spec.env`. */
  env: string;
  /** Field label, e.g. "Personal access token". */
  label: string;
  /** One line: where to get it and which scopes it needs. */
  help: string;
  /** Example shape, never a real value. */
  placeholder?: string;
  /** Optional fields may stay empty (e.g. a self-hosted Sentry host). */
  optional?: boolean;
  /** A bare host name (host[:port]): a pasted URL keeps only its host, since the
   *  server refuses one with a scheme (Sentry's SENTRY_HOST). */
  hostOnly?: boolean;
}

/** A credential value as its server expects it (see `hostOnly`). */
export function cleanSecretValue(field: Pick<McpSecretField, 'hostOnly'> | undefined, value: string): string {
  const v = value.trim();
  if (!field?.hostOnly || !v) return v;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).host || v;
  } catch {
    return v;
  }
}

export interface McpCatalogEntry {
  /** Stable catalog id (also the consent key in `config.mcpDefaults`). The merge
   *  step namespaces the written server id (e.g. `munder-<id>`) to avoid clobbering
   *  a user's own `~/.claude` MCP server of the same name. */
  id: string;
  /** Human label for the consent UI. */
  label: string;
  /** One-line description for the consent UI / hire import preview. */
  description: string;
  /** The MCP stdio server launch spec. `filesystem`/`git` carry a placeholder cwd
   *  arg that Workstream 3 replaces with the agent cwd at merge time. */
  spec: {
    command: string;
    args: string[];
    /** Required env (e.g. an API token). Present only on write/secret entries; the
     *  value is supplied via consent, never hard-coded here. */
    env?: Record<string, string>;
    /** uvx servers only: version overrides for the server's own dependencies
     *  (requirement lines, handed to uv through UV_OVERRIDE). For a release whose
     *  pins no longer install. */
    uvOverrides?: string[];
  };
  tier: McpTier;
  /** Seed for `config.mcpDefaults[id].enabled`. Always === (tier === 'safe-readonly'). */
  defaultEnabled: boolean;
  /** Credentials, for the keyed servers. A server whose required fields are not
   *  all stored is left out of an agent's config: it could only fail. */
  secrets?: McpSecretField[];
  /** Where the user creates the credential. */
  docsUrl?: string;
  /** Things to ask an agent that has this server (Connections guide). */
  examples?: string[];
}

/** The default MCP bundle. Safe/read-only servers are ON; anything that writes
 *  beyond the workspace or needs a secret is OFF until the user consents. */
export const MCP_CATALOG: McpCatalogEntry[] = [
  // ─── Safe, read-only, no-secret — shipped ON ──────────────────────────────
  {
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured step-by-step reasoning scratchpad. No I/O, no secrets.',
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    tier: 'safe-readonly',
    defaultEnabled: false
  },
  {
    id: 'time',
    label: 'Time',
    description: 'Current time and timezone conversions.',
    // Reference time server ships as Python. // TODO-verify transport (uvx vs an npm port)
    spec: { command: 'uvx', args: ['mcp-server-time'] },
    tier: 'safe-readonly',
    defaultEnabled: false
  },
  {
    id: 'fetch',
    label: 'Fetch',
    description: 'Fetch a URL and return its content as markdown (read-only HTTP GET).',
    // Reference fetch server ships as Python. // TODO-verify transport (uvx vs an npm port)
    spec: { command: 'uvx', args: ['mcp-server-fetch'] },
    tier: 'safe-readonly',
    defaultEnabled: false
  },
  {
    id: 'context7',
    label: 'Context7 Docs',
    description: 'Up-to-date library/framework documentation lookups.',
    spec: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },
  {
    id: 'filesystem',
    label: 'Filesystem (cwd)',
    description: 'Read/edit files within the agent workspace only (scoped to cwd at spawn).',
    // The trailing arg is the allowed root — Workstream 3 replaces this placeholder
    // with the agent cwd at merge time so it is NEVER whole-disk.
    spec: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '<cwd>'] },
    tier: 'safe-readonly',
    defaultEnabled: false
  },
  {
    id: 'git',
    label: 'Git (cwd)',
    // Also the switch for git in the agent's shell: off, toolGuard.ts refuses it.
    description: 'git in the workspace repo: the Git server and git commands in its shell. Off: the agent cannot run git at all. Applies at once.',
    // Reference git server ships as Python; `--repository <cwd>` is set at merge time.
    // TODO-verify transport (uvx vs an npm port).
    spec: { command: 'uvx', args: ['mcp-server-git', '--repository', '<cwd>'] },
    tier: 'safe-readonly',
    defaultEnabled: true
  },

  // ─── Write / secret — shipped OFF, consent-gated ──────────────────────────
  {
    id: 'github-token',
    label: 'GitHub',
    description: 'Read/write GitHub issues, PRs, and repos. Requires a personal access token.',
    spec: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }
    },
    tier: 'secret',
    defaultEnabled: false,
    secrets: [{
      env: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      label: 'Personal access token',
      help: 'A fine-grained token with access to the repos the agents work on (Contents, Issues, Pull requests).',
      placeholder: 'github_pat_…'
    }],
    docsUrl: 'https://github.com/settings/personal-access-tokens/new',
    examples: [
      'List the open issues in <owner>/<repo> labelled bug, newest first.',
      'Open a pull request from this branch to main with a summary of the changes.',
      'Review PR #12 in <owner>/<repo> and leave comments on anything risky.'
    ]
  },
  {
    id: 'db',
    label: 'Database',
    description: 'Query a Postgres database, read-only. Requires a connection string.',
    // crystaldba/postgres-mcp: reads the connection from the environment. The
    // @modelcontextprotocol server took it as an ARGUMENT, which would have
    // landed in a config file the hive commits. Restricted mode = read-only.
    spec: {
      command: 'uvx',
      args: ['postgres-mcp', '--access-mode=restricted'],
      env: { DATABASE_URI: '' },
      // Its latest release (0.3.0) pins pglast==7.2.0, which PyPI no longer has,
      // so uv falls back to 0.1.0, which crashes on start under mcp 2.x
      // ('Server' object has no attribute 'list_resources'). Let 0.3.0 install
      // with a pglast that exists and the mcp major it was written for.
      uvOverrides: ['pglast>=7.20,<8', 'mcp<2']
    },
    tier: 'secret',
    defaultEnabled: false,
    secrets: [{
      env: 'DATABASE_URI',
      label: 'Connection string',
      help: 'Use a read-only database user. Needs uv (uvx) installed.',
      placeholder: 'postgresql://user:password@host:5432/dbname'
    }],
    examples: [
      'Which tables are there, and how many rows does each have?',
      'How many invoices were created last month, per customer?',
      'Explain the query plan of our slowest report query and suggest an index.'
    ]
  },
  // No Email & Calendar entry: it pointed at @modelcontextprotocol/server-gsuite,
  // which was never published (npm 404), so switching it on could not work.
  // Google's servers need an OAuth client file plus a browser sign-in, not a
  // token, and come back with their own flow.
  {
    id: 'search-with-key',
    label: 'Web Search',
    description: 'Keyed web search. Requires a search-provider API key.',
    // Brave's official server (stdio by default). The @modelcontextprotocol one
    // it replaces is deprecated on npm.
    spec: { command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], env: { BRAVE_API_KEY: '' } },
    tier: 'secret',
    defaultEnabled: false,
    secrets: [{ env: 'BRAVE_API_KEY', label: 'API key', help: 'From the Brave Search API dashboard (the free plan works).', placeholder: 'BSA…' }],
    docsUrl: 'https://api-dashboard.search.brave.com/app/keys',
    examples: [
      'Search the web for the latest release notes of Electron and summarise what changed.',
      'Find three recent articles comparing Postgres and SQLite for desktop apps.'
    ]
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Search, read and edit the Notion pages shared with the integration.',
    spec: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: '' } },
    tier: 'secret',
    defaultEnabled: false,
    secrets: [{
      env: 'NOTION_TOKEN',
      label: 'Integration secret',
      help: 'Create an internal integration, then share the pages it may use with it (••• → Connections).',
      placeholder: 'ntn_…'
    }],
    docsUrl: 'https://www.notion.so/profile/integrations',
    examples: [
      'Find our Notion page about the release process and follow its checklist.',
      'Add today’s standup summary to the "Team notes" page in Notion.'
    ]
  },
  {
    id: 'sentry',
    label: 'Sentry',
    description: 'Look up issues, events and releases in Sentry.',
    spec: { command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_ACCESS_TOKEN: '', SENTRY_HOST: '' } },
    tier: 'secret',
    defaultEnabled: false,
    secrets: [
      {
        env: 'SENTRY_ACCESS_TOKEN',
        label: 'User auth token',
        help: 'Scopes: org:read, project:read, project:write, team:read, team:write, event:write.',
        placeholder: 'sntryu_…'
      },
      { env: 'SENTRY_HOST', label: 'Host (self-hosted only)', help: 'Leave empty for sentry.io.', placeholder: 'sentry.example.com', optional: true, hostOnly: true }
    ],
    docsUrl: 'https://sentry.io/settings/account/api/auth-tokens/',
    examples: [
      'What are the top unresolved Sentry issues in production this week?',
      'Look at the latest error in Sentry for the billing service and find its cause in the code.'
    ]
  }
];

/** Look up a catalog entry by id. */
export function mcpCatalogEntry(id: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.id === id);
}

/** Whether an id is a known safe-readonly server (the only tier a hire manifest may
 *  request without surfacing for human consent — Workstream 3 validation). */
export function isSafeReadonlyMcp(id: string): boolean {
  return mcpCatalogEntry(id)?.tier === 'safe-readonly';
}

/** Seed for `DEFAULTS.mcpDefaults` — derived from the catalog so the two never
 *  drift (safe-readonly ON, write/secret OFF). */
/**
 * Servers that only repeat what Claude Code already has: its own Read/Edit/
 * Glob (filesystem), WebFetch and the office browser (fetch), its thinking
 * (sequential-thinking) and the date in its context (time). Each one was a
 * process tree per agent (npx/uvx + cmd + node/python, ~70 MB) and its tool
 * schemas in every session's context. Off by default since 0.4.6-fork.35, and
 * switched off once for configs that still had them on from the old defaults
 * (config.ts migrateMcpTrimV1); anyone can switch them back on in MCP.
 */
export const REDUNDANT_MCP_SERVERS: readonly string[] = ['filesystem', 'fetch', 'sequential-thinking', 'time'];

/** The consent map with the redundant servers switched off. */
export function trimRedundantMcp(map: Record<string, { enabled: boolean }> | undefined): Record<string, { enabled: boolean }> {
  const out = { ...(map ?? {}) };
  for (const id of REDUNDANT_MCP_SERVERS) if (out[id]?.enabled !== false) out[id] = { enabled: false };
  return out;
}

export function defaultMcpDefaults(): Record<string, { enabled: boolean }> {
  const out: Record<string, { enabled: boolean }> = {};
  for (const e of MCP_CATALOG) out[e.id] = { enabled: e.defaultEnabled };
  return out;
}
