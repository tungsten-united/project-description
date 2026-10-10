import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDebugLogger } from './debugLog';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch() {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('debug logger', () => {
  it('sends an error immediately, with the client id and all buffered entries', () => {
    const fetchMock = stubFetch();
    const logger = createDebugLogger('https://api.test/');
    logger.setClientId('c1');
    logger.log('info', 'start');
    logger.log('error', 'permission_denied', 'NotAllowedError');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/logs');
    const body = JSON.parse(init.body as string);
    expect(body.clientId).toBe('c1');
    expect(body.entries.map((e: { event: string }) => e.event)).toEqual(['start', 'permission_denied']);
  });

  it('batches info entries and flushes after the interval', () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch();
    const logger = createDebugLogger('https://api.test');
    logger.log('info', 'a');
    logger.log('warn', 'b');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when the endpoint is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));
    const logger = createDebugLogger('https://api.test');
    expect(() => logger.log('error', 'x')).not.toThrow();
    await Promise.resolve();
  });
});
