# Codex App Server 使用与接入说明

> 当前状态：Glass Terminal Beta 已接入 Codex App Server 的完整 UI 控制面和原生
> Agent 链路，包括 CLI 检测与启动、ChatGPT 登录、账号、模型、推理强度、
> Thread/Turn、流式输出、可授权 Workspace Root、可见终端执行以及可选的当前终端只读上下文。
> 用户无需运行 PowerShell、输入 JSON 或复制 token。

官方文档：<https://developers.openai.com/codex/app-server>

## 在界面中使用

1. 打开主窗口左下角的“AI 服务设置”。
2. 选择“Codex App Server”页，点击“自动检测并启动”。应用会依次检查已保存路径、
   打包内置路径、`PATH`、全局 npm 安装以及官方 OpenAI VS Code/Cursor/Windsurf 扩展。
3. 如果自动检测到的 CLI 不可执行，点击“选择 codex 可执行文件…”，在原生文件选择器中指定 `codex.exe`。
4. 服务就绪后，点击“使用 ChatGPT 登录”或“使用设备码登录”。
5. 登录成功后，选择模型和推理强度，点击“保存 App Server 首选模型”。
6. 在第 4 段选择是否“允许 AI 读取当前终端内容”。每个 Turn 始终都会得到非敏感的终端身份与当前目录；开启后才额外允许实时刷新状态和读取近期终端文字。
7. 回到右侧 AI 面板，在“当前智能体后端”选择“Codex App Server · 原生模式”并发送任务。
8. 如需处理工程文件，先设置 Workspace Root，再在 AI 面板选择“只读绑定根”或“读写绑定根”。

等待登录期间可在同一界面重新打开授权页或取消登录。登录后可刷新账号、
重启服务或退出登录。

## 两种 Agent 模式

### 兼容 API

- 依然使用 `terminal_read` / `terminal_state` / `terminal_execute`。
- 命令进入用户正在看到的同一 PTY/SSH Shell。
- 默认逐条 Execute/Edit/Reject；用户可明确开启 Full Takeover，也可人工接管。

### Codex App Server 原生模式

- 使用官方 `thread/start` / `thread/resume` / `turn/start` 和流式 item 协议。
- 未授权 Workspace 时，Codex 内建 Shell/File 在本应用的独立本机工作区运行。
- 授权本地 Workspace 后，内建 Shell/File 直接以该根为 `cwd`；只读授权使用原生只读沙箱，读写授权限制在该根。
- 授权 SSH Workspace 后，内建 Shell/File 仍留在本机独立工作区，远程文件通过现有 SSH 连接的受控 `workspace_*` SFTP 工具处理，无需在远端安装脚本。
- `terminal_execute` 把命令只执行一次于用户正在看的同一 PTY/SSH Shell；默认逐条审批，执行期间临时锁定输入，完成后立即归还用户控制并返回结构化结果。
- 没有 Full Takeover 或“人工接管”按钮；停止 Codex 轮次时，若其可见终端命令仍在运行，会同时发送 Ctrl+C。
- 每轮都注入 local/SSH、target、cwd、effective user、shell、连接状态和 Workspace 执行边界。
- 开启终端上下文权限后，额外注册只读 `terminal_state` + `terminal_read`；该开关不影响 `terminal_execute`。
- 一个 App Server 连接同时只运行一个 Turn，避免多会话串线。
- Generic Provider 与 Codex 分别持久化自己的本地 Thread；切换回来会恢复该后端之前的聊天和上游 thread，不会把另一后端的消息混入。
- Codex 的“修改并重发”使用原生 `thread/fork(lastTurnId)`：Fork 成功后才提交本地替换事件并在新 Thread 上 `turn/start`；Fork 失败时原消息、原回复和原 provider thread 均保持不变。Generic Provider 继续使用原有 Harness 历史重建逻辑。

## 安全与凭据

- `codex app-server` 只由 Electron main 进程以 stdio 启动；renderer 不能访问子进程或任意 JSON-RPC。
- 自动检测先把候选项解析为已存在的绝对路径，再使用 `--version` 验证 `codex-cli`；
  不通过 shell 执行裸 `codex` 命令。Windows Store 中不可从外部执行的应用别名会被跳过。
- Glass Terminal 不会嗅探、附加或复用其他 Codex 进程。stdio 传输属于本应用启动的专用
  App Server 子进程，关闭或崩溃时只清理该进程及未决请求。
- OAuth token 由 Codex/App Server 自己保存与刷新；Glass Terminal 不会读取、拷贝或导出 token。
- 浏览器授权地址仅在 main 进程持有并限制为 HTTPS；renderer 只收到显示所需状态。
- 原生 Turn 优先使用 App Server 的内建 `:workspace` 权限配置，将写入限制在当前本机工作区。只有旧版 App Server 不支持权限配置发现时，才降级为关闭网络的 `workspaceWrite` 沙箱；本地只读授权始终使用显式只读沙箱。内建命令/文件项不会触发可见终端审批，只有 `terminal_execute` 会进入 Glass Terminal 命令审批和控制租约。
- 终端读权限会持久化为布尔配置，不保存终端文本；关闭后新 Turn 仍有每轮身份元数据，但不再得到 `terminal_state`/`terminal_read` 动态工具。
- App Server 崩溃、退出登录或模型绑定失效时，原生 Agent 立即变为不可用。
- 打包态忽略开发服务器环境变量；高权限 IPC 会复核受信主窗口、main frame 和精确 renderer 来源。

## 实现概要

- 默认 stdio JSONL 传输；启动后先 `initialize`，再发送 `initialized`。
- 原生 Turn 按本轮授权选择 App Server `cwd`/`runtimeWorkspaceRoots`：默认独立工作区、本地授权根或显式只读沙箱；远程授权根只通过动态 `workspace_*` 工具访问。
- 账号使用 `account/read`、`account/login/start`、`account/login/cancel` 与 `account/logout`。
- 模型使用分页 `model/list`，模型 ID 和推理强度由界面选择。
- 每个请求有独立 ID 和超时；进程退出会拒绝未决请求并使 UI 状态失效。
- 本地 Session 为每个 Agent 后端分别保存 Thread UUID；Codex Thread 再与上游 App Server thread ID 分开持久化，切换或重连后使用 `thread/resume`。本地 JSONL 仍负责 UI、审计和远程终端绑定，Codex 原生 Thread 负责模型实际上下文；原生分叉结果以 provider thread/turn ID 写入同一条 append-only 修改事件，重启后可恢复新分支。
- 应用实现官方 App Server 协议，支持 PATH、全局 npm 以及官方编辑器扩展中的
  Codex CLI，也支持通过 UI 手动选择 `codex.exe`。手动选择会先验证，只有验证成功才保存
  并替换已运行的连接。当前 npm 依赖和绿色版均不内置 `@openai/codex` 或 Codex vendor 二进制。

## 构建与发布状态

`npm run package` 已可产出 `release/win-unpacked/` 绿色版（electron-builder `--dir`、
asar=false、afterPack 收尾），无需安装即可运行。仍待完成的发布工作：决定是否引入并复制
完整 Codex vendor 资源到包内（当前自动检测/手动选择外部 `codex.exe` 均可工作，但绿色版不自带）、
代码签名/SmartScreen、第三方 NOTICE 收集，以及在干净 Windows 环境验收。

## 当前验证范围

- Fake App Server + 真实 Turn Runner + 真实 AgentService 组合测试覆盖原生 Thread/Turn、流式消息、动态工具 callId 去重、可见终端单次执行、本地/远程 Workspace 路由和内建 command/file 审计。
- 可选 `terminal_state`/`terminal_read` 测试覆盖开/关权限、每轮 cwd/user 刷新和敏感字段白名单；`terminal_execute` 测试断言仅在实际命令期间获取并释放终端控制租约。
- 真实 ChatGPT 登录和真实模型 Turn 仍需用户从 UI 完成，自动测试不会代替用户授权。
- 可通过 `CODEX_APP_SERVER_REAL_SMOKE=true` 运行真实 CLI 集成测试，覆盖自动发现、
  `initialize` / `initialized`、账号状态读取和子进程关闭；测试使用操作系统临时目录，
  不读写用户的 Codex 主目录。
