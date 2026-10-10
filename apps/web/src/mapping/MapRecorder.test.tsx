import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MapAuthError, type Manifest, type MapApi } from './mapApi';
import { MapRecorder, type StartWalk, type WalkHandle } from './MapRecorder';

const manifest: Manifest = {
  rec_id: '20261010T120000Z_abcd',
  place: 'Itnig',
  step_length_m: 0.7,
  status: 'complete',
  duration_ms: 42000,
  video: { codec: 'h264', width: 1080, height: 1920, duration_s: 41.8 },
  voice: [{}, {}],
  counts: { video_chunks: 21, sample_batches: 42, voice_clips: 2, imu: 2500, orientation: 2400, events: 100, marks: 3 },
  gaps: [],
  error: null,
};

function fakeApi(overrides: Partial<MapApi> = {}): MapApi {
  let token: string | null = 'code';
  return {
    hasToken: () => Boolean(token),
    setToken: (t) => (token = t),
    places: async () => [
      { place: 'Office', recordings: 1, duration_ms: 1, last_recorded_utc: '' },
      { place: 'Itnig', recordings: 3, duration_ms: 1, last_recorded_utc: '' },
    ],
    recordings: async () => [],
    create: async () => manifest,
    get: async () => manifest,
    finish: async () => manifest,
    putVideo: async () => new Response(null, { status: 204 }),
    postSamples: async () => new Response(null, { status: 204 }),
    putVoice: async () => new Response(null, { status: 204 }),
    ...overrides,
  };
}

function fakeWalk(): WalkHandle & { tags: string[] } {
  const tags: string[] = [];
  let talking = false;
  return {
    tags,
    video: new MediaStream(),
    audio: new MediaStream(),
    warnings: [],
    snapshot: () => ({ elapsedMs: 65_000, steps: 12, speedMps: 0.8, heading: 90, talking }),
    tag: (t) => void tags.push(t),
    pressTalk: () => (talking = true),
    releaseTalk: () => {
      talking = false;
      return 'stopped';
    },
    stop: async (progress) => {
      progress('Uploading… 0 left');
      return manifest;
    },
  };
}

// jsdom has no MediaStream.
vi.stubGlobal('MediaStream', class {});

describe('MapRecorder', () => {
  it('asks for the access code when there is none, and loads places once given', async () => {
    const api = fakeApi();
    api.setToken('');
    const places = vi.spyOn(api, 'places');
    render(<MapRecorder api={api} />);
    expect(places).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Access code'), 'team');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Access code')).not.toBeInTheDocument());
    expect(places).toHaveBeenCalled();
  });

  it('asks again when map-api refuses the code', async () => {
    render(<MapRecorder api={fakeApi({ places: () => Promise.reject(new MapAuthError()) })} />);
    expect(await screen.findByLabelText('Access code')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('access code did not work');
  });

  it('preselects the place picked last on this phone', async () => {
    localStorage.setItem('orient.mapPlace', 'Itnig');
    render(<MapRecorder api={fakeApi()} />);
    await waitFor(() => expect(screen.getByLabelText('Place')).toHaveValue('Itnig'));
  });

  it('needs a place before starting', async () => {
    const startWalk = vi.fn<StartWalk>();
    render(<MapRecorder api={fakeApi({ places: async () => [] })} startWalk={startWalk} />);
    await userEvent.click(screen.getByRole('button', { name: /Start recording/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('Pick the place');
    expect(startWalk).not.toHaveBeenCalled();
  });

  it('records a walk of a new place: tags, talk, stop, summary', async () => {
    const walk = fakeWalk();
    const startWalk = vi.fn<StartWalk>(async () => walk);
    render(<MapRecorder api={fakeApi({ places: async () => [] })} startWalk={startWalk} />);
    await userEvent.type(screen.getByLabelText('New place name'), '  Itnig ');
    await userEvent.type(screen.getByLabelText(/Where you start/), 'main entrance');
    await userEvent.click(screen.getByRole('button', { name: /Start recording/ }));

    expect(startWalk.mock.calls[0][2]).toEqual({
      place: 'Itnig',
      notes: 'main entrance',
      holding: 'handheld_portrait',
      stepLengthM: 0.7,
    });
    expect(await screen.findByLabelText('Elapsed time')).toHaveTextContent('1:05');
    expect(screen.queryByRole('link', { name: 'Back to Orient' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Door' }));
    expect(walk.tags).toEqual(['door']);
    expect(screen.getByText('Tagged door')).toBeInTheDocument();

    // One user-event instance, so it remembers the button is held between the two calls.
    const user = userEvent.setup();
    const talk = screen.getByRole('button', { name: /Talk/ });
    await user.pointer({ keys: '[MouseLeft>]', target: talk });
    expect(screen.getByText('Talking…', { selector: 'p' })).toBeInTheDocument();
    await user.pointer({ keys: '[/MouseLeft]', target: talk });
    expect(screen.getByText('Voice note saved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('heading', { name: 'Walk saved' })).toBeInTheDocument();
    expect(screen.getByText('42 s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New walk' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Orient' })).toHaveAttribute('href', '/');
  });
});
