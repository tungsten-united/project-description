# S10: Failure messaging and retry

P0 | 30 min | Integration lead (A) and engine owner (B) | Wave 5

- Depends on: S09.
- Parallel with: the tester preparing the S11 run sheet.
- Unblocks: S11.

Purpose: tell the user when guidance cannot continue and let them retry safely. Stop and stale responses are handled in S09.

Acceptance: timeout, offline state, and endpoint errors speak that guidance is unavailable and halt the session; denied permission (from S02) and an uncertain scene (from S05) are spoken to the user in the full loop; retry begins from an explicitly known session/route state; Stop still works during a retry.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
