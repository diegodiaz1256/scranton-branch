/**
 * Hiring in plain language (Easy mode). The hire dialog asks "what do you want
 * it for?" and offers a few roles. Each role fills the agent's description and
 * standing goal. The engine defaults to Claude Code with Sonnet 5.5, and the
 * engine and model pickers move under "Advanced".
 *
 * The description and goal stay in English because they become the agent's
 * prompt. Only the role labels shown to the user are translated
 * (`addAgent.easy.role_<id>`).
 *
 * Pure (no Electron, no React): the dialog and the tests share it.
 */

export type EasyHireRole = 'research' | 'writing' | 'organizing' | 'coding' | 'other';

export interface EasyHireRoleDef {
  id: EasyHireRole;
  /** One-line role, written to the agent's description. Empty for "other". */
  description: string;
  /** Standing goal, written to the agent's goal. Empty for "other". */
  goal: string;
}

export const EASY_HIRE_ROLES: readonly EasyHireRoleDef[] = [
  {
    id: 'research',
    description: 'researches questions and writes clear summaries',
    goal: 'Research the questions you are given across reliable sources, check the key facts, and reply with a short, plain-language summary that names its sources.'
  },
  {
    id: 'writing',
    description: 'drafts, edits and proofreads documents',
    goal: 'Draft, edit and proofread the documents you are asked for. Match the requested tone, keep the text clear and short, and save each finished piece as a file in the project folder.'
  },
  {
    id: 'organizing',
    description: 'sorts and tidies files, spreadsheets and data',
    goal: 'Organize the files and data you are pointed at: sort, rename, clean up and summarize them. Never delete anything without asking first, and explain in plain words what you changed.'
  },
  {
    id: 'coding',
    description: 'builds and fixes software',
    goal: 'Build the features and fix the bugs you are asked for in this project. Make small, tested changes and explain each one in plain language.'
  },
  { id: 'other', description: '', goal: '' }
];

/** The engine an Easy-mode hire starts with: Claude Code on Sonnet 5.5. */
export const EASY_HIRE_ENGINE = { provider: 'claude', model: 'claude-sonnet-5-5' } as const;

export function easyHireRole(id: EasyHireRole): EasyHireRoleDef {
  return EASY_HIRE_ROLES.find((r) => r.id === id) ?? EASY_HIRE_ROLES[EASY_HIRE_ROLES.length - 1];
}
