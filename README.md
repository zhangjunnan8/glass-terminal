<div align="center">

# 🖥️ AI Terminal

### 人与 AI 共享同一终端会话的 Windows 桌面应用

一个 **Windows-first** 的终端智能体：人类和 AI 智能体操作**同一个可见的终端会话**（本地 PTY 或 SSH 远程主机）。AI 执行的每一条命令都原样出现在你眼前的终端里，可审批、可接管、可追溯 —— 没有隐藏的后台 Shell。

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Electron](https://img.shields.io/badge/Electron-43-2b2e3a?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)
![Version](https://img.shields.io/badge/version-0.1.0--alpha.0-orange)
![Tests](https://img.shields.io/badge/tests-479%20passed-brightgreen)
![Status](https://img.shields.io/badge/status-alpha-important)

</div>

---

## ✨ 核心特性

| | 说明 |
|---|---|
| 🖥️ **共享可见终端** | AI 与人类共用同一个终端；AI 命令通过命令信封注入，输出实时回显，无隐藏进程 |
| 🤖 **双 Agent 后端** | Generic Provider（LangChain，兼容 DeepSeek / OpenAI 等）与原生 Codex App Server 两种模式 |
| ✅ **命令审批** | AI 请求执行命令需你确认；支持编辑后执行、拒绝 |
| 🎮 **AI 全接管 / 人工接管** | Full Takeover 全自动执行，Take Control 随时抢回控制权 |
| 🌐 **SSH 远程主机** | 密码 / 键盘交互 / 私钥 / Windows OpenSSH 代理认证；多主机、文件夹分组、收藏 |
| 🪟 **远程 Shell 适配** | 每台主机可指定远程 Shell：Linux/POSIX、PowerShell、cmd —— 命令信封自动匹配，Windows 远程主机不再"命令失灵" |
| 📁 **Workspace 文件工具** | 只读 / 读写绑定根、FULL FILESYSTEM ACCESS 三种授权；`read / search / glob / apply_patch / write` 全程显示 diff |
| 🔐 **安全优先** | 凭据不进模型上下文与明文日志；密钥库 AES-256-GCM 加密；敏感认证交接；无任何遥测 |
| 💾 **持久化与会话** | 会话历史、审计日志（audit JSONL）、断线重连、终端回放 |
| 🌗 **主题** | 暗色 / 亮色 / 跟随系统 三态循环 |
| 📦 **设置与备份** | 设置窗口、密钥库加密、备份导出/导入（ZIP 含审计日志） |
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
npm test            # Vitest 全量测试（61 个测试文件，479 用例）
npm run build       # 编译 renderer + Electron main/preload
```

### 打包（绿色版，无需安装）

```bash
npm run package
# 产物：release/win-unpacked/AI Terminal.exe
```

---

## ⚙️ 配置

复制 `.env.example` 为 `.env`（或直接注入环境变量）：

| 变量 | 说明 |
|---|---|
| `AI_TERMINAL_DEEPSEEK_API_KEY` | DeepSeek API Key（Generic Provider 默认模型） |
| `AI_TERMINAL_SSH_TEST_HOST` 等 `AI_TERMINAL_SSH_TEST_*` | SSH 集成测试环境变量 |

> 用户数据（主机、Provider、加密密钥库、会话）保存在 `%APPDATA%\ai-terminal\`，与应用本体分离。

---

## 🧱 技术栈

**Electron 43 · React 19 · TypeScript · xterm.js · node-pty · ssh2 · LangChain · zod · Vite · tsup · Vitest · electron-builder**

| 层 | 技术 |
|---|---|
| 桌面壳 | Electron + Vite + React 19 |
| 终端 | xterm.js + node-pty（ConPTY） |
| 远程 | ssh2（SSH / SFTP） |
| Agent | LangChain（Generic Provider）+ Codex App Server |
| 构建 | tsup（main/preload）+ Vite（renderer）+ electron-builder |
| 测试 | Vitest |

---

## 📁 目录结构

```text
src/
  main/       Electron 主进程：终端、SSH、Agent、文件工具、设置与加密
  preload/    窄而强类型的 IPC 桥
  renderer/   React 界面（终端面板、Agent 面板、设置窗口）
  shared/     IPC 契约与共享类型
docs/
  AI_PROJECT_GUIDE.md        新 AI 窗口 / 开发者入口文档
  architecture/              架构与技术选型
  progress/                  里程碑记录
```

---

## 🤝 贡献者

本项目由以下 AI 开发工具协作完成：

<div align="center">

| | 工具 | 角色 |
|---|---|---|
| 🦾 | **[Codex](https://github.com/openai/codex)**（OpenAI） | AI 编程代理：功能实现、代码生成与重构 |
| 🌊 | **[DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)**（DeepSeek） | 开发调试环境：承载开发、测试与迭代 |

</div>

---

## 🔒 隐私

AI Terminal **不包含任何分析或遥测**。Provider 请求必须由你主动发起，且仅携带完成该请求所需的终端上下文。请勿提交 `.env`、密码、API Key、私钥或会话数据到仓库。

---

## 📄 许可证

[MIT](LICENSE) © 2026 AI Terminal contributors
