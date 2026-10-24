/**
 * Ordering and ticket search for the Deliverables list. Pure: the view picks
 * how to group (deliverableOrganize.ts) and this orders the files inside.
 * Author and ticket are not orders any more: they are views (by agent, by task).
 */

export type DeliverableSort = 'recent' | 'oldest' | 'name' | 'type';
export const DELIVERABLE_SORTS: DeliverableSort[] = ['recent', 'oldest', 'name', 'type'];

export interface SortItem { name: string; ts?: number }

const ext = (n: string): string => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

/** A query that is a ticket key ("DUN-12"): match that ticket exactly, not
 *  every ticket that contains it (DUN-120). */
export function ticketQuery(q: string): string | null {
  const s = q.trim().toLowerCase();
  return /^[a-z][a-z0-9]*-\d+$/.test(s) ? s : null;
}

/** The comparator for the order the human picked. */
export function compareDeliverables(sort: DeliverableSort): (a: SortItem, b: SortItem) => number {
  return (a, b) => {
    switch (sort) {
      case 'oldest': return (a.ts ?? 0) - (b.ts ?? 0);
      case 'name': return a.name.localeCompare(b.name, undefined, { numeric: true });
      case 'type': return ext(a.name).localeCompare(ext(b.name)) || a.name.localeCompare(b.name, undefined, { numeric: true });
      default: return (b.ts ?? 0) - (a.ts ?? 0);
    }
  };
}
