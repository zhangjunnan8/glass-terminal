# Codex App Server 使用与接入说明

> 当前状态：Glass Terminal Alpha 已接入 Codex App Server 的完整 UI 控制面和原生
> Agent 链路，包括 CLI 检测与启动、ChatGPT 登录、账号、模型、推理强度、
> Thread/Turn、流式输出、内建 Shell/File 项目以及可选的当前终端只读上下文。
> 用户无需运行 PowerShell、输入 JSON 或复制 token。

官方文档：<https://learn.chatgpt.com/docs/app-server>

## 在界面中使用

1. 打开主窗口左下角的“AI 服务设置”。
2. 选择“Codex App Server”页，点击“自动检测并启动”。
3. 如果自动检测到的 CLI 不可执行，点击“选择 codex 可执行文件…”，在原生文件选择器中指定 `codex.exe`。
4. 服务就绪后，点击“使用 ChatGPT 登录”或“使用设备码登录”。
5. 登录成功后，选择模型和推理强度，点击“保存 App Server 首选模型”。
6. 在第 4 段选择是否“允许 AI 读取当前终端内容”。每个 Turn 始终都会得到非敏感的终端身份与当前目录；开启后才额外允许实时刷新状态和读取近期终端文字。
7. 回到右侧 AI 面板，在“当前智能体后端”选择“Codex App Server · 原生模式”并发送任务。

等待登录期间可在同一界面重新打开授权页或取消登录。登录后可刷新账号、
重启服务或退出登录。

## 两种 Agent 模式

### 兼容 API

- 依然使用 `terminal_read` / `terminal_state` / `terminal_execute`。
- 命令进入用户正在看到的同一 PTY/SSH Shell。
- 默认逐条 Execute/Edit/Reject；用户可明确开启 Full Takeover，也可人工接管。

### Codex App Server 原生模式

- 使用官方 `thread/start` / `thread/resume` / `turn/start` 和流式 item 协议。
- Codex 内建 Shell/File 逻辑在本应用的独立工作区运行，不是当前 SSH 或本地终端。
- 当前终端始终保持用户控制；没有 Full Takeover 或“人工接管”按钮。
- 每轮都注入 local/SSH、target、cwd、effective user、shell 和连接状态，并明确内建工具仍在本机工作区。
- 开启终端上下文权限后，额外注册只读 `terminal_state` + `terminal_read`；永不注册 `terminal_execute`。
- 一个 App Server 连接同时只运行一个 Turn，避免多会话串线。

## 安全与凭据

- `codex app-server` 只由 Electron main 进程以 stdio 启动；renderer 不能访问子进程或任意 JSON-RPC。
- OAuth token 由 Codex/App Server 自己保存与刷新；Glass Terminal 不会读取、拷贝或导出 token。
- 浏览器授权地址仅在 main 进程持有并限制为 HTTPS；renderer 只收到显示所需状态。
- 原生 Turn 优先使用 App Server 的内建 `:workspace` 权限配置，将写入限制在当前工作区。只有旧版 App Server 不支持权限配置发现时，才降级为关闭网络的 `workspaceWrite` 沙箱。内建命令/文件项由 Codex 内部连续运行，不会触发可见终端的审批或输入锁。
- 终端读权限会持久化为布尔配置，不保存终端文本；关闭后新 Turn 仍有每轮身份元数据，但不再得到 `terminal_state`/`terminal_read` 动态工具。
- App Server 崩溃、退出登录或模型绑定失效时，原生 Agent 立即变为不可用。
- 打包态忽略开发服务器环境变量；高权限 IPC 会复核受信主窗口、main frame 和精确 renderer 来源。

## 实现概要

- 默认 stdio JSONL 传输；启动后先 `initialize`，再发送 `initialized`。
- 原生 Turn 先通过 `permissionProfile/list` 确认 `:workspace` 可用，然后在 Thread/Turn 中传入 `permissions: ":workspace"`；不再发送已废弃的 `workspaceWrite.readOnlyAccess`。
- 账号使用 `account/read`、`account/login/start`、`account/login/cancel` 与 `account/logout`。
- 模型使用分页 `model/list`，模型 ID 和推理强度由界面选择。
- 每个请求有独立 ID 和超时；进程退出会拒绝未决请求并使 UI 状态失效。
- 本地 Session Thread UUID 与上游 App Server thread ID 分开持久化；重连后使用 `thread/resume`。
- 项目依赖官方 Apache-2.0 `@openai/codex` CLI，同时支持通过 UI 选择其他可执行文件。

## 构建与发布状态

`npm run package` 已可产出 `release/win-unpacked/` 绿色版（electron-builder `--dir`、
asar=false、afterPack 收尾），无需安装即可运行。仍待完成的发布工作：复制完整 Codex
vendor 资源到包内（当前自动检测/手动选择外部 `codex.exe` 均可工作，但绿色版不自带）、
代码签名/SmartScreen、第三方 NOTICE 收集，以及在干净 Windows 环境验收。

## 当前验证范围

- Fake App Server + 真实 Turn Runner + 真实 AgentService 组合测试覆盖原生 Thread/Turn、流式消息、内建 command/file 自动放行与审计。
- 可选 `terminal_state`/`terminal_read` 测试覆盖开/关权限、每轮 cwd/user 刷新和敏感字段白名单，并断言 Codex 路径不获取终端控制租约。
- 真实 ChatGPT 登录和真实模型 Turn 仍需用户从 UI 完成，自动测试不会代替用户授权。
