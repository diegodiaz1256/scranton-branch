/**
 * Offline talk with the orchestrator: no OpenAI key, nothing leaves the machine
 * except the message itself, which goes to the orchestrator like a typed one.
 *
 *   talk → record → transcribe on this machine (local Whisper, the model from
 *   Settings → Voice) → sent to the orchestrator → its reply, which arrives on
 *   its Stop hook (Claude's last_assistant_message), is read aloud with the
 *   system's own voices (main/speak.ts; offline on Windows, macOS and Linux).
 *
 * A module-level singleton like the realtime session, so the agent card and the
 * fullscreen terminal show the same state.
 */
import { useSyncExternalStore } from 'react';
import i18n from '@/i18n';
import { freeflowRecorder } from '@/freeflow/recorder';

export type LocalTalkStatus = 'off' | 'listening' | 'transcribing' | 'waiting' | 'speaking';
export interface LocalTalkState { status: LocalTalkStatus; error: string | null }

/** Longest wait for the orchestrator's reply before giving up the turn. */
const WAIT_MS = 10 * 60_000;

let state: LocalTalkState = { status: 'off', error: null };
const subs = new Set<() => void>();
let godId: string | null = null;
let waitTimer: ReturnType<typeof setTimeout> | null = null;
let unhook: (() => void) | null = null;

function set(patch: Partial<LocalTalkState>): void {
  state = { ...state, ...patch };
  for (const fn of subs) fn();
}

/** Spoken text: no markdown markers, no code, links as their text. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|\*|_|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1500);
}

function speak(text: string): void {
  const words = speakable(text);
  if (!words) { set({ status: 'off' }); return; }
  set({ status: 'speaking', error: null });
  void window.cth.voiceSpeak(words, i18n.language || 'en').then((r) => {
    if (state.status !== 'speaking') return;
    set({ status: 'off', error: r.ok ? null : (r.error ?? 'could not speak') });
  }, () => { if (state.status === 'speaking') set({ status: 'off' }); });
}

function clearWait(): void {
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
}

function ensureHook(): void {
  if (unhook) return;
  unhook = window.cth.onHiveHookEvent((e) => {
    if (state.status !== 'waiting' || !godId || e.agentId !== godId || e.event !== 'Stop' || e.blocked) return;
    clearWait();
    if (e.reply) speak(e.reply);
    else set({ status: 'off' });
  });
}

/** One button: start listening; stop and send; or stop waiting / speaking. */
function toggle(agentId: string): void {
  if (state.status === 'off') {
    godId = agentId;
    ensureHook();
    set({ status: 'listening', error: null });
    void freeflowRecorder.start(agentId, {
      send: true,
      local: true,
      onSent: (r) => {
        if (!r.ok) { set({ status: 'off', error: r.error ?? 'transcription failed' }); return; }
        set({ status: 'waiting' });
        clearWait();
        waitTimer = setTimeout(() => { if (state.status === 'waiting') set({ status: 'off' }); }, WAIT_MS);
      }
    });
    // The mic could not open: the recorder says so and stays idle.
    setTimeout(() => {
      const fs = freeflowRecorder.getSnapshot();
      if (state.status === 'listening' && fs.status === 'idle' && fs.error) set({ status: 'off', error: fs.error });
    }, 1500);
    return;
  }
  if (state.status === 'listening') { set({ status: 'transcribing' }); freeflowRecorder.stop(); return; }
  if (state.status === 'speaking') { void window.cth.voiceStopSpeaking(); set({ status: 'off' }); return; }
  if (state.status === 'waiting') { clearWait(); set({ status: 'off' }); }
}

export const localTalk = {
  toggle,
  getSnapshot: (): LocalTalkState => state,
  subscribe: (fn: () => void): (() => void) => { subs.add(fn); return () => subs.delete(fn); }
};

export function useLocalTalk(): LocalTalkState {
  return useSyncExternalStore(localTalk.subscribe, localTalk.getSnapshot, localTalk.getSnapshot);
}
