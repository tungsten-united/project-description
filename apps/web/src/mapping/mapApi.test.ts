import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMapApi, MapApiError, MapAuthError } from './mapApi';

afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('map api', () => {
  it('takes ?token= from the address bar, keeps it and removes it from the URL', async () => {
    history.replaceState(null, '', '/map?token=s3cret&x=1#top');
    const fetchMock = vi.fn(async () => ok([]));
    vi.stubGlobal('fetch', fetchMock);
    const api = createMapApi('https://map.test/');
    expect(api.hasToken()).toBe(true);
    expect(location.pathname + location.search + location.hash).toBe('/map?x=1#top');
    expect(localStorage.getItem('orient.mapToken')).toBe('s3cret');
    await api.places();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://map.test/api/v1/places');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer s3cret');
  });

  it('reads a remembered token and lets the person set a new one', () => {
    localStorage.setItem('orient.mapToken', 'old');
    const api = createMapApi('https://map.test');
    expect(api.hasToken()).toBe(true);
    api.setToken('  new ');
    expect(localStorage.getItem('orient.mapToken')).toBe('new');
    api.setToken('');
    expect(api.hasToken()).toBe(false);
  });

  it('turns a 401 into MapAuthError and other failures into MapApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(createMapApi('https://map.test').recordings()).rejects.toBeInstanceOf(MapAuthError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const error = await createMapApi('https://map.test').places().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MapApiError);
    expect(error).not.toBeInstanceOf(MapAuthError);
    expect((error as MapApiError).status).toBe(500);
  });

  it('sends uploads to the recording format endpoints', async () => {
    localStorage.setItem('orient.mapToken', 't');
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createMapApi('https://map.test');
    await api.putVideo('R', 3, new Blob(['v']));
    await api.postSamples('R', { seq: 0, imu: [], orientation: [], events: [] });
    await api.putVoice('R', 1, new Blob(['a'], { type: 'audio/webm' }), 10.5, 900);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'PUT https://map.test/api/v1/recordings/R/video/3',
      'POST https://map.test/api/v1/recordings/R/samples',
      'PUT https://map.test/api/v1/recordings/R/voice/1?t_start_ms=10.5&t_end_ms=900',
    ]);
    expect((calls[0][1].headers as Record<string, string>)['Content-Type']).toBe('application/octet-stream');
    expect((calls[2][1].headers as Record<string, string>)['Content-Type']).toBe('audio/webm');
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ seq: 0, imu: [], orientation: [], events: [] });
  });
});
