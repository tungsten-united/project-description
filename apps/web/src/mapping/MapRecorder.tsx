import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { DEFAULT_STEP_LENGTH_M } from '../motion/tracker';
import {
  createMapApi,
  MapAuthError,
  type Holding,
  type Manifest,
  type MapApi,
  type PlaceSummary,
  type RecordingSummary,
  type Tag,
} from './mapApi';
import { Walk, type WalkOptions, type WalkSnapshot } from './recorder';
import { createUploadQueue, type UploadQueue, type UploadState } from './uploadQueue';

/** What the screen needs from a walk; tests pass a fake. */
export type WalkHandle = Pick<Walk, 'video' | 'audio' | 'warnings' | 'snapshot' | 'tag' | 'pressTalk' | 'releaseTalk' | 'stop'>;
export type StartWalk = (api: MapApi, queue: UploadQueue, options: WalkOptions) => Promise<WalkHandle>;

const PLACE_KEY = 'orient.mapPlace';
const NEW_PLACE = '';

const HOLDINGS: Array<[Holding, string]> = [
  ['handheld_portrait', 'In hand, upright'],
  ['handheld_landscape', 'In hand, sideways'],
  ['chest_mount', 'Chest mount'],
  ['lanyard', 'Lanyard'],
  ['other', 'Other'],
];
const TAGS: Array<[Tag, string]> = [
  ['door', 'Door'],
  ['junction', 'Junction'],
  ['stairs', 'Stairs'],
  ['lift', 'Lift'],
  ['destination', 'Destination'],
];
const OUTCOME: Record<string, string> = {
  complete: 'Walk saved',
  incomplete: 'Saved with gaps',
  failed: 'Processing failed',
};

const field = 'min-h-12 w-full rounded-2xl border-[1.5px] border-line bg-sand px-4 text-lg';
const label = 'text-base font-bold';
const primary =
  'flex shrink-0 flex-col items-center justify-center rounded-[1.9rem] border-2 border-clay-line bg-clay text-slate disabled:opacity-60';
const secondary = 'min-h-12 shrink-0 rounded-2xl border-[1.5px] border-line bg-sand px-4 text-lg';

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice lasts for this visit.
  }
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function uploadLine(state: UploadState, authFailed: boolean) {
  if (authFailed) return 'Access code rejected';
  if (state.failures) return `Retrying · ${state.pending} waiting`;
  if (state.pending > 2) return `Uploading · ${(state.bytes / 1e6).toFixed(1)} MB`;
  return 'Uploads ok';
}

type Lists = { places: PlaceSummary[]; recordings: RecordingSummary[] } | { error: unknown };

const fetchLists = (api: MapApi): Promise<Lists> =>
  Promise.all([api.places(), api.recordings()]).then(
    ([places, recordings]) => ({ places, recordings }),
    (error: unknown) => ({ error }),
  );

interface MapRecorderProps {
  api?: MapApi;
  startWalk?: StartWalk;
}

/** /map: record a walk of a place for its map. For the people who map a venue, not for guidance. */
export function MapRecorder({ api: injectedApi, startWalk = Walk.start }: MapRecorderProps) {
  const api = useMemo(() => injectedApi ?? createMapApi(), [injectedApi]);
  const [authFailed, setAuthFailed] = useState(false);
  const queue = useMemo(() => createUploadQueue(() => setAuthFailed(true)), []);
  const [uploads, setUploads] = useState<UploadState>(queue.state());
  useEffect(() => queue.subscribe(setUploads), [queue]);

  const [needsCode, setNeedsCode] = useState(() => !api.hasToken());
  const [code, setCode] = useState('');
  const [places, setPlaces] = useState<PlaceSummary[]>([]);
  const [recent, setRecent] = useState<RecordingSummary[]>([]);
  const [placePick, setPlacePick] = useState(NEW_PLACE);
  const [newPlace, setNewPlace] = useState('');
  const [notes, setNotes] = useState('');
  const [holding, setHolding] = useState<Holding>('handheld_portrait');
  const [stepLength, setStepLength] = useState(String(DEFAULT_STEP_LENGTH_M));
  const [message, setMessage] = useState('');
  const [starting, setStarting] = useState(false);

  const [walk, setWalk] = useState<WalkHandle | null>(null);
  const [snap, setSnap] = useState<WalkSnapshot | null>(null);
  const [status, setStatus] = useState('');
  const [flash, setFlash] = useState<Tag | null>(null);
  const [stopping, setStopping] = useState(false);
  const [doneLine, setDoneLine] = useState('');
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [finishing, setFinishing] = useState(false);

  const newPlaceRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);

  // Places newest first. The place picked last on this phone (or the newest) is preselected, so another walk of
  // the same building joins its map without typing: a typo would start a separate map.
  const applyLists = (lists: Lists) => {
    if ('error' in lists) {
      if (lists.error instanceof MapAuthError) {
        setNeedsCode(true);
        setMessage('That access code did not work. Ask the team for the current one.');
      } else {
        setMessage('Cannot reach the map service. Check the connection and reload.');
      }
      return;
    }
    const last = remembered(PLACE_KEY);
    setPlaces(lists.places);
    setRecent(lists.recordings.slice(0, 10));
    setPlacePick(lists.places.some((p) => p.place === last) ? last! : (lists.places[0]?.place ?? NEW_PLACE));
    setNeedsCode(false);
  };
  const loadLists = () => void fetchLists(api).then(applyLists);

  useEffect(() => {
    if (!api.hasToken()) return;
    let live = true;
    void fetchLists(api).then((lists) => live && applyLists(lists));
    return () => {
      live = false;
    };
  }, [api]);

  // The camera preview and the clock while walking.
  useEffect(() => {
    if (!walk) return;
    if (previewRef.current) previewRef.current.srcObject = walk.video;
    const timer = setInterval(() => setSnap(walk.snapshot()), 250);
    return () => clearInterval(timer);
  }, [walk]);

  // Leaving mid-walk or with uploads pending loses data: ask first.
  const busy = Boolean(walk) || uploads.pending > 0;
  useEffect(() => {
    if (!busy) return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [busy]);

  const saveCode = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    api.setToken(code);
    setCode('');
    setMessage('');
    setAuthFailed(false);
    loadLists();
  };

  const start = async () => {
    setMessage('');
    const place = placePick || newPlace.trim();
    if (needsCode) {
      setMessage('Enter the access code first.');
      return;
    }
    if (!place) {
      setMessage('Pick the place, or name the new place you are mapping.');
      newPlaceRef.current?.focus();
      return;
    }
    setStarting(true);
    try {
      const next = await startWalk(api, queue, {
        place,
        notes: notes.trim(),
        holding,
        stepLengthM: Number(stepLength) || DEFAULT_STEP_LENGTH_M,
      });
      if (placePick) remember(PLACE_KEY, placePick);
      setWalk(next);
      setSnap(next.snapshot());
      setStatus(['Recording', ...next.warnings].join('. '));
    } catch (error) {
      if (error instanceof MapAuthError) {
        setNeedsCode(true);
        setMessage('That access code did not work. Ask the team for the current one.');
      } else {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setStarting(false);
    }
  };

  const tag = (value: Tag, name: string) => {
    walk?.tag(value);
    setFlash(value);
    setTimeout(() => setFlash((current) => (current === value ? null : current)), 400);
    setStatus(`Tagged ${name.toLowerCase()}`);
  };

  const talkDown = (e: PointerEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (!walk || stopping) return;
    e.preventDefault();
    if ('pointerId' in e) e.currentTarget.setPointerCapture?.(e.pointerId);
    if (walk.pressTalk()) setStatus('Talking…');
  };

  const talkUp = (e: PointerEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    if (!walk) return;
    e.preventDefault();
    const result = walk.releaseTalk();
    if (result === 'toggled') setStatus('Talking… tap Talk again to stop');
    if (result === 'stopped') setStatus('Voice note saved');
    setSnap(walk.snapshot());
  };

  const stop = async () => {
    if (!walk || stopping) return;
    setStopping(true);
    setFinishing(true);
    setDoneLine('Stopping…');
    try {
      setManifest(await walk.stop(setDoneLine));
    } finally {
      setWalk(null);
      setStopping(false);
      setFinishing(false);
    }
  };

  const again = () => {
    setManifest(null);
    setDoneLine('');
    setStatus('');
    loadLists();
  };

  const onDone = finishing || manifest != null;
  const talking = snap?.talking ?? false;

  return (
    <main className="mx-auto flex h-full max-w-md flex-col gap-4 overflow-y-auto bg-ivory px-6 pt-5 pb-6">
      <header className="flex items-center justify-between text-base text-ink-soft">
        <span className="flex items-center gap-2.5">
          <img src="/icons/icon-192.png" alt="" width={32} height={32} className="size-8 rounded-lg" />
          <span className="text-lg font-bold tracking-[0.18em] text-slate uppercase">Orient</span>
        </span>
        {!walk && !finishing && !manifest && (
          <a href="/" className="flex min-h-11 items-center underline underline-offset-4">
            Back to Orient
          </a>
        )}
      </header>

      {!walk && !onDone && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-5xl leading-none font-bold">Map a place</h1>
            <p className="text-xl leading-snug text-ink-soft">
              Walk through the place with the phone upright and the rear camera facing forward. Pass every spot that
              should be on the map, in any order, and say where you start.
            </p>
          </div>

          {needsCode && (
            <form onSubmit={saveCode} className="flex flex-col gap-2 rounded-3xl border-[1.5px] border-line bg-sand p-5">
              <label htmlFor="map-code" className={label}>
                Access code
              </label>
              <p className="text-base text-ink-soft">Mapping is for the team. Ask for the code once; this phone keeps it.</p>
              <div className="flex gap-2">
                <input
                  id="map-code"
                  type="password"
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className={`${field} bg-ivory`}
                />
                <button type="submit" className="min-h-12 shrink-0 rounded-2xl border-2 border-slate px-4 text-lg font-bold">
                  Save
                </button>
              </div>
            </form>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="map-place" className={label}>
              Place
            </label>
            <select
              id="map-place"
              value={placePick}
              onChange={(e) => {
                setPlacePick(e.target.value);
                if (!e.target.value) setTimeout(() => newPlaceRef.current?.focus());
              }}
              className={field}
            >
              {places.map((p) => (
                <option key={p.place} value={p.place}>
                  {p.place} ({p.recordings} walk{p.recordings === 1 ? '' : 's'})
                </option>
              ))}
              <option value={NEW_PLACE}>New place…</option>
            </select>
            {!placePick && (
              <input
                ref={newPlaceRef}
                type="text"
                aria-label="New place name"
                placeholder="e.g. Office, 3rd floor"
                autoComplete="off"
                value={newPlace}
                onChange={(e) => setNewPlace(e.target.value)}
                className={field}
              />
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="map-notes" className={label}>
              Where you start <span className="font-normal text-ink-soft">(optional)</span>
            </label>
            <input
              id="map-notes"
              type="text"
              placeholder="e.g. at the main entrance"
              autoComplete="off"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={field}
            />
          </div>

          <details className="shrink-0 rounded-2xl border-[1.5px] border-line bg-sand">
            <summary className="flex min-h-12 cursor-pointer items-center px-4 text-lg">More options</summary>
            <div className="flex flex-col gap-2 px-4 pb-4">
              <label htmlFor="map-holding" className={label}>
                Phone position
              </label>
              <select
                id="map-holding"
                value={holding}
                onChange={(e) => setHolding(e.target.value as Holding)}
                className={`${field} bg-ivory`}
              >
                {HOLDINGS.map(([value, name]) => (
                  <option key={value} value={value}>
                    {name}
                  </option>
                ))}
              </select>
              <label htmlFor="map-step" className={label}>
                Step length (m)
              </label>
              <input
                id="map-step"
                type="number"
                min={0.3}
                max={1.2}
                step={0.05}
                inputMode="decimal"
                value={stepLength}
                onChange={(e) => setStepLength(e.target.value)}
                className={`${field} bg-ivory`}
              />
            </div>
          </details>

          <p role="alert" className="min-h-6 text-lg font-bold empty:min-h-0">
            {message}
          </p>

          <button type="button" onClick={() => void start()} disabled={starting} className={`${primary} h-36 gap-2`}>
            <span className="text-4xl leading-none font-bold">{starting ? 'Starting…' : 'Start recording'}</span>
            <span className="text-lg">Allow the camera, microphone and motion</span>
          </button>

          {recent.length > 0 && (
            <details className="shrink-0 rounded-2xl border-[1.5px] border-line bg-sand">
              <summary className="flex min-h-12 cursor-pointer items-center px-4 text-lg">Recent walks</summary>
              <ul className="flex flex-col gap-1 px-4 pb-4 text-base text-ink-soft">
                {recent.map((r) => (
                  <li key={r.rec_id}>
                    {r.place} · {r.duration_ms ? `${Math.round(r.duration_ms / 1000)} s` : '—'} · {r.status}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      {walk && !finishing && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-4xl font-bold tabular-nums" aria-label="Elapsed time">
              {clock(snap?.elapsedMs ?? 0)}
            </span>
            <span
              aria-live="polite"
              className={`rounded-full border-[1.5px] px-3 py-1 text-base ${
                authFailed || uploads.failures || uploads.bytes > 30e6
                  ? 'border-clay-line bg-clay text-slate'
                  : 'border-line bg-sand text-ink-soft'
              }`}
            >
              {uploadLine(uploads, authFailed)}
            </span>
          </div>

          <video
            ref={previewRef}
            playsInline
            muted
            autoPlay
            aria-hidden="true"
            className="max-h-[36vh] min-h-0 w-full shrink rounded-3xl border-[1.5px] border-line bg-slate object-cover"
          />

          <div aria-hidden="true" className="flex justify-between text-base text-ink-soft">
            <span>
              <b className="text-slate">{snap?.steps ?? 0}</b> steps
            </span>
            <span>
              <b className="text-slate">{(snap?.speedMps ?? 0).toFixed(2)}</b> m/s
            </span>
            <span>
              <b className="text-slate">{snap?.heading == null ? '—' : `${Math.round(snap.heading)}°`}</b> heading
            </span>
          </div>

          <p aria-live="assertive" className="min-h-7 text-xl font-bold">
            {status}
          </p>

          <div role="group" aria-label="Tags" className="grid grid-cols-3 gap-2">
            {TAGS.map(([value, name]) => (
              <button
                key={value}
                type="button"
                onClick={() => tag(value, name)}
                className={`min-h-14 rounded-2xl border-2 px-2 text-lg font-bold transition-colors ${
                  flash === value ? 'border-clay-line bg-clay' : 'border-line bg-sand'
                } ${value === 'destination' ? 'col-span-2' : ''}`}
              >
                {name}
              </button>
            ))}
          </div>

          <button
            type="button"
            aria-pressed={talking}
            disabled={!walk.audio}
            onPointerDown={talkDown}
            onPointerUp={talkUp}
            onPointerCancel={talkUp}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) talkDown(e);
            }}
            onKeyUp={(e) => {
              if (e.key === ' ' || e.key === 'Enter') talkUp(e);
            }}
            className={`flex h-28 shrink-0 touch-none flex-col items-center justify-center gap-1 rounded-[1.9rem] border-2 select-none disabled:opacity-50 ${
              talking ? 'border-clay-line bg-clay' : 'border-slate bg-sand'
            }`}
          >
            <span className="text-4xl leading-none font-bold">{talking ? 'Talking…' : 'Talk'}</span>
            <span className="text-base">{walk.audio ? 'Hold to describe the spot, or tap' : 'No microphone'}</span>
          </button>

          <button
            type="button"
            onClick={() => void stop()}
            disabled={stopping}
            className="h-16 shrink-0 rounded-2xl border-2 border-slate bg-slate text-3xl font-bold text-ivory"
          >
            Stop
          </button>
        </>
      )}

      {onDone && (
        <>
          <div className="flex flex-col gap-1.5">
            <h1 className="text-5xl leading-none font-bold">
              {manifest ? (OUTCOME[manifest.status] ?? manifest.status) : 'Saving'}
            </h1>
            <p aria-live="polite" className="text-xl leading-snug text-ink-soft">
              {manifest
                ? manifest.status === 'failed'
                  ? 'The walk is stored, but the server could not process it. Tell the team.'
                  : 'It joins the map of this place. The map rebuilds by itself.'
                : doneLine}
            </p>
          </div>

          {manifest && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-3xl border-[1.5px] border-line bg-sand p-5 text-base">
              <dt className="text-ink-soft">Place</dt>
              <dd className="font-bold">{manifest.place}</dd>
              <dt className="text-ink-soft">Duration</dt>
              <dd>{Math.round((manifest.duration_ms ?? 0) / 1000)} s</dd>
              <dt className="text-ink-soft">Video</dt>
              <dd>
                {manifest.video
                  ? `${manifest.video.width}×${manifest.video.height} ${manifest.video.codec ?? ''}, ${manifest.video.duration_s?.toFixed(1) ?? '?'} s`
                  : '—'}
              </dd>
              <dt className="text-ink-soft">Voice notes</dt>
              <dd>{manifest.voice.length}</dd>
              <dt className="text-ink-soft">Tags</dt>
              <dd>{manifest.counts.marks}</dd>
              <dt className="text-ink-soft">Sensors</dt>
              <dd>
                {manifest.counts.imu} motion, {manifest.counts.orientation} compass
              </dd>
              {manifest.gaps.length > 0 && (
                <>
                  <dt className="text-ink-soft">Gaps</dt>
                  <dd>{manifest.gaps.join(', ')}</dd>
                </>
              )}
              {manifest.error && (
                <>
                  <dt className="text-ink-soft">Error</dt>
                  <dd className="break-words">{manifest.error}</dd>
                </>
              )}
              <dt className="text-ink-soft">Id</dt>
              <dd className="break-all text-ink-faint select-text">{manifest.rec_id}</dd>
            </dl>
          )}

          {manifest && (
            <>
              <button type="button" onClick={again} className={`${primary} h-24 text-4xl font-bold`}>
                New walk
              </button>
              <a href="/" className={`${secondary} flex items-center justify-center`}>
                Back to Orient
              </a>
            </>
          )}
        </>
      )}
    </main>
  );
}
