# Milestone 7A — Codex App Server UI 控制面

## Implemented

- Electron main 进程 stdio JSONL 客户端：请求 ID、超时、初始化握手、通知、未知服务端请求拒绝、崩溃清理。
- 官方 Codex CLI 项目依赖与真实可执行探测；区分“路径存在”和“可执行/可握手”。
- 全中文 UI：自动检测并启动、原生文件选择、刷新、重启、浏览器登录、设备码登录、重新打开授权页、取消和退出登录。
- `account/read` 与分页 `model/list`；界面选择模型及推理强度并保存 App Server 首选项。
- 配置白名单持久化；不保存 auth URL、设备码、邮箱或 token。
- 单调 revision 避免 IPC invoke 回包覆盖较新的推送状态。
- 登录通知 trailing refresh、进程早退重放、生命周期串行、认证动作互斥、stdio EPIPE 与损坏配置 UI 恢复。
- Renderer 仅允许未打包 loopback 开发源或打包后的精确入口；全部 IPC 校验受信主窗口与 main frame。
- App Server 内建工具无法硬禁时 fail-closed，不接终端 Agent 数据面。

## Main files changed

- `src/main/app-server/app-server-client.ts`
- `src/main/app-server/app-server-service.ts`
- `src/shared/codex-app-server.ts`
- `src/main/index.ts`、`src/shared/ipc.ts`、`src/preload/index.ts`
- `src/main/security/renderer-trust.ts` 与对应单元测试
- `src/renderer/App.tsx`、`src/renderer/styles.css`、`src/renderer/ui-text.ts`
- App Server 单元测试、UI 静态 smoke、依赖清单、README 与接入说明

## Tests run

- `npm run typecheck`：通过。
- App Server client/service、renderer trust 与中文 UI 映射定向测试：27 项通过。
- `npm test`：16 个测试文件通过、2 个跳过；86 项测试通过、2 项跳过。
- `npm run smoke`：`SMOKE_LOCAL_TERMINAL_READY=true`，包含 App Server 中文 UI 与 14px 正文字号断言。
- `npm run smoke:agent`：`SMOKE_AGENT_TERMINAL_READY=true`。
- Ubuntu `192.0.2.10`：`npm run smoke:ssh` 与 `npm run smoke:agent:ssh` 均通过。

## Build result

- `npm run build`：TypeScript、Vitest、Vite renderer 与 Electron main/preload 全部通过。
- 该命令只生成 `dist/` 与 `dist-electron/` 编译产物，不生成 `.exe` 或 Windows Portable 包。
- Vite 仍提示 renderer 单一 JS chunk 大于 500kB；这是非阻断警告。

## Manual verification

- 官方 npm CLI 的本地 Windows 二进制可执行并返回版本。
- 不执行真实 ChatGPT 登录，避免改变本机登录状态。
- 账号、模型、浏览器登录和设备码生命周期由 fake `AppServerConnection` 的 service 单元测试覆盖；Electron UI smoke 只静态验证中文 App Server 面板、关键文字与 14px 正文字号，不等同于完整 UI 点击链路测试。

## Known issues

- App Server Thread/Turn/stream 尚未接入终端 Agent。
- 官方 dynamic tools 目前不能硬性关闭内建 Shell/File 工具，故共享 PTY 数据面保持禁用。
- Windows Portable 打包尚未实现。当前 win32-x64 Codex vendor 原始大小约为 353.3 MiB；仍需配置 `extraResources` 或等效解包规则，把完整 vendor 资源复制到 `resources/codex/<target-triple>`，并在 PATH 不含 Codex 的干净 Windows 环境验证启动和握手。
- Portable 发布还需要评估包体积、代码签名、SmartScreen 与第三方许可证/NOTICE 收集。

## Git commit

- 本里程碑单独提交；见 `git log`。

## Next milestone

- 为 App Server 建立可验证的工具 allowlist，再接 Thread/Turn、流式消息、取消与本地 Session 映射。
