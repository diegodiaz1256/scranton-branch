/**
 * SKILLS — what the coding agents on this machine can actually do, plus a
 * browsable catalog of what they could.
 *
 * Two halves, deliberately separate:
 *
 *  1. LOCAL — skills already installed, discovered by walking the directories
 *     each CLI reads. Claude Code is the well-specified one: a skill is a folder
 *     containing SKILL.md whose YAML frontmatter carries `name` and
 *     `description`. OpenCode and Codex use plugin/config directories instead,
 *     so they are reported as plugins rather than pretending they share a format.
 *
 *  2. CATALOG — abubakarsiddik31/claude-skills-collection: 227 skills in 13
 *     categories, as markdown tables with a GitHub source link per row. It has no
 *     JSON index (checked), so entries are parsed from the raw markdown and
 *     cached on disk. Network failure is never fatal: a stale cache, then an
 *     empty list, then the UI says so.
 *
 * Nothing here installs anything. Discovery and browsing only — installing a
 * third-party skill means running someone else's instructions inside an agent
 * that has the user's tools, and that decision stays with the user.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename, dirname, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { downloadToFile, getText, TooLargeError } from './fetchText';
import {
  commitStaging, copyFolderSkill, discard, extractArchiveSkill, indexArchive, listArchiveDir,
  overLimitMessage, planArchiveSkill, planFolderSkill, restoreExecBits, stagingDir, type SkillLimits
} from './skillArchive';

export interface LocalSkill {
  id: string;
  name: string;
  description: string;
  /** Which CLI reads this directory. */
  provider: 'claude' | 'opencode' | 'codex';
  /** 'user' = global for the whole machine, 'project' = one repo, 'bundled' = ships with the app. */
  scope: 'user' | 'project' | 'bundled';
  path: string;
}

export interface CatalogSkill {
  name: string;
  description: string;
  url: string;
  category: string;
  /** The publisher, taken from the source URL's GitHub owner — anthropics,
   *  stripe, supabase. The names in this list are bare (`docx`, `pdf`), so the
   *  URL is the only place the publisher appears. */
  owner: string;
}

/** Strip a leading YAML frontmatter block and pull the two fields we render.
 *  Deliberately not a YAML parser: `name` and `description` are all the UI shows,
 *  and description is routinely a multi-line `|` block, which a naive
 *  key:value split would truncate at the first line. */
export function parseSkillFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const body = m[1];
  const out: { name?: string; description?: string } = {};
  const nameM = /^name:\s*(.+)$/m.exec(body);
  if (nameM) out.name = nameM[1].trim().replace(/^["']|["']$/g, '');
  // Block scalar (`description: |`) → take the indented lines that follow.
  // Consecutive INDENTED lines after `description: |`. The earlier lookahead
  // form ended at `\r?\n?$`, which under /m matches the end of the FIRST line —
  // so every multi-line description silently arrived truncated to one line.
  const blockM = /^description:\s*[|>]-?[ \t]*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m.exec(body);
  if (blockM) {
    out.description = blockM[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ').trim();
  } else {
    const inlineM = /^description:\s*(.+)$/m.exec(body);
    if (inlineM) out.description = inlineM[1].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Every folder under `dir` holding a SKILL.md, read into a LocalSkill. */
function scanSkillDir(
  dir: string,
  provider: LocalSkill['provider'],
  scope: LocalSkill['scope']
): LocalSkill[] {
  const out: LocalSkill[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
    for (const entry of readdirSync(dir)) {
      const skillDir = join(dir, entry);
      const md = join(skillDir, 'SKILL.md');
      try {
        if (!statSync(skillDir).isDirectory() || !existsSync(md)) continue;
        const fm = parseSkillFrontmatter(readFileSync(md, 'utf8'));
        out.push({
          id: `${scope}:${entry}`,
          name: fm.name || entry,
          description: fm.description || '',
          provider,
          scope,
          path: skillDir
        });
      } catch { /* one unreadable skill must not hide the rest */ }
    }
  } catch { /* unreadable root → report nothing rather than throw into IPC */ }
  return out;
}

/** Plugin directories for the CLIs that do not use Claude's SKILL.md format.
 *  Reported as entries so the tab tells the truth about what a provider has,
 *  instead of implying only Claude Code is extensible. */
function scanPluginDir(dir: string, provider: LocalSkill['provider'], scope: LocalSkill['scope']): LocalSkill[] {
  const out: LocalSkill[] = [];
  try {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue;
      out.push({
        id: `${scope}:${provider}:${entry}`,
        name: entry.replace(/\.(m|c)?js$/i, ''),
        description: `Plugin in ${basename(dirname(dir))}/${basename(dir)}`,
        provider,
        scope,
        path: join(dir, entry)
      });
    }
  } catch { /* noop */ }
  return out;
}

/**
 * Everything installed, deduped by (provider, name) with the most specific scope
 * winning — a project skill shadows the user's, which shadows the bundled copy,
 * which is the same precedence the CLIs themselves apply.
 */
export function listLocalSkills(opts: { cwds: string[]; bundledDir: string | null; home?: string }): LocalSkill[] {
  const home = opts.home ?? homedir();
  const found: LocalSkill[] = [
    ...(opts.bundledDir ? scanSkillDir(opts.bundledDir, 'claude', 'bundled') : []),
    ...scanSkillDir(join(home, '.claude', 'skills'), 'claude', 'user'),
    ...scanPluginDir(join(home, '.config', 'opencode', 'plugin'), 'opencode', 'user'),
    ...scanPluginDir(join(home, '.codex', 'plugins'), 'codex', 'user')
  ];
  for (const cwd of opts.cwds) {
    if (!cwd) continue;
    found.push(...scanSkillDir(join(cwd, '.claude', 'skills'), 'claude', 'project'));
    found.push(...scanPluginDir(join(cwd, '.opencode', 'plugin'), 'opencode', 'project'));
  }
  const rank = { project: 3, user: 2, bundled: 1 } as const;
  const best = new Map<string, LocalSkill>();
  for (const s of found) {
    const key = `${s.provider}:${s.name.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || rank[s.scope] > rank[prev.scope]) best.set(key, s);
  }
  return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const CATALOG_URL =
  'https://raw.githubusercontent.com/abubakarsiddik31/claude-skills-collection/main/README.md';
/** A curated list changes on a human timescale; a day-old copy is fine and keeps
 *  the tab instant on every open after the first. */
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the catalog README into entries.
 *
 * The list is markdown TABLES under `## <emoji> Category` headings:
 *
 *   | Name | Description | Link |
 *   |------|-------------|------|
 *   | **docx** | Create and edit Word documents | [Source](https://github.com/…/tree/main/skills/docx) |
 *
 * Rows that are not skill rows — the header row, the `|---|` rule, the overview
 * table that counts skills per category — are skipped by requiring three cells
 * AND a resolvable https link. Anything else is dropped rather than guessed at:
 * a catalog missing a row is honest, one full of parsed headers is not.
 */
export function parseCatalogMarkdown(md: string): CatalogSkill[] {
  const out: CatalogSkill[] = [];
  let category = 'Skills';
  const seen = new Set<string>();
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const h = /^#{2,3}\s+(.+?)\s*$/.exec(line);
    if (h) {
      category = h[1]
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*_`]/g, '')
        // Leading pictographs only — a blanket non-alphanumeric strip would eat
        // the dot off a name like ".NET".
        .replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '')
        .trim() || category;
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;
    if (/^-{3,}$/.test(cells[0].replace(/:/g, ''))) continue; // the |---| rule
    const name = cells[0].replace(/[*`]/g, '').trim();
    const description = cells[1].replace(/[*`]/g, '').trim();
    const linkM = /\((https?:\/\/[^)]+)\)/.exec(cells[2]) || /(https?:\/\/\S+)/.exec(cells[2]);
    if (!name || !linkM) continue;
    const url = linkM[1].trim();
    const key = `${name}|${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ghOwner = /^https:\/\/github\.com\/([^/]+)/i.exec(url);
    out.push({
      name,
      description,
      url,
      category,
      owner: ghOwner ? ghOwner[1].toLowerCase() : 'other'
    });
  }
  return out;
}


/**
 * The catalog, from cache when fresh and from the network otherwise. A failed
 * refresh falls back to whatever is cached — an offline user still gets to
 * browse, flagged as stale, instead of an empty tab and no explanation.
 */
export async function loadCatalog(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<{ skills: CatalogSkill[]; fetchedAt: number; stale: boolean; error?: string }> {
  let cached: { skills: CatalogSkill[]; fetchedAt: number } | null = null;
  try {
    if (existsSync(cachePath)) cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch { cached = null; }

  const fresh = cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS;
  if (fresh && !opts.force) return { skills: cached!.skills, fetchedAt: cached!.fetchedAt, stale: false };

  try {
    const md = await getText(CATALOG_URL);
    const skills = parseCatalogMarkdown(md);
    // An empty parse means the README's shape changed under us. Keep the cache.
    if (skills.length === 0 && cached) {
      return { skills: cached.skills, fetchedAt: cached.fetchedAt, stale: true, error: 'catalog format changed' };
    }
    const payload = { skills, fetchedAt: Date.now() };
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(payload));
    } catch { /* cache is an optimisation, not a requirement */ }
    return { ...payload, stale: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (cached) return { skills: cached.skills, fetchedAt: cached.fetchedAt, stale: true, error };
    return { skills: [], fetchedAt: 0, stale: true, error };
  }
}

/* ── Install / uninstall ──────────────────────────────────────────────────────
 *
 * A skill is INSTRUCTIONS THAT RUN INSIDE AN AGENT holding the user's tools and
 * keys, so this half of the file is written as if the source is hostile, because
 * from the app's point of view it is: it is arbitrary content from a public list
 * that anyone can PR into.
 *
 * Every limit below exists to bound a specific abuse:
 *   - the destination name is sanitised, so `../../.claude/settings.json` cannot
 *     be a "skill name";
 *   - each archive path is refused if absolute or traversing, and re-checked
 *     to be inside the destination AFTER resolution (skillArchive.ts);
 *   - the skill's unpacked size and file count are capped before anything is
 *     written, and the download itself is capped, so a repo cannot fill a disk;
 *   - only regular files are written — symlinks, hardlinks and devices in the
 *     archive (or a local folder) are skipped, never followed.
 *
 * Uninstall is the more dangerous verb and is treated as such: it deletes a
 * directory, so it refuses anything that is not INSIDE a known skills root and
 * does not itself contain a SKILL.md. A bundled skill can never be removed — it
 * ships inside the app and would reappear on the next spawn anyway.
 */

/** A directory listing entry (GitHub contents API shape; the archive index is
 *  read into the same shape). Only the fields we actually consume. */
interface GhEntry { name: string; path: string; type: string; size?: number; download_url?: string | null }

/** One skill, unpacked. Skills that ship data and scripts run to a few MB
 *  (ui-ux-pro-max: 3 MB in 80 files); 50 MB leaves room without letting a
 *  "skill" be a dataset. */
export const SKILL_LIMITS: SkillLimits = { maxBytes: 50 * 1024 * 1024, maxFiles: 5000 };
/** The compressed repository download the skill is taken from. Larger than the
 *  skill limit because the rest of the repository comes along with it. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_FOLDER_DEPTH = 16;

export type InstallResult =
  | { ok: true; path: string; files?: number; bytes?: number; skipped?: number }
  | { ok: false; error: string; unsupported?: boolean };

/**
 * A GitHub source URL → the pieces the contents API needs.
 *
 * Two shapes, because the catalog uses both: a folder inside a repo
 * (`owner/repo/tree/<ref>/<path>`, 145 entries) and a whole repo whose root IS
 * the skill (`owner/repo`, 81 entries). For the latter `ref` is empty and the
 * caller omits it, which makes the API use the repo's default branch — there is
 * no reliable way to guess between `main` and `master` and no need to.
 */
export function parseGitHubSourceUrl(url: string): { owner: string; repo: string; ref: string; path: string } | null {
  const clean = url.trim().replace(/[#?].*$/, '').replace(/\/+$/, '');
  const tree = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/.exec(clean);
  if (tree) {
    const [, owner, repo, ref, path] = tree;
    if (!owner || !repo || !ref) return null;
    return { owner, repo, ref, path: path.replace(/\/+$/, '') };
  }
  const root = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(clean);
  if (root) {
    const [, owner, repo] = root;
    // Reserved paths that are not repositories.
    if (['orgs', 'topics', 'collections', 'sponsors', 'features'].includes(owner.toLowerCase())) return null;
    return { owner, repo: repo.replace(/\.git$/i, ''), ref: '', path: '' };
  }
  return null;
}

/** A folder name we are willing to create. Anything with a separator, a dot-dot,
 *  or a leading dot is rejected outright rather than massaged into safety. */
export function safeSkillDirName(raw: string): string | null {
  const base = raw.trim().split('/').pop() ?? '';
  if (!base || base === '.' || base === '..') return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(base)) return null;
  if (base.includes('..')) return null;
  return base;
}

/**
 * For a repo-ROOT source, find the directory that actually holds the skill
 * BEFORE anything is walked or downloaded (issue #385).
 *
 * A root URL used to mean "the repo root IS the skill" unconditionally, so the
 * installer walked the entire repository — and MAX_FILES / MAX_TOTAL_BYTES,
 * meant to bound one skill folder, were applied to the whole repo. Any normal
 * repo that keeps its skill under `skills/<name>` failed with "larger than this
 * installer will fetch" even when the skill itself was a few KB.
 *
 * Resolution order, each step one directory listing:
 *   1. Root contains SKILL.md → the root is the skill (the well-formed entries).
 *   2. `skills/<name>`, `.claude/skills/<name>`, `<name>` — probed only when
 *      their first segment exists as a directory in the root listing, so the
 *      outcome is fully determined by listings and no blind 404s are issued.
 *   3. Nothing holds a SKILL.md → a structured refusal, before any download.
 *
 * `listDir` is injected (the downloaded archive's index in production) so this policy
 * is testable without the network.
 */
export async function resolveRepoRootSkillDir(
  listDir: (path: string) => Promise<GhEntry[]>,
  entryName: string
): Promise<{ path: string } | { error: string; unsupported?: boolean }> {
  let root: GhEntry[];
  try {
    root = await listDir('');
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const hasSkillMd = (listing: GhEntry[]) =>
    listing.some((it) => it.type === 'file' && it.name === 'SKILL.md');
  if (hasSkillMd(root)) return { path: '' };

  const hasDir = (name: string) => root.some((it) => it.type === 'dir' && it.name === name);
  const name = safeSkillDirName(entryName);
  const candidates = name
    ? [
        ...(hasDir('skills') ? [`skills/${name}`] : []),
        ...(hasDir('.claude') ? [`.claude/skills/${name}`] : []),
        ...(hasDir(name) ? [name] : [])
      ]
    : [];
  for (const candidate of candidates) {
    try {
      if (hasSkillMd(await listDir(candidate))) return { path: candidate };
    } catch {
      // 404 or transient failure on a guess — try the next location.
    }
  }
  return {
    unsupported: true,
    error: "couldn't find the skill's SKILL.md in that repository — open Learn more to install it by hand"
  };
}

/** officialskills.sh pages are a rendering of a GitHub folder and link back to
 *  it. Resolving that link is one request and turns 578 otherwise un-installable
 *  catalog rows into installable ones. */
async function resolveSourceUrl(url: string): Promise<string | null> {
  if (parseGitHubSourceUrl(url)) return url;
  if (!/^https:\/\/(www\.)?officialskills\.sh\//i.test(url)) return null;
  try {
    const html = await getText(url);
    const m = /https:\/\/github\.com\/[^/"'\s]+\/[^/"'\s]+\/tree\/[^"'\s<>)]+/.exec(html);
    return m ? m[0].replace(/[.,)]+$/, '') : null;
  } catch { return null; }
}

/**
 * Download one skill folder into the user's Claude skills directory.
 *
 * One request: the repository's tarball from codeload.github.com (the default
 * branch when the source names no ref), streamed to a temp file, indexed, and
 * only the skill's folder extracted (skillArchive.ts holds the safety rules).
 * No GitHub API call at all for a folder URL, and none for a repo-root URL
 * either: the root's SKILL.md is located in the archive's own index.
 *
 * Returns a structured refusal rather than throwing, so the UI can say WHY —
 * "not installable" and "install failed" are different answers for the user.
 */
export async function installSkill(
  entryUrl: string,
  entryName: string,
  /** The agents' home: the Windows profile, or the distro's on a WSL floor. */
  home: string = homedir(),
  /** Install into this folder instead of <home>/.claude/skills (the office
   *  skill store), under this folder name. */
  into?: { root: string; dir: string },
  limits: SkillLimits = SKILL_LIMITS
): Promise<InstallResult> {
  const source = await resolveSourceUrl(entryUrl);
  if (!source) {
    return { ok: false, unsupported: true, error: 'No downloadable source — open Learn more to install it by hand.' };
  }
  const gh = parseGitHubSourceUrl(source);
  if (!gh) return { ok: false, unsupported: true, error: 'Source is not a GitHub folder.' };

  let tmp: string | null = null;
  let staging: string | null = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'md-skill-'));
    const archive = join(tmp, 'repo.tar.gz');
    // HEAD is the default branch: no guessing between main and master.
    const url = `https://codeload.github.com/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/tar.gz/${gh.ref ? encodeURIComponent(gh.ref) : 'HEAD'}`;
    try {
      await downloadToFile(url, archive, { timeoutMs: 5 * 60_000, maxBytes: MAX_ARCHIVE_BYTES });
    } catch (e) {
      if (e instanceof TooLargeError) {
        return { ok: false, error: `the ${gh.owner}/${gh.repo} download is ${e.size ? `${Math.round(e.size / 1048576)} MB` : `over ${Math.round(e.limit / 1048576)} MB`}; the limit is ${Math.round(e.limit / 1048576)} MB` };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `could not download ${gh.owner}/${gh.repo}: ${msg}` };
    }
    const entries = await indexArchive(archive);

    // A repo-root source names a repository, not necessarily a skill folder —
    // locate the SKILL.md directory first so the limits bound the skill, not
    // the whole repo (issue #385). Tree URLs keep their explicit path.
    let skillPath = gh.path;
    if (!skillPath) {
      const resolved = await resolveRepoRootSkillDir(async (p) => listArchiveDir(entries, p), entryName);
      if ('error' in resolved) return { ok: false, error: resolved.error, unsupported: resolved.unsupported };
      skillPath = resolved.path;
    }

    const plan = planArchiveSkill(entries, skillPath);
    if ('error' in plan) return { ok: false, error: plan.error };
    const over = overLimitMessage(plan, limits);
    if (over) return { ok: false, error: over };

    const dirName = into ? safeSkillDirName(into.dir) : safeSkillDirName(skillPath || entryName);
    if (!dirName) return { ok: false, error: 'That skill has a name this app will not create a folder for.' };
    const root = into ? into.root : join(home, '.claude', 'skills');
    const dest = join(root, dirName);
    if (existsSync(dest)) return { ok: false, error: `Already installed at ${dest}` };

    // Write into staging and move into place only when every file landed, so a
    // mid-extraction failure cannot leave a half-installed skill an agent loads.
    staging = stagingDir(root);
    const { executables } = await extractArchiveSkill(archive, skillPath, staging, limits);
    commitStaging(staging, dest);
    staging = null;
    await restoreExecBits(dest, executables).catch((e) => console.error('[skills] could not mark scripts executable:', e));
    return { ok: true, path: dest, files: plan.files, bytes: plan.bytes, skipped: plan.skipped.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    discard(staging);
    discard(tmp);
  }
}

/**
 * Copy a skill from a folder on this machine (one holding SKILL.md) into the
 * agents' skills directory, under the same rules as a download: regular files
 * and folders only, safe names, the same size limit, staged then moved.
 */
export async function installSkillFromFolder(
  folder: string,
  home: string = homedir(),
  limits: SkillLimits = SKILL_LIMITS
): Promise<InstallResult> {
  if (typeof folder !== 'string' || !folder.trim()) return { ok: false, error: 'no folder given' };
  const src = resolve(folder);
  try {
    if (!statSync(src).isDirectory()) return { ok: false, error: 'That is not a folder.' };
  } catch { return { ok: false, error: 'That folder could not be read.' }; }
  const root = resolve(join(home, '.claude', 'skills'));
  if (src === root || src.startsWith(root + sep)) return { ok: false, error: 'That skill is already in the skills folder.' };

  const plan = planFolderSkill(src, { maxDepth: MAX_FOLDER_DEPTH });
  if ('error' in plan) return { ok: false, error: plan.error };
  const over = overLimitMessage(plan, limits);
  if (over) return { ok: false, error: over };

  let fm: { name?: string } = {};
  try { fm = parseSkillFrontmatter(readFileSync(join(src, 'SKILL.md'), 'utf8')); } catch { /* folder name */ }
  const dirName = (fm.name && safeSkillDirName(fm.name)) || safeSkillDirName(basename(src));
  if (!dirName) return { ok: false, error: 'That skill has a name this app will not create a folder for.' };
  const dest = join(root, dirName);
  if (existsSync(dest)) return { ok: false, error: `Already installed at ${dest}` };

  let staging: string | null = null;
  try {
    staging = stagingDir(root);
    const { executables } = await copyFolderSkill(src, plan.list, staging);
    commitStaging(staging, dest);
    staging = null;
    await restoreExecBits(dest, executables).catch((e) => console.error('[skills] could not mark scripts executable:', e));
    return { ok: true, path: dest, files: plan.files, bytes: plan.bytes, skipped: plan.skipped.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    discard(staging);
  }
}

/**
 * Remove an installed skill. Refuses anything it cannot prove is a skill folder
 * inside a skills root — the failure mode of getting this wrong is deleting a
 * directory of the user's work.
 */
export function uninstallSkill(
  skillPath: string,
  opts: { cwds: string[]; home?: string }
): { ok: true } | { ok: false; error: string } {
  const home = opts.home ?? homedir();
  if (typeof skillPath !== 'string' || !skillPath.trim()) return { ok: false, error: 'no path given' };
  let target: string;
  try { target = resolve(skillPath); } catch { return { ok: false, error: 'unreadable path' }; }

  const roots = [
    join(home, '.claude', 'skills'),
    join(home, '.config', 'opencode', 'plugin'),
    join(home, '.codex', 'plugins'),
    ...opts.cwds.filter(Boolean).flatMap((c) => [
      join(c, '.claude', 'skills'),
      join(c, '.opencode', 'plugin')
    ])
  ].map((r) => resolve(r));

  const root = roots.find((r) => target.startsWith(r + sep));
  if (!root) return { ok: false, error: 'That folder is not inside a skills directory this app manages.' };
  if (target === root) return { ok: false, error: 'refusing to delete the skills directory itself' };
  if (!existsSync(target)) return { ok: false, error: 'Already gone.' };

  // A directory must look like a skill; a plugin entry must be a plain file.
  try {
    const st = statSync(target);
    if (st.isDirectory()) {
      if (!existsSync(join(target, 'SKILL.md'))) {
        return { ok: false, error: 'That folder has no SKILL.md — refusing to delete it.' };
      }
    } else if (!st.isFile()) {
      return { ok: false, error: 'Not a file or folder this app will remove.' };
    }
  } catch { return { ok: false, error: 'could not inspect that path' }; }

  try {
    rmSync(target, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
