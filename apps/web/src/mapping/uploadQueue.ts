import { MapAuthError } from './mapApi';

/**
 * Uploads one at a time, in order, while walking. Every upload is idempotent on map-api, so a failed one is simply
 * sent again: server errors, timeouts, rate limits and network failures retry with backoff (2 s, 4 s ... 15 s);
 * other client errors are logged and dropped, since sending them again won't help.
 */

export interface UploadState {
  pending: number;
  bytes: number;
  failures: number;
}

export interface UploadQueue {
  add(label: string, bytes: number, run: () => Promise<Response>): void;
  state(): UploadState;
  /** Resolves once every queued upload has gone. */
  idle(): Promise<void>;
  subscribe(listener: (state: UploadState) => void): () => void;
}

interface Task {
  label: string;
  bytes: number;
  run: () => Promise<Response>;
}

const retryable = (status: number) => status >= 500 || status === 408 || status === 429;
export const backoffMs = (failures: number) => Math.min(1000 * 2 ** failures, 15000);

export function createUploadQueue(onAuthError: () => void = () => {}): UploadQueue {
  const tasks: Task[] = [];
  let bytes = 0;
  let failures = 0;
  let running = false;
  const listeners = new Set<(state: UploadState) => void>();
  let waiters: Array<() => void> = [];

  const state = (): UploadState => ({ pending: tasks.length, bytes, failures });
  const notify = () => listeners.forEach((listener) => listener(state()));

  async function drain() {
    running = true;
    while (tasks.length) {
      const task = tasks[0];
      try {
        const response = await task.run();
        if (!response.ok && retryable(response.status)) throw new Error(`HTTP ${response.status}`);
        if (!response.ok) console.error(task.label, response.status, await response.text().catch(() => ''));
        tasks.shift();
        bytes -= task.bytes;
        failures = 0;
      } catch (error) {
        // A wrong token stays wrong: keep the upload and ask for the code, then keep retrying.
        if (error instanceof MapAuthError) onAuthError();
        failures += 1;
        notify();
        await new Promise((resolve) => setTimeout(resolve, backoffMs(failures)));
      }
      notify();
    }
    running = false;
    const done = waiters;
    waiters = [];
    done.forEach((resolve) => resolve());
  }

  return {
    add(label, size, run) {
      tasks.push({ label, bytes: size, run });
      bytes += size;
      notify();
      if (!running) void drain();
    },
    state,
    idle: () => (tasks.length || running ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
