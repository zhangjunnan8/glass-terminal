# Milestone 9 — Per-command approval

## Implemented

- Every Agent `terminal_execute` request becomes a typed, visible
  `CommandApproval` and pauses the loop in `WAITING_APPROVAL`.
- Execute sends the exact proposed command; Edit & Execute records and sends
  the user's actual command with actor `user_modified_ai_command`; Reject writes
  nothing to the terminal and returns a structured rejection to the Provider.
- The approval card shows the command and model-provided reason. The terminal
  remains keyboard-locked so human and Agent input cannot interleave while the
  decision is pending.
- Command requests, approvals, edits, rejects, and completed executions are
  written to Session Audit separately from AI Thread messages and terminal log.
- Approval ownership is checked in the main process; a renderer cannot resolve
  another BrowserWindow's approval or claim an arbitrary actor.

## Tests run

- AgentService integration tests cover edited execution, actor attribution,
  continued multi-round planning, rejection with zero terminal writes, Thread
  persistence callbacks, and Audit event types.
- Electron local and real SSH Agent smokes verify that the marker is absent
  before approval and visible only after Execute.
- Secret scan confirms the mock Provider key does not appear anywhere in the
  isolated Agent smoke data.

## Known issues / next milestone

- Default mode is strictly per-command approval. Full Takeover, manual
  Takeover, keep-process/Ctrl+C choices, and interactive authentication are the
  next milestone.
