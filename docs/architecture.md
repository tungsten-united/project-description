# Architecture: Voice Guidance pipeline

Status: draft for team review. Diagrams are Mermaid, so they render on GitHub and diff cleanly.
Everything here is a proposal. Models, hosting and the exact STT path are not decided. Decisions go through [Jev](https://docs.typesafe.ai/introduction), TypeSafe's decision model: the Command step is one Jev Choice question. Jev does not generate text, so the writer uses templates and the decider uses rules. HTTP contracts: [contracts.md](contracts.md).

## 1. Context

```mermaid
flowchart LR
  user(["User<br/>blind or low-vision"])
  sys["Voice Guidance Assistant<br/>phone app + inference backend"]
  venue[["Itnig venue<br/>route, landmarks, tags<br/>(physical, not an API)"]]
  team[["Dev team<br/>debug and run traces"]]

  user <-->|"voice + camera in<br/>spoken guidance out"| sys
  venue -.->|"seen by the camera"| sys
  sys -.->|"sanitized trace"| team
```

## 2. Containers

The Orchestrator is the only component the phone talks to. Every model call goes out from it and returns to it, so route validation, stale-response checks and logging live in one place.

```mermaid
flowchart LR
  user(["User"])

  subgraph phone["Phone browser"]
    app["Web app<br/>React + Tailwind<br/>capture, Start/Stop, session state"]
    tts["TTS playback<br/>speech queue, interruption"]
  end

  subgraph backend["Inference backend: GPU server behind HTTPS"]
    orch["Orchestrator<br/>auth, limits, session and route state<br/>latest-frame-wins, stale drop"]
    cmd["Command classifier<br/>Jev Choice: destination, cancel or unsupported"]
    nav["Navigation engine<br/>VLA: frame + destination + route step to action"]
    dec["Utterance decider<br/>rules in code: speak now or stay silent"]
    wri["Utterance writer<br/>templates in code: action to one short sentence"]
    route[("Route definition<br/>steps, landmarks, transitions")]
    trace[("Run trace<br/>IDs, timings, errors, no raw media")]
  end

  user <--> app
  app -->|"POST audio + frame"| orch
  orch -->|"SSE: events"| app
  app --> tts
  tts --> user

  orch <--> cmd
  orch <--> nav
  orch <--> dec
  orch <--> wri
  orch --> route
  nav -.->|"reads"| route
  orch -.-> trace
```

Legend: `cmd` (Jev, TypeSafe API) and `nav` (VLA) are the model calls. `dec` and `wri` are plain code inside the Orchestrator, drawn separately because each has its own contract.

## 3. One pass through the pipeline

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant P as Phone app
  participant O as Orchestrator
  participant C as Command classifier (Jev)
  participant N as Navigation engine (VLA)
  participant D as Utterance decider (rules)
  participant W as Utterance writer (templates)

  U->>P: speaks (voice) + camera frame
  P->>O: POST audio + frame (session, sequence, capturedAt)
  O->>C: transcript + supported destinations (Choice question)
  C-->>O: choice + confidence: destinationId | cancel | unsupported

  alt cancel
    O-->>P: SSE stop event
    P->>U: stops capture and speech
  else unsupported or empty
    O-->>P: SSE needs_input event
    P->>U: asks again
  else start(destinationId)
    loop each fresh frame while observing
      P->>O: POST frame
      O->>N: frame + destinationId + route step
      N-->>O: action + proposed next step
      Note over O: validate step against route definition,<br/>drop if frame or session is stale
      O->>D: action, route step, last spoken text
      D-->>O: speak = yes or no (with reason)
      alt speak = yes
        O->>W: action + route step
        W-->>O: one short sentence
        O-->>P: SSE guidance event (text, action, route)
        P->>U: speaks sentence (TTS)
      else speak = no
        O-->>P: SSE heartbeat or state-only event
        Note over P,U: nothing is spoken
      end
    end
  end

  U->>P: Stop
  P->>O: POST stop (generation bump)
  Note over P,O: phone suppresses output locally first,<br/>server drops late results by session and generation
```

## Component responsibilities

| Component | Owns | Does not own |
| --- | --- | --- |
| Web app | Mic and camera capture, Start/Stop, session state machine, SSE client | Any model call, any secret |
| TTS playback | Speaking received text, queue, interrupt on Stop, dedupe by guidance ID | Deciding what to say |
| Orchestrator | Auth, size limits, session and generation tracking, route validation, calling each model in order, SSE out | Model internals |
| Command classifier (Jev) | Turning a transcript into `start(destinationId)`, `cancel` or `unsupported`, with a confidence | Route progress |
| Navigation engine | Frame + destination + step to a structured action | Wording, deciding whether to speak |
| Utterance decider | Speak or stay silent (new action, changed step, repeat interval, uncertainty) | Writing the sentence |
| Utterance writer (templates) | One sentence of at most 240 characters | Route validity |
| Route definition | Allowed steps and transitions, server-owned | Anything learned at runtime |
| Run trace | Sanitized IDs, stage timings and errors | Raw audio or images |

## Open points

1. **Speech to text.** Jev reads text or JSON, not audio, so an STT step sits between the Orchestrator and `cmd`, or the phone sends a transcript. Which STT is still open.
2. **Decider as rules or Jev.** Start with rules (action changed, step changed, or 5 to 10 seconds since the last utterance). If rules prove too rigid, ask Jev a yes/no (Noul) question. A second model call per frame adds latency.
3. **"TTS command".** Drawn as text sent to the phone, which synthesizes speech. If browser TTS fails on the demo phone, add a server TTS component that returns audio on the same event stream.
4. **Where the backend runs.** Tunnel to the local GPU server or a Google Cloud service in front of it. Decides who holds the auth secret.
5. **Silent frames.** When `speak = no`, the server sends a heartbeat or state-only event so the phone can tell "quiet by choice" from "connection lost".
6. **Command classifier runs once per utterance.** After `start`, frames go straight to the navigation engine. A new voice command re-enters at step 3.
