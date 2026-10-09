# S02: Camera and microphone capture

P0 | 45-60 min | Input owner (A) | Wave 2

- Depends on: S00, S01.
- Parallel with: S01b, S04, S06.
- Unblocks: live capture for S03; S09.

Purpose: capture the inputs needed for guidance. The Start/Stop control is in S06.

Acceptance: handle camera/mic permission success and denial on the target phone, with denial reported as a session state; capture a fresh frame and a bounded audio recording on demand; expose start/stop capture functions that S06's control calls; stopping releases the camera and microphone.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
