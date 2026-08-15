# Milestone 7C — Agent 流式输出、Markdown 与跟随滚动

## Implemented

- OpenAI 兼容 Provider 改为真实 SSE 流式读取，支持 UTF-8/分片事件、文本 delta 与分片 tool call 重建。
- Codex App Server 只将 `final_answer` 流入最终助手消息，不再把 commentary 与最终答案拼在一起。
- Agent 消息以稳定 ID 增量更新，流式通知按文本长度合并；人工接管会保留已收到的部分答案并停止迟到刷新。
- 生成中使用转义后的纯文本渲染，完成后再安全渲染 CommonMark/GFM：标题、粗体、列表、表格、任务列表和代码块。
- Markdown 禁用 raw HTML/远程图片，只允许无凭据的 HTTPS 链接和页内锚点，不使用 `dangerouslySetInnerHTML`。
- 右侧 Agent 面板在用户处于底部时自动跟随流式输出；用户主动向上阅读时不抢滚动位置，并提供“回到底部”提示。
- 流式与非流式 Provider 响应都使用有界读取；截断、不安全 finish reason 或超限响应会 fail closed，不会执行不完整 tool call。
- App Server 人工接管后，在旧 turn 确认停止前阻止新 prompt，避免软件先显示暂停但底层 turn 仍未结束的竞态。

## Main files changed

- `src/main/agent/agent-loop.ts`、`generic-provider.ts`、`agent-service.ts`
- `src/main/app-server/app-server-turn-runner.ts`
- `src/renderer/App.tsx`、`styles.css`
- `src/renderer/components/AgentMessageContent.tsx`
- `src/renderer/agent-scroll.ts`
- `src/main/smoke/agent-provider-server.ts`、`smoke-runner.ts`
- 对应 Agent/Provider/App Server/Renderer/Smoke 测试

## Tests run

- `npm run typecheck`：通过。
- Provider/Agent/App Server/Markdown/滚动定向测试：通过。
- `npm run build`：20 个测试文件、136 项通过，3 个文件/3 项按环境条件跳过；Renderer 与 Electron main/preload 构建通过。
- Electron `smoke:agent`：通过，覆盖未完成时的部分流、完成后的语义化粗体和自动滚到底部。
- Electron `smoke`：本地终端与主界面启动通过。
- `npm audit --omit=dev --audit-level=moderate`：生产依赖 0 个漏洞。
- `git diff --check`：通过。

## Build result

- 质量门禁通过；产物仍是 `dist/` 与 `dist-electron/`，不是 `.exe`/Portable。

## Manual verification

- 已启动的用户窗口未被关闭或重载；本次源码和构建修改要在用户主动重启应用后生效。

## Known issues

- 超长回答会触发本地容量上限并安全停止，以保护 Electron 主进程与 Renderer 不被无界输出卡死。
- Renderer 主 bundle 仍有 Vite 的 500 kB chunk 告警，后续可将 Markdown 渲染器拆分为独立 chunk。
- Portable `.exe` 尚未配置。

## Git commit

- 本里程碑独立提交；见 `git log`。

## Next milestone

- 完成 Portable Windows 打包、Codex vendor 资源复制与干净 Windows VM 验收。
