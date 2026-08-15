import { isAbsolute, resolve } from 'node:path';
import type {
  AppServerConnection,
  AppServerNotification,
  AppServerRequest,
} from './app-server-client';

const DEFAULT_TERMINAL_READ_CHARS = 8_000;
const MAX_TERMINAL_READ_CHARS = 30_000;
const MAX_ASSISTANT_TEXT_CHARS = 100_000;
const MAX_ASSISTANT_MESSAGE_ITEMS = 64;
const MAX_TOOL_CALL_IDS = 256;
const MAX_PENDING_NOTIFICATIONS = 256;
const MAX_PENDING_NOTIFICATION_BYTES = 512 * 1024;
const MAX_PROTOCOL_ID_CHARS = 256;
// `thread/start` and `thread/resume` use the CLI-facing kebab-case enum.
// This is distinct from turn/start's structured sandboxPolicy.type enum.
const THREAD_WORKSPACE_SANDBOX = 'workspace-write';

const DEVELOPER_INSTRUCTIONS = `You are the native Codex agent embedded in AI Terminal.
Use Codex's built-in shell and file tools inside the Codex-managed workspace for all execution and filesystem work.
You do not control the user's visible terminal and must never claim that commands ran there.
When terminal_read is available, it is read-only context from the user's currently selected terminal; do not treat it as an execution channel.
Never ask the user to paste passwords, API keys, passphrases, OTPs, or other credentials into chat.
Keep secrets out of chat and command output.`;

export const CODEX_TERMINAL_READ_DYNAMIC_TOOL = {
  type: 'function',
  name: 'terminal_read',
  description: 'Read a bounded recent portion of the user-selected visible terminal history as context only.',
  deferLoading: false,
  inputSchema: {
    type: 'object',
    properties: {
      maxChars: {
        type: 'integer',
        minimum: 100,
        maximum: MAX_TERMINAL_READ_CHARS,
        default: DEFAULT_TERMINAL_READ_CHARS,
      },
    },
    additionalProperties: false,
  },
} as const;

/** @deprecated App Server no longer receives a visible-terminal execution tool. */
export const CODEX_TERMINAL_DYNAMIC_TOOLS = [
  {
    ...CODEX_TERMINAL_READ_DYNAMIC_TOOL,
  },
] as const;

export interface CodexAppServerTurnTools {
  readTerminal(request: { maxChars: number }): Promise<string>;
}

export interface CodexNativeApprovalEvent {
  kind: 'command-execution' | 'file-change' | 'permission-request';
  decision: 'acceptForSession' | 'decline-extra-permissions';
  threadId?: string;
  turnId?: string;
  itemId?: string;
}

export interface RunCodexTurnInput {
  prompt: string;
  model: string;
  reasoningEffort?: string;
  /** Existing App Server thread to resume. Omit to create a new thread. */
  threadId?: string;
  signal: AbortSignal;
  tools: CodexAppServerTurnTools;
  terminalContextAccess: boolean;
  canReadTerminal?(): boolean;
  onThreadBound?(threadId: string): void;
  onDelta?(delta: string): void;
  onNativeApproval?(event: CodexNativeApprovalEvent): void;
}

export interface RunCodexTurnResult {
  threadId: string;
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  finalText: string;
  error?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface ActiveTurn {
  sequence: number;
  connection: AppServerConnection;
  attachmentGeneration: number;
  input: RunCodexTurnInput;
  controller: AbortController;
  completion: Deferred<RunCodexTurnResult>;
  interruptDone: Deferred<void>;
  removeExternalAbort: () => void;
  threadId?: string;
  turnId?: string;
  turnStartIssued: boolean;
  turnStartAcknowledged: boolean;
  interruptRequested: boolean;
  interruptRequest?: Promise<void>;
  observedCompletion?: RunCodexTurnResult;
  finalText: string;
  messageItems: Map<string, { phase?: 'commentary' | 'final_answer'; text: string }>;
  assistantTextChars: number;
  assistantDeltaChars: number;
  seenCallIds: Set<string>;
  pendingNotifications: AppServerNotification[];
  pendingNotificationBytes: number;
  settled: boolean;
}

interface ThreadResponse {
  thread?: unknown;
}

interface TurnStartResponse {
  turn?: unknown;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function protocolId(value: unknown, label: string): string {
  const id = optionalText(value);
  if (!id || id.length > MAX_PROTOCOL_ID_CHARS) {
    throw new Error(`${label} 必须是不超过 ${MAX_PROTOCOL_ID_CHARS} 字符的非空字符串。`);
  }
  return id;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function abortError(message = 'Codex App Server Turn 已中断。'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  tool: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${tool} 收到未知参数：${unexpected}`);
}

function dynamicToolResult(value: unknown, success = true): Record<string, unknown> {
  return {
    contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
    success,
  };
}

function extractAgentText(turn: Record<string, unknown>): string | undefined {
  if (!Array.isArray(turn.items)) return undefined;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (
      isRecord(item)
      && item.type === 'agentMessage'
      && item.phase === 'final_answer'
      && typeof item.text === 'string'
    ) return item.text;
  }
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (
      isRecord(item)
      && item.type === 'agentMessage'
      && item.phase !== 'commentary'
      && typeof item.text === 'string'
    ) {
      return item.text;
    }
  }
  return undefined;
}

function agentMessagePhase(
  value: unknown,
): 'commentary' | 'final_answer' | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function turnError(turn: Record<string, unknown>): string | undefined {
  if (!isRecord(turn.error)) return undefined;
  return optionalText(turn.error.message);
}

function isHandledTurnNotification(method: string): boolean {
  return method === 'turn/started'
    || method === 'turn/completed'
    || method === 'item/agentMessage/delta'
    || method === 'item/started'
    || method === 'item/completed'
    || method.startsWith('item/commandExecution/')
    || method.startsWith('item/fileChange/');
}

function notificationTurnId(notification: AppServerNotification): string | undefined {
  if (!isRecord(notification.params)) return undefined;
  if (notification.method === 'turn/started' || notification.method === 'turn/completed') {
    return isRecord(notification.params.turn)
      ? optionalText(notification.params.turn.id)
      : undefined;
  }
  return optionalText(notification.params.turnId);
}

export class CodexAppServerTurnRunner {
  private readonly workspaceRoot: string;
  private connection?: AppServerConnection;
  private attachmentGeneration = 0;
  private sequence = 0;
  private disposed = false;
  private active?: ActiveTurn;
  private quarantinedAttachmentGeneration?: number;
  private removeNotificationListener?: () => void;
  private removeRequestHandler?: () => void;
  private removeExitListener?: () => void;

  constructor(workspaceRoot: string) {
    if (!workspaceRoot.trim() || !isAbsolute(workspaceRoot)) {
      throw new Error('App Server Agent workspaceRoot 必须是绝对路径。');
    }
    this.workspaceRoot = resolve(workspaceRoot);
  }

  attach(connection: AppServerConnection): void {
    if (this.disposed) throw new Error('Codex App Server Turn Runner 已关闭。');
    if (this.active) throw new Error('Codex App Server Turn 正在运行，无法替换连接。');
    if (this.connection === connection) return;
    this.detach();
    const generation = this.attachmentGeneration + 1;
    this.attachmentGeneration = generation;
    this.connection = connection;
    let removeNotificationListener: (() => void) | undefined;
    let removeRequestHandler: (() => void) | undefined;
    let removeExitListener: (() => void) | undefined;
    try {
      removeNotificationListener = connection.onNotification((notification) => {
        if (this.isAttachmentCurrent(connection, generation)) {
          this.handleNotification(notification);
        }
      });
      removeRequestHandler = connection.onRequest((request) => {
        if (!this.isAttachmentCurrent(connection, generation)) {
          throw new Error('Codex App Server 请求来自已失效连接。');
        }
        return this.handleRequest(request);
      });
      removeExitListener = connection.onExit((error) => {
        if (this.isAttachmentCurrent(connection, generation)) this.detachInternal(error);
      });
    } catch (error) {
      try { removeNotificationListener?.(); } catch { /* best-effort cleanup */ }
      try { removeRequestHandler?.(); } catch { /* best-effort cleanup */ }
      try { removeExitListener?.(); } catch { /* best-effort cleanup */ }
      this.connection = undefined;
      this.attachmentGeneration += 1;
      throw error;
    }
    this.removeNotificationListener = removeNotificationListener;
    this.removeRequestHandler = removeRequestHandler;
    this.removeExitListener = removeExitListener;
  }

  detach(): void {
    this.detachInternal(new Error('Codex App Server 连接已分离。'));
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachInternal(new Error('Codex App Server Turn Runner 已关闭。'));
  }

  run(input: RunCodexTurnInput): Promise<RunCodexTurnResult> {
    if (this.disposed) return Promise.reject(new Error('Codex App Server Turn Runner 已关闭。'));
    const connection = this.connection;
    if (!connection) return Promise.reject(new Error('Codex App Server 尚未连接。'));
    if (this.quarantinedAttachmentGeneration === this.attachmentGeneration) {
      return Promise.reject(new Error(
        'Codex App Server 连接已因协议错误被隔离；请重启并重新连接。',
      ));
    }
    if (this.active) return Promise.reject(new Error('同一时间只能运行一个 Codex App Server Turn。'));
    const prompt = input.prompt.trim();
    const model = input.model.trim();
    const resumeThreadId = input.threadId?.trim();
    if (!prompt) return Promise.reject(new Error('Codex App Server Turn 提示不能为空。'));
    if (!model) return Promise.reject(new Error('Codex App Server Turn 模型不能为空。'));
    if (input.signal.aborted) return Promise.reject(abortError());

    const completion = createDeferred<RunCodexTurnResult>();
    const interruptDone = createDeferred<void>();
    const controller = new AbortController();
    const active: ActiveTurn = {
      sequence: ++this.sequence,
      connection,
      attachmentGeneration: this.attachmentGeneration,
      input: {
        ...input,
        prompt,
        model,
        threadId: resumeThreadId,
      },
      controller,
      completion,
      interruptDone,
      removeExternalAbort: () => undefined,
      threadId: resumeThreadId,
      turnStartIssued: false,
      turnStartAcknowledged: false,
      interruptRequested: false,
      finalText: '',
      messageItems: new Map(),
      assistantTextChars: 0,
      assistantDeltaChars: 0,
      seenCallIds: new Set(),
      pendingNotifications: [],
      pendingNotificationBytes: 0,
      settled: false,
    };
    const onAbort = () => {
      void this.interrupt().catch(() => undefined);
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    active.removeExternalAbort = () => input.signal.removeEventListener('abort', onAbort);
    this.active = active;
    // A JSON-RPC request rejection (for example, an option unsupported by the
    // installed CLI) does not corrupt the connection. Keep it reusable so the
    // user can retry after changing configuration instead of quarantining every
    // ordinary `Invalid request` response as a hostile protocol violation.
    void this.startTurn(active).catch((error) => this.failActive(active, error));
    return completion.promise;
  }

  interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return Promise.resolve();
    if (!active.interruptRequested) {
      active.interruptRequested = true;
      active.controller.abort(abortError());
    }
    if (!active.turnStartIssued) {
      this.failActive(active, abortError());
      return active.interruptDone.promise;
    }
    this.maybeSendInterrupt(active);
    return active.interruptDone.promise;
  }

  private async startTurn(active: ActiveTurn): Promise<void> {
    const threadId = active.input.threadId
      ? await this.resumeThread(active, active.input.threadId)
      : await this.startThread(active);
    this.assertActive(active);
    active.threadId = threadId;
    active.input.onThreadBound?.(threadId);
    this.assertActive(active);
    if (active.interruptRequested) {
      this.failActive(active, abortError());
      return;
    }

    active.turnStartIssued = true;
    const response = await active.connection.request<TurnStartResponse>('turn/start', {
      threadId,
      input: [{ type: 'text', text: active.input.prompt }],
      cwd: this.workspaceRoot,
      runtimeWorkspaceRoots: [this.workspaceRoot],
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [this.workspaceRoot],
        readOnlyAccess: {
          type: 'restricted',
          includePlatformDefaults: true,
          readableRoots: [this.workspaceRoot],
        },
        networkAccess: false,
      },
      model: active.input.model,
      ...(active.input.reasoningEffort
        ? { effort: active.input.reasoningEffort }
        : {}),
    });
    this.assertActive(active);
    if (!isRecord(response) || !isRecord(response.turn)) {
      throw new Error('App Server 返回了无效的 turn/start 响应。');
    }
    const turnId = protocolId(response.turn.id, 'App Server turn/start 响应 turn.id');
    if (active.turnId) throw new Error('App Server Turn 在 turn/start 响应前已被错误绑定。');
    active.turnId = turnId;
    this.recordTurnMessageItems(active, response.turn);
    active.turnStartAcknowledged = true;
    const status = optionalText(response.turn.status);
    if (status && status !== 'inProgress') this.observeCompletion(active, response.turn);
    this.replayPendingNotifications(active);
    if (!this.isActive(active)) return;
    this.maybeSendInterrupt(active);
    this.maybeComplete(active);
  }

  private async startThread(active: ActiveTurn): Promise<string> {
    const response = await active.connection.request<ThreadResponse>('thread/start', {
      model: active.input.model,
      cwd: this.workspaceRoot,
      runtimeWorkspaceRoots: [this.workspaceRoot],
      approvalPolicy: 'never',
      sandbox: THREAD_WORKSPACE_SANDBOX,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      dynamicTools: active.input.terminalContextAccess
        ? [CODEX_TERMINAL_READ_DYNAMIC_TOOL]
        : [],
      serviceName: 'ai_terminal',
    });
    this.assertActive(active);
    return this.parseThreadId(response, 'thread/start');
  }

  private async resumeThread(active: ActiveTurn, expectedThreadId: string): Promise<string> {
    const response = await active.connection.request<ThreadResponse>('thread/resume', {
      threadId: expectedThreadId,
      model: active.input.model,
      cwd: this.workspaceRoot,
      runtimeWorkspaceRoots: [this.workspaceRoot],
      approvalPolicy: 'never',
      sandbox: THREAD_WORKSPACE_SANDBOX,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      dynamicTools: active.input.terminalContextAccess
        ? [CODEX_TERMINAL_READ_DYNAMIC_TOOL]
        : [],
      serviceName: 'ai_terminal',
    });
    this.assertActive(active);
    const threadId = this.parseThreadId(response, 'thread/resume');
    if (threadId !== expectedThreadId) {
      throw new Error('App Server thread/resume 返回了不匹配的 thread.id。');
    }
    return threadId;
  }

  private parseThreadId(response: unknown, method: string): string {
    if (!isRecord(response) || !isRecord(response.thread)) {
      throw new Error(`App Server 返回了无效的 ${method} 响应。`);
    }
    return protocolId(response.thread.id, `App Server ${method} 响应 thread.id`);
  }

  private handleNotification(notification: AppServerNotification): void {
    const active = this.active;
    if (!active || !isHandledTurnNotification(notification.method)) return;
    if (!isRecord(notification.params)) {
      if (active.turnStartAcknowledged) {
        this.failProtocol(active, new Error(
          `App Server ${notification.method} 通知参数无效。`,
        ));
      }
      return;
    }
    const params = notification.params;
    const threadId = optionalText(params.threadId);
    if (!threadId) {
      if (active.turnStartAcknowledged) {
        this.failProtocol(active, new Error(
          `App Server ${notification.method} 通知缺少 threadId。`,
        ));
      }
      return;
    }
    if (!active.threadId || threadId !== active.threadId) return;

    const candidateTurnId = notificationTurnId(notification);
    if (!candidateTurnId || candidateTurnId.length > MAX_PROTOCOL_ID_CHARS) {
      if (active.turnStartAcknowledged) {
        this.failProtocol(active, new Error(
          `App Server ${notification.method} 通知缺少有效 turnId。`,
        ));
      }
      return;
    }
    if (!active.turnStartAcknowledged) {
      this.bufferPendingNotification(active, notification);
      return;
    }
    if (candidateTurnId !== active.turnId) {
      this.failProtocol(active, new Error('App Server Turn 收到不匹配的 turnId。'));
      return;
    }
    this.handleConfirmedNotification(active, notification);
  }

  private handleConfirmedNotification(
    active: ActiveTurn,
    notification: AppServerNotification,
  ): void {
    if (!this.isActive(active) || !isRecord(notification.params)) return;
    const params = notification.params;

    if (notification.method.startsWith('item/commandExecution/')) {
      // Native Codex command execution is intentionally independent from the
      // visible terminal. Its lifecycle is owned and sandboxed by App Server.
      return;
    }
    if (notification.method.startsWith('item/fileChange/')) {
      // Native Codex file changes are valid App Server items.
      return;
    }

    if (notification.method === 'turn/started') {
      if (!isRecord(params.turn)) {
        this.failProtocol(active, new Error('App Server turn/started 通知无效。'));
        return;
      }
      try {
        this.recordTurnMessageItems(active, params.turn);
        this.maybeSendInterrupt(active);
      } catch (error) {
        this.failProtocol(active, error);
      }
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      try {
        this.validateNotificationTurn(active, params);
        if (typeof params.delta !== 'string') {
          throw new Error('App Server item/agentMessage/delta 通知缺少有效 delta。');
        }
        if (params.delta) {
          const itemId = optionalText(params.itemId) ?? '__legacy_agent_message__';
          const message = this.appendMessageDelta(
            active,
            itemId,
            agentMessagePhase(params.phase),
            params.delta,
          );
          if (message.phase !== 'commentary') {
            active.finalText = message.text;
            try { active.input.onDelta?.(params.delta); } catch { /* UI callback isolation */ }
          }
        }
      } catch (error) {
        this.failProtocol(active, error);
      }
      return;
    }

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      try {
        this.validateNotificationTurn(active, params);
        if (!isRecord(params.item)) {
          throw new Error(`App Server ${notification.method} 通知缺少有效 item。`);
        }
        if (params.item.type === 'agentMessage') {
          const itemId = protocolId(params.item.id, 'App Server agentMessage item.id');
          const phase = agentMessagePhase(params.item.phase);
          const existing = active.messageItems.get(itemId);
          const text = typeof params.item.text === 'string'
            ? params.item.text
            : existing?.text ?? '';
          const message = this.storeMessageItem(active, itemId, phase ?? existing?.phase, text);
          if (
            notification.method === 'item/completed'
            && (message.phase === 'final_answer' || message.phase !== 'commentary')
          ) active.finalText = message.text;
        }
      } catch (error) {
        this.failProtocol(active, error);
      }
      return;
    }

    if (notification.method === 'turn/completed') {
      if (!isRecord(params.turn)) {
        this.failProtocol(active, new Error('App Server turn/completed 通知无效。'));
        return;
      }
      try {
        this.recordTurnMessageItems(active, params.turn);
        this.observeCompletion(active, params.turn);
        this.maybeComplete(active);
      } catch (error) {
        this.failProtocol(active, error);
      }
    }
  }

  private async handleRequest(request: AppServerRequest): Promise<unknown> {
    if (
      request.method === 'item/commandExecution/requestApproval'
      || request.method === 'item/fileChange/requestApproval'
    ) {
      const active = this.active;
      if (!active || !this.requestTargetsCurrentTurn(request.params, active)) {
        return { decision: 'decline' };
      }
      this.recordNativeApproval(
        active,
        request.params,
        request.method === 'item/commandExecution/requestApproval'
          ? 'command-execution'
          : 'file-change',
        'acceptForSession',
      );
      return { decision: 'acceptForSession' };
    }
    if (request.method === 'item/permissions/requestApproval') {
      const active = this.active;
      if (active && this.requestTargetsCurrentTurn(request.params, active)) {
        this.recordNativeApproval(
          active,
          request.params,
          'permission-request',
          'decline-extra-permissions',
        );
      }
      // The native workspaceWrite sandbox is the hard boundary. Requests to
      // expand beyond it are resolved without involving the visible terminal.
      return { permissions: {}, scope: 'turn' };
    }
    if (request.method === 'mcpServer/elicitation/request') {
      return { action: 'cancel', content: null };
    }
    if (request.method !== 'item/tool/call') {
      throw new Error(`不支持的 App Server 请求：${request.method}`);
    }

    const active = this.active;
    if (!active || active.settled) throw new Error('当前没有可处理工具调用的 App Server Turn。');
    const params = request.params;
    if (!isRecord(params)) throw new Error('App Server 动态工具请求参数无效。');
    const threadId = optionalText(params.threadId);
    const turnId = optionalText(params.turnId);
    const callId = protocolId(params.callId, 'App Server 动态工具 callId');
    const tool = optionalText(params.tool);
    if (!threadId || threadId !== active.threadId) {
      throw new Error('App Server 动态工具请求的 threadId 不匹配。');
    }
    if (!active.turnStartAcknowledged || !active.turnId) {
      throw new Error('App Server 动态工具请求在 exact turn/start 响应确认前被拒绝。');
    }
    if (!turnId || turnId !== active.turnId) {
      throw new Error('App Server 动态工具请求的 turnId 不匹配。');
    }
    if (active.seenCallIds.has(callId)) {
      throw new Error(`App Server 动态工具 callId 已处理：${callId}`);
    }
    if (params.namespace !== undefined && params.namespace !== null) {
      throw new Error('顶层 terminal_* 动态工具不得携带 namespace。');
    }
    if (!tool) throw new Error('App Server 动态工具请求缺少 tool。');
    if (!isRecord(params.arguments)) throw new Error(`${tool} 参数必须是对象。`);
    if (active.seenCallIds.size >= MAX_TOOL_CALL_IDS) {
      const error = new Error(
        `App Server Turn 动态工具调用超过 ${MAX_TOOL_CALL_IDS} 个唯一 callId。`,
      );
      this.failProtocol(active, error);
      throw error;
    }
    active.seenCallIds.add(callId);

    try {
      if (
        tool !== 'terminal_read'
        || !active.input.terminalContextAccess
        || active.input.canReadTerminal?.() === false
      ) {
        throw new Error(`未允许的 App Server 动态工具：${tool}`);
      }
      return await this.handleTerminalRead(active, params.arguments);
    } catch (error) {
      if (active.controller.signal.aborted || !this.isActive(active)) throw error;
      return dynamicToolResult({ ok: false, error: errorMessage(error) }, false);
    }
  }

  private async handleTerminalRead(
    active: ActiveTurn,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertOnlyKeys(args, ['maxChars'], 'terminal_read');
    const maxChars = args.maxChars === undefined ? DEFAULT_TERMINAL_READ_CHARS : args.maxChars;
    if (
      typeof maxChars !== 'number'
      || !Number.isInteger(maxChars)
      || maxChars < 100
      || maxChars > MAX_TERMINAL_READ_CHARS
    ) throw new Error('terminal_read.maxChars 必须是 100 到 30000 的整数。');
    const output = await this.abortable(
      active,
      () => active.input.tools.readTerminal({ maxChars }),
    );
    if (typeof output !== 'string') throw new Error('terminal_read 返回值必须是字符串。');
    return dynamicToolResult({ ok: true, output });
  }

  private abortable<T>(active: ActiveTurn, operation: () => Promise<T>): Promise<T> {
    const signal = active.controller.signal;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const onAbort = () => rejectPromise(abortError());
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(operation)
        .then(resolvePromise, rejectPromise)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private bufferPendingNotification(
    active: ActiveTurn,
    notification: AppServerNotification,
  ): void {
    let notificationBytes: number;
    try {
      notificationBytes = Buffer.byteLength(JSON.stringify(notification), 'utf8');
    } catch {
      this.failProtocol(active, new Error(
        'App Server turn/start 响应前的通知无法安全序列化。',
      ));
      return;
    }
    if (
      active.pendingNotifications.length >= MAX_PENDING_NOTIFICATIONS
      || notificationBytes > MAX_PENDING_NOTIFICATION_BYTES
      || active.pendingNotificationBytes + notificationBytes > MAX_PENDING_NOTIFICATION_BYTES
    ) {
      this.failProtocol(
        active,
        new Error('App Server turn/start 响应前的通知缓冲超过安全上限。'),
      );
      return;
    }
    active.pendingNotifications.push(notification);
    active.pendingNotificationBytes += notificationBytes;
  }

  private replayPendingNotifications(active: ActiveTurn): void {
    const pending = active.pendingNotifications;
    active.pendingNotifications = [];
    active.pendingNotificationBytes = 0;
    for (const notification of pending) {
      if (!this.isActive(active)) return;
      if (notificationTurnId(notification) !== active.turnId) continue;
      this.handleConfirmedNotification(active, notification);
    }
  }

  private appendMessageDelta(
    active: ActiveTurn,
    itemIdValue: string,
    phase: 'commentary' | 'final_answer' | undefined,
    delta: string,
  ): { phase?: 'commentary' | 'final_answer'; text: string } {
    const itemId = protocolId(itemIdValue, 'App Server agentMessage itemId');
    const existing = active.messageItems.get(itemId);
    if (!existing && active.messageItems.size >= MAX_ASSISTANT_MESSAGE_ITEMS) {
      throw new Error(
        `App Server Turn assistant message item 超过 ${MAX_ASSISTANT_MESSAGE_ITEMS} 个。`,
      );
    }
    if (active.assistantDeltaChars + delta.length > MAX_ASSISTANT_TEXT_CHARS) {
      throw new Error(
        `App Server Turn assistant 流式增量总计超过 ${MAX_ASSISTANT_TEXT_CHARS} 字符。`,
      );
    }
    if (active.assistantTextChars + delta.length > MAX_ASSISTANT_TEXT_CHARS) {
      throw new Error(
        `App Server Turn assistant message 总文本超过 ${MAX_ASSISTANT_TEXT_CHARS} 字符。`,
      );
    }
    const message = {
      phase: existing?.phase ?? phase,
      text: `${existing?.text ?? ''}${delta}`,
    };
    active.messageItems.set(itemId, message);
    active.assistantTextChars += delta.length;
    active.assistantDeltaChars += delta.length;
    return message;
  }

  private storeMessageItem(
    active: ActiveTurn,
    itemIdValue: string,
    phase: 'commentary' | 'final_answer' | undefined,
    text: string,
  ): { phase?: 'commentary' | 'final_answer'; text: string } {
    const itemId = protocolId(itemIdValue, 'App Server agentMessage item.id');
    const existing = active.messageItems.get(itemId);
    if (!existing && active.messageItems.size >= MAX_ASSISTANT_MESSAGE_ITEMS) {
      throw new Error(
        `App Server Turn assistant message item 超过 ${MAX_ASSISTANT_MESSAGE_ITEMS} 个。`,
      );
    }
    const nextTotal = active.assistantTextChars - (existing?.text.length ?? 0) + text.length;
    if (nextTotal > MAX_ASSISTANT_TEXT_CHARS) {
      throw new Error(
        `App Server Turn assistant message 总文本超过 ${MAX_ASSISTANT_TEXT_CHARS} 字符。`,
      );
    }
    const message = { phase, text };
    active.messageItems.set(itemId, message);
    active.assistantTextChars = nextTotal;
    return message;
  }

  private recordTurnMessageItems(active: ActiveTurn, turn: Record<string, unknown>): void {
    if (!Array.isArray(turn.items)) return;
    let assistantItems = 0;
    for (const item of turn.items) {
      if (!isRecord(item) || item.type !== 'agentMessage') continue;
      assistantItems += 1;
      if (assistantItems > MAX_ASSISTANT_MESSAGE_ITEMS) {
        throw new Error(
          `App Server Turn assistant message item 超过 ${MAX_ASSISTANT_MESSAGE_ITEMS} 个。`,
        );
      }
      const itemId = protocolId(item.id, 'App Server turn.items agentMessage id');
      const existing = active.messageItems.get(itemId);
      const text = typeof item.text === 'string' ? item.text : existing?.text ?? '';
      this.storeMessageItem(
        active,
        itemId,
        agentMessagePhase(item.phase) ?? existing?.phase,
        text,
      );
    }
  }

  private requestTargetsCurrentTurn(params: unknown, active: ActiveTurn): boolean {
    if (!isRecord(params)) return false;
    const threadId = optionalText(params.threadId);
    const turnId = optionalText(params.turnId);
    if (!active.turnStartIssued || threadId !== active.threadId || !turnId) return false;
    return !active.turnId || turnId === active.turnId;
  }

  private recordNativeApproval(
    active: ActiveTurn,
    params: unknown,
    kind: CodexNativeApprovalEvent['kind'],
    decision: CodexNativeApprovalEvent['decision'],
  ): void {
    const record = isRecord(params) ? params : {};
    try {
      active.input.onNativeApproval?.({
        kind,
        decision,
        threadId: optionalText(record.threadId),
        turnId: optionalText(record.turnId),
        itemId: optionalText(record.itemId),
      });
    } catch {
      // Audit/UI callbacks must not prevent App Server from resolving a request.
    }
  }

  private validateNotificationTurn(
    active: ActiveTurn,
    params: Record<string, unknown>,
  ): void {
    const turnId = optionalText(params.turnId);
    if (!turnId) throw new Error('App Server Turn 通知缺少 turnId。');
    if (!active.turnStartAcknowledged || !active.turnId || active.turnId !== turnId) {
      throw new Error('App Server Turn 收到不匹配的 turnId。');
    }
  }

  private observeCompletion(active: ActiveTurn, turn: Record<string, unknown>): void {
    const status = optionalText(turn.status);
    if (status !== 'completed' && status !== 'interrupted' && status !== 'failed') {
      throw new Error(`App Server 返回了无效 Turn 终态：${status ?? '缺失'}`);
    }
    const threadId = active.threadId;
    const turnId = active.turnId;
    if (!threadId || !turnId) throw new Error('App Server Turn 终态缺少关联 ID。');
    const finalText = extractAgentText(turn) ?? active.finalText;
    active.finalText = finalText;
    active.observedCompletion = {
      threadId,
      turnId,
      status,
      finalText,
      ...(status === 'failed' ? { error: turnError(turn) ?? 'Codex App Server Turn 失败。' } : {}),
    };
  }

  private maybeComplete(active: ActiveTurn): void {
    if (!active.turnStartAcknowledged || !active.observedCompletion) return;
    this.resolveActive(active, active.observedCompletion);
  }

  private maybeSendInterrupt(active: ActiveTurn): void {
    if (
      !active.interruptRequested
      || active.interruptRequest
      || !active.threadId
      || !active.turnId
      || !this.isActive(active)
    ) return;
    active.interruptRequest = active.connection.request('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId,
    }).then(() => undefined).catch((error) => {
      // A rejected interrupt is an RPC/application error, not evidence that
      // subsequent messages on this connection are structurally unsafe.
      this.failActive(active, error);
      throw error;
    });
    void active.interruptRequest.catch(() => undefined);
  }

  private failProtocol(active: ActiveTurn, error: unknown): void {
    if (active.settled) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    this.quarantinedAttachmentGeneration = active.attachmentGeneration;
    active.interruptRequested = true;
    active.controller.abort(failure);
    this.maybeSendInterrupt(active);
    this.failActive(active, failure);
  }

  private resolveActive(active: ActiveTurn, result: RunCodexTurnResult): void {
    if (active.settled) return;
    active.settled = true;
    active.removeExternalAbort();
    active.controller.abort();
    if (this.active === active) this.active = undefined;
    active.completion.resolve(result);
    active.interruptDone.resolve();
  }

  private failActive(active: ActiveTurn, error: unknown): void {
    if (active.settled) return;
    active.settled = true;
    active.removeExternalAbort();
    active.controller.abort(error instanceof Error ? error : undefined);
    if (this.active === active) this.active = undefined;
    active.completion.reject(error instanceof Error ? error : new Error(String(error)));
    active.interruptDone.resolve();
  }

  private assertActive(active: ActiveTurn): void {
    if (!this.isActive(active)) throw new Error('Codex App Server Turn 已失效。');
  }

  private isActive(active: ActiveTurn): boolean {
    return !active.settled
      && this.active === active
      && this.connection === active.connection
      && this.attachmentGeneration === active.attachmentGeneration
      && !this.disposed;
  }

  private isAttachmentCurrent(
    connection: AppServerConnection,
    generation: number,
  ): boolean {
    return !this.disposed
      && this.connection === connection
      && this.attachmentGeneration === generation;
  }

  private detachInternal(error: Error): void {
    this.attachmentGeneration += 1;
    const removeNotificationListener = this.removeNotificationListener;
    const removeRequestHandler = this.removeRequestHandler;
    const removeExitListener = this.removeExitListener;
    this.removeNotificationListener = undefined;
    this.removeRequestHandler = undefined;
    this.removeExitListener = undefined;
    this.connection = undefined;
    try { removeNotificationListener?.(); } catch { /* best-effort cleanup */ }
    try { removeRequestHandler?.(); } catch { /* best-effort cleanup */ }
    try { removeExitListener?.(); } catch { /* best-effort cleanup */ }
    if (this.active) this.failActive(this.active, error);
  }
}
