# Milestone 7D — Codex App Server 原生独立模式

## Implemented

- 将 Codex App Server 从旧“隔离动态终端工具”改为官方原生 Thread/Turn 后端。
- 内建 command/file 使用 Codex 内部逻辑，在应用私有工作区运行。
- Codex 不获取当前终端控制租约，不注册 `terminal_execute`/`terminal_state`，没有 Full Takeover/人工接管。
- 新增独立的“允许 AI 读取当前终端内容”开关；开启时仅注册 `terminal_read`。
- 兼容 API 的共享终端、逐条审批、Full Takeover 与人工接管逻辑保持不变。
- 本地 Thread UUID 与上游 Codex thread/turn 映射继续持久化并支持 resume。

## Tests run

- App Server + Agent 定向测试：54 项通过，8 项旧隔离场景按设计跳过。
- Provider/UI/Session 定向测试：通过。
- `npm run build`：31 个测试文件、180 项通过；3 个文件/10 项按环境或已替换的旧场景跳过；TypeScript、Renderer 和 Electron main/preload 构建通过。
- `npm audit --omit=dev --audit-level=moderate`：生产依赖 0 个漏洞。
- `git diff --check`：通过。

## Build result

- Renderer/Electron 编译产物仍是 `dist/` 与 `dist-electron/`，不是 `.exe`/Portable。

## Known issues

- Codex 原生 Shell/File 不会操作当前 SSH Shell；这是本模式的明确边界。
- 当前单个 App Server 连接同时只运行一个 Turn。
- Portable 发布打包尚未配置。

## Git commits

- `2c6d244 feat: run Codex App Server in native mode`
- `bd5cfff feat: expose native Codex mode in the UI`
