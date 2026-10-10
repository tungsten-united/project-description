import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createFixtureCapture } from './capture';
import { createMockApi } from './mockApi';
import {
  CaptureError,
  type Capture,
  type OrchestratorApi,
  type ServerEvent,
  type SpeechAdapter,
} from './types';
import type { MotionSource } from '../motion/tracker';
import { MOTION_TEXT, NO_PICTURE_TEXT, PERMISSION_TEXT, useSession } from './useSession';

function speech(): SpeechAdapter & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    spoken,
    initializeAfterUserGesture: () => undefined,
    speak: (t) => {
      spoken.push(t);
      return Promise.resolve('finished');
    },
    stop: () => undefined,
  };
}

/** Mock API whose event listener the test can drive by hand. */
function driven() {
  const base = createMockApi(1_000_000); // scripted guidance never fires on its own
  let listener: ((e: ServerEvent) => void) | null = null;
  const api: OrchestratorApi = {
    ...base,
    subscribe: (c, l) => {
      listener = l;
      return base.subscribe(c, l);
    },
  };
  const emit = (e: Record<string, unknown>) =>
    act(async () => {
      listener?.({ clientId: 'mock-client', sessionId: 's1', requestId: null, emittedAt: 0, eventId: crypto.randomUUID(), ...e } as ServerEvent);
    });
  return { api, emit };
}

describe('useSession', () => {
  it('adopts a newer generation from state, then drops events from the old one', async () => {
    const { api, emit } = driven();
    const sp = speech();
    const capture = createFixtureCapture(); // stable: a new object per render would end the run
    const { result } = renderHook(() => useSession(api, sp, capture));
    await act(async () => void (await result.current.start()));
    await waitFor(() => expect(result.current.view.state).toBe('listening'));
    act(() => result.current.finishRecording());
    await waitFor(() => expect(result.current.view.state).toBe('waiting'));

    await emit({ type: 'state', generation: 2, phase: 'navigating', destinationId: 'counter', routeStepId: 'start' });
    await emit({ type: 'guidance', generation: 1, guidanceId: 'old', text: 'Old guidance', action: 'turn', direction: 'left', routeStepId: 'start', nextRouteStepId: null, uncertain: false });
    expect(sp.spoken).not.toContain('Old guidance');
    await emit({ type: 'guidance', generation: 2, guidanceId: 'new', text: 'Turn left.', action: 'turn', direction: 'left', routeStepId: 'start', nextRouteStepId: null, uncertain: false });
    await waitFor(() => expect(sp.spoken).toContain('Turn left.'));
  });

  it('reports a denied permission as a spoken, recoverable error', async () => {
    const capture: Capture = {
      ...createFixtureCapture(),
      acquire: () => Promise.reject(new CaptureError('permission_denied', 'no')),
      release: vi.fn(),
    };
    const sp = speech();
    const api = createMockApi(10);
    const { result } = renderHook(() => useSession(api, sp, capture));
    await act(async () => void (await result.current.start()));
    expect(result.current.view.state).toBe('stopped');
    expect(result.current.view.stopReason).toBe('error');
    expect(sp.spoken).toContain(PERMISSION_TEXT);
  });

  it('reports a camera without a picture with its own fix', async () => {
    const capture: Capture = { ...createFixtureCapture(), acquire: () => Promise.reject(new CaptureError('no_picture', 'no')) };
    const sp = speech();
    const { result } = renderHook(() => useSession(createMockApi(10), sp, capture));
    await act(async () => void (await result.current.start()));
    expect(result.current.view.state).toBe('stopped');
    expect(sp.spoken).toContain(NO_PICTURE_TEXT);
  });

  it('does not start a session when motion is required and no sensor reports', async () => {
    const release = vi.fn();
    const capture: Capture = { ...createFixtureCapture(), release };
    const api = createMockApi(10);
    const createClient = vi.spyOn(api, 'createClient');
    const stop = vi.fn();
    const motion: MotionSource = {
      start: () => Promise.resolve('denied'),
      ready: () => Promise.resolve({ motion: false, orientation: false }),
      stop,
      snapshot: () => null,
    };
    const sp = speech();
    const { result } = renderHook(() => useSession(api, sp, capture, { motion, requireMotion: true }));
    await act(async () => void (await result.current.start()));
    expect(result.current.view.state).toBe('stopped');
    expect(result.current.view.stopReason).toBe('error');
    expect(result.current.view.detail).toContain('samples=no');
    expect(sp.spoken).toContain(MOTION_TEXT);
    expect(result.current.view.spoken).toBe(MOTION_TEXT); // stays on screen
    expect(createClient).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('asks for motion before the camera, and starts once samples arrive', async () => {
    const order: string[] = [];
    const capture: Capture = {
      ...createFixtureCapture(),
      acquire: async () => void order.push('camera'),
    };
    const motion: MotionSource = {
      start: async () => {
        order.push('motion');
        return 'denied'; // Chrome 155's answer, with samples flowing anyway
      },
      ready: () => Promise.resolve({ motion: true, orientation: true }),
      stop: () => undefined,
      snapshot: () => null,
    };
    const { result } = renderHook(() => useSession(createMockApi(10), speech(), capture, { motion, requireMotion: true }));
    await act(async () => void (await result.current.start()));
    expect(order).toEqual(['motion', 'camera']);
    await waitFor(() => expect(result.current.view.state).toBe('listening'));
  });

  it('releases capture on Stop', async () => {
    const release = vi.fn();
    const capture: Capture = { ...createFixtureCapture(), release };
    const api = createMockApi(10);
    const sp = speech();
    const { result } = renderHook(() => useSession(api, sp, capture));
    await act(async () => void (await result.current.start()));
    act(() => result.current.stop());
    expect(release).toHaveBeenCalled();
    expect(result.current.view.state).toBe('stopped');
  });
});
