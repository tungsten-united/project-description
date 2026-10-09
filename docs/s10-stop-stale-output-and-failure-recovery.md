# S10: Stop, stale output, and failure recovery

P0 | 30-60 min | Integration and engine | Depends on S09.

Purpose: halt guidance and communicate when it cannot continue.

Acceptance: Stop cancels capture, requests, and output; late responses cannot restart speech; handle timeout, offline state, denied permission, and uncertain scene; prevent contradictory overlapping instructions; retry begins from explicitly known session/route state.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
