import {
  ApiError,
  type ClientInfo,
  type FrameInput,
  type MapChoice,
  type Motion,
  type OrchestratorApi,
  type ServerEvent,
  type UserInput,
} from './types';

/** Client for docs/contracts.md section 1. */
export function createHttpApi(baseUrl: string): OrchestratorApi {
  const root = baseUrl.replace(/\/$/, '') + '/v1';
  /** serverTime - Date.now(), per client, so `capturedAt` is in server time. */
  const offsets = new Map<string, number>();

  const auth = (c: ClientInfo) => ({ Authorization: `Bearer ${c.clientToken}` });
  const serverTime = (c: ClientInfo, localMs: number) => localMs + (offsets.get(c.clientId) ?? 0);
  /** `measuredAt` is local time on the phone, like `capturedAt`, so both are sent in server time. */
  const motionMeta = (c: ClientInfo, m: Motion | null) =>
    m ? { ...m, measuredAt: serverTime(c, m.measuredAt) } : null;

  async function fail(res: Response): Promise<never> {
    let code = 'http_error';
    let message = `Request failed: ${res.status}`;
    let retryable = res.status >= 500;
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string; retryable?: boolean } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
      retryable = body.error?.retryable ?? retryable;
    } catch {
      // Body was not the contract's error shape. Keep the status-based defaults.
    }
    throw new ApiError(res.status, code, message, retryable);
  }

  async function post(url: string, init: RequestInit): Promise<void> {
    const res = await fetch(url, { method: 'POST', ...init });
    if (!res.ok) await fail(res);
  }

  return {
    async listMaps() {
      const res = await fetch(`${root}/maps`);
      if (!res.ok) await fail(res);
      return (await res.json()) as MapChoice[];
    },

    async createClient(mapId) {
      const body = mapId ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapId }) } : {};
      const res = await fetch(`${root}/clients`, { method: 'POST', ...body });
      if (!res.ok) await fail(res);
      const client = (await res.json()) as ClientInfo;
      offsets.set(client.clientId, client.serverTime - Date.now());
      return client;
    },

    subscribe(client, onEvent) {
      const url = `${root}/clients/${client.clientId}/events?token=${encodeURIComponent(client.clientToken)}`;
      const source = new EventSource(url);
      // The server sends unnamed events with `type` inside the JSON, so onmessage receives all of them.
      source.onmessage = (e: MessageEvent<string>) => {
        try {
          onEvent(JSON.parse(e.data) as ServerEvent);
        } catch {
          // Ignore a malformed event: the heartbeat watchdog handles a dead stream.
        }
      };
      return () => source.close();
    },

    async sendInput(client, input: UserInput) {
      const form = new FormData();
      form.set(
        'meta',
        JSON.stringify({
          requestId: input.requestId,
          generation: input.generation,
          sequence: input.sequence,
          capturedAt: serverTime(client, input.capturedAt),
          motion: motionMeta(client, input.motion),
        }),
      );
      form.set('audio', input.audio, input.audio.type.includes('mp4') ? 'input.mp4' : 'input.webm');
      if (input.frame) form.set('frame', input.frame, 'frame.jpg');
      await post(`${root}/clients/${client.clientId}/inputs`, { headers: auth(client), body: form });
    },

    async sendFrame(client, input: FrameInput) {
      const form = new FormData();
      form.set(
        'meta',
        JSON.stringify({
          requestId: input.requestId,
          generation: input.generation,
          sequence: input.sequence,
          capturedAt: serverTime(client, input.capturedAt),
          clientRouteStepId: input.clientRouteStepId,
          motion: motionMeta(client, input.motion),
        }),
      );
      form.set('frame', input.frame, 'frame.jpg');
      await post(`${root}/clients/${client.clientId}/frames`, { headers: auth(client), body: form });
    },

    async stop(client, requestId, generation) {
      await post(`${root}/clients/${client.clientId}/stop`, {
        headers: { ...auth(client), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, generation }),
        keepalive: true,
      });
    },

    speechUrl(client, text) {
      const q = new URLSearchParams({ token: client.clientToken, text });
      return `${root}/clients/${client.clientId}/speech?${q.toString()}`;
    },
  };
}
