import type { OrchestratorApi, ServerEvent, SessionInfo } from './types';

const GUIDANCE = [
  { text: 'Pause and point the camera toward the counter.', action: 'wait', direction: null },
  { text: 'Turn slightly left, then continue.', action: 'turn', direction: 'left' },
  { text: 'Continue straight. The counter is ahead.', action: 'continue', direction: null },
  { text: 'You have arrived at the counter.', action: 'arrived', direction: null },
] as const;

type Listener = (event: ServerEvent) => void;

/** In-browser stand-in for the orchestrator so the shell runs without a backend. Scripted, not AI. */
export function createMockApi(stepMs = 2500): OrchestratorApi {
  let generation = 1;
  let listener: Listener | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let counter = 0;

  const emit = (partial: { sessionId: string } & Record<string, unknown>) => {
    counter += 1;
    listener?.({
      eventId: `mock-${counter}`,
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
    async createSession(): Promise<SessionInfo> {
      generation = 1;
      return {
        sessionId: crypto.randomUUID(),
        sessionToken: 'mock',
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
        },
      };
    },
    subscribe(_session, onEvent) {
      listener = onEvent;
      return () => {
        listener = null;
        clear();
      };
    },
    async sendUtterance(session) {
      const sessionId = session.sessionId;
      GUIDANCE.forEach((g, i) => {
        timers.push(
          setTimeout(() => {
            emit({
              sessionId,
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
    async stop() {
      generation += 1;
      clear();
    },
  };
}
