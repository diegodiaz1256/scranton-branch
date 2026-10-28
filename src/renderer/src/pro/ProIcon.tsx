/**
 * Pro's sidebar icons: thin strokes on a 16 box in `currentColor`, so they follow
 * the theme like text does. The pixel set (components/Icon.tsx) stays the Classic
 * identity; next to Pro's hairline cards and system type it read as noise.
 */
export type ProIconName =
  | 'now' | 'tasks' | 'inbox' | 'deliverables' | 'automations' | 'memory' | 'skills' | 'capabilities' | 'connections' | 'environment' | 'privacy' | 'providers' | 'mcp' | 'team' | 'factories' | 'agents' | 'temps';

const PATHS: Record<ProIconName, string> = {
  // a pulse line
  now: 'M1.5 8.5h3l1.6-4.5 3 9 1.6-4.5h3.8',
  // a checklist: three rows, the first two ticked
  tasks: 'M2.5 4.2l1 1 1.8-2 M7.5 4.5H13.5 M2.5 8.2l1 1 1.8-2 M7.5 8.5H13.5 M3 12.5h1.5 M7.5 12.5H13.5',
  // a tray with the dip in the middle
  inbox: 'M2.5 9.5h3l1 1.8h3l1-1.8h3 M2.5 9.5l1.6-5.5h7.8l1.6 5.5v3.5h-11z',
  // a bolt
  automations: 'M9 1.8L3.8 9h3.9L7 14.2 12.2 7H8.3z',
  // a spark of four points and a small one
  memory: 'M7 2.5c.4 2.6 1.4 3.6 4 4-2.6.4-3.6 1.4-4 4-.4-2.6-1.4-3.6-4-4 2.6-.4 3.6-1.4 4-4z M12.2 10.5c.2 1 .6 1.4 1.6 1.6-1 .2-1.4.6-1.6 1.6-.2-1-.6-1.4-1.6-1.6 1-.2 1.4-.6 1.6-1.6z',
  // an open book: instructions an agent reads when a task calls for them
  skills: 'M8 4.2C6.6 3 4.7 2.7 2 3v9.5c2.7-.3 4.6 0 6 1.2 1.4-1.2 3.3-1.5 6-1.2V3c-2.7-.3-4.6 0-6 1.2z M8 4.2v9.5',
  // a puzzle piece
  capabilities: 'M3 5.5h2.2a1.3 1.3 0 1 1 2.6 0H10v2.3a1.3 1.3 0 1 1 0 2.6V13H3z M10 5.5h3v3',
  // two links of a chain
  connections: 'M6.8 9.2l2.4-2.4 M7.6 4.6l1.3-1.3a2.4 2.4 0 0 1 3.4 3.4L11 8 M8.4 11.4l-1.3 1.3a2.4 2.4 0 0 1-3.4-3.4L5 8',
  // two people
  agents: 'M6 7.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z M2 13c.3-2.4 1.9-3.8 4-3.8s3.7 1.4 4 3.8 M10.6 3.2a2 2 0 0 1 0 3.9 M12 9.4c1.2.4 1.9 1.6 2 3.6',
  // two buildings: your office and theirs
  team: 'M2 14V5.5L6 3v11 M6 14V7.5h4.5V14 M10.5 14V4.5L14 6.5V14 M1.5 14h13',
  // a plug: tool servers
  mcp: 'M5.5 2v3 M10.5 2v3 M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0z M8 12v2.5',
  // a key: secrets the agents use but never see
  // a padlock
  privacy: 'M4 7.5h8v6.5H4z M5.6 7.5V5.4a2.4 2.4 0 0 1 4.8 0v2.1 M8 10v1.6',
  environment: 'M5.5 10.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6z M8.3 8.6L14 8.6 M12 8.6v2.2 M14 8.6v1.6',
  // a document with a folded corner
  deliverables: 'M4 1.8h5.5L12.5 4.8V14.2H4z M9.5 1.8v3h3 M6 8h4.5 M6 10.5h4.5 M6 13h2.5',
  // a chip: the model behind the agent
  providers: 'M4.5 4.5h7v7h-7z M6.8 6.8h2.4v2.4H6.8z M6.5 2.5v2 M9.5 2.5v2 M6.5 11.5v2 M9.5 11.5v2 M2.5 6.5h2 M2.5 9.5h2 M11.5 6.5h2 M11.5 9.5h2',
  // a factory: saw-tooth roof and a chimney
  factories: 'M1.5 14V8l3.5-2.5V8l3.5-2.5V8l3.5-2.5V14z M12 5.5V2.5h1.5V14 M4 11h1.5 M7.5 11H9 M1 14h14',
  // a clock
  temps: 'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M8 4.8V8l2.2 1.4'
};

export function ProIcon({ name }: { name: ProIconName }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={{ flexShrink: 0 }}>
      <path d={PATHS[name]} />
    </svg>
  );
}
