export type LogLevel = 'info' | 'warn' | 'error';

export interface DebugLogger {
  log(level: LogLevel, event: string, detail?: string): void;
  /** For the session timeline only: never sent to the orchestrator. Optional. */
  local?(level: LogLevel, event: string, detail?: string): void;
  setClientId(id: string | null): void;
  flush(): void;
}

export const noopLogger: DebugLogger = { log() {}, setClientId() {}, flush() {} };

const FLUSH_MS = 5000;
const MAX_BUFFER = 50;

function deviceId(): string {
  try {
    const key = 'orient.deviceId';
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Sends small debug batches to `POST /v1/logs`, which the orchestrator prints into Cloud Logging.
 * Never logs tokens, audio, frames or transcripts. Failures are swallowed: logging must not
 * affect guidance, and the endpoint may not exist on an older orchestrator.
 */
export function createDebugLogger(baseUrl: string): DebugLogger {
  const url = baseUrl.replace(/\/$/, '') + '/v1/logs';
  const device = deviceId();
  let clientId: string | null = null;
  let buffer: { at: number; level: LogLevel; event: string; detail?: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function send(beacon: boolean) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const body = JSON.stringify({ deviceId: device, clientId, entries: buffer });
    buffer = [];
    try {
      // text/plain keeps the request "simple", so no CORS preflight is needed, even from sendBeacon.
      if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      } else {
        void fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true }).catch(
          () => undefined,
        );
      }
    } catch {
      // Ignore: see above.
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => send(true));
  }

  return {
    log(level, event, detail) {
      buffer.push({ at: Date.now(), level, event, detail: detail?.slice(0, 1000) });
      if (buffer.length > MAX_BUFFER) buffer.shift();
      if (level === 'error') send(false);
      else timer ??= setTimeout(() => send(false), FLUSH_MS);
    },
    setClientId(id) {
      clientId = id;
    },
    flush() {
      send(false);
    },
  };
}
