# S08: Debug panel and shared run trace

P0 | 30-60 min | Infrastructure owner (C), after S04 | Wave 3

- Depends on: S01.
- Parallel with: S03 (if still running), S05, S07.
- Unblocks: S11. Recommended before S09 so integration failures are visible.

Purpose: show request failures and enable comparison between runs.

Acceptance: show request ID, route step, transcript/destination, selected engine, action, stage timings, and error; all teammates can access a sanitized run trace through the agreed local setup; debug view is separate from primary interaction; exclude secrets and raw media by default.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
