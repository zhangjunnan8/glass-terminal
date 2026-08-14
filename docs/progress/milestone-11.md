# Milestone 11 — Interactive authentication and secure input

## Implemented

- A bounded local detector recognizes line-ending password, passphrase,
  sudo-password, OTP, verification-code, and 2FA prompts across ANSI-decorated
  and fragmented terminal output. Prompt text and credentials are never sent
  to the model for classification.
- Before exposing `WAITING_AUTH`, the terminal execution is irreversibly
  tainted and a sensitive lease is active. The same xterm becomes
  `secure-human`; the user types directly into the existing PTY/SSH channel.
- On the first CR/LF, the main process truncates and permanently discards the
  remainder of that input chunk, locks terminal input before the backend write,
  rearms retry detection, and atomically notifies the Agent with opaque IDs.
  There is no renderer acknowledgement window and no credential reaches Agent
  IPC, model context, Audit, or plaintext persistence.
- Sensitive mode remains sticky for the whole command. Terminal journal and
  structured output contain only `[Sensitive interaction hidden]`, and the
  execution is marked `outputRedacted=true`. This remains true across delayed
  sentinel chunks, stale lease endings, retry prompts, cancellation, and exit.
- Authentication Audit contains only detected/submitted phases and opaque IDs.
  The Agent receives the redacted command result only after the human handoff.
- During Full Takeover only, strict `[Y/n]`, `[y/N]`, `(Y/n)`, and `(y/N)`
  prompts are handled locally by selecting the one displayed uppercase
  default. Default approval mode never answers silently, and ambiguous
  `[y/n]`/`[Y/N]` prompts are left unanswered.

## Files changed

- `src/main/terminal/interaction-detector.ts`
- `src/main/terminal/structured-command.ts`
- `src/main/terminal/terminal-service.ts`
- `src/main/agent/agent-service.ts`
- Shared IPC contracts, preload/main handlers, renderer auth UI, and styles
- Detector, redaction, AgentService, and Electron smoke tests

## Tests run

- Detector tests cover ANSI and cross-chunk prompts, false-positive prose,
  retry rearming, displayed defaults, and ambiguous confirmations.
- Terminal tests cover sensitive output/journal sticky taint, stale lease end,
  main-process submission proof, multiline paste-tail truncation across CR/LF
  forms, immediate/reentrant input locking, and exact interrupt behavior.
- Agent tests cover `WAITING_AUTH`, atomic secure-human/locked transitions,
  early command end, redacted Provider tool output, and interactive-auth Audit.
- Local and real-SSH Electron smokes send a multiline canary through the actual
  xterm input surface, prove the tail is not executed, resume the Agent, and
  reach the post-auth marker.
- Every file under both isolated smoke profiles was scanned; gzip terminal
  chunks were decompressed before searching. Canary hit count: zero.

## Build result

- `npm run build`: passed.

## Manual verification

- Windows PowerShell `Read-Host -AsSecureString` in the visible ConPTY: passed.
- POSIX `read -s -p` in the visible Ubuntu SSH PTY: passed.

## Known issues

- Detection is intentionally narrow. Arbitrary numeric menus and full-screen
  TUI interaction are not yet generalized; a manual Secure Input toggle is
  also not implemented.
- Raw terminal output remains visible to the trusted xterm renderer by design;
  the guarantee covers Provider context, AI Thread, Audit, and persisted
  terminal logs, not screen capture or renderer-memory forensics.

## Git commit

- Committed with the combined M10/M11 control-state implementation; see the
  milestone commit in `git log`.

## Next milestone

- M12 recovery/state restoration expansion and final Alpha regression report.
