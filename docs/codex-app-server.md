# Codex App Server 使用与接入说明

> 当前状态：AI Terminal Alpha 已接入 App Server 的 **UI 控制面**，包括 CLI
> 检测与启动、ChatGPT 浏览器/设备码登录、账号状态、模型与推理强度选择及首选项保存、
> 刷新、重启、取消登录和退出登录。用户不需要运行 PowerShell、输入 JSON 或复制 token。

官方文档：<https://learn.chatgpt.com/docs/app-server>

## 在界面中使用

1. 打开主窗口左下角的“AI 服务设置”。
2. 选择“Codex App Server”页，点击“自动检测并启动”。
3. 如果自动检测到的 CLI 不可执行，点击“选择 codex 可执行文件…”，在原生文件选择器中指定 `codex.exe`。
4. 服务就绪后，点击“使用 ChatGPT 登录”或“使用设备码登录”。浏览器登录会自动打开授权页；设备码直接显示在界面中，并可点“打开验证页面”。
5. 登录成功后，界面自动读取账号与模型。选择模型、推理强度，点击“保存 App Server 首选模型”。

等待登录期间可从同一界面重新打开授权页或取消登录。登录后可刷新账号、重启
服务或退出登录。整个流程不会要求用户打开系统终端。

## 安全与凭据

- `codex app-server` 只由 Electron main 进程以 stdio 启动；renderer 不能访问子进程或任意 JSON-RPC。
- 浏览器授权地址只在 main 进程内保存，并且仅允许 HTTPS；renderer 只收到显示 UI 所需的登录状态与设备码。
- OAuth token 由 Codex/App Server 自己保存与刷新。AI Terminal 的配置文件只保存可执行文件路径、模型、推理强度和绑定标志。
- App Server 崩溃或连接退出后，账号与模型运行态立即失效；界面提供重新检测、重启和重新登录入口。
- 所有未知的 App Server 主动工具请求默认返回拒绝，避免意外启动隐藏命令链。
- 损坏的 App Server 配置不会阻止主窗口启动；界面会显示可恢复错误，并可通过重新选择 CLI 与保存首选项覆盖。
- 打包态忽略开发服务器环境变量；开发态只接受本机回环地址。全部高权限 IPC 还会复核受信主窗口、主 frame 与精确 renderer 来源。

## 当前共享终端边界

本次没有把 App Server 直接启用为终端 Agent 数据面。官方实验性
`dynamicTools` 可以增加 `terminal_execute`，但目前没有稳定协议字段可以硬性移除
Codex 内建 Shell/File 工具。只靠提示词无法证明每条命令都进入用户看到的同一
PTY/SSH 会话，因此 UI 会明确显示：

> 绑定、登录和模型选择已可用；终端 Agent 链路暂时保持禁用。

现有 OpenAI 兼容 API Agent 仍通过应用自己的 `terminal_execute`、逐条审批、
Full Takeover、安全认证与可见 PTY 链路工作。App Server 只有在能建立可验证的
工具 allowlist 后，才会接入同一条 Agent 命令链。

## 实现概要

- 默认 stdio JSONL 传输；消息不带 `"jsonrpc":"2.0"`。
- 启动后先完成 `initialize`，再发送 `initialized`。
- 账号使用 `account/read`、`account/login/start`、`account/login/cancel` 与 `account/logout`。
- 模型使用分页 `model/list`，模型 ID 和推理强度都由界面选择。
- 每个请求有独立 ID 和超时；支持分片/批量 JSONL、乱序响应、错误响应、stderr 上限和进程退出清理。
- 项目依赖官方 Apache-2.0 `@openai/codex` CLI，同时支持通过 UI 选择其他可执行文件。

## 构建与发布状态

当前 `npm run build` 只编译 renderer 与 Electron main/preload，不生成 `.exe` 或
Windows Portable 包。开发环境可以从 `node_modules` 自动定位平台对应的 Codex
CLI；发布包尚未配置 `extraResources` 或等效解包规则。后续打包必须把完整
Codex vendor 资源复制到 `resources/codex/<target-triple>`，不能只复制
`codex.exe`。当前 win32-x64 vendor 原始大小约为 353.3 MiB，需同时评估包体积、
代码签名、SmartScreen 和 Apache-2.0/第三方 NOTICE 分发要求，并在 PATH 不含
Codex 的干净 Windows 环境完成启动与握手验收。

## 后续数据面

后续接入 Thread/Turn 时，将保留本地 Session Thread ID 与 App Server Thread ID 的
独立映射，处理 `thread/start`/`thread/resume`、流事件与 `turn/interrupt`。只有
命令和文件工具能被硬性限定到 AI Terminal 提供的动态工具后，才会复用现有
Execute/Edit/Reject、Full Takeover、Audit 和共享 PTY 状态机。
