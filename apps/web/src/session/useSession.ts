import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { initialView, reduce, type MachineEvent, type ViewState } from './machine';
import type { OrchestratorApi, ServerEvent, SessionInfo, SpeechAdapter, StopReason } from './types';

/** Stand-in for the recorded destination until audio capture (S02) lands. */
export const FIXTURE_TRANSCRIPT = 'Take me to the coffee counter';
const MAX_LISTEN_MS = 8000;
export const GENERIC_ERROR_TEXT = 'Guidance is unavailable. Press Try again.';

interface Run {
  id: number;
  session: SessionInfo | null;
  generation: number;
  sequence: number;
  unsubscribe: (() => void) | null;
  spoken: Set<string>;
}

export function useSession(api: OrchestratorApi, speech: SpeechAdapter) {
  const viewRef = useRef<ViewState>(initialView);
  const [view, setView] = useState<ViewState>(initialView);
  const run = useRef<Run>({ id: 0, session: null, generation: 0, sequence: 0, unsubscribe: null, spoken: new Set() });

  const send = useCallback((event: MachineEvent) => {
    viewRef.current = reduce(viewRef.current, event);
    setView(viewRef.current);
  }, []);

  /** Stop wins: silence and release locally first, then tell the server without waiting. */
  const halt = useCallback(
    (reason: StopReason, error?: string) => {
      const r = run.current;
      r.id += 1; // invalidates every pending callback from the previous run
      speech.stop();
      r.unsubscribe?.();
      r.unsubscribe = null;
      send({ type: 'stop', reason, error });
      const session = r.session;
      r.session = null;
      if (session) void api.stop(session, crypto.randomUUID(), r.generation).catch(() => undefined);
      if (error) void speech.speak(error);
    },
    [api, send, speech],
  );

  const onEvent = useCallback(
    async (id: number, event: ServerEvent) => {
      const r = run.current;
      if (id !== r.id || event.generation !== r.generation) return; // late result: drop
      switch (event.type) {
        case 'guidance': {
          if (r.spoken.has(event.guidanceId) || viewRef.current.state !== 'waiting') return;
          r.spoken.add(event.guidanceId);
          send({ type: 'speak', text: event.text });
          await speech.speak(event.text);
          if (id !== r.id) return;
          if (event.action === 'arrived' || event.action === 'stop') halt(event.action === 'arrived' ? 'arrived' : 'user_stop');
          else send({ type: 'speech_done', then: 'wait' });
          return;
        }
        case 'needs_input': {
          if (viewRef.current.state !== 'waiting') return;
          send({ type: 'speak', text: event.text });
          await speech.speak(event.text);
          if (id === r.id) send({ type: 'speech_done', then: 'listen' });
          return;
        }
        case 'stop':
          halt(event.reason);
          return;
        case 'error':
          halt('error', event.text);
          return;
        default:
          return; // state and heartbeat carry no speech
      }
    },
    [halt, send, speech],
  );

  const start = useCallback(async () => {
    const state = viewRef.current.state;
    if (state !== 'idle' && state !== 'stopped') return;
    const r = run.current;
    r.id += 1;
    const id = r.id;
    r.spoken = new Set();
    r.sequence = 0;
    speech.initializeAfterUserGesture();
    send({ type: 'start' });
    let info: SessionInfo;
    try {
      info = await api.createSession();
    } catch {
      if (id === r.id) halt('error', GENERIC_ERROR_TEXT);
      return;
    }
    if (id !== r.id) {
      void api.stop(info, crypto.randomUUID(), info.generation).catch(() => undefined);
      return;
    }
    r.session = info;
    r.generation = info.generation;
    r.unsubscribe = api.subscribe(info, (e) => void onEvent(id, e));
    const labels = info.route.destinations.map((d) => d.label).join(' or ');
    const prompt = `Where would you like to go? You can say ${labels}.`;
    send({ type: 'prompt_started', text: prompt });
    await speech.speak(prompt); // a failed prompt still shows as text, so continue
    if (id === r.id) send({ type: 'prompt_done' });
  }, [api, halt, onEvent, send, speech]);

  const finishRecording = useCallback(() => {
    const r = run.current;
    const session = r.session;
    if (viewRef.current.state !== 'listening' || !session) return;
    send({ type: 'recording_done' });
    r.sequence += 1;
    const id = r.id;
    api
      .sendUtterance(session, {
        requestId: crypto.randomUUID(),
        generation: r.generation,
        sequence: r.sequence,
        transcript: FIXTURE_TRANSCRIPT,
      })
      .catch(() => {
        if (id === r.id) halt('error', GENERIC_ERROR_TEXT);
      });
  }, [api, halt, send]);

  // Bounded recording: ends by itself so the user is never left listening forever.
  const listening = view.state === 'listening';
  useEffect(() => {
    if (!listening) return;
    const limit = Math.min(MAX_LISTEN_MS, run.current.session?.limits.maxAudioMs ?? MAX_LISTEN_MS);
    const timer = setTimeout(finishRecording, limit);
    return () => clearTimeout(timer);
  }, [listening, finishRecording]);

  // Leaving the page ends the session and releases everything.
  useEffect(() => {
    const r = run.current;
    return () => {
      r.id += 1;
      speech.stop();
      r.unsubscribe?.();
    };
  }, [speech]);

  return useMemo(
    () => ({ view, start, stop: () => halt('user_stop'), finishRecording }),
    [view, start, halt, finishRecording],
  );
}
