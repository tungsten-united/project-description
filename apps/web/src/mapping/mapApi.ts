/**
 * Client for nav-engine's map-api, the team service that stores mapping walks (not the orchestrator).
 * Format: nav-engine nav/schemas/recording.py. Endpoints: map-api /docs, under /api/v1.
 * map-api needs its token (NAV_API_TOKEN). The site is public, so the token is never built in: the person
 * types it once (or opens /map?token=...) and it stays in this browser.
 */

export const DEFAULT_MAP_API_URL = 'https://map-api-613464313064.europe-southwest1.run.app';
const TOKEN_KEY = 'orient.mapToken';

export type Holding = 'handheld_portrait' | 'handheld_landscape' | 'chest_mount' | 'lanyard' | 'other';
export type Tag = 'door' | 'junction' | 'stairs' | 'lift' | 'destination';
export type RecordingStatus = 'recording' | 'finalizing' | 'complete' | 'incomplete' | 'failed';

export interface PlaceSummary {
  place: string;
  recordings: number;
  duration_ms: number;
  last_recorded_utc: string;
}

export interface Counts {
  video_chunks: number;
  sample_batches: number;
  voice_clips: number;
  imu: number;
  orientation: number;
  events: number;
  marks: number;
}

export interface RecordingSummary {
  rec_id: string;
  place: string;
  created_at_utc: string;
  status: RecordingStatus;
  duration_ms: number | null;
  counts: Counts;
}

export interface RecordingCreate {
  place: string;
  notes: string;
  holding: Holding;
  step_length_m: number;
  t0_epoch_ms: number;
  device: { user_agent: string; platform: string | null; screen_w: number; screen_h: number; pixel_ratio: number };
  camera: { width: number; height: number; fps: number | null; mime: string; facing: string | null; label: string | null };
}

export interface FinishRequest {
  duration_ms: number;
  video_chunks: number;
  sample_batches: number;
  voice_clips: number;
}

export interface Manifest {
  rec_id: string;
  place: string;
  step_length_m: number;
  status: RecordingStatus;
  duration_ms: number | null;
  video: { codec: string | null; width: number | null; height: number | null; duration_s: number | null } | null;
  voice: unknown[];
  counts: Counts;
  gaps: string[];
  error: string | null;
}

export interface SampleBatch {
  seq: number;
  imu: object[];
  orientation: object[];
  events: object[];
}

export class MapApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MapApiError';
  }
}

/** map-api refused the token, or there is none yet. */
export class MapAuthError extends MapApiError {
  constructor() {
    super(401, 'The access code is missing or wrong.');
    this.name = 'MapAuthError';
  }
}

export interface MapApi {
  hasToken(): boolean;
  setToken(token: string): void;
  places(): Promise<PlaceSummary[]>;
  recordings(): Promise<RecordingSummary[]>;
  create(req: RecordingCreate): Promise<Manifest>;
  get(recId: string): Promise<Manifest>;
  finish(recId: string, req: FinishRequest): Promise<Manifest>;
  /** Uploads resolve with the raw response so the upload queue decides what to retry. All are idempotent. */
  putVideo(recId: string, seq: number, chunk: Blob): Promise<Response>;
  postSamples(recId: string, batch: SampleBatch): Promise<Response>;
  putVoice(recId: string, clip: number, audio: Blob, tStartMs: number, tEndMs: number): Promise<Response>;
}

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Blocked storage: the code lasts for this visit only.
  }
}

/** Moves ?token= from the address bar into storage, so a shared link signs this browser in once. */
export function adoptTokenFromUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const token = params.get('token')?.trim();
  if (!params.has('token')) return null;
  params.delete('token');
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
  if (token) writeToken(token);
  return token || null;
}

export function createMapApi(baseUrl = import.meta.env.VITE_MAP_API_URL || DEFAULT_MAP_API_URL): MapApi {
  const root = baseUrl.replace(/\/+$/, '') + '/api/v1';
  let token = adoptTokenFromUrl() ?? readToken();

  const send = (method: string, path: string, body?: BodyInit, contentType?: string) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (contentType) headers['Content-Type'] = contentType;
    return fetch(root + path, { method, body, headers, cache: 'no-store' });
  };

  const json = async <T>(method: string, path: string, body?: object): Promise<T> => {
    const response = await send(method, path, body && JSON.stringify(body), body && 'application/json');
    if (response.status === 401) throw new MapAuthError();
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new MapApiError(response.status, `map-api answered ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  };

  const upload = async (method: string, path: string, body: BodyInit, contentType: string) => {
    const response = await send(method, path, body, contentType);
    if (response.status === 401) throw new MapAuthError();
    return response;
  };

  return {
    hasToken: () => Boolean(token),
    setToken(next) {
      token = next.trim() || null;
      writeToken(token ?? '');
    },
    places: () => json('GET', '/places'),
    recordings: () => json('GET', '/recordings'),
    create: (req) => json('POST', '/recordings', req),
    get: (recId) => json('GET', `/recordings/${recId}`),
    finish: (recId, req) => json('POST', `/recordings/${recId}/finish`, req),
    putVideo: (recId, seq, chunk) => upload('PUT', `/recordings/${recId}/video/${seq}`, chunk, 'application/octet-stream'),
    postSamples: (recId, batch) =>
      upload('POST', `/recordings/${recId}/samples`, JSON.stringify(batch), 'application/json'),
    putVoice: (recId, clip, audio, tStartMs, tEndMs) =>
      upload(
        'PUT',
        `/recordings/${recId}/voice/${clip}?t_start_ms=${tStartMs}&t_end_ms=${tEndMs}`,
        audio,
        audio.type || 'audio/webm',
      ),
  };
}
