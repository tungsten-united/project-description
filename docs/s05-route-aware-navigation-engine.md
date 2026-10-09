# S05: Route-aware navigation engine

P0 | 60-120 min | Engine owner | Depends on S04 and S01.

Purpose: deliver one short instruction appropriate to the current route step.

Acceptance: combine destination, fresh image, and route state; return structured action, concise guidance, and next state; uncertain scenes produce wait/stop and a request for a clearer view; demonstrate arrival; reject expired input instead of inventing progress.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
