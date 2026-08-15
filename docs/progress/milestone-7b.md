# Milestone 7B — 隔离 Codex App Server Agent 数据面

## Implemented

- 独立 `codex-app-server-isolated` Agent backend，不伪装成 OpenAI 兼容 Provider。
- App Server server-request dispatcher、实验 API capability 与动态工具响应。
- Thread/Turn runner：`thread/start`/`thread/resume`、`turn/start`、流式消息、`turn/interrupt`、单活动 turn、精确 thread/turn/call ID 与 call-at-most-once。
- 隔离策略：私有 `CODEX_HOME`/cwd、收窄子进程环境、空 environments/workspace roots、只读无网络 sandbox、只注册三个 `terminal_*` 动态工具。
- `terminal_execute` 复用现有 AgentService 审批、Full Takeover、安全认证和同一 TerminalService backend；没有第二个 SSH/PTY/隐藏 exec 通道。
- 内建命令、文件与权限请求拒绝并中断；观察到越界 item 时持久化违规、关闭实验后端并标为未知。
- 实验授权仅在当前应用进程有效；重启后必须重新确认，确保违规记录写盘失败时仍不会自动重新启用。
- 本地 Thread UUID 与上游 App Server thread/turn ID 分离持久化和恢复。
- 全中文 UI：隔离状态、风险确认、违规记录、后端选择、不可用时禁用输入且不静默回退；Full Takeover 只适用于动态 terminal_execute。

## Main files changed

- `src/main/app-server/app-server-turn-runner.ts`
- `src/main/app-server/app-server-client.ts`
- `src/main/app-server/app-server-service.ts`
- `src/main/agent/agent-service.ts`
- `src/main/sessions/session-store.ts`、`session-manager.ts`
- `src/shared/agent.ts`、`codex-app-server.ts`、`session.ts`、`ipc.ts`
- `src/preload/index.ts`、`src/main/index.ts`
- `src/renderer/App.tsx`、`styles.css`、`ui-text.ts`
- 对应 protocol/service/Agent/Session/renderer/组合与真实 CLI gated 测试

## Tests run

- `npm run typecheck`：通过。
- `npm run build`：全量 Vitest 共 107 项通过、3 项按环境条件跳过；Renderer 与 Electron 主进程构建通过。
- Turn Runner、Service、AgentService、Session、UI 映射及故障注入定向测试：通过。
- Fake App Server + real runner + real AgentService 组合测试：通过；覆盖逐条审批、编辑执行、同一 backend 输出回传、内建工具拒绝、违规锁停与 logout 撤权。
- `CODEX_APP_SERVER_REAL_SMOKE=true` 的官方 CLI `initialize + account/read`：1 项通过，使用工作区临时私有 CODEX_HOME。
- Electron：`smoke`、`smoke:agent` 均通过。
- 远程 Ubuntu 调试机：`smoke:ssh`、`smoke:agent:ssh` 均通过；仅执行无落盘 marker 命令。
- `git diff --check`：通过。

## Build result

- 质量门禁通过，产物为 `dist/` 与 `dist-electron/`。当前仍不是 `.exe`/Portable；发布打包属于后续里程碑。

## Manual verification

- UI 的服务、登录、模型、实验确认和 Agent backend 入口全部可在界面完成。
- 自动化不会替用户完成真实 ChatGPT 登录；真实模型 turn 需要用户首次从 UI 授权后验证。

## Known issues

- 隔离数据面仍标为实验。协议明确空 environments 关闭 environment access，但未承诺模型永远不尝试内建工具；因此保留拒绝、中断、事件检测和违规锁停。
- 当前一个 App Server 连接同一时间只运行一个 turn；多个终端不会并行抢用连接。
- Portable `.exe` 尚未配置，Codex vendor 打包、体积、签名、SmartScreen 和第三方 NOTICE 仍属发布工作。

## Git commit

- 本里程碑按协议运行器、数据面/UI 与收口修复分别提交；见 `git log`。

## Next milestone

- 完成真实 UI 登录后的 App Server model turn 人工验收；随后推进 Portable 打包与干净 Windows VM 验证。
