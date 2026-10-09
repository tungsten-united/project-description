# S09: Connect the full phone loop and Stop

P0 | 60-90 min | Integration lead (A) and all owners | Wave 4

- Depends on: S02, S03, S05, S06. S08 recommended.
- Parallel with: nothing; the whole team integrates.
- Unblocks: S10.

Purpose: request a supported destination, hear guidance based on the current scene, and stop cleanly at any point.

Acceptance: phone reaches the selected inference endpoint through S00's HTTPS setup; activation -> request -> camera/engine -> spoken output works end to end; track stage latency; associate each result with the correct session/request; keep API credentials server-side; only one request is in flight at a time, so instructions never overlap or contradict; Stop cancels capture, the in-flight request, and speech; responses for a stopped session or an old request ID are dropped and cannot restart speech.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
