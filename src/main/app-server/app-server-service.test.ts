import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppServerConnection,
  AppServerNotification,
} from './app-server-client';
import {
  bundledCodexCandidates,
  CodexAppServerService,
} from './app-server-service';

const roots: string[] = [];

class FakeConnection extends EventEmitter implements AppServerConnection {
  account: unknown = null;
  requiresOpenaiAuth = true;
  readonly models = [{
    id: 'gpt-test',
    model: 'gpt-test',
    displayName: 'GPT Test',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: '更快' },
      { reasoningEffort: 'medium', description: '平衡' },
    ],
    inputModalities: ['text'],
    supportsPersonality: true,
    isDefault: true,
  }];
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  closed = false;

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'account/read') {
      return { account: this.account, requiresOpenaiAuth: this.requiresOpenaiAuth } as T;
    }
    if (method === 'model/list') return { data: this.models, nextCursor: null } as T;
    if (method === 'account/login/start') {
      if ((params as { type?: string }).type === 'chatgptDeviceCode') {
        return {
          type: 'chatgptDeviceCode',
          loginId: 'device-login',
          verificationUrl: 'https://auth.openai.com/codex/device',
          userCode: 'ABCD-1234',
        } as T;
      }
      return {
        type: 'chatgpt',
        loginId: 'browser-login',
        authUrl: 'https://chatgpt.com/auth/fake',
      } as T;
    }
    return {} as T;
  }

  notify(): void {}

  onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.on('notification', listener);
    return () => this.off('notification', listener);
  }

  onExit(listener: (error: Error) => void): () => void {
    this.on('closed', listener);
    return () => this.off('closed', listener);
  }

  close(): void {
    this.closed = true;
  }

  notification(method: string, params?: unknown): void {
    this.emit('notification', { method, params });
  }

  crash(message: string): void {
    this.emit('closed', new Error(message));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-app-server-test-'));
  roots.push(root);
  const bundledExecutable = bundledCodexCandidates(root, root, 'win32', 'x64')[0];
  mkdirSync(dirname(bundledExecutable), { recursive: true });
  writeFileSync(bundledExecutable, 'fake codex binary');
  const connection = new FakeConnection();
  const openExternal = vi.fn(async () => undefined);
  const probe = vi.fn(async () => 'codex-cli 1.2.3');
  const launch = vi.fn(async () => connection as AppServerConnection);
  const service = new CodexAppServerService(
    join(root, 'config.json'),
    root,
    root,
    '0.1.0',
    openExternal,
    {
      platform: 'win32',
      arch: 'x64',
      probe,
      launch,
    },
  );
  return {
    root,
    connection,
    launch,
    openExternal,
    probe,
    service,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

describe('CodexAppServerService', () => {
  it('starts, logs in through the browser, loads models, and persists no auth data', async () => {
    const { root, connection, openExternal, service } = fixture();
    const started = await service.start();
    expect(started).toMatchObject({
      phase: 'ready',
      requiresOpenaiAuth: true,
      models: [],
      terminalAgentEnabled: false,
    });

    const pending = await service.loginBrowser();
    expect(pending.pendingLogin).toMatchObject({ type: 'browser' });
    expect(pending.pendingLogin).not.toHaveProperty('loginId');
    expect(openExternal).toHaveBeenCalledWith('https://chatgpt.com/auth/fake');

    connection.account = { type: 'chatgpt', email: 'user@example.com', planType: 'plus' };
    connection.notification('account/login/completed', {
      loginId: 'browser-login', success: true, error: null,
    });
    await vi.waitFor(() => expect(service.getState().models).toHaveLength(1));
    const bound = service.saveSelection({ modelId: 'gpt-test', reasoningEffort: 'low' });
    expect(bound).toMatchObject({
      bound: true,
      selection: { modelId: 'gpt-test', reasoningEffort: 'low' },
    });

    const persisted = readFileSync(join(root, 'config.json'), 'utf8');
    expect(persisted).not.toContain('chatgpt.com');
    expect(persisted).not.toContain('user@example.com');
    expect(persisted).not.toContain('browser-login');
    expect(persisted).toContain('gpt-test');
  });

  it('owns the device-code UI lifecycle and cancels by exact login id', async () => {
    const { connection, openExternal, service } = fixture();
    await service.start();
    const pending = await service.loginDeviceCode();
    expect(pending.pendingLogin).toEqual(expect.objectContaining({
      type: 'device-code',
      userCode: 'ABCD-1234',
    }));
    expect(openExternal).not.toHaveBeenCalled();
    await service.openPendingLogin();
    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/codex/device');
    await service.cancelLogin();
    expect(service.getState().pendingLogin).toBeUndefined();
    expect(connection.calls).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: 'device-login' },
    });
  });

  it('handles login completion that arrives before login/start returns', async () => {
    const { connection, openExternal, service } = fixture();
    await service.start();
    const originalRequest = connection.request.bind(connection);
    connection.request = (async <T>(method: string, params?: unknown): Promise<T> => {
      if (method !== 'account/login/start') return originalRequest<T>(method, params);
      connection.account = {
        type: 'chatgpt', email: 'race@example.com', planType: 'plus',
      };
      connection.notification('account/login/completed', {
        loginId: 'race-login', success: true, error: null,
      });
      return {
        type: 'chatgpt',
        loginId: 'race-login',
        authUrl: 'https://chatgpt.com/auth/race',
      } as T;
    }) as FakeConnection['request'];

    const state = await service.loginBrowser();
    expect(state.pendingLogin).toBeUndefined();
    expect(state.account?.email).toBe('race@example.com');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('invalidates runtime state on process crash and rejects non-HTTPS login URLs', async () => {
    const { connection, service } = fixture();
    await service.start();
    connection.crash('fake process crash');
    expect(service.getState()).toMatchObject({
      phase: 'error',
      error: 'fake process crash',
      models: [],
    });

    const second = fixture();
    let unsafeAuthUrl = 'http://example.com/login';
    second.connection.request = vi.fn(async (method: string) => {
      if (method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (method === 'account/login/start') {
        return { loginId: 'unsafe', authUrl: unsafeAuthUrl };
      }
      return {};
    }) as FakeConnection['request'];
    await second.service.start();
    await expect(second.service.loginBrowser()).rejects.toThrow('必须使用 HTTPS');
    unsafeAuthUrl = 'https://user:password@example.com/login';
    await expect(second.service.loginBrowser()).rejects.toThrow('不能包含用户名或密码');
    expect(second.openExternal).not.toHaveBeenCalled();
  });

  it('keeps revisions monotonic across start, refresh, and restart', async () => {
    const { service } = fixture();
    const revisions: number[] = [];
    service.onStateChanged((state) => revisions.push(state.revision));
    await service.start();
    await service.refresh();
    await service.restart();
    expect(revisions.length).toBeGreaterThan(4);
    expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
    expect(new Set(revisions).size).toBe(revisions.length);
  });

  it('runs a trailing refresh when account/updated arrives during an in-flight refresh', async () => {
    const { connection, service } = fixture();
    await service.start();
    const originalRequest = connection.request.bind(connection);
    let accountReads = 0;
    let releaseFirstRead!: (value: unknown) => void;
    connection.request = (async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === 'account/read') {
        accountReads += 1;
        if (accountReads === 1) {
          return await new Promise<unknown>((resolve) => {
            releaseFirstRead = resolve;
          }) as T;
        }
      }
      return originalRequest<T>(method, params);
    }) as FakeConnection['request'];

    connection.notification('account/login/completed', {
      loginId: 'trailing-login', success: true, error: null,
    });
    await vi.waitFor(() => expect(accountReads).toBe(1));
    connection.account = {
      type: 'chatgpt', email: 'fresh@example.com', planType: 'plus',
    };
    connection.notification('account/updated', {
      authMode: 'chatgpt', planType: 'plus',
    });
    releaseFirstRead({ account: null, requiresOpenaiAuth: true });

    await vi.waitFor(() => expect(service.getState().account?.email).toBe('fresh@example.com'));
    expect(accountReads).toBe(2);
  });

  it('does not apply an in-flight or trailing refresh after close', async () => {
    const { connection, service } = fixture();
    await service.start();
    const originalRequest = connection.request.bind(connection);
    let accountReads = 0;
    let releaseRead!: (value: unknown) => void;
    connection.request = (async <T>(method: string, params?: unknown): Promise<T> => {
      if (method === 'account/read') {
        accountReads += 1;
        return await new Promise<unknown>((resolve) => {
          releaseRead = resolve;
        }) as T;
      }
      return originalRequest<T>(method, params);
    }) as FakeConnection['request'];

    const refreshing = service.refresh();
    await vi.waitFor(() => expect(accountReads).toBe(1));
    const trailing = service.refresh();
    expect(trailing).toBe(refreshing);
    service.close();
    releaseRead({
      account: { type: 'chatgpt', email: 'stale@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    });

    await expect(refreshing).resolves.toMatchObject({
      phase: 'stopped',
      operation: 'idle',
      models: [],
      account: undefined,
    });
    await expect(trailing).resolves.toMatchObject({ phase: 'stopped' });
    expect(accountReads).toBe(1);
    expect(service.getState()).toMatchObject({
      phase: 'stopped',
      operation: 'idle',
      models: [],
      account: undefined,
    });
  });

  it('serializes concurrent restarts and closes every superseded connection', async () => {
    const { connection, launch, service } = fixture();
    await service.start();
    launch.mockClear();
    const restartedConnections: FakeConnection[] = [];
    let activeLaunches = 0;
    let maxActiveLaunches = 0;
    launch.mockImplementation(async () => {
      activeLaunches += 1;
      maxActiveLaunches = Math.max(maxActiveLaunches, activeLaunches);
      await Promise.resolve();
      const next = new FakeConnection();
      restartedConnections.push(next);
      activeLaunches -= 1;
      return next;
    });

    await Promise.all([service.restart(), service.restart()]);

    expect(connection.closed).toBe(true);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(maxActiveLaunches).toBe(1);
    expect(restartedConnections[0].closed).toBe(true);
    expect(restartedConnections[1].closed).toBe(false);
  });

  it('prevents an in-flight start from spawning after close and rejects later actions', async () => {
    const { launch, probe, service } = fixture();
    let releaseProbe!: (version: string) => void;
    probe.mockImplementationOnce(() => new Promise<string>((resolve) => {
      releaseProbe = resolve;
    }));

    const starting = service.start();
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    service.close();
    releaseProbe('codex-cli delayed');

    await expect(starting).resolves.toMatchObject({ phase: 'stopped' });
    expect(launch).not.toHaveBeenCalled();
    await expect(service.restart()).rejects.toThrow('服务已关闭');
  });

  it('rejects overlapping auth actions and a second login while one is pending', async () => {
    const { connection, service } = fixture();
    await service.start();

    const first = service.loginBrowser();
    const overlapping = service.loginDeviceCode();
    await expect(overlapping).rejects.toThrow('账号操作正在进行');
    await expect(first).resolves.toMatchObject({
      pendingLogin: { type: 'browser' },
    });
    await expect(service.loginDeviceCode()).rejects.toThrow('已有等待完成');
    expect(connection.calls.filter((call) => call.method === 'account/login/start')).toHaveLength(1);
  });

  it('surfaces a connection that failed before the service attached its exit listener', async () => {
    const { launch, service } = fixture();
    const failed = new FakeConnection();
    failed.onExit = (listener) => {
      queueMicrotask(() => listener(new Error('early app-server exit')));
      return () => undefined;
    };
    launch.mockResolvedValue(failed);

    const state = await service.start();

    expect(state).toMatchObject({
      phase: 'error',
      error: 'early app-server exit',
      models: [],
    });
  });

  it('never probes a bare executable name when trusted candidates are absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-app-server-no-cli-'));
    roots.push(root);
    const probe = vi.fn(async () => 'untrusted');
    const launch = vi.fn(async () => new FakeConnection() as AppServerConnection);
    const service = new CodexAppServerService(
      join(root, 'config.json'),
      root,
      root,
      '0.1.0',
      async () => undefined,
      {
        platform: 'win32',
        arch: 'x64',
        probe,
        launch,
      },
    );

    const state = await service.start();

    expect(state.phase).toBe('error');
    expect(probe).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('surfaces corrupt config as recoverable UI state and replaces it after rebinding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-app-server-corrupt-config-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{ definitely-not-json');
    const executablePath = bundledCodexCandidates(root, root, 'win32', 'x64')[0];
    mkdirSync(dirname(executablePath), { recursive: true });
    writeFileSync(executablePath, 'fake codex binary');
    const connection = new FakeConnection();
    connection.requiresOpenaiAuth = false;
    const service = new CodexAppServerService(
      configPath,
      root,
      root,
      '0.1.0',
      async () => undefined,
      {
        platform: 'win32',
        arch: 'x64',
        probe: async () => 'codex-cli 1.2.3',
        launch: async () => connection,
      },
    );

    expect(service.getState()).toMatchObject({
      phase: 'error',
      bound: false,
    });
    expect(service.getState().error).toContain('配置已损坏并被忽略');

    const started = await service.configureExecutableAndStart(executablePath);
    expect(started).toMatchObject({ phase: 'ready', error: undefined });
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      executablePath,
      bound: false,
    });
  });

  it('isolates a throwing state listener from other listeners and startup', async () => {
    const { service } = fixture();
    const peer = vi.fn();
    service.onStateChanged(() => {
      throw new Error('bad renderer listener');
    });
    service.onStateChanged(peer);

    await expect(service.start()).resolves.toMatchObject({ phase: 'ready' });
    expect(peer).toHaveBeenCalled();
  });
});
