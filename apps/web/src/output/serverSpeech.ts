import type { SpeechAdapter, SpeechResult } from '../session/types';

// 0.1 s of silence. Playing it inside the Start tap unlocks audio on iOS Safari.
const SILENCE =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
const WATCHDOG_MS = 15000;

/**
 * Plays the orchestrator's ElevenLabs audio (`GET /speech`) in one reused <audio> element.
 * Any failure falls back to the browser adapter, so speech never blocks guidance.
 */
export function createServerSpeech(
  fallback: SpeechAdapter,
  onFallback: (reason: string) => void = () => undefined,
): SpeechAdapter {
  const audio = typeof Audio !== 'undefined' ? new Audio() : null;
  let urlFor: ((text: string) => string | null) | null = null;
  let current = 0; // id of the utterance that may still resolve
  let settle: ((r: SpeechResult) => void) | null = null;

  const cancelPending = () => {
    current += 1;
    const s = settle;
    settle = null;
    s?.('cancelled');
  };

  const silence = () => {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  };

  return {
    initializeAfterUserGesture() {
      fallback.initializeAfterUserGesture();
      if (!audio) return;
      audio.src = SILENCE;
      void audio.play().catch(() => undefined);
    },

    setSource(next) {
      urlFor = next;
    },

    speak(text) {
      const url = audio ? urlFor?.(text) : null;
      if (!audio || !url) return fallback.speak(text);
      cancelPending();
      const id = current;
      return new Promise<SpeechResult>((resolve) => {
        let done = false;
        const finish = (result: SpeechResult) => {
          if (done || id !== current) return;
          done = true;
          clearTimeout(watchdog);
          settle = null;
          audio.onended = null;
          audio.onerror = null;
          resolve(result);
        };
        const switchToFallback = (reason: string) => {
          if (done || id !== current) return;
          onFallback(reason);
          done = true;
          clearTimeout(watchdog);
          settle = null;
          silence();
          void fallback.speak(text).then(resolve);
        };
        const watchdog = setTimeout(() => switchToFallback('timeout'), WATCHDOG_MS);
        settle = (r) => {
          done = true;
          clearTimeout(watchdog);
          resolve(r);
        };
        audio.onended = () => finish('finished');
        audio.onerror = () => switchToFallback(`audio_error code=${audio.error?.code ?? 'none'}`);
        audio.src = url;
        audio.play().catch((e: unknown) => switchToFallback(`play_rejected ${String(e)}`));
      });
    },

    stop() {
      cancelPending();
      silence();
      fallback.stop();
    },
  };
}
