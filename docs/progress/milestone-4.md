# Milestone 4 — Linked SFTP and transfer queue

## Implemented

- The SFTP subsystem is opened from the `ssh2.Client` already owned by the
  visible SSH terminal. Browsing and transfers never create a hidden second
  login and never cache connection credentials.
- A linked file drawer for the active SSH tab supports home-directory loading,
  absolute path navigation, parent, refresh, directory browsing, and file
  metadata.
- Upload selection uses the trusted Electron main-process file dialog and can
  queue multiple files into the current remote directory.
- Download selection uses a main-process save dialog with Windows filename
  sanitization.
- Transfers run asynchronously in the main process. Jobs expose queued,
  running, completed, failed, and cancelled states plus byte progress, attempt,
  revision, error, cancel, and retry.
- Jobs are serialized per SSH terminal so one connection is not flooded, while
  separate terminals can progress independently.
- Uploads and downloads write unique partial files and rename only after a
  complete stream. Failed/cancelled partial files are removed best-effort.
- Upload refuses to overwrite an existing remote path. Download overwrite is
  authorized through the native save dialog and replaces the selected local
  file only after the partial download succeeds.
- Closing or losing the associated visible SSH terminal cancels its queued and
  active transfer jobs.

## Files changed

- `src/shared/sftp.ts` plus the narrow preload bridge.
- `src/main/sftp/sftp-service.ts` for ownership-checked directory browsing.
- `src/main/sftp/transfer-queue.ts` for streaming transfers and lifecycle.
- `src/renderer/components/SftpDrawer.tsx` and related UI styling.
- `TerminalService.openSftp()` keeps SFTP tied to the existing visible SSH
  connection.

## Tests run

- TransferQueue unit tests cover per-terminal FIFO execution, progress,
  terminal-exit cancellation, retry attempts, and BrowserWindow ownership
  isolation.
- Environment-gated real SFTP integration test against the designated Ubuntu
  VM: browse home, create a unique smoke directory, upload, list, download,
  byte-for-byte verify, delete the generated remote file/directory, and verify
  removal.
- Windows Electron SSH smoke opens the SFTP drawer and waits for the real home
  listing while the same visible terminal remains interactive.
- Full unit suite, strict typecheck, production build, local ConPTY smoke, and
  SSH smoke.

## Manual verification

The generated remote smoke directory and its single test file were removed
successfully and verified absent. The generated local round-trip directory was
also removed. These generated artifacts are not recoverable and contained no
user data.

## Known issues / next milestone

- Transfer jobs are intentionally in-memory only and do not resume after an
  application restart.
- Recursive directory transfer, mkdir, rename, delete, drag/drop, SCP, and
  resumable ranges remain later file-management milestones.
- A transfer ends if its owning SSH shell/connection exits; keeping transfers
  alive beyond a terminal tab requires a separate durable Connection model.
- The next milestone adds Provider profiles and then the full shared-terminal
  Agent loop with structured commands and approval.
