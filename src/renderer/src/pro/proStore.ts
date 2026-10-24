import { create } from 'zustand';

/**
 * Pro layout state — kept out of the main store on purpose: the Classic floor
 * never reads it, and the main store's persistence rules (roster mirrors,
 * origin partitioning) don't apply to two UI preferences.
 */

export type ProSection = 'now' | 'tasks' | 'inbox' | 'deliverables' | 'automations' | 'memory' | 'skills' | 'capabilities' | 'connections' | 'environment' | 'providers' | 'mcp' | 'team' | 'factories' | 'agents' | 'temps';
export type ProView = { kind: 'section'; section: ProSection } | { kind: 'agent'; agentId: string };
export type Layout = 'classic' | 'pro';

const LS_LAYOUT = 'cth.layout';
const LS_VIEW = 'cth.proView';

function readLayout(): Layout {
  try { return window.localStorage.getItem(LS_LAYOUT) === 'pro' ? 'pro' : 'classic'; } catch { return 'classic'; }
}

function readView(): ProView {
  try {
    const raw = JSON.parse(window.localStorage.getItem(LS_VIEW) ?? 'null') as ProView | null;
    if (raw?.kind === 'section' && typeof raw.section === 'string') return raw;
    if (raw?.kind === 'agent' && typeof raw.agentId === 'string') return raw;
  } catch { /* fall through */ }
  return { kind: 'section', section: 'agents' };
}

interface ProState {
  layout: Layout;
  view: ProView;
  setLayout: (layout: Layout) => void;
  setView: (view: ProView) => void;
  /** Deliverables opened from a task: show that task's only (null = all). Not persisted. */
  focusTask: string | null;
  setFocusTask: (taskId: string | null) => void;
}

export const useProStore = create<ProState>((set) => ({
  layout: readLayout(),
  view: readView(),
  setLayout: (layout) => {
    try { window.localStorage.setItem(LS_LAYOUT, layout); } catch { /* noop */ }
    set({ layout });
  },
  setView: (view) => {
    try { window.localStorage.setItem(LS_VIEW, JSON.stringify(view)); } catch { /* noop */ }
    set({ view });
  },
  focusTask: null,
  setFocusTask: (focusTask) => set({ focusTask })
}));
