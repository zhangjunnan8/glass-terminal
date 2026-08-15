# Codex App Server 使用与接入说明

> 当前状态：AI Terminal Alpha **尚未接入** Codex App Server。设置页现有的
> Base URL、Model ID 和 API Key 表单只用于 OpenAI 兼容 HTTP API，不能连接
> App Server，也不代表已经登录 ChatGPT。

官方文档：<https://learn.chatgpt.com/docs/app-server>

## 它是什么

`codex app-server` 是给桌面端、IDE 等富客户端使用的官方 Codex 接口，提供
ChatGPT/API Key 登录、Thread/Turn 历史、流式事件、命令与文件审批等能力。
它使用双向 JSON-RPC 风格消息；线上不带 `"jsonrpc":"2.0"` 字段。

## 本机启动方式

先确认已安装且可运行 Codex CLI：

```powershell
codex --version
```

桌面应用集成应使用默认 stdio 传输：

```powershell
codex app-server
```

此命令会等待客户端通过标准输入逐行发送 JSON，并通过标准输出逐行返回 JSON；
它本身不是供人直接聊天的终端界面。客户端连接后的最小生命周期如下：

1. 发送 `initialize`，再发送无 `id` 的 `initialized` 通知。
2. 用 `account/read` 检查登录状态；必要时启动 ChatGPT 浏览器或设备码登录。
3. 用 `thread/start` 创建会话，或用 `thread/resume` 恢复已有会话。
4. 用 `turn/start` 发送用户请求，并持续消费流式通知。
5. 收到命令或文件审批请求时，在 UI 中向用户展示，并用原请求 `id` 回复决定。
6. 以 `turn/completed` 作为本轮最终状态；取消时使用 `turn/interrupt`。

初始化示例（每个对象各占一行）：

```json
{"method":"initialize","id":0,"params":{"clientInfo":{"name":"ai_terminal","title":"AI Terminal","version":"0.1.0"}}}
{"method":"initialized","params":{}}
{"method":"account/read","id":1,"params":{"refreshToken":false}}
```

## ChatGPT 登录

浏览器登录由 App Server 官方管理，客户端不应读取、复制或自行保存登录 token：

```json
{"method":"account/login/start","id":2,"params":{"type":"chatgpt","useHostedLoginSuccessPage":true,"appBrand":"chatgpt"}}
```

响应会返回 `loginId` 和 `authUrl`。客户端用系统浏览器打开 `authUrl`，然后等待：

- `account/login/completed`
- `account/updated`

若本地回调不稳定，可改用设备码登录：

```json
{"method":"account/login/start","id":3,"params":{"type":"chatgptDeviceCode"}}
```

客户端向用户显示响应中的 `verificationUrl` 与 `userCode`，仍然不接触密码。

## Thread 与 Turn

```json
{"method":"thread/start","id":10,"params":{"model":"<当前可用的 Codex 模型>"}}
{"method":"turn/start","id":11,"params":{"threadId":"<thread id>","input":[{"type":"text","text":"检查当前项目并给出下一步。"}]}}
```

常用流事件包括 `item/started`、`item/agentMessage/delta`、
`item/commandExecution/outputDelta`、`item/completed` 和 `turn/completed`。
命令审批请求是服务端主动发给客户端的
`item/commandExecution/requestApproval`；客户端必须用该请求的精确 `id` 回复，
并用 `threadId`、`turnId` 将审批绑定到正确会话。

## WebSocket 仅用于调试/远程 TUI

本地可临时启动：

```powershell
codex app-server --listen ws://127.0.0.1:4500
codex --remote ws://127.0.0.1:4500
```

官方目前把 WebSocket transport 标为实验性且不支持生产使用。明文 `ws://`
只应用于 localhost 或 SSH 端口转发；远程暴露时必须使用 TLS 与官方支持的
WebSocket 认证参数，不能把 token 直接放在命令行。

## 本项目计划的正确接法

- 仅在 Electron main 进程启动 `codex app-server`，renderer 不接触子进程或凭据。
- 为 stdio JSONL 建立请求 ID、超时、流事件和崩溃恢复状态机。
- 将每个 AI Terminal Session 映射到独立的 Codex Thread；Provider 切换时创建新 Thread。
- 把官方审批请求接入现有 Execute/Edit/Reject、Full Takeover、Audit 与控制租约。
- 继续保证所有 Agent 命令进入用户可见的同一 Terminal/PTY，而不是 App Server 的隐藏 Shell。
- 认证全走 `account/*` 官方流程，不解析 TUI、不提取 token、不调用私有接口。
