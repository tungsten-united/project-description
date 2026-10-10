import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCapture, fitWithin, pickAudioMime } from './capture';

describe('capture helpers', () => {
  it('prefers webm opus, then webm, then mp4 for Safari', () => {
    expect(pickAudioMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickAudioMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickAudioMime(() => false)).toBeUndefined();
  });

  it('scales the longest edge down to the limit and never enlarges', () => {
    expect(fitWithin(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 });
    expect(fitWithin(640, 480, 1280)).toEqual({ width: 640, height: 480 });
  });
});

describe('browser capture', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** A granted stream whose tracks the test controls. jsdom videos never get a size, like a dead camera. */
  function grant(micState: MediaStreamTrackState) {
    const stop = vi.fn();
    const audio = { readyState: micState, stop } as unknown as MediaStreamTrack;
    const video = { readyState: 'live', stop } as unknown as MediaStreamTrack;
    const stream = {
      getAudioTracks: () => [audio],
      getVideoTracks: () => [video],
      getTracks: () => [audio, video],
    } as unknown as MediaStream;
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: () => Promise.resolve(stream) } });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    return stop;
  }

  it('rejects a granted camera that gives no picture, and releases it', async () => {
    const stop = grant('live');
    const error = await createBrowserCapture({ pictureTimeoutMs: 200 }).acquire().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'no_picture' });
    expect(stop).toHaveBeenCalled();
  });

  it('rejects a microphone that is not live', async () => {
    grant('ended');
    const error = await createBrowserCapture({ pictureTimeoutMs: 200 }).acquire().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'unavailable' });
  });

  it('accepts a camera once it has a picture', async () => {
    grant('live');
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(640);
    await expect(createBrowserCapture({ pictureTimeoutMs: 200 }).acquire()).resolves.toBeUndefined();
  });
});
