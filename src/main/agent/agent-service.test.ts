import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_APP_SERVER_AGENT_BACKEND,
  CODEX_APP_SERVER_AGENT_POLICY_VERSION,
} from '../../shared/agent';
import type {
  AgentBackendRef,
  CommandActor,
  CommandExecution,
  TerminalInputMode,
} from '../../shared/agent';
import type { ProviderProfile } from '../../shared/provider';
import type { SessionRecord } from '../../shared/session';
import type { ProviderStore } from '../providers/provider-store';
import type { CodexAppServerService } from '../app-server/app-server-service';
import type { RunCodexTurnInput } from '../app-server/app-server-turn-runner';
import type { SessionManager } from '../sessions/session-manager';
import type {
  StructuredExecutionHooks,
  TerminalService,
} from '../terminal/terminal-service';
import type { AgentCompletion, AgentCompletionRequest, AgentProviderRuntime } from './agent-loop';
import type { AgentFileService } from './agent-file-service';
import { AgentService } from './agent-service';

async function waitFor(predicate: () => boolean, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for Agent state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeProvider implements AgentProviderRuntime {
  readonly requests: AgentCompletionRequest[] = [];

  constructor(private readonly responses: AgentCompletion[]) {}

  async complete(request: AgentCompletionRequest): Promise<AgentCompletion> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error('No fake response remains.');
    return response;
  }
}

class DeferredStreamingProvider implements AgentProviderRuntime {
  request?: AgentCompletionRequest;
  private resolveCompletion?: (value: AgentCompletion) => void;

  complete(request: AgentCompletionRequest): Promise<AgentCompletion> {
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

class FakeSessions {
  readonly audits: Array<{ type: string; details?: Record<string, unknown> }> = [];
  readonly threadEvents: Array<Record<string, unknown>> = [];
  persistedThreadEvents: Array<Record<string, unknown>> = [];
  readonly failAuditTypes = new Set<string>();
  failThreadEvents = false;
  session: SessionRecord = {
    schemaVersion: 1,
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Test Session',
    nameSource: 'automatic',
    transport: 'ssh',
    hostId: 'host',
    shellProfileId: 'ssh:host',
    shellKind: 'posix',
    targetSnapshot: { label: 'Test', username: 'tester' },
    connectionState: 'connected',
    status: 'active',
    runtimeTerminalId: 'terminal',
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
  bindAgentThread(_sessionId: string, providerId: string, threadId: string) {
    this.session = {
      ...this.session,
      providerId,
      agentBackend: { kind: 'generic-provider', providerId },
      aiThreadId: threadId,
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
      providerThreadId: undefined,
    };
    return this.session;
  }
  bindProviderThread(_sessionId: string, localThreadId: string, providerThreadId: string) {
    if (this.session.aiThreadId !== localThreadId) throw new Error('stale local thread');
    this.session = { ...this.session, providerThreadId };
    return this.session;
  }
  readThreadEvents() { return this.persistedThreadEvents; }
  appendThreadEvent(_sessionId: string, _threadId: string, event: Record<string, unknown>) {
    if (this.failThreadEvents) throw new Error('thread persistence failed');
    this.threadEvents.push(event);
    this.persistedThreadEvents.push(event);
  }
  readTerminalHistory() { return 'tester@host:~$ '; }
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
        acceptedClientTools: ['terminal_read'],
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
        acceptedClientTools: ['terminal_read'],
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
  onSensitiveSubmission(listener: (
    terminalId: string,
    ownerId: number,
    executionId: string,
    leaseId: string,
  ) => void) {
    this.sensitiveSubmissionListener = listener;
    return () => { this.sensitiveSubmissionListener = undefined; };
  }
  state() { return { transport: 'ssh', shellKind: 'posix', status: 'connected' }; }
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

function providerStore(): ProviderStore {
  const profile: ProviderProfile = {
    id: 'provider',
    name: 'Provider',
    kind: 'generic-openai-compatible',
    baseUrl: 'https://provider.example/v1',
    modelId: 'model',
    apiKeyConfigured: true,
    isDefault: true,
    status: 'ready',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
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

function toolCall(id: string, command: string): AgentCompletion {
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

describe('AgentService shared-terminal controls', () => {
  it('binds ephemeral file permission, audits content-free writes, and does not use a hidden command', async () => {
    const sessions = new FakeSessions();
    sessions.session = { ...sessions.session, cwd: '/work' };
    const terminals = new FakeTerminals();
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: null, toolCalls: [{
        id: 'write-1',
        name: 'file_write',
        arguments: JSON.stringify({
          path: 'new.ts', content: 'export {};\n', expectedSha256: null,
        }),
      }] } },
      { message: { role: 'assistant', content: 'written' } },
    ]);
    const fileService = {
      bindWorkspaceRoot: vi.fn().mockResolvedValue('/work'),
      writeText: vi.fn().mockResolvedValue({
        path: '/work/new.ts', bytes: 11, sha256: 'a'.repeat(64), created: true,
      }),
    } as unknown as AgentFileService;
    const service = new AgentService(
      terminals as unknown as TerminalService,
      sessions as unknown as SessionManager,
      providerStore(),
      () => provider,
      undefined,
      fileService,
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
    );
    expect(sessions.audits).toContainEqual({
      type: 'file_permission_changed',
      details: { mode: 'read-write', root: '/work', ephemeral: true },
    });
    const modified = sessions.audits.find((audit) => audit.type === 'file_modified');
    expect(modified?.details).toEqual({ path: '/work/new.ts', sha256: 'a'.repeat(64), bytes: 11 });
    expect(JSON.stringify(modified)).not.toContain('export');
  });

  it('hydrates the persisted AI conversation when a Session reconnects to a new terminal', () => {
    const sessions = new FakeSessions();
    sessions.session = {
      ...sessions.session,
      runtimeTerminalId: 'reconnected-terminal',
      aiThreadId: '22222222-2222-2222-2222-222222222222',
      agentBackend: { kind: 'generic-provider', providerId: 'provider' },
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
      () => { throw new Error('Generic Provider must not be used.'); },
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
      const view = call[1] as {
        streamingMessageId?: string;
        messages?: Array<{ id: string; content: string }>;
      };
      return Boolean(view?.streamingMessageId)
        && view.messages?.at(-1)?.content === '**部分输出';
    }));
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
      () => { throw new Error('Generic Provider must not be used.'); },
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
      () => provider,
    );

    service.sendPrompt(owner, { terminalId: 'terminal', prompt: 'Stream Markdown.' });
    await waitFor(() => Boolean(provider.request));
    provider.push('**正在');
    provider.push('生成');

    await waitFor(() => send.mock.calls.some((call) => {
      const view = call[1] as { streamingMessageId?: string; messages?: Array<{ content: string }> };
      return Boolean(view?.streamingMessageId)
        && view.messages?.at(-1)?.content === '**正在生成';
    }));
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
      () => provider,
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
      () => { throw new Error('Generic Provider must not be used.'); },
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
      () => new FakeProvider([]),
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => normalProvider,
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
      () => takeoverProvider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => provider,
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
      () => { throw new Error('Generic Provider must not be used.'); },
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
      () => { throw new Error('Generic Provider must not be used.'); },
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
      (providerId) => providerId === firstProfile.id ? firstProvider : secondProvider,
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
