# Milestone 3 — Session lifecycle and persistence

## Implemented

- Runtime `terminalId` and durable `sessionId` are separate identifiers.
- New terminals remain temporary and create no Session files by default.
- The first explicit **Activate AI Session** action promotes the current
  terminal in place; repeated promotion is idempotent.
- The main process retains a bounded 8 MiB temporary terminal journal from
  terminal creation, including output, resize, gap, and exit events. Promotion
  backfills that journal before subsequent live events are appended.
- Durable Session metadata records its connection target snapshot, shell,
  effective user when known, timestamps, naming source, and connection state.
- Terminal logs are JSONL event streams stored in gzip-compressed, indexed
  chunks. Automatic retention applies both 90-day and 200 MiB per-Session
  limits; pinned Sessions are exempt from cleanup.
- Activity Audit is stored separately from terminal output. It records Session
  creation, rename, reconnect, disconnect, and interrupted restart state.
- User-renamed Sessions cannot be overwritten by a later automatic name.
- Host details show durable Session history and can reconnect an SSH terminal
  into the existing Session without persisting credentials.
- A clean restart preserves Session metadata, history, and Audit; a formerly
  active Session is marked interrupted rather than pretending its process was
  restored.

## Files changed

- `src/shared/session.ts` and the typed preload IPC contract.
- `src/main/sessions/session-store.ts` for atomic metadata, compressed logs,
  retention, and Audit.
- `src/main/sessions/session-manager.ts` for promotion, binding, reconnect,
  and terminal lifecycle coordination.
- `src/main/terminal/terminal-service.ts` for main-process pre-roll journaling,
  durable Session binding, exited-tab retention, and UTF-8 stream decoding.
- Renderer Host history, Session activation/status, rename, and reconnect UI.

## Tests run

- SessionStore unit tests: no pre-promotion disk writes, journal backfill plus
  live append, compressed chunk index, restart recovery, Audit continuity, and
  manual-name protection.
- Existing Host, shell discovery, and product tests.
- Windows Electron local smoke: send a marker through the visible ConPTY,
  promote that exact terminal, and read the marker back from its compressed
  Session history.
- Real SSH integration and Windows Electron SSH smoke against the designated
  Ubuntu VM after the terminal lifecycle refactor.
- Strict typecheck and production build.

## Manual verification

The smoke Session persisted under isolated workspace data with one metadata
file, two compressed terminal chunks, an index, and two Audit events. The SSH
regression used only a marker command and `exit` on the remote debug VM.

## Known issues / next milestone

- The bounded temporary pre-roll records an explicit gap if more than 8 MiB is
  produced before promotion; it cannot claim unlimited history.
- Remote cwd discovery and user/cwd restoration are deferred to the terminal
  state and recovery milestones. Processes, environment variables, virtual
  environments, and tmux are intentionally not restored.
- Audit is an application activity record, not a tamper-proof compliance log.
- Session history is listed in Host details; a dedicated read-only history tab
  is still pending.
- Milestone 4 adds a linked SFTP browser and asynchronous transfer queue over
  the already-visible SSH connection.
