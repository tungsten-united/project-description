import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Capture } from '../session/types';
import type { DebugStore, PayloadRecord } from './store';

type Tab = 'camera' | 'logs' | 'motion' | 'payloads';
const TABS: { id: Tab; label: string }[] = [
  { id: 'camera', label: 'Camera' },
  { id: 'logs', label: 'Logs' },
  { id: 'motion', label: 'Motion' },
  { id: 'payloads', label: 'Payloads' },
];

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
const kb = (n: number | null) => (n == null ? 'none' : `${(n / 1024).toFixed(1)} KB`);

function CameraFeed({ capture }: { capture: Capture }) {
  const ref = useRef<HTMLVideoElement>(null);
  const stream = capture.previewStream();
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  if (!stream) return <p className="text-ink-soft">No camera stream. Press Start first, then reopen this tab.</p>;
  return <video ref={ref} autoPlay muted playsInline className="w-full rounded-xl border border-line bg-slate" />;
}

function Motion({ store }: { store: DebugStore }) {
  const motion = useSyncExternalStore(store.subscribe, () => store.get().motion);
  if (!motion) return <p className="text-ink-soft">No sensor data yet. Motion access is requested when you press Start.</p>;
  const rows: [string, string][] = [
    ['speedMps', String(motion.speedMps)],
    ['cadenceHz', String(motion.cadenceHz)],
    ['stepCount', String(motion.stepCount)],
    ['stepLengthM', String(motion.stepLengthM)],
    ['headingDeg', String(motion.headingDeg)],
    ['headingSource', String(motion.headingSource)],
    ['headingAccuracyDeg', String(motion.headingAccuracyDeg)],
    ['orientation', motion.orientation ? JSON.stringify(motion.orientation) : 'null'],
    ['measuredAt', motion.measuredAt ? time(motion.measuredAt) : 'none'],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-soft">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Payload({ record }: { record: PayloadRecord }) {
  return (
    <details className="rounded-xl border border-line bg-ivory p-3">
      <summary className="cursor-pointer font-mono text-sm">
        {time(record.at)} {record.kind} #{String((record.meta as { sequence?: number }).sequence ?? '?')}
        {record.audioBytes != null && ` audio ${kb(record.audioBytes)}`}
        {record.frameBytes != null && ` frame ${kb(record.frameBytes)}`}
      </summary>
      <div className="mt-3 flex flex-col gap-3">
        <pre className="overflow-x-auto rounded-lg bg-sand p-3 font-mono text-xs">{JSON.stringify(record.meta, null, 2)}</pre>
        {record.audioUrl && <audio controls src={record.audioUrl} className="w-full" />}
        {record.frameUrl && <img src={record.frameUrl} alt="Frame that was sent" className="max-h-64 rounded-lg border border-line" />}
      </div>
    </details>
  );
}

interface Props {
  store: DebugStore;
  capture: Capture;
}

/** Debug-only overlay: what the phone sees, logs, motion, and the exact requests it sends. */
export function DebugPanel({ store, capture }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('logs');
  const state = useSyncExternalStore(store.subscribe, store.get);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open debug panel"
        className="fixed top-3 right-3 z-40 flex size-12 items-center justify-center rounded-full border-[1.5px] border-line bg-sand text-2xl"
      >
        <span aria-hidden="true">⚙</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Debug panel" className="fixed inset-0 z-50 flex flex-col gap-3 overflow-hidden bg-ivory p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xl font-bold">Debug</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => store.setPaused(!state.paused)}
                className="min-h-11 rounded-xl border-2 border-slate px-4 font-bold"
              >
                {state.paused ? 'Resume frames' : 'Pause frames'}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-xl border-2 border-slate bg-slate px-4 font-bold text-ivory">
                Close
              </button>
            </div>
          </div>
          {state.paused && (
            <p className="rounded-lg bg-clay/20 p-2 text-sm">
              Frame sending is paused. {state.heldBack} frames were not sent. Voice inputs still go out. Inspect the payloads, then resume.
            </p>
          )}
          <div role="tablist" className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`min-h-11 flex-1 rounded-lg border-[1.5px] px-2 text-sm font-bold ${tab === t.id ? 'border-slate bg-slate text-ivory' : 'border-line bg-sand'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 grow overflow-y-auto">
            {tab === 'camera' && <CameraFeed capture={capture} />}
            {tab === 'motion' && <Motion store={store} />}
            {tab === 'logs' && (
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {state.logs.length === 0 && <li className="text-ink-soft">No log lines yet.</li>}
                {[...state.logs].reverse().map((l) => (
                  <li key={l.id} className={l.level === 'error' ? 'text-clay-line' : l.level === 'warn' ? 'font-bold' : ''}>
                    {time(l.at)} [{l.level}] {l.event}
                    {l.detail ? ` ${l.detail}` : ''}
                  </li>
                ))}
              </ul>
            )}
            {tab === 'payloads' && (
              <div className="flex flex-col gap-2">
                {state.payloads.length === 0 && <p className="text-ink-soft">Nothing sent yet.</p>}
                {state.payloads.map((p) => (
                  <Payload key={p.id} record={p} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
