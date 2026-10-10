import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { noMotion, type MotionSource } from '../motion/tracker';
import { noopLogger, type DebugLogger } from './debugLog';
import { initialView, reduce, type MachineEvent, type ViewState } from './machine';
import {
  CaptureError,
  type Capture,
  type ClientInfo,
  type OrchestratorApi,
  type ServerEvent,
  type SpeechAdapter,
  type StopReason,
} from './types';

const MAX_LISTEN_MS = 8000;
/** Gap between frame uploads. The next frame goes only after the previous 202. */
const FRAME_GAP_MS = 500;
export const UNAVAILABLE_TEXT = 'Guidance is unavailable. Press Try again.';
export const PERMISSION_TEXT = 'I need the camera and microphone. Please allow access, then press Try again.';
export const NOT_HEARD_TEXT = 'I did not hear anything. Please say it again.';

interface Run {
  id: number;
  client: ClientInfo | null;
  generation: number;
  sessionId: string | null;
  routeStepId: string | null;
  sequence: number;
  unsubscribe: (() => void) | null;
  spoken: Set<string>;
  lastEventAt: number;
}

function describeEnvironment(): string {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  return `ua=${navigator.userAgent} secure=${String(window.isSecureContext)} standalone=${String(standalone)} viewport=${window.innerWidth}x${window.innerHeight}`;
}

interface SessionOptions {
  logger?: DebugLogger;
  /** Speed and heading sensors. Defaults to none, so `motion` is null in every request. */
  motion?: MotionSource;
}

export function useSession(
  api: OrchestratorApi,
  speech: SpeechAdapter,
  capture: Capture,
  { logger = noopLogger, motion = noMotion }: SessionOptions = {},
) {
  const viewRef = useRef<ViewState>(initialView);
  const [view, setView] = useState<ViewState>(initialView);
  const [navigating, setNavigating] = useState(false);
  const run = useRef<Run>({
    id: 0,
    client: null,
    generation: 0,
    sessionId: null,
    routeStepId: null,
    sequence: 0,
    unsubscribe: null,
    spoken: new Set(),
    lastEventAt: 0,
  });

  const send = useCallback((event: MachineEvent) => {
    viewRef.current = reduce(viewRef.current, event);
    setView(viewRef.current);
  }, []);

  /** Stop wins: silence and release locally first, then tell the server without waiting. */
  const halt = useCallback(
    (reason: StopReason, error?: string, detail?: string) => {
      const r = run.current;
      logger.log(reason === 'error' ? 'error' : 'info', 'stop', `${reason}${detail ? `: ${detail}` : ''}`);
      r.id += 1; // invalidates every pending callback from the previous run
      speech.stop();
      speech.setSource?.(null);
      capture.release();
      motion.stop();
      r.unsubscribe?.();
      r.unsubscribe = null;
      setNavigating(false);
      send({ type: 'stop', reason, error, detail });
      const client = r.client;
      r.client = null;
      r.sessionId = null;
      if (client) void api.stop(client, crypto.randomUUID(), r.generation).catch(() => undefined);
      if (error) void speech.speak(error);
      logger.flush();
      logger.setClientId(null);
    },
    [api, capture, logger, motion, send, speech],
  );

  const onEvent = useCallback(
    async (id: number, event: ServerEvent) => {
      const r = run.current;
      if (id !== r.id) return;
      r.lastEventAt = Date.now();
      if (event.type === 'state') {
        // A newer generation means a new session started. Adopt it, and anything older is a late result.
        if (event.generation < r.generation) return;
        logger.log('info', 'state', `generation=${event.generation} phase=${event.phase} session=${event.sessionId ?? 'none'}`);
        r.generation = event.generation;
        r.sessionId = event.sessionId;
        r.routeStepId = event.routeStepId;
        setNavigating(event.phase === 'navigating' && event.sessionId !== null);
        return;
      }
      if (event.generation !== r.generation) return; // late result: drop
      switch (event.type) {
        case 'guidance': {
          logger.log('info', 'guidance', `${event.action} step=${event.routeStepId} uncertain=${String(event.uncertain)}`);
          r.routeStepId = event.routeStepId;
          if (r.spoken.has(event.guidanceId) || viewRef.current.state === 'speaking') return;
          if (viewRef.current.state !== 'waiting') return;
          r.spoken.add(event.guidanceId);
          send({ type: 'speak', text: event.text });
          await speech.speak(event.text);
          if (id !== r.id) return;
          if (event.action === 'arrived' || event.action === 'stop') halt(event.action === 'arrived' ? 'arrived' : 'user_stop');
          else send({ type: 'speech_done', then: 'wait' });
          return;
        }
        case 'needs_input': {
          logger.log('info', 'needs_input', event.reason);
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
          return; // heartbeat only proves the stream is alive; log is for the debug panel
      }
    },
    [halt, logger, send, speech],
  );

  const start = useCallback(async () => {
    const state = viewRef.current.state;
    if (state !== 'idle' && state !== 'stopped') return;
    const r = run.current;
    r.id += 1;
    const id = r.id;
    r.spoken = new Set();
    r.sequence = 0;
    r.sessionId = null;
    r.routeStepId = null;
    speech.initializeAfterUserGesture();
    send({ type: 'start' });
    logger.log('info', 'start', describeEnvironment());
    // Both permission prompts are started inside the tap. Denied motion only means motion is null.
    const motionAccess = motion.start().catch(() => 'denied' as const);
    try {
      await capture.acquire();
    } catch (e) {
      if (id === r.id) {
        const denied = e instanceof CaptureError && e.code === 'permission_denied';
        const detail = e instanceof CaptureError ? e.detail : String(e);
        halt('error', denied ? PERMISSION_TEXT : UNAVAILABLE_TEXT, detail);
      }
      return;
    }
    logger.log('info', 'motion_access', await motionAccess);
    if (id !== r.id) {
      capture.release();
      motion.stop();
      return;
    }
    let client: ClientInfo;
    try {
      client = await api.createClient();
    } catch (e) {
      if (id === r.id) halt('error', UNAVAILABLE_TEXT, `create_client: ${String(e)}`);
      return;
    }
    if (id !== r.id) {
      void api.stop(client, crypto.randomUUID(), client.generation).catch(() => undefined);
      return;
    }
    logger.setClientId(client.clientId);
    logger.log('info', 'client_created', `generation=${client.generation}`);
    r.client = client;
    r.generation = client.generation;
    r.lastEventAt = Date.now();
    speech.setSource?.((text) => api.speechUrl(client, text));
    r.unsubscribe = api.subscribe(client, (e) => void onEvent(id, e));
    const labels = client.route.destinations.map((d) => d.label).join(' or ');
    const prompt = `Where would you like to go? You can say ${labels}.`;
    send({ type: 'prompt_started', text: prompt });
    await speech.speak(prompt); // a failed prompt still shows as text, so continue
    if (id === r.id) send({ type: 'prompt_done' });
  }, [api, capture, halt, logger, motion, onEvent, send, speech]);

  const finishRecording = useCallback(async () => {
    const r = run.current;
    const client = r.client;
    if (viewRef.current.state !== 'listening' || !client) return;
    const id = r.id;
    send({ type: 'recording_done' });
    const capturedAt = Date.now();
    const [audio, frame] = await Promise.all([capture.stopRecording(), capture.grabFrame()]);
    if (id !== r.id) return;
    if (!audio) {
      send({ type: 'speak', text: NOT_HEARD_TEXT });
      await speech.speak(NOT_HEARD_TEXT);
      if (id === r.id) send({ type: 'speech_done', then: 'listen' });
      return;
    }
    r.sequence += 1;
    logger.log('info', 'input_sent', `audio=${audio.size}B ${audio.type} frame=${frame?.size ?? 0}B`);
    try {
      await api.sendInput(client, {
        requestId: crypto.randomUUID(),
        generation: r.generation,
        sequence: r.sequence,
        capturedAt,
        audio,
        frame,
        motion: motion.snapshot(),
      });
    } catch (e) {
      if (id === r.id) halt('error', UNAVAILABLE_TEXT, `send_input: ${String(e)}`);
    }
  }, [api, capture, halt, logger, motion, send, speech]);

  // Bounded recording: starts when listening begins and ends by itself.
  const listening = view.state === 'listening';
  useEffect(() => {
    if (!listening) return;
    capture.startRecording();
    const limit = Math.min(MAX_LISTEN_MS, run.current.client?.limits.maxAudioMs ?? MAX_LISTEN_MS);
    const timer = setTimeout(() => void finishRecording(), limit);
    return () => clearTimeout(timer);
  }, [listening, capture, finishRecording]);

  // Frame loop while a session is navigating: one upload in flight, latest frame wins on the server.
  const streaming = navigating && (view.state === 'waiting' || view.state === 'speaking');
  useEffect(() => {
    if (!streaming) return;
    let cancelled = false;
    const r = run.current;
    const id = r.id;
    void (async () => {
      while (!cancelled && id === r.id && r.client) {
        const client = r.client;
        const capturedAt = Date.now();
        const frame = await capture.grabFrame();
        if (cancelled || id !== r.id) return;
        if (frame) {
          r.sequence += 1;
          await api
            .sendFrame(client, {
              requestId: crypto.randomUUID(),
              generation: r.generation,
              sequence: r.sequence,
              capturedAt,
              frame,
              clientRouteStepId: r.routeStepId,
              motion: motion.snapshot(),
            })
            .catch(() => undefined); // 409s resync through events; a dead stream trips the watchdog
        }
        await new Promise((resolve) => setTimeout(resolve, FRAME_GAP_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streaming, api, capture, motion]);

  // Connection watchdog: no event for 3 x heartbeatMs means the stream is lost.
  const running = view.state !== 'idle' && view.state !== 'stopped';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      const r = run.current;
      const limit = (r.client?.limits.heartbeatMs ?? 5000) * 3;
      if (r.client && Date.now() - r.lastEventAt > limit) halt('error', UNAVAILABLE_TEXT, `no event for ${limit} ms`);
    }, 1000);
    return () => clearInterval(timer);
  }, [running, halt]);

  // Leaving the page ends the session and releases the camera and microphone.
  useEffect(() => {
    const r = run.current;
    return () => {
      r.id += 1;
      speech.stop();
      capture.release();
      motion.stop();
      r.unsubscribe?.();
    };
  }, [speech, capture, motion]);

  return useMemo(
    () => ({ view, start, stop: () => halt('user_stop'), finishRecording: () => void finishRecording() }),
    [view, start, halt, finishRecording],
  );
}
