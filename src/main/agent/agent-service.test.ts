import type { WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_CHANNELS,
  CODEX_APP_SERVER_AGENT_BACKEND,
  CODEX_APP_SERVER_AGENT_POLICY_VERSION,
} from '../../shared/agent';
import type {
  AgentBackendRef,
  AgentFileAccessMode,
  AgentSessionView,
  CommandActor,
  CommandExecution,
  TerminalInputMode,
} from '../../shared/agent';
import type { ProviderProfile } from '../../shared/provider';
import type { SessionRecord } from '../../shared/session';
import type { ToolGateway } from '../../shared/tools';
import type { ProviderStore } from '../providers/provider-store';
import type { CodexAppServerService } from '../app-server/app-server-service';
import type { RunCodexTurnInput } from '../app-server/app-server-turn-runner';
import type { SessionManager } from '../sessions/session-manager';
import type {
  StructuredExecutionHooks,
  TerminalService,
} from '../terminal/terminal-service';
import type {
  AgentBackend,
  AgentBackendEvent,
  AgentBackendResult,
  AgentBackendThread,
  AgentMessage,
  AgentToolCall,
  InterruptAgentBackendInput,
  SendAgentBackendMessageInput,
} from './agent-backend';
import type { AgentFileService } from './agent-file-service';
import { AgentService } from './agent-service';

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Agent state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface ScriptedCompletion {
  message: {
    role: 'assistant';
    content: string | null;
    toolCalls?: AgentToolCall[];
  };
}

interface ScriptedCompletionRequest {
  messages: AgentMessage[];
  signal: AbortSignal;
  onTextDelta?(delta: string): void;
}

interface ScriptedProvider {
  complete(request: ScriptedCompletionRequest): Promise<ScriptedCompletion>;
}

function parseScriptedToolArguments(call: AgentToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be an object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid arguments for ${call.name}: ${(error as Error).message}`);
  }
}

function throwIfScriptedTurnCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Agent turn cancelled.');
  error.name = 'AbortError';
  throw error;
}

/**
 * Test-only scripted harness. It implements the `AgentBackend` boundary with a
 * deterministic, caller-driven completion sequence so AgentService orchestration
 * tests can exercise the real per-turn ToolGateway without a network or model.
 */
class ScriptedLoopBackend implements AgentBackend {
  private readonly threads = new Map<string, {
    handle: AgentBackendThread;
    priorMessages: AgentMessage[];
  }>();
  private readonly activeTurns = new Map<string, { controller: AbortController }>();

  constructor(private readonly provider: ScriptedProvider) {}

  async createThread(input: { id: string; signal?: AbortSignal }): Promise<AgentBackendThread> {
    if (input.signal) throwIfScriptedTurnCancelled(input.signal);
    if (this.threads.has(input.id)) throw new Error(`Agent backend thread ${input.id} already exists.`);
    const handle = Object.freeze({ id: input.id });
    this.threads.set(input.id, { handle, priorMessages: [] });
    return handle;
  }

  async resume(input: {
    id: string;
    priorMessages: readonly AgentMessage[];
    signal?: AbortSignal;
  }): Promise<AgentBackendThread> {
    if (input.signal) throwIfScriptedTurnCancelled(input.signal);
    const handle = Object.freeze({ id: input.id });
    this.threads.set(input.id, {
      handle,
      priorMessages: input.priorMessages.map((message) => ({ ...message })),
    });
    return handle;
  }

  async sendMessage(input: SendAgentBackendMessageInput): Promise<AgentBackendResult> {
    const record = this.threads.get(input.thread.id);
    if (!record || record.handle !== input.thread) {
      throw new Error('Agent backend thread handle is missing or stale.');
    }
    if (this.activeTurns.has(input.thread.id)) {
      throw new Error(`Agent backend thread ${input.thread.id} already has an active turn.`);
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) abortFromCaller();
    else input.signal.addEventListener('abort', abortFromCaller, { once: true });
    this.activeTurns.set(input.thread.id, { controller });

    try {
      const messages: AgentMessage[] = [
        { role: 'system', content: input.systemPrompt },
        ...record.priorMessages.map((message) => ({ ...message })),
        {
          role: 'user',
          content: `${input.prompt}\n\nRecent visible terminal context:\n${input.terminalContext}`,
        },
      ];
      let finalText = '';

      for (let round = 0; round < 64; round += 1) {
        throwIfScriptedTurnCancelled(controller.signal);
        const completion = await this.provider.complete({
          messages,
          signal: controller.signal,
          onTextDelta: (delta) => {
            if (delta && !controller.signal.aborted) {
              input.onEvent?.({ type: 'assistant_delta', text: delta });
            }
          },
        });
        throwIfScriptedTurnCancelled(controller.signal);
        const assistant = completion.message;
        messages.push(assistant);
        if (assistant.content) {
          finalText = assistant.content;
          input.onEvent?.({ type: 'assistant_text', text: assistant.content });
        }
        if (!assistant.toolCalls?.length) {
          throwIfScriptedTurnCancelled(controller.signal);
          record.priorMessages = messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({ ...message }));
          return {
            id: randomUUID(),
            messages: messages.map((message) => ({ ...message })),
            finalText,
            rounds: round + 1,
          };
        }

        for (const call of assistant.toolCalls) {
          throwIfScriptedTurnCancelled(controller.signal);
          input.onEvent?.({ type: 'tool_started', toolCall: call });
          throwIfScriptedTurnCancelled(controller.signal);
          let result: string;
          try {
            result = await this.executeTool(input.gateway, call, input.fileAccessMode);
          } catch (error) {
            throwIfScriptedTurnCancelled(controller.signal);
            result = JSON.stringify({ ok: false, error: (error as Error).message });
          }
          throwIfScriptedTurnCancelled(controller.signal);
          messages.push({ role: 'tool', toolCallId: call.id, content: result });
          input.onEvent?.({ type: 'tool_completed', toolCall: call, result });
          throwIfScriptedTurnCancelled(controller.signal);
        }
      }
      throw new Error('Scripted backend exceeded the round limit.');
    } finally {
      input.signal.removeEventListener('abort', abortFromCaller);
      const active = this.activeTurns.get(input.thread.id);
      if (active?.controller === controller) this.activeTurns.delete(input.thread.id);
    }
  }

  async interrupt(input: InterruptAgentBackendInput): Promise<void> {
    this.activeTurns.get(input.threadId)?.controller.abort(
      new Error(`Agent turn interrupted: ${input.reason}.`),
    );
  }

  private async executeTool(
    gateway: ToolGateway,
    call: AgentToolCall,
    fileAccessMode: AgentFileAccessMode,
  ): Promise<string> {
    const args = parseScriptedToolArguments(call);
    switch (call.name) {
      case 'terminal_read': {
        const requested = typeof args.maxChars === 'number' ? args.maxChars : 8_000;
        const maxChars = Math.min(30_000, Math.max(100, Math.floor(requested)));
        return JSON.stringify({
          ok: true,
          output: await gateway.terminal.readVisible({ maxChars }),
        });
      }
      case 'terminal_state':
        return JSON.stringify({ ok: true, state: await gateway.terminal.getState() });
      case 'terminal_execute': {
        if (typeof args.command !== 'string' || !args.command.trim()) {
          throw new Error('terminal_execute requires a non-empty command.');
        }
        const result = await gateway.terminal.execute(
          args.command,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        return JSON.stringify({ ok: result.status === 'completed', ...result });
      }
      case 'workspace_list': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        const path = typeof args.path === 'string' ? args.path : '.';
        return JSON.stringify({ ok: true, ...await workspace.listDirectory(path) });
      }
      case 'workspace_read_file': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        return JSON.stringify({
          ok: true,
          ...await workspace.readFile(this.requiredPath(args, call.name)),
        });
      }
      case 'workspace_stat': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        return JSON.stringify({
          ok: true,
          ...await workspace.stat(this.requiredPath(args, call.name)),
        });
      }
      case 'workspace_search': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        if (typeof args.query !== 'string' || !args.query) {
          throw new Error('workspace_search requires a valid query.');
        }
        return JSON.stringify({
          ok: true,
          ...await workspace.search(args.query, {
            ...(typeof args.path === 'string' ? { path: args.path } : {}),
            ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
          }),
        });
      }
      case 'workspace_glob': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        if (typeof args.pattern !== 'string' || !args.pattern) {
          throw new Error('workspace_glob requires a valid pattern.');
        }
        return JSON.stringify({
          ok: true,
          ...await workspace.glob(args.pattern, {
            ...(typeof args.path === 'string' ? { path: args.path } : {}),
            ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
          }),
        });
      }
      case 'workspace_apply_patch': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        return JSON.stringify({
          ok: true,
          ...await workspace.applyPatch(
            this.requiredPath(args, call.name),
            this.requiredString(args, 'expectedSha256', call.name),
            args.patches as never,
          ),
        });
      }
      case 'workspace_write_file': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        return JSON.stringify({
          ok: true,
          ...await workspace.writeFile(
            this.requiredPath(args, call.name),
            this.requiredString(args, 'content', call.name),
            (args.expectedSha256 as string | null) ?? null,
          ),
        });
      }
      case 'workspace_mkdir': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        const path = this.requiredPath(args, call.name);
        await workspace.mkdir(path);
        return JSON.stringify({ ok: true, path });
      }
      case 'workspace_rename': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        const source = this.requiredPath(args, call.name, 'source');
        const destination = this.requiredPath(args, call.name, 'destination');
        await workspace.rename(source, destination);
        return JSON.stringify({ ok: true, source, destination });
      }
      case 'workspace_delete': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, call.name);
        const path = this.requiredPath(args, call.name);
        const recursive = args.recursive === true;
        await workspace.delete(path, { recursive });
        return JSON.stringify({ ok: true, path, recursive });
      }
      default:
        throw new Error(`Unsupported tool: ${call.name}`);
    }
  }

  private requireWorkspace(
    gateway: ToolGateway,
    fileAccessMode: AgentFileAccessMode,
    toolName: string,
  ): NonNullable<ToolGateway['workspace']> {
    const permissions = gateway.context.permissions.workspace;
    if (
      fileAccessMode === 'off'
      || !permissions.enabled
      || !permissions.read
      || !gateway.workspace
    ) throw new Error(`${toolName} is disabled.`);
    return gateway.workspace;
  }

  private requiredPath(args: Record<string, unknown>, toolName: string, field = 'path'): string {
    const value = args[field];
    if (typeof value !== 'string' || !value || value.length > 4_096) {
      throw new Error(`${toolName} requires a valid ${field}.`);
    }
    return value;
  }

  private requiredString(args: Record<string, unknown>, field: string, toolName: string): string {
    const value = args[field];
    if (typeof value !== 'string') throw new Error(`${toolName} requires a valid ${field}.`);
    return value;
  }
}

class FakeProvider implements ScriptedProvider {
  readonly requests: ScriptedCompletionRequest[] = [];

  constructor(private readonly responses: ScriptedCompletion[]) {}

  async complete(request: ScriptedCompletionRequest): Promise<ScriptedCompletion> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('No fake response remains.');
    return response;
  }
}

class DeferredStreamingProvider implements ScriptedProvider {
  request?: ScriptedCompletionRequest;
  private resolveCompletion?: (value: ScriptedCompletion) => void;

  complete(request: ScriptedCompletionRequest): Promise<ScriptedCompletion> {
    this.request = request;
    return new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
  }

  push(delta: string): void {
    if (!this.request) throw new Error('Streaming request has not started.');
    this.request.onTextDelta?.(delta);
  }

  finish(content: string): void {
    if (!this.resolveCompletion) throw new Error('Streaming request has not started.');
    this.resolveCompletion({ message: { role: 'assistant', content } });
  }
}

class RecordingBackend implements AgentBackend {
  readonly createInputs: Array<{ id: string }> = [];
  readonly resumeInputs: Array<{ id: string; priorMessages: readonly AgentMessage[] }> = [];
  readonly sendInputs: SendAgentBackendMessageInput[] = [];
  readonly priorMessagesAtSend: AgentMessage[][] = [];
  readonly interrupts: InterruptAgentBackendInput[] = [];
  private readonly histories = new Map<string, AgentMessage[]>();

  async createThread(input: { id: string }): Promise<AgentBackendThread> {
    this.createInputs.push({ id: input.id });
    this.histories.set(input.id, []);
    return { id: input.id };
  }

  async resume(input: {
    id: string;
    priorMessages: readonly AgentMessage[];
  }): Promise<AgentBackendThread> {
    const priorMessages = input.priorMessages.map((message) => ({ ...message }));
    this.resumeInputs.push({ id: input.id, priorMessages });
    this.histories.set(input.id, priorMessages);
    return { id: input.id };
  }

  async sendMessage(input: SendAgentBackendMessageInput): Promise<AgentBackendResult> {
    this.sendInputs.push(input);
    const priorMessages = this.histories.get(input.thread.id) ?? [];
    this.priorMessagesAtSend.push(priorMessages.map((message) => ({ ...message })));
    return this.complete(input);
  }

  async interrupt(input: InterruptAgentBackendInput): Promise<void> {
    this.interrupts.push(input);
  }

  protected complete(input: SendAgentBackendMessageInput): AgentBackendResult {
    const finalText = `reply:${input.prompt}`;
    const messages: AgentMessage[] = [
      ...(this.histories.get(input.thread.id) ?? []),
      { role: 'user', content: input.prompt },
      { role: 'assistant', content: finalText },
    ];
    this.histories.set(input.thread.id, messages);
    input.onEvent?.({ type: 'assistant_text', text: finalText });
    return {
      id: `turn-${this.sendInputs.length}`,
      messages,
      finalText,
      rounds: 1,
    };
  }
}

class DeferredRecordingBackend extends RecordingBackend {
  private pending?: {
    input: SendAgentBackendMessageInput;
    resolve(result: AgentBackendResult): void;
  };

  override sendMessage(input: SendAgentBackendMessageInput): Promise<AgentBackendResult> {
    this.sendInputs.push(input);
    this.priorMessagesAtSend.push([]);
    return new Promise((resolve) => {
      this.pending = { input, resolve };
    });
  }

  finish(): void {
    if (!this.pending) throw new Error('Backend message has not started.');
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(this.complete(pending.input));
  }
}

class DeferredActivityBackend extends RecordingBackend {
  private pending?: {
    input: SendAgentBackendMessageInput;
    resolve(result: AgentBackendResult): void;
    reject(error: unknown): void;
  };

  override sendMessage(input: SendAgentBackendMessageInput): Promise<AgentBackendResult> {
    this.sendInputs.push(input);
    this.priorMessagesAtSend.push([]);
    return new Promise((resolve, reject) => {
      this.pending = { input, resolve, reject };
    });
  }

  emit(event: AgentBackendEvent): void {
    if (!this.pending) throw new Error('Backend message has not started.');
    this.pending.input.onEvent?.(event);
  }

  finish(): void {
    if (!this.pending) throw new Error('Backend message has not started.');
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(this.complete(pending.input));
  }

  fail(error: unknown): void {
    if (!this.pending) throw new Error('Backend message has not started.');
    const pending = this.pending;
    this.pending = undefined;
    pending.reject(error);
  }
}

class DeferredCreateBackend extends RecordingBackend {
  private pendingCreate?: {
    input: { id: string };
    resolve(thread: AgentBackendThread): void;
    reject(error: unknown): void;
  };

  override createThread(input: { id: string }): Promise<AgentBackendThread> {
    this.createInputs.push(input);
    return new Promise((resolve, reject) => {
      this.pendingCreate = { input, resolve, reject };
    });
  }

  resolveCreate(): void {
    if (!this.pendingCreate) throw new Error('Backend thread creation has not started.');
    const pending = this.pendingCreate;
    this.pendingCreate = undefined;
    pending.resolve({ id: pending.input.id });
  }

  rejectCreate(error: unknown): void {
    if (!this.pendingCreate) throw new Error('Backend thread creation has not started.');
    const pending = this.pendingCreate;
    this.pendingCreate = undefined;
    pending.reject(error);
  }
}

class ThrowingInterruptActivityBackend extends DeferredActivityBackend {
  override interrupt(input: InterruptAgentBackendInput): Promise<void> {
    this.interrupts.push(input);
    throw new Error('synchronous backend interrupt failure');
  }
}

class FakeSessions {
  readonly audits: Array<{ type: string; details?: Record<string, unknown> }> = [];
  readonly threadEvents: Array<Record<string, unknown>> = [];
  persistedThreadEvents: Array<Record<string, unknown>> = [];
  readonly failAuditTypes = new Set<string>();
  failThreadEvents = false;
  persistedThreadId?: string;
  fullTakeover = false;
  session: SessionRecord = {
    schemaVersion: 1,
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Test Session',
    nameSource: 'automatic',
    transport: 'ssh',
    hostId: 'host',
    shellProfileId: 'ssh:host',
    shellKind: 'posix',
    targetSnapshot: {
      label: 'Test', hostname: '192.0.2.10', port: 22, username: 'tester',
    },
    connectionState: 'connected',
    status: 'active',
    runtimeTerminalId: 'terminal',
    cwd: '/home/tester/project',
    effectiveUser: 'tester',
    pinned: false,
    preludeTruncated: false,
    droppedPreludeBytes: 0,
    startedAt: new Date(0).toISOString(),
    promotedAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastConnectedAt: new Date(0).toISOString(),
  };

  upgrade() { return this.session; }
  sessionForTerminal() { return this.session; }
  bindAgentThread(
    _sessionId: string,
    providerId: string,
    threadId: string,
    backendFingerprint: string,
  ) {
    this.session = {
      ...this.session,
      providerId,
      agentBackend: { kind: 'generic-provider', providerId },
      aiThreadId: threadId,
      agentBackendFingerprint: backendFingerprint,
      providerThreadId: undefined,
    };
    return this.session;
  }
  bindAgentBackendThread(_sessionId: string, backend: AgentBackendRef, threadId: string) {
    this.session = {
      ...this.session,
      providerId: backend.kind === 'generic-provider' ? backend.providerId : undefined,
      agentBackend: backend,
      aiThreadId: threadId,
      agentBackendFingerprint: undefined,
      providerThreadId: undefined,
    };
    return this.session;
  }
  bindProviderThread(_sessionId: string, localThreadId: string, providerThreadId: string) {
    if (this.session.aiThreadId !== localThreadId) throw new Error('stale local thread');
    this.session = { ...this.session, providerThreadId };
    return this.session;
  }
  readThreadEvents(_sessionId: string, threadId: string) {
    return this.persistedThreadId && this.persistedThreadId !== threadId
      ? []
      : this.persistedThreadEvents;
  }
  appendThreadEvent(_sessionId: string, _threadId: string, event: Record<string, unknown>) {
    if (this.failThreadEvents) throw new Error('thread persistence failed');
    this.threadEvents.push(event);
    this.persistedThreadEvents.push(event);
  }
  hostFullTakeover(_hostId: string) { return this.fullTakeover; }
  setHostFullTakeover(_hostId: string, enabled: boolean) { this.fullTakeover = enabled; }
  readTerminalHistory() { return 'tester@host:~$ '; }
  readTerminalHistorySince(
    _sessionId: string,
    cursor: { version: 1; position: number } | undefined,
    maxCharacters = 120_000,
  ) {
    const history = this.readTerminalHistory();
    const start = cursor?.position ?? Math.max(0, history.length - maxCharacters);
    return {
      content: history.slice(start).slice(-maxCharacters),
      nextCursor: { version: 1 as const, position: history.length },
      truncated: start > 0 && cursor === undefined,
    };
  }
  currentTerminalHistoryCursor() {
    return { version: 1 as const, position: this.readTerminalHistory().length };
  }
  appendAudit(
    _sessionId: string,
    type: string,
    _actor?: string,
    details?: Record<string, unknown>,
  ) {
    if (this.failAuditTypes.has(type)) throw new Error(`audit failed: ${type}`);
    this.audits.push({ type, details });
  }
}

class FakeCodexAppServer {
  readonly turns: RunCodexTurnInput[] = [];

  getState() {
    return {
      agentAvailable: true,
      agentReason: 'ready',
      terminalContextAccess: {
        available: true,
        enabled: true,
        acceptedClientTools: ['terminal_state', 'terminal_read'],
        reason: 'allowed',
      },
      terminalAgentEnabled: true,
      terminalAgentReason: 'ready',
      selection: { modelId: 'gpt-codex', reasoningEffort: 'high' },
    };
  }

  async runTerminalAgentTurn(input: RunCodexTurnInput) {
    this.turns.push(input);
    input.onThreadBound?.('provider-thread-1');
    const history = await input.tools.readTerminal({ maxChars: 500 });
    const finalText = history.includes('tester@host') ? 'history-ok' : 'history-missing';
    input.onDelta?.(finalText);
    return {
      threadId: 'provider-thread-1',
      turnId: 'provider-turn-1',
      status: 'completed' as const,
      finalText,
    };
  }
}

class DeferredStreamingCodexAppServer {
  input?: RunCodexTurnInput;
  interruptRequested = false;
  private resolveTurn?: (value: {
    threadId: string;
    turnId: string;
    status: 'completed' | 'interrupted';
    finalText: string;
  }) => void;
  private resolveInterrupt?: () => void;

  getState() {
    return {
      agentAvailable: true,
      agentReason: 'ready',
      terminalContextAccess: {
        available: true,
        enabled: true,
        acceptedClientTools: ['terminal_state', 'terminal_read'],
        reason: 'allowed',
      },
      terminalAgentEnabled: true,
      terminalAgentReason: 'ready',
      selection: { modelId: 'gpt-codex', reasoningEffort: 'high' },
    };
  }

  runTerminalAgentTurn(input: RunCodexTurnInput) {
    this.input = input;
    input.onThreadBound?.('provider-thread-stream');
    return new Promise<{
      threadId: string;
      turnId: string;
      status: 'completed' | 'interrupted';
      finalText: string;
    }>((resolve) => {
      this.resolveTurn = resolve;
    });
  }

  push(delta: string): void {
    if (!this.input) throw new Error('Codex turn has not started.');
    this.input.onDelta?.(delta);
  }

  finish(finalText: string): void {
    if (!this.resolveTurn) throw new Error('Codex turn has not started.');
    this.resolveTurn({
      threadId: 'provider-thread-stream',
      turnId: 'provider-turn-stream',
      status: 'completed',
      finalText,
    });
  }

  interruptTerminalAgentTurn(): Promise<void> {
    this.interruptRequested = true;
    return new Promise<void>((resolve) => { this.resolveInterrupt = resolve; });
  }

  finishInterrupt(): void {
    this.resolveTurn?.({
      threadId: 'provider-thread-stream',
      turnId: 'provider-turn-stream',
      status: 'interrupted',
      finalText: '',
    });
    this.resolveInterrupt?.();
    this.resolveInterrupt = undefined;
  }
}

class RejectingInterruptCodexAppServer extends DeferredStreamingCodexAppServer {
  override interruptTerminalAgentTurn(): Promise<void> {
    this.interruptRequested = true;
    return Promise.reject(new Error('interrupt rejected; connection quarantined'));
  }
}

type ExecutionBehavior = (
  started: CommandExecution,
  hooks: StructuredExecutionHooks,
) => Promise<CommandExecution>;

class FakeTerminals {
  readonly executions: Array<{ command: string; actor: CommandActor }> = [];
  readonly controlModes: TerminalInputMode[] = [];
  interruptCount = 0;
  keepCount = 0;
  sensitiveBeginCount = 0;
  sensitiveEndCount = 0;
  rearmCount = 0;
  sensitiveSubmitted = false;
  current?: CommandExecution;
  private executionIndex = 0;
  private connected = true;
  private controlLease?: string;
  private sensitiveLease?: string;
  private exitListener?: (terminalId: string, ownerId: number) => void;
  private sensitiveSubmissionListener?: (
    terminalId: string,
    ownerId: number,
    executionId: string,
    leaseId: string,
  ) => void;

  constructor(private readonly behavior?: ExecutionBehavior) {}

  onExit(listener: (terminalId: string, ownerId: number) => void) {
    this.exitListener = listener;
    return () => { this.exitListener = undefined; };
  }
  exit(terminalId = 'terminal', ownerId = 99): void {
    this.connected = false;
    this.exitListener?.(terminalId, ownerId);
  }
  onSensitiveSubmission(listener: (
    terminalId: string,
    ownerId: number,
    executionId: string,
    leaseId: string,
  ) => void) {
    this.sensitiveSubmissionListener = listener;
    return () => { this.sensitiveSubmissionListener = undefined; };
  }
  state() {
    return {
      transport: 'ssh',
      shellKind: 'posix',
      status: this.connected ? 'connected' : 'exited',
    };
  }
  descriptor(owner: WebContents, terminalId: string) {
    if (owner.id !== 99 || terminalId !== 'terminal') throw new Error('Terminal not found.');
    return {
      id: 'terminal',
      title: 'Test',
      profileId: 'ssh:host',
      shellKind: 'posix' as const,
      transport: 'ssh' as const,
      hostId: 'host',
      sessionId: '11111111-1111-1111-1111-111111111111',
    };
  }
  currentExecution() { return this.current ? { ...this.current } : undefined; }
  acquireAgentControl() {
    if (this.controlLease) throw new Error('already leased');
    this.controlLease = 'control-lease';
    this.controlModes.push('locked');
    return this.controlLease;
  }
  setAgentControlMode(
    _owner: WebContents,
    _terminalId: string,
    leaseId: string,
    mode: Exclude<TerminalInputMode, 'human'>,
  ) {
    if (leaseId !== this.controlLease) throw new Error('stale control lease');
    this.controlModes.push(mode);
  }
  releaseAgentControl(_owner: WebContents, _terminalId: string, leaseId: string) {
    if (leaseId !== this.controlLease) return false;
    this.controlLease = undefined;
    this.controlModes.push('human');
    return true;
  }
  hasControlLease(): boolean { return Boolean(this.controlLease); }
  beginSensitiveMode() {
    this.sensitiveBeginCount += 1;
    this.sensitiveLease = 'sensitive-lease';
    return this.sensitiveLease;
  }
  endSensitiveMode(_owner: WebContents, _terminalId: string, leaseId: string) {
    if (leaseId !== this.sensitiveLease) return false;
    this.sensitiveLease = undefined;
    this.sensitiveEndCount += 1;
    return true;
  }
  rearmAuthPrompt() { this.rearmCount += 1; }
  consumeSensitiveSubmission() {
    if (!this.sensitiveSubmitted) return false;
    this.sensitiveSubmitted = false;
    return true;
  }
  hasSensitiveSubmission() { return this.sensitiveSubmitted; }
  submitSensitive() {
    if (!this.current || !this.sensitiveLease) throw new Error('no sensitive interaction');
    this.rearmCount += 1;
    this.sensitiveSubmitted = true;
    this.sensitiveSubmissionListener?.(
      this.current.terminalId,
      99,
      this.current.id,
      this.sensitiveLease,
    );
  }
  keepExecution(_owner: WebContents, _terminalId: string, executionId: string) {
    if (this.current?.id !== executionId) return false;
    this.keepCount += 1;
    return true;
  }
  interruptExecution(_owner: WebContents, _terminalId: string, executionId: string) {
    if (this.current?.id !== executionId) return undefined;
    this.interruptCount += 1;
    this.current = { ...this.current, interruptRequestedAt: new Date(1).toISOString() };
    return { ...this.current };
  }
  confirmShellReady(_owner: WebContents, _terminalId: string, executionId: string) {
    if (this.current?.id !== executionId || !this.current.interruptRequestedAt) return undefined;
    const settled = { ...this.current, status: 'cancelled' as const };
    this.current = undefined;
    return settled;
  }

  async executeStructured(
    _owner: WebContents,
    terminalId: string,
    command: string,
    actor: CommandActor,
    hooks: StructuredExecutionHooks = {},
  ): Promise<CommandExecution> {
    this.executions.push({ command, actor });
    this.executionIndex += 1;
    const started: CommandExecution = {
      id: `execution-${this.executionIndex}`,
      sessionId: '11111111-1111-1111-1111-111111111111',
      terminalId,
      actor,
      command,
      requestedAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      status: 'running',
      output: '',
    };
    this.current = started;
    hooks.onStarted?.(started);
    const completed = this.behavior
      ? await this.behavior(started, hooks)
      : {
        ...started,
        status: 'completed' as const,
        exitCode: 0,
        output: 'tester\n',
        endedAt: new Date(1).toISOString(),
        durationMs: 1,
      };
    this.current = undefined;
    return completed;
  }
}

function readyProviderProfile(
  id = 'provider',
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id,
    name: id === 'provider' ? 'Provider' : id,
    kind: 'generic-openai-compatible',
    baseUrl: `https://${id}.example/v1`,
    modelId: 'model',
    recipientRevision: `recipient-${id}`,
    apiKeyConfigured: true,
    isDefault: true,
    status: 'ready',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function recipientFingerprint(profile = readyProviderProfile()): string {
  return createHash('sha256').update(JSON.stringify([
    profile.id,
    profile.kind,
    profile.baseUrl,
    profile.modelId,
    profile.recipientRevision,
  ])).digest('hex');
}

function providerStore(): ProviderStore {
  const profile = readyProviderProfile();
  return {
    get: () => profile,
    list: () => [profile],
  } as unknown as ProviderStore;
}

function browserOwner(): WebContents {
  return {
    id: 99,
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

function toolCall(id: string, command: string): ScriptedCompletion {
  return {
    message: {
      role: 'assistant',
      content: null,
      toolCalls: [{
        id,
        name: 'terminal_execute',
        arguments: JSON.stringify({ command }),
      }],
    },
  };
}

function activityCall(
  id: string,
  name: string,
  argumentsValue: Record<string, unknown> | string = {},
): AgentToolCall {
  return {
    id,
    name,
    arguments: typeof argumentsValue === 'string'
      ? argumentsValue
      : JSON.stringify(argumentsValue),
  };
}

async function startActivityHarness(prompt = 'Inspect the workspace.') {
  const backend = new DeferredActivityBackend();
  const terminals = new FakeTerminals();
  const sessions = new FakeSessions();
  const owner = browserOwner();
  const service = new AgentService(
    terminals as unknown as TerminalService,
    sessions as unknown as SessionManager,
    providerStore(),
    undefined,
    undefined,
    () => backend,
  );
  const initial = service.sendPrompt(owner, { terminalId: 'terminal', prompt });
  await waitFor(() => backend.sendInputs.length === 1);
  return { backend, initial, owner, service, sessions, terminals };
}

describe('AgentService shared-terminal controls', () => {
  it('does not let a stale create resolution replace the backend selected after takeover', async () => {
    const backendA = new DeferredCreateBackend();
    const backendB = new DeferredCreateBackend();
    const remainingBackends: AgentBackend[] = [backendA, backendB];
    const backendFactory = vi.fn(() => {
      const backend = remainingBackends.shift();
      if (!backend) throw new Error('No replacement backend remains.');
      return backend;
    });
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      backendFactory,
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'First turn.' });
    await waitFor(() => backendA.createInputs.length === 1);
    service.takeover(owner, { terminalId: 'terminal' });
    expect(terminals.hasControlLease()).toBe(false);

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Replacement turn.' });
    await waitFor(() => backendB.createInputs.length === 1);
    backendA.resolveCreate();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(backendA.sendInputs).toEqual([]);
    expect(backendB.sendInputs).toEqual([]);
    expect(service.getState(owner, 'terminal')?.state).toBe('THINKING');

    backendB.resolveCreate();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(backendB.sendInputs).toHaveLength(1);
    expect(backendB.sendInputs[0].prompt).toBe('Replacement turn.');
    expect(service.getState(owner, 'terminal')).toMatchObject({
      state: 'COMPLETED',
      terminalInputMode: 'human',
      error: undefined,
    });
    expect(terminals.hasControlLease()).toBe(false);
    service.close();
  });

  it('does not let a stale create rejection clear the replacement backend or lease', async () => {
    const backendA = new DeferredCreateBackend();
    const backendB = new DeferredCreateBackend();
    const remainingBackends: AgentBackend[] = [backendA, backendB];
    const backendFactory = vi.fn(() => {
      const backend = remainingBackends.shift();
      if (!backend) throw new Error('No replacement backend remains.');
      return backend;
    });
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      backendFactory,
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'First turn.' });
    await waitFor(() => backendA.createInputs.length === 1);
    service.takeover(owner, { terminalId: 'terminal' });
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Replacement turn.' });
    await waitFor(() => backendB.createInputs.length === 1);

    backendA.rejectCreate(new Error('stale create rejected'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getState(owner, 'terminal')).toMatchObject({
      state: 'THINKING',
      error: undefined,
    });

    backendB.resolveCreate();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(backendB.sendInputs).toHaveLength(1);
    expect(service.getState(owner, 'terminal')).toMatchObject({
      state: 'COMPLETED',
      terminalInputMode: 'human',
      error: undefined,
    });
    expect(terminals.hasControlLease()).toBe(false);

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Reuse replacement backend.' });
    await waitFor(() => backendB.sendInputs.length === 2);
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(backendB.createInputs).toHaveLength(1);
    expect(terminals.hasControlLease()).toBe(false);
    service.close();
  });

  it.each(['takeover', 'close'] as const)(
    'finishes cleanup when backend interrupt throws synchronously during %s',
    async (action) => {
      const backend = new ThrowingInterruptActivityBackend();
      const terminals = new FakeTerminals();
      const owner = browserOwner();
      const service = new AgentService(
        terminals as unknown as TerminalService,
        new FakeSessions() as unknown as SessionManager,
        providerStore(),
        undefined,
        undefined,
        () => backend,
      );
      service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Long tool turn.' });
      await waitFor(() => backend.sendInputs.length === 1);
      backend.emit({
        type: 'tool_started',
        toolCall: activityCall('interrupt-activity', 'workspace_stat', { path: 'src/index.ts' }),
      });
      const runtime = (service as unknown as {
        runtimes: Map<string, { activities: AgentSessionView['activities'] }>;
      }).runtimes.get('terminal')!;
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      if (action === 'takeover') {
        expect(() => service.takeover(owner, { terminalId: 'terminal' })).not.toThrow();
      } else {
        expect(() => service.close()).not.toThrow();
      }

      expect(runtime.activities).toEqual([
        expect.objectContaining({
          id: 'interrupt-activity',
          status: 'cancelled',
          finishedAt: expect.any(String),
        }),
      ]);
      expect(terminals.hasControlLease()).toBe(false);
      expect(terminals.controlModes.at(-1)).toBe('human');
      expect(backend.interrupts).toContainEqual({
        threadId: expect.any(String),
        reason: action === 'takeover' ? 'takeover' : 'shutdown',
      });
      expect(errorLog).toHaveBeenCalledWith(
        'Unable to interrupt Generic Harness backend:',
        expect.objectContaining({ message: 'synchronous backend interrupt failure' }),
      );

      backend.finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (action === 'takeover') {
        expect(service.getState(owner, 'terminal')).toMatchObject({
          state: 'PAUSED',
          terminalInputMode: 'human',
        });
        service.close();
      }
      errorLog.mockRestore();
    },
  );

  it.each(['resolved', 'rejected'] as const)(
    'ignores backend events emitted after sendMessage has %s',
    async (outcome) => {
      const { backend, owner, service, sessions } = await startActivityHarness();
      if (outcome === 'resolved') backend.finish();
      else backend.fail(new Error('expected backend rejection'));
      await waitFor(() => service.getState(owner, 'terminal')?.state === (
        outcome === 'resolved' ? 'COMPLETED' : 'FAILED'
      ));

      const staleOnEvent = backend.sendInputs[0].onEvent;
      expect(staleOnEvent).toBeTypeOf('function');
      const before = service.getState(owner, 'terminal')!;
      const threadEventCount = sessions.threadEvents.length;
      const auditCount = sessions.audits.length;
      const sendCount = vi.mocked(owner.send).mock.calls.length;
      const staleSecret = `STALE_EVENT_SECRET_${outcome}`;
      const staleCall = activityCall('stale-tool', 'workspace_write_file', {
        path: 'src/stale.ts',
        content: staleSecret,
        expectedSha256: null,
      });

      staleOnEvent?.({ type: 'tool_started', toolCall: staleCall });
      staleOnEvent?.({
        type: 'tool_completed',
        toolCall: staleCall,
        result: JSON.stringify({
          ok: true,
          path: `src/${staleSecret}.ts`,
          sha256: 'a'.repeat(64),
          bytes: 12,
        }),
      });
      staleOnEvent?.({ type: 'assistant_delta', text: staleSecret });
      staleOnEvent?.({ type: 'assistant_text', text: staleSecret });
      await new Promise((resolve) => setTimeout(resolve, 80));

      const after = service.getState(owner, 'terminal')!;
      expect(after.revision).toBe(before.revision);
      expect(after.activities).toEqual(before.activities);
      expect(after.messages).toEqual(before.messages);
      expect(after.streamingMessageId).toBe(before.streamingMessageId);
      expect(sessions.threadEvents).toHaveLength(threadEventCount);
      expect(sessions.audits).toHaveLength(auditCount);
      expect(vi.mocked(owner.send).mock.calls).toHaveLength(sendCount);
      expect(JSON.stringify({ after, events: sessions.threadEvents, audits: sessions.audits }))
        .not.toContain(staleSecret);
      service.close();
    },
  );

  it('projects tool start and completion into a succeeded activity summary', async () => {
    const { backend, owner, service } = await startActivityHarness();
    const call = activityCall('search-1', 'workspace_search', {
      path: 'src',
      query: 'private query',
    });

    backend.emit({ type: 'tool_started', toolCall: call });
    expect(service.getState(owner, 'terminal')?.activities).toEqual([
      expect.objectContaining({
        id: 'search-1',
        toolName: 'workspace_search',
        kind: 'workspace',
        label: 'Search workspace src',
        status: 'running',
      }),
    ]);

    backend.emit({
      type: 'tool_completed',
      toolCall: call,
      result: JSON.stringify({
        ok: true,
        matches: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
        filesScanned: 7,
      }),
    });
    expect(service.getState(owner, 'terminal')?.activities).toEqual([
      expect.objectContaining({
        id: 'search-1',
        status: 'succeeded',
        summary: '2 matches · 7 files',
        finishedAt: expect.any(String),
      }),
    ]);

    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    service.close();
  });

  it('publishes context compression progress and records a metadata-only audit', async () => {
    const backend = new DeferredActivityBackend();
    const sessions = new FakeSessions();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => backend,
    );
    const owner = browserOwner();
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Compress when needed.' });
    await waitFor(() => backend.sendInputs.length === 1);

    backend.emit({
      type: 'context_status',
      contextUsage: {
        estimatedTokens: 54_400,
        contextWindowTokens: 64_000,
        compressionThresholdTokens: 54_400,
        percentage: 100,
        status: 'compressing',
      },
    });
    expect(service.getState(owner, 'terminal')?.contextUsage).toMatchObject({
      percentage: 100,
      status: 'compressing',
    });

    backend.emit({
      type: 'context_status',
      contextUsage: {
        estimatedTokens: 8_000,
        contextWindowTokens: 64_000,
        compressionThresholdTokens: 54_400,
        percentage: 15,
        status: 'ready',
        lastCompressedAt: '2026-08-20T00:00:00.000Z',
      },
      compression: { beforeTokens: 54_400, afterTokens: 8_000 },
    });
    expect(service.getState(owner, 'terminal')?.contextUsage).toMatchObject({
      percentage: 15,
      status: 'ready',
    });
    expect(sessions.audits.filter(({ type }) => type === 'context_compressed')).toEqual([
      expect.objectContaining({
        details: expect.objectContaining({ beforeTokens: 54_400, afterTokens: 8_000 }),
      }),
    ]);
    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    service.close();
  });

  it('settles a running activity as failed when the backend rejects', async () => {
    const { backend, owner, service } = await startActivityHarness();
    backend.emit({
      type: 'tool_started',
      toolCall: activityCall('stat-1', 'workspace_stat', { path: 'src/index.ts' }),
    });

    backend.fail(new Error('backend failed after tool start'));
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'FAILED');

    expect(service.getState(owner, 'terminal')?.activities).toEqual([
      expect.objectContaining({
        id: 'stat-1',
        status: 'failed',
        finishedAt: expect.any(String),
      }),
    ]);
    service.close();
  });

  it.each(['user stop', 'takeover', 'terminal exit'] as const)(
    'settles a running activity as cancelled on %s',
    async (action) => {
      const { backend, initial, owner, service, terminals } = await startActivityHarness();
      backend.emit({
        type: 'tool_started',
        toolCall: activityCall('read-1', 'workspace_read_file', { path: 'src/index.ts' }),
      });

      if (action === 'user stop') {
        service.interruptTurn(owner, {
          terminalId: 'terminal',
          messageId: initial.messages.at(-1)!.id,
        });
      } else if (action === 'takeover') {
        service.takeover(owner, { terminalId: 'terminal' });
      } else {
        terminals.exit();
      }

      expect(service.getState(owner, 'terminal')?.activities).toEqual([
        expect.objectContaining({
          id: 'read-1',
          status: 'cancelled',
          finishedAt: expect.any(String),
        }),
      ]);
      backend.finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(service.getState(owner, 'terminal')?.activities[0]?.status).toBe('cancelled');
      service.close();
    },
  );

  it('keeps only the 24 most recently started tool activities', async () => {
    const { backend, owner, service } = await startActivityHarness();
    for (let index = 0; index < 30; index += 1) {
      backend.emit({
        type: 'tool_started',
        toolCall: activityCall(`activity-${index}`, 'workspace_stat', {
          path: `src/file-${index}.ts`,
        }),
      });
    }

    const activities = service.getState(owner, 'terminal')!.activities;
    expect(activities).toHaveLength(24);
    expect(activities[0]?.id).toBe('activity-6');
    expect(activities.at(-1)?.id).toBe('activity-29');

    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    service.close();
  });

  it('does not share activity arrays or objects across returned and emitted views', async () => {
    const { backend, owner, service } = await startActivityHarness();
    backend.emit({
      type: 'tool_started',
      toolCall: activityCall('clone-1', 'workspace_stat', { path: 'src/index.ts' }),
    });

    const returned = service.getState(owner, 'terminal')!;
    returned.activities[0]!.label = 'tampered returned label';
    returned.activities.length = 0;
    expect(service.getState(owner, 'terminal')?.activities).toEqual([
      expect.objectContaining({ id: 'clone-1', label: 'Stat src/index.ts', status: 'running' }),
    ]);

    const send = vi.mocked(owner.send);
    const emitted = send.mock.calls.at(-1)?.[1] as AgentSessionView;
    emitted.activities[0]!.label = 'tampered emitted label';
    emitted.activities.length = 0;
    expect(service.getState(owner, 'terminal')?.activities).toEqual([
      expect.objectContaining({ id: 'clone-1', label: 'Stat src/index.ts', status: 'running' }),
    ]);

    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    service.close();
  });

  it('clears the previous activity list when a second turn starts', async () => {
    const { backend, owner, service } = await startActivityHarness('First turn.');
    const call = activityCall('first-turn', 'workspace_glob', {
      path: 'src',
      pattern: '**/*.ts',
    });
    backend.emit({ type: 'tool_started', toolCall: call });
    backend.emit({
      type: 'tool_completed',
      toolCall: call,
      result: JSON.stringify({ ok: true, paths: ['src/index.ts'] }),
    });
    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(service.getState(owner, 'terminal')?.activities).toHaveLength(1);

    const second = service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Second turn.' });
    expect(second.activities).toEqual([]);
    expect(service.getState(owner, 'terminal')?.activities).toEqual([]);
    await waitFor(() => backend.sendInputs.length === 2);
    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    service.close();
  });

  it('keeps 3 MiB tool secrets out of activities and activity persistence', async () => {
    const { backend, owner, service, sessions } = await startActivityHarness();
    const argumentSecret = 'ARGUMENT_SECRET_17f2b9';
    const resultSecret = 'RESULT_SECRET_42ac71';
    const errorSecret = 'ERROR_SECRET_b7e631';
    const hugeArguments = JSON.stringify({
      query: `${argumentSecret}\u0000\u001b${'A'.repeat(3 * 1024 * 1024)}`,
      path: 'src',
    });
    const hugeResult = JSON.stringify({
      ok: false,
      error: `${resultSecret}\u0000\u001b${errorSecret}${'R'.repeat(3 * 1024 * 1024)}`,
    });
    const call = activityCall('hostile-1', 'workspace_search', hugeArguments);
    const threadEventCount = sessions.threadEvents.length;
    const auditCount = sessions.audits.length;

    backend.emit({ type: 'tool_started', toolCall: call });
    backend.emit({ type: 'tool_completed', toolCall: call, result: hugeResult });

    const activities = service.getState(owner, 'terminal')!.activities;
    const serialized = JSON.stringify(activities);
    expect(activities).toEqual([
      expect.objectContaining({ id: 'hostile-1', status: 'failed' }),
    ]);
    expect(serialized.length).toBeLessThan(1_000);
    for (const secret of [argumentSecret, resultSecret, errorSecret]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('\\u0000');
    expect(serialized).not.toContain('\\u001b');
    expect(sessions.threadEvents).toHaveLength(threadEventCount);
    expect(sessions.audits).toHaveLength(auditCount);

    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(JSON.stringify(sessions.threadEvents)).not.toContain('"activities"');
    expect(JSON.stringify(sessions.audits)).not.toContain('"activities"');
    expect(sessions.threadEvents.some(({ type }) => String(type).includes('activity'))).toBe(false);
    expect(sessions.audits.some(({ type }) => type.includes('activity'))).toBe(false);
    service.close();
  });

  it('does not persist a malicious workspace mutation result outside bounded activity state', async () => {
    const { backend, owner, service, sessions } = await startActivityHarness();
    const auditSecret = 'OVERSIZED_AUDIT_SECRET_f80d61';
    const call = activityCall('oversized-patch', 'workspace_apply_patch', {
      path: 'src/index.ts',
      expectedSha256: 'a'.repeat(64),
      patches: [],
    });
    const oversizedResult = JSON.stringify({
      ok: true,
      path: `${auditSecret}${'P'.repeat(2 * 1024 * 1024 + 1)}`,
      sha256: 'b'.repeat(64),
      bytes: 12,
    });

    backend.emit({ type: 'tool_started', toolCall: call });
    backend.emit({ type: 'tool_completed', toolCall: call, result: oversizedResult });
    backend.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(sessions.audits.filter(({ type }) => type === 'file_modified')).toEqual([]);
    expect(JSON.stringify(service.getState(owner, 'terminal')?.activities)).not.toContain(auditSecret);
    expect(JSON.stringify(sessions.threadEvents)).not.toContain('"activities"');
    expect(JSON.stringify(sessions.audits)).not.toContain(auditSecret);
    service.close();
  });

  it('creates one Generic backend thread, reuses its history, and injects a fresh gateway per turn', async () => {
    const backend = new RecordingBackend();
    const backendFactory = vi.fn(() => backend);
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      backendFactory,
    );
    const owner = browserOwner();

    const first = service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'First.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Second.' });
    await waitFor(() => backend.sendInputs.length === 2);
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(backendFactory).toHaveBeenCalledTimes(1);
    expect(backend.createInputs).toEqual([{ id: first.threadId }]);
    expect(backend.resumeInputs).toEqual([]);
    expect(backend.sendInputs).toHaveLength(2);
    expect(backend.sendInputs[0].thread).toBe(backend.sendInputs[1].thread);
    expect(backend.sendInputs[0].gateway).not.toBe(backend.sendInputs[1].gateway);
    expect(backend.sendInputs.map(({ gateway }) => gateway.context)).toEqual([
      expect.objectContaining({
        sessionId: '11111111-1111-1111-1111-111111111111',
        terminal: expect.objectContaining({ terminalId: 'terminal', type: 'ssh' }),
      }),
      expect.objectContaining({
        sessionId: '11111111-1111-1111-1111-111111111111',
        terminal: expect.objectContaining({ terminalId: 'terminal', type: 'ssh' }),
      }),
    ]);
    expect(backend.priorMessagesAtSend[0]).toEqual([]);
    expect(backend.priorMessagesAtSend[1]).toEqual([
      { role: 'user', content: 'First.' },
      { role: 'assistant', content: 'reply:First.' },
    ]);
  });

  it('resumes a Generic backend thread from the latest persisted turn', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      providerId: 'provider',
      agentBackend: { kind: 'generic-provider', providerId: 'provider' },
      agentBackendFingerprint: recipientFingerprint(),
      aiThreadId: 'persisted-thread',
    };
    const persistedMessages: AgentMessage[] = [
      { role: 'user', content: 'Persisted prompt.' },
      { role: 'assistant', content: 'Persisted answer.' },
    ];
    sessions.persistedThreadEvents = [{
      type: 'turn',
      id: 'persisted-turn',
      messages: persistedMessages,
    }];
    const backend = new RecordingBackend();
    const backendFactory = vi.fn(() => backend);
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      backendFactory,
    );

    service.sendPrompt(browserOwner(), { terminalId: 'terminal', prompt: 'Continue.' });
    await waitFor(() => backend.sendInputs.length === 1);

    expect(backendFactory).toHaveBeenCalledTimes(1);
    expect(backend.createInputs).toEqual([]);
    expect(backend.resumeInputs).toEqual([{
      id: 'persisted-thread',
      priorMessages: persistedMessages,
    }]);
    expect(backend.priorMessagesAtSend[0]).toEqual(persistedMessages);
  });

  it('replays bounded context checkpoints plus later deltas without duplicating full turns', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      providerId: 'provider',
      agentBackend: { kind: 'generic-provider', providerId: 'provider' },
      agentBackendFingerprint: recipientFingerprint(),
      aiThreadId: 'persisted-thread',
    };
    const checkpoint: AgentMessage[] = [
      { role: 'assistant', content: '[Glass Terminal automatic context summary]\nEarlier work.' },
      { role: 'user', content: 'First retained prompt.' },
      { role: 'assistant', content: 'First retained answer.' },
    ];
    const delta: AgentMessage[] = [
      { role: 'user', content: 'Second prompt.' },
      { role: 'assistant', content: 'Second answer.' },
    ];
    sessions.persistedThreadEvents = [
      { type: 'turn', contextMode: 'checkpoint', messages: checkpoint },
      { type: 'turn', contextMode: 'delta', messages: delta },
    ];
    const backend = new RecordingBackend();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => backend,
    );

    service.sendPrompt(browserOwner(), { terminalId: 'terminal', prompt: 'Continue.' });
    await waitFor(() => backend.sendInputs.length === 1);

    expect(backend.resumeInputs[0]?.priorMessages).toEqual([...checkpoint, ...delta]);
    service.close();
  });

  it('discards a Generic backend thread after replacing persisted conversation history', async () => {
    const backends: RecordingBackend[] = [];
    const backendFactory = vi.fn(() => {
      const backend = new RecordingBackend();
      backends.push(backend);
      return backend;
    });
    const owner = browserOwner();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      backendFactory,
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Keep.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Replace me.' });
    await waitFor(() => backends[0]?.sendInputs.length === 2);
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const targetMessageId = [...service.getState(owner, 'terminal')!.messages]
      .reverse().find((message) => message.role === 'user')!.id;

    service.revisePrompt(owner, {
      terminalId: 'terminal',
      messageId: targetMessageId,
      action: 'replace',
      prompt: 'Replacement.',
    });
    await waitFor(() => backends.length === 2 && backends[1].sendInputs.length === 1);

    expect(backendFactory).toHaveBeenCalledTimes(2);
    expect(backends[0].sendInputs).toHaveLength(2);
    expect(backends[1].createInputs).toEqual([]);
    expect(backends[1].resumeInputs).toHaveLength(1);
    expect(backends[1].resumeInputs[0].priorMessages).toEqual([
      { role: 'user', content: 'Keep.' },
      { role: 'assistant', content: 'reply:Keep.' },
    ]);
  });

  it('forwards user stop, takeover, and shutdown interrupts to the active Generic thread', async () => {
    const start = async () => {
      const backend = new DeferredRecordingBackend();
      const owner = browserOwner();
      const service = new AgentService(
        new FakeTerminals() as unknown as TerminalService,
        new FakeSessions() as unknown as SessionManager,
        providerStore(),
        undefined,
        undefined,
        () => backend,
      );
      const running = service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Wait.' });
      await waitFor(() => backend.sendInputs.length === 1);
      return { backend, owner, running, service };
    };

    const stopped = await start();
    const messageId = stopped.running.messages.find((message) => message.role === 'user')!.id;
    stopped.service.interruptTurn(stopped.owner, { terminalId: 'terminal', messageId });
    expect(stopped.backend.interrupts).toEqual([{
      threadId: stopped.running.threadId,
      reason: 'user',
    }]);
    expect(stopped.backend.sendInputs[0].signal.aborted).toBe(true);
    stopped.backend.finish();

    const takenOver = await start();
    takenOver.service.takeover(takenOver.owner, { terminalId: 'terminal' });
    expect(takenOver.backend.interrupts).toEqual([{
      threadId: takenOver.running.threadId,
      reason: 'takeover',
    }]);
    expect(takenOver.backend.sendInputs[0].signal.aborted).toBe(true);
    takenOver.backend.finish();

    const closed = await start();
    closed.service.close();
    expect(closed.backend.interrupts).toEqual([{
      threadId: closed.running.threadId,
      reason: 'shutdown',
    }]);
    expect(closed.backend.sendInputs[0].signal.aborted).toBe(true);
    closed.backend.finish();
  });

  it('never constructs a Generic backend for a native Codex turn', async () => {
    const genericBackendFactory = vi.fn((_providerId: string): AgentBackend => {
      throw new Error('Generic backend must not be constructed.');
    });
    const codex = new FakeCodexAppServer();
    const owner = browserOwner();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
      undefined,
      genericBackendFactory,
    );

    service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Use native Codex.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(genericBackendFactory).not.toHaveBeenCalled();
  });

  it('allows Workspace changes without a runtime and enforces runtime ownership', async () => {
    const terminals = new FakeTerminals();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
    );
    const owner = browserOwner();

    expect(() => service.assertWorkspaceChangeAllowed(owner, 'terminal')).not.toThrow();
    await service.setFileAccess(owner, {
      terminalId: 'terminal',
      mode: 'off',
      backend: { kind: 'generic-provider', providerId: 'provider' },
    });
    expect(() => service.assertWorkspaceChangeAllowed(owner, 'terminal')).not.toThrow();
    expect(() => service.assertWorkspaceChangeAllowed({
      ...owner,
      id: 100,
    } as WebContents, 'terminal')).toThrow('Agent Session not found.');
  });

  it('rejects Workspace changes while Generic Provider file access is enabled', async () => {
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      canonicalizeAccessRoot: vi.fn(async (_owner, _terminalId, accessRoot) => accessRoot),
    } as unknown as AgentFileService;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
    );
    const owner = browserOwner();

    await service.setFileAccess(owner, {
      terminalId: 'terminal',
      mode: 'read-only',
      backend: { kind: 'generic-provider', providerId: 'provider' },
    });

    expect(() => service.assertWorkspaceChangeAllowed(owner, 'terminal'))
      .toThrow('请先关闭 Generic Provider 文件访问');
  });

  it('maps legacy file-access modes to ephemeral policies and returns isolated snapshots', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      canonicalizeAccessRoot: vi.fn(async (_owner, _terminalId, accessRoot) => accessRoot),
    } as unknown as AgentFileService;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;

    const readOnly = await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });
    expect(readOnly.fileAccessPolicy).toEqual({
      read: true,
      write: false,
      create: false,
      delete: false,
      readablePaths: ['/work'],
      writablePaths: [],
      fullAccess: false,
    });
    readOnly.fileAccessPolicy!.read = false;
    readOnly.fileAccessPolicy!.readablePaths[0] = '/tampered';
    expect(service.getState(owner, 'terminal')?.fileAccessPolicy).toEqual({
      read: true,
      write: false,
      create: false,
      delete: false,
      readablePaths: ['/work'],
      writablePaths: [],
      fullAccess: false,
    });

    const readWrite = await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-write', backend,
    });
    expect(readWrite.fileAccessPolicy).toEqual({
      read: true,
      write: true,
      create: true,
      delete: true,
      readablePaths: ['/work'],
      writablePaths: ['/work'],
      fullAccess: false,
    });

    const disabled = await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'off', backend,
    });
    expect(disabled).toMatchObject({
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
      fileAccessPolicy: {
        read: false,
        write: false,
        create: false,
        delete: false,
        readablePaths: [],
        writablePaths: [],
        fullAccess: false,
      },
    });
    expect(sessions.session).not.toHaveProperty('fileAccessPolicy');
  });

  it('canonicalizes, deduplicates, and preserves a granular policy snapshot', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const canonicalizeAccessRoot = vi.fn(async (
      _owner: WebContents,
      _terminalId: string,
      accessRoot: string,
    ) => accessRoot.startsWith('/read-') ? '/canonical-read' : '/canonical-create');
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      canonicalizeAccessRoot,
    } as unknown as AgentFileService;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
    );

    const view = await service.setFileAccess(browserOwner(), {
      terminalId: 'terminal',
      mode: 'read-write',
      backend: { kind: 'generic-provider', providerId: 'provider' },
      policy: {
        read: true,
        write: false,
        create: true,
        delete: false,
        readablePaths: ['/read-alias', '/read-duplicate'],
        writablePaths: ['/create-alias'],
        fullAccess: false,
      },
    });

    expect(view.fileAccessPolicy).toEqual({
      read: true,
      write: false,
      create: true,
      delete: false,
      readablePaths: ['/canonical-read'],
      writablePaths: ['/canonical-create'],
      fullAccess: false,
    });
    expect(canonicalizeAccessRoot).toHaveBeenCalledTimes(3);
  });

  it('requires an explicit confirmation for Full Access and still requires a Workspace Root', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const bindWorkspaceRoot = vi.fn().mockResolvedValue('/work');
    const canonicalizeAccessRoot = vi.fn(async (
      _owner: WebContents,
      _terminalId: string,
      accessRoot: string,
    ) => accessRoot);
    const fileService = { bindWorkspaceRoot, canonicalizeAccessRoot } as unknown as AgentFileService;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
    );
    const owner = browserOwner();
    const request = {
      terminalId: 'terminal',
      mode: 'full-access' as const,
      backend: { kind: 'generic-provider', providerId: 'provider' } as const,
    };

    await expect(service.setFileAccess(owner, request)).rejects.toThrow('显式确认');
    expect(bindWorkspaceRoot).not.toHaveBeenCalled();

    const view = await service.setFileAccess(owner, {
      ...request,
      fullAccessConfirmed: true,
    });
    expect(view.fileAccessPolicy).toEqual({
      read: true,
      write: true,
      create: true,
      delete: true,
      readablePaths: [],
      writablePaths: [],
      fullAccess: true,
    });
    expect(canonicalizeAccessRoot).not.toHaveBeenCalled();

    const missingWorkspaceService = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      undefined,
      {
        bindWorkspaceRoot: vi.fn().mockRejectedValue(new Error('请先设置 Workspace Root。')),
      } as unknown as AgentFileService,
    );
    await expect(missingWorkspaceService.setFileAccess(browserOwner(), {
      ...request,
      fullAccessConfirmed: true,
    })).rejects.toThrow('请先设置 Workspace Root');
  });

  it('rejects stale and asynchronously changed Workspace roots without granting access', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    let resolveCanonical: ((path: string) => void) | undefined;
    const canonicalizeAccessRoot = vi.fn(() => new Promise<string>((resolve) => {
      resolveCanonical = resolve;
    }));
    const bindWorkspaceRoot = vi.fn().mockResolvedValue('/work');
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      { bindWorkspaceRoot, canonicalizeAccessRoot } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;

    await expect(service.setFileAccess(owner, {
      terminalId: 'terminal',
      mode: 'read-only',
      backend,
      expectedWorkspaceRoot: '/stale-work',
    })).rejects.toThrow('Workspace Root 已变化');
    expect(bindWorkspaceRoot).not.toHaveBeenCalled();

    const pending = service.setFileAccess(owner, {
      terminalId: 'terminal',
      mode: 'read-only',
      backend,
      expectedWorkspaceRoot: '/work',
      policy: {
        read: true,
        write: false,
        create: false,
        delete: false,
        readablePaths: ['/scope'],
        writablePaths: [],
        fullAccess: false,
      },
    });
    await waitFor(() => canonicalizeAccessRoot.mock.calls.length === 1);
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/replaced', hostId: 'host' },
    };
    resolveCanonical!('/scope');
    await expect(pending).rejects.toThrow('状态已变化');
    expect(service.getState(owner, 'terminal')).toMatchObject({
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
    });
    expect(sessions.audits.filter((entry) => entry.type === 'file_permission_changed'))
      .toHaveLength(0);
  });

  it('does not let an older asynchronous grant override a later explicit revoke', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    let resolveBinding: ((root: string) => void) | undefined;
    const bindWorkspaceRoot = vi.fn(() => new Promise<string>((resolve) => {
      resolveBinding = resolve;
    }));
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      { bindWorkspaceRoot } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;

    const pendingGrant = service.setFileAccess(owner, {
      terminalId: 'terminal',
      mode: 'full-access',
      backend,
      fullAccessConfirmed: true,
      expectedWorkspaceRoot: '/work',
    });
    await waitFor(() => bindWorkspaceRoot.mock.calls.length === 1);
    await service.setFileAccess(owner, { terminalId: 'terminal', mode: 'off', backend });
    resolveBinding!('/work');

    await expect(pendingGrant).rejects.toThrow('状态已变化');
    expect(service.getState(owner, 'terminal')).toMatchObject({
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
      fileAccessPolicy: { fullAccess: false, read: false, write: false },
    });
    expect(sessions.audits.some((entry) => entry.details?.mode === 'full-access')).toBe(false);
  });

  it('does not let a pending grant restore authority after terminal exit', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const terminals = new FakeTerminals();
    let resolveBinding: ((root: string) => void) | undefined;
    const bindWorkspaceRoot = vi.fn(() => new Promise<string>((resolve) => {
      resolveBinding = resolve;
    }));
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      { bindWorkspaceRoot } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const pendingGrant = service.setFileAccess(owner, {
      terminalId: 'terminal',
      mode: 'full-access',
      backend: { kind: 'generic-provider', providerId: 'provider' },
      fullAccessConfirmed: true,
    });
    await waitFor(() => bindWorkspaceRoot.mock.calls.length === 1);
    terminals.exit();
    resolveBinding!('/work');

    await expect(pendingGrant).rejects.toThrow('状态已变化');
    expect(service.getState(owner, 'terminal')).toMatchObject({
      state: 'FAILED',
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
    });
  });

  it('does not let a pending grant cross a Generic Provider runtime switch', async () => {
    const profiles = new Map([
      ['provider-a', readyProviderProfile('provider-a')],
      ['provider-b', readyProviderProfile('provider-b', { isDefault: false })],
    ]);
    const providers = {
      get: (providerId: string) => {
        const profile = profiles.get(providerId);
        if (!profile) throw new Error('Provider not found.');
        return profile;
      },
      list: () => [...profiles.values()],
    } as unknown as ProviderStore;
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    let resolveBinding: ((root: string) => void) | undefined;
    const bindWorkspaceRoot = vi.fn(() => new Promise<string>((resolve) => {
      resolveBinding = resolve;
    }));
    const backendAdapter = new RecordingBackend();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providers,
      undefined,
      { bindWorkspaceRoot } as unknown as AgentFileService,
      () => backendAdapter,
    );
    const owner = browserOwner();
    const pendingGrant = service.setFileAccess(owner, {
      terminalId: 'terminal',
      mode: 'full-access',
      backend: { kind: 'generic-provider', providerId: 'provider-a' },
      fullAccessConfirmed: true,
    });
    await waitFor(() => bindWorkspaceRoot.mock.calls.length === 1);
    service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'switch provider',
      backend: { kind: 'generic-provider', providerId: 'provider-b' },
    });
    resolveBinding!('/work');

    await expect(pendingGrant).rejects.toThrow('状态已变化');
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(service.getState(owner, 'terminal')).toMatchObject({
      backend: { kind: 'generic-provider', providerId: 'provider-b' },
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
    });
  });

  it('rejects new non-off grants after the terminal or Session disconnects', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const terminals = new FakeTerminals();
    const bindWorkspaceRoot = vi.fn().mockResolvedValue('/work');
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      { bindWorkspaceRoot } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;

    await service.setFileAccess(owner, { terminalId: 'terminal', mode: 'off', backend });
    terminals.exit();
    await expect(service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    })).rejects.toThrow('终端已断开');
    expect(bindWorkspaceRoot).not.toHaveBeenCalled();

    const sessionOnlyService = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      Object.assign(new FakeSessions(), {
        session: { ...sessions.session, connectionState: 'disconnected' },
      }) as unknown as SessionManager,
      providerStore(),
      undefined,
      { bindWorkspaceRoot } as unknown as AgentFileService,
    );
    await expect(sessionOnlyService.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    })).rejects.toThrow('终端已断开');
    expect(bindWorkspaceRoot).not.toHaveBeenCalled();
  });

  it('keeps revocation and strict downgrade fail-closed when audit persistence fails', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      {
        bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
        canonicalizeAccessRoot: vi.fn(async (
          _owner: WebContents, _terminalId: string, path: string,
        ) => path),
      } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'full-access', backend, fullAccessConfirmed: true,
    });
    sessions.failAuditTypes.add('file_permission_changed');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const downgraded = await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-write', backend,
    });
    expect(downgraded).toMatchObject({
      fileAccessMode: 'read-write',
      fileAccessPolicy: { fullAccess: false },
    });
    const revoked = await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'off', backend,
    });
    expect(revoked).toMatchObject({ fileAccessMode: 'off', fileAccessRoot: undefined });
    consoleError.mockRestore();
  });

  it('never adds authority when the upgrade audit cannot be persisted', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      {
        bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
        canonicalizeAccessRoot: vi.fn(async (
          _owner: WebContents, _terminalId: string, path: string,
        ) => path),
      } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });
    sessions.failAuditTypes.add('file_permission_changed');

    await expect(service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-write', backend,
    })).rejects.toThrow('audit failed');
    expect(service.getState(owner, 'terminal')).toMatchObject({
      fileAccessMode: 'read-only',
      fileAccessPolicy: { read: true, write: false, create: false, delete: false },
    });
  });

  it('keeps SFTP scope comparisons case-sensitive before fail-closed audit', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      {
        bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
        canonicalizeAccessRoot: vi.fn(async (
          _owner: WebContents, _terminalId: string, path: string,
        ) => path),
      } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    const policy = (path: string) => ({
      read: true,
      write: false,
      create: false,
      delete: false,
      readablePaths: [path],
      writablePaths: [],
      fullAccess: false,
    });
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend, policy: policy('/Work'),
    });
    sessions.failAuditTypes.add('file_permission_changed');

    await expect(service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend, policy: policy('/work'),
    })).rejects.toThrow('audit failed');
    expect(service.getState(owner, 'terminal')?.fileAccessPolicy?.readablePaths)
      .toEqual(['/Work']);
  });

  it('preserves a Generic thread and file grant across harmless Provider metadata updates', async () => {
    let profile = readyProviderProfile();
    const providers = {
      get: () => profile,
      list: () => [profile],
    } as unknown as ProviderStore;
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const backendAdapter = new RecordingBackend();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providers,
      undefined,
      {
        bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
        canonicalizeAccessRoot: vi.fn(async (
          _owner: WebContents, _terminalId: string, path: string,
        ) => path),
      } as unknown as AgentFileService,
      () => backendAdapter,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'first turn', backend });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const originalThreadId = service.getState(owner, 'terminal')!.threadId;
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });

    profile = {
      ...profile,
      isDefault: false,
      lastTestedAt: new Date(2).toISOString(),
      updatedAt: new Date(2).toISOString(),
    };
    expect(() => service.sendPrompt(owner, {
      terminalId: 'terminal', prompt: 'second turn', backend,
    })).not.toThrow();
    await waitFor(() => backendAdapter.sendInputs.length === 2);
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(service.getState(owner, 'terminal')).toMatchObject({
      threadId: originalThreadId,
      fileAccessMode: 'read-only',
    });
    expect(backendAdapter.priorMessagesAtSend[1]).not.toEqual([]);
  });

  it('rebuilds the Generic backend for a changed context window without losing history', async () => {
    let profile = readyProviderProfile('provider', { contextWindowTokens: 64_000 });
    const providers = {
      get: () => profile,
      list: () => [profile],
    } as unknown as ProviderStore;
    const sessions = new FakeSessions();
    const backends = [new RecordingBackend(), new RecordingBackend()];
    const factory = vi.fn(() => backends[factory.mock.calls.length - 1]!);
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providers,
      undefined,
      undefined,
      factory,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'first turn', backend });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const threadId = service.getState(owner, 'terminal')!.threadId;

    profile = { ...profile, contextWindowTokens: 128_000 };
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'second turn', backend });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(factory).toHaveBeenCalledTimes(2);
    expect(backends[1]!.resumeInputs[0]?.priorMessages).not.toEqual([]);
    expect(service.getState(owner, 'terminal')).toMatchObject({
      threadId,
      contextUsage: { contextWindowTokens: 128_000 },
    });
  });

  it('does not resume persisted Generic history when its recipient fingerprint changed offline', async () => {
    const oldProfile = readyProviderProfile('provider', {
      recipientRevision: 'old-recipient',
    });
    const currentProfile = readyProviderProfile('provider', {
      recipientRevision: 'replacement-recipient',
    });
    const providers = {
      get: () => currentProfile,
      list: () => [currentProfile],
    } as unknown as ProviderStore;
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      providerId: 'provider',
      agentBackend: { kind: 'generic-provider', providerId: 'provider' },
      agentBackendFingerprint: recipientFingerprint(oldProfile),
      aiThreadId: 'persisted-old-thread',
    };
    sessions.persistedThreadId = 'persisted-old-thread';
    sessions.persistedThreadEvents = [{
      type: 'turn',
      id: 'old-recipient-turn',
      messages: [
        { role: 'user', content: 'private old-recipient prompt' },
        { role: 'assistant', content: 'private old-recipient reply' },
      ],
    }];
    const backendAdapter = new RecordingBackend();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providers,
      undefined,
      undefined,
      () => backendAdapter,
    );

    service.sendPrompt(browserOwner(), {
      terminalId: 'terminal',
      prompt: 'new recipient turn',
      backend: { kind: 'generic-provider', providerId: 'provider' },
    });
    await waitFor(() => backendAdapter.sendInputs.length === 1);

    expect(backendAdapter.resumeInputs).toEqual([]);
    expect(backendAdapter.priorMessagesAtSend[0]).toEqual([]);
    expect(backendAdapter.sendInputs[0]!.thread.id).not.toBe('persisted-old-thread');
    expect(sessions.session.agentBackendFingerprint).toBe(recipientFingerprint(currentProfile));
  });

  it('revokes an old provider fingerprint before the same provider ID can run again', async () => {
    let profile = readyProviderProfile();
    const providers = {
      get: () => profile,
      list: () => [profile],
    } as unknown as ProviderStore;
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const backendAdapter = new RecordingBackend();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providers,
      undefined,
      {
        bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
        canonicalizeAccessRoot: vi.fn(async (
          _owner: WebContents, _terminalId: string, path: string,
        ) => path),
      } as unknown as AgentFileService,
      () => backendAdapter,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'old recipient turn', backend });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const oldThreadId = service.getState(owner, 'terminal')!.threadId;
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });
    profile = readyProviderProfile('provider', {
      baseUrl: 'https://replacement.example/v1',
      recipientRevision: 'recipient-provider-replacement',
      updatedAt: new Date(1).toISOString(),
    });

    expect(() => service.sendPrompt(owner, {
      terminalId: 'terminal', prompt: 'must be retried', backend,
    })).toThrow('旧对话未发送');
    expect(backendAdapter.sendInputs).toHaveLength(1);
    expect(service.getState(owner, 'terminal')).toMatchObject({
      fileAccessMode: 'off',
      messages: [],
    });
    expect(service.getState(owner, 'terminal')!.threadId).not.toBe(oldThreadId);

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'new recipient', backend });
    await waitFor(() => backendAdapter.sendInputs.length === 2);
    expect(backendAdapter.priorMessagesAtSend[1]).toEqual([]);
    expect(backendAdapter.sendInputs[1].gateway.context.permissions.workspace.enabled).toBe(false);
    expect(sessions.audits).toContainEqual({
      type: 'file_permission_changed',
      details: { mode: 'off', reason: 'provider_changed', ephemeral: true },
    });
  });

  it('allows off to revoke authority after the provider is removed or becomes unavailable', async () => {
    const profile = readyProviderProfile();
    let providerAvailable = true;
    const providers = {
      get: () => {
        if (!providerAvailable) throw new Error('Provider not found.');
        return profile;
      },
      list: () => providerAvailable ? [profile] : [],
    } as unknown as ProviderStore;
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providers,
      undefined,
      {
        bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
        canonicalizeAccessRoot: vi.fn(async (
          _owner: WebContents, _terminalId: string, path: string,
        ) => path),
      } as unknown as AgentFileService,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });
    providerAvailable = false;

    await expect(service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'off', backend,
    })).resolves.toMatchObject({ fileAccessMode: 'off', fileAccessRoot: undefined });
  });

  it('makes a captured Workspace gateway live only for its originating turn', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const backendAdapter = new DeferredRecordingBackend();
    const readText = vi.fn().mockResolvedValue({
      path: '/work/inside.txt',
      content: 'inside',
      bytes: 6,
      sha256: 'a'.repeat(64),
    });
    const recordPolicyRejection = vi.fn();
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      canonicalizeAccessRoot: vi.fn(async (
        _owner: WebContents, _terminalId: string, path: string,
      ) => path),
      readText,
      recordPolicyRejection,
    } as unknown as AgentFileService;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
      () => backendAdapter,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'capture gateway', backend });
    await waitFor(() => backendAdapter.sendInputs.length === 1);
    const terminal = backendAdapter.sendInputs[0]!.gateway.terminal;
    const workspace = backendAdapter.sendInputs[0]!.gateway.workspace!;
    await expect(terminal.readHistory()).resolves.toContain('tester@host');
    await expect(terminal.getState()).resolves.toMatchObject({ status: 'connected' });
    await expect(workspace.readFile('inside.txt')).resolves.toMatchObject({ content: 'inside' });
    expect(readText).toHaveBeenCalledTimes(1);

    backendAdapter.finish();
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    await expect(terminal.readHistory()).rejects.toThrow('no longer active');
    await expect(terminal.getState()).rejects.toThrow('no longer active');
    await expect(workspace.readFile('inside.txt')).rejects.toThrow('no longer active');
    // A stale, out-of-scope request must fail at the liveness guard without
    // writing its raw spelling to the policy-rejection journal.
    await expect(workspace.readFile('/private/raw-secret-name.txt'))
      .rejects.toThrow('no longer active');
    expect(recordPolicyRejection).not.toHaveBeenCalled();

    await service.setFileAccess(owner, { terminalId: 'terminal', mode: 'off', backend });
    await expect(terminal.readHistory()).rejects.toThrow('no longer active');
    await expect(terminal.getState()).rejects.toThrow('no longer active');
    await expect(workspace.readFile('inside.txt')).rejects.toThrow('no longer active');
  });

  it('revokes tools when backend send settles and drains an already-dispatched Workspace call', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const backendAdapter = new DeferredRecordingBackend();
    let resolveRead!: (value: {
      path: string;
      content: string;
      bytes: number;
      sha256: string;
    }) => void;
    const readText = vi.fn(() => new Promise<{
      path: string;
      content: string;
      bytes: number;
      sha256: string;
    }>((resolve) => { resolveRead = resolve; }));
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      canonicalizeAccessRoot: vi.fn(async (
        _owner: WebContents, _terminalId: string, path: string,
      ) => path),
      readText,
      recordPolicyRejection: vi.fn(),
    } as unknown as AgentFileService;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
      () => backendAdapter,
    );
    const owner = browserOwner();
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'drain gateway', backend });
    await waitFor(() => backendAdapter.sendInputs.length === 1);
    const terminal = backendAdapter.sendInputs[0]!.gateway.terminal;
    const workspace = backendAdapter.sendInputs[0]!.gateway.workspace!;
    const pendingRead = workspace.readFile('inside.txt');

    backendAdapter.finish();
    await Promise.resolve();
    await expect(terminal.readHistory()).rejects.toThrow('no longer active');
    expect(service.getState(owner, 'terminal')?.state).not.toBe('COMPLETED');
    resolveRead({
      path: '/work/inside.txt',
      content: 'inside',
      bytes: 6,
      sha256: 'a'.repeat(64),
    });

    await expect(pendingRead).rejects.toThrow('no longer active');
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
  });

  it('revokes a captured Workspace gateway on terminal exit or Provider fingerprint change', async () => {
    const makeService = (options: {
      terminals: FakeTerminals;
      providers: ProviderStore;
      backend: DeferredRecordingBackend;
    }) => {
      const sessions = new FakeSessions();
      sessions.session = {
        ...sessions.session,
        workspace: { backend: 'sftp' as const, root: '/work', hostId: 'host' },
      };
      const fileService = {
        bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
        canonicalizeAccessRoot: vi.fn(async (
          _owner: WebContents, _terminalId: string, path: string,
        ) => path),
        readText: vi.fn().mockResolvedValue({
          path: '/work/inside.txt', content: 'inside', bytes: 6, sha256: 'a'.repeat(64),
        }),
        recordPolicyRejection: vi.fn(),
      } as unknown as AgentFileService;
      return new AgentService(
        options.terminals as unknown as TerminalService,
        sessions as unknown as SessionManager,
        options.providers,
        undefined,
        fileService,
        () => options.backend,
      );
    };
    const owner = browserOwner();
    const backendRef = { kind: 'generic-provider', providerId: 'provider' } as const;

    const exitTerminals = new FakeTerminals();
    const exitBackend = new DeferredRecordingBackend();
    const exitService = makeService({
      terminals: exitTerminals,
      providers: providerStore(),
      backend: exitBackend,
    });
    await exitService.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend: backendRef,
    });
    exitService.sendPrompt(owner, {
      terminalId: 'terminal', prompt: 'terminal exit', backend: backendRef,
    });
    await waitFor(() => exitBackend.sendInputs.length === 1);
    const exitTerminal = exitBackend.sendInputs[0]!.gateway.terminal;
    const exitWorkspace = exitBackend.sendInputs[0]!.gateway.workspace!;
    exitTerminals.exit();
    await expect(exitTerminal.readHistory()).rejects.toThrow('no longer active');
    await expect(exitTerminal.getState()).rejects.toThrow('no longer active');
    await expect(exitWorkspace.readFile('inside.txt')).rejects.toThrow('no longer active');
    exitBackend.finish();

    let profile = readyProviderProfile();
    const changedProviders = {
      get: () => profile,
      list: () => [profile],
    } as unknown as ProviderStore;
    const changedBackend = new DeferredRecordingBackend();
    const changedService = makeService({
      terminals: new FakeTerminals(),
      providers: changedProviders,
      backend: changedBackend,
    });
    await changedService.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend: backendRef,
    });
    changedService.sendPrompt(owner, {
      terminalId: 'terminal', prompt: 'provider change', backend: backendRef,
    });
    await waitFor(() => changedBackend.sendInputs.length === 1);
    const changedTerminal = changedBackend.sendInputs[0]!.gateway.terminal;
    const changedWorkspace = changedBackend.sendInputs[0]!.gateway.workspace!;
    profile = readyProviderProfile('provider', {
      baseUrl: 'https://replacement.example/v1',
      updatedAt: new Date(1).toISOString(),
    });
    await expect(changedTerminal.readHistory()).rejects.toThrow('no longer active');
    await expect(changedTerminal.getState()).rejects.toThrow('no longer active');
    await expect(changedWorkspace.readFile('inside.txt')).rejects.toThrow('no longer active');
    changedBackend.finish();
  });

  it('revokes ephemeral file authority on terminal exit and backend replacement', async () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const terminals = new FakeTerminals();
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      canonicalizeAccessRoot: vi.fn(async (
        _owner: WebContents,
        _terminalId: string,
        accessRoot: string,
      ) => accessRoot),
    } as unknown as AgentFileService;
    const backend = { kind: 'generic-provider', providerId: 'provider' } as const;
    const owner = browserOwner();
    const terminalExitService = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
    );
    await terminalExitService.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });
    terminals.exit();
    expect(terminalExitService.getState(owner, 'terminal')).toMatchObject({
      state: 'FAILED',
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
      fileAccessPolicy: { read: false, write: false, create: false, delete: false },
    });

    const replacementSessions = new FakeSessions();
    replacementSessions.session = {
      ...replacementSessions.session,
      workspace: { backend: 'sftp', root: '/work', hostId: 'host' },
    };
    const replacementService = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      replacementSessions as unknown as SessionManager,
      providerStore(),
      new FakeCodexAppServer() as unknown as CodexAppServerService,
      fileService,
    );
    await replacementService.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-only', backend,
    });
    replacementService.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Switch backend.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => replacementService.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(replacementService.getState(owner, 'terminal')).toMatchObject({
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
      fileAccessPolicy: { read: false, write: false, create: false, delete: false },
    });
    expect(replacementSessions.audits).toContainEqual({
      type: 'file_permission_changed',
      details: { mode: 'off', reason: 'user', ephemeral: true },
    });
  });

  it('rejects Workspace changes while a Generic Provider turn is running', async () => {
    const provider = new DeferredStreamingProvider();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );
    const owner = browserOwner();

    service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Keep working.',
      backend: { kind: 'generic-provider', providerId: 'provider' },
    });

    expect(() => service.assertWorkspaceChangeAllowed(owner, 'terminal'))
      .toThrow('Agent 运行或正在停止时');
    await waitFor(() => Boolean(provider.request));
    provider.finish('Done.');
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
  });

  it('rejects Workspace changes while a native backend turn is draining', async () => {
    const codex = new DeferredStreamingCodexAppServer();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
    );
    const owner = browserOwner();
    const running = service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Keep working.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => Boolean(codex.input));
    service.interruptTurn(owner, {
      terminalId: 'terminal',
      messageId: running.messages.at(-1)!.id,
    });

    expect(service.getState(owner, 'terminal')?.backendTurnDraining).toBe(true);
    expect(() => service.assertWorkspaceChangeAllowed(owner, 'terminal'))
      .toThrow('Agent 运行或正在停止时');

    codex.finishInterrupt();
    await waitFor(() => service.getState(owner, 'terminal')?.backendTurnDraining === false);
  });

  it('binds ephemeral file permission and does not use a hidden command or legacy mutation audit', async () => {
    const sessions = new FakeSessions();
    sessions.session = { ...sessions.session, cwd: '/work' };
    const terminals = new FakeTerminals();
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'write-1',
        name: 'workspace_write_file',
        arguments: JSON.stringify({
          path: 'new.ts', content: 'export {};\n', expectedSha256: null,
        }),
      }] } },
      { message: { role: 'assistant', content: 'written' } },
    ]);
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      canonicalizeAccessRoot: vi.fn(async (_owner, _terminalId, accessRoot) => accessRoot),
      writeText: vi.fn().mockResolvedValue({
        path: '/work/new.ts', bytes: 11, sha256: 'a'.repeat(64), created: true,
      }),
    } as unknown as AgentFileService;
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      fileService,
      () => new ScriptedLoopBackend(provider),
    );
    const owner = browserOwner();

    const permission = await service.setFileAccess(owner, {
      terminalId: 'terminal', mode: 'read-write',
      backend: { kind: 'generic-provider', providerId: 'provider' },
    });
    expect(permission).toMatchObject({ fileAccessMode: 'read-write', fileAccessRoot: '/work' });
    sessions.session = { ...sessions.session, cwd: '/' };
    service.sendPrompt(owner, {
      terminalId: 'terminal', prompt: 'create it',
      backend: { kind: 'generic-provider', providerId: 'provider' },
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(terminals.executions).toHaveLength(0);
    expect(fileService.writeText).toHaveBeenCalledWith(
      owner, 'terminal', 'new.ts', 'export {};\n', null, '/work',
      expect.objectContaining({
        readablePaths: ['/work'],
        writablePaths: ['/work'],
        fullAccess: false,
        assertLive: expect.any(Function),
      }),
    );
    expect(sessions.audits).toContainEqual({
      type: 'file_permission_changed',
      details: {
        mode: 'read-write',
        root: '/work',
        ephemeral: true,
        policy: {
          read: true,
          write: true,
          create: true,
          delete: true,
          readablePaths: ['/work'],
          writablePaths: ['/work'],
          fullAccess: false,
        },
      },
    });
    expect(sessions.audits.some((audit) => audit.type === 'file_modified')).toBe(false);
  });

  it('hydrates the persisted AI conversation when a Session reconnects to a new terminal', () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      runtimeTerminalId: 'reconnected-terminal',
      aiThreadId: '22222222-2222-2222-2222-222222222222',
      agentBackend: { kind: 'generic-provider', providerId: 'provider' },
      agentBackendFingerprint: recipientFingerprint(),
      providerId: 'provider',
    };
    sessions.persistedThreadEvents = [{
      type: 'chat',
      timestamp: new Date(1).toISOString(),
      item: {
        id: 'message-1',
        role: 'assistant',
        content: 'Persisted answer',
        createdAt: new Date(1).toISOString(),
      },
    }];
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
    );

    const restored = service.getState(browserOwner(), 'reconnected-terminal');

    expect(restored?.threadId).toBe('22222222-2222-2222-2222-222222222222');
    expect(restored?.messages).toEqual([expect.objectContaining({
      id: 'message-1',
      content: 'Persisted answer',
    })]);
  });

  it('publishes App Server deltas before turn completion using one stable message', async () => {
    const codex = new DeferredStreamingCodexAppServer();
    const sessions = new FakeSessions();
    const owner = browserOwner();
    const send = owner.send as unknown as ReturnType<typeof vi.fn>;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
    );

    service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Stream from App Server.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => Boolean(codex.input));
    codex.push('**部分');
    codex.push('输出');
    await waitFor(() => send.mock.calls.some((call) => {
      const event = call[1] as { delta?: string };
      return call[0] === AGENT_CHANNELS.assistantDelta
        && event.delta === '**部分输出';
    }));
    const deltaPayload = send.mock.calls.find(
      (call) => call[0] === AGENT_CHANNELS.assistantDelta,
    )?.[1] as Record<string, unknown>;
    expect(deltaPayload).toMatchObject({
      terminalId: 'terminal',
      messageId: expect.any(String),
      turnId: expect.any(String),
      sequence: 1,
      delta: '**部分输出',
    });
    expect(deltaPayload).not.toHaveProperty('messages');
    expect(send.mock.calls.some((call) => {
      if (call[0] !== AGENT_CHANNELS.stateChanged) return false;
      const view = call[1] as AgentSessionView;
      return Boolean(view.streamingMessageId)
        && view.messages.at(-1)?.content === '';
    })).toBe(true);
    const partial = service.getState(owner, 'terminal')!;
    const partialId = partial.streamingMessageId;
    expect(partial.messages.at(-1)?.id).toBe(partialId);
    expect(partial.state).toBe('THINKING');

    codex.finish('**部分输出**');
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const completed = service.getState(owner, 'terminal')!;
    expect(completed.streamingMessageId).toBeUndefined();
    expect(completed.messages.at(-1)).toMatchObject({
      id: partialId,
      content: '**部分输出**',
    });
  });

  it('keeps the visible terminal human-owned and disables manual takeover for App Server', async () => {
    const codex = new DeferredStreamingCodexAppServer();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
    );
    const request = {
      terminalId: 'terminal',
      prompt: 'First turn.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      } as const,
    };

    service.sendPrompt(owner, request);
    await waitFor(() => Boolean(codex.input));
    expect(service.getState(owner, 'terminal')?.terminalInputMode).toBe('human');
    expect(terminals.controlModes).toEqual([]);
    expect(() => service.takeover(owner, { terminalId: 'terminal' }))
      .toThrow('无需人工接管');
    expect(() => service.setFullTakeover(owner, {
      terminalId: 'terminal', enabled: true,
    })).toThrow('Full Takeover');
    codex.finish('done');
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(terminals.controlModes).toEqual([]);
  });

  it('reads fresh non-secret Session metadata for native Codex terminal state', async () => {
    const codex = new DeferredStreamingCodexAppServer();
    const sessions = new FakeSessions();
    const owner = browserOwner();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
    );

    service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Inspect the current SSH terminal.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => Boolean(codex.input));

    sessions.session = {
      ...sessions.session,
      cwd: '/srv/latest',
      effectiveUser: 'root',
      connectionState: 'disconnected',
    };
    const state = await codex.input!.tools.getTerminalState();
    expect(state).toEqual({
      transport: 'ssh',
      target: {
        label: 'Test', hostname: '192.0.2.10', port: 22, username: 'tester',
      },
      cwd: '/srv/latest',
      effectiveUser: 'root',
      shellKind: 'posix',
      connectionState: 'disconnected',
    });
    expect(state).not.toHaveProperty('hostId');

    codex.finish('state read');
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
  });

  it('publishes partial Generic Provider output and finalizes one persisted chat item', async () => {
    const provider = new DeferredStreamingProvider();
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const send = owner.send as unknown as ReturnType<typeof vi.fn>;
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Stream Markdown.' });
    await waitFor(() => Boolean(provider.request));
    provider.push('**正在');
    provider.push('生成');

    await waitFor(() => send.mock.calls.some((call) => {
      const event = call[1] as { delta?: string };
      return call[0] === AGENT_CHANNELS.assistantDelta
        && event.delta === '**正在生成';
    }));
    const streamPayloads = send.mock.calls
      .filter((call) => call[0] === AGENT_CHANNELS.assistantDelta)
      .map((call) => call[1] as Record<string, unknown>);
    expect(streamPayloads).toEqual([
      expect.objectContaining({ sequence: 1, delta: '**正在生成' }),
    ]);
    expect(streamPayloads[0]).not.toHaveProperty('messages');
    expect(service.getState(owner, 'terminal')).toMatchObject({
      state: 'THINKING',
      messages: [
        { role: 'user', content: 'Stream Markdown.' },
        { role: 'assistant', content: '**正在生成' },
      ],
    });

    provider.finish('**正在生成**');
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const completed = service.getState(owner, 'terminal')!;
    expect(completed.streamingMessageId).toBeUndefined();
    expect(completed.messages.at(-1)?.content).toBe('**正在生成**');
    expect(sessions.threadEvents.filter((event) => (
      event.type === 'chat' && (event.item as { role?: string }).role === 'assistant'
    ))).toHaveLength(1);
  });

  it('clears and persists partial streaming output before manual takeover', async () => {
    const provider = new DeferredStreamingProvider();
    const sessions = new FakeSessions();
    const owner = browserOwner();
    const send = owner.send as unknown as ReturnType<typeof vi.fn>;
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Stream then pause.' });
    await waitFor(() => Boolean(provider.request));
    provider.push('partial answer');
    await waitFor(() => Boolean(service.getState(owner, 'terminal')?.streamingMessageId));

    const paused = service.takeover(owner, { terminalId: 'terminal' });
    const sendCount = send.mock.calls.length;
    expect(paused.state).toBe('PAUSED');
    expect(paused.streamingMessageId).toBeUndefined();
    expect(sessions.threadEvents.filter((event) => (
      event.type === 'chat'
      && (event.item as { role?: string; content?: string }).role === 'assistant'
    ))).toContainEqual(expect.objectContaining({
      item: expect.objectContaining({ content: 'partial answer' }),
    }));

    provider.finish('partial answer');
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(send.mock.calls).toHaveLength(sendCount);
    expect(service.getState(owner, 'terminal')?.state).toBe('PAUSED');
  });

  it('runs App Server independently without routing commands into the visible terminal', async () => {
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const codex = new FakeCodexAppServer();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
    );

    service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Use native Codex tools.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    const view = service.getState(owner, 'terminal')!;
    expect(view.backend).toEqual({
      kind: CODEX_APP_SERVER_AGENT_BACKEND,
      policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
    });
    expect(terminals.executions).toEqual([]);
    expect(terminals.controlModes).toEqual([]);
    expect(view.terminalInputMode).toBe('human');
    expect(sessions.session.providerThreadId).toBe('provider-thread-1');
    expect(view.messages.at(-1)?.content).toBe('history-ok');
    expect(sessions.threadEvents.some((event) => (
      event.type === 'codex_app_server_turn'
      && event.providerTurnId === 'provider-turn-1'
    ))).toBe(true);
  });

  it('does not acquire terminal control when the initial prompt cannot be persisted', () => {
    const sessions = new FakeSessions();
    sessions.failThreadEvents = true;
    const terminals = new FakeTerminals();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(new FakeProvider([])),
    );
    const owner = browserOwner();

    expect(() => service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Do not lock.',
    })).toThrow(/thread persistence failed/i);

    expect(terminals.controlModes).toEqual([]);
    expect(service.getState(owner, 'terminal')?.state).toBe('USER_CONTROL');
    expect(service.getState(owner, 'terminal')?.messages).toEqual([]);
  });

  it('executes an edited command in the owned visible terminal and completes the loop', async () => {
    const provider = new FakeProvider([
      toolCall('call-1', 'whoami'),
      { message: { role: 'assistant', content: 'The effective user is tester.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Who am I?' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    service.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'edit',
      editedCommand: 'id -un',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(terminals.executions).toEqual([{ command: 'id -un', actor: 'user_modified_ai_command' }]);
    expect(sessions.audits.map((audit) => audit.type)).toEqual(expect.arrayContaining([
      'command_requested',
      'command_edited',
      'command_completed',
    ]));
    expect(service.getState(owner, 'terminal')?.messages.at(-1)?.content)
      .toBe('The effective user is tester.');
    expect(terminals.controlModes.at(-1)).toBe('human');
  });

  it('returns rejection to the Provider without writing any terminal input', async () => {
    const provider = new FakeProvider([
      toolCall('call-1', 'uname'),
      { message: { role: 'assistant', content: 'The command was rejected.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Inspect OS' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    service.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'reject',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(terminals.executions).toEqual([]);
    expect(sessions.audits.map((audit) => audit.type)).toContain('command_rejected');
    const toolResult = provider.requests[1].messages.find((message) => message.role === 'tool');
    expect(toolResult?.content).toContain('User rejected');
  });

  it('runs multiple commands without approval only after explicit Full Takeover', async () => {
    const provider = new FakeProvider([
      toolCall('call-1', 'printf one'),
      toolCall('call-2', 'printf two'),
      { message: { role: 'assistant', content: 'Both commands completed.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    const enabled = service.setFullTakeover(owner, {
      terminalId: 'terminal',
      enabled: true,
      providerId: 'provider',
    });
    expect(enabled.fullTakeover).toBe(true);
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Run both.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(terminals.executions.map((item) => item.command)).toEqual([
      'printf one',
      'printf two',
    ]);
    expect(sessions.audits.filter((audit) => audit.type === 'command_approved'))
      .toHaveLength(2);
    expect(sessions.audits.filter((audit) => audit.type === 'command_approved'))
      .toSatisfy((audits: Array<{ details?: Record<string, unknown> }>) => (
        audits.every((audit) => audit.details?.fullTakeover === true)
      ));
  });

  it('atomically upgrades an exact pending approval to Full Takeover and preserves edits', async () => {
    const provider = new FakeProvider([
      toolCall('call-1', 'printf original'),
      toolCall('call-2', 'printf second'),
      { message: { role: 'assistant', content: 'Both commands completed.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Run both.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    const emissionsBeforeConfirmation = vi.mocked(owner.send).mock.calls.length;
    const enabled = service.setFullTakeover(owner, {
      terminalId: 'terminal',
      enabled: true,
      approvalId: approval.id,
      editedCommand: 'printf edited',
    });

    expect(enabled.fullTakeover).toBe(true);
    expect(enabled.state).toBe('AI_CONTROL');
    expect(enabled.pendingApproval?.status).toBe('edited');
    expect(vi.mocked(owner.send).mock.calls.length - emissionsBeforeConfirmation).toBe(1);
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(terminals.executions).toEqual([
      { command: 'printf edited', actor: 'user_modified_ai_command' },
      { command: 'printf second', actor: 'ai' },
    ]);
    expect(sessions.audits.filter((audit) => audit.type === 'full_takeover_changed'))
      .toHaveLength(1);
    expect(sessions.audits.map((audit) => audit.type)).toContain('command_edited');
  });

  it('rejects stale Full Takeover approval IDs without changing state or executing', async () => {
    const provider = new FakeProvider([
      toolCall('call-1', 'printf guarded'),
      { message: { role: 'assistant', content: 'Rejected.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Try it.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    expect(() => service.setFullTakeover(owner, {
      terminalId: 'terminal',
      enabled: true,
      approvalId: 'stale-approval',
    })).toThrow(/no longer pending/i);
    expect(() => service.setFullTakeover(owner, {
      terminalId: 'terminal',
      enabled: true,
      approvalId: approval.id,
      editedCommand: '   ',
    })).toThrow(/cannot be empty/i);
    expect(service.getState(owner, 'terminal')?.state).toBe('WAITING_APPROVAL');
    expect(service.getState(owner, 'terminal')?.fullTakeover).toBe(false);
    expect(terminals.executions).toEqual([]);
    expect(sessions.audits.some((audit) => audit.type === 'full_takeover_changed')).toBe(false);

    service.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'reject',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
  });

  it('rolls back approval-bound Full Takeover when approval audit persistence fails', async () => {
    const provider = new FakeProvider([
      toolCall('call-1', 'printf guarded'),
      { message: { role: 'assistant', content: 'Rejected.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Try it.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    sessions.failAuditTypes.add('command_approved');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => service.setFullTakeover(owner, {
      terminalId: 'terminal',
      enabled: true,
      approvalId: approval.id,
    })).toThrow(/audit failed/i);

    expect(service.getState(owner, 'terminal')?.fullTakeover).toBe(false);
    expect(service.getState(owner, 'terminal')?.state).toBe('WAITING_APPROVAL');
    expect(terminals.executions).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
    sessions.failAuditTypes.delete('command_approved');
    service.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'reject',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
  });

  it('auto-answers displayed Y/n defaults only during Full Takeover', async () => {
    let normalAnswer: boolean | undefined;
    const normalProvider = new FakeProvider([
      toolCall('call-1', 'confirm-normal'),
      { message: { role: 'assistant', content: 'Done.' } },
    ]);
    const normalSessions = new FakeSessions();
    const normalTerminals = new FakeTerminals(async (started, hooks) => {
      normalAnswer = hooks.onConfirmation?.('y', started);
      return {
        ...started,
        status: 'completed',
        exitCode: 0,
        output: 'done',
        endedAt: new Date(1).toISOString(),
        durationMs: 1,
      };
    });
    const owner = browserOwner();
    const normalService = new AgentService(
      normalTerminals as unknown as TerminalService,
      normalSessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(normalProvider),
    );
    normalService.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Confirm.' });
    await waitFor(() => normalService.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = normalService.getState(owner, 'terminal')!.pendingApproval!;
    normalService.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'execute',
    });
    await waitFor(() => normalService.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(normalAnswer).toBe(false);
    expect(normalSessions.audits.some((audit) => audit.type === 'interactive_response')).toBe(false);

    let takeoverAnswer: boolean | undefined;
    const takeoverProvider = new FakeProvider([
      toolCall('call-1', 'confirm-takeover'),
      { message: { role: 'assistant', content: 'Done.' } },
    ]);
    const takeoverSessions = new FakeSessions();
    const takeoverTerminals = new FakeTerminals(async (started, hooks) => {
      takeoverAnswer = hooks.onConfirmation?.('n', started);
      return {
        ...started,
        status: 'completed',
        exitCode: 0,
        output: 'done',
        endedAt: new Date(1).toISOString(),
        durationMs: 1,
      };
    });
    const takeoverService = new AgentService(
      takeoverTerminals as unknown as TerminalService,
      takeoverSessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(takeoverProvider),
    );
    takeoverService.setFullTakeover(owner, { terminalId: 'terminal', enabled: true });
    takeoverService.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Confirm.' });
    await waitFor(() => takeoverService.getState(owner, 'terminal')?.state === 'COMPLETED');
    expect(takeoverAnswer).toBe(true);
    expect(takeoverSessions.audits.filter((audit) => audit.type === 'interactive_response'))
      .toHaveLength(1);
  });

  it('can interrupt a kept foreground process from the latest message without resuming the Agent', async () => {
    let finish!: (execution: CommandExecution) => void;
    const deferred = new Promise<CommandExecution>((resolve) => { finish = resolve; });
    const provider = new FakeProvider([
      toolCall('call-1', 'long-running-command'),
      { message: { role: 'assistant', content: 'must not be reached' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals(() => deferred);
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Start it.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    service.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'execute',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'RUNNING');
    const frozen = service.takeover(owner, { terminalId: 'terminal' });
    expect(frozen.state).toBe('TAKEOVER_PENDING');
    const pending = frozen.pendingTakeover!;
    service.resolveTakeover(owner, {
      terminalId: 'terminal',
      takeoverId: pending.id,
      executionId: pending.executionId,
      action: 'keep',
    });
    expect(service.getState(owner, 'terminal')?.state).toBe('PAUSED');
    expect(terminals.keepCount).toBe(1);

    const latestUserMessage = [...service.getState(owner, 'terminal')!.messages]
      .reverse().find((message) => message.role === 'user')!;
    const interrupted = service.interruptTurn(owner, {
      terminalId: 'terminal',
      messageId: latestUserMessage.id,
    });
    expect(terminals.interruptCount).toBe(1);
    expect(interrupted).toMatchObject({
      state: 'PAUSED',
      terminalInputMode: 'human',
      activeExecution: { id: pending.executionId },
    });
    expect(interrupted.activeExecution?.interruptRequestedAt).toBeTruthy();

    const started = terminals.current!;
    finish({
      ...started,
      status: 'completed',
      exitCode: 0,
      output: 'done',
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
    });
    await waitFor(() => service.getState(owner, 'terminal')?.activeExecution?.status === 'completed');

    expect(service.getState(owner, 'terminal')?.state).toBe('PAUSED');
    expect(provider.requests).toHaveLength(1);
    expect(terminals.controlModes.at(-1)).toBe('human');
  });

  it('publishes cancelled shell-ready state even when the control Audit write fails', async () => {
    const deferred = new Promise<CommandExecution>(() => undefined);
    const provider = new FakeProvider([toolCall('call-1', 'long-running-command')]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals(() => deferred);
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Start it.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    service.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'execute',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'RUNNING');
    const frozen = service.takeover(owner, { terminalId: 'terminal' });
    const pending = frozen.pendingTakeover!;
    service.resolveTakeover(owner, {
      terminalId: 'terminal',
      takeoverId: pending.id,
      executionId: pending.executionId,
      action: 'interrupt',
    });
    sessions.failAuditTypes.add('agent_paused');
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const revisionBefore = service.getState(owner, 'terminal')!.revision;

    const settled = service.confirmShellReady(owner, {
      terminalId: 'terminal',
      executionId: pending.executionId,
    });

    expect(settled.state).toBe('PAUSED');
    expect(settled.activeExecution?.status).toBe('cancelled');
    expect(settled.revision).toBeGreaterThan(revisionBefore);
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });

  it('opens secure terminal input for auth and never sends the redacted output as a secret', async () => {
    let finish!: (execution: CommandExecution) => void;
    const deferred = new Promise<CommandExecution>((resolve) => { finish = resolve; });
    const provider = new FakeProvider([
      toolCall('call-1', 'sudo harmless-command'),
      { message: { role: 'assistant', content: 'Authentication completed.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals((started, hooks) => {
      hooks.onAuthPrompt?.(started);
      return deferred;
    });
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Run sudo.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_APPROVAL');
    const approval = service.getState(owner, 'terminal')!.pendingApproval!;
    service.resolveApproval(owner, {
      terminalId: 'terminal',
      approvalId: approval.id,
      decision: 'execute',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'WAITING_AUTH');
    const auth = service.getState(owner, 'terminal')!.authRequest!;
    expect(service.getState(owner, 'terminal')?.terminalInputMode).toBe('secure-human');
    expect(auth.executionId).toBe(terminals.current?.id);
    terminals.submitSensitive();
    expect(service.getState(owner, 'terminal')?.terminalInputMode).toBe('locked');

    const started = terminals.current!;
    finish({
      ...started,
      status: 'completed',
      exitCode: 0,
      output: '[Sensitive interaction hidden]',
      outputRedacted: true,
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    expect(terminals.sensitiveBeginCount).toBe(1);
    expect(terminals.sensitiveEndCount).toBe(1);
    expect(terminals.rearmCount).toBe(1);
    const toolResult = provider.requests[1].messages.find((message) => message.role === 'tool');
    expect(toolResult?.content).toContain('Sensitive interaction hidden');
    expect(sessions.audits.filter((audit) => audit.type === 'interactive_auth'))
      .toHaveLength(2);
  });

  it('closes an auth handoff safely when the command ends before any secure submission', async () => {
    const provider = new FakeProvider([
      toolCall('call-1', 'prints-a-password-prompt-and-exits'),
      { message: { role: 'assistant', content: 'The command ended.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals(async (started, hooks) => {
      hooks.onAuthPrompt?.(started);
      return {
        ...started,
        status: 'failed',
        exitCode: 1,
        output: '[Sensitive interaction hidden]',
        outputRedacted: true,
        endedAt: new Date(1).toISOString(),
        durationMs: 1,
      };
    });
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.setFullTakeover(owner, { terminalId: 'terminal', enabled: true });
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Run it.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    const state = service.getState(owner, 'terminal')!;
    expect(state.authRequest).toBeUndefined();
    expect(state.terminalInputMode).toBe('human');
    expect(sessions.audits.some((audit) => (
      audit.type === 'interactive_auth'
      && audit.details?.phase === 'execution_ended_without_submission'
    ))).toBe(true);
  });

  it('interrupts only the latest running user message and ignores stale completion', async () => {
    const provider = new DeferredStreamingProvider();
    const sessions = new FakeSessions();
    const owner = browserOwner();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    const running = service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Long task.' });
    const messageId = running.messages.at(-1)!.id;
    await waitFor(() => Boolean(provider.request));

    expect(() => service.interruptTurn(owner, {
      terminalId: 'terminal',
      messageId: 'stale-message',
    })).toThrow('最后一条用户消息');
    const interrupted = service.interruptTurn(owner, { terminalId: 'terminal', messageId });
    expect(interrupted.state).toBe('PAUSED');
    expect(interrupted.terminalInputMode).toBe('human');
    expect(provider.request?.signal.aborted).toBe(true);

    const revision = interrupted.revision;
    provider.finish('must be ignored');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(service.getState(owner, 'terminal')).toMatchObject({ state: 'PAUSED', revision });
    expect(service.getState(owner, 'terminal')?.messages.some((item) => (
      item.content === 'must be ignored'
    ))).toBe(false);
  });

  it('replaces only the latest completed prompt using append-only conversation actions', async () => {
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'First answer.' } },
      { message: { role: 'assistant', content: 'Old second answer.' } },
      { message: { role: 'assistant', content: 'Revised answer.' } },
    ]);
    const sessions = new FakeSessions();
    const terminals = new FakeTerminals();
    const owner = browserOwner();
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'First prompt.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const firstMessageId = service.getState(owner, 'terminal')!.messages
      .find((item) => item.role === 'user')!.id;
    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Old second prompt.' });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const oldMessageId = [...service.getState(owner, 'terminal')!.messages]
      .reverse().find((item) => item.role === 'user')!.id;

    expect(() => service.revisePrompt(owner, {
      terminalId: 'terminal',
      messageId: firstMessageId,
      action: 'retract',
    })).toThrow('最后一条用户消息');
    service.revisePrompt(owner, {
      terminalId: 'terminal',
      messageId: oldMessageId,
      action: 'replace',
      prompt: 'Revised second prompt.',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');

    const completed = service.getState(owner, 'terminal')!;
    expect(completed.messages.map((item) => item.content)).toEqual([
      'First prompt.',
      'First answer.',
      'Revised second prompt.',
      'Revised answer.',
    ]);
    expect(provider.requests[2].messages.some((message) => (
      message.role === 'user' && message.content.startsWith('First prompt.')
    ))).toBe(true);
    expect(provider.requests[2].messages.some((message) => (
      message.role === 'user' && message.content.includes('Old second prompt.')
    ))).toBe(false);
    expect(sessions.threadEvents).toContainEqual(expect.objectContaining({
      type: 'chat_action',
      action: 'replace',
      targetMessageId: oldMessageId,
      executionHistoryPreserved: true,
    }));

    service.close();
    const restored = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      undefined,
      undefined,
      () => new ScriptedLoopBackend(provider),
    ).getState(owner, 'terminal');
    expect(restored?.messages.map((item) => item.content)).toEqual([
      'First prompt.',
      'First answer.',
      'Revised second prompt.',
      'Revised answer.',
    ]);
  });

  it('drains an interrupted native Codex turn without taking terminal control', async () => {
    const codex = new DeferredStreamingCodexAppServer();
    const owner = browserOwner();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
    );
    const running = service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Native long task.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => Boolean(codex.input));

    const interrupted = service.interruptTurn(owner, {
      terminalId: 'terminal',
      messageId: running.messages.at(-1)!.id,
    });
    expect(interrupted).toMatchObject({
      state: 'PAUSED',
      terminalInputMode: 'human',
      backendTurnDraining: true,
    });
    expect(codex.interruptRequested).toBe(true);
    codex.finishInterrupt();
    await waitFor(() => service.getState(owner, 'terminal')?.backendTurnDraining === false);
    expect(service.getState(owner, 'terminal')?.state).toBe('PAUSED');
  });

  it('reports a rejected native interrupt instead of presenting it as safely stopped', async () => {
    const codex = new RejectingInterruptCodexAppServer();
    const owner = browserOwner();
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      providerStore(),
      codex as unknown as CodexAppServerService,
    );
    const running = service.sendPrompt(owner, {
      terminalId: 'terminal',
      prompt: 'Native long task.',
      backend: {
        kind: CODEX_APP_SERVER_AGENT_BACKEND,
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      },
    });
    await waitFor(() => Boolean(codex.input));

    service.interruptTurn(owner, {
      terminalId: 'terminal',
      messageId: running.messages.at(-1)!.id,
    });
    await waitFor(() => service.getState(owner, 'terminal')?.error !== undefined);
    expect(service.getState(owner, 'terminal')).toMatchObject({
      state: 'PAUSED',
      terminalInputMode: 'human',
      backendTurnDraining: true,
      error: 'interrupt rejected; connection quarantined',
    });
    service.handleCodexAppServerRestarted();
    expect(service.getState(owner, 'terminal')).toMatchObject({
      state: 'PAUSED',
      terminalInputMode: 'human',
      backendTurnDraining: false,
      error: undefined,
    });
  });

  it('keeps renderer revisions increasing when the Provider creates a new runtime', async () => {
    const firstProfile: ProviderProfile = {
      id: 'provider-a',
      name: 'Provider A',
      kind: 'generic-openai-compatible',
      baseUrl: 'https://a.example/v1',
      modelId: 'model-a',
      recipientRevision: 'recipient-a',
      apiKeyConfigured: true,
      isDefault: true,
      status: 'ready',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const secondProfile: ProviderProfile = {
      ...firstProfile,
      id: 'provider-b',
      name: 'Provider B',
      baseUrl: 'https://b.example/v1',
      modelId: 'model-b',
      isDefault: false,
    };
    const store = {
      get: (id: string) => [firstProfile, secondProfile].find((profile) => profile.id === id),
      list: () => [firstProfile, secondProfile],
    } as unknown as ProviderStore;
    const firstProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'First turn.' } },
    ]);
    const secondProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'Second turn.' } },
    ]);
    const service = new AgentService(
      new FakeTerminals() as unknown as TerminalService,
      new FakeSessions() as unknown as SessionManager,
      store,
      undefined,
      undefined,
      (providerId) => new ScriptedLoopBackend(providerId === firstProfile.id ? firstProvider : secondProvider),
    );
    const owner = browserOwner();

    service.sendPrompt(owner, {
      terminalId: 'terminal',
      providerId: firstProfile.id,
      prompt: 'First.',
    });
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
    const firstRevision = service.getState(owner, 'terminal')!.revision;
    const switched = service.sendPrompt(owner, {
      terminalId: 'terminal',
      providerId: secondProfile.id,
      prompt: 'Second.',
    });

    expect(switched.providerId).toBe(secondProfile.id);
    expect(switched.revision).toBeGreaterThan(firstRevision);
    await waitFor(() => service.getState(owner, 'terminal')?.state === 'COMPLETED');
  });
});
