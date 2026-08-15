# AI Terminal

Windows-first desktop terminal where a human and an AI agent share the same
visible PTY or SSH shell.

> Status: Alpha vertical slice. Local/SSH shared-terminal Agent execution,
> approval, Full Takeover, manual Take Control, secure authentication handoff,
> persistence, and linked SFTP are working and tested. This is not yet the
> finished Core Demo; see `docs/progress/alpha-vertical-slice.md`.

当前界面已提供简体中文并采用放大字号。Codex App Server 的启动、ChatGPT
登录、账号、模型、首选项与实验隔离 Agent 启用均可全程在 UI 中完成。实验后端使用
空 environment、私有只读运行目录和三个 `terminal_*` 动态工具，并将命令复用到现有
逐条审批与同一可见 PTY 链路；具体边界见 `docs/codex-app-server.md`。
右侧 Agent 面板支持流式输出、安全 CommonMark/GFM 渲染与底部自动跟随；
用户主动向上阅读时不会被新输出强制拉回底部。

## Design invariants

- One terminal session owns exactly one terminal and one active AI thread.
- Human input and agent input enter the same visible terminal transport.
- Agent commands never execute in a hidden convenience shell.
- Human approval is the default; full takeover is explicit and reversible.
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
