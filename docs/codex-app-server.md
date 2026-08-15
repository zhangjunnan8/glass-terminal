# Codex App Server 使用与接入说明

> 当前状态：AI Terminal Alpha 已接入 App Server 的 **UI 控制面和实验隔离 Agent 数据面**，包括 CLI
> 检测与启动、ChatGPT 浏览器/设备码登录、账号状态、模型与推理强度选择及首选项保存、
> 刷新、重启、取消登录、退出登录，以及明确确认隔离边界后从 Agent 面板选择后端。
> 用户不需要运行 PowerShell、输入 JSON 或复制 token。

官方文档：<https://learn.chatgpt.com/docs/app-server>

## 在界面中使用

1. 打开主窗口左下角的“AI 服务设置”。
2. 选择“Codex App Server”页，点击“自动检测并启动”。
3. 如果自动检测到的 CLI 不可执行，点击“选择 codex 可执行文件…”，在原生文件选择器中指定 `codex.exe`。
4. 服务就绪后，点击“使用 ChatGPT 登录”或“使用设备码登录”。浏览器登录会自动打开授权页；设备码直接显示在界面中，并可点“打开验证页面”。
5. 登录成功后，界面自动读取账号与模型。选择模型、推理强度，点击“保存 App Server 首选模型”。
6. 阅读第 4 段“隔离 App Server Agent（实验）”，点击“启用实验模式…”，勾选风险确认后启用。
7. 回到右侧 AI 智能体面板，在“当前智能体后端”选择“Codex App Server · 隔离实验”，然后发送任务。

等待登录期间可从同一界面重新打开授权页或取消登录。登录后可刷新账号、重启
服务或退出登录。整个流程不会要求用户打开系统终端。

## 安全与凭据

- `codex app-server` 只由 Electron main 进程以 stdio 启动；renderer 不能访问子进程或任意 JSON-RPC。
- 浏览器授权地址只在 main 进程内保存，并且仅允许 HTTPS；renderer 只收到显示 UI 所需的登录状态与设备码。
- OAuth token 由 Codex/App Server 自己保存与刷新。App Server 使用本应用私有的 `CODEX_HOME`；AI Terminal 的配置文件只保存可执行文件路径、模型、推理强度和绑定。实验 Agent 授权不跨应用重启保存，每次启动都需重新确认。
- App Server 崩溃或连接退出后，账号与模型运行态立即失效；界面提供重新检测、重启和重新登录入口。
- App Server 子进程只继承最小系统/代理环境，不继承 API Key、SSH Agent 或常见 token/password 环境变量。
- App Server 主动请求只允许精确匹配当前 thread/turn/call 的三个 `terminal_*` 工具；未知或跨轮次请求不会进入终端。
- 损坏的 App Server 配置不会阻止主窗口启动；界面会显示可恢复错误，并可通过重新选择 CLI 与保存首选项覆盖。
- 打包态忽略开发服务器环境变量；开发态只接受本机回环地址。全部高权限 IPC 还会复核受信主窗口、主 frame 与精确 renderer 来源。

## 当前共享终端边界

实验数据面不把 App Server 当作隐藏 Shell，而把它当作有状态的远程推理后端：

- `thread/start` 和每个 `turn/start` 都使用 `environments: []`。当前官方实验协议将空列表定义为关闭 environment access。
- Thread 使用应用私有空目录、空 runtime workspace roots、只读 sandbox 和关闭网络的 turn sandbox；子进程还使用私有 `CODEX_HOME` 与收窄后的环境变量。
- 客户端只注册 `terminal_read`、`terminal_state`、`terminal_execute`。其中 `terminal_execute` 直接调用已有 `AgentService → TerminalService.executeStructured`，沿用同一 owner、Session、可见 PTY/SSH backend、Execute/Edit/Reject、Full Takeover 和安全认证交接。
- App Server 的内建命令、文件修改与权限审批一律拒绝并中断。“AI 全接管”只影响动态 `terminal_execute`，不会批准这些内建请求。
- 若流事件中观察到 `commandExecution` 或 `fileChange`，应用无法仅凭事件证明是否已产生副作用，因此立即持久化“违规锁停”，把结果标为未知，必须由用户重新审阅和确认才能再次启用。
- 即使违规记录因磁盘故障无法写入，实验启用状态也不会跨进程恢复；下次启动仍保持关闭，避免旧配置 fail-open。

这比单靠提示词更强，但仍标为实验：协议给出了 environment 关闭语义，却没有承诺模型
永远不会尝试内建工具。UI 因此明确展示真实边界，不把“已拒绝请求”夸大为“协议层已删除所有内建工具”。

## 实现概要

- 默认 stdio JSONL 传输；消息不带 `"jsonrpc":"2.0"`。
- 启动后先完成 `initialize`，再发送 `initialized`。
- 账号使用 `account/read`、`account/login/start`、`account/login/cancel` 与 `account/logout`。
- 模型使用分页 `model/list`，模型 ID 和推理强度都由界面选择。
- 每个请求有独立 ID 和超时；支持分片/批量 JSONL、乱序响应、错误响应、stderr 上限和进程退出清理。
- Thread/Turn 使用独立 runner；同一 App Server 同时只允许一个活动 turn，并校验 thread ID、turn ID 与一次性 call ID。
- 本地 Session Thread UUID 与上游 App Server thread ID 分开持久化；重启后使用 `thread/resume`，每一轮重新施加空 environment 和只读 sandbox。
- 流式 assistant delta 显示在 Agent 面板；最终消息、上游 thread/turn 映射、命令执行与审计分别落盘。
- 项目依赖官方 Apache-2.0 `@openai/codex` CLI，同时支持通过 UI 选择其他可执行文件。

## 构建与发布状态

当前 `npm run build` 只编译 renderer 与 Electron main/preload，不生成 `.exe` 或
Windows Portable 包。开发环境可以从 `node_modules` 自动定位平台对应的 Codex
CLI；发布包尚未配置 `extraResources` 或等效解包规则。后续打包必须把完整
Codex vendor 资源复制到 `resources/codex/<target-triple>`，不能只复制
`codex.exe`。当前 win32-x64 vendor 原始大小约为 353.3 MiB，需同时评估包体积、
代码签名、SmartScreen 和 Apache-2.0/第三方 NOTICE 分发要求，并在 PATH 不含
Codex 的干净 Windows 环境完成启动与握手验收。

## 当前验证范围

- Fake App Server + 真实 Turn Runner + 真实 AgentService 的组合测试覆盖了：动态命令审批前零终端写入、编辑批准后只写同一 backend、同一 output canary 返回给 App Server、上游 thread/turn 映射与审计。
- 隔离测试覆盖内建命令/文件/权限请求的拒绝、中断、零终端执行和违规持久锁停。
- 仓库内锁定的真实官方 CLI 已在私有临时 `CODEX_HOME` 下通过 `initialize + account/read` 握手。
- 真实 ChatGPT 登录和真实模型 turn 仍需用户从 UI 完成，不在自动测试中代替用户操作。
