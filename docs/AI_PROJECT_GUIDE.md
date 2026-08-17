# AI Terminal — AI 项目交接指南

> 用途：把这份文档作为新 AI 窗口的第一个上下文。它记录当前产品边界、
> 核心调用链、代码地图、数据布局、安全不变量和已知限制。
>
> 最后核对：2026-08-16，功能基线 `b5c69ec`。文档可能落后于代码；实际优先级始终是
> **shared 契约 + main 实现 + 对应测试 > 本文 > `docs/progress/` 历史里程碑**。

## 1. 新 AI 窗口快速开始

1. 完整阅读本文，再读 `README.md`、`docs/codex-app-server.md` 和
   `docs/agent-file-tools.md`。
2. 先执行 `git status --short` 和 `git log -8 --oneline`，不要覆盖用户或其他 Agent 的改动。
3. 开发源码只在当前 Windows 工作区编辑；用户提供的远程主机只是调试目标，
   不是主仓库，也不应存放本项目唯一副本。
4. 用户正在使用应用时，不要运行 `npm run dev`、`npm start` 或 Electron smoke，
   不要关闭/刷新当前窗口。`typecheck`/Vitest/build 是无 UI 验证，可以运行。
5. 每个独立能力先测试和 build，再单独 commit；不要在最后做一个巨型提交。
6. 不要将密码、API Key、私钥、OTP、Credential Manager 引用值或真实测试凭据写入
   文档、测试源码、命令行或 Git。
7. 不修改 Windows 系统设置、用户资料、音响/播放状态。

可直接给新 AI 窗口的提示词：

```text
请先完整阅读 docs/AI_PROJECT_GUIDE.md，然后检查 git status 和最近提交。
以当前源码和测试为准，保持文档中的终端、Session、凭据、Generic Agent 和
Codex App Server 边界。不要启动或刷新我正在使用的 Electron 窗口。
每个独立功能测试通过后单独 commit。
```

## 2. 产品是什么

AI Terminal 是 Windows-first Electron 桌面终端，把本地 PTY/ConPTY、SSH、Session 持久化、
SFTP 和两类 AI 后端整合在同一个中文 UI 中。

两类 Agent 必须严格区分：

| 后端 | 命令/文件在哪里执行 | 与可见终端的关系 |
| --- | --- | --- |
| Generic OpenAI-compatible Provider | `terminal_execute` 进入人类正在看的同一 PTY/SSH；可选 `file_*` 在授权根目录直接处理文本 | 命令默认逐条审批，可显式 Full Takeover，可人工接管 |
| Codex App Server 原生模式 | Codex 内建 Shell/File 在本机 userData 下的独立 workspace | 不写入当前终端，无 Full Takeover/人工接管；每轮获得终端身份，用户开启后可只读 `terminal_state` + `terminal_read` |

**`b5c69ec` 只修复了 Codex 的环境认知，没有把 Codex 内建 Shell 变成 SSH Shell。**
Codex 会明确知道“我在本机 Windows workspace 执行，用户当前绑定的是某个 SSH/本地终端”。

## 3. 当前已完成的功能

- 本地 Shell 发现：PowerShell、CMD、WSL、Git Bash；多 Terminal tabs、xterm resize、Ctrl+C/D、
  本地/SSH 统一右键菜单和复制粘贴快捷键。
- SSH：自定义端口、host-key 指纹信任、keepalive、resize、reconnect，支持 password、
  private key + passphrase、Windows OpenSSH Agent、keyboard-interactive。
- Host：保存/编辑/删除/搜索/收藏，文件夹分组、折叠、拖拽排序；未分组 Host 直接在根级。
- SSH 凭据：默认仅当次连接；用户显式勾选后保存到当前 Windows 用户的
  Credential Manager，以后可空密码重连。
- Session：临时终端第一次使用 AI 时原地升级；保存 terminal log、AI thread、Audit、
  cwd/effective user；SSH 重连尝试恢复用户/目录；支持重命名、详情查看和安全删除。
- SFTP：复用现有 SSH Client，目录浏览/刷新、单文件上传/下载、进度、取消/重试，
  每终端同时最多一个传输，任务区可收起。
- Generic Provider：OpenAI、DeepSeek、智谱 GLM、MiniMax 中国/国际、自定义模板；
  API Key、`/models` 自动检索、下拉/手输模型、Test Connection、默认 Provider。
- Generic Agent：流式输出、安全 CommonMark/GFM、近底部自动跟随、三点运行卡、
  Enter 发送/Shift+Enter 换行；上一条用户消息支持打断、撤回、替换。
- Generic 命令：始终进入同一可见终端；Execute/Edit/Reject、Full Takeover UI 风险确认、
  Take Control（保留前台进程或 exact Ctrl+C）、安全认证交接与脱敏。
- Generic 文件工具：默认 off，Session 内 read-only/read-write；read-write 需 UI 二次确认；
  本地 Node FS / SSH 同连接 SFTP；list/read/write/exact patch、SHA-256 并发保护、原子发布。
- Codex App Server：全 UI 的 CLI 检测/选择、启动/重启、浏览器/设备码登录、账号/登出、
  分页模型、推理强度、Thread/Turn/stream/interrupt/resume、优先 `:workspace` permission profile（旧版回退）。
- UI：中文、放大字号、深色/白色主题、AI 栏隐藏/水平拖宽，单实例应用。

## 4. 总体架构

```text
React renderer + xterm.js
  -> window.aiTerminal (contextBridge)
  -> typed preload IPC
  -> trusted ipcMain handlers
  -> main services
       TerminalService -> node-pty / ssh2 shell / same-client SFTP
       SessionManager  -> SessionStore
       HostService     -> HostStore + Windows Credential Manager
       AgentService    -> GenericHarnessBackend(AgentLoop) | Codex App Server TurnRunner
       SftpService / TransferQueue
```

分层入口：

| 层 | 主要文件 | 职责 |
| --- | --- | --- |
| Renderer | `src/renderer/main.tsx`, `src/renderer/App.tsx` | React UI、tab/sidebar/modal/Agent 交互状态 |
| UI 组件 | `src/renderer/components/` | xterm、SFTP、会话历史、Markdown、运行进度卡 |
| Preload | `src/preload/index.ts` | 唯一 `window.aiTerminal` 桥，不向 renderer 暴露 Node/Electron |
| Shared | `src/shared/*.ts` | 领域 DTO、判别联合、IPC channel 和 `DesktopBridge` 合同 |
| Main 组合根 | `src/main/index.ts` | BrowserWindow 安全选项、受信 IPC、service 装配、userData 路径 |
| Main 领域 | `src/main/{terminal,hosts,sessions,sftp,providers,agent,app-server}/` | 特权 I/O、状态机、持久化和外部协议 |

`src/renderer/App.tsx` 目前仍是大型热点文件。新功能如果有独立状态/测试价值，优先抽到
`components/` 或纯函数模块，不要继续无限扩大 `App.tsx`。

## 5. 核心代码地图

### 5.1 Terminal / PTY / SSH

- `src/main/terminal/terminal-service.ts`
  - `create()`：本地 node-pty/ConPTY。
  - `createSsh()`：ssh2、host key、keyboard-interactive、可见 shell channel。
  - `write()` / control lease：人类输入的 main-process 权威门禁。
  - `executeStructured()`：向同一 backend 写入带随机 sentinel 的命令包装。
  - `interruptExecution()`：核对 exact execution ID 后发送一次 Ctrl+C，并继续等待 sentinel；
    它本身不保证进程已经退出。命令 watchdog 的超时路径才有 grace/fail-closed；若用户已人工
    确认 Shell 恢复，可通过 `confirmShellReady()` 结束旧 execution 跟踪。
  - `beginSensitiveMode()` / `endSensitiveMode()`：认证脱敏租约。
  - `openSftp()`：只从已有 SSH Client 开 SFTP subsystem。
- `src/main/terminal/structured-command.ts`：PowerShell/cmd/POSIX envelope 和 `SentinelCapture`。
- `src/main/terminal/interaction-detector.ts`：password/passphrase/OTP/Y-n 等本地检测。
- `src/main/terminal/shell-discovery.ts`：Windows Shell 发现。
- `src/renderer/components/TerminalPane.tsx`：xterm attach、resize、右键、剪贴板、input lock。

### 5.2 Host / 凭据 / 分组

- `src/shared/host.ts`：Host、folder、SSH connect 契约；VNC/RDP/串口只是未实现的 UI tab 合同。
- `src/main/hosts/host-store.ts`：`hosts.json` v2、旧 group 迁移、folder/排序、identity revision、原子写。
- `src/main/hosts/host-service.ts`：保存/删除/连接/重连编排、每 Host 串行锁、凭据并发保护。
- `src/main/hosts/host-credential-store.ts`：只允许 `AI Terminal/ssh/<host UUID>`。
- `src/main/providers/secret-store.ts`：`WindowsCredentialStore` 与测试用 `MemorySecretStore`。

### 5.3 Session / 持久化 / 历史

- `src/shared/session.ts`：`SessionRecord`、journal/audit 类型、历史预览/并发删除请求。
- `src/main/sessions/session-manager.ts`
  - `upgrade()`：临时 Terminal -> 正式 Session，回填升级前由 main 保存的临时 journal。
  - `reconnect()`：校验 transport/host 且 hostname/port/username 完全相同，再尝试恢复用户/目录。
  - journal listener：持久化输出并保守推断 cwd/effective user。
- `src/main/sessions/session-context.ts`：Shell prompt 上下文识别和 SSH 恢复输入。
- `src/main/sessions/session-store.ts`：metadata、gzip chunks/index、AI JSONL、Audit、retention、原子隔离删除。
- `src/main/sessions/session-history.ts`：有界对话预览和 ANSI/控制字符清理。
- `src/renderer/components/SessionHistoryDialog.tsx`：历史详情和二次确认删除。

### 5.4 Generic Provider Agent（共享可见终端）

- `src/main/agent/agent-service.ts`：两种 backend 的总控制器。
  - `sendPrompt()` / `interruptTurn()` / `revisePrompt()`。
  - `resolveApproval()` / `setFullTakeover()` / `takeover()`。
  - `runTurn()`：Generic 路径。
  - `requestCommand()`：审批 -> `TerminalService.executeStructured()` 的唯一命令链。
  - `ensureRuntime()`：Terminal/Session/AI thread/backend 绑定与恢复。
- `src/main/agent/agent-loop.ts`：tool schema、最多 12 rounds、结果路由和历史压缩。
- `src/main/agent/generic-provider.ts`：OpenAI-compatible `/chat/completions` + SSE 解析与容量门禁。
- `src/main/agent/langchain-backend.ts`：**生产默认的 Generic Harness**（`index.ts` 经
  `LangChainProviderModelFactory` 接线），用 LangChain.js 的 `ChatOpenAICompletions` 跑调用循环；
  工具仍全部来自 `ToolGateway`，LangChain 自带 shell/file 工具从不注册。SSE 流式、模型懒加载
  （API key 留在 secret store、recipient revision 栅栏）。`agent-loop.ts`/`generic-provider.ts`
  保留为兼容/测试路径。
- `src/main/providers/provider-store.ts`：Provider CRUD、HTTPS/URL 校验、`/models`、Ready 状态。
- `src/shared/provider-templates.ts`：内置 API 模板。

### 5.5 Generic 直接文件工具

- `src/main/agent/agent-file-service.ts`：本地 Node FS / SSH same-client SFTP 的 list/read/write/patch。
- `src/main/agent/agent-loop.ts`：`file_*` 工具可见性、读取总预算、完成后压缩。
- `docs/agent-file-tools.md`：权限、限额和推荐工作流。

边界：文件权限默认 off，只在当前进程/Session 内有效；授权时把正式 Session 的
规范 cwd 冻结为根。覆盖需要最近 read 得到的 SHA-256，并使用临时文件+原子发布。
命令、删除、移动、chmod、测试和部署仍走可见 `terminal_execute`。

### 5.6 Codex App Server（本机独立 workspace）

- `src/main/app-server/app-server-client.ts`：启动 `codex app-server`、stdio JSONL、request map、notification/server request、
  timeout/exit/EPIPE 处理。
- `src/main/app-server/app-server-service.ts`：CLI 检测、登录/账号/模型、配置、独立 runtime 目录、生命周期串行化。
- `src/main/app-server/app-server-turn-runner.ts`：Thread start/resume、Turn、流式 item、interrupt、
  permission profile、精确 thread/turn/call ID 路由与 quarantine。
- `AgentService.runCodexTurn()`：本地 thread UUID <-> 上游 App Server thread ID 持久映射。
- `src/shared/codex-app-server.ts`：UI snapshot 和 `CodexVisibleTerminalContext`。
- `docs/codex-app-server.md`：用户操作与边界。

Codex 的 `cwd`/`runtimeWorkspaceRoots` 始终是：

```text
<userData>/config/codex-app-server-runtime/agent-workspace
```

每个 Turn 都追加权威 `<ai_terminal_binding>`：transport、target、cwd、effective user、shell、
connected/disconnected，以及“内建工具仍在本机”的边界。开启读取开关后才额外注册
`terminal_state` + `terminal_read`；永远没有 `terminal_execute`。

权限上优先要求允许的 `:workspace` profile；只有服务器明确不支持
`permissionProfile/list` 时才降级到关闭网络的旧 `workspace-write`。如果 profile 存在但被管理员
禁止，则 fail closed，不会用更宽松的 legacy 模式绕过。Codex 对 exact active Turn 的内建
command/file 审批自动返回 `acceptForSession`，额外权限请求始终拒绝；这些审批不会进入可见终端 UI。

### 5.7 SFTP

- `src/main/sftp/sftp-service.ts`：绝对 POSIX 路径目录列表。
- `src/main/sftp/transfer-queue.ts`：每 terminal 同时最多一个任务、不同 terminal 可并行，`.part` -> rename，
  进度/取消/重试。任务只在内存中，重启不恢复；retry 后不承诺严格 FIFO。
- `src/renderer/components/SftpDrawer.tsx`：浏览器与可收起任务区。

## 6. 七条主调用链

1. **本地终端**：`App` -> preload `terminal.create` -> main IPC -> `TerminalService.create()` ->
   node-pty -> `terminal:data` -> `TerminalPane` xterm。
2. **SSH**：连接对话框 -> `HostService.connect()` -> Credential Manager/输入凭据 ->
   `TerminalService.createSsh()` -> host-key 处理 -> shell descriptor/tab -> 可选 `SessionManager.reconnect()`。
3. **首次 AI**：`agent.sendPrompt` -> `AgentService.ensureRuntime()` -> `SessionManager.upgrade()` ->
   回填 main-side 临时 journal -> 建立/恢复一个本地 AI thread。
4. **Generic 命令**：`AgentService` -> `AgentBackend.sendMessage()` -> `GenericHarnessBackend` ->
   本轮显式 `ToolGateway` -> `terminal_execute` -> `AgentService.requestCommand()` -> UI 审批/Full Takeover ->
   `TerminalService.executeStructured()` -> 同一可见 backend -> 结构化 result -> 继续 loop。
5. **Generic Workspace**：用户显式设置 Workspace Root 并临时授权 ->
   `workspace_list/search/glob/read_file/apply_patch/...` -> `SessionToolGateway` ->
   `AgentFileWorkspaceAdapter` -> LocalFilesystem/已有 SSH Client 的 SFTP。文件正文和 diff 不进 Terminal journal，
   Agent 状态只发送有界、脱敏的 Tool Activity 摘要。
6. **Codex**：UI 启动/登录/选模型 -> `CodexAppServerService` -> `AppServerClient` ->
   `AgentService.runCodexTurn()` -> `TurnRunner` thread/turn -> 本机 Codex workspace；可见终端只提供身份/可选只读内容。
7. **持久化**：Terminal output -> journal listener -> gzip chunk；Agent chat/turn ->
   `ai/<local-thread-uuid>.jsonl`；重要操作 -> append-only `audit.jsonl`。

## 7. 必须保持的不变量

1. PTY/SSH/SFTP/磁盘/凭据/child process 只在 main；renderer 只能通过 preload 窄桥。
2. 所有 invoke 必须经 `assertTrustedSender()`：已登记 WebContents、main frame、精确受信 URL。
3. Host != Session != runtime Terminal。一个 runtime Terminal 最多绑一个正式 Session；
   一个 Session 不能同时重连到两个活动 Terminal。
4. SSH Session 重连前必须核对 hostname/port/username，不能把旧 cwd/AI thread 发给同 hostId 的新目标。
5. Generic Agent 的每条命令只能经 `terminal_execute`，人类和 AI 共用同一 backend。
   禁止新建 hidden exec/SSH 后再回显。
6. 默认逐条审批；Full Takeover 必须经过 UI 显式风险确认且可 Take Control。该确认依赖受信
   renderer + trusted IPC 边界，并不是 main 另发 challenge token 的双层授权协议。
7. 人类输入锁必须在 main 的 control lease 强制，不能只信任 renderer disabled。
8. Agent 命令中被本地 detector 识别的认证交互只进同一终端，不进模型/thread/明文
   journal/Audit；安全粘贴中首个换行后的尾部必须丢弃。普通人工终端没有通用 DLP，
   用户主动回显的秘密仍可能进入 terminal journal 和后续 Provider 上下文。
9. Codex native 与可见终端不共享 Shell；只有独立本机 workspace，可选 state/history read-only，没有 terminal execute/lock/Full Takeover。
10. Codex 同一 App Server 连接同时最多一个 active Turn；必须 exact threadId/turnId/callId，
    无法证明旧 Turn 终止时必须阻止新 Turn 或 quarantine 连接。
11. 已保存的 SSH/API secret 不进 AI Terminal 配置 JSON，renderer 也取不到其明文；首次输入仍会
    短暂存在受控输入框并经 IPC 交给 main。OAuth 凭据由隔离的 Codex home 自行保存/刷新，
    AI Terminal 不读取、复制或导出。Credential Manager 只用 UUID-scoped reference；Host 的
    hostname/port/username/auth method/private-key path 变化会退役旧凭据，只有 hostname/port
    变化才清除 server fingerprint。
12. Agent 文件权限默认 off、不跨重启；根在授权时规范化冻结，拒绝 traversal/root replacement/symlink overwrite。
13. chat/thread/audit 是 append-only。“撤回/修改上一条”只追加 `chat_action`，不回滚已执行的终端/文件副作用。
14. 删除 Session 只允许 disconnected，并校验 `expectedUpdatedAt + expectedRuntimeTerminalId`。
15. Terminal/Agent/Transfer 都按 WebContents owner 校验；窗口销毁时必须清理它的运行时资源。
16. 无 telemetry；只向用户选定的 Provider 发完成当前请求所需的最小上下文。

## 8. userData 数据布局

```text
<Electron userData>/
  config/
    hosts.json                         # Host/folder/order + credential reference, no password
    providers.json                     # Provider metadata + credential reference, no API key
    codex-app-server.json              # executable/model/effort/context switch, no OAuth token
    codex-app-server-runtime/
      codex-home/                      # isolated CODEX_HOME, owned by Codex
      server-cwd/
      agent-workspace/                 # native Codex built-in Shell/File workspace
  sessions/<session-uuid>/
    session.json
    audit.jsonl
    ai/<local-thread-uuid>.jsonl
    terminal/
      index.json
      00000001-<uuid>.jsonl.gz
      ...
```

- Terminal chunk 目标 64 KiB，最多等待 200 ms 刷盘。
- 非 pinned Session 的 terminal log 同时受 90 天和每 Session 200 MiB 限制。
- AI thread 和 Audit 不随 terminal retention 自动删除。
- 应用重启时，上次仍 active 的 Session 转为 interrupted/disconnected；不伪装恢复进程/env/venv/tmux。

## 9. 容量门禁与 `Provider response is too large`

Generic Provider 本地门禁在 `src/main/agent/generic-provider.ts`：

| 项目 | 上限 |
| --- | ---: |
| 非流式 JSON response | 8 MiB |
| 整条 SSE wire | 32 MiB |
| 单个 SSE event | 2 MiB / 4096 lines |
| 单次助手文本 | 100,000 字符 |
| tool calls | 64 |
| 单个 tool arguments | 1,048,576 个 JavaScript 字符 |
| 所有 tool arguments 合计 | 2,097,152 个 JavaScript 字符 |

这个错误可能是 AI Terminal 为防止截断工具调用/内存膨胀主动拒绝，也可能是上游
Provider 的限制。不要第一反应就继续放大上限。

大型代码任务的正确路线：

1. 开启 Generic Agent 的 read-only 或 read-write 文件权限。
2. `workspace_list/search/glob` -> `workspace_read_file` 只读必需文件 -> 优先小型 `workspace_apply_patch`；`workspace_write_file` 只用于一次能完整提交的
   文件，它是整文件原子覆盖，不支持 append/offset/分片拼接。
3. 不要让模型在最终回答/单个 tool arguments 里回显整个仓库或数十个大文件。
4. 用可见 `terminal_execute` 运行构建、测试、部署、chmod、sudo 和有副作用的 Git 命令；普通 Workspace 内 mkdir/rename/delete 使用结构化 Workspace 工具。
5. 超大仓库按模块/目标拆成多个 turn；较大文本文件按重新 read/hash 后的精确 patch 分轮处理，
   无法落在文件工具边界内时改走可见终端；二进制或超大文件走 SFTP queue。

Generic 文件工具限制：单 UTF-8 文件 read/service write 512 KiB，`workspace_write_file` 单次
131,072 字符，每 turn 读/列表结果合计 2 MiB，目录 500 项，exact patch 64 条；一个
Agent turn 最多 12 rounds。当前没有通用 conversation token-budget/自动总结器，超大仓库或长会话仍应拆分。

## 10. 测试和构建

要求：Node.js >= 22，npm >= 10。

```powershell
npm install
npm run typecheck
npm test
npm run build
```

- `npm run build` = typecheck + 全部 Vitest + renderer build + main/preload build。
- `npm start` 只运行已有 `dist/` + `dist-electron/`，不会先重编译。
- `npm run dev` 会启动 Vite + Electron；用户已打开应用时不要运行。
- 最后功能基线验证：test files 为 39 passed / 3 skipped（42 total），tests 为
  241 passed / 10 skipped（251 total）；
  Renderer/Electron 构建通过。主 renderer chunk 约 617 kB，仍有 Vite >500 kB 警告。

真实 SSH/SFTP 测试只在显式提供下列环境变量时运行，不要将值提交到仓库：

```text
AI_TERMINAL_SSH_TEST_HOST
AI_TERMINAL_SSH_TEST_PORT
AI_TERMINAL_SSH_TEST_USER
AI_TERMINAL_SSH_TEST_PASSWORD
CODEX_APP_SERVER_REAL_SMOKE=true
```

前四项 SSH 变量用于 SSH/SFTP 条件测试；`CODEX_APP_SERVER_REAL_SMOKE` 只启用真实 bundled
App Server 的 initialize/account-read smoke，不代替 OAuth，也不运行真实模型 Turn。

重要测试地图：

- Terminal/secure auth/sentinel：`src/main/terminal/*.test.ts`
- Host/凭据/文件夹：`src/main/hosts/*.test.ts`
- Session/恢复/历史：`src/main/sessions/*.test.ts`
- Generic loop/provider/file tools：`src/main/agent/*.test.ts`
- Codex JSONL/service/turn/组合：`src/main/app-server/*.test.ts`
- SFTP/queue：`src/main/sftp/*.test.ts`
- Renderer 交互：`src/renderer/*.test.ts`、`src/renderer/*.test.tsx`、
  `src/renderer/components/*.test.tsx`
- 高权限 IPC 来源：`src/main/security/renderer-trust.test.ts`

## 11. 当前未完成/部分完成

- **没有 `.exe`/Portable/installer**。尚无 electron-builder/forge/packager；`dist/` 和
  `dist-electron/` 只是编译产物。还需 Codex vendor 复制、签名/SmartScreen、NOTICE 和干净 Windows 验收。
- Host 只实现 SSH；VNC/RDP/串口是可查看的占位配置 tab，但保存被禁用且没有连接能力。
- Host 复制尚未实现；AI 自动生成有意义的 Session 名称尚未接入，只有初始/手工命名和
  “手工名不被 automatic 覆盖”的数据保护。
- 未实现 ProxyJump、SSH config import、持久 port forwarding、SCP。
- SFTP 尚无 mkdir/rename/delete/copy path/jump cwd/drag-drop/recursive/resume/speed display；
  transfer jobs 不落盘，应用重启后消失，SSH terminal 退出时取消。
- 不恢复前台进程、env、venv/conda 或 tmux；本地 Session 目前只能看历史，没有 reconnect/reopen 链路。
- `pinned` 数据和 retention 例外存在，但尚无 pin UI/API。
- Generic file tools 无 delete/move/chmod/二进制/>512 KiB；当前只有一个冻结 cwd 根，
  无 Host 记忆和细粒度 read/write/create/delete path policy。
- Codex native 不能用内建 Shell 操作当前 SSH；如果任务必须在远程执行，选 Generic Provider
  的可见终端/文件工具，或未来另做用户明确授权的远程执行桥。
- 真实 ChatGPT OAuth + 真实 Codex model turn 仍需用户在 UI 人工验收。
- 无 Settings import/export、Session backup/restore、通用大任务进度窗口、Windows notification。
- 无 split pane；Terminal/AI pop-out/remerge、独立 AI Chat、AI 栏拖到左/底部未实现。
- 主题只有 dark/light，没有跟随 System；没有快捷键重映射和默认 Shell 设置 UI。

## 12. 常见改动应该从哪里入手

| 需求 | 先看 | 必须同步检查 |
| --- | --- | --- |
| 新 Terminal 行为 | `terminal-service.ts`, `TerminalPane.tsx` | `shared/terminal.ts`, preload/main IPC、Terminal tests |
| 新 Host/SSH 字段 | `shared/host.ts`, `host-store.ts`, `host-service.ts` | 迁移/白名单 DTO、凭据退役、renderer form/tests |
| Session 恢复/历史 | `session-manager.ts`, `session-store.ts` | 目标身份校验、append-only/audit、删除并发保护 |
| Generic 新 tool | `agent-loop.ts`, `agent-service.ts` | tool schema/参数限额/历史压缩/审批/持久化脱敏 |
| Generic Provider 协议 | `generic-provider.ts`, `provider-store.ts` | SSE/JSON 终态、响应上限、secret 不返回 renderer |
| Codex 协议 | `app-server-client.ts`, `app-server-turn-runner.ts` | generation、exact IDs、中断/quarantine、permission profile、UI snapshot |
| AI UI | `App.tsx`, `components/`, `styles.css` | revision newer-wins、串流合并、滚动意图、白/深主题、最小窗口 |
| 新 IPC | 对应 `shared/*.ts` channel + `shared/ipc.ts` | preload 窄桥、`handleTrusted`、runtime schema/所有 renderer fixtures |
| 新持久数据 | 对应 Store | 白名单 parse、原子写、旧 schema 迁移、不存 secret |

## 13. 交付前检查清单

- [ ] `git diff` 只包含本次功能，未覆盖其他人改动。
- [ ] 新/改 shared 合同已同步 main、preload、renderer mock。
- [ ] 已运行最小定向测试和 `npm run typecheck`。
- [ ] 核心链路改动已运行 `npm run build`。
- [ ] 未在测试/日志/Git 中存放真实 secret。
- [ ] 未用 hidden shell/hidden SSH 伪造 Generic 可见终端结果。
- [ ] Codex native 文案没有宣称内建工具在 SSH 上执行。
- [ ] 深色/白色主题、窄 AI 栏、980x640 最小窗口的状态和错误仍可见。
- [ ] 独立功能已单独 commit，最终 `git status --short` 为空。
