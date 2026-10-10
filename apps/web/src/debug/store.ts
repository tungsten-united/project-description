import type { DebugLogger, LogLevel } from '../session/debugLog';
import { describePhoneEvent, describeServerEntry, type Line, type TimelineLine } from './timeline';
import type { FrameInput, Motion, OrchestratorApi, UserInput } from '../session/types';

export interface LogLine {
  id: number;
  at: number;
  level: LogLevel;
  event: string;
  detail?: string;
}

/** One request the phone sent, kept for inspection. Blobs are shown through object URLs. */
export interface PayloadRecord {
  id: number;
  at: number;
  kind: 'input' | 'frame';
  meta: Record<string, unknown>;
  audioBytes: number | null;
  frameBytes: number | null;
  audioUrl: string | null;
  frameUrl: string | null;
}

export interface DebugState {
  logs: LogLine[];
  payloads: PayloadRecord[];
  motion: Motion | null;
  /** While paused, frames are not sent. Voice inputs are never held back. */
  paused: boolean;
  /** Frames dropped while paused. */
  heldBack: number;
  /** The session timeline, oldest first. Cleared on every Start. */
  timeline: TimelineLine[];
  /** Local epoch ms of the last Start, or null before the first one. */
  sessionStart: number | null;
  /** Whether the orchestrator is streaming its trace (it only does in debug mode). */
  serverTrace: 'waiting' | 'streaming';
}

const MAX_LOGS = 200;
const MAX_PAYLOADS = 8;
const MAX_TIMELINE = 800;

export interface DebugStore {
  get(): DebugState;
  subscribe(listener: () => void): () => void;
  log(level: LogLevel, event: string, detail?: string): void;
  setMotion(motion: Motion | null): void;
  setPaused(paused: boolean): void;
  addPayload(record: Omit<PayloadRecord, 'id' | 'at'>): void;
  /** A line from this phone. `start` clears the timeline and begins a new session. */
  addPhoneEvent(level: LogLevel, event: string, detail?: string): void;
  /** Lines from one trace entry the orchestrator streamed. */
  addServerEntry(entry: Record<string, unknown>): void;
  clearTimeline(): void;
  countHeldBack(): void;
}

export function createDebugStore(): DebugStore {
  let state: DebugState = {
    logs: [],
    payloads: [],
    motion: null,
    paused: false,
    heldBack: 0,
    timeline: [],
    sessionStart: null,
    serverTrace: 'waiting',
  };
  let nextId = 1;
  const listeners = new Set<() => void>();
  const set = (next: DebugState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    log(level, event, detail) {
      const line: LogLine = { id: nextId++, at: Date.now(), level, event, detail };
      set({ ...state, logs: [...state.logs, line].slice(-MAX_LOGS) });
    },
    setMotion(motion) {
      set({ ...state, motion });
    },
    setPaused(paused) {
      set({ ...state, paused, heldBack: paused ? state.heldBack : 0 });
    },
    addPayload(record) {
      const next = [{ ...record, id: nextId++, at: Date.now() }, ...state.payloads];
      for (const dropped of next.slice(MAX_PAYLOADS)) {
        if (dropped.audioUrl) URL.revokeObjectURL(dropped.audioUrl);
        if (dropped.frameUrl) URL.revokeObjectURL(dropped.frameUrl);
      }
      set({ ...state, payloads: next.slice(0, MAX_PAYLOADS) });
    },
    countHeldBack() {
      set({ ...state, heldBack: state.heldBack + 1 });
    },
    addPhoneEvent(level, event, detail) {
      const now = Date.now();
      const base = event === 'start' ? { ...state, timeline: [], sessionStart: now, serverTrace: 'waiting' as const } : state;
      const line: TimelineLine = { ...describePhoneEvent(level, event, detail), id: nextId++, at: now };
      set({ ...base, timeline: [...base.timeline, line].slice(-MAX_TIMELINE) });
    },
    addServerEntry(entry) {
      const now = Date.now();
      const lines: TimelineLine[] = describeServerEntry(entry).map((l: Line) => ({ ...l, id: nextId++, at: now }));
      set({ ...state, serverTrace: 'streaming', timeline: [...state.timeline, ...lines].slice(-MAX_TIMELINE) });
    },
    clearTimeline() {
      set({ ...state, timeline: [], sessionStart: Date.now() });
    },
  };
}

/** Writes every log line to the store as well as to the remote logger. */
export function teeLogger(remote: DebugLogger, store: DebugStore): DebugLogger {
  return {
    log(level, event, detail) {
      store.log(level, event, detail);
      store.addPhoneEvent(level, event, detail);
      remote.log(level, event, detail);
    },
    local(level, event, detail) {
      store.addPhoneEvent(level, event, detail);
    },
    setClientId: (id) => remote.setClientId(id),
    flush: () => remote.flush(),
  };
}

/**
 * Wraps the API so the panel can show what is sent, the server's trace entries, and pause the frame stream.
 * The recorded meta is what the phone built, before the HTTP client converts times to server time.
 */
export function withInspection(api: OrchestratorApi, store: DebugStore): OrchestratorApi {
  return {
    ...api,
    subscribe(client, onEvent) {
      return api.subscribe(client, (event) => {
        if (event.type === 'log') {
          store.log(event.entry.error ? 'error' : 'info', `server ${event.kind}`, JSON.stringify(event.entry));
          store.addServerEntry(event.entry);
        }
        onEvent(event);
      });
    },
    sendInput(client, input: UserInput) {
      const { audio, frame, ...meta } = input;
      store.addPayload({
        kind: 'input',
        meta,
        audioBytes: audio.size,
        frameBytes: frame?.size ?? null,
        audioUrl: URL.createObjectURL(audio),
        frameUrl: frame ? URL.createObjectURL(frame) : null,
      });
      return api.sendInput(client, input);
    },
    sendFrame(client, input: FrameInput) {
      if (store.get().paused) {
        store.countHeldBack();
        return Promise.resolve();
      }
      const { frame, ...meta } = input;
      store.addPayload({
        kind: 'frame',
        meta,
        audioBytes: null,
        frameBytes: frame.size,
        audioUrl: null,
        frameUrl: URL.createObjectURL(frame),
      });
      return api.sendFrame(client, input);
    },
  };
}
