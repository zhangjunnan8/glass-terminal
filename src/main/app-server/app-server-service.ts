import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type {
  CodexAccountInfo,
  CodexAppServerSelection,
  CodexAppServerSnapshot,
  CodexExecutableInfo,
  CodexModelInfo,
  SaveCodexAppServerSelectionRequest,
} from '../../shared/codex-app-server';
import {
  launchCodexAppServer,
} from './app-server-client';
import type {
  AppServerConnection,
  AppServerNotification,
} from './app-server-client';

const TERMINAL_AGENT_BLOCK_REASON = 'App Server 暂时无法硬性关闭内建 Shell/File 工具；为保证所有命令只进入同一可见终端，终端 Agent 链路保持禁用。';
const PROBE_TIMEOUT_MS = 5_000;

interface StoredAppServerConfig {
  executablePath?: string;
  modelId?: string;
  reasoningEffort?: string;
  bound: boolean;
}

interface ExecutableCandidate {
  path: string;
  source: CodexExecutableInfo['source'];
}

interface AccountReadResult {
  account?: unknown;
  requiresOpenaiAuth?: unknown;
}

interface ModelListResult {
  data?: unknown;
  nextCursor?: unknown;
}

class ConnectionSupersededError extends Error {
  constructor() {
    super('Codex App Server 连接已被替换。');
    this.name = 'ConnectionSupersededError';
  }
}

export interface CodexAppServerDependencies {
  applicationRoot: string;
  resourcesPath: string;
  platform: NodeJS.Platform;
  arch: string;
  clientVersion: string;
  openExternal(url: string): Promise<void>;
  launch(executable: string, clientVersion: string): Promise<AppServerConnection>;
  probe(executable: string): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cloneSnapshot(snapshot: CodexAppServerSnapshot): CodexAppServerSnapshot {
  return {
    ...snapshot,
    executable: snapshot.executable ? { ...snapshot.executable } : undefined,
    account: snapshot.account ? { ...snapshot.account } : undefined,
    models: snapshot.models.map((model) => ({
      ...model,
      supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
        ...effort,
      })),
      inputModalities: [...model.inputModalities],
    })),
    selection: snapshot.selection ? { ...snapshot.selection } : undefined,
    pendingLogin: snapshot.pendingLogin ? { ...snapshot.pendingLogin } : undefined,
  };
}

function parseConfig(value: unknown): StoredAppServerConfig {
  if (!isRecord(value)) throw new Error('App Server 配置格式无效。');
  return {
    executablePath: optionalText(value.executablePath),
    modelId: optionalText(value.modelId),
    reasoningEffort: optionalText(value.reasoningEffort),
    bound: value.bound === true,
  };
}

function parseAccount(value: unknown): CodexAccountInfo | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  return {
    type: value.type,
    email: optionalText(value.email),
    planType: optionalText(value.planType),
  };
}

function parseModels(value: unknown): CodexModelInfo[] {
  if (!Array.isArray(value)) throw new Error('App Server 返回的模型列表无效。');
  return value.flatMap((candidate): CodexModelInfo[] => {
    if (!isRecord(candidate) || typeof candidate.id !== 'string') return [];
    const efforts = Array.isArray(candidate.supportedReasoningEfforts)
      ? candidate.supportedReasoningEfforts.flatMap((entry) => (
        isRecord(entry) && typeof entry.reasoningEffort === 'string'
          ? [{
            reasoningEffort: entry.reasoningEffort,
            description: optionalText(entry.description),
          }]
          : []
      ))
      : [];
    return [{
      id: candidate.id,
      model: optionalText(candidate.model) ?? candidate.id,
      displayName: optionalText(candidate.displayName) ?? candidate.id,
      defaultReasoningEffort: optionalText(candidate.defaultReasoningEffort),
      supportedReasoningEfforts: efforts,
      inputModalities: Array.isArray(candidate.inputModalities)
        ? candidate.inputModalities.filter((item): item is string => typeof item === 'string')
        : ['text', 'image'],
      supportsPersonality: candidate.supportsPersonality === true,
      isDefault: candidate.isDefault === true,
    }];
  });
}

function targetTriple(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-musl';
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-musl';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  return undefined;
}

function platformPackage(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && arch === 'x64') return 'codex-win32-x64';
  if (platform === 'win32' && arch === 'arm64') return 'codex-win32-arm64';
  if (platform === 'linux' && arch === 'x64') return 'codex-linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'codex-linux-arm64';
  if (platform === 'darwin' && arch === 'x64') return 'codex-darwin-x64';
  if (platform === 'darwin' && arch === 'arm64') return 'codex-darwin-arm64';
  return undefined;
}

export function bundledCodexCandidates(
  applicationRoot: string,
  resourcesPath: string,
  platform: NodeJS.Platform,
  arch: string,
): string[] {
  const triple = targetTriple(platform, arch);
  const packageName = platformPackage(platform, arch);
  if (!triple || !packageName) return [];
  const executable = platform === 'win32' ? 'codex.exe' : 'codex';
  return [
    join(
      applicationRoot,
      'node_modules',
      '@openai',
      packageName,
      'vendor',
      triple,
      'bin',
      executable,
    ),
    join(
      resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@openai',
      packageName,
      'vendor',
      triple,
      'bin',
      executable,
    ),
    join(resourcesPath, 'codex', triple, 'bin', executable),
  ];
}

export function probeCodexExecutable(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(executable, ['--version'], {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    let output = '';
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        const version = output.trim().split(/\r?\n/)[0] || '';
        if (!/^codex-cli\s+/i.test(version)) {
          reject(new Error('所选文件不是可识别的 Codex CLI。'));
        } else {
          resolve(version);
        }
      }
    };
    child.stdout.on('data', (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(0, 4096);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      output = `${output}${String(chunk)}`.slice(0, 4096);
    });
    child.once('error', (error) => finish(new Error(error.message)));
    child.once('exit', (code) => {
      if (code === 0) finish();
      else finish(new Error(output.trim() || `进程返回退出码 ${code ?? '未知'}`));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('版本检测超时。'));
    }, PROBE_TIMEOUT_MS);
  });
}

function defaultDependencies(
  applicationRoot: string,
  resourcesPath: string,
  clientVersion: string,
  openExternal: (url: string) => Promise<void>,
): CodexAppServerDependencies {
  return {
    applicationRoot,
    resourcesPath,
    platform: process.platform,
    arch: process.arch,
    clientVersion,
    openExternal,
    launch: launchCodexAppServer,
    probe: probeCodexExecutable,
  };
}

export class CodexAppServerService {
  private config: StoredAppServerConfig;
  private snapshot: CodexAppServerSnapshot;
  private initialConfigError?: string;
  private connection?: AppServerConnection;
  private connectionGeneration = 0;
  private startPromise?: Promise<CodexAppServerSnapshot>;
  private refreshPromise?: Promise<CodexAppServerSnapshot>;
  private authActionPromise?: Promise<CodexAppServerSnapshot>;
  private operationTail: Promise<void> = Promise.resolve();
  private refreshAgain = false;
  private disposed = false;
  private removeNotificationListener?: () => void;
  private removeExitListener?: () => void;
  private pendingLoginId?: string;
  private pendingLoginUrl?: string;
  private readonly completedLogins = new Map<string, { success: boolean; error?: string }>();
  private readonly listeners = new Set<(snapshot: CodexAppServerSnapshot) => void>();
  private readonly dependencies: CodexAppServerDependencies;

  constructor(
    private readonly configPath: string,
    applicationRoot: string,
    resourcesPath: string,
    clientVersion: string,
    openExternal: (url: string) => Promise<void>,
    dependencies?: Partial<CodexAppServerDependencies>,
  ) {
    this.config = this.readConfig();
    this.dependencies = {
      ...defaultDependencies(applicationRoot, resourcesPath, clientVersion, openExternal),
      ...dependencies,
    };
    const selection = this.config.modelId
      ? {
        modelId: this.config.modelId,
        reasoningEffort: this.config.reasoningEffort,
      }
      : undefined;
    this.snapshot = {
      revision: 0,
      phase: this.initialConfigError ? 'error' : 'stopped',
      operation: 'idle',
      models: [],
      selection,
      bound: this.config.bound,
      error: this.initialConfigError,
      terminalAgentEnabled: false,
      terminalAgentReason: TERMINAL_AGENT_BLOCK_REASON,
    };
  }

  getState(): CodexAppServerSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  onStateChanged(listener: (snapshot: CodexAppServerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async startIfBound(): Promise<CodexAppServerSnapshot> {
    return this.config.bound ? this.start() : this.getState();
  }

  start(): Promise<CodexAppServerSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Codex App Server 服务已关闭。'));
    if (this.connection && this.snapshot.phase === 'ready') {
      return Promise.resolve(this.getState());
    }
    if (!this.startPromise) {
      const operation = this.enqueueOperation(async () => {
        if (this.connection && this.snapshot.phase === 'ready') return this.getState();
        if (this.connection) this.disconnect();
        return this.startInternal('starting');
      });
      const tracked = operation.finally(() => {
        if (this.startPromise === tracked) this.startPromise = undefined;
      });
      this.startPromise = tracked;
    }
    return this.startPromise;
  }

  configureExecutableAndStart(executablePath: string): Promise<CodexAppServerSnapshot> {
    const normalized = executablePath.trim();
    if (!normalized || !isAbsolute(normalized)) throw new Error('请选择 Codex CLI 的绝对路径。');
    if (!existsSync(normalized) || !statSync(normalized).isFile()) {
      throw new Error('所选 Codex CLI 文件不存在。');
    }
    if (this.dependencies.platform === 'win32' && !normalized.toLowerCase().endsWith('.exe')) {
      throw new Error('Windows 上请选择 codex.exe。');
    }
    return this.enqueueOperation(async () => {
      const nextConfig = { ...this.config, executablePath: normalized };
      this.writeConfig(nextConfig);
      this.config = nextConfig;
      return this.restartInternal();
    });
  }

  restart(): Promise<CodexAppServerSnapshot> {
    return this.enqueueOperation(() => this.restartInternal());
  }

  refresh(): Promise<CodexAppServerSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Codex App Server 服务已关闭。'));
    if (this.refreshPromise) {
      this.refreshAgain = true;
      return this.refreshPromise;
    }
    const cycle = async (): Promise<CodexAppServerSnapshot> => {
      let state = this.getState();
      do {
        this.refreshAgain = false;
        state = await this.enqueueOperation(() => this.refreshPublic());
      } while (this.refreshAgain && !this.disposed);
      return state;
    };
    const operation = cycle();
    const tracked = operation.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = undefined;
    });
    this.refreshPromise = tracked;
    return tracked;
  }

  loginBrowser(): Promise<CodexAppServerSnapshot> {
    return this.runAuthAction(() => this.loginBrowserInternal());
  }

  loginDeviceCode(): Promise<CodexAppServerSnapshot> {
    return this.runAuthAction(() => this.loginDeviceCodeInternal());
  }

  openPendingLogin(): Promise<CodexAppServerSnapshot> {
    return this.runAuthAction(() => this.openPendingLoginInternal());
  }

  cancelLogin(): Promise<CodexAppServerSnapshot> {
    return this.runAuthAction(() => this.cancelLoginInternal());
  }

  logout(): Promise<CodexAppServerSnapshot> {
    return this.runAuthAction(() => this.logoutInternal());
  }

  private async loginBrowserInternal(): Promise<CodexAppServerSnapshot> {
    this.assertLoginCanStart();
    const connection = this.requireConnection();
    const generation = this.connectionGeneration;
    this.update({ operation: 'logging-in', error: undefined });
    try {
      const result = await connection.request<unknown>('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'chatgpt',
      });
      this.assertConnectionCurrent(connection, generation);
      if (
        !isRecord(result)
        || typeof result.loginId !== 'string'
        || typeof result.authUrl !== 'string'
      ) throw new Error('App Server 返回了无效的浏览器登录信息。');
      this.assertHttps(result.authUrl);
      this.pendingLoginId = result.loginId;
      this.pendingLoginUrl = result.authUrl;
      const completion = this.completedLogins.get(result.loginId);
      const pending = completion
        ? undefined
        : {
          type: 'browser' as const,
          startedAt: new Date().toISOString(),
        };
      this.update({ pendingLogin: pending, operation: 'idle' });
      if (pending) {
        await this.openPendingLoginInternal();
      } else {
        this.pendingLoginId = undefined;
        this.pendingLoginUrl = undefined;
        if (!completion?.success) {
          throw new Error(`ChatGPT 登录失败：${completion?.error ?? '未知错误'}`);
        }
        await this.refreshFromServer(false, connection, generation);
      }
      return this.getState();
    } catch (error) {
      if (this.isConnectionSuperseded(error, connection, generation)) return this.getState();
      this.update({ operation: 'idle', error: this.actionError(error) });
      throw error;
    }
  }

  private async loginDeviceCodeInternal(): Promise<CodexAppServerSnapshot> {
    this.assertLoginCanStart();
    const connection = this.requireConnection();
    const generation = this.connectionGeneration;
    this.update({ operation: 'logging-in', error: undefined });
    try {
      const result = await connection.request<unknown>('account/login/start', {
        type: 'chatgptDeviceCode',
      });
      this.assertConnectionCurrent(connection, generation);
      if (
        !isRecord(result)
        || typeof result.loginId !== 'string'
        || typeof result.verificationUrl !== 'string'
        || typeof result.userCode !== 'string'
      ) throw new Error('App Server 返回了无效的设备码登录信息。');
      this.assertHttps(result.verificationUrl);
      this.pendingLoginId = result.loginId;
      this.pendingLoginUrl = result.verificationUrl;
      const completion = this.completedLogins.get(result.loginId);
      const pending = completion
        ? undefined
        : {
          type: 'device-code' as const,
          userCode: result.userCode,
          startedAt: new Date().toISOString(),
        };
      this.update({ pendingLogin: pending, operation: 'idle' });
      if (completion) {
        this.pendingLoginId = undefined;
        this.pendingLoginUrl = undefined;
        if (!completion.success) {
          throw new Error(`ChatGPT 登录失败：${completion.error ?? '未知错误'}`);
        }
        await this.refreshFromServer(false, connection, generation);
      }
      return this.getState();
    } catch (error) {
      if (this.isConnectionSuperseded(error, connection, generation)) return this.getState();
      this.update({ operation: 'idle', error: this.actionError(error) });
      throw error;
    }
  }

  private async openPendingLoginInternal(): Promise<CodexAppServerSnapshot> {
    if (!this.snapshot.pendingLogin || !this.pendingLoginUrl) {
      throw new Error('当前没有等待完成的登录。');
    }
    const loginUrl = this.pendingLoginUrl;
    this.assertHttps(loginUrl);
    try {
      await this.dependencies.openExternal(loginUrl);
      if (!this.disposed && this.pendingLoginUrl === loginUrl) this.update({ error: undefined });
    } catch (error) {
      if (!this.disposed && this.pendingLoginUrl === loginUrl) {
        this.update({ error: `无法打开登录页面：${this.actionError(error)}` });
      }
    }
    return this.getState();
  }

  private async cancelLoginInternal(): Promise<CodexAppServerSnapshot> {
    const pending = this.snapshot.pendingLogin;
    const loginId = this.pendingLoginId;
    if (!pending || !loginId) return this.getState();
    const connection = this.requireConnection();
    const generation = this.connectionGeneration;
    try {
      await connection.request('account/login/cancel', { loginId });
      this.assertConnectionCurrent(connection, generation);
      this.pendingLoginId = undefined;
      this.pendingLoginUrl = undefined;
      this.update({ pendingLogin: undefined, error: undefined });
      return this.getState();
    } catch (error) {
      if (this.isConnectionSuperseded(error, connection, generation)) return this.getState();
      this.update({ error: this.actionError(error) });
      throw error;
    }
  }

  private async logoutInternal(): Promise<CodexAppServerSnapshot> {
    const connection = this.requireConnection();
    const generation = this.connectionGeneration;
    this.update({ operation: 'logging-out', error: undefined });
    try {
      await connection.request('account/logout');
      this.assertConnectionCurrent(connection, generation);
      this.pendingLoginId = undefined;
      this.pendingLoginUrl = undefined;
      const nextConfig = { ...this.config, bound: false };
      let persistenceError: string | undefined;
      try {
        this.writeConfig(nextConfig);
      } catch (error) {
        persistenceError = `账号已退出，但无法保存解绑状态：${this.actionError(error)}`;
      }
      this.config = nextConfig;
      this.update({ pendingLogin: undefined, bound: false });
      const refreshed = await this.refreshFromServer(true, connection, generation);
      if (persistenceError) this.update({ error: persistenceError });
      return persistenceError ? this.getState() : refreshed;
    } catch (error) {
      if (this.isConnectionSuperseded(error, connection, generation)) return this.getState();
      this.update({ operation: 'idle', error: this.actionError(error) });
      throw error;
    }
  }

  saveSelection(request: SaveCodexAppServerSelectionRequest): CodexAppServerSnapshot {
    if (this.disposed) throw new Error('Codex App Server 服务已关闭。');
    if (!request || typeof request.modelId !== 'string') {
      throw new Error('模型绑定请求无效。');
    }
    const model = this.snapshot.models.find((candidate) => candidate.id === request.modelId);
    if (!model) throw new Error('请选择 App Server 当前提供的模型。');
    const effort = optionalText(request.reasoningEffort);
    if (
      effort
      && !model.supportedReasoningEfforts.some((entry) => entry.reasoningEffort === effort)
    ) throw new Error('所选推理强度不受该模型支持。');
    const selection: CodexAppServerSelection = {
      modelId: model.id,
      reasoningEffort: effort ?? model.defaultReasoningEffort,
    };
    this.update({ operation: 'saving', error: undefined });
    const nextConfig: StoredAppServerConfig = {
      ...this.config,
      modelId: selection.modelId,
      reasoningEffort: selection.reasoningEffort,
      bound: true,
    };
    try {
      this.writeConfig(nextConfig);
    } catch (error) {
      this.update({ operation: 'idle', error: this.actionError(error) });
      throw error;
    }
    this.config = nextConfig;
    this.update({ selection, bound: true, operation: 'idle' });
    return this.getState();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshAgain = false;
    this.disconnect();
    this.completedLogins.clear();
    this.update({
      phase: 'stopped',
      operation: 'idle',
      pendingLogin: undefined,
      account: undefined,
      requiresOpenaiAuth: undefined,
      models: [],
      error: undefined,
    });
  }

  private async restartInternal(): Promise<CodexAppServerSnapshot> {
    this.update({ operation: 'restarting', error: undefined });
    this.disconnect();
    return this.startInternal('restarting');
  }

  private async startInternal(
    operation: 'starting' | 'restarting',
  ): Promise<CodexAppServerSnapshot> {
    if (this.disposed) return this.getState();
    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.update({
      phase: 'detecting',
      operation,
      error: undefined,
      account: undefined,
      requiresOpenaiAuth: undefined,
      models: [],
      pendingLogin: undefined,
    });
    this.pendingLoginId = undefined;
    this.pendingLoginUrl = undefined;
    this.completedLogins.clear();
    const attempts: string[] = [];
    let selected: CodexExecutableInfo | undefined;
    for (const candidate of this.executableCandidates()) {
      if (isAbsolute(candidate.path) && !existsSync(candidate.path)) continue;
      try {
        const version = await this.dependencies.probe(candidate.path);
        if (!this.isGenerationCurrent(generation)) return this.getState();
        selected = { ...candidate, version };
        break;
      } catch (error) {
        if (!this.isGenerationCurrent(generation)) return this.getState();
        attempts.push(`${candidate.path}：${this.actionError(error)}`);
      }
    }
    if (!selected) {
      if (!this.isGenerationCurrent(generation)) return this.getState();
      this.update({
        phase: 'error',
        operation: 'idle',
        executable: undefined,
        error: attempts.length
          ? `未找到可执行的 Codex CLI。${attempts.join('；').slice(0, 900)}`
          : '未找到 Codex CLI。请使用“选择 codex 可执行文件”从界面指定 codex.exe。',
      });
      return this.getState();
    }

    this.update({ phase: 'starting', executable: selected });
    let launchedConnection: AppServerConnection | undefined;
    try {
      const connection = await this.dependencies.launch(
        selected.path,
        this.dependencies.clientVersion,
      );
      launchedConnection = connection;
      if (!this.isGenerationCurrent(generation)) {
        connection.close();
        return this.getState();
      }
      this.connection = connection;
      this.removeNotificationListener = connection.onNotification((notification) => {
        if (this.isGenerationCurrent(generation)) this.handleNotification(notification);
      });
      this.removeExitListener = connection.onExit((error) => {
        this.handleConnectionExit(connection, generation, error);
      });
      this.update({ phase: 'ready', operation: 'idle', error: undefined });
      try {
        return await this.refreshFromServer(false, connection, generation);
      } catch (error) {
        if (this.isConnectionSuperseded(error, connection, generation)) return this.getState();
        this.update({ operation: 'idle', error: this.actionError(error) });
        return this.getState();
      }
    } catch (error) {
      if (this.isGenerationCurrent(generation)) {
        if (launchedConnection) {
          this.disconnect();
        }
        this.update({
          phase: 'error',
          operation: 'idle',
          error: `Codex App Server 握手失败：${this.actionError(error)}`,
        });
      }
      return this.getState();
    }
  }

  private async refreshPublic(): Promise<CodexAppServerSnapshot> {
    const connection = this.requireConnection();
    const generation = this.connectionGeneration;
    this.update({ operation: 'refreshing', error: undefined });
    try {
      return await this.refreshFromServer(false, connection, generation);
    } catch (error) {
      if (this.isConnectionSuperseded(error, connection, generation)) return this.getState();
      this.update({ operation: 'idle', error: this.actionError(error) });
      throw error;
    }
  }

  private async refreshFromServer(
    refreshToken: boolean,
    connection = this.requireConnection(),
    generation = this.connectionGeneration,
  ): Promise<CodexAppServerSnapshot> {
    this.assertConnectionCurrent(connection, generation);
    const accountResult = await connection.request<AccountReadResult>(
      'account/read',
      { refreshToken },
    );
    this.assertConnectionCurrent(connection, generation);
    if (!isRecord(accountResult)) throw new Error('App Server 返回的账号状态无效。');
    if (typeof accountResult.requiresOpenaiAuth !== 'boolean') {
      throw new Error('App Server 返回的认证要求无效。');
    }
    const account = parseAccount(accountResult.account);
    const requiresOpenaiAuth = accountResult.requiresOpenaiAuth === true;
    let models: CodexModelInfo[] = [];
    if (account || !requiresOpenaiAuth) {
      models = await this.readModels(connection, generation);
    }
    this.assertConnectionCurrent(connection, generation);
    const configured = this.config.modelId
      ? models.find((model) => model.id === this.config.modelId)
      : undefined;
    const chosen = configured ?? models.find((model) => model.isDefault) ?? models[0];
    const selectedEffort = chosen
      ? chosen.supportedReasoningEfforts.some((entry) => (
        entry.reasoningEffort === this.config.reasoningEffort
      ))
        ? this.config.reasoningEffort
        : chosen.defaultReasoningEffort
      : undefined;
    const selection = chosen ? {
      modelId: chosen.id,
      reasoningEffort: selectedEffort,
    } : this.snapshot.selection;
    const bound = Boolean(account || !requiresOpenaiAuth)
      && Boolean(configured)
      && this.config.bound;
    this.update({
      account,
      requiresOpenaiAuth,
      models,
      selection,
      bound,
      operation: 'idle',
      error: undefined,
    });
    return this.getState();
  }

  private async readModels(
    connection: AppServerConnection,
    generation: number,
  ): Promise<CodexModelInfo[]> {
    const models: CodexModelInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await connection.request<ModelListResult>('model/list', {
        limit: 100,
        includeHidden: false,
        ...(cursor ? { cursor } : {}),
      });
      this.assertConnectionCurrent(connection, generation);
      if (!isRecord(result)) throw new Error('App Server 返回的模型分页无效。');
      models.push(...parseModels(result.data));
      cursor = optionalText(result.nextCursor);
      if (!cursor) break;
    }
    return models;
  }

  private handleNotification(notification: AppServerNotification): void {
    if (notification.method === 'account/login/completed' && isRecord(notification.params)) {
      const loginId = optionalText(notification.params.loginId);
      if (loginId) {
        this.completedLogins.set(loginId, {
          success: notification.params.success === true,
          error: optionalText(notification.params.error),
        });
        if (this.completedLogins.size > 32) {
          const oldest = this.completedLogins.keys().next().value as string | undefined;
          if (oldest) this.completedLogins.delete(oldest);
        }
      }
      if (
        loginId
        && this.snapshot.pendingLogin
        && this.pendingLoginId === loginId
      ) {
        this.pendingLoginId = undefined;
        this.pendingLoginUrl = undefined;
        this.update({ pendingLogin: undefined });
      }
      if (notification.params.success === true) {
        void this.refresh().catch(() => undefined);
      } else {
        this.update({
          error: `ChatGPT 登录失败：${optionalText(notification.params.error) ?? '未知错误'}`,
        });
      }
      return;
    }
    if (notification.method === 'account/updated') {
      void this.refresh().catch(() => undefined);
    }
  }

  private executableCandidates(): ExecutableCandidate[] {
    const candidates: ExecutableCandidate[] = [];
    if (this.config.executablePath && isAbsolute(this.config.executablePath)) {
      candidates.push({ path: this.config.executablePath, source: 'configured' });
    }
    for (const path of bundledCodexCandidates(
      this.dependencies.applicationRoot,
      this.dependencies.resourcesPath,
      this.dependencies.platform,
      this.dependencies.arch,
    )) candidates.push({ path, source: 'bundled' });
    return candidates.filter((candidate, index, all) => (
      all.findIndex((other) => other.path === candidate.path) === index
    ));
  }

  private requireConnection(): AppServerConnection {
    if (!this.connection || this.snapshot.phase !== 'ready') {
      throw new Error('请先从界面启动 Codex App Server。');
    }
    return this.connection;
  }

  private disconnect(): void {
    this.connectionGeneration += 1;
    try {
      this.removeNotificationListener?.();
    } catch {
      // Listener cleanup must not prevent the child from being terminated.
    }
    try {
      this.removeExitListener?.();
    } catch {
      // Listener cleanup must not prevent the child from being terminated.
    }
    this.removeNotificationListener = undefined;
    this.removeExitListener = undefined;
    try {
      this.connection?.close();
    } catch {
      // The state is invalidated even if the child already disappeared.
    }
    this.connection = undefined;
    this.pendingLoginId = undefined;
    this.pendingLoginUrl = undefined;
  }

  private enqueueOperation<T>(
    operation: () => Promise<T> | T,
  ): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Codex App Server 服务已关闭。'));
    const run = this.operationTail.then(async () => {
      if (this.disposed) throw new Error('Codex App Server 服务已关闭。');
      return operation();
    });
    this.operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private runAuthAction(
    action: () => Promise<CodexAppServerSnapshot>,
  ): Promise<CodexAppServerSnapshot> {
    if (this.disposed) return Promise.reject(new Error('Codex App Server 服务已关闭。'));
    if (this.authActionPromise) {
      return Promise.reject(new Error('另一项 App Server 账号操作正在进行，请稍候。'));
    }
    const operation = this.enqueueOperation(action);
    const tracked = operation.finally(() => {
      if (this.authActionPromise === tracked) this.authActionPromise = undefined;
    });
    this.authActionPromise = tracked;
    return tracked;
  }

  private assertLoginCanStart(): void {
    if (this.pendingLoginId || this.snapshot.pendingLogin) {
      throw new Error('已有等待完成的 ChatGPT 登录，请先完成或取消。');
    }
    if (this.snapshot.account) throw new Error('当前已有登录账号，请先退出登录。');
    if (this.snapshot.requiresOpenaiAuth === false) {
      throw new Error('当前模型提供方无需 OpenAI 登录。');
    }
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.disposed && generation === this.connectionGeneration;
  }

  private assertConnectionCurrent(
    connection: AppServerConnection,
    generation: number,
  ): void {
    if (
      !this.isGenerationCurrent(generation)
      || this.connection !== connection
      || this.snapshot.phase !== 'ready'
    ) throw new ConnectionSupersededError();
  }

  private isConnectionSuperseded(
    error: unknown,
    connection: AppServerConnection,
    generation: number,
  ): boolean {
    return error instanceof ConnectionSupersededError
      || this.disposed
      || generation !== this.connectionGeneration
      || this.connection !== connection;
  }

  private handleConnectionExit(
    connection: AppServerConnection,
    generation: number,
    error: Error,
  ): void {
    if (!this.isGenerationCurrent(generation) || this.connection !== connection) return;
    this.connectionGeneration += 1;
    try {
      this.removeNotificationListener?.();
    } catch {
      // The dead connection is discarded even if listener removal misbehaves.
    }
    try {
      this.removeExitListener?.();
    } catch {
      // The dead connection is discarded even if listener removal misbehaves.
    }
    this.removeNotificationListener = undefined;
    this.removeExitListener = undefined;
    this.connection = undefined;
    this.pendingLoginId = undefined;
    this.pendingLoginUrl = undefined;
    this.completedLogins.clear();
    this.update({
      phase: 'error',
      operation: 'idle',
      account: undefined,
      requiresOpenaiAuth: undefined,
      models: [],
      pendingLogin: undefined,
      error: this.actionError(error),
    });
  }

  private assertHttps(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error('App Server 返回了无效登录地址。');
    }
    if (url.protocol !== 'https:') throw new Error('App Server 登录地址必须使用 HTTPS。');
    if (url.username || url.password) {
      throw new Error('App Server 登录地址不能包含用户名或密码。');
    }
  }

  private actionError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  }

  private update(patch: Partial<CodexAppServerSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      revision: this.snapshot.revision + 1,
    };
    const cloned = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(cloned);
      } catch {
        // One renderer/window listener must not break service state transitions.
      }
    }
  }

  private readConfig(): StoredAppServerConfig {
    try {
      return parseConfig(JSON.parse(readFileSync(this.configPath, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bound: false };
      this.initialConfigError = `App Server 配置已损坏并被忽略，可从界面重新绑定：${this.actionError(error)}`;
      return { bound: false };
    }
  }

  private writeConfig(config = this.config): void {
    mkdirSync(dirname(this.configPath), { recursive: true });
    const temporaryPath = `${this.configPath}.tmp-${process.pid}-${randomUUID()}`;
    const persisted: StoredAppServerConfig = {
      executablePath: config.executablePath,
      modelId: config.modelId,
      reasoningEffort: config.reasoningEffort,
      bound: config.bound,
    };
    writeFileSync(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporaryPath, this.configPath);
  }
}
