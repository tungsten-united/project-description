import type { SpeechAdapter, SpeechResult } from '../session/types';

const WATCHDOG_MS = 15000;

/** Thin browser TTS adapter. Tung owns the full output module; this satisfies the same interface. */
export function createBrowserSpeech(): SpeechAdapter {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined;
  return {
    initializeAfterUserGesture() {
      // Speaking an empty utterance inside the tap unlocks audio on iOS Safari.
      synth?.speak(new SpeechSynthesisUtterance(''));
    },
    speak(text) {
      if (!synth) return Promise.resolve<SpeechResult>('failed');
      return new Promise<SpeechResult>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        const watchdog = setTimeout(() => resolve('failed'), WATCHDOG_MS);
        const done = (result: SpeechResult) => {
          clearTimeout(watchdog);
          resolve(result);
        };
        utterance.onend = () => done('finished');
        utterance.onerror = (e) =>
          done(e.error === 'canceled' || e.error === 'interrupted' ? 'cancelled' : 'failed');
        synth.cancel();
        synth.speak(utterance);
      });
    },
    stop() {
      synth?.cancel();
    },
  };
}
