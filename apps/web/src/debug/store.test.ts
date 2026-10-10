import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../session/mockApi';
import type { ClientInfo, FrameInput, ServerEvent, UserInput } from '../session/types';
import { createDebugStore, withInspection } from './store';

const client = {} as ClientInfo;
const frame = (n: number): FrameInput => ({
  requestId: `r${n}`,
  generation: 1,
  sequence: n,
  capturedAt: 1,
  frame: new Blob(['x'], { type: 'image/jpeg' }),
  clientRouteStepId: null,
  motion: null,
});

describe('debug store and inspection', () => {
  it('records what is sent and forwards it', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    const store = createDebugStore();
    const api = createMockApi();
    const spy = vi.spyOn(api, 'sendFrame');
    const wrapped = withInspection(api, store);
    await wrapped.sendFrame(client, frame(1));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.get().payloads[0]).toMatchObject({ kind: 'frame', frameBytes: 1 });
    expect(store.get().payloads[0].meta).toMatchObject({ sequence: 1, motion: null });
    vi.unstubAllGlobals();
  });

  it('shows server trace entries in the logs and still forwards every event', () => {
    const store = createDebugStore();
    const api = createMockApi();
    let push: (e: ServerEvent) => void = () => undefined;
    vi.spyOn(api, 'subscribe').mockImplementation((_c, onEvent) => {
      push = onEvent;
      return () => undefined;
    });
    const seen: ServerEvent[] = [];
    withInspection(api, store).subscribe(client, (e) => seen.push(e));
    push({ type: 'log', kind: 'frame', entry: { phase: 'navigating', error: 'localize: timeout' } } as unknown as ServerEvent);
    expect(seen).toHaveLength(1);
    expect(store.get().logs[0]).toMatchObject({ level: 'error', event: 'server frame' });
    expect(store.get().logs[0].detail).toContain('"phase":"navigating"');
  });

  it('pause holds frames back but never voice inputs', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined });
    const store = createDebugStore();
    const api = createMockApi();
    const frames = vi.spyOn(api, 'sendFrame');
    const inputs = vi.spyOn(api, 'sendInput');
    const wrapped = withInspection(api, store);
    store.setPaused(true);
    await wrapped.sendFrame(client, frame(1));
    await wrapped.sendFrame(client, frame(2));
    const input: UserInput = {
      requestId: 'i',
      generation: 1,
      sequence: 3,
      capturedAt: 1,
      audio: new Blob(['a'], { type: 'audio/webm' }),
      frame: null,
      motion: null,
    };
    await wrapped.sendInput(client, input);
    expect(frames).not.toHaveBeenCalled();
    expect(inputs).toHaveBeenCalledTimes(1);
    expect(store.get().heldBack).toBe(2);
    store.setPaused(false);
    await wrapped.sendFrame(client, frame(4));
    expect(frames).toHaveBeenCalledTimes(1);
    expect(store.get().heldBack).toBe(0);
    vi.unstubAllGlobals();
  });

  it('keeps only the latest payloads and log lines', () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: vi.fn() });
    const store = createDebugStore();
    for (let i = 0; i < 12; i++) {
      store.addPayload({ kind: 'frame', meta: { sequence: i }, audioBytes: null, frameBytes: 1, audioUrl: null, frameUrl: 'blob:x' });
    }
    expect(store.get().payloads).toHaveLength(8);
    expect(store.get().payloads[0].meta).toEqual({ sequence: 11 });
    for (let i = 0; i < 250; i++) store.log('info', 'e', String(i));
    expect(store.get().logs).toHaveLength(200);
    vi.unstubAllGlobals();
  });
});
