# HTTP contracts

Status: draft for S01 team review. Derived from [architecture.md](architecture.md). Every limit and timeout below is a starting value that we tune on the demo phone, not a measured result.

Four boundaries:

1. Phone ↔ Orchestrator: public HTTPS through the tunnel.
2. Orchestrator ↔ Navigation engine: nav-engine's nav-api, server to server over HTTPS with nav-api's token. Never exposed to the phone. See [section 2](#2-orchestrator--navigation-engine) and [architecture.md](architecture.md#navigation-engine-nav-engine).
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
- Destination IDs are node ids of the venue map, listed in the server's route definition, and route step IDs are the user's node on that map ([section 2](#2-orchestrator--navigation-engine)). The examples below use readable ids such as `corridor` and `counter`; the Itnig map's ids are `n1` to `n10`.

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
    "navFrames": 4
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

One camera frame while `navigating`. It joins the current session's buffer of the last `navFrames` (4) frames. `multipart/form-data`:

| Part | Type | Required |
| --- | --- | --- |
| `meta` | JSON `{ requestId, generation, sequence, capturedAt, clientRouteStepId }` | yes |
| `frame` | `image/jpeg`, at most `maxFrameBytes` and `maxFrameEdgePx` | yes |

`clientRouteStepId` is the step the phone last received. It is only for diagnosis, since the server owns route state. A mismatch is logged in the trace.

```json
202 { "requestId": "…", "accepted": true }
```

The phone sends the next frame after it gets the 202, so at most one upload is in flight. An evaluation sends `localize` every buffered frame it has not sent before (at most 4), so each frame is scored once and a frame that arrives during a call goes with the next one.

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

### Motion (proposed, pending team review)

An optional `motion` field in the `meta` JSON of `POST /inputs` and `POST /frames`, so the navigation engine knows how the phone is moving. `null` when the sensors are denied or unsupported. The phone estimates it with the same step detector and camera-heading formula as the nav-engine recorder (`frontend/app.js`, `STEP` constants and `cameraHeading`).

```ts
interface Motion {
  speedMps: number | null;        // steps in the last 4 s / 4 x stepLengthM. null until 3 steps seen, 0 standing
  cadenceHz: number;              // steps per second over the same window
  stepCount: number;              // since Start
  stepLengthM: number;            // 0.7 by default
  headingDeg: number | null;      // rear-camera axis, degrees clockwise from north
  headingSource: "compass_ios" | "orientation_absolute" | null;
  headingAccuracyDeg: number | null;   // iOS webkitCompassAccuracy
  orientation: { alpha: number; beta: number; gamma: number; absolute: boolean } | null;
  measuredAt: number;             // newest sensor sample, server time like capturedAt
}
```

The orchestrator passes each frame's whole `motion` on to `localize`, with the step count at the user's last node change ([section 2](#post-mapsmap_idlocalize)): nav-api leaves out frames pointed at the floor or ceiling and only counts a node the user can have walked to. The newest frame's `headingDeg` also goes as `heading_deg`; nav-api reports the heading against each reference, without scoring with it. The live speed is a 4 s window average and reports nothing before 3 steps. The indoor compass is noisy, which is why the raw angles are included.

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
  "debug": { "engine": "nav-engine", "timingsMs": { "upload": 180, "localize": 600, "route": 40, "jev": 300, "total": 1150 } }
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

The navigation engine is [nav-engine](https://github.com/tungsten-united/nav-engine)'s **nav-api**, the read-only live API over the venue's published map: `https://nav-api-613464313064.europe-southwest1.run.app/api/v1` (`NAV_URL`). Every call carries nav-api's token as `Authorization: Bearer $NAV_API_TOKEN`. The map is `NAV_MAP_ID` (`itnig`). A destination's `destinationId` in the route definition is its node id on that map; the orchestrator does not check it, and an unknown id is a 404 from `route`. Formats: `nav/schemas/navigation.py` in nav-engine. Staging can use the fakes in `orient-orchestrator/examples/fakes.rs` instead.

nav-api is stateless. The orchestrator keeps the navigation state in the session: it locates the user, asks for one route, and follows it one hop at a time. Every call also carries the caller's ids as `X-Client-Id`, `X-Session-Id` and `X-Request-Id` (the frame's `requestId`), so nav-api's log lines join the trace.

### Navigation loop

A session's navigation state: the user's node (the last node reached, kept into the next session) with the phone's `stepCount` when they reached it, the route's hops (none while locating), the current hop, and the votes of the last `NAV_VOTE_N` `localize` calls. Each call sends the frames not sent before, so every vote is over different frames. The worker calls once `NAV_BURST` such frames are waiting.

1. **Locating**, at the start of a session and after lost. `localize` without `expected`; after lost, with the last node as `previous` and its step count as `previous_step_count`, so a node the user can't have walked to yet doesn't count. A result votes for its `best` when its status isn't `lost`, its `margin` is at least `NAV_MARGIN`, and that candidate isn't `plausible: false`. The user is at a node once it has `NAV_VOTE_K` of the last `NAV_VOTE_N` votes, or at once on a `confirmed` result. Then `route` from that node to the destination, once. If the node is the destination, the output is `arrived`; with `found: false`, locating goes on. Until the user is located, the output is `wait` with `uncertain: true`.
2. **Following** the hop `source → target`. `localize` with `previous` = source, `expected` = target, each frame's `motion` and `previous_step_count`. Each result is one vote:
   - `at_target`: `best` is the target, `margin` ≥ `NAV_MARGIN`, the status isn't `lost`, and the target isn't `plausible: false`;
   - `elsewhere`: `best` is neither the source nor the target, `margin` ≥ `NAV_MARGIN`, and the status isn't `lost`;
   - otherwise no vote.

   With `NAV_VOTE_K` `at_target` votes among the last `NAV_VOTE_N`, the user is at the target: it becomes their node (with the newest `stepCount`) and the next hop starts, or at the destination the output is `arrived`. Only the current hop's target can be reached, so no node is skipped.
3. **Lost**: `NAV_VOTE_K` `elsewhere` votes among the last `NAV_VOTE_N`, or `NAV_LOST_CALLS` `lost` results in a row while following. The route is dropped and the loop goes back to locating: a new navigation from where the user is.

Live frames score low (Itnig, 2026-10-10: 0.17 to 0.49, against nav-api's confirm score of 0.45), so the votes look at which node leads (`margin`), not at the absolute score. The defaults, `NAV_BURST` 1, `NAV_VOTE_K` 3 of `NAV_VOTE_N` 4, `NAV_MARGIN` 0.04 and `NAV_LOST_CALLS` 10, come from replaying the Itnig walks through the same loop (`nav map orchestrator-replay` in nav-engine). They were the only settings with no wrong move.

### `POST /maps/{map_id}/localize`

Which node the camera sees. Called for every evaluation. `multipart/form-data`:

- `images`: the frames not sent before, oldest first, 1 to 4 (nav-api's maximum), one `image/jpeg` part each.
- `previous`: while following, the hop's source; when relocating, the last node reached. Without `motion`, a node further than one edge from it stays `uncertain`.
- `expected`: while following, the hop's target. Its score and rank come back as `expected_score` and `expected_rank`.
- `heading_deg`: the newest frame's `motion.headingDeg`, when the phone sent one.
- `motion`: one part per image, in the same order, each that frame's `meta.motion` as JSON (`null` for a frame without one). When any is sent there must be one per image.
- `previous_step_count` (with `previous` and `motion`): the `stepCount` of the newest frame when the user reached `previous`.

```json
200 {
  "map_id": "itnig", "model": "gmberton/MegaLoc:5fe0dd6…", "frames": 1,
  "status": "confirmed", "reason": "clear: score >= 0.45, margin >= 0.05, 3 m walked from the last confirmed node",
  "best": "n4", "margin": 0.08,
  "candidates": [{ "node": "n4", "name": "Stage corridor", "score": 0.51, "refs": [], "distance_m": 0.9, "plausible": true }],
  "previous": "n3", "expected": "n4", "expected_score": 0.51, "expected_rank": 1, "walked_m": 3.1,
  "took_ms": { "embed": 30, "match": 1, "total": 40 }
}
```

- `status` is `confirmed`, `uncertain` or `lost`; `best` is the top candidate and `margin` its lead over the second. The [navigation loop](#navigation-loop) turns each result into a vote.
- The loop's state and the vote (locating or the hop, and the vote counts) go to the trace as `observation`, the best candidate's `score` as `confidence`, and the whole response as `localize`.
- Timeout 4 s. The first frame after nav-api's inference host restarts can get a 503 while its model loads.

With `motion`:

- Frames with the camera more than 55° up or down (from `orientation`) are left out, as the map has no such images. With none left the status is `lost`.
- With `previous` and `previous_step_count`, the distance walked is the new steps (the newest `stepCount` minus `previous_step_count`) times the map's length of a phone step. It replaces the one-edge rule: a node `d` metres from `previous` along the map's edges is `plausible` once the user has walked at least `d` − max(1 m, 0.35 `d`); before that it stays `uncertain` and doesn't vote. A `stepCount` below `previous_step_count` (the phone restarted its count) falls back to the one-edge rule.
- The newest frame's `headingDeg`, when it has one, is used instead of `heading_deg`.
- The result adds `walked_m`, `frames_used`, `pitch_deg` (per frame) and, per candidate, `distance_m` and `plausible`.

### `POST /maps/{map_id}/route`

The route from the user's node to the destination. Called once each time the user is located, at the start of a session and after lost, unless they are at the destination. The orchestrator keeps the hops and follows them in order.

```json
{ "start": "n1", "goal": "n4", "trust": "observed" }
```

`trust` is `NAV_TRUST`: `verified` (edges a person checked; nav-api's choice for real users), `observed` (walked while mapping, in the walked direction; the default while no edge is verified) or `any`.

```json
200 {
  "map_id": "itnig", "start": "n1", "goal": "n4", "trust": "observed", "found": true, "length_m": 9.3,
  "hops": [
    { "edge": "e1", "source": "n1", "target": "n2", "forward": true, "length_m": 3.1, "bearing_deg": 12.0,
      "instruction": "Go through the glass door and walk straight ahead about 3 metres. Bear right …",
      "steps": [{ "action": "go_through", "distance_m": 1.0, "along": null, "until": null }],
      "status": "observed" }
  ]
}
```

Each hop becomes an output when it starts:

- `action` is `turn` with `direction` `left`, `right` or `around` when the hop's first step is `turn_left`, `turn_right` or `turn_around`, and `continue` otherwise.
- `instruction` is spoken instead of the template. When it is longer than 240 characters, it is cut after the last whole sentence that fits; with no such sentence, the template is used.
- `found: false`, or a first hop that does not start at the user's node, keeps locating, with the output `wait`.
- Timeout 2 s.

A `localize` or `route` failure drops that evaluation. Three in a row in a session send an `error` event with stage `navigate`.

The validated result is an **output**: `{ action, direction, step, next, instruction, uncertain }`, where `step` is the user's node and `next` the current hop's target. The worker compares it with the session's previous output, as described in [Worker](#worker-speak-or-stay-quiet).

## 3. Orchestrator ↔ Jev (TypeSafe)

[Jev](https://docs.typesafe.ai/introduction) is TypeSafe's decision model. It takes a `state` and typed questions and returns calibrated answers: Choice, Score or Noul. It does not generate text. So Jev handles the Command step and decides whether a changed direction is worth saying. The sentences come from the path or from templates.

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

One worker per client evaluates the frames not sent yet: one `localize` call, a vote in the [navigation loop](#navigation-loop), and the current hop validated into an output. It compares that output with the session's **previous output**:

```json
previous { "action": "continue", "direction": null, "step": "n1", "next": "n2", "instruction": "Go through the glass door …", "uncertain": false }
output   { "action": "turn", "direction": "left", "step": "n2", "next": "n3", "instruction": "From the drinks cooler, bear left …", "uncertain": false }
→ changed: ask Jev
```

- There is no previous output (first evaluation in the session): send `guidance`, reason `first`.
- `arrived`: always send `guidance`.
- Any field differs: ask Jev whether it is worth saying (below). Send `guidance`, or a `heartbeat` with `quietReason: "not_worth_saying"`. Without `TYPESAFE_API_KEY`, every change is spoken.
- All fields are equal: send `heartbeat` with `quietReason: "unchanged"`. Nothing is repeated on a timer. Asking for the same destination again clears the previous output, so the next output is spoken.

Every output becomes the new previous output, whether it was spoken or not. A new session starts with no previous output and locates the user again.

### Speak: one Choice question

```json
{
  "model": "jev-latest",
  "state": {
    "destination": "coffee counter",
    "previous": { "action": "continue", "step": "start", "next": "corridor", "…": "…" },
    "new": { "action": "turn", "direction": "left", "step": "corridor", "next": "counter", "…": "…" },
    "msSinceLastSpoken": 4200
  },
  "questions": {
    "speak": {
      "type": "choice",
      "instructions": "A blind user is being guided indoors by voice. The route planner gave a new direction. Should it be spoken now? …",
      "criteria": { "speak": "The new direction changes what the user must do now …", "quiet": "The new direction repeats or only rephrases what was last said …" }
    }
  }
}
```

Only `quiet` with `confidence` of at least `JEV_MIN_CONFIDENCE` keeps it unsaid. Low confidence, an HTTP error or a 2 s timeout speaks it.

### Sentence templates

Jev does not write sentences. The orchestrator speaks the route hop's `instruction` when there is one, and otherwise a fixed sentence for each action: "Turn left.", "Keep going straight.", "You have arrived at the coffee counter.", "Wait a moment." or "Please hold still, I need a clearer view." Templates are instant, never fail, and stay within the 240-character limit.

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
  phase: "awaiting_destination" | "navigating" | "arrived" | "stopped",
  clientRouteStepId: string | null, routeStepId: string | null, destinationId: string | null,
  transcript: string | null, command: string | null,
  engine: string, framesSent: number | null, action: Action | null, confidence: number | null, observation: string | null,
  spoke: boolean, text: string | null,
  timingsMs: { upload?: number, stt?: number, command?: number, localize?: number, route?: number, jev?: number, tts?: number, total: number },
  dropped: "stale_generation" | "stale_sequence" | "expired_input" | "superseded" | "echo" | null,
  error: string | null,
  localize: object | null, route: object | null, // nav-api's raw localize and route responses, frame entries only
  quietReason: string | null, // why a frame's output was kept quiet: "unchanged", "not_worth_saying", …
  // Jev's answer behind the decision: the command question on input entries, "worth saying" on frame entries
  jev: { source: "jev" | "keywords", choice?: string, confidence?: number, probabilities?: object, error?: string } | null
}
```
