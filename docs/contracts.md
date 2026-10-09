# HTTP contracts

Status: draft for S01 team review. Derived from [architecture.md](architecture.md). Every limit and timeout below is a starting value that we tune on the demo phone, not a measured result.

Three boundaries:

1. Phone ↔ Orchestrator: public HTTPS through the tunnel.
2. Orchestrator ↔ Navigation engine (VLA): internal HTTP on the GPU server, not exposed through the tunnel.
3. Orchestrator ↔ Jev (TypeSafe): the Command step, and the Utterance decider if it ever moves off rules. Server-side only.

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
| 503 | `upstream_unavailable` | VLA, STT or Jev unreachable |

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

## 3. Orchestrator ↔ Jev (TypeSafe)

[Jev](https://docs.typesafe.ai/introduction) is TypeSafe's decision model. It takes a `state` and typed questions and returns calibrated answers: Choice, Score or Noul. It does not generate text. So Jev handles the Command step. The decider stays as rules for now, and the writer uses templates.

`POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`. The key lives only in server env. The key and raw audio never go into the trace. TypeSafe returns `401` for a bad key, `422` for a bad request, and `429` or `529` when overloaded. Any failure is handled as described for each call. No call can move route state.

### Speech to text (open point 1)

Jev takes text or JSON state, not audio. So an STT step runs first and produces `{ "transcript": string, "sttMs": number }`, or the phone sends a `transcript`. An empty transcript skips Jev and sends `needs_input` with `reason: "empty"`.

### Command: one Choice question

Runs once per utterance. The options are each destination ID plus `cancel` and `unsupported`. The option descriptions are built from the route definition.

```json
{
  "model": "jev-latest",
  "state": { "spokenRequest": "take me to the coffee", "sessionPhase": "awaiting_destination" },
  "questions": {
    "command": {
      "type": "choice",
      "instructions": "What is the blind user asking for in this spoken request? They are being guided indoors and can only be taken to the listed places.",
      "criteria": {
        "counter": "Wants to go to the coffee counter, for example: coffee, counter, bar.",
        "bathroom": "Wants to go to the bathroom, for example: bathroom, toilet, restroom, wc.",
        "cancel": "Wants to stop, cancel or end the guidance.",
        "unsupported": "Wants something else: another place, a question, or nothing clear."
      }
    }
  }
}
```

```json
200 {
  "model": "jev-1.13.0",
  "answers": {
    "command": { "type": "choice", "choice": "counter", "confidence": 0.86,
                 "probabilities": { "counter": 0.9, "bathroom": 0.02, "cancel": 0.0, "unsupported": 0.08 } }
  },
  "usage": { "input_tokens": 180, "output_tokens": 12 }
}
```

- `choice` is a destination ID, which starts navigation, or `cancel`, which sends a `stop` event with `voice_cancel`, or `unsupported`, which sends `needs_input` with `reason: "unsupported"`.
- `confidence` below `JEV_MIN_CONFIDENCE` (0.5) sends `needs_input` with `reason: "unclear"`. A low-confidence answer is never acted on.
- An HTTP error, an unknown `choice`, or a timeout after 3 s also sends `needs_input` with `reason: "unclear"`.
- With no `TYPESAFE_API_KEY` set, the orchestrator matches keywords from the route aliases instead. This is for local development.

### Utterance decider: rules

```json
in  { "action": "turn", "direction": "left", "routeStepId": "corridor", "uncertain": false,
      "lastSpoken": { "action": "continue", "routeStepId": "corridor", "msAgo": 4200 } }
out { "speak": true, "reason": "action_changed" }
```

The rules speak when the action changed, the step changed, `uncertain` was not already spoken, or `msAgo ≥ REPEAT_MS` (7000). `stop` and `arrived` are always spoken. If the rules prove too rigid, this becomes a Jev Noul question: "should the user be told something now?". The orchestrator would speak when `noul ≥ 0.5`, and fall back to the rules on failure.

### Utterance writer: templates

Jev does not write sentences, so the orchestrator uses a fixed sentence for each action: "Turn left.", "Keep going straight.", "You have arrived at the coffee counter.", "Wait a moment." or "Please hold still, I need a clearer view." Templates are instant, never fail, and stay within the 240-character limit.

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
