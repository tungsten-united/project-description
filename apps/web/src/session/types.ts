// Mirrors docs/contracts.md. Keep in sync until packages/contracts exists.

export type Action = 'wait' | 'turn' | 'continue' | 'arrived' | 'stop';
export type Direction = 'left' | 'right' | 'around' | null;
export type Phase = 'awaiting_destination' | 'navigating' | 'arrived' | 'stopped';
export type StopReason = 'user_stop' | 'voice_cancel' | 'arrived' | 'error';

export interface Limits {
  maxAudioMs: number;
  maxAudioBytes: number;
  maxFrameBytes: number;
  maxFrameEdgePx: number;
  maxInputAgeMs: number;
  heartbeatMs: number;
  navFrames: number;
}

/** Response of `POST /v1/clients`: one phone from Start to Stop. */
export interface ClientInfo {
  clientId: string;
  clientToken: string;
  generation: number;
  serverTime: number;
  phase: Phase;
  route: {
    routeId: string;
    startStepId: string;
    destinations: { destinationId: string; label: string }[];
  };
  limits: Limits;
}

interface Envelope {
  eventId: string;
  clientId: string;
  /** Null until the user has said a destination. */
  sessionId: string | null;
  generation: number;
  requestId: string | null;
  emittedAt: number;
}

export type ServerEvent = Envelope &
  (
    | { type: 'state'; phase: Phase; destinationId: string | null; routeStepId: string | null }
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
    | { type: 'heartbeat'; lastRequestId: string | null; quietReason: string | null }
    | { type: 'stop'; reason: StopReason }
    | { type: 'error'; code: string; stage: string; text: string; retryable: boolean }
  );

export interface UtteranceInput {
  requestId: string;
  generation: number;
  sequence: number;
  /** Local `Date.now()` when the recording ended. The client converts it to server time. */
  capturedAt: number;
  audio: Blob;
  frame: Blob | null;
}

export interface FrameInput {
  requestId: string;
  generation: number;
  sequence: number;
  capturedAt: number;
  frame: Blob;
  clientRouteStepId: string | null;
}

/** The phone's only view of the orchestrator. Implemented by the mock and by the HTTP client. */
export interface OrchestratorApi {
  createClient(): Promise<ClientInfo>;
  subscribe(client: ClientInfo, onEvent: (event: ServerEvent) => void): () => void;
  sendUtterance(client: ClientInfo, input: UtteranceInput): Promise<void>;
  sendFrame(client: ClientInfo, input: FrameInput): Promise<void>;
  stop(client: ClientInfo, requestId: string, generation: number): Promise<void>;
  /** URL that streams the spoken text as audio, or null when the backend has none (demo mode). */
  speechUrl(client: ClientInfo, text: string): string | null;
}

export type SpeechResult = 'finished' | 'cancelled' | 'failed';

export interface SpeechAdapter {
  initializeAfterUserGesture(): void;
  /** Tells the adapter where to fetch audio for this client. Null clears it. */
  setSource?(urlFor: ((text: string) => string | null) | null): void;
  speak(text: string): Promise<SpeechResult>;
  stop(): void;
}

export type CaptureErrorCode = 'permission_denied' | 'unavailable';

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Microphone and camera. Phone browsers only grant them after a tap, so acquire() runs inside Start. */
export interface Capture {
  acquire(): Promise<void>;
  startRecording(): void;
  stopRecording(): Promise<Blob | null>;
  grabFrame(): Promise<Blob | null>;
  release(): void;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}
