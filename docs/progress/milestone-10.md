# Milestone 10 — Full Takeover and manual Take Control

## Implemented

- Full Takeover can only be enabled through an explicit, target-specific risk
  confirmation. Its red status remains visible above the terminal and in the
  Agent header until the user disables it, manually takes control, changes
  Provider/runtime, disconnects, or restarts the app.
- A waiting approval can open that same risk confirmation. The confirmation is
  bound to the exact terminal and approval ID, shows the final edited command,
  and atomically enables Full Takeover while executing that command once.
- While Full Takeover is active, every command is still recorded as a typed
  `CommandExecution`, but the application does not insert another approval—
  including for destructive-looking commands. Audit records the automatic
  approval as `actor=system` with `fullTakeover=true`.
- Take Control first freezes the Agent in the main process. If a command is in
  the foreground, the UI presents an execution-ID-bound choice to keep the
  process or send exactly one Ctrl+C. A stale choice cannot interrupt a newer
  command.
- If Ctrl+C prevents the structured end sentinel, tracking remains fail-closed
  until the user can see the recovered shell prompt and explicitly releases
  that exact execution. A five-minute command timeout instead closes the
  terminal after a five-second Ctrl+C grace period, preventing command overlap.
- Keeping a process removes its five-minute Agent timeout and leaves it in the
  same visible PTY while the Agent stays paused. New Agent turns are blocked
  until that process finishes.
- A random main-process control lease rejects human terminal IPC while the
  Agent owns input. Renderer keyboard locking is now only a UI reflection of
  that authoritative policy.
- Agent state snapshots carry a per-terminal monotonic revision, so a late IPC
  response cannot overwrite a newer Takeover/state event in the renderer.

## Files changed

- `src/main/agent/agent-service.ts`
- `src/main/terminal/terminal-service.ts`
- `src/shared/agent.ts`, `src/shared/ipc.ts`, `src/shared/session.ts`
- `src/main/index.ts`, `src/preload/index.ts`
- `src/renderer/App.tsx`, `src/renderer/agent-state.ts`
- `src/renderer/components/TerminalPane.tsx`, `src/renderer/styles.css`
- Agent, terminal, renderer-state, and Electron smoke tests

## Tests run

- Unit/integration: exact pending approval atomically enables Full Takeover;
  stale IDs and empty edits make zero state change; two commands then execute
  without another approval; Take Control keep preserves the foreground
  process; late completion cannot resume a paused Agent; exact-ID Ctrl+C is
  sent once; prompt-ready confirmation releases only that execution; timed-out
  commands fail closed; main input gating and stale revisions are enforced.
- Electron local smoke: approval card → exact-ID risk modal → two consecutive
  commands → exact-ID Take Control → Ctrl+C → settled `PAUSED`.
- Electron real-SSH smoke against the designated Ubuntu VM runs the same chain
  in the existing visible SSH PTY.

## Build result

- `npm run build`: passed.

## Manual verification

- Local Windows PowerShell/ConPTY Electron smoke: passed.
- Ubuntu `192.0.2.10` SSH PTY Electron smoke: passed.

## Known issues

- “Keep process running” intentionally blocks a new Agent turn until that
  foreground command ends; arbitrary process reattachment is not implemented.
- After Ctrl+C, the user must explicitly confirm a visible recovered prompt if
  the shell skipped the command's end sentinel.
- Full Takeover is runtime-only and is never restored after application
  restart.

## Git commit

- Committed with the combined M10/M11 control-state implementation; see the
  milestone commit in `git log`.

## Next milestone

- M11 interactive authentication and secure input redaction.
