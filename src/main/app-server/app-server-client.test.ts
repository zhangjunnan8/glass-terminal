import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexAppServerClient,
  isolatedCodexEnvironment,
  launchCodexAppServer,
} from './app-server-client';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}

function readJsonLines(stream: PassThrough, listener: (message: Record<string, unknown>) => void) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) listener(JSON.parse(line) as Record<string, unknown>);
      newline = buffer.indexOf('\n');
    }
  });
}

describe('CodexAppServerClient', () => {
  it('performs initialize before initialized over newline JSON', async () => {
    const child = new FakeChild();
    const messages: Record<string, unknown>[] = [];
    readJsonLines(child.stdin, (message) => {
      messages.push(message);
      if (message.method === 'initialize') {
        const response = `${JSON.stringify({ id: message.id, result: { userAgent: 'fake' } })}\n`;
        child.stdout.write(response.slice(0, 9));
        child.stdout.write(response.slice(9));
      }
    });
    const spawnFactory = vi.fn(() => child.asChild());

    const connection = await launchCodexAppServer('codex.exe', '0.1.0', {
      codexHome: 'C:\\app-data\\codex-home',
      workingDirectory: 'C:\\app-data\\server-cwd',
    }, spawnFactory);

    expect(spawnFactory).toHaveBeenCalledWith(
      'codex.exe',
      ['app-server'],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        cwd: 'C:\\app-data\\server-cwd',
        env: expect.objectContaining({ CODEX_HOME: 'C:\\app-data\\codex-home' }),
      }),
    );
    expect(messages.map((message) => message.method)).toEqual(['initialize', 'initialized']);
    expect(messages[0]).toMatchObject({
      params: {
        clientInfo: { name: 'ai_terminal', title: 'AI Terminal', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      },
    });
    connection.close();
  });

  it('terminates the child when initialize fails', async () => {
    const child = new FakeChild();
    readJsonLines(child.stdin, (message) => {
      if (message.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({
          id: message.id,
          error: { code: -32000, message: 'handshake rejected' },
        })}\n`);
      }
    });
    await expect(launchCodexAppServer(
      'codex.exe',
      '0.1.0',
      { codexHome: 'C:\\private-home', workingDirectory: 'C:\\private-cwd' },
      () => child.asChild(),
    )).rejects.toThrow('handshake rejected');
    expect(child.killed).toBe(true);
  });

  it('builds a narrow child environment without credentials or SSH agent access', () => {
    const environment = isolatedCodexEnvironment({
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      OPENAI_API_KEY: 'must-not-leak',
      SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent',
      GITHUB_TOKEN: 'must-not-leak-either',
      CUSTOM_PASSWORD: 'also-secret',
    }, 'C:\\app-data\\codex-home');

    expect(environment).toEqual({
      CODEX_HOME: 'C:\\app-data\\codex-home',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
    });
  });

  it('routes partial, batched, and out-of-order responses by exact id', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    const outgoing: Record<string, unknown>[] = [];
    readJsonLines(child.stdin, (message) => outgoing.push(message));
    const first = client.request<{ value: number }>('first', {});
    const second = client.request<{ value: number }>('second', {});
    await vi.waitFor(() => expect(outgoing).toHaveLength(2));
    const payload = [
      { id: outgoing[1].id, result: { value: 2 } },
      { id: outgoing[0].id, result: { value: 1 } },
    ].map((item) => JSON.stringify(item)).join('\n') + '\n';
    child.stdout.write(payload.slice(0, 13));
    child.stdout.write(payload.slice(13));

    await expect(first).resolves.toEqual({ value: 1 });
    await expect(second).resolves.toEqual({ value: 2 });
    client.close();
  });

  it('streams notifications and rejects unsupported server requests', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    const outgoing: Record<string, unknown>[] = [];
    const listener = vi.fn();
    readJsonLines(child.stdin, (message) => outgoing.push(message));
    client.onNotification(listener);

    child.stdout.write(`${JSON.stringify({ method: 'account/updated', params: { authMode: 'chatgpt' } })}\n`);
    child.stdout.write(`${JSON.stringify({
      id: 'server-request-44', method: 'item/tool/call', params: {},
    })}\n`);

    await vi.waitFor(() => expect(outgoing).toHaveLength(1));
    expect(listener).toHaveBeenCalledWith({
      method: 'account/updated',
      params: { authMode: 'chatgpt' },
    });
    expect(outgoing[0]).toMatchObject({
      id: 'server-request-44',
      error: { code: -32601 },
    });
    client.close();
  });

  it('routes asynchronous server requests and replies with the exact request id', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    const outgoing: Record<string, unknown>[] = [];
    readJsonLines(child.stdin, (message) => outgoing.push(message));
    const handler = vi.fn(async (request) => ({
      contentItems: [{ type: 'inputText', text: JSON.stringify(request.params) }],
      success: true,
    }));
    client.onRequest(handler);

    child.stdout.write(`${JSON.stringify({
      id: 'tool-request-7',
      method: 'item/tool/call',
      params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'terminal_state' },
    })}\n`);

    await vi.waitFor(() => expect(outgoing).toHaveLength(1));
    expect(handler).toHaveBeenCalledWith({
      id: 'tool-request-7',
      method: 'item/tool/call',
      params: { threadId: 'thread-1', turnId: 'turn-1', tool: 'terminal_state' },
    });
    expect(outgoing[0]).toEqual({
      id: 'tool-request-7',
      result: {
        contentItems: [{
          type: 'inputText',
          text: JSON.stringify({
            threadId: 'thread-1', turnId: 'turn-1', tool: 'terminal_state',
          }),
        }],
        success: true,
      },
    });
    client.close();
  });

  it('turns a server request handler failure into a bounded protocol error', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    const outgoing: Record<string, unknown>[] = [];
    readJsonLines(child.stdin, (message) => outgoing.push(message));
    client.onRequest(async () => {
      throw new Error('tool rejected safely');
    });

    child.stdout.write(`${JSON.stringify({
      id: 91, method: 'item/tool/call', params: {},
    })}\n`);

    await vi.waitFor(() => expect(outgoing).toHaveLength(1));
    expect(outgoing[0]).toMatchObject({
      id: 91,
      error: { code: -32000, message: 'tool rejected safely' },
    });
    client.close();
  });

  it('fails closed on malformed JSON and process exit', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    const first = client.request('pending-malformed');
    child.stdout.write('{not-json}\n');
    await expect(first).rejects.toThrow('无效 JSON');
    expect(child.killed).toBe(true);

    const secondChild = new FakeChild();
    const secondClient = new CodexAppServerClient(secondChild.asChild());
    const second = secondClient.request('pending-exit');
    secondChild.stderr.write('controlled crash');
    secondChild.emit('exit', 7, null);
    await expect(second).rejects.toThrow('退出码 7');
  });

  it('replays an early process failure to exit listeners registered later', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    child.stderr.write('failed before service listener');
    child.emit('exit', 9, null);

    const listener = vi.fn();
    client.onExit(listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(listener.mock.calls[0][0].message).toContain('退出码 9');
  });

  it('turns stdin EPIPE into a connection failure instead of an unhandled stream error', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    const exitListener = vi.fn();
    client.onExit(exitListener);
    const pending = client.request('pending-write');

    const pipeError = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    child.stdin.emit('error', pipeError);

    await expect(pending).rejects.toThrow('标准输入失败');
    expect(exitListener).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(true);
  });

  it('isolates throwing notification and exit listeners', async () => {
    const child = new FakeChild();
    const client = new CodexAppServerClient(child.asChild());
    const notificationPeer = vi.fn();
    client.onNotification(() => {
      throw new Error('bad notification listener');
    });
    client.onNotification(notificationPeer);

    child.stdout.write(`${JSON.stringify({ method: 'account/updated', params: {} })}\n`);
    expect(notificationPeer).toHaveBeenCalledTimes(1);

    const exitPeer = vi.fn();
    client.onExit(() => {
      throw new Error('bad exit listener');
    });
    client.onExit(exitPeer);
    child.emit('exit', 3, null);
    expect(exitPeer).toHaveBeenCalledTimes(1);
  });
});
