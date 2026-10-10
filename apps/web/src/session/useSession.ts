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
const FRAME_GAP_MS = 500; // when the server sends no limits.frameGapMs
export const UNAVAILABLE_TEXT = 'Guidance is unavailable. Press Try again.';
export const PERMISSION_TEXT =
  "I need the camera and microphone. Allow them in the browser's site settings. On iPhone, also check Settings, Chrome or Safari, Camera and Microphone. Then press Try again.";
export const NO_PICTURE_TEXT = 'The camera is not giving a picture. Close other apps using it and press Try again.';
export const MOTION_TEXT =
  'I need the motion sensors. In Chrome, tap the icon left of the address, then Permissions, Motion sensors, Allow. Then press Try again.';
export const MOTION_TEXT_IOS = 'I need motion and orientation access. Close this tab, open the page again and allow it.';
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

/** iPhone and iPad, including iPadOS that reports itself as a Mac. */
function isIos(): boolean {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

function describeEnvironment(): string {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  return `ua=${navigator.userAgent} secure=${String(window.isSecureContext)} standalone=${String(standalone)} viewport=${window.innerWidth}x${window.innerHeight}`;
}

interface SessionOptions {
  logger?: DebugLogger;
  /** Speed and heading sensors. Defaults to none, so `motion` is null in every request. */
  motion?: MotionSource;
  /**
   * No session without motion: Start stops with a spoken fix unless the accelerometer reports. The live app
   * sets it, since nav-api's walked-distance gate needs the phone's steps; demo and mock modes have no sensors.
   */
  requireMotion?: boolean;
  /** The place to guide in (`GET /v1/maps`); undefined: the orchestrator's default map. */
  mapId?: string;
}

export function useSession(
  api: OrchestratorApi,
  speech: SpeechAdapter,
  capture: Capture,
  { logger = noopLogger, motion = noMotion, requireMotion = false, mapId }: SessionOptions = {},
) {
  const viewRef = useRef<ViewState>(initialView);
  const [view, setView] = useState<ViewState>(initialView);
  const [navigating, setNavigating] = useState(false);
  /** The destinations the orchestrator can guide to, for the on-screen hint. Empty outside a session. */
  const [places, setPlaces] = useState<string[]>([]);
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

  /** Speaks one sentence and records when it started and how it ended, for the session timeline. */
  const say = useCallback(
    async (text: string) => {
      logger.local?.('info', 'tts_start', text);
      const result = await speech.speak(text);
      logger.local?.('info', 'tts_end', result);
      return result;
    },
    [logger, speech],
  );

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
      setPlaces([]);
      send({ type: 'stop', reason, error, detail });
      const client = r.client;
      r.client = null;
      r.sessionId = null;
      if (client) void api.stop(client, crypto.randomUUID(), r.generation).catch(() => undefined);
      if (error) void say(error);
      logger.flush();
      logger.setClientId(null);
    },
    [api, capture, logger, motion, say, send, speech],
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
          await say(event.text);
          if (id !== r.id) return;
          if (event.action === 'arrived' || event.action === 'stop') halt(event.action === 'arrived' ? 'arrived' : 'user_stop');
          else send({ type: 'speech_done', then: 'wait' });
          return;
        }
        case 'needs_input': {
          logger.log('info', 'needs_input', event.reason);
          if (viewRef.current.state !== 'waiting') return;
          send({ type: 'speak', text: event.text });
          await say(event.text);
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
    [halt, logger, say, send],
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
    // One prompt at a time: two at once left an iPhone (Chrome, iOS 27) with NotAllowedError and no prompt.
    // Motion asks first, while the tap still counts (iOS only asks inside one). Camera and microphone need no tap.
    const motionAccess = await motion.start().catch(() => 'denied' as const);
    if (id !== r.id) return;
    const sensors = motion.ready();
    try {
      await capture.acquire();
    } catch (e) {
      if (id === r.id) {
        const code = e instanceof CaptureError ? e.code : null;
        const detail = e instanceof CaptureError ? e.detail : String(e);
        const text = code === 'permission_denied' ? PERMISSION_TEXT : code === 'no_picture' ? NO_PICTURE_TEXT : UNAVAILABLE_TEXT;
        halt('error', text, detail);
      }
      return;
    }
    if (capture.describe) logger.log('info', 'capture_ready', capture.describe());
    const seen = await sensors;
    const sensed = `${motionAccess} samples=${seen.motion ? 'yes' : 'no'} orientation=${seen.orientation ? 'yes' : 'no'}`;
    logger.log('info', 'motion_access', sensed);
    if (id !== r.id) {
      capture.release();
      motion.stop();
      return;
    }
    // Every check passed or no session: without steps, nav-api cannot tell a walked hop from a glance.
    if (requireMotion && !seen.motion) {
      halt('error', isIos() ? MOTION_TEXT_IOS : MOTION_TEXT, `motion: ${sensed}`);
      return;
    }
    let client: ClientInfo;
    try {
      client = await api.createClient(mapId);
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
    setPlaces(client.route.destinations.map((d) => d.label));
    r.client = client;
    r.generation = client.generation;
    r.lastEventAt = Date.now();
    speech.setSource?.((text) => api.speechUrl(client, text));
    r.unsubscribe = api.subscribe(client, (e) => void onEvent(id, e));
    // The open question only. The server's route decides what it can guide to, and says so if it cannot.
    const prompt = 'Where would you like to go?';
    send({ type: 'prompt_started', text: prompt });
    await say(prompt); // a failed prompt still shows as text, so continue
    if (id === r.id) send({ type: 'prompt_done' });
  }, [api, capture, halt, logger, mapId, motion, onEvent, requireMotion, say, send, speech]);

  const finishRecording = useCallback(async () => {
    const r = run.current;
    const client = r.client;
    if (viewRef.current.state !== 'listening' || !client) return;
    const id = r.id;
    send({ type: 'recording_done' });
    const capturedAt = Date.now();
    const [audio, frame] = await Promise.all([capture.stopRecording(), capture.grabFrame(client.limits.maxFrameEdgePx)]);
    if (id !== r.id) return;
    logger.local?.('info', 'recording_stopped', audio ? `${(audio.size / 1024).toFixed(0)} KB` : 'no audio');
    const levels = capture.voiceStats?.();
    if (levels) {
      logger.log('info', 'voice_levels', `floor=${levels.noiseFloorDb}dB peak=${levels.peakDb}dB open=${levels.openRatio} frames=${levels.frames}`);
    }
    if (!audio) {
      send({ type: 'speak', text: NOT_HEARD_TEXT });
      await say(NOT_HEARD_TEXT);
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
  }, [api, capture, halt, logger, motion, say, send]);

  // Bounded recording: starts when listening begins and ends by itself.
  const listening = view.state === 'listening';
  useEffect(() => {
    if (!listening) return;
    capture.startRecording();
    const limit = Math.min(MAX_LISTEN_MS, run.current.client?.limits.maxAudioMs ?? MAX_LISTEN_MS);
    logger.local?.('info', 'recording_started', `${limit / 1000} s`);
    const timer = setTimeout(() => void finishRecording(), limit);
    return () => clearTimeout(timer);
  }, [listening, capture, finishRecording, logger]);

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
        const frame = await capture.grabFrame(client.limits.maxFrameEdgePx);
        if (cancelled || id !== r.id) return;
        if (frame) {
          r.sequence += 1;
          const m = motion.snapshot();
          const hdg = m?.headingDeg == null ? 'no heading' : `heading ${Math.round(m.headingDeg)}°`;
          logger.local?.('info', 'frame_sent', `#${r.sequence} sent, ${(frame.size / 1024).toFixed(0)} KB, ${hdg}`);
          await api
            .sendFrame(client, {
              requestId: crypto.randomUUID(),
              generation: r.generation,
              sequence: r.sequence,
              capturedAt,
              frame,
              clientRouteStepId: r.routeStepId,
              motion: m,
            })
            .catch(() => undefined); // 409s resync through events; a dead stream trips the watchdog
        }
        await new Promise((resolve) => setTimeout(resolve, client.limits.frameGapMs ?? FRAME_GAP_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [streaming, api, capture, motion, logger]);

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
    () => ({ view, places, start, stop: () => halt('user_stop'), finishRecording: () => void finishRecording() }),
    [view, places, start, halt, finishRecording],
  );
}
