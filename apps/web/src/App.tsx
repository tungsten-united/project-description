import { useMemo } from 'react';
import { createBrowserSpeech } from './output/browserSpeech';
import { createServerSpeech } from './output/serverSpeech';
import { createBrowserCapture, createFixtureCapture } from './session/capture';
import { createHttpApi } from './session/httpApi';
import { createMockApi } from './session/mockApi';
import { isRunning, type ViewState } from './session/machine';
import type { Capture, OrchestratorApi, SpeechAdapter } from './session/types';
import { useSession } from './session/useSession';

interface Copy {
  label: string;
  caption: string;
}

function copyFor(view: ViewState): Copy {
  switch (view.state) {
    case 'idle':
      return { label: 'Ready', caption: 'Press Start, or double tap anywhere, to begin.' };
    case 'prompting':
      return { label: 'Starting', caption: 'Listen to the question.' };
    case 'listening':
      return { label: 'Listening', caption: 'Say where you want to go, then press Done.' };
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

interface AppProps {
  api?: OrchestratorApi;
  speech?: SpeechAdapter;
  capture?: Capture;
}

export function App({ api, speech, capture }: AppProps) {
  const resolvedApi = useMemo(() => api ?? defaultApi(), [api]);
  const resolvedSpeech = useMemo(() => speech ?? createServerSpeech(createBrowserSpeech()), [speech]);
  // Demo mode has no backend to receive media, so it skips the permission prompts.
  const resolvedCapture = useMemo(
    () => capture ?? (import.meta.env.VITE_API_BASE_URL ? createBrowserCapture() : createFixtureCapture()),
    [capture],
  );
  const { view, start, stop, finishRecording } = useSession(resolvedApi, resolvedSpeech, resolvedCapture);

  const running = isRunning(view.state);
  const { label, caption } = copyFor(view);
  const startLabel = view.stopReason === 'error' ? 'Try again' : view.state === 'idle' ? 'Start' : 'Start again';

  return (
    <main
      className="mx-auto flex h-full max-w-md flex-col gap-4 bg-ivory px-6 pt-5 pb-6"
      // Double tap only starts. It never stops, so a grip or a pocket cannot end a session.
      onDoubleClick={() => {
        if (!running) void start();
      }}
    >
      <header className="flex items-center justify-between text-base text-ink-soft">
        <span className="tracking-wide">Orient</span>
        {!import.meta.env.VITE_API_BASE_URL && <span>Demo mode</span>}
      </header>

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

      <div aria-live="polite" className="flex flex-col gap-1.5">
        <h1 className="text-5xl leading-none font-bold">{label}</h1>
        <p className="min-h-[3.25rem] text-xl leading-snug text-ink-soft">{caption}</p>
      </div>

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
        <button
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
          aria-label="Finish recording"
          className="flex h-64 shrink-0 flex-col items-center justify-center gap-1.5 rounded-[1.9rem] border-2 border-clay-line bg-clay text-slate"
        >
          <span className="text-6xl leading-none font-bold">Done</span>
          <span className="text-lg">Ends by itself after 8 seconds</span>
        </button>
      )}
    </main>
  );
}
