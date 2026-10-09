# S06: Activation and spoken output

P0 | 45-75 min | Output/UI owner (D) | Wave 2

- Depends on: S00, S01.
- Parallel with: S01b, S02, S03, S04.
- Unblocks: S07, S09.

Purpose: let the user start and stop a session and hear the prompt and guidance without reading. Phone browsers only play speech after a user gesture, so the tap that starts a session also unlocks audio.

Acceptance: one large, labeled Start/Stop control; test the proposed double tap with a screen reader; after activation, speak the opening prompt and a mocked engine response on the target phone; serialize speech; Stop cancels queued/current output and calls S02's stop capture once it exists; TTS failure leaves a recoverable app state.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
