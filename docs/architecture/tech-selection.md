# Technology selection

Date: 2026-08-14

## Decision

Use **Electron + React + TypeScript + xterm.js**, with platform-neutral core
interfaces and Windows-specific adapters for ConPTY. Production Provider/SSH
secrets currently use the app-owned AES-256-GCM file store behind `SecretStore`;
the older Windows Credential Manager adapter remains available but is not wired
by the composition root.

This is the shortest route to a Windows-first demo without implementing a
terminal emulator or SSH protocol:

- Electron gives one JavaScript/TypeScript runtime for the desktop shell,
  provider streaming, Codex app-server JSONL, SSH, SFTP, and persistence.
- xterm.js is a mature terminal renderer and remains independent from the
  transport.
- node-pty provides ConPTY on Windows and a compatible PTY interface during
  development.
- ssh2 provides SSH shell channels, SFTP, keepalive, resize, agent forwarding
  hooks, keyboard-interactive authentication, and port forwarding.
- React keeps the high-density multi-pane UI maintainable without coupling
  domain state to Electron.

## Alternatives considered

| Option | Result |
| --- | --- |
| Fork an existing terminal | Rejected for the first milestone. It saves terminal UI work but adds unfamiliar lifecycle, licensing, and agent-integration surface. |
| Electron + xterm.js | Selected. Fastest implementation, strongest Node SSH/SFTP and Codex process integration, proven ConPTY path; higher memory use is acceptable for the demo. |
| Tauri + xterm.js | Good future optimization, but Rust IPC, Windows PTY, SSH/SFTP, and provider integration increase first-demo cost. |
| Native Windows UI | Rejected for now. Best native footprint, but duplicates cross-platform UI and provider work and slows the vertical slice. |

## License review

Core dependencies are permissively licensed:

| Dependency | License | Role |
| --- | --- | --- |
| Electron | MIT | Desktop runtime |
| React | MIT | Renderer UI |
| react-markdown | MIT | Safe Agent Markdown rendering |
| remark-gfm | MIT | GitHub-Flavored Markdown support |
| TypeScript | Apache-2.0 | Language/tooling |
| Vite | MIT | Renderer build |
| xterm.js | MIT | Terminal emulator |
| node-pty | MIT | Local PTY / Windows ConPTY |
| ssh2 | MIT | SSH/SFTP transport |

The project itself uses MIT. Chromium and transitive Electron components carry
their own permissive notices and must be included in release attribution.
No GPL/AGPL core dependency is intentionally introduced. The current npm
dependency graph does not include `@openai/codex`, and the green build does not
bundle a Codex executable. Codex App Server integration detects an external
official Codex CLI or accepts a user-selected executable. If a future release
redistributes Codex, it must add the applicable Apache-2.0 license and NOTICE
content. Package versions and
licenses must be re-audited before a public binary release. A redistributed
Codex CLI binary must be accompanied by the complete third-party attribution
bundle rather than relying only on npm package metadata.

## Architectural boundaries

```text
Renderer (xterm + React)
        |
Typed preload IPC
        |
TerminalSessionCoordinator
   |          |             |
LocalPty   SshShell    AgentRuntime
   \          /             |
    SharedTerminalTransport |
             \              /
          TerminalToolRouter
```

The shared terminal transport is the single writer boundary. Both keyboard and
agent commands are serialized into it; agent output is observed from that same
transport.

Platform-specific code lives behind interfaces such as `SecretStore`; terminal,
notification, and shell-discovery implementation details remain in the main
process. Some adapter names in the original decision record were architectural
targets and are not literal exported interfaces in the current source tree.

## Codex integration boundary

Codex is an optional provider adapter, not the domain model. The supported
integration is the official `codex app-server` JSON-RPC protocol over stdio,
including initialize, account/auth, thread, turn, streaming event, and approval
lifecycles. The application must never parse the Codex TUI, simulate Codex CLI
keystrokes, read OAuth tokens directly, or call private endpoints.

Official protocol reference: https://learn.chatgpt.com/docs/app-server
