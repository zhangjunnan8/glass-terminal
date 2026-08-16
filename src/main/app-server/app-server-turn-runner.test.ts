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

interface RecordedRequest { method: string; params?: unknown }

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a record.');
  }
  return value as Record<string, unknown>;
}

function turnInputText(params: unknown): string {
  const input = asRecord(params).input;
  if (!Array.isArray(input) || !input.length) throw new Error('Missing turn input.');
  const text = asRecord(input[0]).text;
  if (typeof text !== 'string') throw new Error('Missing turn input text.');
  return text;
}

class FakeConnection implements AppServerConnection {
  readonly requests: RecordedRequest[] = [];
  responder?: (method: string, params: unknown) => unknown | Promise<unknown>;
  private readonly notificationListeners = new Set<(
    notification: AppServerNotification,
  ) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private requestHandler?: AppServerRequestHandler;

  request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (this.responder) return Promise.resolve(this.responder(method, params)) as Promise<T>;
    if (method === 'permissionProfile/list') {
      return Promise.resolve({
        data: [{ id: ':workspace', description: null, allowed: true }],
        nextCursor: null,
      }) as Promise<T>;
    }
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: 'thread-new' } }) as Promise<T>;
    }
    if (method === 'thread/resume') {
      return Promise.resolve({ thread: { id: asRecord(params).threadId } }) as Promise<T>;
    }
    if (method === 'turn/start') {
      return Promise.resolve({
        turn: { id: 'turn-1', status: 'inProgress', items: [] },
      }) as Promise<T>;
    }
    if (method === 'turn/interrupt') return Promise.resolve({}) as Promise<T>;
    return Promise.reject(new Error(`Unexpected request: ${method}`));
  }

  notify(): void {}

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

  close(): void {}

  emit(method: string, params?: unknown): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  invoke(method: string, params?: unknown): Promise<unknown> {
    if (!this.requestHandler) return Promise.reject(new Error('No request handler.'));
    return Promise.resolve(this.requestHandler({ id: 1, method, params } as AppServerRequest));
  }
}

function createTools(): CodexAppServerTurnTools {
  return {
    readTerminal: vi.fn(async ({ maxChars }) => `last ${maxChars} chars`),
    getTerminalState: vi.fn(async () => ({
      transport: 'ssh' as const,
      target: {
        label: 'Ubuntu VM',
        hostname: '192.168.31.93',
        port: 22,
        username: 'zjn',
      },
      cwd: '/home/zjn/project',
      effectiveUser: 'zjn',
      shellKind: 'posix' as const,
      connectionState: 'connected' as const,
    })),
  };
}

function createInput(overrides: Partial<RunCodexTurnInput> = {}): RunCodexTurnInput {
  return {
    prompt: 'Inspect the task',
    model: 'gpt-5.4',
    signal: new AbortController().signal,
    tools: createTools(),
    terminalContextAccess: true,
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

describe('CodexAppServerTurnRunner native mode', () => {
  it('binds an SSH terminal to every turn and exposes only read-only terminal context tools', async () => {
    const workspaceRoot = resolve('app-server-agent-workspace');
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(workspaceRoot);
    const tools = createTools();
    runner.attach(connection);

    const resultPromise = runner.run(createInput({ tools, reasoningEffort: 'high' }));
    const profileList = await waitForRequest(connection, 'permissionProfile/list');
    const threadStart = await waitForRequest(connection, 'thread/start');
    const turnStart = await waitForRequest(connection, 'turn/start');

    expect(profileList.params).toEqual({ cwd: workspaceRoot });
    expect(threadStart.params).toMatchObject({
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      approvalPolicy: 'never',
      permissions: ':workspace',
      dynamicTools: CODEX_TERMINAL_DYNAMIC_TOOLS,
      serviceName: 'ai_terminal',
    });
    expect(asRecord(threadStart.params)).not.toHaveProperty('sandbox');
    expect(asRecord(threadStart.params).developerInstructions).toEqual(expect.stringContaining(
      "Use Codex's built-in shell and file tools",
    ));
    expect(turnStart.params).toMatchObject({
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      approvalPolicy: 'never',
      permissions: ':workspace',
      effort: 'high',
    });
    expect(asRecord(turnStart.params)).not.toHaveProperty('sandboxPolicy');
    expect(JSON.stringify(turnStart.params)).not.toContain('readOnlyAccess');
    const turnText = turnInputText(turnStart.params);
    expect(turnText).toContain('ai_terminal_binding');
    expect(turnText).toContain('192.168.31.93');
    expect(turnText).toContain('/home/zjn/project');
    expect(turnText).toContain('local ');
    expect(turnText).toContain('App Server process');
    expect(turnText).toContain('must never be described as having run on the SSH target');

    const read = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'read-1',
      tool: 'terminal_read', arguments: { maxChars: 500 },
    }));
    expect(read.success).toBe(true);
    expect(tools.readTerminal).toHaveBeenCalledWith({ maxChars: 500 });

    const state = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'terminal_state-1',
      tool: 'terminal_state', arguments: {},
    }));
    expect(state.success).toBe(true);
    expect(JSON.stringify(state)).toContain('192.168.31.93');
    expect(tools.getTerminalState).toHaveBeenCalledTimes(2);

    const rejected = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'terminal_execute-1',
      tool: 'terminal_execute', arguments: {},
    }));
    expect(rejected.success).toBe(false);

    completeTurn(connection);
    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed', finalText: 'Finished safely.',
    });
  });

  it('always injects terminal identity but registers no tools when terminal read is disabled', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ terminalContextAccess: false }));
    const threadStart = await waitForRequest(connection, 'thread/start');
    expect(asRecord(threadStart.params).dynamicTools).toEqual([]);
    const turnStart = await waitForRequest(connection, 'turn/start');
    expect(turnInputText(turnStart.params)).toContain('192.168.31.93');
    expect(turnInputText(turnStart.params)).toContain('"terminalHistory": "disabled"');
    for (const tool of ['terminal_read', 'terminal_state']) {
      const rejected = asRecord(await connection.invoke('item/tool/call', {
        threadId: 'thread-new', turnId: 'turn-1', callId: `${tool}-disabled`,
        tool, arguments: {},
      }));
      expect(rejected.success).toBe(false);
    }
    completeTurn(connection);
    await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('injects local terminal metadata without leaking extra sensitive fields', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    const tools = createTools();
    vi.mocked(tools.getTerminalState).mockResolvedValue({
      transport: 'local',
      target: { label: 'PowerShell', password: 'nested-secret' },
      cwd: 'C:\\Users\\tester\\project',
      effectiveUser: 'tester',
      shellKind: 'powershell',
      connectionState: 'connected',
      hostId: 'must-not-leak',
      password: 'super-secret',
    } as never);
    runner.attach(connection);

    const resultPromise = runner.run(createInput({ tools, terminalContextAccess: false }));
    const turnStart = await waitForRequest(connection, 'turn/start');
    const serialized = turnInputText(turnStart.params);
    expect(serialized).toContain('PowerShell');
    expect(serialized).toContain('C:\\\\Users\\\\tester\\\\project');
    expect(serialized).toContain('independent local workspace');
    expect(serialized).not.toContain('must-not-leak');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('nested-secret');
    completeTurn(connection);
    await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('refreshes the terminal cwd for every resumed turn', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    const tools = createTools();
    const getTerminalState = vi.mocked(tools.getTerminalState);
    runner.attach(connection);

    const first = runner.run(createInput({ tools, threadId: 'thread-existing' }));
    await vi.waitFor(() => {
      expect(connection.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(1);
    });
    const firstTurn = connection.requests.filter(({ method }) => method === 'turn/start')[0];
    expect(turnInputText(firstTurn.params)).toContain('/home/zjn/project');
    completeTurn(connection, 'thread-existing');
    await expect(first).resolves.toMatchObject({ status: 'completed' });

    getTerminalState.mockResolvedValue({
      transport: 'ssh',
      target: {
        label: 'Ubuntu VM', hostname: '192.168.31.93', port: 22, username: 'zjn',
      },
      cwd: '/srv/updated',
      effectiveUser: 'root',
      shellKind: 'posix',
      connectionState: 'connected',
    });
    const second = runner.run(createInput({ tools, threadId: 'thread-existing' }));
    await vi.waitFor(() => {
      expect(connection.requests.filter(({ method }) => method === 'turn/start')).toHaveLength(2);
    });
    const secondTurn = connection.requests.filter(({ method }) => method === 'turn/start')[1];
    expect(turnInputText(secondTurn.params)).toContain('/srv/updated');
    expect(turnInputText(secondTurn.params)).toContain('root');
    completeTurn(connection, 'thread-existing');
    await expect(second).resolves.toMatchObject({ status: 'completed' });
  });

  it('accepts native command/file approvals without visible-terminal lockout', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    const onNativeApproval = vi.fn();
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ onNativeApproval }));
    await waitForRequest(connection, 'turn/start');

    connection.emit('item/started', {
      threadId: 'thread-new', turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', status: 'inProgress' },
    });
    connection.emit('item/completed', {
      threadId: 'thread-new', turnId: 'turn-1',
      item: { id: 'file-1', type: 'fileChange', status: 'completed' },
    });
    await expect(connection.invoke('item/commandExecution/requestApproval', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'command-1',
    })).resolves.toEqual({ decision: 'acceptForSession' });
    await expect(connection.invoke('item/fileChange/requestApproval', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'file-1',
    })).resolves.toEqual({ decision: 'acceptForSession' });
    expect(onNativeApproval).toHaveBeenCalledTimes(2);

    completeTurn(connection);
    await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('declines requests to expand the native workspace sandbox', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    const onNativeApproval = vi.fn();
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ onNativeApproval }));
    await waitForRequest(connection, 'turn/start');

    await expect(connection.invoke('item/permissions/requestApproval', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'permission-1',
    })).resolves.toEqual({ permissions: {}, scope: 'turn' });
    expect(onNativeApproval).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'permission-request', decision: 'decline-extra-permissions',
    }));
    completeTurn(connection);
    await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('reapplies native configuration and tool visibility on resume', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput({
      threadId: 'thread-existing', terminalContextAccess: false,
    }));
    const resume = await waitForRequest(connection, 'thread/resume');
    expect(resume.params).toMatchObject({
      threadId: 'thread-existing', approvalPolicy: 'never',
      permissions: ':workspace', dynamicTools: [],
    });
    expect(asRecord(resume.params)).not.toHaveProperty('sandbox');
    await waitForRequest(connection, 'turn/start');
    completeTurn(connection, 'thread-existing');
    await expect(resultPromise).resolves.toMatchObject({ threadId: 'thread-existing' });
  });

  it('streams final text and interrupts through the native turn API', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    const controller = new AbortController();
    const onDelta = vi.fn();
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ signal: controller.signal, onDelta }));
    await waitForRequest(connection, 'turn/start');
    connection.emit('item/agentMessage/delta', {
      threadId: 'thread-new', turnId: 'turn-1', itemId: 'message-1', delta: 'Hello',
    });
    expect(onDelta).toHaveBeenCalledWith('Hello');
    controller.abort();
    await waitForRequest(connection, 'turn/interrupt');
    completeTurn(connection, 'thread-new', 'turn-1', 'Hello', 'interrupted');
    await expect(resultPromise).resolves.toMatchObject({ status: 'interrupted' });
  });

  it('rejects the interrupt and quarantines the connection when stop is not acknowledged', async () => {
    const connection = new FakeConnection();
    connection.responder = (method) => {
      if (method === 'permissionProfile/list') {
        return { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      }
      if (method === 'thread/start') return { thread: { id: 'thread-new' } };
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
      }
      if (method === 'turn/interrupt') throw new Error('interrupt rejected');
      throw new Error(`Unexpected request: ${method}`);
    };
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput());
    await waitForRequest(connection, 'turn/start');

    await expect(runner.interrupt()).rejects.toThrow('interrupt rejected');
    await expect(resultPromise).rejects.toThrow('interrupt rejected');
    await expect(runner.run(createInput())).rejects.toThrow('上一轮状态无法安全确认');
  });

  it('keeps the connection reusable after an ordinary JSON-RPC request rejection', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    let threadStarts = 0;
    connection.responder = (method, params) => {
      if (method === 'permissionProfile/list') {
        return { data: [{ id: ':workspace', allowed: true }], nextCursor: null };
      }
      if (method === 'thread/start') {
        threadStarts += 1;
        if (threadStarts === 1) {
          throw new Error(
            'Codex App Server：Invalid request: unknown variant `workspaceWrite`',
          );
        }
        return { thread: { id: 'thread-retry' } };
      }
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
      }
      if (method === 'turn/interrupt') return {};
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(params)}`);
    };
    runner.attach(connection);

    await expect(runner.run(createInput())).rejects.toThrow('Invalid request');

    const retried = runner.run(createInput());
    await waitForRequest(connection, 'turn/start');
    completeTurn(connection, 'thread-retry');
    await expect(retried).resolves.toMatchObject({
      threadId: 'thread-retry', status: 'completed',
    });
    expect(threadStarts).toBe(2);
    expect(connection.requests.filter(({ method }) => method === 'permissionProfile/list'))
      .toHaveLength(1);
  });

  it('falls back to the legacy workspace sandbox only when profile discovery is unsupported', async () => {
    const connection = new FakeConnection();
    connection.responder = (method, params) => {
      if (method === 'permissionProfile/list') {
        throw new Error('Codex App Server：Method not found: permissionProfile/list');
      }
      if (method === 'thread/start') return { thread: { id: 'thread-legacy' } };
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1', status: 'inProgress', items: [] } };
      }
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(params)}`);
    };
    const workspaceRoot = resolve('app-server-agent-workspace');
    const runner = new CodexAppServerTurnRunner(workspaceRoot);
    runner.attach(connection);

    const resultPromise = runner.run(createInput());
    const threadStart = await waitForRequest(connection, 'thread/start');
    const turnStart = await waitForRequest(connection, 'turn/start');
    expect(threadStart.params).toMatchObject({ sandbox: 'workspace-write' });
    expect(asRecord(threadStart.params)).not.toHaveProperty('permissions');
    expect(turnStart.params).toMatchObject({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [workspaceRoot],
        networkAccess: false,
      },
    });
    expect(asRecord(turnStart.params)).not.toHaveProperty('permissions');
    expect(JSON.stringify(turnStart.params)).not.toContain('readOnlyAccess');
    completeTurn(connection, 'thread-legacy');
    await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });
  });

  it('fails closed when the managed policy denies the workspace permission profile', async () => {
    const connection = new FakeConnection();
    connection.responder = (method) => {
      if (method === 'permissionProfile/list') {
        return { data: [{ id: ':workspace', allowed: false }], nextCursor: null };
      }
      throw new Error(`Unexpected request: ${method}`);
    };
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    runner.attach(connection);

    await expect(runner.run(createInput())).rejects.toThrow('不允许 :workspace');
    expect(connection.requests.some(({ method }) => method === 'thread/start')).toBe(false);
  });
});
