import type { ClientInfo, OrchestratorApi, ServerEvent } from './types';

/** The places on the Itnig demo route (ids are the map's node ids). */
export const DEMO_PLACES = [
  { destinationId: 'n2', label: 'drinks area' },
  { destinationId: 'n7', label: 'kitchen' },
  { destinationId: 'n8', label: 'stage' },
] as const;

/** A scripted walk to one place. It is the same four beats whatever the place: not a real route. */
function scriptFor(label: string) {
  return [
    { text: 'Wait a moment.', action: 'wait', direction: null },
    { text: 'Turn left.', action: 'turn', direction: 'left' },
    { text: 'Keep going straight.', action: 'continue', direction: null },
    { text: `You have arrived at the ${label}.`, action: 'arrived', direction: null },
  ] as const;
}

type Listener = (event: ServerEvent) => void;

export interface MockApi extends OrchestratorApi {
  /** Chooses the place the scripted walk goes to, by label. Defaults to the first one. */
  setDestination(label: string): void;
}

/** In-browser stand-in for the orchestrator so the shell runs without a backend. Scripted, not AI. */
export function createMockApi(stepMs = 2500): MockApi {
  let chosen: { destinationId: string; label: string } = DEMO_PLACES[0];
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
          startStepId: 'n1',
          destinations: DEMO_PLACES.map((p) => ({ ...p })),
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
    async sendInput() {
      // A new action starts a new session and bumps the generation, like the real server.
      generation += 1;
      sessionId = crypto.randomUUID();
      const destination = chosen;
      timers.push(
        setTimeout(
          () => emit({ type: 'state', phase: 'navigating', destinationId: destination.destinationId, routeStepId: 'n1' }),
          10,
        ),
      );
      scriptFor(destination.label).forEach((g, i) => {
        timers.push(
          setTimeout(() => {
            emit({
              type: 'guidance',
              guidanceId: `mock-g-${i}`,
              text: g.text,
              action: g.action,
              direction: g.direction,
              routeStepId: i < 2 ? 'n1' : 'n2',
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
    setDestination(label) {
      chosen = DEMO_PLACES.find((p) => p.label === label) ?? DEMO_PLACES[0];
    },
  };
}
