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
  it('uses native workspaceWrite tools and exposes only terminal_read when allowed', async () => {
    const workspaceRoot = resolve('app-server-agent-workspace');
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(workspaceRoot);
    const tools = createTools();
    runner.attach(connection);

    const resultPromise = runner.run(createInput({ tools, reasoningEffort: 'high' }));
    const threadStart = await waitForRequest(connection, 'thread/start');
    const turnStart = await waitForRequest(connection, 'turn/start');

    expect(threadStart.params).toMatchObject({
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      dynamicTools: CODEX_TERMINAL_DYNAMIC_TOOLS,
      serviceName: 'ai_terminal',
    });
    expect(asRecord(threadStart.params).developerInstructions).toEqual(expect.stringContaining(
      "Use Codex's built-in shell and file tools",
    ));
    expect(turnStart.params).toMatchObject({
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [workspaceRoot],
        networkAccess: false,
      },
      effort: 'high',
    });

    const read = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'read-1',
      tool: 'terminal_read', arguments: { maxChars: 500 },
    }));
    expect(read.success).toBe(true);
    expect(tools.readTerminal).toHaveBeenCalledWith({ maxChars: 500 });

    for (const tool of ['terminal_state', 'terminal_execute']) {
      const rejected = asRecord(await connection.invoke('item/tool/call', {
        threadId: 'thread-new', turnId: 'turn-1', callId: `${tool}-1`, tool, arguments: {},
      }));
      expect(rejected.success).toBe(false);
    }

    completeTurn(connection);
    await expect(resultPromise).resolves.toMatchObject({
      status: 'completed', finalText: 'Finished safely.',
    });
  });

  it('registers no terminal tools when terminal context access is disabled', async () => {
    const connection = new FakeConnection();
    const runner = new CodexAppServerTurnRunner(resolve('app-server-agent-workspace'));
    runner.attach(connection);
    const resultPromise = runner.run(createInput({ terminalContextAccess: false }));
    const threadStart = await waitForRequest(connection, 'thread/start');
    expect(asRecord(threadStart.params).dynamicTools).toEqual([]);
    await waitForRequest(connection, 'turn/start');
    const rejected = asRecord(await connection.invoke('item/tool/call', {
      threadId: 'thread-new', turnId: 'turn-1', callId: 'read-disabled',
      tool: 'terminal_read', arguments: {},
    }));
    expect(rejected.success).toBe(false);
    completeTurn(connection);
    await expect(resultPromise).resolves.toMatchObject({ status: 'completed' });
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
      sandbox: 'workspace-write', dynamicTools: [],
    });
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
  });
});
