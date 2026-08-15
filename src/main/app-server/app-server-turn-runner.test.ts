import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  AppServerConnection,
  AppServerNotification,
  AppServerRequest,
  AppServerRequestHandler,
} from './app-server-client';
import {
  CODEX_TERMINAL_DYNAMIC_TOOLS,
  CodexAppServerTurnRunner,
  type CodexAppServerTurnTools,
  type RunCodexTurnInput,
} from './app-server-turn-runner';

interface RecordedRequest {
  method: string;
  params?: unknown;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a record.');
  }
  return value as Record<string, unknown>;
}

class FakeConnection implements AppServerConnection {
  readonly requests: RecordedRequest[] = [];
  readonly notifications: RecordedRequest[] = [];
  closed = false;
  responder?: (method: string, params: unknown) => unknown | Promise<unknown>;
  private readonly notificationListeners = new Set<(
    notification: AppServerNotification,
  ) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private requestHandler?: AppServerRequestHandler;

  request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (this.responder) {
      return Promise.resolve(this.responder(method, params)) as Promise<T>;
    }
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'thread-new' } }) as Promise<T>;
    }
    if (method === 'thread/resume') {
      return Promise.resolve({
        thread: { id: asRecord(params).threadId },
      }) as Promise<T>;
    }
    if (method === 'turn/start') {
      return Promise.resolve({
        turn: { id: 'turn-1', status: 'inProgress', items: [] },
      }) as Promise<T>;
    }
    if (method === 'turn/interrupt') return Promise.resolve({}) as Promise<T>;
    return Promise.reject(new Error(`Unexpected request: ${method}`));
  }

  notify(method: string, params?: unknown): void {
    this.notifications.push({ method, params });
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(handler: AppServerRequestHandler): () => void {
    if (this.requestHandler) throw new Error('Request handler already registered.');
    this.requestHandler = handler;
    return () => {
      if (this.requestHandler === handler) this.requestHandler = undefined;
    };
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(method: string, params?: unknown): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  exit(error = new Error('fake connection exited')): void {
    for (const listener of this.exitListeners) listener(error);
  }

  invoke(method: string, params?: unknown, id: number | string = 1): Promise<unknown> {
    if (!this.requestHandler) return Promise.reject(new Error('No request handler.'));
    return Promise.resolve(this.requestHandler({ id, method, params } as AppServerRequest));
  }

  listenerCounts(): { notifications: number; requests: number; exits: number } {
    return {
      notifications: this.notificationListeners.size,
      requests: this.requestHandler ? 1 : 0,
      exits: this.exitListeners.size,
    };
  }
}

function createTools(): CodexAppServerTurnTools {
  return {
    readTerminal: vi.fn(async ({ maxChars }) => `last ${maxChars} chars`),
    getTerminalState: vi.fn(async () => ({ connected: true, mode: 'control' })),
    executeCommand: vi.fn(async ({ command }) => ({
      executionId: 'execution-1',
      command,
      status: 'completed' as const,
      exitCode: 0,
      output: 'done',
    })),
  };
}

function createInput(
  overrides: Partial<RunCodexTurnInput> = {},
): RunCodexTurnInput {
  return {
    prompt: 'Inspect the visible terminal',
    model: 'gpt-5.4',
    signal: new AbortController().signal,
    tools: createTools(),
    ...overrides,
  };
}

async function waitForRequest(
  connection: FakeConnection,
  method: string,
): Promise<RecordedRequest> {
  await vi.waitFor(() => {
    expect(connection.requests.some((request) => request.method === method)).toBe(true);
  });
  return connection.requests.find((request) => request.method === method)!;
}

function completeTurn(
  connection: FakeConnection,
  threadId = 'thread-new',
  turnId = 'turn-1',
  text = 'Finished safely.',
  status: 'completed' | 'interrupted' | 'failed' = 'completed',
): void {
  connection.emit('turn/completed', {
    threadId,
    turn: {
      id: turnId,
      status,
      items: [{ id: 'message-1', type: 'agentMessage', phase: 'final_answer', text }],
      ...(status === 'failed' ? { error: { message: 'turn failed' } } : {}),
    },
  });
}

describe('CodexAppServerTurnRunner', () => {
  it('starts an isolated thread and routes only the three exact dynamic tools', async () => {
    const sandboxRoot = resolve('app-server-agent-sandbox');
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(sandboxRoot);
    const tools = createTools();
    const onDelta = vi.fn();
    const onThreadBound = vi.fn();
    runner.attach(connection);

    const resultPromise = runner.run(createInput({
      reasoningEffort: 'high',
      tools,
      onDelta,
      onThreadBound,
    }));
    const threadStart = await waitForRequest(connection, 'thread/start');
    const turnStart = await waitForRequest(connection, 'turn/start');

    expect(threadStart.params).toMatchObject({
      model: 'gpt-5.4',
      cwd: sandboxRoot,
      runtimeWorkspaceRoots: [],
      environments: [],
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      dynamicTools: CODEX_TERMINAL_DYNAMIC_TOOLS,
    });
    expect(asRecord(threadStart.params).developerInstructions).toEqual(expect.stringContaining(
      'Use only terminal_read, terminal_state, and terminal_execute',
    ));
    expect(turnStart.params).toEqual({
      threadId: 'thread-new',
      input: [{ type: 'text', text: 'Inspect the visible terminal' }],
      cwd: sandboxRoot,
      runtimeWorkspaceRoots: [],
      environments: [],
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      model: 'gpt-5.4',
      effort: 'high',
    });

    const read = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'call-read',
      tool: 'terminal_read',
      arguments: { maxChars: 400 },
    }));
    const state = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'call-state',
      tool: 'terminal_state',
      arguments: {},
    }));
    const execute = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      callId: 'call-execute',
      tool: 'terminal_execute',
      arguments: { command: 'pwd', reason: 'show the shared location' },
    }));

    expect(tools.readTerminal).toHaveBeenCalledWith({ maxChars: 400 });
    expect(tools.getTerminalState).toHaveBeenCalledTimes(1);
    expect(tools.executeCommand).toHaveBeenCalledWith(
      { command: 'pwd', reason: 'show the shared location' },
      expect.any(AbortSignal),
    );
    expect(JSON.parse(asRecord((read.contentItems as unknown[])[0]).text as string)).toEqual({
      ok: true,
      output: 'last 400 chars',
    });
    expect(JSON.parse(asRecord((state.contentItems as unknown[])[0]).text as string)).toEqual({
      ok: true,
      state: { connected: true, mode: 'control' },
    });
    expect(JSON.parse(asRecord((execute.contentItems as unknown[])[0]).text as string)).toMatchObject({
      ok: true,
      result: { command: 'pwd', status: 'completed', output: 'done' },
    });

    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'message-1', delta: 'Finished ',
    });
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'message-1', delta: 'safely.',
    });
    completeTurn(connection);

    await expect(resultPromise).resolves.toEqual({
      threadId: 'thread-new',
      turnId: 'turn-1',
      status: 'completed',
      finalText: 'Finished safely.',
    });
    expect(onDelta.mock.calls.flat()).toEqual(['Finished ', 'safely.']);
    expect(onThreadBound).toHaveBeenCalledOnce();
    expect(onThreadBound).toHaveBeenCalledWith('thread-new');
  });

  it('keeps commentary separate and streams only the final-answer item', async () => {
    const connection = new FakeConnection();
    const onDelta = vi.fn();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ onDelta }));
    await waitForRequest(connection, 'turn/start');

    connection.emit('item/started', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      item: { id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: '' },
    });
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'commentary-1', delta: 'Internal note.',
    });
    connection.emit('item/completed', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      item: {
        id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: 'Internal note.',
      },
    });
    connection.emit('item/started', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      item: { id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '' },
    });
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'final-1', delta: '**Visible',
    });
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'final-1', delta: ' answer**',
    });
    connection.emit('item/completed', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      item: {
        id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '**Visible answer**',
      },
    });
    connection.emit('turn/completed', {
      threadId: 'thread-new',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'commentary-1', type: 'agentMessage', phase: 'commentary', text: 'Internal note.',
          },
          {
            id: 'final-1', type: 'agentMessage', phase: 'final_answer', text: '**Visible answer**',
          },
        ],
      },
    });

    await expect(resultPromise).resolves.toMatchObject({ finalText: '**Visible answer**' });
    expect(onDelta.mock.calls.flat()).toEqual(['**Visible', ' answer**']);
  });

  it('resumes only the exact requested thread and reapplies per-turn isolation', async () => {
    const sandboxRoot = resolve('app-server-agent-sandbox');
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(sandboxRoot);
    runner.attach(connection);

    const resultPromise = runner.run(createInput({ threadId: 'thread-existing' }));
    const resume = await waitForRequest(connection, 'thread/resume');
    const turnStart = await waitForRequest(connection, 'turn/start');

    expect(resume.params).toMatchObject({
      threadId: 'thread-existing',
      model: 'gpt-5.4',
      cwd: sandboxRoot,
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'untrusted',
      sandbox: 'read-only',
      developerInstructions: expect.stringContaining('terminal_execute'),
    });
    expect(turnStart.params).toMatchObject({
      threadId: 'thread-existing',
      cwd: sandboxRoot,
      runtimeWorkspaceRoots: [],
      environments: [],
      approvalPolicy: 'untrusted',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    });

    completeTurn(connection, 'thread-existing');
    await expect(resultPromise).resolves.toMatchObject({
      threadId: 'thread-existing',
      status: 'completed',
    });
  });

  it('does not lose completion notifications that precede the turn/start response', async () => {
    const turnStartResponse = deferred<unknown>();
    const connection = new FakeConnection();
    connection.responder = (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new' } };
      if (method === 'turn/start') return turnStartResponse.promise;
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(params)}`);
    };
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);

    let settled = false;
    const resultPromise = runner.run(createInput());
    void resultPromise.finally(() => { settled = true; });
    await waitForRequest(connection, 'turn/start');
    connection.emit('turn/started', {
      threadId: 'thread-new',
      turn: { id: 'turn-early', status: 'inProgress', items: [] },
    });
    completeTurn(connection, 'thread-new', 'turn-early', 'early completion');
    await Promise.resolve();
    expect(settled).toBe(false);

    turnStartResponse.resolve({
      turn: { id: 'turn-early', status: 'inProgress', items: [] },
    });
    await expect(resultPromise).resolves.toMatchObject({
      turnId: 'turn-early',
      finalText: 'early completion',
    });
  });

  it('validates exact dynamic-tool scope and consumes every callId at most once', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput());
    await waitForRequest(connection, 'turn/start');
    connection.emit('turn/started', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });

    await expect(connection.invoke('item/tool/call', {
      threadId: 'thread-other', turnId: 'turn-1', callId: 'wrong-thread',
      tool: 'terminal_state', arguments: {},
    })).rejects.toThrow('threadId');
    await expect(connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-other', callId: 'wrong-turn',
      tool: 'terminal_state', arguments: {},
    })).rejects.toThrow('turnId');
    await expect(connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'once',
      tool: 'terminal_state', arguments: {},
    })).resolves.toMatchObject({ success: true });
    await expect(connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'once',
      tool: 'terminal_state', arguments: {},
    })).rejects.toThrow('已处理');

    completeTurn(connection);
    await resultPromise;
  });

  it('declines built-in actions and fails closed when command or file activity appears', async () => {
    const connection = new FakeConnection();
    const onIsolationViolation = vi.fn();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'), {
      onIsolationViolation,
    });
    runner.attach(connection);

    await expect(connection.invoke('item/permissions/requestApproval', {})).resolves.toEqual({
      permissions: {},
    });
    await expect(connection.invoke('mcpServer/elicitation/request', {})).resolves.toEqual({
      action: 'cancel',
      content: null,
    });

    const resultPromise = runner.run(createInput());
    await waitForRequest(connection, 'turn/start');
    await expect(connection.invoke('item/fileChange/requestApproval', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'file-change-1',
    })).resolves.toEqual({ decision: 'decline' });
    await expect(resultPromise).rejects.toThrow('隔离违规');
    expect(onIsolationViolation).toHaveBeenCalledWith({
      kind: 'file-change',
      detail: expect.stringContaining('item/fileChange/requestApproval'),
    });
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });

    const nextConnection = new FakeConnection();
    runner.attach(nextConnection);
    const nextRun = runner.run(createInput());
    await waitForRequest(nextConnection, 'turn/start');
    nextConnection.emit('item/started', {
      threadId: 'thread-new',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'whoami' },
    });
    await expect(nextRun).rejects.toThrow('隔离违规');
    expect(onIsolationViolation).toHaveBeenLastCalledWith({
      kind: 'command-execution',
      detail: expect.stringContaining('commandExecution'),
    });
    expect(nextConnection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });
  });

  it('retains a pre-response isolation violation until the exact turn can be interrupted', async () => {
    const turnStartResponse = deferred<unknown>();
    const connection = new FakeConnection();
    connection.responder = (method, params) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new' } };
      if (method === 'turn/start') return turnStartResponse.promise;
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(params)}`);
    };
    const onIsolationViolation = vi.fn();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'), {
      onIsolationViolation,
    });
    runner.attach(connection);
    const resultPromise = runner.run(createInput());
    await waitForRequest(connection, 'turn/start');

    await expect(connection.invoke('item/commandExecution/requestApproval', {
      threadId: 'thread-new',
      turnId: 'turn-before-response',
      itemId: 'command-before-response',
    })).resolves.toEqual({ decision: 'decline' });
    expect(connection.requests.some((request) => request.method === 'turn/interrupt')).toBe(false);

    turnStartResponse.resolve({
      turn: { id: 'turn-before-response', status: 'inProgress', items: [] },
    });
    await expect(resultPromise).rejects.toThrow('隔离违规');
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-before-response' },
    });
    expect(onIsolationViolation).toHaveBeenCalledTimes(1);
  });

  it('returns empty permissions while interrupting and reporting an active permission request', async () => {
    const connection = new FakeConnection();
    const onIsolationViolation = vi.fn();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'), {
      onIsolationViolation,
    });
    runner.attach(connection);
    const resultPromise = runner.run(createInput());
    await waitForRequest(connection, 'turn/start');
    connection.emit('turn/started', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });

    await expect(connection.invoke('item/permissions/requestApproval', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'permissions-1',
    })).resolves.toEqual({ permissions: {} });
    await expect(resultPromise).rejects.toThrow('隔离违规');
    expect(onIsolationViolation).toHaveBeenCalledWith({
      kind: 'permission-request',
      detail: expect.stringContaining('item/permissions/requestApproval'),
    });
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });
  });

  it('interrupts on AbortSignal and waits for the terminal turn notification', async () => {
    const abortController = new AbortController();
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ signal: abortController.signal }));
    await waitForRequest(connection, 'turn/start');
    connection.emit('turn/started', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });

    abortController.abort();
    await waitForRequest(connection, 'turn/interrupt');
    completeTurn(connection, 'thread-new', 'turn-1', 'partial', 'interrupted');

    await expect(resultPromise).resolves.toEqual({
      threadId: 'thread-new',
      turnId: 'turn-1',
      status: 'interrupted',
      finalText: 'partial',
    });
  });

  it('quarantines a failed connection and never binds stale pre-response Turn activity', async () => {
    const firstConnection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    const firstTools = createTools();
    runner.attach(firstConnection);
    const firstRun = runner.run(createInput({ tools: firstTools }));
    const firstFailure = firstRun.then(() => undefined, (error: Error) => error);
    await waitForRequest(firstConnection, 'turn/start');

    firstConnection.emit('item/completed', {
      threadId: 'thread-new',
      turnId: 'turn-1',
    });
    expect((await firstFailure)?.message).toContain('item');
    expect(firstConnection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });
    await expect(runner.run(createInput({ threadId: 'thread-new' }))).rejects.toThrow('隔离');

    firstConnection.emit('turn/started', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    await expect(firstConnection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'stale-first-call',
      tool: 'terminal_execute', arguments: { command: 'must-not-run' },
    })).rejects.toThrow('当前没有');
    expect(firstTools.executeCommand).not.toHaveBeenCalled();

    const turnStartResponse = deferred<unknown>();
    const replacement = new FakeConnection();
    replacement.responder = (method, params) => {
      if (method === 'thread/resume') return { thread: { id: asRecord(params).threadId } };
      if (method === 'turn/start') return turnStartResponse.promise;
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected request: ${method}`);
    };
    const secondTools = createTools();
    runner.attach(replacement);
    const secondRun = runner.run(createInput({ threadId: 'thread-new', tools: secondTools }));
    await waitForRequest(replacement, 'turn/start');

    replacement.emit('turn/started', {
      threadId: 'thread-new',
      turn: { id: 'turn-1', status: 'inProgress', items: [] },
    });
    await expect(replacement.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'stale-pending-call',
      tool: 'terminal_execute', arguments: { command: 'still-must-not-run' },
    })).rejects.toThrow('exact turn/start');
    expect(secondTools.executeCommand).not.toHaveBeenCalled();

    turnStartResponse.resolve({
      turn: { id: 'turn-2', status: 'inProgress', items: [] },
    });
    await vi.waitFor(async () => {
      await expect(replacement.invoke('item/tool/call', {
        threadId: 'thread-new', turnId: 'turn-2', callId: 'current-call',
        tool: 'terminal_execute', arguments: { command: 'allowed-after-exact-response' },
      })).resolves.toMatchObject({ success: true });
    });
    expect(secondTools.executeCommand).toHaveBeenCalledTimes(1);
    completeTurn(replacement, 'thread-new', 'turn-2');
    await expect(secondRun).resolves.toMatchObject({ turnId: 'turn-2', status: 'completed' });
  });

  it('enforces the 100,000-character aggregate and authoritative completion limits', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);
    const aggregateRun = runner.run(createInput());
    const aggregateFailure = aggregateRun.then(() => undefined, (error: Error) => error);
    await waitForRequest(connection, 'turn/start');
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'message-a', delta: 'a'.repeat(60_000),
    });
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'message-b', delta: 'b'.repeat(40_001),
    });
    expect((await aggregateFailure)?.message).toContain('100000');
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });

    const authoritativeConnection = new FakeConnection();
    const authoritativeRunner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    authoritativeRunner.attach(authoritativeConnection);
    const authoritativeRun = authoritativeRunner.run(createInput());
    const authoritativeFailure = authoritativeRun.then(() => undefined, (error: Error) => error);
    await waitForRequest(authoritativeConnection, 'turn/start');
    completeTurn(authoritativeConnection, 'thread-new', 'turn-1', 'x'.repeat(100_001));
    expect((await authoritativeFailure)?.message).toContain('100000');
    await expect(authoritativeRunner.run(createInput())).rejects.toThrow('隔离');
  });

  it('allows 64 assistant items and quarantines the 65th', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput());
    const failure = resultPromise.then(() => undefined, (error: Error) => error);
    await waitForRequest(connection, 'turn/start');
    for (let index = 0; index < 65; index += 1) {
      connection.emit('item/started', {
        threadId: 'thread-new',
        turnId: 'turn-1',
        item: { id: `message-${index}`, type: 'agentMessage', text: '' },
      });
    }
    expect((await failure)?.message).toContain('64');
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });
  });

  it('allows 256 unique dynamic calls and rejects the 257th before execution', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    const tools = createTools();
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ tools }));
    const failure = resultPromise.then(() => undefined, (error: Error) => error);
    await waitForRequest(connection, 'turn/start');
    for (let index = 0; index < 256; index += 1) {
      await expect(connection.invoke('item/tool/call', {
        threadId: 'thread-new', turnId: 'turn-1', callId: `call-${index}`,
        tool: 'terminal_state', arguments: {},
      })).resolves.toMatchObject({ success: true });
    }
    await expect(connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'call-256',
      tool: 'terminal_execute', arguments: { command: 'must-not-run' },
    })).rejects.toThrow('256');
    expect((await failure)?.message).toContain('256');
    expect(tools.executeCommand).not.toHaveBeenCalled();
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-new', turnId: 'turn-1' },
    });
  });

  it('never refunds the monotonic streaming budget when an item snapshot shrinks', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    const onDelta = vi.fn();
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ onDelta }));
    const failure = resultPromise.then(() => undefined, (error: Error) => error);
    await waitForRequest(connection, 'turn/start');

    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'message-stream',
      phase: 'final_answer', delta: 'x'.repeat(100_000),
    });
    connection.emit('item/completed', {
      threadId: 'thread-new', turnId: 'turn-1',
      item: { id: 'message-stream', type: 'agentMessage', phase: 'final_answer', text: '' },
    });
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'message-stream',
      phase: 'final_answer', delta: 'y',
    });

    expect((await failure)?.message).toContain('100000');
    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta.mock.calls[0]?.[0]).toHaveLength(100_000);
    await expect(runner.run(createInput())).rejects.toThrow('隔离');
  });

  it('bounds the complete serialized payload buffered before turn/start responds', async () => {
    const turnStartResponse = deferred<unknown>();
    const connection = new FakeConnection();
    connection.responder = (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-new' } };
      if (method === 'turn/start') return turnStartResponse.promise;
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected request: ${method}`);
    };
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput());
    await waitForRequest(connection, 'turn/start');

    connection.emit('item/started', {
      threadId: 'thread-new', turnId: 'turn-pending',
      item: { id: 'reasoning-1', type: 'reasoning', metadata: 'z'.repeat(600_000) },
    });

    await expect(resultPromise).rejects.toThrow('通知缓冲超过安全上限');
    await expect(runner.run(createInput())).rejects.toThrow('隔离');
    turnStartResponse.resolve({
      turn: { id: 'turn-pending', status: 'inProgress', items: [] },
    });
  });

  it('rejects concurrent runs and detaches listeners while invalidating in-flight work', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-sandbox'));
    runner.attach(connection);
    const first = runner.run(createInput());

    await expect(runner.run(createInput())).rejects.toThrow('同一时间只能运行一个');
    runner.detach();
    await expect(first).rejects.toThrow('连接已分离');
    expect(connection.listenerCounts()).toEqual({ notifications: 0, requests: 0, exits: 0 });
    expect(connection.closed).toBe(false);

    const replacement = new FakeConnection();
    runner.attach(replacement);
    const next = runner.run(createInput());
    await waitForRequest(replacement, 'turn/start');
    completeTurn(replacement);
    await expect(next).resolves.toMatchObject({ status: 'completed' });
    runner.close();
    expect(replacement.listenerCounts()).toEqual({ notifications: 0, requests: 0, exits: 0 });
    await expect(runner.run(createInput())).rejects.toThrow('已关闭');
  });
});
