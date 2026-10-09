# HTTP contracts

Status: draft for S01 team review. Derived from [architecture.md](architecture.md). Every limit and timeout below is a starting value that we tune on the demo phone, not a measured result.

Three boundaries:

1. Phone ↔ Orchestrator: public HTTPS through the tunnel.
2. Orchestrator ↔ Navigation engine (VLA): internal HTTP on the GPU server, not exposed through the tunnel.
3. Orchestrator ↔ Jev API: the Command LLM, the Utterance decider (if it becomes an LLM) and the Utterance writer. Server-side only.

## Conventions

- Base path `/v1`. JSON bodies, UTF-8, camelCase.
- IDs are UUID v4 strings. The server creates `sessionId`. The phone creates a `requestId` for every POST. A repeated `requestId` returns the original response and is not processed again.
- `generation`: integer that starts at 1. The server increments it on stop and retry. Every POST and every SSE event carries it. Results from an older generation are dropped on both sides.
- `sequence`: integer the phone increments on each utterance or frame in a session. The server keeps the highest one and drops anything older (latest frame wins).
- `capturedAt`: epoch milliseconds **in server time**. The phone computes `offset = serverTime - Date.now()` from the session response and adds it, because phone and server clocks drift. Input older than `maxInputAgeMs` is rejected.
- Auth: `POST /v1/sessions` returns a `sessionToken`. Send it as `Authorization: Bearer <token>`. `EventSource` cannot set headers, so the SSE URL uses `?token=`. The server redacts it from access logs.
- Route step and destination IDs are fixed strings from the server's route definition, for example `start`, `corridor`, `counter`.

Shared types:

```ts
type Action = "wait" | "turn" | "continue" | "arrived" | "stop";
type Direction = "left" | "right" | "around" | null; // only set when action = "turn"
type Phase = "awaiting_destination" | "navigating" | "arrived" | "stopped";
```

## 1. Phone ↔ Orchestrator

### `GET /v1/health`

For S00. No auth.

```json
200 { "status": "ok", "version": "0.1.0" }
```

### `POST /v1/sessions`

Starts a session after the double tap or Start button. No body.

```json
201 {
  "sessionId": "6f1c…",
  "sessionToken": "…",
  "generation": 1,
  "serverTime": 1791561600000,
  "phase": "awaiting_destination",
  "route": {
    "routeId": "itnig-demo",
    "startStepId": "start",
    "destinations": [
      { "destinationId": "counter", "label": "coffee counter" },
      { "destinationId": "bathroom", "label": "bathroom" }
    ]
  },
  "limits": {
    "maxAudioMs": 10000,
    "maxAudioBytes": 1000000,
    "maxFrameBytes": 512000,
    "maxFrameEdgePx": 1280,
    "maxInputAgeMs": 3000,
    "heartbeatMs": 5000
  }
}
```

The phone speaks the destination prompt itself, built from `destinations[].label`.

### `GET /v1/sessions/{sessionId}/events?token=…`

Server-sent events. On every connect or reconnect the server first sends a `state` event, so the phone can resync without a replay. See [SSE events](#sse-events).

### `POST /v1/sessions/{sessionId}/utterances`

A spoken command: the destination, or "cancel". `multipart/form-data`:

| Part | Type | Required |
| --- | --- | --- |
| `meta` | JSON `{ requestId, generation, sequence, capturedAt }` | yes |
| `audio` | `audio/webm` (Chrome) or `audio/mp4` (Safari), at most `maxAudioMs` | one of `audio`/`transcript` |
| `transcript` | text; for fixtures, tests and browser STT | one of `audio`/`transcript` |
| `frame` | `image/jpeg`; used as the first navigation frame if the command is `start` | no |

```json
202 { "requestId": "…", "accepted": true }
```

The outcome arrives on SSE: `needs_input`, `state` (phase `navigating`) followed by `guidance` or `heartbeat`, or `stop`.

### `POST /v1/sessions/{sessionId}/frames`

One camera frame while `navigating`. `multipart/form-data`:

| Part | Type | Required |
| --- | --- | --- |
| `meta` | JSON `{ requestId, generation, sequence, capturedAt, clientRouteStepId }` | yes |
| `frame` | `image/jpeg`, at most `maxFrameBytes` and `maxFrameEdgePx` | yes |

`clientRouteStepId` is the step the phone last received. It is only for diagnosis, since the server owns route state. A mismatch is logged in the trace.

```json
202 { "requestId": "…", "accepted": true }
```

The phone sends the next frame after it gets the 202, so at most one upload is in flight. The server also drops a frame if a newer one arrives before navigation starts on it.

### `POST /v1/sessions/{sessionId}/stop`

```json
{ "requestId": "…", "generation": 3 }
```

```json
200 { "sessionId": "…", "generation": 4, "phase": "stopped" }
```

Stop always wins. It succeeds even with an old `generation` and is idempotent. The phone silences TTS and releases capture **before** sending it and does not wait for the reply. The server cancels in-flight model calls and sends a final `stop` event.

### `POST /v1/sessions/{sessionId}/retry`

For S10. It resumes from a state the server knows.

```json
{ "requestId": "…", "generation": 4, "from": "destination_prompt" }
```

Like stop, retry accepts any `generation`, because an `error` event also increments it. `from`: `destination_prompt` returns to `awaiting_destination` at `startStepId`. `last_confirmed_step` returns to `navigating` at the last step the route logic validated.

```json
200 { "sessionId": "…", "generation": 5, "phase": "navigating", "routeStepId": "corridor", "destinationId": "counter" }
```

### `GET /v1/sessions/{sessionId}/trace`

For S08, the debug panel. Uses the same bearer token.

```json
200 { "sessionId": "…", "entries": [ TraceEntry, … ] }
```

See [Run trace entry](#run-trace-entry).

### HTTP errors

All non-2xx responses use the same body:

```json
{ "error": { "code": "stale_generation", "message": "Session was stopped.", "retryable": false } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | Missing part, invalid `meta` |
| 401 | `unauthorized` | Missing or wrong token |
| 404 | `session_not_found` | Unknown or expired session |
| 409 | `stale_generation` | `generation` is not the current one (except stop) |
| 409 | `stale_sequence` | A newer `sequence` was already received |
| 409 | `not_navigating` | Frame sent outside `navigating` |
| 413 | `payload_too_large` | Above `limits` |
| 415 | `unsupported_media_type` | Audio or image type not listed |
| 422 | `expired_input` | `capturedAt` older than `maxInputAgeMs` |
| 429 | `rate_limited` | Too many requests for this session |
| 503 | `upstream_unavailable` | VLA or Jev API unreachable |

## SSE events

Every event's `data` contains the envelope, plus the fields for its type:

```ts
{ type, eventId: string, sessionId, generation, requestId: string | null, emittedAt: number }
```

The phone ignores any event whose `generation` is not its current one. That is how late results are blocked after Stop.

| `type` | Extra fields | Phone does |
| --- | --- | --- |
| `state` | `phase, routeStepId, destinationId \| null` | Resync |
| `needs_input` | `reason: "empty" \| "unsupported" \| "unclear"`, `text` | Speak `text`, listen again |
| `guidance` | see below | Speak `text` once per `guidanceId` |
| `heartbeat` | `phase, routeStepId, lastRequestId \| null, quietReason \| null` | Nothing spoken. Proves the connection is alive |
| `stop` | `reason: "user_stop" \| "voice_cancel" \| "arrived" \| "error"` | Stop capture and speech |
| `error` | `code, stage, text, retryable` | Speak `text` ("Guidance is unavailable."), go to `stopped`, offer retry |

`guidance`:

```json
{
  "type": "guidance",
  "guidanceId": "…",
  "text": "Turn left at the coffee machine.",
  "action": "turn",
  "direction": "left",
  "routeStepId": "corridor",
  "nextRouteStepId": "counter",
  "uncertain": false,
  "debug": { "engine": "vla:<name>", "timingsMs": { "upload": 180, "navigate": 900, "decide": 1, "write": 400, "total": 1500 } }
}
```

`text` is at most 240 characters. `debug` is shown only in the debug panel, never spoken. `heartbeat` is sent for a frame the decider kept quiet (`quietReason` set) and every `heartbeatMs` when nothing else was sent. With no event for `3 × heartbeatMs`, the phone treats the connection as lost.

### Client states driven by these contracts

| From | Trigger | To |
| --- | --- | --- |
| idle | Start, `POST /sessions` 201 | prompting |
| prompting | Prompt finished speaking | listening |
| listening | Recording ends, `POST /utterances` 202 | waiting |
| waiting | `guidance` or `needs_input` | speaking |
| waiting | `heartbeat` | waiting |
| speaking | TTS done, phase `navigating` | waiting (frame loop continues) |
| speaking | TTS done after `needs_input` | listening |
| speaking | TTS done after `action: "arrived"` | stopped |
| any | Stop tap, `stop` event, `error` event, connection lost | stopped |
| stopped | Retry, `POST /retry` 200 | prompting (`destination_prompt`) or waiting (`last_confirmed_step`) |

## 2. Orchestrator ↔ Navigation engine (VLA)

`POST http://<gpu-host>:<port>/v1/navigate`, internal only. `multipart/form-data`:

- `meta`: JSON

  ```json
  {
    "requestId": "…",
    "destinationId": "counter",
    "routeStepId": "corridor",
    "allowedNextStepIds": ["counter"],
    "stepHint": "Coffee machine on the left, counter ahead."
  }
  ```

- `frame`: `image/jpeg`, passed through unchanged.

```json
200 {
  "action": "turn",
  "direction": "left",
  "proposedNextStepId": "counter",
  "confidence": 0.82,
  "observation": "coffee machine visible on the left",
  "modelMs": 870
}
```

The orchestrator validates every response before using it:

- If `proposedNextStepId` is not `routeStepId` or one of `allowedNextStepIds`, the step stays where it is and the action becomes `wait`.
- `confidence` below `MIN_CONFIDENCE` (0.5) becomes `wait` with `uncertain: true`, and the writer asks for a clearer view.
- `observation` goes to the trace only.
- Timeout 4 s: that frame is dropped. Three failures in a row send an `error` event with stage `navigate`.

## 3. Orchestrator ↔ Jev API

The decision LLMs run through the Jev API. Its wire format is not in this repo yet, so this section defines the JSON each call puts in and must get back. One adapter in the orchestrator maps these to Jev requests and asks for structured or JSON output. `JEV_API_KEY` and `JEV_BASE_URL` live only in server env. Prompts, the key and raw audio never go into the trace.

Any Jev output that does not parse or fails validation is handled as described for each call. No call can move route state.

### Speech to text (open point 1)

If the Jev API accepts audio, the Command call gets the audio directly. Otherwise an STT step runs first and produces `{ "transcript": string, "sttMs": number }`. Either way, the Command contract below takes the transcript. An empty transcript skips the call and sends `needs_input` with `reason: "empty"`.

### Command LLM

Runs once per utterance.

```json
in  { "transcript": "take me to the coffee", "phase": "awaiting_destination",
      "destinations": [ { "destinationId": "counter", "label": "coffee counter", "aliases": ["coffee", "bar"] },
                        { "destinationId": "bathroom", "label": "bathroom", "aliases": ["toilet", "restroom"] } ] }
out { "command": "start", "destinationId": "counter", "confidence": 0.93 }
```

- `command` is `start`, `cancel` or `unsupported`.
- A `destinationId` that is not in the list counts as `unsupported`.
- Invalid output, or a timeout after 3 s, sends `needs_input` with `reason: "unclear"`.

### Utterance decider

Starts as rules in the orchestrator. If it moves to the Jev API, the contract stays the same.

```json
in  { "action": "turn", "direction": "left", "routeStepId": "corridor", "uncertain": false,
      "lastSpoken": { "action": "continue", "routeStepId": "corridor", "text": "Keep going straight.", "msAgo": 4200 } }
out { "speak": true, "reason": "action_changed" }
```

The rules speak when the action changed, the step changed, `uncertain` was not already spoken, or `msAgo ≥ REPEAT_MS` (7000). `stop` and `arrived` are always spoken. An LLM failure falls back to these rules.

### Utterance writer

```json
in  { "action": "turn", "direction": "left", "routeStepId": "corridor", "destinationLabel": "coffee counter",
      "stepHint": "Coffee machine on the left, counter ahead.", "uncertain": false }
out { "text": "Turn left at the coffee machine." }
```

`text` must be non-empty and at most 240 characters. If it is invalid, or the call times out after 2 s, the orchestrator uses a fixed template for that action, such as "Turn left." or "Please hold still, I need a clearer view." Guidance never stops because the writer failed.

## Run trace entry

No media, tokens or prompts.

```ts
{
  at: number, sessionId: string, generation: number, requestId: string,
  kind: "utterance" | "frame" | "stop" | "retry",
  clientRouteStepId: string | null, routeStepId: string, destinationId: string | null,
  transcript: string | null, command: string | null,
  engine: string, action: Action | null, confidence: number | null, observation: string | null,
  spoke: boolean, text: string | null,
  timingsMs: { upload?: number, stt?: number, command?: number, navigate?: number, decide?: number, write?: number, total: number },
  dropped: "stale_generation" | "stale_sequence" | "expired_input" | "superseded" | null,
  error: string | null
}
```
