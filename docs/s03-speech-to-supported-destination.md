# S03: Speech to supported destination

P0 | 45-90 min | Input owner (A), after S02 | Wave 2-3

- Depends on: S01. Acceptance needs the S01b voice clips. Live capture uses S02.
- Parallel with: S04, S06, then S05 and S08.
- Unblocks: S09.

Purpose: understand a spoken destination and acknowledge it audibly. Use S06 for speech, or a mocked acknowledgement until S06 is done.

Acceptance: process the S01b venue recordings using the chosen API or local speech model; map supported phrasing to a fixed destination ID; empty, noisy, or unsupported requests prompt retry instead of starting guidance; document one measured turnaround.

Follow the shared [Definition of Done](../agent.md#definition-of-done).
