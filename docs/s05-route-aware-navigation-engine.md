# S05: Route-aware navigation engine

P0 | 60-120 min | Engine owner (B) | Wave 3

- Depends on: S01, S04.
- Parallel with: S03 (if still running), S07, S08.
- Unblocks: S09.

Purpose: deliver one short instruction appropriate to the current route step.

Acceptance: combine destination, fresh image, and route state; return structured action, concise guidance, and next state; uncertain scenes produce wait/stop and a request for a clearer view; demonstrate arrival; reject expired input instead of inventing progress.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
