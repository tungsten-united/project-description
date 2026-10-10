import type { SpeechAdapter, SpeechResult } from '../session/types';

/** Rough time a screen reader needs for a sentence, so the session can keep its one-at-a-time order. */
export function estimateReadMs(text: string): number {
  return Math.min(10000, 800 + text.length * 65);
}

/**
 * Opt-in mode: the user's screen reader is the voice. Guidance text goes to an assertive live region
 * and the app plays no audio of its own. Stop clears the region, but a screen reader may finish a
 * sentence it already started, which the app cannot cancel.
 */
export function createLiveRegionSpeech(setAnnouncement: (text: string) => void): SpeechAdapter {
  let pending: { timer: ReturnType<typeof setTimeout>; resolve: (r: SpeechResult) => void } | null = null;

  const cancelPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.resolve('cancelled');
    pending = null;
  };

  return {
    initializeAfterUserGesture() {},
    speak(text) {
      cancelPending();
      // A new string each time, so a repeated sentence is announced again.
      setAnnouncement(text);
      return new Promise<SpeechResult>((resolve) => {
        const timer = setTimeout(() => {
          pending = null;
          resolve('finished');
        }, estimateReadMs(text));
        pending = { timer, resolve };
      });
    },
    stop() {
      cancelPending();
      setAnnouncement('');
    },
  };
}
