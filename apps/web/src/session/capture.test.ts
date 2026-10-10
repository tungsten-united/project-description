import { describe, expect, it } from 'vitest';
import { fitWithin, pickAudioMime } from './capture';

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
