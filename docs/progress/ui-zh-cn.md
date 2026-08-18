# 中文界面与可读性改造

## Milestone

UI-ZH-CN — Alpha 中文界面与大字号可读性。

## Implemented

- 主窗口、SSH、Session、Agent、审批、认证、接管、Provider 与 SFTP 静态界面中文化。
- 对 Agent、Provider、Session、命令、传输与认证方式使用显示层中文映射，底层协议值保持不变。
- 全界面最小可见字号提升到 12px，常规正文提升到 14px，标题提升到 15–16px。
- xterm 字号由 13px 提升到 15px，行高由 1.18 提升到 1.28，并增加中文字体回退。
- 按钮、输入框、工具栏、弹窗和窄屏 Provider 布局同步放大与防溢出。
- Smoke 测试改用稳定 `data-action`/`data-testid`，不再依赖英文按钮文案。
- Provider 设置在当时明确标注 Codex App Server 尚未接入，并增加独立接入说明；后续 Milestone 7A 已提供中文 UI 控制面。

## Files changed

- `src/renderer/App.tsx`
- `src/renderer/components/SftpDrawer.tsx`
- `src/renderer/components/TerminalPane.tsx`
- `src/renderer/styles.css`
- `src/renderer/ui-text.ts` 与对应单元测试
- `src/main/smoke/smoke-runner.ts`
- 本地 Shell 展示名、原生 SFTP 文件对话框、Provider 连接成功提示
- `README.md`、`docs/codex-app-server.md` 与本进度记录

## Tests run

- `npm run typecheck`：通过。
- `npm test`：13 个测试文件通过、2 个跳过；61 项测试通过、2 项跳过。
- `npm run smoke`：`SMOKE_LOCAL_TERMINAL_READY=true`，同时验证 `zh-CN` 界面标记、12px 分区标题和 14px 搜索框。
- `npm run smoke:agent`：`SMOKE_AGENT_TERMINAL_READY=true`。
- Ubuntu `192.0.2.10`：`npm run smoke:ssh` 与 `npm run smoke:agent:ssh` 均通过。

## Build result

- `npm run build`：TypeScript、Vitest、Vite renderer 与 Electron main/preload 全部通过。
- Vite 仍提示单个 renderer JS chunk 大于 500kB；这是已有的非阻断警告。

## Manual verification

- Electron 本地终端、Agent 审批/全接管/安全认证流程通过自动化 UI smoke。
- 真实 Ubuntu SSH PTY 与 Agent 共享终端流程通过自动化 UI smoke。
- 尚未在 Windows 125%/150% 系统缩放下做人工视觉走查；自动化已断言关键字号下限。

## Known issues

- Terminal、Agent 回复、命令、路径、模型名等动态内容按原文显示。
- 部分来自底层库的自由格式错误仍可能是英文，后续应改为稳定错误码加本地化文案。
- Codex App Server 不属于本次 UI-ZH-CN 提交；其后续 UI 控制面见 `milestone-7a.md`。

## Git commit

- 本里程碑单独提交；见 `git log` 中的中文界面与可读性提交。

## Next milestone

- M7：按官方 stdio JSONL/JSON-RPC 协议接入 Codex App Server、ChatGPT 登录、Thread、流事件与审批。
