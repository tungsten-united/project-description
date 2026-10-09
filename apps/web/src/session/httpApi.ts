import type { OrchestratorApi, ServerEvent, SessionInfo } from './types';

/** Real client for docs/contracts.md section 1. Untested against a live server until the orchestrator exists. */
export function createHttpApi(baseUrl: string): OrchestratorApi {
  const root = baseUrl.replace(/\/$/, '') + '/v1';

  const headers = (s: SessionInfo) => ({ Authorization: `Bearer ${s.sessionToken}` });

  return {
    async createSession() {
      const res = await fetch(`${root}/sessions`, { method: 'POST' });
      if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
      return (await res.json()) as SessionInfo;
    },
    subscribe(session, onEvent) {
      const url = `${root}/sessions/${session.sessionId}/events?token=${encodeURIComponent(session.sessionToken)}`;
      const source = new EventSource(url);
      const types = ['state', 'needs_input', 'guidance', 'heartbeat', 'stop', 'error'];
      for (const type of types) {
        source.addEventListener(type, (e) => {
          onEvent({ ...JSON.parse((e as MessageEvent<string>).data), type } as ServerEvent);
        });
      }
      return () => source.close();
    },
    async sendUtterance(session, input) {
      const form = new FormData();
      form.set(
        'meta',
        JSON.stringify({
          requestId: input.requestId,
          generation: input.generation,
          sequence: input.sequence,
          capturedAt: Date.now(),
        }),
      );
      form.set('transcript', input.transcript);
      const res = await fetch(`${root}/sessions/${session.sessionId}/utterances`, {
        method: 'POST',
        headers: headers(session),
        body: form,
      });
      if (!res.ok) throw new Error(`utterance failed: ${res.status}`);
    },
    async stop(session, requestId, generation) {
      await fetch(`${root}/sessions/${session.sessionId}/stop`, {
        method: 'POST',
        headers: { ...headers(session), 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, generation }),
        keepalive: true,
      });
    },
  };
}
