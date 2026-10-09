// Mirrors docs/contracts.md (draft for S01). Keep in sync until packages/contracts exists.

export type Action = 'wait' | 'turn' | 'continue' | 'arrived' | 'stop';
export type Direction = 'left' | 'right' | 'around' | null;
export type Phase = 'awaiting_destination' | 'navigating' | 'arrived' | 'stopped';
export type StopReason = 'user_stop' | 'voice_cancel' | 'arrived' | 'error';

export interface SessionInfo {
  sessionId: string;
  sessionToken: string;
  generation: number;
  serverTime: number;
  phase: Phase;
  route: {
    routeId: string;
    startStepId: string;
    destinations: { destinationId: string; label: string }[];
  };
  limits: {
    maxAudioMs: number;
    maxAudioBytes: number;
    maxFrameBytes: number;
    maxFrameEdgePx: number;
    maxInputAgeMs: number;
    heartbeatMs: number;
  };
}

interface Envelope {
  eventId: string;
  sessionId: string;
  generation: number;
  requestId: string | null;
  emittedAt: number;
}

export type ServerEvent = Envelope &
  (
    | { type: 'state'; phase: Phase; routeStepId: string; destinationId: string | null }
    | { type: 'needs_input'; reason: 'empty' | 'unsupported' | 'unclear'; text: string }
    | {
        type: 'guidance';
        guidanceId: string;
        text: string;
        action: Action;
        direction: Direction;
        routeStepId: string;
        nextRouteStepId: string | null;
        uncertain: boolean;
      }
    | { type: 'heartbeat'; phase: Phase; routeStepId: string; lastRequestId: string | null; quietReason: string | null }
    | { type: 'stop'; reason: StopReason }
    | { type: 'error'; code: string; stage: string; text: string; retryable: boolean }
  );

export interface UtteranceInput {
  requestId: string;
  generation: number;
  sequence: number;
  /** Fixture or browser-STT text. Audio capture lands with S02. */
  transcript: string;
}

/** The phone's only view of the orchestrator. Implemented by the mock and by the HTTP client. */
export interface OrchestratorApi {
  createSession(): Promise<SessionInfo>;
  subscribe(session: SessionInfo, onEvent: (event: ServerEvent) => void): () => void;
  sendUtterance(session: SessionInfo, input: UtteranceInput): Promise<void>;
  stop(session: SessionInfo, requestId: string, generation: number): Promise<void>;
}

export type SpeechResult = 'finished' | 'cancelled' | 'failed';

export interface SpeechAdapter {
  initializeAfterUserGesture(): void;
  speak(text: string): Promise<SpeechResult>;
  stop(): void;
}
