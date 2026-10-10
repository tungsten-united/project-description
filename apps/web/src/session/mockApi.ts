import type { ClientInfo, OrchestratorApi, ServerEvent } from './types';

const GUIDANCE = [
  { text: 'Wait a moment.', action: 'wait', direction: null },
  { text: 'Turn left.', action: 'turn', direction: 'left' },
  { text: 'Keep going straight.', action: 'continue', direction: null },
  { text: 'You have arrived at the coffee counter.', action: 'arrived', direction: null },
] as const;

type Listener = (event: ServerEvent) => void;

/** In-browser stand-in for the orchestrator so the shell runs without a backend. Scripted, not AI. */
export function createMockApi(stepMs = 2500): OrchestratorApi {
  let generation = 1;
  let listener: Listener | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let counter = 0;
  const clientId = 'mock-client';
  let sessionId: string | null = null;

  const emit = (partial: Record<string, unknown>) => {
    counter += 1;
    listener?.({
      eventId: `mock-${counter}`,
      clientId,
      sessionId,
      generation,
      requestId: null,
      emittedAt: Date.now(),
      ...partial,
    } as ServerEvent);
  };
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };

  return {
    async createClient(): Promise<ClientInfo> {
      generation = 1;
      sessionId = null;
      return {
        clientId,
        clientToken: 'mock',
        generation,
        serverTime: Date.now(),
        phase: 'awaiting_destination',
        route: {
          routeId: 'itnig-demo',
          startStepId: 'start',
          destinations: [
            { destinationId: 'counter', label: 'coffee counter' },
            { destinationId: 'bathroom', label: 'bathroom' },
          ],
        },
        limits: {
          maxAudioMs: 10000,
          maxAudioBytes: 1_000_000,
          maxFrameBytes: 512_000,
          maxFrameEdgePx: 1280,
          maxInputAgeMs: 3000,
          heartbeatMs: 5000,
          navFrames: 5,
        },
      };
    },
    subscribe(_client, onEvent) {
      listener = onEvent;
      return () => {
        listener = null;
        clear();
      };
    },
    async sendUtterance() {
      // A new action starts a new session and bumps the generation, like the real server.
      generation += 1;
      sessionId = crypto.randomUUID();
      timers.push(
        setTimeout(() => emit({ type: 'state', phase: 'navigating', destinationId: 'counter', routeStepId: 'start' }), 10),
      );
      GUIDANCE.forEach((g, i) => {
        timers.push(
          setTimeout(() => {
            emit({
              type: 'guidance',
              guidanceId: `mock-g-${i}`,
              text: g.text,
              action: g.action,
              direction: g.direction,
              routeStepId: i < 2 ? 'start' : 'corridor',
              nextRouteStepId: null,
              uncertain: false,
            });
          }, stepMs * (i + 1)),
        );
      });
    },
    async sendFrame() {
      // Frames are accepted and ignored: the mock is scripted.
    },
    async stop() {
      generation += 1;
      clear();
    },
    speechUrl() {
      return null;
    },
  };
}
