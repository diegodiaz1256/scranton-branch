/**
 * Office skills: the orchestrator gives agents skills from the catalog.
 *
 * It writes a request into its own folder (agents/<god>/skills/<id>.json, the
 * single-writer rule every agent follows); main checks it here, installs the
 * skill once into the hive's skill store, copies it into the agents it names
 * and answers in the orchestrator's inbox. What it may install is the human's
 * call (Capabilities → Skills): nothing, Anthropic's own skills only (the
 * default), Anthropic's plus the human's own marketplaces, or anything in the
 * catalog. A skill is instructions that run with
 * the agent's tools, so the catalog's community entries stay opt-in.
 *
 *   { "action": "add",    "skill": "pdf", "agents": ["jim", "pam"] }
 *   { "action": "add",    "skill": "docx", "agents": ["*"] }      // every agent, new ones too
 *   { "action": "remove", "skill": "pdf", "agents": ["jim"] }      // omit agents: from everyone
 */

export type SkillPolicy = 'off' | 'official' | 'mine' | 'catalog';

/** The publisher whose skills count as official. */
export const OFFICIAL_SKILL_OWNER = 'anthropics';

export interface CatalogEntry {
  name: string; description: string; url: string; category: string; owner: string;
  /** Set when it comes from one of the human's own marketplaces. */
  marketplace?: string;
}

/** May the orchestrator add this skill under this policy? */
export function policyAllows(entry: Pick<CatalogEntry, 'owner' | 'marketplace'>, policy: SkillPolicy): boolean {
  if (policy === 'off') return false;
  if (policy === 'catalog') return true;
  if (entry.owner === OFFICIAL_SKILL_OWNER) return true;
  return policy === 'mine' && !!entry.marketplace;
}

export interface OfficeSkill {
  /** The catalog source it was installed from. */
  url: string;
  owner: string;
  /** Folder name in the store and in each agent's .claude/skills. */
  dir: string;
  /** Agent ids, or ['*'] for every agent. */
  agents: string[];
  addedAt: string;
}

export interface OfficeSkills { skills: Record<string, OfficeSkill> }

export type SkillPlan =
  | { ok: false; message: string }
  | { ok: true; message: string; next: OfficeSkills; install?: CatalogEntry; drop?: string };

export function cleanSkillPolicy(v: unknown): SkillPolicy {
  return v === 'off' || v === 'catalog' || v === 'mine' ? v : 'official';
}

export function readOfficeSkills(raw: unknown): OfficeSkills {
  const out: OfficeSkills = { skills: {} };
  const s = raw && typeof raw === 'object' ? (raw as { skills?: unknown }).skills : null;
  if (!s || typeof s !== 'object') return out;
  for (const [name, v] of Object.entries(s as Record<string, unknown>)) {
    const e = v as Partial<OfficeSkill>;
    if (!e || typeof e.dir !== 'string' || !Array.isArray(e.agents)) continue;
    out.skills[name] = {
      url: typeof e.url === 'string' ? e.url : '',
      owner: typeof e.owner === 'string' ? e.owner : '',
      dir: e.dir,
      agents: e.agents.filter((a): a is string => typeof a === 'string'),
      addedAt: typeof e.addedAt === 'string' ? e.addedAt : ''
    };
  }
  return out;
}

/** True when this skill reaches this agent. */
export function skillReaches(s: OfficeSkill, agentId: string): boolean {
  return s.agents.includes('*') || s.agents.includes(agentId);
}

/** The catalog entry for a name: exact (case-insensitive), the official one
 *  first when several publishers use the name. */
export function findCatalogSkill(catalog: readonly CatalogEntry[], name: string): CatalogEntry | undefined {
  const n = name.trim().toLowerCase();
  const hits = catalog.filter((c) => c.name.toLowerCase() === n);
  return hits.find((c) => c.owner === OFFICIAL_SKILL_OWNER) ?? hits[0];
}

/** Best matches for some words, for the orchestrator's search. */
export function searchCatalog(catalog: readonly CatalogEntry[], query: string, policy: SkillPolicy, n = 8): CatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const pool = catalog.filter((c) => policyAllows(c, policy));
  if (!words.length) return pool.slice(0, n);
  return pool
    .map((c) => {
      const name = c.name.toLowerCase();
      const hay = `${c.description} ${c.category}`.toLowerCase();
      const score = words.reduce((s, w) => s + (name === w ? 5 : name.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0);
      return { c, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name))
    .slice(0, n)
    .map((x) => x.c);
}

/** What a request does to the office skills, or why it is refused. */
export function planSkillRequest(
  req: unknown,
  ctx: { state: OfficeSkills; catalog: readonly CatalogEntry[]; policy: SkillPolicy; agents: ReadonlySet<string>; now?: string }
): SkillPlan {
  if (ctx.policy === 'off') return { ok: false, message: 'The human has not let you manage skills (Capabilities → Skills).' };
  const r = (req && typeof req === 'object' ? req : {}) as { action?: unknown; skill?: unknown; agents?: unknown };
  const action = r.action === 'add' || r.action === 'remove' ? r.action : null;
  if (!action) return { ok: false, message: 'action must be "add" or "remove".' };
  // A plugin-qualified name ("anthropic-skills:xlsx", as Claude Code lists
  // skills) means the catalog's "xlsx".
  const name = typeof r.skill === 'string' ? r.skill.trim().replace(/^[\w.-]+:/, '') : '';
  if (!name) return { ok: false, message: 'skill is required (a catalog name; search with sb-skills).' };
  const list = Array.isArray(r.agents) ? r.agents.filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim()) : [];
  const unknown = list.filter((a) => a !== '*' && !ctx.agents.has(a));
  if (unknown.length) return { ok: false, message: `No agent with id ${unknown.join(', ')} on the floor.` };
  const next: OfficeSkills = { skills: { ...ctx.state.skills } };
  const key = Object.keys(next.skills).find((k) => k.toLowerCase() === name.toLowerCase());

  if (action === 'remove') {
    if (!key) return { ok: false, message: `${name} is not an office skill.` };
    const cur = next.skills[key];
    const left = !list.length || list.includes('*') ? [] : cur.agents.filter((a) => !list.includes(a));
    if (left.length) {
      next.skills[key] = { ...cur, agents: left };
      return { ok: true, next, message: `${key} removed from ${list.join(', ')}; still with ${left.join(', ')}.` };
    }
    delete next.skills[key];
    return { ok: true, next, drop: cur.dir, message: `${key} removed from every agent.` };
  }

  if (!list.length) return { ok: false, message: 'agents is required: agent ids, or ["*"] for everyone.' };
  const agents = list.includes('*') ? ['*'] : list;
  if (key) {
    const cur = next.skills[key];
    const merged = cur.agents.includes('*') || agents.includes('*') ? ['*'] : [...new Set([...cur.agents, ...agents])];
    next.skills[key] = { ...cur, agents: merged };
    return { ok: true, next, message: `${key} now reaches ${merged.includes('*') ? 'every agent' : merged.join(', ')} (from their next prompt).` };
  }
  const entry = findCatalogSkill(ctx.catalog, name);
  if (!entry) return { ok: false, message: `${name} is not in the skills catalog. Search it with sb-skills.` };
  if (!policyAllows(entry, ctx.policy)) {
    const allowed = ctx.policy === 'mine' ? "Anthropic's own and the human's marketplaces" : "Anthropic's own";
    return { ok: false, message: `${entry.name} is a community skill (${entry.owner}); you may only add ${allowed}. Ask the human to allow the whole catalog in Capabilities → Skills, or to add it there.` };
  }
  const dir = entry.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
  if (!dir) return { ok: false, message: `${entry.name} has no usable folder name.` };
  next.skills[entry.name] = { url: entry.url, owner: entry.owner, dir, agents, addedAt: ctx.now ?? new Date().toISOString() };
  return { ok: true, next, install: entry, message: `${entry.name} (${entry.owner}) installed for ${agents.includes('*') ? 'every agent' : agents.join(', ')}.` };
}
