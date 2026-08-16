import type { WebContents } from 'electron';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import type { SessionRecord } from '../../shared/session';
import type { ProviderStore } from '../providers/provider-store';
import type { SessionManager } from '../sessions/session-manager';
import type {
  StructuredExecutionHooks,
  TerminalService,
} from '../terminal/terminal-service';
import { AgentService } from '../agent/agent-service';
import type {
  AppServerConnection,
  AppServerNotification,
  AppServerRequest,
  AppServerRequestHandler,
} from './app-server-client';
import {
  bundledCodexCandidates,
  CodexAppServerService,
} from './app-server-service';

const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const TERMINAL_ID = 'terminal';
const PROVIDER_THREAD_ID = 'provider-thread-1';
const OUTPUT_CANARY = '__SAME_VISIBLE_TERMINAL_OUTPUT__';

interface RecordedRequest {
  method: string;
  params?: unknown;
}

interface RecordedAudit {
  type: string;
  actor?: string;
  details?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a record.');
  }
  return value as Record<string, unknown>;
}

class FakeAppServerConnection implements AppServerConnection {
  readonly requests: RecordedRequest[] = [];
  readonly notifications: RecordedRequest[] = [];
  readonly models = [{
    id: 'gpt-codex-test',
    model: 'gpt-codex-test',
    displayName: 'GPT Codex Test',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
    ],
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: true,
  }];
  latestTurnId?: string;
  closed = false;
  private turnSequence = 0;
  private readonly notificationListeners = new Set<(
    notification: AppServerNotification,
  ) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private requestHandler?: AppServerRequestHandler;

  request<T>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params });
    if (method === 'account/read') {
      return Promise.resolve({
        account: { type: 'chatgpt', email: 'integration@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      }) as Promise<T>;
    }
    if (method === 'model/list') {
      return Promise.resolve({ data: this.models, nextCursor: null }) as Promise<T>;
    }
    if (method === 'permissionProfile/list') {
      return Promise.resolve({
        data: [{ id: ':workspace', description: null, allowed: true }],
        nextCursor: null,
      }) as Promise<T>;
    }
    if (method === 'account/logout') return Promise.resolve({}) as Promise<T>;
    if (method === 'thread/start') {
      return Promise.resolve({ thread: { id: PROVIDER_THREAD_ID } }) as Promise<T>;
    }
    if (method === 'thread/resume') {
      return Promise.resolve({
        thread: { id: asRecord(params).threadId },
      }) as Promise<T>;
    }
    if (method === 'turn/start') {
      this.turnSequence += 1;
      this.latestTurnId = `provider-turn-${this.turnSequence}`;
      return Promise.resolve({
        turn: { id: this.latestTurnId, status: 'inProgress', items: [] },
      }) as Promise<T>;
    }
    if (method === 'turn/interrupt') return Promise.resolve({}) as Promise<T>;
    return Promise.reject(new Error(`Unexpected App Server request: ${method}`));
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

  invoke(method: string, params?: unknown, id: number | string = 1): Promise<unknown> {
    if (!this.requestHandler) return Promise.reject(new Error('No request handler.'));
    return Promise.resolve(this.requestHandler({ id, method, params } as AppServerRequest));
  }
}

class FakeSessions {
  readonly audits: RecordedAudit[] = [];
  readonly threadEvents: Array<{
    sessionId: string;
    localThreadId: string;
    event: Record<string, unknown>;
  }> = [];
  session: SessionRecord = {
    schemaVersion: 1,
    id: SESSION_ID,
    name: 'App Server Integration',
    nameSource: 'automatic',
    transport: 'ssh',
    hostId: 'host',
    shellProfileId: 'ssh:host',
    shellKind: 'posix',
    targetSnapshot: {
      label: 'Test', hostname: '192.168.31.93', port: 22, username: 'tester',
    },
    connectionState: 'connected',
    status: 'active',
    runtimeTerminalId: TERMINAL_ID,
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

  upgrade(): SessionRecord {
    return this.session;
  }

  sessionForTerminal(): SessionRecord {
    return this.session;
  }

  bindAgentBackendThread(
    _sessionId: string,
    backend: AgentBackendRef,
    localThreadId: string,
  ): SessionRecord {
    this.session = {
      ...this.session,
      agentBackend: backend,
      aiThreadId: localThreadId,
      providerId: backend.kind === 'generic-provider' ? backend.providerId : undefined,
      providerThreadId: undefined,
    };
    return this.session;
  }

  bindProviderThread(
    _sessionId: string,
    localThreadId: string,
    providerThreadId: string,
  ): SessionRecord {
    if (this.session.aiThreadId !== localThreadId) throw new Error('Stale local thread.');
    this.session = { ...this.session, providerThreadId };
    return this.session;
  }

  readThreadEvents(): Record<string, unknown>[] {
    return [];
  }

  appendThreadEvent(
    sessionId: string,
    localThreadId: string,
    event: Record<string, unknown>,
  ): void {
    this.threadEvents.push({ sessionId, localThreadId, event });
  }

  readTerminalHistory(): string {
    return 'tester@host:~$ visible-history-canary';
  }

  appendAudit(
    _sessionId: string,
    type: string,
    actor?: string,
    details?: Record<string, unknown>,
  ): void {
    this.audits.push({ type, actor, details });
  }
}

class FakeTerminals {
  readonly backend = {
    id: 'single-visible-terminal-backend',
    writes: [] as Array<{
      backend: object;
      ownerId: number;
      terminalId: string;
      command: string;
      actor: CommandActor;
    }>,
  };
  readonly controlModes: TerminalInputMode[] = [];
  private controlLease?: string;
  private current?: CommandExecution;
  private exitListener?: (terminalId: string, ownerId: number) => void;
  private sensitiveSubmissionListener?: (
    terminalId: string,
    ownerId: number,
    executionId: string,
    leaseId: string,
  ) => void;

  onExit(listener: (terminalId: string, ownerId: number) => void): () => void {
    this.exitListener = listener;
    return () => { this.exitListener = undefined; };
  }

  onSensitiveSubmission(listener: (
    terminalId: string,
    ownerId: number,
    executionId: string,
    leaseId: string,
  ) => void): () => void {
    this.sensitiveSubmissionListener = listener;
    return () => { this.sensitiveSubmissionListener = undefined; };
  }

  state(): Record<string, unknown> {
    return { transport: 'ssh', shellKind: 'posix', status: 'connected' };
  }

  currentExecution(): CommandExecution | undefined {
    return this.current ? { ...this.current } : undefined;
  }

  acquireAgentControl(): string {
    if (this.controlLease) throw new Error('Terminal is already leased.');
    this.controlLease = 'control-lease';
    this.controlModes.push('locked');
    return this.controlLease;
  }

  setAgentControlMode(
    _owner: WebContents,
    _terminalId: string,
    leaseId: string,
    mode: Exclude<TerminalInputMode, 'human'>,
  ): void {
    if (leaseId !== this.controlLease) throw new Error('Stale terminal control lease.');
    this.controlModes.push(mode);
  }

  releaseAgentControl(
    _owner: WebContents,
    _terminalId: string,
    leaseId: string,
  ): boolean {
    if (leaseId !== this.controlLease) return false;
    this.controlLease = undefined;
    this.controlModes.push('human');
    return true;
  }

  async executeStructured(
    owner: WebContents,
    terminalId: string,
    command: string,
    actor: CommandActor,
    hooks: StructuredExecutionHooks = {},
  ): Promise<CommandExecution> {
    if (terminalId !== TERMINAL_ID) throw new Error('Unexpected terminal route.');
    this.backend.writes.push({
      backend: this.backend,
      ownerId: owner.id,
      terminalId,
      command,
      actor,
    });
    const started: CommandExecution = {
      id: 'execution-1',
      sessionId: SESSION_ID,
      terminalId,
      actor,
      command,
      requestedAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      status: 'running',
      output: '',
    };
    this.current = started;
    hooks.onStarted?.({ ...started });
    const completed: CommandExecution = {
      ...started,
      status: 'completed',
      exitCode: 0,
      output: OUTPUT_CANARY,
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
    };
    this.current = undefined;
    return completed;
  }
}

function owner(): WebContents {
  return {
    id: 99,
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

const roots: string[] = [];
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  for (const root of roots.splice(0)) {
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'ai-terminal-app-server-agent-integration-'));
  roots.push(root);
  const executable = bundledCodexCandidates(root, root, 'win32', 'x64')[0];
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, 'fake codex binary');
  const connection = new FakeAppServerConnection();
  const appServer = new CodexAppServerService(
    join(root, 'config.json'),
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
  await appServer.start();
  appServer.saveSelection({ modelId: 'gpt-codex-test', reasoningEffort: 'medium' });
  appServer.setTerminalAgentEnabled({
    enabled: true,
    acknowledgementVersion: 1,
  });

  const sessions = new FakeSessions();
  const terminals = new FakeTerminals();
  const browser = owner();
  const agents = new AgentService(
    terminals as unknown as TerminalService,
    sessions as unknown as SessionManager,
    {} as ProviderStore,
    () => { throw new Error('Generic Provider must not be used.'); },
    appServer,
  );
  disposers.push(() => {
    agents.close();
    appServer.close();
  });
  return { agents, appServer, browser, connection, sessions, terminals };
}

function sendCodexPrompt(agents: AgentService, browser: WebContents, prompt: string): void {
  agents.sendPrompt(browser, {
    terminalId: TERMINAL_ID,
    prompt,
    backend: {
      kind: CODEX_APP_SERVER_AGENT_BACKEND,
      policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
    },
  });
}

async function waitForTurnStart(
  connection: FakeAppServerConnection,
  expectedCount = 1,
): Promise<string> {
  await vi.waitFor(() => {
    expect(connection.requests.filter((request) => request.method === 'turn/start')).toHaveLength(
      expectedCount,
    );
  });
  if (!connection.latestTurnId) throw new Error('Missing fake provider turn id.');
  return connection.latestTurnId;
}

function completeTurn(
  connection: FakeAppServerConnection,
  turnId: string,
  text: string,
): void {
  connection.emit('turn/completed', {
    threadId: PROVIDER_THREAD_ID,
    turn: {
      id: turnId,
      status: 'completed',
      items: [{ id: 'assistant-1', type: 'agentMessage', text }],
    },
  });
}

describe('Codex App Server Agent integration', () => {
  it.skip('legacy shared-terminal execute routing', async () => {
    const {
      agents,
      browser,
      connection,
      sessions,
      terminals,
    } = await harness();

    sendCodexPrompt(agents, browser, 'Run a command in the shared terminal.');
    const turnId = await waitForTurnStart(connection);
    expect(terminals.backend.writes).toEqual([]);

    const toolResponsePromise = connection.invoke('item/tool/call', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      callId: 'dynamic-execute-1',
      tool: 'terminal_execute',
      arguments: {
        command: 'printf requested-command',
        reason: 'prove shared terminal routing',
      },
    });
    expect(terminals.backend.writes).toEqual([]);
    await vi.waitFor(() => {
      expect(agents.getState(browser, TERMINAL_ID)?.state).toBe('WAITING_APPROVAL');
    });
    expect(terminals.backend.writes).toEqual([]);

    const approval = agents.getState(browser, TERMINAL_ID)!.pendingApproval!;
    agents.resolveApproval(browser, {
      terminalId: TERMINAL_ID,
      approvalId: approval.id,
      decision: 'edit',
      editedCommand: 'printf edited-visible-command',
    });

    const toolResponse = asRecord(await toolResponsePromise);
    expect(toolResponse.success).toBe(true);
    const contentItem = asRecord((toolResponse.contentItems as unknown[])[0]);
    expect(JSON.parse(contentItem.text as string)).toMatchObject({
      ok: true,
      result: {
        command: 'printf edited-visible-command',
        status: 'completed',
        output: OUTPUT_CANARY,
      },
    });
    expect(terminals.backend.writes).toHaveLength(1);
    expect(terminals.backend.writes[0]).toMatchObject({
      ownerId: browser.id,
      terminalId: TERMINAL_ID,
      command: 'printf edited-visible-command',
      actor: 'user_modified_ai_command',
    });
    expect(terminals.backend.writes[0].backend).toBe(terminals.backend);

    completeTurn(connection, turnId, `Observed ${OUTPUT_CANARY}`);
    await vi.waitFor(() => {
      expect(agents.getState(browser, TERMINAL_ID)?.state).toBe('COMPLETED');
    });

    const view = agents.getState(browser, TERMINAL_ID)!;
    expect(view.backend).toEqual({
      kind: CODEX_APP_SERVER_AGENT_BACKEND,
      policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
    });
    expect(sessions.session).toMatchObject({
      aiThreadId: view.threadId,
      providerThreadId: PROVIDER_THREAD_ID,
      agentBackend: view.backend,
    });
    expect(sessions.threadEvents).toContainEqual(expect.objectContaining({
      sessionId: SESSION_ID,
      localThreadId: view.threadId,
      event: expect.objectContaining({
        type: 'codex_app_server_turn',
        providerThreadId: PROVIDER_THREAD_ID,
        providerTurnId: turnId,
        status: 'completed',
        policyVersion: CODEX_APP_SERVER_AGENT_POLICY_VERSION,
      }),
    }));
    expect(sessions.audits.map((audit) => audit.type)).toEqual([
      'command_requested',
      'command_edited',
      'command_completed',
    ]);
    expect(sessions.audits.at(-1)).toMatchObject({
      type: 'command_completed',
      actor: 'system',
      details: {
        actor: 'user_modified_ai_command',
        command: 'printf edited-visible-command',
        status: 'completed',
      },
    });
  });

  it.skip('legacy built-in command isolation lock', async () => {
    const {
      agents,
      appServer,
      browser,
      connection,
      sessions,
      terminals,
    } = await harness();

    sendCodexPrompt(agents, browser, 'Do not use built-in command tools.');
    const firstTurnId = await waitForTurnStart(connection);
    await expect(connection.invoke('item/commandExecution/requestApproval', {
      threadId: PROVIDER_THREAD_ID,
      turnId: firstTurnId,
      itemId: 'builtin-command-approval-1',
      startedAtMs: 1,
      command: 'whoami',
    })).resolves.toEqual({ decision: 'decline' });
    await vi.waitFor(() => {
      expect(appServer.getState().agentIsolation.availability).toBe('blocked');
      expect(agents.getState(browser, TERMINAL_ID)?.state).toBe('FAILED');
    });
    expect(appServer.getState()).toMatchObject({
      terminalAgentEnabled: false,
      agentIsolation: {
        userEnabled: false,
        availability: 'blocked',
        lastViolation: { kind: 'command-execution' },
      },
    });
    expect(terminals.backend.writes).toEqual([]);
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: PROVIDER_THREAD_ID, turnId: firstTurnId },
    });

    appServer.setTerminalAgentEnabled({
      enabled: true,
      acknowledgementVersion: 1,
    });
    sendCodexPrompt(agents, browser, 'Again, use only dynamic terminal tools.');
    const secondTurnId = await waitForTurnStart(connection, 2);
    connection.emit('item/started', {
      threadId: PROVIDER_THREAD_ID,
      turnId: secondTurnId,
      item: {
        id: 'builtin-command-item-2',
        type: 'commandExecution',
        command: 'uname -a',
        status: 'inProgress',
      },
    });
    await vi.waitFor(() => {
      expect(appServer.getState().agentIsolation.availability).toBe('blocked');
      expect(agents.getState(browser, TERMINAL_ID)?.state).toBe('FAILED');
    });
    expect(appServer.getState()).toMatchObject({
      terminalAgentEnabled: false,
      agentIsolation: {
        userEnabled: false,
        availability: 'blocked',
        lastViolation: {
          kind: 'command-execution',
          detail: expect.stringContaining('commandExecution'),
        },
      },
    });
    expect(terminals.backend.writes).toEqual([]);
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: PROVIDER_THREAD_ID, turnId: secondTurnId },
    });
    expect(connection.requests).toContainEqual(expect.objectContaining({
      method: 'thread/resume',
      params: expect.objectContaining({ threadId: PROVIDER_THREAD_ID }),
    }));
    expect(sessions.audits.filter((audit) => audit.type.startsWith('command_'))).toEqual([]);
  });

  it.skip('legacy terminal_execute revocation path', async () => {
    const {
      agents,
      appServer,
      browser,
      connection,
      terminals,
    } = await harness();

    sendCodexPrompt(agents, browser, 'Wait for account revocation.');
    const turnId = await waitForTurnStart(connection);
    await appServer.logout();
    expect(appServer.getState().terminalAgentEnabled).toBe(false);
    expect(connection.requests).toContainEqual({
      method: 'turn/interrupt',
      params: { threadId: PROVIDER_THREAD_ID, turnId },
    });

    await expect(connection.invoke('item/tool/call', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      callId: 'after-logout',
      tool: 'terminal_execute',
      arguments: { command: 'printf must-not-run' },
    })).rejects.toThrow('中断');
    expect(terminals.backend.writes).toEqual([]);

    connection.emit('turn/completed', {
      threadId: PROVIDER_THREAD_ID,
      turn: { id: turnId, status: 'interrupted', items: [] },
    });
    await vi.waitFor(() => {
      expect(agents.getState(browser, TERMINAL_ID)?.state).toBe('PAUSED');
    });
  });

  it('keeps the visible terminal human-owned and exposes only read-only context', async () => {
    const { agents, browser, connection, sessions, terminals } = await harness();
    sendCodexPrompt(agents, browser, 'Use native Codex tools and inspect terminal context.');
    const turnId = await waitForTurnStart(connection);

    expect(agents.getState(browser, TERMINAL_ID)).toMatchObject({
      state: 'THINKING',
      terminalInputMode: 'human',
      fullTakeover: false,
    });
    expect(terminals.controlModes).toEqual([]);
    expect(terminals.backend.writes).toEqual([]);

    const read = asRecord(await connection.invoke('item/tool/call', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      callId: 'read-visible-context',
      tool: 'terminal_read',
      arguments: { maxChars: 500 },
    }));
    expect(read.success).toBe(true);
    expect(JSON.stringify(read)).toContain('visible-history-canary');

    const state = asRecord(await connection.invoke('item/tool/call', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      callId: 'read-visible-state',
      tool: 'terminal_state',
      arguments: {},
    }));
    expect(state.success).toBe(true);
    expect(JSON.stringify(state)).toContain('192.168.31.93');
    expect(JSON.stringify(state)).toContain('/home/tester/project');
    expect(JSON.stringify(state)).toContain('local ');
    expect(JSON.stringify(state)).toContain('App Server process');

    const execute = asRecord(await connection.invoke('item/tool/call', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      callId: 'execute-must-not-route',
      tool: 'terminal_execute',
      arguments: { command: 'printf must-not-run' },
    }));
    expect(execute.success).toBe(false);
    expect(terminals.backend.writes).toEqual([]);

    completeTurn(connection, turnId, 'Native work complete.');
    await vi.waitFor(() => {
      expect(agents.getState(browser, TERMINAL_ID)?.state).toBe('COMPLETED');
    });
    expect(terminals.controlModes).toEqual([]);
    expect(sessions.session.providerThreadId).toBe(PROVIDER_THREAD_ID);
  });

  it('auto-resolves native command/file approvals and records them without takeover', async () => {
    const { agents, browser, connection, sessions, terminals } = await harness();
    sendCodexPrompt(agents, browser, 'Run work inside the native Codex workspace.');
    const turnId = await waitForTurnStart(connection);

    await expect(connection.invoke('item/commandExecution/requestApproval', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      itemId: 'native-command',
    })).resolves.toEqual({ decision: 'acceptForSession' });
    await expect(connection.invoke('item/fileChange/requestApproval', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      itemId: 'native-file-change',
    })).resolves.toEqual({ decision: 'acceptForSession' });
    connection.emit('item/started', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      item: { id: 'native-command', type: 'commandExecution', status: 'inProgress' },
    });
    connection.emit('item/completed', {
      threadId: PROVIDER_THREAD_ID,
      turnId,
      item: { id: 'native-file-change', type: 'fileChange', status: 'completed' },
    });

    expect(terminals.backend.writes).toEqual([]);
    expect(terminals.controlModes).toEqual([]);
    expect(sessions.audits.filter((audit) => audit.type === 'codex_native_approval'))
      .toHaveLength(2);
    completeTurn(connection, turnId, 'Native approvals resolved.');
    await vi.waitFor(() => {
      expect(agents.getState(browser, TERMINAL_ID)?.state).toBe('COMPLETED');
    });
  });
});
