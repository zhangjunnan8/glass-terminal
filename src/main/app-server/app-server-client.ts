import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_CHARS = 32 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface AppServerConnection {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(listener: (notification: AppServerNotification) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
  close(): void;
}

export type SpawnCodexProcess = (
  executable: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class CodexAppServerClient implements AppServerConnection {
  private nextRequestId = 1;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private closed = false;
  private failure?: Error;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(
    notification: AppServerNotification,
  ) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.stdin.on('error', (error) => this.failTransport(
      new Error(`Codex App Server 标准输入失败：${safeErrorMessage(error)}`),
    ));
    child.stdout.on('error', (error) => this.failTransport(
      new Error(`Codex App Server 标准输出失败：${safeErrorMessage(error)}`),
    ));
    child.stderr.on('error', (error) => this.failTransport(
      new Error(`Codex App Server 错误输出失败：${safeErrorMessage(error)}`),
    ));
    child.once('error', (error) => this.fail(
      new Error(`无法启动 Codex App Server：${safeErrorMessage(error)}`),
    ));
    child.once('exit', (code, signal) => {
      const detail = signal ? `信号 ${signal}` : `退出码 ${code ?? '未知'}`;
      const stderr = this.stderrBuffer.trim();
      this.fail(new Error(
        `Codex App Server 已退出（${detail}）${stderr ? `：${stderr.slice(-500)}` : '。'}`,
      ));
    });
  }

  request<T>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex App Server 连接已关闭。'));
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.exitListeners.add(listener);
    if (this.failure) {
      const failure = this.failure;
      queueMicrotask(() => {
        if (this.exitListeners.has(listener)) this.callExitListener(listener, failure);
      });
    }
    return () => this.exitListeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('Codex App Server 连接已关闭。'));
    this.child.kill();
  }

  private write(message: unknown): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error('Codex App Server 连接不可写。');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
      if (error) {
        this.failTransport(new Error(
          `Codex App Server 标准输入失败：${safeErrorMessage(error)}`,
        ));
      }
    });
  }

  private handleStdout(chunk: string): void {
    if (this.closed) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_LINE_BYTES) {
      this.fail(new Error('Codex App Server 返回了过大的协议消息。'));
      this.child.kill();
      return;
    }
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
      if (this.closed) return;
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(new Error('Codex App Server 返回了无效 JSON。'));
      this.child.kill();
      return;
    }
    if (!isRecord(message)) return;

    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        const detail = typeof message.error.message === 'string'
          ? message.error.message
          : '未知协议错误';
        pending.reject(new Error(`Codex App Server：${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== 'string') return;
    if (typeof message.id === 'number' || typeof message.id === 'string') {
      try {
        this.write({
          id: message.id,
          error: {
            code: -32601,
            message: 'AI Terminal 当前未启用 App Server 工具请求。',
          },
        });
      } catch (error) {
        this.failTransport(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    const notification = { method: message.method, params: message.params };
    for (const listener of this.notificationListeners) {
      try {
        listener(notification);
      } catch {
        // One host listener must not corrupt the stdio protocol loop or starve peers.
      }
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    this.rejectPending(error);
    for (const listener of this.exitListeners) this.callExitListener(listener, error);
  }

  private failTransport(error: Error): void {
    this.fail(error);
    try {
      this.child.kill();
    } catch {
      // The connection is already failed; a concurrent process exit is harmless.
    }
  }

  private callExitListener(listener: (error: Error) => void, error: Error): void {
    try {
      listener(error);
    } catch {
      // Process cleanup and the remaining listeners must still run.
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export async function launchCodexAppServer(
  executable: string,
  clientVersion: string,
  spawnProcess: SpawnCodexProcess = spawn as SpawnCodexProcess,
): Promise<AppServerConnection> {
  const child = spawnProcess(executable, ['app-server'], {
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new CodexAppServerClient(child);
  try {
    await client.request('initialize', {
      clientInfo: {
        name: 'ai_terminal',
        title: 'AI Terminal',
        version: clientVersion,
      },
    });
    client.notify('initialized', {});
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
