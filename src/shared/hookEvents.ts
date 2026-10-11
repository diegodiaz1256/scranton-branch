/** Renderer-facing hook event shared across the Electron IPC boundary. */
export interface HookEvent {
  agentId?: string;
  event: string;
  tool?: string;
  notificationType?: string;
  source?: string;
  message?: string;
  blocked?: boolean;
  /** What the tool was asked to do (redacted), or the prompt text. For the steps timeline. */
  detail?: string;
  /** epoch ms the event reached the app. */
  ts?: number;
  /** Files this tool call writes, absolute (any CLI: Write, apply_patch, write_to_file…). */
  files?: string[];
  /** Stop: the agent's last reply (redacted, short), e.g. to read it aloud. */
  reply?: string;
}

const OPTIONAL_STRING_FIELDS = ['tool', 'notificationType', 'source', 'message', 'detail', 'reply'] as const;

/** Validate an untrusted payload before it crosses the Electron IPC boundary. */
export function validateHookEvent(value: unknown): value is HookEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.event !== 'string' || candidate.event.length === 0) return false;
  if (
    candidate.agentId !== undefined &&
    (typeof candidate.agentId !== 'string' || candidate.agentId.length === 0)
  ) return false;

  for (const field of OPTIONAL_STRING_FIELDS) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') return false;
  }

  if (candidate.ts !== undefined && typeof candidate.ts !== 'number') return false;
  if (candidate.files !== undefined && !(Array.isArray(candidate.files) && candidate.files.length <= 50 && candidate.files.every((f) => typeof f === 'string'))) return false;
  return candidate.blocked === undefined || typeof candidate.blocked === 'boolean';
}
