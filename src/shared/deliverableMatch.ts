/**
 * Is a path an agent printed one of the office's deliverables? Terminal links
 * use it: a click on a deliverable opens it in Deliverables, anything else in
 * the IDE as before. Pure, so node:test can load it.
 *
 * An agent on a WSL floor prints Linux paths (/home/u/offices/x/hive/research/
 * a.md), a relative one from its folder (research/a.md), or the Windows form
 * (\\wsl.localhost\Ubuntu\… or \\wsl$\Ubuntu\…); all are the same file.
 */
import { hostPath } from './deliverables';

/** Host form; a UNC path (either slash) is one already, not a Linux path. */
const toHost = (p: string, distro: string | null): string => (/^[\\/]{2}/.test(p) ? p : hostPath(p, distro));

/** Host form with '/' separators and no `.`/`..`; case kept. */
function normal(p: string, distro: string | null): string {
  const h = toHost(p.trim(), distro).replace(/\\/g, '/');
  const unc = h.startsWith('//');
  const parts: string[] = [];
  for (const seg of h.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (parts.length > (unc ? 2 : 1)) parts.pop(); continue; }
    parts.push(seg);
  }
  // \\wsl$\ is the older name of \\wsl.localhost\.
  return ((unc ? '//' : h.startsWith('/') ? '/' : '') + parts.join('/')).replace(/^\/\/wsl\$\//i, '//wsl.localhost/');
}

/** One spelling per file: host form, '/' separators, no `.`/`..`, no case. */
export function deliverableKey(p: string, distro: string | null = null): string {
  return normal(p, distro).toLowerCase();
}

export interface DeliverableIndex {
  /** The office's research/ folder (host form). */
  researchDir: string;
  /** The floor's distro, when its agents run in WSL. */
  distro: string | null;
  /** Other files the list shows: linked from tasks, written elsewhere. */
  known: string[];
}

/** The clicked path (absolute, or relative to `cwd`) as the deliverable it
 *  is, spelled the way the list spells it; null when it is not one. */
export function matchDeliverable(clicked: string, index: DeliverableIndex, cwd?: string): string | null {
  const raw = clicked.trim();
  if (!raw) return null;
  const absolute = raw.startsWith('/') || raw.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(raw);
  if (!absolute && !cwd) return null;
  const full = normal(absolute ? raw : `${cwd!.replace(/[\\/]+$/, '')}/${raw}`, index.distro);
  const key = full.toLowerCase();
  const research = deliverableKey(index.researchDir, index.distro);
  // research/hires/ holds hire proposals, which the list leaves out.
  if (key.startsWith(`${research}/`) && !key.startsWith(`${research}/hires/`)) {
    // Under the research folder as the list names it (its separators, its case).
    const dir = index.researchDir.replace(/[\\/]+$/, '');
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir + sep + full.slice(research.length + 1).split('/').join(sep);
  }
  return index.known.find((k) => deliverableKey(k, index.distro) === key) ?? null;
}
