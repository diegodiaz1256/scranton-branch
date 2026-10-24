/**
 * Which agents an installed skill reaches, for the Skills page.
 *
 * Where a skill sits decides who loads it, the same rule the CLIs apply:
 *   - user scope (~/.claude/skills, the distro's on a WSL floor) and the
 *     skills that ship with the app reach every agent of that CLI;
 *   - project scope (<repo>/.claude/skills) reaches only the agents working
 *     in that repo (its folder or a worktree inside it).
 * A skill belongs to one CLI (Claude Code reads SKILL.md folders; OpenCode
 * and Codex have plugin folders), so an agent of another CLI never counts.
 *
 * Paths are compared with the guard's normPath: on a WSL floor the app lists
 * a skill as \\wsl.localhost\<distro>\home\... while the agent's folder is
 * /home/..., and both name the same place.
 *
 * Pure, for tests.
 */
import { normPath } from './toolGuard';

export { normPath };

export interface ReachAgent { id: string; provider?: string; cwd?: string; worktreePath?: string; archived?: boolean }
export interface ReachSkill { provider: string; scope: 'user' | 'project' | 'bundled'; path: string }

/** `<root>/.claude/skills/<name>` (or `<root>/.opencode/plugin/<name>`) → `<root>`. */
export function projectRootOf(skillPath: string): string {
  return normPath(skillPath).split('/').slice(0, -3).join('/') || '/';
}

const inside = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);

/** The agents (live ones) that load `skill`, and whether that is all of this CLI's. */
export function skillReach(skill: ReachSkill, agents: readonly ReachAgent[]): { everyone: boolean; agents: string[] } {
  const same = agents.filter((a) => !a.archived && (a.provider ?? 'claude') === skill.provider);
  if (skill.scope !== 'project') return { everyone: true, agents: same.map((a) => a.id) };
  const root = projectRootOf(skill.path);
  return {
    everyone: false,
    agents: same.filter((a) => [a.cwd, a.worktreePath].some((p) => !!p && inside(normPath(p), root))).map((a) => a.id)
  };
}
