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

VLAs, an Omni-VLA-like approach, and 2D navigation are exploration candidates, not selected technologies. Images alone do not provide a map. Voice API services and hosting Voxtral are alternatives. Do not assume a specific model, provider, framework, or cloud service has been selected.

## Kickoff decisions and unresolved choices

Recommended first 30 minutes:

1. Pick one route, start point, and destination.
2. Name one owner per pipeline and one integration lead.
3. Choose a working speech input/output provider and one navigation candidate.
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

- A, input/integration: microphone/camera capture, API contract, browser-to-inference connection.
- B, navigation: model evaluation, route decisions, uncertainty handling.
- C, navigation/infrastructure: partner on model evaluation, local serving/tunnel, latency and cost measurement.
- D, output/interface: TTS, accessible activation/stop, debug panel, demo presentation.

## Kanban workflow

The PDF proposes a starting board; it contains no verified implementation results. Do not mark work Done without evidence.

- Ready: S01, S02, S03, S04.
- Backlog: S05 through S12.
- In progress, Review, Done: initially empty.
- Pull after agreeing owners. Limit work in progress to one card per owner; the model spike may have two people.
- Review requires evidence and a peer check. Done requires acceptance criteria passed on the target phone.

Pull order: S01 -> S02/S03/S04 in parallel -> S05/S06 with S08 alongside -> S09 -> S10/S11 -> S12. S07 is a bounded output spike and must not block the voice demo. Observe each card's dependencies even if it is in Ready.

P0 means needed for the controlled voice demo. P1 means useful exploration/support; cut it if it threatens integration. Per-card effort estimates can overlap and exclude unexpected model/hosting problems.

## Story cards and acceptance criteria

### S01: Scope and shared contract

P0 | 20-30 min | Integration lead | No dependency.

Purpose: give the three pipelines one route and one shared contract.

Acceptance: record start point, destination, allowed route steps, and fallback; name pipeline owners; commit request/response fixtures with session/request IDs and error states; confirm budget cap and who provisions inference.

### S02: Camera, microphone, and activation

P0 | 45-75 min | Input owner | Depends on S01.

Purpose: activate the app and capture the inputs needed for guidance.

Acceptance: handle camera/mic permission success and denial on the target phone; capture a fresh frame and bounded audio recording; provide labeled, usable Start/Stop; test proposed double tap with a screen reader; Stop releases capture.

### S03: Speech to supported destination

P0 | 45-90 min | Input owner | Depends on S01; live capture uses S02.

Purpose: understand a spoken destination and acknowledge it audibly.

Acceptance: process a real venue recording using the chosen API or local speech model; map supported phrasing to a fixed destination ID; empty, noisy, or unsupported requests prompt retry instead of starting guidance; document one measured turnaround.

### S04: Navigation model feasibility spike

P0 | 60-90 min cap | Engine pair | Depends on S01.

Purpose: establish whether an engine gives usable guidance for the chosen route.

Acceptance: test venue images and destination prompts; compare response usefulness, latency, and setup effort; select one engine and record limitations. If no candidate passes, choose a clearly labeled scripted route with AI scene assistance; do not claim autonomous navigation.

### S05: Route-aware navigation engine

P0 | 60-120 min | Engine owner | Depends on S04 and S01.

Purpose: deliver one short instruction appropriate to the current route step.

Acceptance: combine destination, fresh image, and route state; return structured action, concise guidance, and next state; uncertain scenes produce wait/stop and a request for a clearer view; demonstrate arrival; reject expired input instead of inventing progress.

### S06: Spoken prompt and guidance

P0 | 30-60 min | Output/UI owner | Depends on S01.

Purpose: let the user hear the destination prompt and guidance without reading.

Acceptance: after user activation, speak the opening prompt and a mocked engine response on the target phone; serialize speech; Stop cancels queued/current output; TTS failure leaves a recoverable app state.

### S07: Define and test haptic output

P1 | 30-45 min cap | Output/UI owner | Depends on S06.

Purpose: explore simple vibration cues alongside speech.

Acceptance: check device vibration support; define/document at most two clearly distinct cues and test comprehension with a sighted/supervised tester; unsupported devices retain full spoken guidance; keep directional vibration experimental until consistently understood.

### S08: Debug panel and shared run trace

P0 | 30-60 min | Infrastructure owner | Depends on S01.

Purpose: show request failures and enable comparison between runs.

Acceptance: show request ID, route step, transcript/destination, selected engine, action, stage timings, and error; all teammates can access a sanitized run trace through the agreed local setup; debug view is separate from primary interaction; exclude secrets and raw media by default.

### S09: Connect the full phone loop

P0 | 60-90 min | Integration lead and owners | Depends on S02, S03, S05, S06.

Purpose: request a supported destination and hear guidance based on the current scene.

Acceptance: phone reaches selected inference endpoint through HTTPS; activation -> request -> camera/engine -> spoken output works end to end; track stage latency; associate each result with the correct session/request; keep API credentials server-side.

### S10: Stop, stale output, and failure recovery

P0 | 30-60 min | Integration and engine | Depends on S09.

Purpose: halt guidance and communicate when it cannot continue.

Acceptance: Stop cancels capture, requests, and output; late responses cannot restart speech; handle timeout, offline state, denied permission, and uncertain scene; prevent contradictory overlapping instructions; retry begins from explicitly known session/route state.

### S11: Supervised venue acceptance test

P0 | 45-75 min | Tester and engine owner | Depends on S09, S10, S08.

Purpose: demonstrate the bounded route with observable evidence.

Acceptance: complete three supervised runs on the target phone; record observed failures and latency and fix blockers; include unsupported destination and uncertain scene; set an explicit acceptable latency based on testing. Do not ask a blind person to rely on the unvalidated prototype for mobility.

### S12: Freeze and rehearse the shareable demo

P0 | 30-60 min | Demo lead and all | Depends on S11.

Purpose: communicate the value and limits in a short live demo.

Acceptance: freeze a known working version; rehearse a 2-3 minute ask/observe/guide/stop scenario; show the AI contribution and disclose scripts/tags; prepare a labeled recorded fallback, endpoint restart notes, and simple budget check; explain free exploration and richer haptics as next steps.

## Definition of Done

A story is Done only when its acceptance criteria pass on the actual demo phone, another teammate checks the result, errors are observable, Stop halts pending output, and a short sanitized log or clip is attached to the card. Avoid raw camera/audio in routine logs. Report remaining limitations honestly, including scripted behavior and unverified safety, latency, pricing, or infrastructure assumptions.
