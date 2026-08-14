# Milestone 6 — Generic Agent loop

## Implemented

- Provider-neutral, bounded multi-round Agent loop with explicit system/user,
  assistant, and tool-result messages.
- Unified terminal tool contract for bounded terminal reads, terminal state,
  and command-execution requests.
- Every Generic OpenAI-compatible Provider uses the complete loop; no Provider
  is reduced to a chat-only shortcut.
- OpenAI-compatible `/chat/completions` adapter maps function definitions,
  assistant tool calls, tool results, and final text while enforcing Provider
  Ready state.
- Unsupported tool names and malformed arguments are returned as structured
  tool errors rather than executed.
- Per-turn cancellation, a 12-round safety bound, redirect rejection, safe HTTP
  status errors, and a 4 MiB response cap.
- API keys are retrieved internally for the HTTP Authorization header and never
  inserted into Agent messages or request bodies.

## Tests run

- Multi-round read → command → result → final-answer loop.
- Unsupported hidden-shell tool rejection.
- OpenAI-compatible function-call request/response mapping and secret-boundary
  assertion.
- Full typecheck and unit suite.

## Manual verification

This is a platform-neutral runtime milestone. The next milestone binds its
command callback to the same visible PTY and exposes approval in the desktop UI.

## Known issues / next milestone

- Streaming UI events are emitted by the loop, but the Generic HTTP adapter
  currently requests a non-streaming completion.
- Thread persistence and Provider-switch thread separation are connected in
  the shared-terminal integration milestone.
- No command can execute through this layer until the approval/shared-terminal
  adapter in Milestones 8–9 is present.
