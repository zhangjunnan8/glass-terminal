import { isAbsolute, resolve } from 'node:path';
import type { AgentCommandResult } from '../agent/agent-loop';
import type {
  AppServerConnection,
  AppServerNotification,
  AppServerRequest,
} from './app-server-client';

const DEFAULT_TERMINAL_READ_CHARS = 8_000;
const MAX_TERMINAL_READ_CHARS = 30_000;
const MAX_COMMAND_CHARS = 20_000;
const MAX_REASON_CHARS = 1_000;

const DEVELOPER_INSTRUCTIONS = `You and the human operate the exact same visible terminal session.
Use only terminal_read, terminal_state, and terminal_execute for terminal or filesystem work.
Never claim that a command ran unless terminal_execute returned its result.
Never ask the user to paste passwords, API keys, passphrases, OTPs, or other credentials into chat.
Authentication is entered by the user directly in the visible terminal.
Do not use or request any built-in shell, command execution, or file-change capability.`;

export const CODEX_TERMINAL_DYNAMIC_TOOLS = [
  {
    type: 'function',
    name: 'terminal_read',
    description: 'Read a bounded recent portion of the exact visible terminal history.',
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
  },
  {
    type: 'function',
    name: 'terminal_state',
    description: 'Read the transport and control state of the exact visible terminal.',
    deferLoading: false,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'terminal_execute',
    description: 'Request one command in the exact visible terminal. Existing approval and Full Takeover rules apply.',
    deferLoading: false,
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', minLength: 1, maxLength: MAX_COMMAND_CHARS },
        reason: { type: 'string', maxLength: MAX_REASON_CHARS },
      },
      additionalProperties: false,
    },
  },
] as const;

export interface CodexAppServerTurnTools {
  readTerminal(request: { maxChars: number }): Promise<string>;
  getTerminalState(): Promise<Record<string, unknown>>;
  executeCommand(
    request: { command: string; reason?: string },
    signal: AbortSignal,
  ): Promise<AgentCommandResult>;
}

export interface RunCodexTurnInput {
  prompt: string;
  model: string;
  reasoningEffort?: string;
  /** Existing App Server thread to resume. Omit to create a new thread. */
  threadId?: string;
  signal: AbortSignal;
  tools: CodexAppServerTurnTools;
  onThreadBound?(threadId: string): void;
  onDelta?(delta: string): void;
}

export interface RunCodexTurnResult {
  threadId: string;
  turnId: string;
  status: 'completed' | 'interrupted' | 'failed';
  finalText: string;
  error?: string;
}

export interface CodexAppServerIsolationViolation {
  kind: 'command-execution' | 'file-change' | 'permission-request';
  detail: string;
}

export interface CodexAppServerTurnRunnerOptions {
  onIsolationViolation?(violation: CodexAppServerIsolationViolation): void;
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
  seenCallIds: Set<string>;
  executeInFlight: boolean;
  pendingIsolationError?: Error;
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
    if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return undefined;
}

function turnError(turn: Record<string, unknown>): string | undefined {
  if (!isRecord(turn.error)) return undefined;
  return optionalText(turn.error.message);
}

function forbiddenItemKind(
  item: Record<string, unknown>,
): CodexAppServerIsolationViolation['kind'] | undefined {
  if (item.type === 'commandExecution') return 'command-execution';
  if (item.type === 'fileChange') return 'file-change';
  return undefined;
}

function forbiddenTurnItemKind(
  turn: Record<string, unknown>,
): CodexAppServerIsolationViolation['kind'] | undefined {
  if (!Array.isArray(turn.items)) return undefined;
  for (const item of turn.items) {
    if (!isRecord(item)) continue;
    const kind = forbiddenItemKind(item);
    if (kind) return kind;
  }
  return undefined;
}

export class CodexAppServerTurnRunner {
  private readonly sandboxRoot: string;
  private readonly options: CodexAppServerTurnRunnerOptions;
  private connection?: AppServerConnection;
  private attachmentGeneration = 0;
  private sequence = 0;
  private disposed = false;
  private active?: ActiveTurn;
  private removeNotificationListener?: () => void;
  private removeRequestHandler?: () => void;
  private removeExitListener?: () => void;

  constructor(
    sandboxRoot: string,
    options: CodexAppServerTurnRunnerOptions = {},
  ) {
    if (!sandboxRoot.trim() || !isAbsolute(sandboxRoot)) {
      throw new Error('App Server Agent sandboxRoot 必须是绝对路径。');
    }
    this.sandboxRoot = resolve(sandboxRoot);
    this.options = options;
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
      seenCallIds: new Set(),
      executeInFlight: false,
      settled: false,
    };
    const onAbort = () => {
      void this.interrupt().catch(() => undefined);
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    active.removeExternalAbort = () => input.signal.removeEventListener('abort', onAbort);
    this.active = active;
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
      cwd: this.sandboxRoot,
      runtimeWorkspaceRoots: [],
      environments: [],
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      model: active.input.model,
      ...(active.input.reasoningEffort
        ? { effort: active.input.reasoningEffort }
        : {}),
    });
    this.assertActive(active);
    if (!isRecord(response) || !isRecord(response.turn)) {
      throw new Error('App Server 返回了无效的 turn/start 响应。');
    }
    const turnId = optionalText(response.turn.id);
    if (!turnId) throw new Error('App Server turn/start 响应缺少 turn.id。');
    this.bindTurnId(active, turnId);
    if (this.settlePendingIsolation(active)) return;
    const forbiddenKind = forbiddenTurnItemKind(response.turn);
    if (forbiddenKind) {
      this.failIsolation(active, forbiddenKind, 'turn/start 响应包含被禁用的内建项目。');
      return;
    }
    active.turnStartAcknowledged = true;
    const status = optionalText(response.turn.status);
    if (status && status !== 'inProgress') this.observeCompletion(active, response.turn);
    this.maybeSendInterrupt(active);
    this.maybeComplete(active);
  }

  private async startThread(active: ActiveTurn): Promise<string> {
    const response = await active.connection.request<ThreadResponse>('thread/start', {
      model: active.input.model,
      cwd: this.sandboxRoot,
      runtimeWorkspaceRoots: [],
      environments: [],
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      dynamicTools: CODEX_TERMINAL_DYNAMIC_TOOLS,
    });
    this.assertActive(active);
    return this.parseThreadId(response, 'thread/start');
  }

  private async resumeThread(active: ActiveTurn, expectedThreadId: string): Promise<string> {
    const response = await active.connection.request<ThreadResponse>('thread/resume', {
      threadId: expectedThreadId,
      model: active.input.model,
      cwd: this.sandboxRoot,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: DEVELOPER_INSTRUCTIONS,
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
    const threadId = optionalText(response.thread.id);
    if (!threadId) throw new Error(`App Server ${method} 响应缺少 thread.id。`);
    return threadId;
  }

  private handleNotification(notification: AppServerNotification): void {
    const active = this.active;
    if (!active || !isRecord(notification.params)) return;
    const params = notification.params;
    const threadId = optionalText(params.threadId);
    if (!threadId || !active.threadId || threadId !== active.threadId) return;

    if (notification.method.startsWith('item/commandExecution/')) {
      this.failIsolation(
        active,
        'command-execution',
        `观察到被禁用的内建事件：${notification.method}`,
      );
      return;
    }
    if (notification.method.startsWith('item/fileChange/')) {
      this.failIsolation(
        active,
        'file-change',
        `观察到被禁用的内建事件：${notification.method}`,
      );
      return;
    }

    if (notification.method === 'turn/started') {
      if (!isRecord(params.turn)) {
        this.failActive(active, new Error('App Server turn/started 通知无效。'));
        return;
      }
      const turnId = optionalText(params.turn.id);
      if (!turnId) {
        this.failActive(active, new Error('App Server turn/started 缺少 turn.id。'));
        return;
      }
      try {
        this.bindTurnId(active, turnId);
        if (this.settlePendingIsolation(active)) return;
        const forbiddenKind = forbiddenTurnItemKind(params.turn);
        if (forbiddenKind) {
          this.failIsolation(active, forbiddenKind, 'turn/started 包含被禁用的内建项目。');
          return;
        }
        this.maybeSendInterrupt(active);
      } catch (error) {
        this.failActive(active, error);
      }
      return;
    }

    if (notification.method === 'item/agentMessage/delta') {
      try {
        this.validateNotificationTurn(active, params);
      } catch (error) {
        this.failActive(active, error);
        return;
      }
      if (typeof params.delta === 'string') {
        active.finalText += params.delta;
        try { active.input.onDelta?.(params.delta); } catch { /* UI callback isolation */ }
      }
      return;
    }

    if (notification.method === 'item/started' || notification.method === 'item/completed') {
      try {
        this.validateNotificationTurn(active, params);
      } catch (error) {
        this.failActive(active, error);
        return;
      }
      if (!isRecord(params.item)) return;
      const forbiddenKind = forbiddenItemKind(params.item);
      if (forbiddenKind) {
        this.failIsolation(
          active,
          forbiddenKind,
          `观察到被禁用的内建项目：${String(params.item.type)}`,
        );
        return;
      }
      if (
        notification.method === 'item/completed'
        && params.item.type === 'agentMessage'
        && typeof params.item.text === 'string'
      ) active.finalText = params.item.text;
      return;
    }

    if (notification.method === 'turn/completed') {
      if (!isRecord(params.turn)) {
        this.failActive(active, new Error('App Server turn/completed 通知无效。'));
        return;
      }
      try {
        const turnId = optionalText(params.turn.id);
        if (!turnId) throw new Error('App Server turn/completed 缺少 turn.id。');
        this.bindTurnId(active, turnId);
        if (this.settlePendingIsolation(active)) return;
        const forbiddenKind = forbiddenTurnItemKind(params.turn);
        if (forbiddenKind) {
          this.failIsolation(active, forbiddenKind, 'turn/completed 包含被禁用的内建项目。');
          return;
        }
        this.observeCompletion(active, params.turn);
        this.maybeComplete(active);
      } catch (error) {
        this.failActive(active, error);
      }
    }
  }

  private async handleRequest(request: AppServerRequest): Promise<unknown> {
    if (
      request.method === 'item/commandExecution/requestApproval'
      || request.method === 'item/fileChange/requestApproval'
    ) {
      const active = this.active;
      if (active && this.requestTargetsActiveTurn(request.params, active)) {
        this.failIsolation(
          active,
          request.method === 'item/commandExecution/requestApproval'
            ? 'command-execution'
            : 'file-change',
          `收到被禁用的内建审批：${request.method}`,
        );
      }
      return { decision: 'decline' };
    }
    if (request.method === 'item/permissions/requestApproval') {
      const active = this.active;
      if (active && this.requestTargetsActiveTurn(request.params, active)) {
        this.failIsolation(
          active,
          'permission-request',
          '收到被禁用的权限审批：item/permissions/requestApproval',
        );
      }
      return { permissions: {} };
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
    const callId = optionalText(params.callId);
    const tool = optionalText(params.tool);
    if (!threadId || threadId !== active.threadId) {
      throw new Error('App Server 动态工具请求的 threadId 不匹配。');
    }
    if (!turnId) throw new Error('App Server 动态工具请求缺少 turnId。');
    if (!active.turnId || turnId !== active.turnId) {
      throw new Error('App Server 动态工具请求的 turnId 不匹配。');
    }
    if (!callId) throw new Error('App Server 动态工具请求缺少 callId。');
    if (active.seenCallIds.has(callId)) {
      throw new Error(`App Server 动态工具 callId 已处理：${callId}`);
    }
    if (params.namespace !== undefined && params.namespace !== null) {
      throw new Error('顶层 terminal_* 动态工具不得携带 namespace。');
    }
    if (!tool) throw new Error('App Server 动态工具请求缺少 tool。');
    if (!isRecord(params.arguments)) throw new Error(`${tool} 参数必须是对象。`);
    active.seenCallIds.add(callId);

    try {
      switch (tool) {
        case 'terminal_read':
          return await this.handleTerminalRead(active, params.arguments);
        case 'terminal_state':
          return await this.handleTerminalState(active, params.arguments);
        case 'terminal_execute':
          return await this.handleTerminalExecute(active, params.arguments);
        default:
          throw new Error(`未允许的 App Server 动态工具：${tool}`);
      }
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

  private async handleTerminalState(
    active: ActiveTurn,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertOnlyKeys(args, [], 'terminal_state');
    const state = await this.abortable(active, () => active.input.tools.getTerminalState());
    if (!isRecord(state)) throw new Error('terminal_state 返回值必须是对象。');
    return dynamicToolResult({ ok: true, state });
  }

  private async handleTerminalExecute(
    active: ActiveTurn,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assertOnlyKeys(args, ['command', 'reason'], 'terminal_execute');
    if (
      typeof args.command !== 'string'
      || !args.command.trim()
      || args.command.length > MAX_COMMAND_CHARS
    ) throw new Error('terminal_execute.command 必须是非空且不超过 20000 字符的字符串。');
    if (args.reason !== undefined && (
      typeof args.reason !== 'string'
      || args.reason.length > MAX_REASON_CHARS
    )) throw new Error('terminal_execute.reason 必须是不超过 1000 字符的字符串。');
    if (active.executeInFlight) throw new Error('已有 terminal_execute 正在运行。');
    active.executeInFlight = true;
    try {
      const result = await this.abortable(active, () => active.input.tools.executeCommand({
        command: args.command as string,
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
      }, active.controller.signal));
      return dynamicToolResult({ ok: true, result });
    } finally {
      active.executeInFlight = false;
    }
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

  private requestTargetsActiveTurn(params: unknown, active: ActiveTurn): boolean {
    if (!isRecord(params)) return false;
    const threadId = optionalText(params.threadId);
    const turnId = optionalText(params.turnId);
    return threadId === active.threadId
      && Boolean(turnId)
      && (!active.turnId || turnId === active.turnId);
  }

  private validateNotificationTurn(
    active: ActiveTurn,
    params: Record<string, unknown>,
  ): void {
    const turnId = optionalText(params.turnId);
    if (!turnId) throw new Error('App Server Turn 通知缺少 turnId。');
    this.bindTurnId(active, turnId);
    if (this.settlePendingIsolation(active)) {
      throw active.pendingIsolationError ?? new Error('App Server Agent 隔离违规。');
    }
  }

  private bindTurnId(active: ActiveTurn, turnId: string): void {
    if (active.turnId && active.turnId !== turnId) {
      throw new Error('App Server Turn 收到不匹配的 turnId。');
    }
    active.turnId = turnId;
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
      this.failActive(active, error);
      throw error;
    });
    void active.interruptRequest.catch(() => undefined);
  }

  private failIsolation(
    active: ActiveTurn,
    kind: CodexAppServerIsolationViolation['kind'],
    detail: string,
  ): void {
    if (active.settled) return;
    const error = new Error(`App Server Agent 隔离违规：${detail}`);
    if (!active.pendingIsolationError) {
      try { this.options.onIsolationViolation?.({ kind, detail }); } catch { /* host callback isolation */ }
    }
    active.interruptRequested = true;
    active.controller.abort(error);
    if (!active.turnId) {
      active.pendingIsolationError = error;
      return;
    }
    this.maybeSendInterrupt(active);
    this.failActive(active, error);
  }

  private settlePendingIsolation(active: ActiveTurn): boolean {
    const error = active.pendingIsolationError;
    if (!error || !active.turnId || active.settled) return false;
    this.maybeSendInterrupt(active);
    this.failActive(active, error);
    return true;
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
