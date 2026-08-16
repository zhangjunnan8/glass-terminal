# AI Terminal

> 新 AI 窗口/开发者请先读：[`docs/AI_PROJECT_GUIDE.md`](docs/AI_PROJECT_GUIDE.md)。

Windows-first desktop terminal where a human and an AI agent share the same
visible PTY or SSH shell.

> Status: Alpha vertical slice. Local/SSH shared-terminal Agent execution,
> approval, Full Takeover, manual Take Control, secure authentication handoff,
> persistence, and linked SFTP are working and tested. This is not yet the
> finished Core Demo; see `docs/progress/alpha-vertical-slice.md`.

当前界面已提供简体中文并采用放大字号。Codex App Server 的启动、ChatGPT
登录、账号、模型和首选项均可全程在 UI 中完成。Codex 模式使用官方
App Server 的 Thread/Turn 与内建 Shell/File 逻辑，在本应用的独立工作区运行；它不与当前
SSH/本地终端共用 Shell，只有用户开启权限时才能读取当前终端文字。具体边界见
`docs/codex-app-server.md`。
右侧 Agent 面板支持流式输出、安全 CommonMark/GFM 渲染与底部自动跟随；
用户主动向上阅读时不会被新输出强制拉回底部。

## Design invariants

- One terminal session owns exactly one terminal and one active AI thread.
- Generic API Agent input enters the same visible terminal transport as the human;
  approval is the default and Full Takeover is explicit and reversible.
- Native Codex App Server turns run in a separate application workspace. They never
  write to the selected terminal, and terminal text access is an explicit read-only option.
- Credentials are excluded from model context and plaintext logs.
- SSH passwords/private-key passphrases are session-only by default; an
  explicit UI option stores them in the current user's Windows Credential
  Manager for password-free reconnects.
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

当前 `npm run build` 只生成 renderer 与 Electron main/preload 的编译产物，
不会生成 `.exe` 或 Windows Portable 目录。Portable 打包、Codex CLI 资源复制、
签名与干净 Windows 环境验收仍属于后续发布工作。

## Repository map

```text
src/
  main/       Electron main process and platform adapters
  preload/    narrow, typed IPC bridge
  renderer/   React UI
  shared/     IPC contracts and shared types
docs/
  AI_PROJECT_GUIDE.md
  architecture/
  progress/
```

## Privacy

AI Terminal does not include analytics or telemetry. Provider requests must be
initiated by the user and only include the terminal context needed for that
request. Never commit `.env` files, passwords, API keys, private keys, or
session data.
