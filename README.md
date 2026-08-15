# AI Terminal

Windows-first desktop terminal where a human and an AI agent share the same
visible PTY or SSH shell.

> Status: Alpha vertical slice. Local/SSH shared-terminal Agent execution,
> approval, Full Takeover, manual Take Control, secure authentication handoff,
> persistence, and linked SFTP are working and tested. This is not yet the
> finished Core Demo; see `docs/progress/alpha-vertical-slice.md`.

当前界面已提供简体中文并采用放大字号。Codex App Server 尚未接入；其官方
使用方式与本项目接入边界见 `docs/codex-app-server.md`。

## Design invariants

- One terminal session owns exactly one terminal and one active AI thread.
- Human input and agent input enter the same visible terminal transport.
- Agent commands never execute in a hidden convenience shell.
- Human approval is the default; full takeover is explicit and reversible.
- Credentials are excluded from model context and plaintext logs.
- No telemetry.

## Development

Requirements:

- Node.js 22+
- npm 10+
- Windows 10/11 for ConPTY and portable-package verification

```bash
npm install
npm run dev
```

Quality gates:

```bash
npm run typecheck
npm test
npm run build
```

## Repository map

```text
src/
  main/       Electron main process and platform adapters
  preload/    narrow, typed IPC bridge
  renderer/   React UI
  core/       platform-neutral domain logic
  shared/     IPC contracts and shared types
docs/
  architecture/
  progress/
```

## Privacy

AI Terminal does not include analytics or telemetry. Provider requests must be
initiated by the user and only include the terminal context needed for that
request. Never commit `.env` files, passwords, API keys, private keys, or
session data.
