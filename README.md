<div align="center">

# 🖥️ Glass Terminal

### 面向远程设备的人机共享 AI 终端

**不装远程 IDE，不使用隐藏 Shell，人与 AI 共用一个真实终端。**

Glass Terminal 是一个 **Windows-first、终端优先、远程设备优先**的 Agent 工作台。对于 Jetson、树莓派、ARM 小电脑、边缘主机，以及连接着单片机/JTAG/串口设备的实验室主机，目标端通常只需已有的 SSH/SFTP：无需部署 VS Code Server、模型 SDK 或常驻 Agent。Generic Provider 模式下，人类和 AI 操作**同一个可见的本地 PTY 或 SSH Shell**，命令只执行一次，原始实时输出完整呈现，并且随时可以审批、Ctrl+C 或人工接管。

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Electron](https://img.shields.io/badge/Electron-43-2b2e3a?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)
![Version](https://img.shields.io/badge/version-0.1.0--beta.1-blue)
![Tests](https://img.shields.io/badge/tests-682%20passed-brightgreen)
![Status](https://img.shields.io/badge/status-beta-blue)

</div>

---

## 🎯 为什么 Glass Terminal

AI IDE、Remote IDE 和通用 Agent Harness 主要围绕代码工作区与 Agent 自有执行环境设计；Glass Terminal 首先解决的是另一类问题：**如何让 AI 安全、透明地进入已经存在的真实设备终端**。

| | Glass Terminal | 常见 Remote IDE | 常见 Agent Harness |
|---|---|---|---|
| **远程准备** | 目标端通常只需 SSH；文件工具使用同一连接上的 SFTP | 经常需要部署远程 Server、扩展和索引环境 | 经常需要额外 Shell、运行时或工具服务 |
| **执行位置** | AI 和人共用同一个真实 PTY/SSH Shell | IDE 任务或远程扩展环境 | Harness 创建的 Shell、容器或沙箱 |
| **输出呈现** | xterm 直接显示原始实时流，包括进度、提示和控制序列 | 取决于 IDE 任务与终端集成 | 常见形态是截取后的工具结果或摘要 |
| **人工干预** | 可直接输入、回答提示、发送 Ctrl+C，并随时接管 | 常需要切换到另一终端处理 | 通常只能批准、拒绝或终止工具调用 |
| **模型选择** | DeepSeek、GLM、MiniMax、OpenAI 等兼容端点可替换 | 通常绑定对应 Agent 生态 | 取决于 Harness 实现 |

典型场景包括：在低速网络下维护 Jetson；观察 CUDA、驱动、Docker 或编译过程；通过远程控制主机运行 OpenOCD、esptool、串口和烧录工具；以及处理必须看到实时进度、交互提示或设备异常的长任务。

> Glass Terminal 不替代单片机本身的物理调试链路。对于不能运行 SSH 的 MCU，它连接的是挂载该设备、烧录器或串口的控制主机。

> **当前模式边界：**OpenAI 兼容 Provider 通过受控工具将获批命令只执行一次于当前可见 PTY/SSH；本地 Workspace 使用本机文件工具，SSH Workspace 复用现有连接的 SFTP 通道。

## ✨ 核心特性

| | 说明 |
|---|---|
| 🖥️ **共享可见终端** | Generic Provider 与人类共用同一个真实 PTY/SSH Shell；命令只执行一次，输出实时可见，没有第二条隐藏执行通道 |
| 🪶 **远程零侵入** | 目标主机无需安装 Glass Terminal、远程 IDE 或 Agent Runtime；会话集成不修改远端 PowerShell Profile、不落地脚本 |
| 🤖 **开放模型接入** | 基于 LangChain 的 OpenAI 兼容 Provider，可接入 DeepSeek / GLM / MiniMax / OpenAI 等兼容端点，并支持手动填写模型 ID |
| 🧠 **有界上下文记忆** | Generic Provider 按模型窗口保守估算；满阈值生成经校验的结构化摘要，用户还可审阅、编辑和合并独立的短记忆卡片 |
| ✅ **命令审批** | AI 请求执行命令需你确认；支持编辑后执行、拒绝 |
| 🎮 **AI 全接管 / 人工接管** | 显式确认后 Full Takeover 可连续执行命令，Take Control 可随时抢回当前终端；SSH Host 当前会记住该偏好 |
| 🌐 **SSH 远程主机** | 密码 / 键盘交互 / 私钥 / Windows OpenSSH 代理认证；多主机、文件夹分组、收藏 |
| 🪟 **远程 Shell 适配** | 每台主机可指定 Linux/POSIX、PowerShell 或 cmd；PowerShell 使用会话级 Shell Integration 获取命令边界、退出码和 cwd，可见 VT 流不做文本猜测或重绘过滤 |
| 📁 **Workspace 文件工具** | 两种后端均支持只读 / 读写绑定根；Generic 另有显式风险确认的 FULL FILESYSTEM ACCESS；`read / search / glob / apply_patch / write` 全程显示 diff |
| 🔐 **安全优先** | 凭据不进模型上下文与明文日志；密钥库 AES-256-GCM 加密；敏感认证交接；无任何遥测 |
| 💾 **持久化与会话** | 会话历史、审计日志（audit JSONL）、断线重连、终端回放 |
| 🌗 **主题** | 暗色 / 亮色 / 跟随系统 三态循环 |
| 📦 **设置与备份** | 设置窗口、AES-256-GCM 文件密钥库、配置备份导出/导入；包含 Provider/SSH 凭据时强制使用至少 12 字符的口令加密整包 |
| 🔗 **SFTP** | 与远程会话关联的文件传输队列 |

---

## 🚀 快速开始

### 环境要求

- **Node.js 22+**、**npm 10+**
- **Windows 10/11**（ConPTY 与本机终端支持）

### 安装与运行（开发模式）

```bash
npm install
npm run dev
```

### 质量门禁

```bash
npm run typecheck   # TypeScript 类型检查
npm test            # Vitest 全量测试（70 个文件通过、4 个跳过；676 项通过、13 项跳过）
npm run build       # 类型检查 + 全量测试 + renderer/Electron 生产编译
```

### 打包（绿色版，无需安装）

```bash
npm run build
npm run package:win
# 产物：release/win-unpacked/Glass Terminal.exe
```

---

## ⚙️ 配置

复制 `.env.example` 为 `.env`（或直接注入环境变量）：

| 变量 | 说明 |
|---|---|
| `AI_TERMINAL_DEEPSEEK_API_KEY` | 仅用于按环境启用的 DeepSeek 真实模型集成测试；应用内 Provider 请在设置窗口配置 |
| `AI_TERMINAL_SSH_TEST_HOST` 等 `AI_TERMINAL_SSH_TEST_*` | SSH 集成测试环境变量 |

> 用户数据（主机、Provider、加密密钥库、会话）保存在 `%APPDATA%\glass-terminal\`，与应用本体分离。
>
> ⚠️ 默认备份不包含 Provider API Key 或 SSH 凭据。显式包含凭据时，`.aitbak` 和
> `.aithosts` 会使用用户提供的口令加密整个文件；口令不会由应用保存，遗失后无法恢复。
> 旧版明文凭据备份仍可在显式确认风险后导入，请继续将所有备份视为敏感文件。

---

## 🧱 技术栈

**Electron 43 · React 19 · TypeScript · xterm.js · node-pty · ssh2 · LangChain · zod · Vite · tsup · Vitest · electron-builder**

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron + Vite + React 19 |
| 终端 | xterm.js + node-pty（ConPTY） |
| 远程 | ssh2（SSH / SFTP） |
| Agent | LangChain（OpenAI 兼容 Provider） |
| 构建 | tsup（main/preload）+ Vite（renderer）+ electron-builder |
| 测试 | Vitest |

---

## 🔗 开源致谢

Glass Terminal 建立在以下出色的开源项目之上，向它们的作者和维护者致敬：

| 组件 | 作用 | 许可证 |
|---|---|---|
| [xterm.js](https://github.com/xtermjs/xterm.js) | 终端模拟与渲染（VS Code 终端同款核心） | MIT |
| [node-pty](https://github.com/microsoft/node-pty) | 本地 PTY 会话（基于 Windows ConPTY） | MIT |
| [ssh2](https://github.com/mscdex/ssh2) | SSH / SFTP 远程连接 | MIT |
| [Electron](https://github.com/electron/electron) | 跨平台桌面应用壳 | MIT |
| [React](https://github.com/facebook/react) | UI 框架 | MIT |
| [LangChain](https://github.com/langchain-ai/langchainjs) | Agent 工具编排 | MIT |
| [zod](https://github.com/colinhacks/zod) | 运行时模式校验 | MIT |
| [Vite](https://github.com/vitejs/vite) · [tsup](https://github.com/egoist/tsup) · [Vitest](https://github.com/vitest-dev/vitest) · [electron-builder](https://github.com/electron-userland/electron-builder) | 构建与测试工具链 | MIT |

终端底层基于微软开源的 **Windows ConPTY 控制台基础设施**（[OpenConsole / conpty](https://github.com/microsoft/terminal)）。

---

## 📁 目录结构

```text
src/
  main/       Electron 主进程：终端、SSH、Agent、文件工具、设置与加密
  preload/    窄而强类型的 IPC 桥
  renderer/   React 界面（终端面板、Agent 面板、设置窗口）
  shared/     IPC 契约与共享类型
docs/
  architecture/              架构与技术选型
  releases/                  版本发布说明
```

---

## 🤝 贡献者

本项目由以下 AI 开发工具协作完成：

<div align="center">

| | 工具 | 角色 |
|---|---|---|
| 🌊 | **[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)**（DeepSeek） | 开发调试环境：承载开发、测试与迭代 |

</div>

---

## 🔒 隐私

Glass Terminal **不包含任何分析或遥测**。Provider 请求必须由你主动发起，且仅携带完成该请求所需的终端上下文。请勿提交 `.env`、密码、API Key、私钥或会话数据到仓库。

---

## 📄 许可证

[MIT](LICENSE) © 2026 Glass Terminal contributors
