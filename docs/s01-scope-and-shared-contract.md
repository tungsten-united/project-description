# S01: Scope and shared contract

P0 | 20-30 min | Integration lead (A) | Wave 1

- Depends on: nothing.
- Parallel with: S00.
- Unblocks: every other card.

Purpose: give the three pipelines one route, one shared contract, and one set of session states.

Acceptance: record start point, destination, allowed route steps, and fallback; name pipeline owners; commit request/response fixtures with session/request IDs and error states; define the client session states (idle -> prompting -> listening -> waiting -> speaking -> stopped) and which events move between them; confirm budget cap and who provisions inference.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
