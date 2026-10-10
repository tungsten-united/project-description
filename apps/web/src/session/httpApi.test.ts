import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from './httpApi';
import { ApiError, type ClientInfo } from './types';

const client: ClientInfo = {
  clientId: 'c1',
  clientToken: 'tok en',
  generation: 1,
  serverTime: 1_000_000,
  phase: 'awaiting_destination',
  route: { routeId: 'r', startStepId: 'start', destinations: [] },
  limits: { maxAudioMs: 1, maxAudioBytes: 1, maxFrameBytes: 1, maxFrameEdgePx: 1, maxInputAgeMs: 1, heartbeatMs: 1, navFrames: 5 },
};

afterEach(() => vi.unstubAllGlobals());

describe('http api', () => {
  it('posts audio as multipart to /clients/{id}/inputs with the bearer token and server-time capturedAt', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(500); // offset = 1_000_000 - 500
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/clients')
        ? new Response(JSON.stringify(client), { status: 201 })
        : new Response('{}', { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('https://api.test/');
    await api.createClient();
    await api.sendInput(client, {
      requestId: 'r1',
      generation: 1,
      sequence: 1,
      capturedAt: 700,
      audio: new Blob(['a'], { type: 'audio/webm' }),
      frame: null,
      motion: {
        speedMps: 0.9,
        cadenceHz: 1.3,
        stepCount: 12,
        stepLengthM: 0.7,
        headingDeg: 90,
        headingSource: 'orientation_absolute',
        headingAccuracyDeg: null,
        orientation: null,
        measuredAt: 650,
      },
    });
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/clients/c1/inputs');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok en');
    const form = init.body as FormData;
    const meta = JSON.parse(form.get('meta') as string);
    expect(meta).toMatchObject({ requestId: 'r1', sequence: 1, capturedAt: 1_000_200 });
    // measuredAt is converted to server time like capturedAt: 650 + (1_000_000 - 500)
    expect(meta.motion).toMatchObject({ speedMps: 0.9, headingDeg: 90, measuredAt: 1_000_150 });
    expect(form.get('audio')).toBeInstanceOf(Blob);
    expect(form.has('frame')).toBe(false);
  });

  it('turns the contract error body into an ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: 'stale_generation', message: 'Stopped.', retryable: false } }), { status: 409 }),
      ),
    );
    const api = createHttpApi('https://api.test');
    await expect(api.stop(client, 'r', 1)).rejects.toMatchObject({ status: 409, code: 'stale_generation' });
    await expect(api.stop(client, 'r', 1)).rejects.toBeInstanceOf(ApiError);
  });

  it('builds the speech URL with the token and encoded text in the query', () => {
    const api = createHttpApi('https://api.test');
    const url = new URL(api.speechUrl(client, 'Turn left.')!);
    expect(url.pathname).toBe('/v1/clients/c1/speech');
    expect(url.searchParams.get('token')).toBe('tok en');
    expect(url.searchParams.get('text')).toBe('Turn left.');
  });

  it('parses unnamed SSE messages, which is how the orchestrator sends events', () => {
    let instance: { onmessage: ((e: MessageEvent<string>) => void) | null; close: () => void } | null = null;
    class FakeEventSource {
      onmessage: ((e: MessageEvent<string>) => void) | null = null;
      close = vi.fn();
      constructor(public url: string) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        instance = this;
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const api = createHttpApi('https://api.test');
    const onEvent = vi.fn();
    const unsubscribe = api.subscribe(client, onEvent);
    instance!.onmessage!({ data: JSON.stringify({ type: 'heartbeat', generation: 1 }) } as MessageEvent<string>);
    instance!.onmessage!({ data: 'not json' } as MessageEvent<string>);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: 'heartbeat', generation: 1 });
    unsubscribe();
    expect(instance!.close).toHaveBeenCalled();
  });
});
