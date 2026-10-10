import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapAuthError } from './mapApi';
import { createUploadQueue } from './uploadQueue';

afterEach(() => vi.useRealTimers());

const status = (code: number) => new Response(code === 204 ? null : 'x', { status: code });

describe('upload queue', () => {
  it('uploads in order, one at a time', async () => {
    const order: string[] = [];
    const queue = createUploadQueue();
    for (const label of ['a', 'b', 'c']) {
      queue.add(label, 10, async () => {
        order.push(label);
        return status(204);
      });
    }
    expect(queue.state()).toEqual({ pending: 3, bytes: 30, failures: 0 });
    await queue.idle();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(queue.state()).toEqual({ pending: 0, bytes: 0, failures: 0 });
  });

  it('retries server errors and network failures with backoff, keeping the order', async () => {
    vi.useFakeTimers();
    const answers: Array<() => Promise<Response>> = [
      async () => status(503),
      () => Promise.reject(new TypeError('offline')),
      async () => status(204),
    ];
    const first = vi.fn(() => answers.shift()!());
    const second = vi.fn(async () => status(204));
    const queue = createUploadQueue();
    queue.add('first', 1, first);
    queue.add('second', 1, second);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.state().failures).toBe(1);
    expect(second).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); // first retry after 2 s
    expect(queue.state().failures).toBe(2);
    await vi.advanceTimersByTimeAsync(4000); // second retry after 4 s
    await queue.idle();
    expect(first).toHaveBeenCalledTimes(3);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('drops a client error instead of retrying it forever', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = vi.fn(async () => status(422));
    const queue = createUploadQueue();
    queue.add('bad', 5, bad);
    await queue.idle();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(queue.state().pending).toBe(0);
  });

  it('reports a rejected access code and keeps the upload', async () => {
    vi.useFakeTimers();
    const onAuth = vi.fn();
    const queue = createUploadQueue(onAuth);
    queue.add('video 0', 1, () => Promise.reject(new MapAuthError()));
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuth).toHaveBeenCalled();
    expect(queue.state().pending).toBe(1);
  });

  it('notifies subscribers', async () => {
    const queue = createUploadQueue();
    const seen: number[] = [];
    queue.subscribe((s) => seen.push(s.pending));
    queue.add('x', 1, async () => status(204));
    await queue.idle();
    expect(seen[0]).toBe(1);
    expect(seen.at(-1)).toBe(0);
  });
});
