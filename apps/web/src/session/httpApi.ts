import { ApiError, type ClientInfo, type FrameInput, type OrchestratorApi, type ServerEvent, type UtteranceInput } from './types';

/** Client for docs/contracts.md section 1. */
export function createHttpApi(baseUrl: string): OrchestratorApi {
  const root = baseUrl.replace(/\/$/, '') + '/v1';
  /** serverTime - Date.now(), per client, so `capturedAt` is in server time. */
  const offsets = new Map<string, number>();

  const auth = (c: ClientInfo) => ({ Authorization: `Bearer ${c.clientToken}` });
  const serverTime = (c: ClientInfo, localMs: number) => localMs + (offsets.get(c.clientId) ?? 0);

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
    async createClient() {
      const res = await fetch(`${root}/clients`, { method: 'POST' });
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

    async sendUtterance(client, input: UtteranceInput) {
      const form = new FormData();
      form.set(
        'meta',
        JSON.stringify({
          requestId: input.requestId,
          generation: input.generation,
          sequence: input.sequence,
          capturedAt: serverTime(client, input.capturedAt),
        }),
      );
      form.set('audio', input.audio, input.audio.type.includes('mp4') ? 'utterance.mp4' : 'utterance.webm');
      if (input.frame) form.set('frame', input.frame, 'frame.jpg');
      await post(`${root}/clients/${client.clientId}/utterances`, { headers: auth(client), body: form });
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
