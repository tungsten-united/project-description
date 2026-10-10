# Voice-first indoor guidance assistant

Project instructions derived from [Itnig-Voice-Guidance-Plan-Kanban.pdf](Itnig-Voice-Guidance-Plan-Kanban.pdf), the Itnig hackathon team working brief dated 9 October 2026.

## Working baseline

Follow the recommended plan as the working baseline while keeping unresolved choices explicit. Recommendations are not confirmed team agreements. Do not present proposals, estimates, or unverified implementation results as facts.

## Goal and MVP scope

Build a browser-based assistant that uses a phone camera, microphone, and spoken feedback to help a blind or visually impaired person explore an unfamiliar indoor space and reach a requested destination.

The first demo is one controlled route at Itnig with a small set of predefined destinations and a predefined script. The counter for ordering coffee, then the bathroom, are proposed; a meeting room is another example. Select the actual route and start point before implementation.

Recommended success criterion: on a real phone, start a session, state one supported destination, receive a short spoken instruction informed by a current camera image, and stop the session. Demonstrate the route under supervision. The prototype does not establish safe independent navigation.

Keep one route, one navigation implementation, and one speech path. Defer free exploration, arbitrary destinations, always-listening commands, broad environment mapping, elaborate helper setup, and visual segmentation polish. Investigate simple haptics only after spoken output works.

## Decisions and proposals

| Item | Scope and qualification |
| --- | --- |
| Voice-first web app | Camera input, microphone requests, speaker output, and minimal visual interface. |
| Constrained first route | Counter/bathroom, predefined script, limited destinations. Tags at key places are suggested. |
| Double tap to start/stop | Prioritized before real-time voice interaction; an MVP gesture proposal whose accessibility needs testing. |
| Three functional pipelines | Voice input, navigation engine/LLM-VLA coordination, and TTS output. Parallel work is possible after agreeing a contract. |
| Developer debug mode | Useful app information and logs for diagnosis and agent-assisted development. |
| Minimal interface | Simple activation is favored. Segmentation display and helper setup are not established MVP requirements. |

Core flow: open app -> double tap -> hear destination prompt -> speak destination -> send captured request to server -> navigation/AI processing -> spoken guidance. Double tap again to stop. Recording-end behavior remains unresolved.

Navigation is map-based, not a VLA ([nav-engine](https://github.com/tungsten-united/nav-engine), see [architecture.md](docs/architecture.md#navigation-engine-nav-engine)): walks of the venue are recorded on a phone and turned into a semantic topological map of named spots and walkable connections, and live guidance follows routes over that map. VLAs, Omni-VLA and 2D navigation were exploration candidates and are not used for the MVP. Images alone do not provide a map. Speech in and out is selected: ElevenLabs Scribe v2 (speech to text) and Flash v2.5 (text to speech), called only by the orchestrator; Wispr Flow was evaluated and rejected because it has no self-serve API ([contracts.md section 4](docs/contracts.md#4-orchestrator--elevenlabs)). Do not assume any other model, provider, framework, or cloud service has been selected.

## Kickoff decisions and unresolved choices

Recommended first 30 minutes:

1. Pick one route, start point, and destination.
2. Name one owner per pipeline and one integration lead.
3. Get an ElevenLabs API key into the orchestrator env (speech provider is chosen) and choose one navigation candidate.
4. Agree the budget cap and who can provision inference.
5. Fix the shared request/response contract before separate development.

Recommended defaults:

- Route progress: explicit steps and observable landmarks. Do not claim general mapless navigation.
- Model/dataset/hosting: time-box a spike; choose using an actual venue test, measured latency, and deployment effort.
- Recording completion: bounded recording with an explicit stop control; defer always-listening interaction.
- Activation accessibility: test double tap with a screen reader and provide one large, labeled Start/Stop control as well.
- Errors: speak that guidance is unavailable, halt the session, and allow retry/stop.
- Ownership: use roles until actual people are agreed.

## Infrastructure and budget

Start locally, then optimize. Serve small models from a teammate's computer through a tunnel for the first iteration; consider other inference options in the next build block if the initial approach works. APIs, remote inference, and GPU hosting remain options, not a finalized architecture.

A EUR 50 pool is proposed. Confirm the cap and split before spending. Hardware and inference price estimates are unverified.

Plan shared access to run logs. Local storage and Google Cloud credits are alternatives; no cloud service is definitively selected. Credit amounts and eligibility are unverified.

## Shared contract and implementation constraints

Recommended minimum request fields:

- Session ID.
- Supported destination.
- Current route step.
- Audio or transcript.
- Current image.
- Capture timestamp.

Recommended minimum response fields:

- Request ID.
- Status.
- Short guidance text.
- Action: `wait`, `turn`, `continue`, `arrived`, or `stop`.
- Next route step.
- Debug timing.

Recommended client session states: idle -> prompting -> listening -> waiting -> speaking -> stopped. Define them in S01 with the request/response formats.

Commit shared request/response fixtures with session/request IDs and error states. Associate results with the correct session and request. Only advance route state when route logic can justify it. Reject expired input and stale responses after Stop; do not invent route progress.

Use HTTPS for the phone-to-inference connection. Keep API credentials server-side. Exclude secrets and raw camera/audio data from routine logs. Keep debug information separate from the primary interaction.

Serialize spoken instructions. Stop must cancel capture, requests, queued speech, and current output, release capture resources, and prevent late responses from restarting speech. Retry must start from an explicitly known session/route state. Handle uncertain scenes with wait/stop and a request for a clearer view.

## Delivery plan and responsibilities

These phases and estimates are recommendations, not confirmed commitments. Workstreams can run in parallel once the shared contract is agreed.

| Phase | Outcome/gate | Suggested responsibility |
| --- | --- | --- |
| 0: 0-30 min | Freeze one route, contracts, and owners; confirm real-phone camera/mic access. | All; integration lead drives. |
| 1: 30-90 min | Speech input, image-to-guidance, and speech output work independently; navigation candidate passes venue image test or fallback is chosen. | Input owner; engine pair; output/UI owner. |
| 2: 90 min-3 h | Full phone request through local inference; Start/Stop and debug trace work. | Integration lead and pipeline owners. |
| 3: 3-5 h | Supervised venue route, bounded retries, uncertainty handling, measured latency. | Engine owner and tester; input/output owners fix failures. |
| 4: next build block | Improve hosting only if needed; stabilize and rehearse. Stretch work follows MVP acceptance. | Infrastructure owner, demo lead, all review. |

Suggested four-person split; choose actual names together:

- A, input/integration: microphone/camera capture, API contract, browser-to-inference connection. Cards: S01, S02, S03, S09 lead, S10.
- B, navigation: model evaluation, route decisions, uncertainty handling. Cards: S01b, S04, S05, S10, S11.
- C, navigation/infrastructure: partner on model evaluation, local serving/tunnel, latency and cost measurement. Cards: S00, S01b, S04, S08.
- D, output/interface: TTS, accessible activation/stop, demo presentation. Cards: S06, S07, S12 lead.

## Codebase

This repository holds the plan, the docs and the phone web app. The orchestrator backend is a separate Rust repo, [tungsten-united/orient-orchestrator](https://github.com/tungsten-united/orient-orchestrator). The navigation engine is [tungsten-united/nav-engine](https://github.com/tungsten-united/nav-engine): the recorder, map pipeline and review (`map-api`, with a debugging frontend for the team), and `nav-api`, the live API the orchestrator calls for every frame (`localize`, then `route`; [contracts.md section 2](docs/contracts.md#2-orchestrator--navigation-engine)). The phone never calls nav-engine.

### Commands

Node 24 (`.nvmrc`). An npm workspace, so run everything from the repo root:

```bash
npm ci
npm run dev -w apps/web                               # http://localhost:5173
npm run check                                         # lint, typecheck, test, build: what CI runs
npm test -w apps/web -- src/session/machine.test.ts   # one test file
npm test -w apps/web -- -t "late events"              # tests whose name matches
```

`VITE_API_BASE_URL` (see `apps/web/.env.example`) points the app at a real orchestrator. When it is unset, the app runs in demo mode against `mockApi.ts`, a scripted in-browser orchestrator, not AI.

### Seeing the app and testing against the orchestrator

- Desktop: `npm run dev -w apps/web`, then Chrome DevTools device mode (Cmd+Shift+M).
- Phone: https://orient.harshdeepsingh.dev, built without `VITE_API_BASE_URL`, so demo mode. Phones only allow camera and microphone over HTTPS, so a LAN `http://` dev server is not a real test.
- Orchestrator without a phone: in `orient-orchestrator`, `cargo run --example fakes`, then `STT_URL=http://localhost:8001/stt DEBUG_PAGE=1 cargo run` and open http://localhost:8000/debug.
- Debug mode: build with `VITE_DEBUG_MODE=true` (a repo variable for the Cloudflare build) to get a cog that opens camera feed, logs, motion data and the exact payloads sent. Pause stops frame uploads so a payload, including its audio clip, can be inspected.
- Session log: in debug mode a second button (≣) opens a compact, tagged timeline of the whole session since Start: `FE` phone, `ORCH` orchestrator, `STT`, `JEV`, `NAV` (nav-api and the GPU embed time), `TTS`. It merges what the phone did with the orchestrator's `log` events, which are only streamed when the orchestrator runs with `DEBUG_PAGE` (staging does). Copy puts it on the clipboard as plain text to paste into a report.
- `/itnig-demo` is a scripted walk that runs entirely in the browser, for anyone who is not on the real route: no camera, microphone, backend or logging. It is labelled "Scripted demo", and a tap on a place plays the same four beats whatever the place. It is not real navigation and must be presented as scripted.
- Pull to refresh is off (`overscroll-behavior-y: none` on `html` and `body`), because a reload ends a session: the client id, token and state live only in memory. Resuming a session after a reload is not built; the plan is `sessionStorage` plus a "Resume guidance" tap that re-subscribes and calls `POST /retry` with `last_confirmed_step`.
- Voice isolation: `VITE_VOICE_ISOLATION=true` (or the switch in the debug panel, per device) records through a high-pass filter and a noise gate with automatic gain control off, so the nearest voice dominates in a room with other phones. Untuned; compare on the demo phone with the payload audio playback. `voice_levels` lines in the client log show the noise floor, peak and how much of the clip the gate let through.
- Staging: released by hand from **Actions > Deploy staging** in `orient-orchestrator`, which creates `orient-orchestrator-staging` on Cloud Run (`<url>/debug`, `/v1/health`). To point the app at it, set `VITE_API_BASE_URL` in `apps/web/.env.local`, or as the repo variable for the Cloudflare build.
- Phone to orchestrator end to end needs the web app drift below fixed first.

### Architecture

Read [docs/architecture.md](docs/architecture.md) for the pipeline and [docs/contracts.md](docs/contracts.md) for every HTTP and event shape. The contract is the shared source of truth between the phone, the orchestrator and the navigation engine. Change it first, then the code on both sides.

The web app (`apps/web`, React + Tailwind + Vite):

- `session/types.ts` mirrors the contract by hand. `OrchestratorApi` is the phone's only view of the backend. Two implementations: `httpApi.ts` (fetch + `EventSource`) and `mockApi.ts`.
- `session/machine.ts` is a pure reducer for the client states (idle → prompting → listening → waiting → speaking → stopped). It ignores events that are invalid for the current state.
- `session/useSession.ts` wires the reducer, the API and speech together. It owns the stale-result rules: a local run counter plus the server `generation` drop late events, guidance is deduplicated by `guidanceId`, and Stop silences speech locally before telling the server.
- `output/browserSpeech.ts` is the `SpeechAdapter` over browser TTS. Per the contract it becomes the fallback; the primary adapter plays `GET /v1/clients/{clientId}/speech` (ElevenLabs) in an `<audio>` element.

Deployment ([docs/deployment.md](docs/deployment.md)): the web app is static assets on Cloudflare (`apps/web/wrangler.jsonc`). `.github/workflows/web.yml` runs the checks on every PR and deploys on merge to `main`. It skips the deploy with a warning when Cloudflare secrets are missing. The orchestrator is planned for Cloud Run, and `infra/gcp/setup.sh` provisions it once. nav-engine runs two Cloud Run services on the team bucket: `nav-api` (live, read-only, for the orchestrator) and `map-api` (recordings, map builds, review, the debugging frontend). Their models run on a teammate GPU (helium) behind a tunnel.

### Known drift

The web app follows the contract as of this change. Still open:

- `session/types.ts` is written by hand, so it can drift again. A shared `packages/contracts` or a cross-repo smoke test would catch it.
- No `POST /retry` call yet: Try again starts a new client, which is the contract's `destination_prompt` path. `last_confirmed_step` is not used.
- Staging runs the orchestrator with fakes. Real Jev and ElevenLabs behaviour has not been exercised from the phone.
- `GET /speech` plays in an `<audio>` element and falls back to browser TTS. Neither has been tried on the demo phone, and iOS audio unlock is untested.

## Kanban workflow

The PDF proposes a starting board; it contains no verified implementation results. Do not mark work Done without evidence.

- Ready: S00, S01.
- Backlog: S01b through S12.
- In progress, Review, Done: initially empty.
- Pull after agreeing owners. Limit work in progress to one card per owner; S01b and the model spike may have two people.
- Review requires evidence and a peer check. Done requires acceptance criteria passed on the target phone.

Cards in the same wave run in parallel; waves run in sequence. A card can start once all its dependencies are Done. Each story file lists what it depends on, what it runs alongside, and what it unblocks.

| Wave | A (input/integration) | B (navigation) | C (navigation/infra) | D (output/UI) |
| --- | --- | --- | --- | --- |
| 1 | S01 | helps S01 | S00 | helps S01 |
| 2 | S02 -> S03 | S01b -> S04 | S01b -> S04 | S06 |
| 3 | S03 (if needed) | S05 | S08 | S07 (P1, optional) |
| 4 | S09 lead | S09 | S09 | S09 |
| 5 | S10 | S10 | prepares S11 | prepares S11 |
| 6 | fixes blockers | S11 | fixes blockers | fixes blockers |
| 7 | S12 | S12 | S12 | S12 lead |

Dependencies:

```
S00 ─┬──────────────────────────► S02 ──► S03 ─┐
S01 ─┼─► S01b ─► S04 ─► S05 ───────────────────┼─► S09 ─► S10 ─► S11 ─► S12
     ├──────────────────────────► S06 ─────────┘                  ▲
     │                             └─► S07 (P1, optional)         │
     └─► S08 ─────────────────────────────────────────────────────┘
```

S01b is needed for S03 and S04 acceptance only; both can start setup before it is done. S07 must not block the voice demo.

P0 means needed for the controlled voice demo. P1 means useful exploration/support; cut it if it threatens integration. Per-card effort estimates can overlap and exclude unexpected model/hosting problems.

## Story cards and acceptance criteria

Read the relevant story before implementing or reviewing it. Each file in `docs` is the source of truth for that story.

- [S00: Phone-reachable HTTPS skeleton][S00]
- [S01: Scope and shared contract][S01]
- [S01b: Venue sample capture][S01b]
- [S02: Camera and microphone capture][S02]
- [S03: Speech to supported destination][S03]
- [S04: Navigation model feasibility spike][S04]
- [S05: Route-aware navigation engine][S05]
- [S06: Activation and spoken output][S06]
- [S07: Define and test haptic output][S07]
- [S08: Debug panel and shared run trace][S08]
- [S09: Connect the full phone loop and Stop][S09]
- [S10: Failure messaging and retry][S10]
- [S11: Supervised venue acceptance test][S11]
- [S12: Freeze and rehearse the shareable demo][S12]

[S00]: docs/s00-phone-reachable-https-skeleton.md
[S01]: docs/s01-scope-and-shared-contract.md
[S01b]: docs/s01b-venue-sample-capture.md
[S02]: docs/s02-camera-and-microphone-capture.md
[S03]: docs/s03-speech-to-supported-destination.md
[S04]: docs/s04-navigation-model-feasibility-spike.md
[S05]: docs/s05-route-aware-navigation-engine.md
[S06]: docs/s06-activation-and-spoken-output.md
[S07]: docs/s07-define-and-test-haptic-output.md
[S08]: docs/s08-debug-panel-and-shared-run-trace.md
[S09]: docs/s09-connect-the-full-phone-loop-and-stop.md
[S10]: docs/s10-failure-messaging-and-retry.md
[S11]: docs/s11-supervised-venue-acceptance-test.md
[S12]: docs/s12-freeze-and-rehearse-the-shareable-demo.md

## Definition of Done

A story is Done only when its acceptance criteria pass on the actual demo phone, another teammate checks the result, errors are observable, Stop halts pending output, and a short sanitized log or clip is attached to the card. Avoid raw camera/audio in routine logs. Report remaining limitations honestly, including scripted behavior and unverified safety, latency, pricing, or infrastructure assumptions.
