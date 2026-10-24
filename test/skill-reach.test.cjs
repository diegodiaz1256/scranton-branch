'use strict';

/**
 * "Used by" on the Skills page (src/shared/skillReach.ts): which agents load
 * an installed skill. A wrong answer here tells the user an agent has a skill
 * it never sees, or hides one that it does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { skillReach, projectRootOf } = loadTs('src/shared/skillReach.ts');

const agents = [
  { id: 'god', cwd: 'C:\\Users\\me\\offices\\main' },
  { id: 'web', provider: 'claude', cwd: 'G:\\Code\\Shop' },
  { id: 'wt', provider: 'claude', cwd: 'G:\\code\\shop\\.worktrees\\agent-wt' },
  { id: 'api', provider: 'claude', cwd: 'G:\\Code\\Shop-api' },
  { id: 'cdx', provider: 'codex', cwd: 'G:\\Code\\Shop' },
  { id: 'gone', provider: 'claude', cwd: 'G:\\Code\\Shop', archived: true }
];

test('a user-scope skill reaches every live agent of its CLI, and only those', () => {
  assert.deepEqual(
    skillReach({ provider: 'claude', scope: 'user', path: 'C:\\Users\\me\\.claude\\skills\\pdf' }, agents),
    { everyone: true, agents: ['god', 'web', 'wt', 'api'] }
  );
  assert.deepEqual(
    skillReach({ provider: 'codex', scope: 'user', path: 'C:\\Users\\me\\.codex\\plugins\\x' }, agents),
    { everyone: true, agents: ['cdx'] }
  );
});

test('a project skill reaches the agents in that repo, worktrees included, not a sibling with a shared prefix', () => {
  const r = skillReach({ provider: 'claude', scope: 'project', path: 'G:\\Code\\Shop\\.claude\\skills\\deploy' }, agents);
  assert.deepEqual(r, { everyone: false, agents: ['web', 'wt'] });
});

test('Linux paths keep their case; Windows drive paths fold it', () => {
  assert.equal(projectRootOf('/home/me/repo/.claude/skills/x'), '/home/me/repo');
  const linux = [{ id: 'a', cwd: '/home/me/Repo' }, { id: 'b', cwd: '/home/me/repo' }];
  assert.deepEqual(skillReach({ provider: 'claude', scope: 'project', path: '/home/me/repo/.claude/skills/x' }, linux).agents, ['b']);
});

test('on a WSL floor the share path the app lists and the distro path the agent works in are one place', () => {
  const floor = [{ id: 'w', cwd: '/home/zeroge/shop' }, { id: 'x', cwd: '/home/zeroge/Shop' }];
  const skill = { provider: 'claude', scope: 'project', path: '\\\\wsl.localhost\\Ubuntu\\home\\zeroge\\shop\\.claude\\skills\\deploy' };
  assert.deepEqual(skillReach(skill, floor), { everyone: false, agents: ['w'] });
});
