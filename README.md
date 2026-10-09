# Orient

A voice-first web app that uses a phone's camera, microphone and speech to guide a blind or visually impaired person through an unfamiliar indoor space to a destination they ask for.

Named after Orient, the guide dog who led Bill Irwin, a blind hiker, along the entire Appalachian Trail in 1990.

## How it works

1. Open the app on a phone and double tap, or press the large Start button.
2. Orient asks where you want to go. Say a supported destination, such as the coffee counter.
3. The phone sends your voice and camera frames to the server. A navigation model reads each frame against the known route.
4. Orient speaks one short instruction at a time ("Turn left at the coffee machine.") until you arrive.
5. Double tap or press Stop at any time to end the session. Stop cancels all pending speech.

## Status

Hackathon prototype for Itnig, October 2026. The first demo covers one controlled route with a few predefined destinations and is always supervised. Orient has not been shown to support safe independent navigation and does not replace a cane, a guide dog or a person.

## Docs

- [agent.md](agent.md): scope, constraints, delivery plan and Definition of Done
- [docs/architecture.md](docs/architecture.md): pipeline diagrams
- [docs/contracts.md](docs/contracts.md): HTTP and event contracts
- [docs/](docs/): story cards S00 to S12
