# Milestone 8 — Shared visible terminal Agent

## Implemented

- The Agent runtime is bound to one durable Session, one AI Thread, and the
  existing visible terminal backend owned by that BrowserWindow.
- Terminal reads come from the Session journal; execution calls
  `TerminalService.executeStructured()` and writes into the same ConPTY or SSH
  `ClientChannel` used by human keystrokes and xterm output.
- Random per-command sentinels are generated in split fragments so the shell's
  input echo cannot be mistaken for actual start/end output.
- PowerShell, CMD, and POSIX/WSL/Git Bash envelopes capture start, output,
  numeric exit code, end time, duration, actor, command, terminal, and Session.
- Command output is bounded before it returns to the Provider while the full
  visible terminal stream continues through xterm and the Session log.
- AI Thread events and command executions persist under the Session. Changing
  Provider creates a new Thread and leaves older Thread files intact.
- Terminal keyboard input is locked while the Agent is thinking or executing;
  status is shown prominently above the terminal.

## Tests run

- Sentinel tests cover echoed input, split markers, bounded streaming output,
  and non-zero exit codes for PowerShell, CMD, and POSIX envelopes.
- Real Ubuntu SSH integration executes a structured marker command and verifies
  status, exit code, captured output, and the same visible SSH data stream.
- Full Electron Agent-over-SSH smoke uses a loopback mock Provider: connect to
  the designated VM, receive a tool call, wait for approval, execute in that
  exact SSH tab, observe the marker in xterm, return the structured result to
  the Provider, and receive a final answer.

## Known issues / next milestone

- Interactive/full-screen programs can remain running and require the takeover
  controls in Milestones 10–11.
- Structured envelopes cannot guarantee an end sentinel if a command exits the
  parent shell deliberately; terminal exit is recorded as a failed execution.
- Codex App Server startup/Auth/account/model UI is available in Milestone 7A,
  but its Thread/Turn Agent data plane is not represented by the Generic mock Provider.
