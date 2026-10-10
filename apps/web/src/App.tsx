import { useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserSpeech } from './output/browserSpeech';
import { createLiveRegionSpeech } from './output/liveRegionSpeech';
import { createServerSpeech } from './output/serverSpeech';
import { createBrowserCapture, createFixtureCapture } from './session/capture';
import { DebugPanel } from './debug/DebugPanel';
import { SessionLogPanel } from './debug/SessionLogPanel';
import { createDebugStore, teeLogger, withInspection } from './debug/store';
import { createMotionTracker, noMotion } from './motion/tracker';
import { createDebugLogger, noopLogger } from './session/debugLog';
import { createHttpApi } from './session/httpApi';
import { createMockApi, type MockApi } from './session/mockApi';
import { isRunning, type ViewState } from './session/machine';
import type { Capture, OrchestratorApi, SpeechAdapter } from './session/types';
import { useSession } from './session/useSession';

interface Copy {
  label: string;
  caption: string;
}

function copyFor(view: ViewState, demo: boolean): Copy {
  switch (view.state) {
    case 'idle':
      return {
        label: 'Ready',
        caption: demo
          ? 'A scripted walk, no camera or microphone. Press Start, then tap a place.'
          : 'Orient guides you indoors by voice. Turn the sound up, press Start, allow the camera, microphone and motion, then say where you want to go.',
      };
    case 'prompting':
      return { label: 'Starting', caption: 'Listen to the question.' };
    case 'listening':
      return {
        label: 'Listening',
        caption: demo ? 'Tap the place you want to go to.' : 'Say where you want to go, then press Done.',
      };
    case 'waiting':
      return { label: 'Guiding', caption: 'Keep the phone raised. Quiet means keep going. Stop is at the top.' };
    case 'speaking':
      return { label: 'Guidance', caption: 'Keep the phone raised in front of you.' };
    case 'stopped':
      if (view.stopReason === 'arrived') return { label: 'Arrived', caption: 'Press Start to choose another destination.' };
      if (view.stopReason === 'error') return { label: 'Cannot guide', caption: 'Guidance has stopped.' };
      return { label: 'Stopped', caption: 'Press Start to begin again.' };
  }
}

function defaultApi(): OrchestratorApi {
  const base = import.meta.env.VITE_API_BASE_URL;
  return base ? createHttpApi(base) : createMockApi();
}

const SR_PREF_KEY = 'orient.screenReaderSpeech';

function readPreference(): boolean {
  try {
    return localStorage.getItem(SR_PREF_KEY) === '1';
  } catch {
    return false;
  }
}

function writePreference(on: boolean) {
  try {
    localStorage.setItem(SR_PREF_KEY, on ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the choice just lasts for this visit.
  }
}

interface AppProps {
  api?: OrchestratorApi;
  speech?: SpeechAdapter;
  capture?: Capture;
  /** The /itnig-demo page: a scripted walk in the browser. No camera, microphone, backend or logging. */
  demo?: boolean;
}

export function App({ api, speech, capture, demo = false }: AppProps) {
  // DEBUG_MODE is a build variable (VITE_DEBUG_MODE=true). It adds a cog with camera, logs, motion and payloads.
  const debugStore = useMemo(() => (import.meta.env.VITE_DEBUG_MODE === 'true' ? createDebugStore() : null), []);
  const baseApi = useMemo(() => api ?? (demo ? createMockApi() : defaultApi()), [api, demo]);
  const resolvedApi = useMemo(() => (debugStore ? withInspection(baseApi, debugStore) : baseApi), [baseApi, debugStore]);
  // Debug batches go to the orchestrator, which prints them into Cloud Logging. Off in demo mode.
  const logger = useMemo(() => {
    const base = import.meta.env.VITE_API_BASE_URL;
    const remote = base && !demo ? createDebugLogger(base) : noopLogger;
    return debugStore ? teeLogger(remote, debugStore) : remote;
  }, [debugStore, demo]);
  // Motion sensors only matter when there is a backend to send them to. There, they are required.
  const live = Boolean(import.meta.env.VITE_API_BASE_URL) && !demo;
  const motion = useMemo(() => (live ? createMotionTracker() : noMotion), [live]);
  // Default: the app's own voice is the only voice. Opt-in: the user's screen reader reads the text.
  const [screenReaderSpeech, setScreenReaderSpeech] = useState(readPreference);
  const [announcement, setAnnouncement] = useState('');
  const appVoice = useMemo(
    () => speech ?? createServerSpeech(createBrowserSpeech(), (reason) => logger.log('warn', 'speech_fallback', reason)),
    [speech, logger],
  );
  const readerVoice = useMemo(() => createLiveRegionSpeech(setAnnouncement), []);
  const resolvedSpeech = screenReaderSpeech ? readerVoice : appVoice;
  // Demo mode has no backend to receive media, so it skips the permission prompts.
  const resolvedCapture = useMemo(
    () => capture ?? (import.meta.env.VITE_API_BASE_URL && !demo ? createBrowserCapture() : createFixtureCapture()),
    [capture, demo],
  );
  const { view, places, start, stop, finishRecording } = useSession(resolvedApi, resolvedSpeech, resolvedCapture, {
    logger,
    motion,
    requireMotion: live,
  });

  // Keeps the panel's motion tab live while debugging.
  useEffect(() => {
    if (!debugStore) return;
    const timer = setInterval(() => debugStore.setMotion(motion.snapshot()), 500);
    return () => clearInterval(timer);
  }, [debugStore, motion]);

  const running = isRunning(view.state);
  const { label, caption } = copyFor(view, demo);
  const chooseDemoPlace = (place: string) => {
    (baseApi as Partial<MockApi>).setDestination?.(place);
    finishRecording();
  };

  // After Stop, arrival or an error the app is silent, so moving focus back to Start is announced once.
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (view.state === 'stopped') startRef.current?.focus();
  }, [view.state]);
  // The only status the screen reader is told about unprompted. While running the app's voice is the voice.
  const outcome = view.state === 'stopped' ? `${label}. ${caption}` : '';
  const startLabel = view.stopReason === 'error' ? 'Try again' : view.state === 'idle' ? 'Start' : 'Start again';

  return (
    <main
      className="mx-auto flex h-full max-w-md flex-col gap-4 bg-ivory px-6 pt-5 pb-6"
      // Double tap only starts. It never stops, so a grip or a pocket cannot end a session.
      onDoubleClick={() => {
        if (!running) void start();
      }}
    >
      {debugStore && <DebugPanel store={debugStore} capture={resolvedCapture} />}
      {debugStore && <SessionLogPanel store={debugStore} />}

      {/* The right padding keeps clear of the debug buttons, which only exist in debug mode. On a narrow screen the
          labels wrap under the name rather than over it. */}
      <header className={`flex flex-wrap items-center gap-x-3 text-base text-ink-soft ${debugStore ? 'pr-28' : ''}`}>
        <span className="flex shrink-0 items-center gap-2.5">
          {/* Decorative: the name next to it carries the meaning. CSS uppercases it, so a screen reader says "Orient". */}
          <img src="/icons/icon-192.png" alt="" width={32} height={32} className="size-8 rounded-lg" />
          <span className="text-lg font-bold tracking-[0.18em] text-slate uppercase">Orient</span>
        </span>
        <span className="ml-auto flex items-center gap-x-3 whitespace-nowrap">
          {demo ? <span>Scripted demo</span> : !import.meta.env.VITE_API_BASE_URL && <span>Demo mode</span>}
          {/* For the people who record a venue's map. Small and out of the way of Start. */}
          <a
            href="/map"
            onDoubleClick={(e) => e.stopPropagation()}
            className="flex min-h-11 items-center underline underline-offset-4"
          >
            Map a place
          </a>
        </span>
      </header>

      <div role="status" className="sr-only">
        {outcome}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      {running && (
        <button
          type="button"
          onClick={stop}
          aria-label="Stop guidance"
          className="h-16 shrink-0 rounded-2xl border-2 border-slate bg-slate text-3xl font-bold text-ivory"
        >
          Stop
        </button>
      )}

      <div className="flex flex-col gap-1.5">
        <h1 className="text-5xl leading-none font-bold">{label}</h1>
        <p className="min-h-[3.25rem] text-xl leading-snug text-ink-soft">{caption}</p>
      </div>

      {view.state === 'listening' && places.length > 0 && !demo && (
        <p className="text-xl font-bold" data-testid="places-hint">
          Say: {places.join(' · ')}
        </p>
      )}

      {view.state === 'listening' && demo && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Places">
          {places.map((place) => (
            <button
              key={place}
              type="button"
              onClick={() => chooseDemoPlace(place)}
              className="min-h-14 grow rounded-2xl border-2 border-slate bg-sand px-4 text-2xl font-bold"
            >
              {place}
            </button>
          ))}
        </div>
      )}

      {view.detail && (
        <p className="text-sm break-words text-ink-faint select-text" data-testid="technical-detail">
          Technical detail: {view.detail}
        </p>
      )}

      <section
        aria-label="Last thing said"
        className="flex min-h-0 grow flex-col justify-center overflow-hidden rounded-3xl border-[1.5px] border-line bg-sand p-5"
      >
        {view.spoken ? (
          <p className="text-3xl leading-tight font-bold">{view.spoken}</p>
        ) : (
          <p className="text-xl leading-snug text-ink-faint">What the assistant says appears here.</p>
        )}
      </section>

      {!running && (
        <details className="shrink-0 rounded-2xl border-[1.5px] border-line bg-sand">
          <summary className="flex min-h-12 cursor-pointer items-center px-4 text-lg">Accessibility</summary>
          <button
            type="button"
            role="switch"
            aria-checked={screenReaderSpeech}
            onClick={() => {
              const next = !screenReaderSpeech;
              setScreenReaderSpeech(next);
              writePreference(next);
            }}
            className="flex min-h-12 w-full items-center justify-between gap-3 px-4 pb-2 text-left text-lg"
          >
            <span>Read guidance with my screen reader</span>
            <span className="font-bold">{screenReaderSpeech ? 'On' : 'Off'}</span>
          </button>
        </details>
      )}

      {!running && (
        <button
          ref={startRef}
          type="button"
          onClick={() => void start()}
          aria-label={view.stopReason === 'error' ? 'Try again' : 'Start guidance'}
          className="flex h-64 shrink-0 flex-col items-center justify-center gap-1.5 rounded-[1.9rem] border-2 border-clay-line bg-clay text-slate"
        >
          <span className="text-6xl leading-none font-bold">{startLabel}</span>
          <span className="text-lg">or double tap anywhere</span>
        </button>
      )}

      {view.state === 'listening' && (
        <button
          type="button"
          onClick={finishRecording}
          aria-label="Done"
          className="flex h-64 shrink-0 flex-col items-center justify-center gap-1.5 rounded-[1.9rem] border-2 border-clay-line bg-clay text-slate"
        >
          <span className="text-6xl leading-none font-bold">Done</span>
          <span className="text-lg">Ends by itself after 8 seconds</span>
        </button>
      )}
    </main>
  );
}
