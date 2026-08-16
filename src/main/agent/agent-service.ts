import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import {
  AGENT_CHANNELS,
  CODEX_APP_SERVER_AGENT_BACKEND,
  CODEX_APP_SERVER_AGENT_POLICY_VERSION,
} from '../../shared/agent';
import type {
  AgentBackendRef,
  AgentChatItem,
  AgentFileAccessMode,
  AgentRuntimeState,
  AgentSessionView,
  CommandActor,
  CommandApproval,
  CommandExecution,
  ConfirmShellReadyRequest,
  InterruptAgentTurnRequest,
  ResolveApprovalRequest,
  ResolveTakeoverRequest,
  ReviseAgentPromptRequest,
  SendAgentPromptRequest,
  SetFullTakeoverRequest,
  SetAgentFileAccessRequest,
  TakeoverRequest,
  TerminalInputMode,
} from '../../shared/agent';
import type { ProviderProfile } from '../../shared/provider';
import type { CodexVisibleTerminalContext } from '../../shared/codex-app-server';
import type { SessionAuditEvent, SessionRecord } from '../../shared/session';
import type { TerminalCommandResult, WorkspaceBinding } from '../../shared/tools';
import type { ProviderStore } from '../providers/provider-store';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';
import type {
  AgentBackend,
  AgentBackendEvent,
  AgentBackendThread,
  AgentMessage,
} from './agent-backend';
import type { AgentProviderRuntime } from './agent-loop';
import { AgentFileService } from './agent-file-service';
import {
  reduceAgentToolActivities,
  settleRunningToolActivities,
} from './agent-tool-activity';
import { GenericHarnessBackend } from './generic-harness-backend';
import { GenericOpenAiProvider } from './generic-provider';
import type { CodexAppServerService } from '../app-server/app-server-service';
import { SharedTerminalTool } from '../tools/shared-terminal-tool';
import { SessionToolGateway } from '../tools/tool-gateway';
import {
  buildSessionToolContext,
  workspacePermissions,
} from '../tools/session-tool-context';
import { AgentFileWorkspaceAdapter } from '../tools/agent-file-workspace-adapter';

interface ApprovalResolution {
  decision: 'execute' | 'edit' | 'reject';
  command: string;
}

interface AgentRuntimeRecord extends AgentSessionView {
  owner: WebContents;
  ownerId: number;
  priorMessages: AgentMessage[];
  harnessBackend?: AgentBackend;
  harnessThread?: AgentBackendThread;
  providerThreadId?: string;
  abortController?: AbortController;
  turnToken: number;
  controlLeaseId?: string;
  sensitiveLeaseId?: string;
  authHandoff?: Promise<void>;
  resolveAuthHandoff?: () => void;
  resolveApproval?: (resolution: ApprovalResolution) => void;
  streamEmitTimer?: ReturnType<typeof setTimeout>;
}

type GenericBackendFactory = (providerId: string) => AgentBackend;

const BUSY_STATES = new Set<AgentRuntimeState>([
  'THINKING',
  'WAITING_APPROVAL',
  'AI_CONTROL',
  'RUNNING',
  'WAITING_OUTPUT',
  'WAITING_AUTH',
  'TAKEOVER_PENDING',
]);

const SYSTEM_PROMPT = `You are the AI agent inside AI Terminal.
You and the human operate the exact same visible terminal session. Use only the provided tools.
Never invent command output. Read terminal state/history when needed, request one clear command at a time, inspect its structured result, and continue until the user's goal is handled.
Every command must use terminal_execute so it appears in the visible terminal. Workspace tools, when explicitly enabled, operate directly inside the explicit Workspace Root and must never be emulated with a hidden shell. Use workspace_list, workspace_search, workspace_glob, and workspace_read_file for discovery, then prefer small workspace_apply_patch calls for edits; never use terminal cat/grep/sed/echo to emulate file tools or dump an entire repository.
Do not ask the user to send passwords, API keys, passphrases, OTPs, or other credentials through chat. Authentication is entered by the user directly in the visible terminal.
Commands require explicit user approval unless the UI reports that Full Takeover is active.`;

function cloneView(runtime: AgentRuntimeRecord): AgentSessionView {
  return {
    revision: runtime.revision,
    terminalId: runtime.terminalId,
    sessionId: runtime.sessionId,
    threadId: runtime.threadId,
    backend: { ...runtime.backend },
    providerId: runtime.providerId,
    state: runtime.state,
    terminalInputMode: runtime.terminalInputMode,
    fullTakeover: runtime.fullTakeover,
    fileAccessMode: runtime.fileAccessMode,
    fileAccessRoot: runtime.fileAccessRoot,
    messages: runtime.messages.map((message) => ({ ...message })),
    activities: runtime.activities.map((activity) => ({ ...activity })),
    streamingMessageId: runtime.streamingMessageId,
    backendTurnDraining: runtime.backendTurnDraining,
    pendingApproval: runtime.pendingApproval ? { ...runtime.pendingApproval } : undefined,
    authRequest: runtime.authRequest ? { ...runtime.authRequest } : undefined,
    pendingTakeover: runtime.pendingTakeover ? { ...runtime.pendingTakeover } : undefined,
    activeExecution: runtime.activeExecution ? { ...runtime.activeExecution } : undefined,
    error: runtime.error,
  };
}

function sameBackend(left: AgentBackendRef | undefined, right: AgentBackendRef): boolean {
  if (!left || left.kind !== right.kind) return false;
  return left.kind === 'generic-provider'
    ? left.providerId === (right as Extract<AgentBackendRef, { kind: 'generic-provider' }>).providerId
    : left.policyVersion === (
      right as Extract<AgentBackendRef, { kind: typeof CODEX_APP_SERVER_AGENT_BACKEND }>
    ).policyVersion;
}

function safePriorMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((message): message is AgentMessage => (
    Boolean(message)
    && typeof message === 'object'
    && ['user', 'assistant', 'tool'].includes((message as { role?: string }).role ?? '')
  ));
}

interface ReplayedConversation {
  messages: AgentChatItem[];
  priorMessages: AgentMessage[];
  providerThreadId?: string;
}

const MAX_CODEX_RESEEDED_HISTORY_CHARS = 24_000;
const MAX_MUTATION_AUDIT_RESULT_CHARS = 256 * 1024;

function mutationAuditDetails(result: string | undefined): {
  path: string;
  sha256: string;
  bytes: number;
} | undefined {
  if (!result || result.length > MAX_MUTATION_AUDIT_RESULT_CHARS) return undefined;
  try {
    const completed = JSON.parse(result) as Record<string, unknown>;
    if (
      completed.ok !== true
      || typeof completed.path !== 'string'
      || !completed.path
      || completed.path.length > 4_096
      || /[\u0000-\u001F\u007F]/u.test(completed.path)
      || typeof completed.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/iu.test(completed.sha256)
      || typeof completed.bytes !== 'number'
      || !Number.isSafeInteger(completed.bytes)
      || completed.bytes < 0
    ) return undefined;
    return {
      path: completed.path,
      sha256: completed.sha256,
      bytes: completed.bytes,
    };
  } catch {
    return undefined;
  }
}

function codexPromptWithLocalHistory(
  messages: AgentChatItem[],
  prompt: string,
  hasProviderThread: boolean,
): string {
  if (hasProviderThread || messages.length <= 1) return prompt;
  const history = messages.slice(0, -1).map((message) => {
    const role = message.role === 'user'
      ? '用户'
      : message.role === 'assistant' ? '助手' : '系统';
    return `[${role}]\n${message.content}`;
  }).join('\n\n');
  if (!history) return prompt;
  const boundedHistory = history.slice(-MAX_CODEX_RESEEDED_HISTORY_CHARS);
  return [
    '下面是 AI Terminal 从本地会话记录恢复的较早对话，仅用于延续上下文。',
    '<local_conversation_history>',
    boundedHistory,
    '</local_conversation_history>',
    '',
    '当前用户消息：',
    prompt,
  ].join('\n');
}

function codexVisibleTerminalContext(session: SessionRecord): CodexVisibleTerminalContext {
  return {
    transport: session.transport,
    target: {
      label: session.targetSnapshot.label,
      ...(session.targetSnapshot.hostname
        ? { hostname: session.targetSnapshot.hostname }
        : {}),
      ...(session.targetSnapshot.port !== undefined
        ? { port: session.targetSnapshot.port }
        : {}),
      ...(session.targetSnapshot.username
        ? { username: session.targetSnapshot.username }
        : {}),
    },
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.effectiveUser ? { effectiveUser: session.effectiveUser } : {}),
    shellKind: session.shellKind,
    connectionState: session.connectionState,
  };
}

function safeChatItem(value: unknown): AgentChatItem | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<AgentChatItem>;
  if (
    typeof item.id !== 'string'
    || !['user', 'assistant', 'system'].includes(item.role ?? '')
    || typeof item.content !== 'string'
    || typeof item.createdAt !== 'string'
  ) return undefined;
  return item as AgentChatItem;
}

/** Replays append-only chat events, including later user retractions/replacements. */
function replayConversation(
  events: Array<Record<string, unknown>>,
  fallbackProviderThreadId?: string,
): ReplayedConversation {
  let chats: Array<{ item: AgentChatItem; eventIndex: number }> = [];
  let turns: Array<{ messages: AgentMessage[]; eventIndex: number }> = [];
  let providerThreadId = fallbackProviderThreadId;

  events.forEach((event, eventIndex) => {
    if (event.type === 'chat') {
      const item = safeChatItem(event.item);
      if (item) chats.push({ item, eventIndex });
      return;
    }
    if (event.type === 'turn') {
      turns.push({ messages: safePriorMessages(event.messages), eventIndex });
      return;
    }
    if (event.type === 'codex_app_server_turn' && typeof event.providerThreadId === 'string') {
      providerThreadId = event.providerThreadId;
      return;
    }
    if (
      event.type !== 'chat_action'
      || (event.action !== 'retract' && event.action !== 'replace')
      || typeof event.targetMessageId !== 'string'
    ) return;
    const targetIndex = chats.findIndex(({ item }) => item.id === event.targetMessageId);
    if (targetIndex < 0 || chats[targetIndex].item.role !== 'user') return;
    const cutoffEventIndex = chats[targetIndex].eventIndex;
    chats = chats.slice(0, targetIndex);
    turns = turns.filter((turn) => turn.eventIndex < cutoffEventIndex);
    const replacementItem = event.action === 'replace'
      ? safeChatItem(event.replacementItem)
      : undefined;
    if (replacementItem?.role === 'user') {
      chats.push({ item: replacementItem, eventIndex });
    }
    // App Server threads are stateful and cannot be rewound. A later turn must
    // start a new native thread instead of silently reusing the retracted one.
    providerThreadId = undefined;
  });

  return {
    messages: chats.map(({ item }) => item),
    priorMessages: turns.at(-1)?.messages ?? [],
    providerThreadId,
  };
}

export class AgentService {
  private readonly runtimes = new Map<string, AgentRuntimeRecord>();
  private readonly revisionCounters = new Map<string, number>();
  private readonly removeExitListener: () => void;
  private readonly removeSensitiveSubmissionListener: () => void;
  private readonly fileService: AgentFileService;
  private readonly genericBackendFactory: GenericBackendFactory;

  constructor(
    private readonly terminals: TerminalService,
    private readonly sessions: SessionManager,
    private readonly providers: ProviderStore,
    private readonly providerFactory: (providerId: string) => AgentProviderRuntime = (
      providerId,
    ) => new GenericOpenAiProvider(providerId, providers),
    private readonly codexAppServer?: CodexAppServerService,
    fileService?: AgentFileService,
    genericBackendFactory?: GenericBackendFactory,
  ) {
    this.fileService = fileService ?? new AgentFileService(terminals, sessions);
    this.genericBackendFactory = genericBackendFactory
      ?? ((providerId) => new GenericHarnessBackend(this.providerFactory(providerId)));
    this.removeExitListener = terminals.onExit((terminalId, ownerId) => {
      this.handleTerminalExit(terminalId, ownerId);
    });
    this.removeSensitiveSubmissionListener = terminals.onSensitiveSubmission((
      terminalId,
      ownerId,
      executionId,
      leaseId,
    ) => {
      this.handleSensitiveSubmission(terminalId, ownerId, executionId, leaseId);
    });
  }

  sendPrompt(owner: WebContents, request: SendAgentPromptRequest): AgentSessionView {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('Agent prompt cannot be empty.');
    if (prompt.length > 20_000) throw new Error('Agent prompt exceeds 20,000 characters.');
    const backend = this.selectBackend(request.backend, request.providerId);
    const existing = this.runtimes.get(request.terminalId);
    if (existing && existing.ownerId !== owner.id) {
      throw new Error('Agent Session ownership mismatch.');
    }
    if (existing && (BUSY_STATES.has(existing.state) || existing.backendTurnDraining)) {
      throw new Error('The Agent is already working in this terminal.');
    }
    if (
      backend.kind !== CODEX_APP_SERVER_AGENT_BACKEND
      && this.terminals.currentExecution(owner, request.terminalId)
    ) {
      throw new Error('A foreground process retained by Takeover is still running.');
    }

    const runtime = this.ensureRuntime(owner, request.terminalId, backend);
    this.addChat(runtime, 'user', prompt);
    return this.startPersistedPrompt(runtime, prompt);
  }

  interruptTurn(owner: WebContents, request: InterruptAgentTurnRequest): AgentSessionView {
    const runtime = this.requireOwned(owner, request.terminalId);
    this.requireLatestUserMessage(runtime, request.messageId);
    if (runtime.backendTurnDraining) {
      throw new Error('正在等待 Codex App Server 安全停止当前轮次。');
    }
    const foregroundExecution = this.terminals.currentExecution(owner, request.terminalId);
    if (!BUSY_STATES.has(runtime.state) && !foregroundExecution) {
      throw new Error('最近一条消息已经停止运行。');
    }
    runtime.error = undefined;

    if (runtime.backend.kind !== CODEX_APP_SERVER_AGENT_BACKEND) {
      // A process explicitly kept during Takeover remains attached to the same
      // visible terminal after the planner is paused. Let the message-level
      // stop button send Ctrl+C to that exact execution as well.
      if (!BUSY_STATES.has(runtime.state) && foregroundExecution) {
        const interrupted = this.terminals.interruptExecution(
          owner,
          request.terminalId,
          foregroundExecution.id,
        );
        runtime.activeExecution = interrupted ?? foregroundExecution;
        runtime.pendingTakeover = undefined;
        this.setHumanState(runtime, 'PAUSED');
        this.appendControlAudit(runtime, 'agent_paused', 'user', {
          processAction: 'interrupt_latest_message',
          executionId: foregroundExecution.id,
          applied: Boolean(interrupted),
        });
        this.emit(runtime);
        return cloneView(runtime);
      }
      const paused = this.takeover(owner, { terminalId: request.terminalId }, 'user');
      if (!paused.pendingTakeover) return paused;
      return this.resolveTakeover(owner, {
        terminalId: request.terminalId,
        takeoverId: paused.pendingTakeover.id,
        executionId: paused.pendingTakeover.executionId,
        action: 'interrupt',
      });
    }

    const partial = runtime.streamingMessageId
      ? runtime.messages.find((message) => message.id === runtime.streamingMessageId)
      : undefined;
    if (partial?.content) {
      try { this.persistChatItem(runtime, partial); } catch { /* interruption must continue */ }
    }
    runtime.streamingMessageId = undefined;
    this.cancelStreamEmit(runtime);
    runtime.turnToken += 1;
    runtime.abortController?.abort();
    runtime.abortController = undefined;
    runtime.backendTurnDraining = true;
    this.setIndependentCodexState(runtime, 'PAUSED');
    try {
      this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
        type: 'turn_interrupted',
        timestamp: new Date().toISOString(),
        targetMessageId: request.messageId,
      });
    } catch (error) {
      runtime.error = `轮次已停止，但中断记录保存失败：${error instanceof Error ? error.message : String(error)}`;
    }
    this.emit(runtime);

    const interruptedRuntime = runtime;
    void this.codexAppServer?.interruptTerminalAgentTurn()
      .then(() => {
        if (this.runtimes.get(request.terminalId) !== interruptedRuntime) return;
        interruptedRuntime.backendTurnDraining = false;
        this.emit(interruptedRuntime);
      })
      .catch((error) => {
        if (this.runtimes.get(request.terminalId) !== interruptedRuntime) return;
        // The old native turn may still be alive. Keep this runtime blocked
        // until an explicit App Server restart replaces the child process.
        interruptedRuntime.error = error instanceof Error ? error.message : String(error);
        interruptedRuntime.backendTurnDraining = true;
        this.emit(interruptedRuntime);
      });
    return cloneView(runtime);
  }

  handleCodexAppServerRestarted(): void {
    for (const runtime of this.runtimes.values()) {
      if (
        runtime.backend.kind !== CODEX_APP_SERVER_AGENT_BACKEND
        || !runtime.backendTurnDraining
      ) continue;
      runtime.backendTurnDraining = false;
      runtime.error = undefined;
      this.setIndependentCodexState(runtime, 'PAUSED');
      this.emit(runtime);
    }
  }

  revisePrompt(owner: WebContents, request: ReviseAgentPromptRequest): AgentSessionView {
    const runtime = this.requireOwned(owner, request.terminalId);
    this.requireLatestUserMessage(runtime, request.messageId);
    if (BUSY_STATES.has(runtime.state) || runtime.backendTurnDraining) {
      throw new Error('运行中的消息只能先打断。');
    }
    if (this.terminals.currentExecution(owner, request.terminalId)) {
      throw new Error('终端前台进程仍在运行，无法撤回或修改消息。');
    }
    const replacement = request.action === 'replace' ? request.prompt?.trim() ?? '' : '';
    if (request.action === 'replace' && !replacement) {
      throw new Error('修改后的消息不能为空。');
    }
    if (replacement.length > 20_000) {
      throw new Error('Agent prompt exceeds 20,000 characters.');
    }

    const replacementItem: AgentChatItem | undefined = request.action === 'replace'
      ? {
        id: randomUUID(),
        role: 'user',
        content: replacement,
        createdAt: new Date().toISOString(),
      }
      : undefined;
    const actionEvent = {
      type: 'chat_action',
      action: request.action,
      timestamp: new Date().toISOString(),
      targetMessageId: request.messageId,
      ...(replacementItem ? { replacementItem } : {}),
      // This operation changes conversation context only. Terminal output,
      // command executions, and audits remain append-only and untouched.
      executionHistoryPreserved: true,
    };
    this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, actionEvent);
    const replayed = replayConversation(
      this.sessions.readThreadEvents(runtime.sessionId, runtime.threadId),
      runtime.providerThreadId,
    );
    runtime.messages = replayed.messages;
    runtime.priorMessages = replayed.priorMessages;
    runtime.activities = [];
    if (runtime.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      runtime.providerThreadId = replayed.providerThreadId;
    } else {
      // Generic Harness threads own their in-memory history. Replaying an
      // append-only retract/replace must seed a fresh backend thread next turn.
      runtime.harnessBackend = undefined;
      runtime.harnessThread = undefined;
    }
    runtime.error = undefined;
    runtime.activeExecution = undefined;
    runtime.pendingTakeover = undefined;
    runtime.streamingMessageId = undefined;
    this.clearFullTakeover(runtime, 'conversation_revised');
    if (runtime.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      this.setIndependentCodexState(runtime, 'USER_CONTROL');
    } else {
      this.setHumanState(runtime, 'USER_CONTROL');
    }

    if (request.action === 'replace') {
      return this.startPersistedPrompt(runtime, replacement);
    }
    this.emit(runtime);
    return cloneView(runtime);
  }

  getState(owner: WebContents, terminalId: string): AgentSessionView | null {
    let runtime = this.runtimes.get(terminalId);
    if (!runtime) {
      const session = this.sessions.sessionForTerminal(owner, terminalId);
      const persistedBackend = session?.agentBackend
        ?? (session?.providerId
          ? { kind: 'generic-provider' as const, providerId: session.providerId }
          : undefined);
      if (!session?.aiThreadId || !persistedBackend) return null;
      runtime = this.ensureRuntime(owner, terminalId, persistedBackend);
    }
    if (runtime.ownerId !== owner.id) throw new Error('Agent Session not found.');
    return cloneView(runtime);
  }

  /**
   * Workspace roots are part of the tool boundary for a Generic Provider
   * runtime. Keep that boundary immutable while a turn can still use it, or
   * while file tools remain authorized against the current root.
   */
  assertWorkspaceChangeAllowed(owner: WebContents, terminalId: string): void {
    const runtime = this.runtimes.get(terminalId);
    if (!runtime) {
      // A missing Agent runtime is allowed, but the terminal still has to be
      // live and owned by the calling renderer.
      this.terminals.descriptor(owner, terminalId);
      return;
    }
    if (runtime.ownerId !== owner.id) throw new Error('Agent Session not found.');
    if (BUSY_STATES.has(runtime.state) || runtime.backendTurnDraining) {
      throw new Error('Agent 运行或正在停止时不能更改 Workspace 根目录。');
    }
    if (runtime.fileAccessMode !== 'off') {
      throw new Error('请先关闭 Generic Provider 文件访问，再更改 Workspace 根目录。');
    }
  }

  async setFileAccess(
    owner: WebContents,
    request: SetAgentFileAccessRequest,
  ): Promise<AgentSessionView> {
    if (!(['off', 'read-only', 'read-write'] as AgentFileAccessMode[]).includes(request.mode)) {
      throw new Error('未知的文件访问模式。');
    }
    const backend = this.selectBackend(request.backend);
    if (backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      throw new Error('Codex 原生模式不使用 Generic Provider 文件工具。');
    }
    const existing = this.runtimes.get(request.terminalId);
    if (existing && (BUSY_STATES.has(existing.state) || existing.backendTurnDraining)) {
      throw new Error('智能体运行时不能更改文件访问权限。');
    }
    const runtime = this.ensureRuntime(owner, request.terminalId, backend);
    const fileAccessRoot = request.mode === 'off'
      ? undefined
      : await this.fileService.bindWorkspaceRoot(owner, request.terminalId);
    if (
      this.runtimes.get(request.terminalId) !== runtime
      || BUSY_STATES.has(runtime.state)
      || runtime.backendTurnDraining
    ) throw new Error('智能体状态已变化，文件访问权限未修改。');
    this.sessions.appendAudit(runtime.sessionId, 'file_permission_changed', 'user', {
      mode: request.mode,
      root: fileAccessRoot,
      ephemeral: true,
    });
    runtime.fileAccessMode = request.mode;
    runtime.fileAccessRoot = fileAccessRoot;
    runtime.error = undefined;
    this.emit(runtime);
    return cloneView(runtime);
  }

  resolveApproval(owner: WebContents, request: ResolveApprovalRequest): AgentSessionView {
    const runtime = this.requireOwned(owner, request.terminalId);
    const approval = runtime.pendingApproval;
    if (!approval || approval.id !== request.approvalId || !runtime.resolveApproval) {
      throw new Error('Command approval is no longer pending.');
    }
    const command = request.decision === 'edit'
      ? request.editedCommand?.trim() ?? ''
      : approval.command;
    if (request.decision !== 'reject' && !command) throw new Error('Edited command cannot be empty.');
    const resolvedAt = new Date().toISOString();
    runtime.pendingApproval = {
      ...approval,
      command,
      status: request.decision === 'reject'
        ? 'rejected'
        : request.decision === 'edit' ? 'edited' : 'approved',
      resolvedAt,
    };
    if (request.decision === 'reject') {
      this.sessions.appendAudit(runtime.sessionId, 'command_rejected', 'user', {
        approvalId: approval.id,
        command: approval.command,
      });
      this.setLockedState(runtime, 'THINKING');
    } else if (request.decision === 'edit') {
      this.sessions.appendAudit(runtime.sessionId, 'command_edited', 'user', {
        approvalId: approval.id,
        requestedCommand: approval.command,
        command,
      });
      this.setLockedState(runtime, 'AI_CONTROL');
    } else {
      this.sessions.appendAudit(runtime.sessionId, 'command_approved', 'user', {
        approvalId: approval.id,
        command,
      });
      this.setLockedState(runtime, 'AI_CONTROL');
    }
    const resolve = runtime.resolveApproval;
    runtime.resolveApproval = undefined;
    this.emit(runtime);
    resolve({ decision: request.decision, command });
    return cloneView(runtime);
  }

  setFullTakeover(owner: WebContents, request: SetFullTakeoverRequest): AgentSessionView {
    let runtime = this.runtimes.get(request.terminalId);
    if (runtime && runtime.ownerId !== owner.id) throw new Error('Agent Session not found.');
    if (
      request.backend?.kind === CODEX_APP_SERVER_AGENT_BACKEND
      || runtime?.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND
    ) {
      if (!runtime) {
        runtime = this.ensureRuntime(
          owner,
          request.terminalId,
          this.selectBackend(request.backend, request.providerId),
        );
      }
      if (request.enabled) {
        throw new Error('Codex App Server 使用独立内建执行环境，不使用 Full Takeover。');
      }
      runtime.fullTakeover = false;
      return cloneView(runtime);
    }
    if (
      runtime
      && request.approvalId
      && request.backend
      && !sameBackend(runtime.backend, request.backend)
    ) {
      throw new Error('Full Takeover 请求与当前智能体后端不匹配。');
    }
    if (request.approvalId) {
      if (!request.enabled || !runtime) {
        throw new Error('Full Takeover approval is no longer pending.');
      }
      const approval = runtime.pendingApproval;
      if (
        runtime.state !== 'WAITING_APPROVAL'
        || !approval
        || approval.id !== request.approvalId
        || !runtime.resolveApproval
      ) {
        throw new Error('Full Takeover approval is no longer pending.');
      }
      const editedCommand = request.editedCommand?.trim();
      const decision = request.editedCommand === undefined || editedCommand === approval.command
        ? 'execute'
        : 'edit';
      if (decision === 'edit' && !editedCommand) {
        throw new Error('Edited command cannot be empty.');
      }
      if (!runtime.fullTakeover) {
        this.sessions.appendAudit(runtime.sessionId, 'full_takeover_changed', 'user', {
          enabled: true,
          approvalId: approval.id,
        });
        runtime.fullTakeover = true;
      }
      try {
        return this.resolveApproval(owner, {
          terminalId: request.terminalId,
          approvalId: approval.id,
          decision,
          editedCommand: decision === 'edit' ? editedCommand : undefined,
        });
      } catch (error) {
        runtime.fullTakeover = false;
        this.appendControlAudit(runtime, 'full_takeover_changed', 'system', {
          enabled: false,
          reason: 'approval_resolution_failed',
          approvalId: approval.id,
        });
        throw error;
      }
    }
    if (runtime && (BUSY_STATES.has(runtime.state) || runtime.backendTurnDraining)) {
      throw new Error('Take control of the active Agent turn before changing Full Takeover.');
    }
    if (runtime && this.terminals.currentExecution(owner, request.terminalId)) {
      throw new Error('A foreground process retained by Takeover is still running.');
    }
    if (runtime && request.backend && !sameBackend(runtime.backend, request.backend)) {
      if (!request.enabled) {
        throw new Error('Full Takeover 请求与当前智能体后端不匹配。');
      }
      runtime = this.ensureRuntime(
        owner,
        request.terminalId,
        this.selectBackend(request.backend, request.providerId),
      );
    }
    if (!runtime) {
      if (!request.enabled) throw new Error('Agent Session not found.');
      runtime = this.ensureRuntime(
        owner,
        request.terminalId,
        this.selectBackend(request.backend, request.providerId),
      );
    }
    if (runtime.fullTakeover === request.enabled) return cloneView(runtime);
    if (request.enabled) {
      this.sessions.appendAudit(runtime.sessionId, 'full_takeover_changed', 'user', {
        enabled: true,
      });
      runtime.fullTakeover = true;
    } else {
      runtime.fullTakeover = false;
      this.appendControlAudit(runtime, 'full_takeover_changed', 'user', {
        enabled: false,
      });
    }
    this.emit(runtime);
    return cloneView(runtime);
  }

  takeover(
    owner: WebContents,
    request: TakeoverRequest,
    interruptReason: 'user' | 'takeover' = 'takeover',
  ): AgentSessionView {
    const runtime = this.requireOwned(owner, request.terminalId);
    if (runtime.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      throw new Error('Codex App Server 不操作用户终端，无需人工接管。');
    }
    if (runtime.state === 'TAKEOVER_PENDING') return cloneView(runtime);
    if (!BUSY_STATES.has(runtime.state) && !runtime.fullTakeover) {
      return cloneView(runtime);
    }

    const partial = runtime.streamingMessageId
      ? runtime.messages.find((message) => message.id === runtime.streamingMessageId)
      : undefined;
    if (partial?.content) {
      try { this.persistChatItem(runtime, partial); } catch { /* takeover must still proceed */ }
    }
    runtime.streamingMessageId = undefined;
    this.cancelStreamEmit(runtime);
    runtime.turnToken += 1;
    runtime.abortController?.abort();
    this.interruptHarness(runtime, interruptReason);
    // A cancelled replaceable backend may retain partial provider-side state.
    // Discard it and resume a fresh adapter from the last committed transcript.
    runtime.harnessBackend = undefined;
    runtime.harnessThread = undefined;
    runtime.activities = settleRunningToolActivities(
      runtime.activities,
      'cancelled',
      new Date().toISOString(),
    );
    runtime.abortController = undefined;
    if (runtime.pendingApproval) {
      this.appendControlAudit(runtime, 'command_rejected', 'user', {
        approvalId: runtime.pendingApproval.id,
        command: runtime.pendingApproval.command,
        reason: 'manual_takeover',
      });
    }
    const resolveApproval = runtime.resolveApproval;
    runtime.resolveApproval = undefined;
    runtime.pendingApproval = undefined;
    resolveApproval?.({ decision: 'reject', command: '' });
    this.resolveAuth(runtime);

    if (runtime.fullTakeover) {
      runtime.fullTakeover = false;
      this.appendControlAudit(runtime, 'full_takeover_changed', 'user', {
        enabled: false,
        reason: 'manual_takeover',
      });
    }

    const execution = this.terminals.currentExecution(owner, request.terminalId);
    if (execution) {
      runtime.activeExecution = execution;
      runtime.pendingTakeover = {
        id: randomUUID(),
        executionId: execution.id,
        requestedAt: new Date().toISOString(),
      };
      this.setLockedState(runtime, 'TAKEOVER_PENDING');
    } else {
      runtime.pendingTakeover = undefined;
      this.setHumanState(runtime, 'PAUSED');
      this.appendControlAudit(runtime, 'agent_paused', 'user', {
        processAction: 'none',
      });
    }
    this.emit(runtime);
    return cloneView(runtime);
  }

  resolveTakeover(owner: WebContents, request: ResolveTakeoverRequest): AgentSessionView {
    const runtime = this.requireOwned(owner, request.terminalId);
    const pending = runtime.pendingTakeover;
    if (
      runtime.state !== 'TAKEOVER_PENDING'
      || !pending
      || pending.id !== request.takeoverId
      || pending.executionId !== request.executionId
    ) {
      throw new Error('Takeover choice is no longer pending.');
    }

    let applied = false;
    if (request.action === 'interrupt') {
      const interrupted = this.terminals.interruptExecution(
        owner,
        request.terminalId,
        request.executionId,
      );
      applied = Boolean(interrupted);
      if (interrupted) runtime.activeExecution = interrupted;
    } else {
      applied = this.terminals.keepExecution(owner, request.terminalId, request.executionId);
    }
    runtime.pendingTakeover = undefined;
    this.setHumanState(runtime, 'PAUSED');
    this.appendControlAudit(runtime, 'agent_paused', 'user', {
      processAction: request.action,
      executionId: request.executionId,
      applied,
    });
    this.emit(runtime);
    return cloneView(runtime);
  }

  confirmShellReady(
    owner: WebContents,
    request: ConfirmShellReadyRequest,
  ): AgentSessionView {
    const runtime = this.requireOwned(owner, request.terminalId);
    if (
      runtime.state !== 'PAUSED'
      || runtime.activeExecution?.id !== request.executionId
      || !runtime.activeExecution.interruptRequestedAt
    ) {
      throw new Error('Interrupted command is no longer awaiting shell confirmation.');
    }
    const execution = this.terminals.confirmShellReady(
      owner,
      request.terminalId,
      request.executionId,
    );
    if (!execution) {
      throw new Error('Interrupted command is no longer awaiting shell confirmation.');
    }
    runtime.activeExecution = execution;
    this.appendControlAudit(runtime, 'agent_paused', 'user', {
      processAction: 'shell-ready-confirmed',
      executionId: request.executionId,
    });
    this.emit(runtime);
    return cloneView(runtime);
  }

  closeTerminal(owner: WebContents, terminalId: string): void {
    const runtime = this.runtimes.get(terminalId);
    if (!runtime) return;
    if (runtime.ownerId !== owner.id) throw new Error('Agent Session not found.');
    this.clearFullTakeover(runtime, 'terminal_closed');
    this.invalidateRuntime(runtime, 'shutdown');
    this.runtimes.delete(terminalId);
  }

  closeOwnedBy(ownerId: number): void {
    for (const [terminalId, runtime] of this.runtimes) {
      if (runtime.ownerId !== ownerId) continue;
      this.clearFullTakeover(runtime, 'window_closed');
      this.invalidateRuntime(runtime, 'shutdown');
      this.runtimes.delete(terminalId);
    }
  }

  close(): void {
    this.removeExitListener();
    this.removeSensitiveSubmissionListener();
    for (const runtime of this.runtimes.values()) {
      this.clearFullTakeover(runtime, 'application_shutdown');
      this.invalidateRuntime(runtime, 'shutdown');
    }
    this.runtimes.clear();
  }

  private async runTurn(
    runtime: AgentRuntimeRecord,
    token: number,
    prompt: string,
    controlLeaseId?: string,
  ): Promise<void> {
    if (runtime.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      await this.runCodexTurn(runtime, token, prompt, controlLeaseId);
      return;
    }
    if (!controlLeaseId) throw new Error('Generic Agent control lease is missing.');
    const signal = runtime.abortController!.signal;
    let streamedMessage: AgentChatItem | undefined;
    let acceptBackendEvents = true;
    const onEvent = (event: AgentBackendEvent): void => {
      if (!acceptBackendEvents || !this.isCurrentTurn(runtime, token)) return;
      if (event.type === 'tool_started' || event.type === 'tool_completed') {
        runtime.activities = reduceAgentToolActivities(
          runtime.activities,
          event,
          new Date().toISOString(),
        );
        this.emit(runtime);
      }
      if (
        event.type === 'tool_completed'
        && (
          event.toolCall?.name === 'workspace_write_file'
          || event.toolCall?.name === 'workspace_apply_patch'
          || event.toolCall?.name === 'file_write'
          || event.toolCall?.name === 'file_patch'
        )
      ) {
        const details = mutationAuditDetails(event.result);
        if (details) {
          this.sessions.appendAudit(runtime.sessionId, 'file_modified', 'ai', {
            ...details,
          });
        }
      }
      if (event.type === 'assistant_delta' && event.text) {
        if (!streamedMessage) {
          streamedMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
          };
          runtime.messages.push(streamedMessage);
          runtime.streamingMessageId = streamedMessage.id;
        }
        streamedMessage.content += event.text;
        this.queueStreamEmit(runtime, token);
      } else if (event.type === 'assistant_text' && event.text) {
        if (streamedMessage) {
          streamedMessage.content = event.text;
          this.persistChatItem(runtime, streamedMessage);
          runtime.streamingMessageId = undefined;
          streamedMessage = undefined;
          this.cancelStreamEmit(runtime);
        } else {
          this.addChat(runtime, 'assistant', event.text);
        }
        this.emit(runtime);
      }
    };

    try {
      const boundSession = this.sessions.sessionForTerminal(runtime.owner, runtime.terminalId);
      if (!boundSession) throw new Error('当前终端没有可用的正式 Session。');
      const workspace: WorkspaceBinding | undefined = runtime.fileAccessRoot
        ? {
          backend: boundSession.transport === 'ssh' ? 'sftp' : 'local',
          root: runtime.fileAccessRoot,
          ...(boundSession.hostId ? { hostId: boundSession.hostId } : {}),
        }
        : boundSession.workspace;
      const toolContext = buildSessionToolContext(
        { ...boundSession, ...(workspace ? { workspace } : {}) },
        this.terminals.descriptor(runtime.owner, runtime.terminalId),
        { workspacePermissions: workspacePermissions(runtime.fileAccessMode, workspace) },
      );
      const terminalTool = new SharedTerminalTool({
        context: toolContext,
        owner: runtime.owner,
        terminals: this.terminals,
        sessions: this.sessions,
        execute: (command, reason) => this.requestCommand(runtime, token, { command, reason }),
      });
      const workspaceTool = workspace
        ? new AgentFileWorkspaceAdapter(
          this.fileService,
          runtime.owner,
          runtime.terminalId,
          workspace,
        )
        : undefined;
      const gateway = new SessionToolGateway(toolContext, terminalTool, workspaceTool);

      let backend = runtime.harnessBackend;
      if (!backend) {
        backend = this.genericBackendFactory(runtime.providerId);
        runtime.harnessBackend = backend;
      }
      let thread = runtime.harnessThread;
      if (!thread) {
        try {
          const createdThread = runtime.priorMessages.length > 0
            ? await backend.resume({
              id: runtime.threadId,
              priorMessages: runtime.priorMessages,
              signal,
            })
            : await backend.createThread({ id: runtime.threadId, signal });
          if (
            !this.isCurrentTurn(runtime, token)
            || runtime.harnessBackend !== backend
          ) return;
          thread = createdThread;
          runtime.harnessThread = createdThread;
        } catch (error) {
          if (
            !this.isCurrentTurn(runtime, token)
            || runtime.harnessBackend !== backend
          ) return;
          if (!runtime.harnessThread) runtime.harnessBackend = undefined;
          throw error;
        }
      }
      if (!this.isCurrentTurn(runtime, token)) return;

      const terminalContext = this.sessions.readTerminalHistory(runtime.sessionId).slice(-12_000);
      const result = await backend.sendMessage({
        thread,
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        terminalContext,
        fileAccessMode: runtime.fileAccessMode,
        gateway,
        signal,
        onEvent,
      });
      acceptBackendEvents = false;
      if (!this.isCurrentTurn(runtime, token)) return;
      runtime.priorMessages = result.messages.filter((message) => message.role !== 'system');
      this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
        type: 'turn',
        id: result.id,
        timestamp: new Date().toISOString(),
        messages: runtime.priorMessages,
      });
      runtime.pendingApproval = undefined;
      runtime.activeExecution = undefined;
      runtime.streamingMessageId = undefined;
      runtime.activities = settleRunningToolActivities(
        runtime.activities,
        'failed',
        new Date().toISOString(),
      );
      this.cancelStreamEmit(runtime);
      this.setHumanState(runtime, 'COMPLETED', controlLeaseId);
      this.emit(runtime);
    } catch (error) {
      acceptBackendEvents = false;
      if (!this.isCurrentTurn(runtime, token)) return;
      if (streamedMessage?.content) {
        try { this.persistChatItem(runtime, streamedMessage); } catch { /* preserve original error */ }
      }
      streamedMessage = undefined;
      runtime.streamingMessageId = undefined;
      this.cancelStreamEmit(runtime);
      runtime.pendingApproval = undefined;
      runtime.activeExecution = undefined;
      runtime.activities = settleRunningToolActivities(
        runtime.activities,
        signal.aborted ? 'cancelled' : 'failed',
        new Date().toISOString(),
      );
      runtime.error = error instanceof Error ? error.message : String(error);
      this.setHumanState(runtime, signal.aborted ? 'PAUSED' : 'FAILED', controlLeaseId);
      this.emit(runtime);
    }
  }

  private async runCodexTurn(
    runtime: AgentRuntimeRecord,
    token: number,
    prompt: string,
    _controlLeaseId?: string,
  ): Promise<void> {
    const service = this.codexAppServer;
    const signal = runtime.abortController!.signal;
    if (!service) {
      runtime.error = 'Codex App Server Agent Runtime 未初始化。';
      this.setIndependentCodexState(runtime, 'FAILED');
      this.emit(runtime);
      return;
    }
    const snapshot = service.getState();
    const selection = snapshot.selection;
    if (!snapshot.agentAvailable || !selection) {
      runtime.error = snapshot.agentReason;
      this.setIndependentCodexState(runtime, 'FAILED');
      this.emit(runtime);
      return;
    }

    let streamedMessage: AgentChatItem | undefined;
    try {
      const boundSession = this.sessions.sessionForTerminal(
        runtime.owner,
        runtime.terminalId,
      );
      if (!boundSession) throw new Error('当前终端没有可用的持久会话上下文。');
      let lastKnownTerminalContext = codexVisibleTerminalContext(boundSession);
      const upstreamPrompt = codexPromptWithLocalHistory(
        runtime.messages,
        prompt,
        Boolean(runtime.providerThreadId),
      );
      const result = await service.runTerminalAgentTurn({
        prompt: upstreamPrompt,
        model: selection.modelId,
        reasoningEffort: selection.reasoningEffort,
        threadId: runtime.providerThreadId,
        signal,
        terminalContextAccess: snapshot.terminalContextAccess.enabled,
        tools: {
          readTerminal: async ({ maxChars }) => (
            this.sessions.readTerminalHistory(runtime.sessionId).slice(-maxChars)
          ),
          getTerminalState: async () => {
            try {
              const latestSession = this.sessions.sessionForTerminal(
                runtime.owner,
                runtime.terminalId,
              );
              if (latestSession) {
                lastKnownTerminalContext = codexVisibleTerminalContext(latestSession);
                return lastKnownTerminalContext;
              }
            } catch {
              // A terminal may close between the user message and a state read.
            }
            return {
              ...lastKnownTerminalContext,
              target: { ...lastKnownTerminalContext.target },
              connectionState: 'disconnected',
            };
          },
        },
        onThreadBound: (threadId) => {
          if (!this.isCurrentTurn(runtime, token)) {
            throw new Error('Codex App Server Thread 已失效。');
          }
          if (runtime.providerThreadId !== threadId) {
            this.sessions.bindProviderThread(runtime.sessionId, runtime.threadId, threadId);
            runtime.providerThreadId = threadId;
          }
        },
        onDelta: (delta) => {
          if (!delta || !this.isCurrentTurn(runtime, token)) return;
          if (!streamedMessage) {
            streamedMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            };
            runtime.messages.push(streamedMessage);
            runtime.streamingMessageId = streamedMessage.id;
          }
          streamedMessage.content += delta;
          this.queueStreamEmit(runtime, token);
        },
        onNativeApproval: (approval) => {
          if (!this.isCurrentTurn(runtime, token)) return;
          this.sessions.appendAudit(runtime.sessionId, 'codex_native_approval', 'system', {
            ...approval,
            policy: 'native-workspace-no-visible-terminal',
          });
        },
      });
      if (!this.isCurrentTurn(runtime, token)) return;
      if (result.status !== 'completed') {
        const terminalError = new Error(
          result.error ?? (result.status === 'interrupted'
            ? 'Codex App Server Turn 已中断。'
            : 'Codex App Server Turn 失败。'),
        );
        if (result.status === 'interrupted') terminalError.name = 'AbortError';
        throw terminalError;
      }
      runtime.providerThreadId = result.threadId;
      const finalText = result.finalText.trim();
      if (streamedMessage) {
        if (finalText) streamedMessage.content = result.finalText;
        this.persistChatItem(runtime, streamedMessage);
        streamedMessage = undefined;
      } else if (finalText) {
        this.addChat(runtime, 'assistant', result.finalText);
      }
      runtime.streamingMessageId = undefined;
      this.cancelStreamEmit(runtime);
      this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
        type: 'codex_app_server_turn',
        timestamp: new Date().toISOString(),
        providerThreadId: result.threadId,
        providerTurnId: result.turnId,
        status: result.status,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      });
      runtime.pendingApproval = undefined;
      runtime.activeExecution = undefined;
      this.setIndependentCodexState(runtime, 'COMPLETED');
      this.emit(runtime);
    } catch (error) {
      if (!this.isCurrentTurn(runtime, token)) return;
      if (streamedMessage?.content) {
        try { this.persistChatItem(runtime, streamedMessage); } catch { /* preserve original error */ }
      }
      streamedMessage = undefined;
      runtime.streamingMessageId = undefined;
      this.cancelStreamEmit(runtime);
      const wasAborted = signal.aborted
        || (error instanceof Error && error.name === 'AbortError');
      runtime.turnToken += 1;
      runtime.abortController?.abort();
      runtime.abortController = undefined;
      const pendingApproval = runtime.pendingApproval;
      if (pendingApproval) {
        this.appendControlAudit(runtime, 'command_rejected', 'system', {
          approvalId: pendingApproval.id,
          command: pendingApproval.command,
          reason: 'app_server_turn_ended',
        });
      }
      const resolveApproval = runtime.resolveApproval;
      runtime.resolveApproval = undefined;
      runtime.pendingApproval = undefined;
      resolveApproval?.({ decision: 'reject', command: '' });
      this.resolveAuth(runtime);
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.fullTakeover = false;
      runtime.activeExecution = undefined;
      runtime.pendingTakeover = undefined;
      this.setIndependentCodexState(runtime, wasAborted ? 'PAUSED' : 'FAILED');
      this.emit(runtime);
    }
  }

  private async requestCommand(
    runtime: AgentRuntimeRecord,
    token: number,
    request: { command: string; reason?: string },
  ): Promise<TerminalCommandResult> {
    if (!this.isCurrentTurn(runtime, token)) throw new Error('Agent turn is no longer active.');
    const approval: CommandApproval = {
      id: randomUUID(),
      sessionId: runtime.sessionId,
      terminalId: runtime.terminalId,
      command: request.command,
      reason: request.reason,
      status: 'waiting',
      requestedAt: new Date().toISOString(),
    };
    this.sessions.appendAudit(runtime.sessionId, 'command_requested', 'ai', {
      approvalId: approval.id,
      command: approval.command,
      reason: approval.reason,
    });

    let resolution: ApprovalResolution;
    if (runtime.fullTakeover) {
      resolution = { decision: 'execute', command: approval.command };
      this.sessions.appendAudit(runtime.sessionId, 'command_approved', 'system', {
        approvalId: approval.id,
        command: approval.command,
        fullTakeover: true,
      });
      this.setLockedState(runtime, 'AI_CONTROL');
      this.emit(runtime);
    } else {
      runtime.pendingApproval = approval;
      this.setLockedState(runtime, 'WAITING_APPROVAL');
      this.emit(runtime);
      resolution = await new Promise<ApprovalResolution>((resolve) => {
        runtime.resolveApproval = resolve;
      });
      runtime.pendingApproval = undefined;
      if (!this.isCurrentTurn(runtime, token)) throw new Error('Agent turn is no longer active.');
      if (resolution.decision === 'reject') {
        const finishedAt = Date.now();
        const startedAt = Date.parse(approval.requestedAt);
        return {
          commandId: approval.id,
          command: approval.command,
          status: 'rejected',
          exitCode: null,
          output: 'User rejected this command.',
          startedAt,
          finishedAt,
          durationMs: Math.max(0, finishedAt - startedAt),
        };
      }
    }

    const actor: CommandActor = resolution.decision === 'edit'
      ? 'user_modified_ai_command'
      : 'ai';
    this.setLockedState(runtime, 'RUNNING');
    this.emit(runtime);

    let execution: CommandExecution;
    try {
      execution = await this.terminals.executeStructured(
        runtime.owner,
        runtime.terminalId,
        resolution.command,
        actor,
        {
          onStarted: (started) => {
            if (!this.isCurrentTurn(runtime, token)) return;
            runtime.activeExecution = started;
            this.setLockedState(runtime, 'RUNNING');
            this.emit(runtime);
          },
          onAuthPrompt: (started) => {
            this.handleAuthPrompt(runtime, token, started);
          },
          onConfirmation: (answer, started) => (
            this.handleConfirmation(runtime, token, answer, started)
          ),
        },
      );
      if (
        this.isCurrentTurn(runtime, token)
        && runtime.authRequest?.executionId === execution.id
        && runtime.sensitiveLeaseId
        && !this.terminals.hasSensitiveSubmission(
          runtime.owner,
          runtime.terminalId,
          execution.id,
          runtime.sensitiveLeaseId,
        )
      ) {
        const interactionId = runtime.authRequest.id;
        this.resolveAuth(runtime);
        this.setLockedState(runtime, 'RUNNING');
        this.appendControlAudit(runtime, 'interactive_auth', 'system', {
          phase: 'execution_ended_without_submission',
          executionId: execution.id,
          interactionId,
        });
        this.emit(runtime);
      }
      while (
        this.isCurrentTurn(runtime, token)
        && runtime.authRequest?.executionId === execution.id
        && runtime.authHandoff
      ) {
        await runtime.authHandoff;
      }
    } finally {
      if (runtime.sensitiveLeaseId) {
        this.terminals.endSensitiveMode(
          runtime.owner,
          runtime.terminalId,
          runtime.sensitiveLeaseId,
        );
        runtime.sensitiveLeaseId = undefined;
      }
    }

    this.sessions.appendAudit(runtime.sessionId, 'command_completed', 'system', {
      executionId: execution.id,
      command: execution.command,
      actor: execution.actor,
      status: execution.status === 'running' ? 'failed' : execution.status,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      outputRedacted: execution.outputRedacted === true,
    });
    this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
      type: 'command_execution',
      timestamp: new Date().toISOString(),
      execution,
    });

    const sameRuntime = this.runtimes.get(runtime.terminalId) === runtime;
    if (sameRuntime) {
      runtime.activeExecution = execution;
      if (
        runtime.state === 'TAKEOVER_PENDING'
        && runtime.pendingTakeover?.executionId === execution.id
      ) {
        runtime.pendingTakeover = undefined;
        this.setHumanState(runtime, 'PAUSED');
        this.appendControlAudit(runtime, 'agent_paused', 'system', {
          processAction: 'process-finished-before-choice',
          executionId: execution.id,
        });
        this.emit(runtime);
      } else if (this.isCurrentTurn(runtime, token)) {
        this.setLockedState(runtime, 'WAITING_OUTPUT');
        this.emit(runtime);
      } else {
        this.emit(runtime);
      }
    }
    if (!this.isCurrentTurn(runtime, token)) throw new Error('Agent turn is no longer active.');
    this.setLockedState(runtime, 'THINKING');
    this.emit(runtime);
    return {
      commandId: execution.id,
      command: execution.command,
      status: execution.status === 'running' ? 'failed' : execution.status,
      exitCode: execution.exitCode ?? null,
      output: execution.output,
      startedAt: Date.parse(execution.startedAt),
      finishedAt: execution.endedAt ? Date.parse(execution.endedAt) : undefined,
      durationMs: execution.durationMs,
    };
  }

  private handleAuthPrompt(
    runtime: AgentRuntimeRecord,
    token: number,
    execution: CommandExecution,
  ): void {
    if (!this.isCurrentTurn(runtime, token)) return;
    if (runtime.authRequest?.executionId === execution.id) return;
    runtime.sensitiveLeaseId ??= this.terminals.beginSensitiveMode(
      runtime.owner,
      runtime.terminalId,
      execution.id,
    );
    runtime.authRequest = {
      id: randomUUID(),
      executionId: execution.id,
      detectedAt: new Date().toISOString(),
    };
    runtime.authHandoff = new Promise<void>((resolve) => {
      runtime.resolveAuthHandoff = resolve;
    });
    this.setSecureInputState(runtime);
    this.appendControlAudit(runtime, 'interactive_auth', 'system', {
      phase: 'detected',
      executionId: execution.id,
      interactionId: runtime.authRequest.id,
    });
    this.emit(runtime);
  }

  private handleSensitiveSubmission(
    terminalId: string,
    ownerId: number,
    executionId: string,
    leaseId: string,
  ): void {
    const runtime = this.runtimes.get(terminalId);
    const interaction = runtime?.authRequest;
    if (
      !runtime
      || runtime.ownerId !== ownerId
      || runtime.state !== 'WAITING_AUTH'
      || !interaction
      || interaction.executionId !== executionId
      || runtime.sensitiveLeaseId !== leaseId
      || !this.terminals.consumeSensitiveSubmission(
        runtime.owner,
        terminalId,
        executionId,
        leaseId,
      )
    ) return;
    runtime.authRequest = undefined;
    const resolve = runtime.resolveAuthHandoff;
    runtime.resolveAuthHandoff = undefined;
    runtime.authHandoff = undefined;
    this.setLockedState(runtime, 'RUNNING');
    this.appendControlAudit(runtime, 'interactive_auth', 'user', {
      phase: 'submitted',
      executionId,
      interactionId: interaction.id,
    });
    this.emit(runtime);
    resolve?.();
  }

  private handleConfirmation(
    runtime: AgentRuntimeRecord,
    token: number,
    answer: 'y' | 'n',
    execution: CommandExecution,
  ): boolean {
    if (
      !this.isCurrentTurn(runtime, token)
      || runtime.authRequest
      || !runtime.fullTakeover
    ) return false;
    try {
      this.sessions.appendAudit(runtime.sessionId, 'interactive_response', 'ai', {
        executionId: execution.id,
        response: answer,
        policy: 'displayed-default',
      });
    } catch (error) {
      console.error('Unable to persist interactive response; leaving it unanswered:', error);
      return false;
    }
    return true;
  }

  private ensureRuntime(
    owner: WebContents,
    terminalId: string,
    backend: AgentBackendRef,
  ): AgentRuntimeRecord {
    const session = this.sessions.upgrade(owner, terminalId);
    const existing = this.runtimes.get(terminalId);
    if (existing && existing.ownerId !== owner.id) throw new Error('Agent Session ownership mismatch.');
    if (existing && sameBackend(existing.backend, backend) && existing.sessionId === session.id) {
      return existing;
    }
    if (existing) {
      if (
        BUSY_STATES.has(existing.state)
        || existing.backendTurnDraining
        || this.terminals.currentExecution(owner, terminalId)
      ) {
        throw new Error('Cannot switch Provider while the Agent or a foreground process is active.');
      }
      this.invalidateRuntime(existing, 'user');
    }

    const persistedBackend = session.agentBackend
      ?? (session.providerId
        ? { kind: 'generic-provider' as const, providerId: session.providerId }
        : undefined);
    const canReuseThread = sameBackend(persistedBackend, backend) && Boolean(session.aiThreadId);
    const threadId = canReuseThread ? session.aiThreadId! : randomUUID();
    if (!canReuseThread) {
      if (backend.kind === 'generic-provider') {
        this.sessions.bindAgentThread(session.id, backend.providerId, threadId);
      } else {
        this.sessions.bindAgentBackendThread(session.id, backend, threadId);
      }
    }
    const persisted = this.sessions.readThreadEvents(session.id, threadId);
    const replayed = replayConversation(persisted, session.providerThreadId);
    const runtime: AgentRuntimeRecord = {
      revision: this.revisionCounters.get(terminalId) ?? 0,
      owner,
      ownerId: owner.id,
      terminalId,
      sessionId: session.id,
      threadId,
      backend,
      providerId: backend.kind === 'generic-provider'
        ? backend.providerId
        : CODEX_APP_SERVER_AGENT_BACKEND,
      state: 'USER_CONTROL',
      terminalInputMode: 'human',
      fullTakeover: false,
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
      messages: replayed.messages,
      activities: [],
      priorMessages: replayed.priorMessages,
      providerThreadId: canReuseThread && backend.kind === CODEX_APP_SERVER_AGENT_BACKEND
        ? replayed.providerThreadId
        : undefined,
      turnToken: 0,
    };
    this.runtimes.set(terminalId, runtime);
    return runtime;
  }

  private selectBackend(
    requested?: AgentBackendRef,
    legacyProviderId?: string,
  ): AgentBackendRef {
    if (requested && requested.kind !== 'generic-provider'
      && requested.kind !== CODEX_APP_SERVER_AGENT_BACKEND) {
      throw new Error('未知的智能体后端。');
    }
    if (requested?.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      if (requested.policyVersion !== CODEX_APP_SERVER_AGENT_POLICY_VERSION) {
        throw new Error('Codex App Server Agent 隔离策略版本不受支持。');
      }
      const state = this.codexAppServer?.getState();
      if (!state || !state.agentAvailable) {
        throw new Error(state?.agentReason ?? 'Codex App Server Agent 尚未就绪。');
      }
      return {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      };
    }
    if (
      requested?.kind === 'generic-provider'
      && (typeof requested.providerId !== 'string' || !requested.providerId.trim())
    ) throw new Error('Generic Provider ID 无效。');
    const provider = this.selectProvider(
      requested?.kind === 'generic-provider' ? requested.providerId : legacyProviderId,
    );
    return { kind: 'generic-provider', providerId: provider.id };
  }

  private selectProvider(providerId?: string): ProviderProfile {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.providers.list().find((profile) => profile.isDefault);
    if (!provider) throw new Error('Configure a default Provider first.');
    if (provider.status !== 'ready') throw new Error(`Provider ${provider.name} is not Ready.`);
    return provider;
  }

  private isCurrentTurn(runtime: AgentRuntimeRecord, token: number): boolean {
    return this.runtimes.get(runtime.terminalId) === runtime
      && runtime.turnToken === token;
  }

  private setLockedState(runtime: AgentRuntimeRecord, state: AgentRuntimeState): void {
    runtime.state = state;
    runtime.terminalInputMode = 'locked';
    if (runtime.controlLeaseId) {
      this.terminals.setAgentControlMode(
        runtime.owner,
        runtime.terminalId,
        runtime.controlLeaseId,
        'locked',
      );
    }
  }

  private setIndependentCodexState(
    runtime: AgentRuntimeRecord,
    state: AgentRuntimeState,
  ): void {
    runtime.state = state;
    runtime.terminalInputMode = 'human';
    // Defensive cleanup for sessions created by the legacy shared-terminal
    // App Server mode. Native Codex must never retain a terminal control lease.
    if (runtime.controlLeaseId) {
      this.terminals.releaseAgentControl(
        runtime.owner,
        runtime.terminalId,
        runtime.controlLeaseId,
      );
      runtime.controlLeaseId = undefined;
    }
  }

  private setSecureInputState(runtime: AgentRuntimeRecord): void {
    runtime.state = 'WAITING_AUTH';
    runtime.terminalInputMode = 'secure-human';
    if (!runtime.controlLeaseId) throw new Error('Agent control lease is missing.');
    this.terminals.setAgentControlMode(
      runtime.owner,
      runtime.terminalId,
      runtime.controlLeaseId,
      'secure-human',
    );
  }

  private setHumanState(
    runtime: AgentRuntimeRecord,
    state: AgentRuntimeState,
    expectedLeaseId = runtime.controlLeaseId,
  ): void {
    runtime.state = state;
    runtime.terminalInputMode = 'human';
    if (expectedLeaseId) {
      this.terminals.releaseAgentControl(runtime.owner, runtime.terminalId, expectedLeaseId);
      if (runtime.controlLeaseId === expectedLeaseId) runtime.controlLeaseId = undefined;
    }
  }

  private resolveAuth(runtime: AgentRuntimeRecord): void {
    runtime.authRequest = undefined;
    const resolve = runtime.resolveAuthHandoff;
    runtime.resolveAuthHandoff = undefined;
    runtime.authHandoff = undefined;
    resolve?.();
  }

  private invalidateRuntime(
    runtime: AgentRuntimeRecord,
    reason: 'user' | 'takeover' | 'shutdown' = 'shutdown',
  ): void {
    runtime.turnToken += 1;
    runtime.streamingMessageId = undefined;
    runtime.backendTurnDraining = false;
    this.cancelStreamEmit(runtime);
    runtime.abortController?.abort();
    this.interruptHarness(runtime, reason);
    runtime.activities = settleRunningToolActivities(
      runtime.activities,
      'cancelled',
      new Date().toISOString(),
    );
    runtime.abortController = undefined;
    runtime.harnessBackend = undefined;
    runtime.harnessThread = undefined;
    runtime.resolveApproval?.({ decision: 'reject', command: '' });
    runtime.resolveApproval = undefined;
    runtime.pendingApproval = undefined;
    this.resolveAuth(runtime);
    if (
      runtime.sensitiveLeaseId
      && !this.terminals.currentExecution(runtime.owner, runtime.terminalId)
    ) {
      this.terminals.endSensitiveMode(
        runtime.owner,
        runtime.terminalId,
        runtime.sensitiveLeaseId,
      );
      runtime.sensitiveLeaseId = undefined;
    }
    if (runtime.controlLeaseId) {
      this.terminals.releaseAgentControl(
        runtime.owner,
        runtime.terminalId,
        runtime.controlLeaseId,
      );
      runtime.controlLeaseId = undefined;
    }
  }

  private interruptHarness(
    runtime: AgentRuntimeRecord,
    reason: 'user' | 'takeover' | 'shutdown',
  ): void {
    if (runtime.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) return;
    const backend = runtime.harnessBackend;
    const thread = runtime.harnessThread;
    if (!backend || !thread) return;
    try {
      void backend.interrupt({ threadId: thread.id, reason }).catch((error) => {
        console.error('Unable to interrupt Generic Harness backend:', error);
      });
    } catch (error) {
      // A replaceable backend may throw before returning its promised result;
      // runtime cleanup and terminal lease release must still continue.
      console.error('Unable to interrupt Generic Harness backend:', error);
    }
  }

  private handleTerminalExit(terminalId: string, ownerId: number): void {
    const runtime = this.runtimes.get(terminalId);
    if (!runtime || runtime.ownerId !== ownerId) return;
    if (runtime.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      // The native App Server turn is independent from the visible terminal.
      // A disconnected shell only removes future terminal_read context.
      runtime.terminalInputMode = 'human';
      this.emit(runtime);
      return;
    }
    this.invalidateRuntime(runtime);
    runtime.pendingTakeover = undefined;
    runtime.error = 'Terminal disconnected.';
    runtime.state = 'FAILED';
    runtime.terminalInputMode = 'human';
    this.clearFullTakeover(runtime, 'terminal_disconnected');
    this.emit(runtime);
  }

  private clearFullTakeover(runtime: AgentRuntimeRecord, reason: string): void {
    if (!runtime.fullTakeover) return;
    runtime.fullTakeover = false;
    try {
      this.sessions.appendAudit(runtime.sessionId, 'full_takeover_changed', 'system', {
        enabled: false,
        reason,
      });
    } catch (error) {
      console.error('Unable to persist Full Takeover shutdown:', error);
    }
  }

  private appendControlAudit(
    runtime: AgentRuntimeRecord,
    type: SessionAuditEvent['type'],
    actor: SessionAuditEvent['actor'],
    details: Record<string, unknown>,
  ): void {
    try {
      this.sessions.appendAudit(runtime.sessionId, type, actor, details);
    } catch (error) {
      console.error(`Unable to persist ${type} control transition:`, error);
    }
  }

  private addChat(
    runtime: AgentRuntimeRecord,
    role: AgentChatItem['role'],
    content: string,
  ): void {
    const item: AgentChatItem = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    this.persistChatItem(runtime, item);
    runtime.messages.push(item);
  }

  private persistChatItem(runtime: AgentRuntimeRecord, item: AgentChatItem): void {
    this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
      type: 'chat',
      timestamp: item.createdAt,
      item,
    });
  }

  private queueStreamEmit(runtime: AgentRuntimeRecord, token: number): void {
    if (runtime.streamEmitTimer) return;
    const streamingLength = runtime.streamingMessageId
      ? runtime.messages.find((item) => item.id === runtime.streamingMessageId)?.content.length ?? 0
      : 0;
    const delay = streamingLength >= 64_000
      ? 250
      : streamingLength >= 32_000
        ? 160
        : streamingLength >= 8_000
          ? 80
          : 40;
    runtime.streamEmitTimer = setTimeout(() => {
      runtime.streamEmitTimer = undefined;
      if (this.isCurrentTurn(runtime, token)) this.emit(runtime);
    }, delay);
  }

  private cancelStreamEmit(runtime: AgentRuntimeRecord): void {
    if (!runtime.streamEmitTimer) return;
    clearTimeout(runtime.streamEmitTimer);
    runtime.streamEmitTimer = undefined;
  }

  private requireOwned(owner: WebContents, terminalId: string): AgentRuntimeRecord {
    const runtime = this.runtimes.get(terminalId);
    if (!runtime || runtime.ownerId !== owner.id) throw new Error('Agent Session not found.');
    return runtime;
  }

  private requireLatestUserMessage(
    runtime: AgentRuntimeRecord,
    messageId: string,
  ): AgentChatItem {
    const message = [...runtime.messages].reverse().find((item) => item.role === 'user');
    if (!message || message.id !== messageId) {
      throw new Error('只能处理当前会话的最后一条用户消息。');
    }
    return message;
  }

  private startPersistedPrompt(
    runtime: AgentRuntimeRecord,
    prompt: string,
  ): AgentSessionView {
    runtime.turnToken += 1;
    const token = runtime.turnToken;
    runtime.abortController = new AbortController();
    runtime.error = undefined;
    runtime.activeExecution = undefined;
    runtime.pendingTakeover = undefined;
    runtime.authRequest = undefined;
    runtime.streamingMessageId = undefined;
    runtime.activities = [];
    if (runtime.backend.kind === CODEX_APP_SERVER_AGENT_BACKEND) {
      runtime.controlLeaseId = undefined;
      this.setIndependentCodexState(runtime, 'THINKING');
    } else {
      try {
        runtime.controlLeaseId = this.terminals.acquireAgentControl(
          runtime.owner,
          runtime.terminalId,
        );
      } catch (error) {
        runtime.abortController = undefined;
        runtime.error = error instanceof Error ? error.message : String(error);
        runtime.state = 'FAILED';
        runtime.terminalInputMode = 'human';
        this.emit(runtime);
        throw error;
      }
      this.setLockedState(runtime, 'THINKING');
    }
    this.emit(runtime);
    void this.runTurn(runtime, token, prompt, runtime.controlLeaseId);
    return cloneView(runtime);
  }

  private emit(runtime: AgentRuntimeRecord): void {
    runtime.revision = (this.revisionCounters.get(runtime.terminalId) ?? 0) + 1;
    this.revisionCounters.set(runtime.terminalId, runtime.revision);
    if (!runtime.owner.isDestroyed()) {
      try {
        runtime.owner.send(AGENT_CHANNELS.stateChanged, cloneView(runtime));
      } catch (error) {
        console.error('Unable to notify renderer of Agent state:', error);
      }
    }
  }
}
