# HTTP contracts

Status: draft for S01 team review. Derived from [architecture.md](architecture.md). Every limit and timeout below is a starting value that we tune on the demo phone, not a measured result.

Four boundaries:

1. Phone ↔ Orchestrator: public HTTPS through the tunnel.
2. Orchestrator ↔ Navigation engine: internal HTTP, not exposed to the phone. Not implemented by nav-engine yet, see [architecture.md](architecture.md#navigation-engine-nav-engine).
3. Orchestrator ↔ Jev (TypeSafe): the Command step. Server-side only.
4. Orchestrator ↔ ElevenLabs: speech to text (Scribe) and text to speech (Flash). Server-side only. See [section 4](#4-orchestrator--elevenlabs).

Two levels of state:

- A **client** is one phone from Start to Stop. It holds the token and the event stream.
- A **session** is one spoken action: guidance to one destination. When speech-to-text gives a different action from the current session, the orchestrator starts a new session with an empty frame buffer and no previous output. The same action again keeps the current session.

## Conventions

- Base path `/v1`. JSON bodies, UTF-8, camelCase.
- IDs are UUID v4 strings. The server creates `clientId` and `sessionId`. The phone creates a `requestId` for every POST. A repeated `requestId` returns the original response and is not processed again.
- `generation`: integer that starts at 1. The server increments it on stop, retry, error and every new session. The phone learns the new value from the event envelope. Every POST and every SSE event carries it. Results from an older generation are dropped on both sides.
- `sequence`: integer the phone increments on each input or frame for the client. The server keeps the highest one and drops anything older (latest frame wins).
- `capturedAt`: epoch milliseconds **in server time**. The phone computes `offset = serverTime - Date.now()` from the client response and adds it, because phone and server clocks drift. Input older than `maxInputAgeMs` is rejected.
- Auth: `POST /v1/clients` returns a `clientToken`. Send it as `Authorization: Bearer <token>`. `EventSource` cannot set headers, so the SSE URL uses `?token=`. The server redacts it from access logs.
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

### `POST /v1/clients`

Called after the double tap or Start button. No body. No session exists until the user says a destination.

```json
201 {
  "clientId": "6f1c…",
  "clientToken": "…",
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
    "heartbeatMs": 5000,
    "navFrames": 5
  }
}
```

The phone builds the destination prompt from `destinations[].label` and plays it through [`GET /speech`](#get-v1clientsclientidspeechtokentext).

### `GET /v1/clients/{clientId}/events?token=…`

Server-sent events. On every connect or reconnect the server first sends a `state` event, so the phone can resync without a replay. See [SSE events](#sse-events).

### `POST /v1/clients/{clientId}/inputs`

A spoken command as recorded audio: a destination, or "cancel". The orchestrator runs speech-to-text, then Jev. `multipart/form-data`:

| Part | Type | Required |
| --- | --- | --- |
| `meta` | JSON `{ requestId, generation, sequence, capturedAt }` | yes |
| `audio` | `audio/webm` (Chrome) or `audio/mp4` (Safari), at most `maxAudioMs` | yes |
| `frame` | `image/jpeg`; the first frame of the session's buffer | no |

```json
202 { "requestId": "…", "accepted": true }
```

The outcome arrives on SSE:

- A new action sends `state` with a new `sessionId` and a new `generation`, then `guidance` or `heartbeat` for each frame.
- The same action as the current session sends `state` with the same `sessionId` and `generation`.
- `cancel` sends `stop`. Anything unclear sends `needs_input`.

### `POST /v1/clients/{clientId}/frames`

One camera frame while `navigating`. It joins the current session's buffer of the last `navFrames` (5) frames. `multipart/form-data`:

| Part | Type | Required |
| --- | --- | --- |
| `meta` | JSON `{ requestId, generation, sequence, capturedAt, clientRouteStepId }` | yes |
| `frame` | `image/jpeg`, at most `maxFrameBytes` and `maxFrameEdgePx` | yes |

`clientRouteStepId` is the step the phone last received. It is only for diagnosis, since the server owns route state. A mismatch is logged in the trace.

```json
202 { "requestId": "…", "accepted": true }
```

The phone sends the next frame after it gets the 202, so at most one upload is in flight. Only the newest frame triggers an evaluation. If a newer frame arrives before evaluation starts, the older one is not evaluated but stays in the buffer.

### `GET /v1/clients/{clientId}/speech?token=…&text=…`

Text to speech for anything the phone says: the destination prompt, and the `text` of `guidance`, `needs_input` and `error` events. The orchestrator proxies ElevenLabs and streams the audio back, so the ElevenLabs key never reaches the phone. It is a GET with the token in the query, like the SSE URL, so the phone can set it as the `src` of one reused `<audio>` element and playback starts while the audio is still arriving.

- `text`: URL-encoded, at most 240 characters, otherwise `400 bad_request`.
- `200`, `Content-Type: audio/mpeg`, chunked. MP3 because Safari and Chrome both play it from a plain `<audio>` element.
- `X-Speech-Text`: the exact text sent to ElevenLabs, percent-encoded UTF-8 (`decodeURIComponent` reads it). Exposed through CORS, so a `fetch` can read it. A plain `<audio>` element cannot read headers.
- The orchestrator caches audio by `text` in memory. The sentence templates and the prompt are a small fixed set, so after the first time they cost no ElevenLabs call and no TTS latency.
- On any non-2xx, or if `<audio>` fails to play, the phone speaks the same text with browser `speechSynthesis` (`output/browserSpeech.ts`). Speech never blocks guidance.
- Stop: the phone calls `audio.pause()` and clears `src` before `POST /stop`, which also aborts the download.
- Audio unlock: the Start tap plays the `<audio>` element once (iOS Safari only plays audio started inside a user gesture), then later playback is allowed.

### `POST /v1/clients/{clientId}/stop`

```json
{ "requestId": "…", "generation": 3 }
```

```json
200 { "clientId": "…", "generation": 4, "phase": "stopped", "sessionId": "…", "destinationId": "counter", "routeStepId": "corridor" }
```

Stop always wins. It succeeds even with an old `generation` and is idempotent. The phone silences TTS and releases capture **before** sending it and does not wait for the reply. The server cancels in-flight model calls and sends a final `stop` event.

### `POST /v1/clients/{clientId}/retry`

For S10. It resumes from a state the server knows.

```json
{ "requestId": "…", "generation": 4, "from": "destination_prompt" }
```

Like stop, retry accepts any `generation`, because an `error` event also increments it. `from`: `destination_prompt` returns to `awaiting_destination`. `destination_prompt` ends the session. `last_confirmed_step` keeps the same session and returns to `navigating` at the last step the route logic validated, with an empty frame buffer and no previous output.

```json
200 { "clientId": "…", "generation": 5, "phase": "navigating", "sessionId": "…", "destinationId": "counter", "routeStepId": "corridor" }
```

### `GET /v1/clients/{clientId}/trace`

For S08, the debug panel. Uses the same bearer token.

```json
200 { "clientId": "…", "entries": [ TraceEntry, … ] }
```

See [Run trace entry](#run-trace-entry).

### `POST /v1/logs`

Debug lines from the phone, for Cloud Logging. No token, because the failures worth seeing (denied permission, no camera, blocked site) happen before `POST /v1/clients`. The orchestrator prints each entry as one structured line with `kind: "client_log"`, next to its own trace, so one query shows both sides of a session. Debug only: no media, tokens or transcripts.

```json
{
  "deviceId": "uuid kept in localStorage",
  "clientId": "6f1c…",
  "entries": [
    { "at": 1791561600000, "level": "error", "event": "stop", "detail": "error: NotAllowedError: Permission denied (microphone=denied)" }
  ]
}
```

- `clientId` is null until `POST /v1/clients` has answered. `level` is `info`, `warn` or `error`. `at` is local epoch milliseconds.
- At most 16 KB and 50 entries per batch. Strings are truncated (`event` 64, `detail` 1000). Over the limit: `413 payload_too_large` or `400 bad_request`.
- The orchestrator caps the whole server at 120 batches a minute (`429 rate_limited`).
- `204` on success. The phone ignores every failure, and an orchestrator without this route is fine.
- The phone sends `Content-Type: text/plain` so the request is "simple" (no CORS preflight), which also lets `sendBeacon` deliver the last batch on page hide. The body is still JSON.

### HTTP errors

All non-2xx responses use the same body:

```json
{ "error": { "code": "stale_generation", "message": "Session was stopped.", "retryable": false } }
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | Missing part (including `audio`), invalid `meta` |
| 401 | `unauthorized` | Missing or wrong token |
| 404 | `client_not_found` | Unknown client |
| 409 | `stale_generation` | `generation` is not the current one, for example after a new session (except stop and retry) |
| 409 | `stale_sequence` | A newer `sequence` was already received |
| 409 | `not_navigating` | Frame sent with no active session |
| 413 | `payload_too_large` | Above `limits` |
| 415 | `unsupported_media_type` | Audio or image type not listed |
| 422 | `expired_input` | `capturedAt` older than `maxInputAgeMs` |
| 429 | `rate_limited` | Too many requests for this client |
| 503 | `upstream_unavailable` | Navigation engine, ElevenLabs or Jev unreachable |

## SSE events

Every event's `data` contains the envelope, plus the fields for its type:

```ts
{ type, eventId: string, clientId, sessionId: string | null, generation, requestId: string | null, emittedAt: number }
```

The phone ignores any event whose `generation` is older than its current one, and adopts a newer one from `state`. That is how late results are blocked after Stop or a session change.

| `type` | Extra fields | Phone does |
| --- | --- | --- |
| `state` | `phase, sessionId, destinationId, routeStepId` (null without a session) | Resync. A new `sessionId` means a new action started |
| `needs_input` | `reason: "empty" \| "unsupported" \| "unclear"`, `text` | Speak `text`, listen again |
| `guidance` | see below | Speak `text` once per `guidanceId` |
| `heartbeat` | `state` fields, `lastRequestId \| null, quietReason \| null` | Nothing spoken. Proves the connection is alive |
| `stop` | `reason: "user_stop" \| "voice_cancel" \| "arrived" \| "error"` | Stop capture and speech |
| `error` | `code, stage, text, retryable` | Speak `text` ("Guidance is unavailable."), go to `stopped`, offer retry |
| `log` | `kind` (the trace entry's `kind`), `entry` ([Run trace entry](#run-trace-entry)) | Nothing spoken. Debug panel only. Sent only when the server runs with `DEBUG_PAGE`, never in production |

`guidance`:

```json
{
  "type": "guidance",
  "guidanceId": "…",
  "text": "Turn left.",
  "action": "turn",
  "direction": "left",
  "routeStepId": "corridor",
  "nextRouteStepId": "counter",
  "uncertain": false,
  "debug": { "engine": "vla:<name>", "timingsMs": { "upload": 180, "navigate": 900, "total": 1100 } }
}
```

`text` is at most 240 characters. `debug` is shown only in the debug panel, never spoken. `heartbeat` is sent for a frame the worker kept quiet (`quietReason: "unchanged"`) and every `heartbeatMs` when nothing else was sent. With no event for `3 × heartbeatMs`, the phone treats the connection as lost.

### Client states driven by these contracts

| From | Trigger | To |
| --- | --- | --- |
| idle | Start, `POST /clients` 201 | prompting |
| prompting | Prompt finished speaking | listening |
| listening | Recording ends, `POST /inputs` 202 | waiting |
| waiting | `state` with a new `sessionId` | waiting (adopt the new `generation`, frame loop starts) |
| waiting | `guidance` or `needs_input` | speaking |
| waiting | `heartbeat` | waiting |
| speaking | TTS done, phase `navigating` | waiting (frame loop continues) |
| speaking | TTS done after `needs_input` | listening |
| speaking | TTS done after `action: "arrived"` | stopped |
| any | Stop tap, `stop` event, `error` event, connection lost | stopped |
| stopped | Retry, `POST /retry` 200 | prompting (`destination_prompt`) or waiting (`last_confirmed_step`) |

## 2. Orchestrator ↔ Navigation engine

Status: no service implements this endpoint yet. Staging uses the fake in `orient-orchestrator/examples/fakes.rs`. [nav-engine](https://github.com/tungsten-united/nav-engine) has the map and the routing and step-tracking reference code it would be built from; see [architecture.md](architecture.md#navigation-engine-nav-engine).

`POST http://<gpu-host>:<port>/v1/navigate`, internal only. Each call carries the session's last `NAV_FRAMES` (5) frames, oldest first. At the start of a session there are fewer, from 1 up to 5. `multipart/form-data`:

- `meta`: JSON. `frames` lists the images in the same order as the `frames` parts.

  ```json
  {
    "requestId": "…",
    "sessionId": "…",
    "destinationId": "counter",
    "routeStepId": "corridor",
    "allowedNextStepIds": ["counter"],
    "stepHint": "Coffee machine on the left, counter ahead.",
    "frames": [
      { "requestId": "…", "capturedAt": 1791561600000 },
      { "requestId": "…", "capturedAt": 1791561600800 }
    ]
  }
  ```

- `frames`: one `image/jpeg` part per frame, repeated under the same name, oldest first. Images are passed through unchanged.

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
- `confidence` below `MIN_CONFIDENCE` (0.5) becomes `wait` with `uncertain: true`, and the template asks for a clearer view.
- `observation` goes to the trace only.
- Timeout 4 s: that evaluation is dropped. Three failures in a row in a session send an `error` event with stage `navigate`.

The validated result is an **output**: `{ action, direction, step, uncertain }`. The worker compares it with the session's previous output, as described in [Worker](#worker-speak-or-stay-quiet).

## 3. Orchestrator ↔ Jev (TypeSafe)

[Jev](https://docs.typesafe.ai/introduction) is TypeSafe's decision model. It takes a `state` and typed questions and returns calibrated answers: Choice, Score or Noul. It does not generate text. So Jev handles the Command step. The worker's speak-or-stay-quiet rule is code, and the sentences are templates.

`POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer $TYPESAFE_API_KEY`. The key lives only in server env. The key and raw audio never go into the trace. TypeSafe returns `401` for a bad key, `422` for a bad request, and `429` or `529` when overloaded. Any failure is handled as described for each call. No call can move route state.

### Speech to text

The phone always sends audio, and Jev takes text or JSON state, not audio. So the orchestrator runs ElevenLabs Scribe first and passes its `text` to Jev as `spokenRequest`. The exact call is in [section 4](#speech-to-text-scribe-v2). An STT failure sends an `error` event with stage `stt`. An empty transcript skips Jev and sends `needs_input` with `reason: "empty"`.

### Command: one Choice question

Runs once per input. The options are each destination ID plus `cancel` and `unsupported`. The option descriptions are built from the route definition.

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

- `choice` is a destination ID, or `cancel`, which sends a `stop` event with `voice_cancel`, or `unsupported`, which sends `needs_input` with `reason: "unsupported"`.
- A destination ID that differs from the current session's destination starts a new session. The same destination keeps the current session. After Stop or arrival, any destination starts a new session.
- `confidence` below `JEV_MIN_CONFIDENCE` (0.5) sends `needs_input` with `reason: "unclear"`. A low-confidence answer is never acted on.
- An HTTP error, an unknown `choice`, or a timeout after 3 s also sends `needs_input` with `reason: "unclear"`.
- With no `TYPESAFE_API_KEY` set, the orchestrator matches keywords from the route aliases instead. This is for local development.

## Worker: speak or stay quiet

One worker per client evaluates the newest frame. It calls the navigation engine with the session's last 5 frames, validates the answer into an output, and compares that output with the session's **previous output**:

```json
previous { "action": "continue", "direction": null, "step": "corridor", "uncertain": false }
output   { "action": "turn", "direction": "left", "step": "corridor", "uncertain": false }
→ speak, reason "changed"
```

- There is no previous output (first evaluation in the session): send `guidance`, reason `first`.
- Any field differs: send `guidance` with the template sentence, reason `changed`.
- All fields are equal: send `heartbeat` with `quietReason: "unchanged"`. As a reminder, the same output is spoken again once `REPEAT_MS` (7000) has passed since the last spoken message.

Every output becomes the new previous output, whether it was spoken or not. A new session starts with no previous output.

### Sentence templates

Jev does not write sentences, so the orchestrator uses a fixed sentence for each action: "Turn left.", "Keep going straight.", "You have arrived at the coffee counter.", "Wait a moment." or "Please hold still, I need a clearer view." Templates are instant, never fail, and stay within the 240-character limit.

## 4. Orchestrator ↔ ElevenLabs

One vendor and one key for both directions. `ELEVENLABS_API_KEY` lives only in server env (Secret Manager on Cloud Run) and is sent as the `xi-api-key` header. The key, raw audio and transcripts of failed calls never go into the trace.

| Env var | Starting value | Use |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | secret | Both calls |
| `ELEVENLABS_STT_MODEL` | `scribe_v2` | Speech to text |
| `ELEVENLABS_TTS_MODEL` | `eleven_flash_v2_5` | Text to speech, the lowest-latency model |
| `ELEVENLABS_VOICE_ID` | picked by the output owner (S06) from the voice library | Text to speech |
| `SPEECH_LANGUAGE` | `en` | Sent to both, so Scribe skips language detection |

### Speech to text: Scribe v2

`POST https://api.elevenlabs.io/v1/speech-to-text`, `multipart/form-data`:

| Part | Value |
| --- | --- |
| `model_id` | `$ELEVENLABS_STT_MODEL` |
| `file` | The phone's `audio` part as received, `audio/webm` or `audio/mp4`. Scribe accepts both, so no transcoding. |
| `language_code` | `$SPEECH_LANGUAGE` |
| `tag_audio_events` | `false` |

```json
200 { "language_code": "en", "language_probability": 0.98, "text": "take me to the coffee", "words": [ … ] }
```

- Only `text` is used. It is trimmed; empty means `needs_input` with `reason: "empty"`.
- Timeout 5 s. `401`, `422`, `429`, `5xx` or a timeout send an `error` event with stage `stt`, `retryable: true`.
- This is the batch endpoint, one call per recorded input, which matches `POST /inputs`. Scribe v2 Realtime (WebSocket, partial transcripts) exists, but only pays off with always-listening input, which is out of scope.

### Text to speech: Flash v2.5

`POST https://api.elevenlabs.io/v1/text-to-speech/$ELEVENLABS_VOICE_ID/stream?output_format=mp3_44100_64`

```json
{ "text": "Turn left.", "model_id": "eleven_flash_v2_5", "language_code": "en" }
```

- `200` is a chunked MP3 stream. The orchestrator pipes it straight into the `GET /speech` response and keeps a copy in the cache once it completes.
- Timeout 3 s to the first byte. Any failure returns `503 upstream_unavailable` from `GET /speech`, and the phone falls back to browser TTS.
- `voice_settings` are left at the voice's stored defaults. Tune `speed` there if guidance feels slow on the demo phone.

### Wispr Flow: evaluated, not used

Wispr Flow was considered for speech to text and rejected for the demo:

- No self-serve API. The developer page has no public docs; access is by emailing `enterprise@wisprflow.ai` for a key, billed on an enterprise account.
- The one known model, `flow-v1`, is built for dictation into apps (cleanup and formatting of long text), not for short spoken commands.
- Integrations transcode audio with ffmpeg first, so it likely does not take the phone's webm/mp4 directly. Request format and latency are unpublished.
- ElevenLabs is already needed for TTS, so Scribe adds no new vendor, key or bill.

Revisit only if Scribe fails the S03 acceptance on the S01b venue clips and Wispr grants a key in time.

## Run trace entry

No media, tokens or prompts.

```ts
{
  at: number, clientId: string, sessionId: string | null, generation: number, requestId: string,
  kind: "client" | "input" | "frame" | "stop" | "retry",
  clientRouteStepId: string | null, routeStepId: string, destinationId: string | null,
  transcript: string | null, command: string | null,
  engine: string, framesSent: number | null, action: Action | null, confidence: number | null, observation: string | null,
  spoke: boolean, text: string | null,
  timingsMs: { upload?: number, stt?: number, command?: number, navigate?: number, tts?: number, total: number },
  dropped: "stale_generation" | "stale_sequence" | "expired_input" | "superseded" | null,
  error: string | null
}
```
