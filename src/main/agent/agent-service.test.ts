import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CommandActor, CommandExecution, TerminalInputMode } from '../../shared/agent';
import type { ProviderProfile } from '../../shared/provider';
import type { SessionRecord } from '../../shared/session';
import type { ProviderStore } from '../providers/provider-store';
import type { SessionManager } from '../sessions/session-manager';
import type {
  StructuredExecutionHooks,
  TerminalService,
} from '../terminal/terminal-service';
import type { AgentCompletion, AgentCompletionRequest, AgentProviderRuntime } from './agent-loop';
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

class FakeSessions {
  readonly audits: Array<{ type: string; details?: Record<string, unknown> }> = [];
  readonly threadEvents: Array<Record<string, unknown>> = [];
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
  bindAgentThread(_sessionId: string, providerId: string, threadId: string) {
    this.session = { ...this.session, providerId, aiThreadId: threadId };
    return this.session;
  }
  readThreadEvents() { return []; }
  appendThreadEvent(_sessionId: string, _threadId: string, event: Record<string, unknown>) {
    if (this.failThreadEvents) throw new Error('thread persistence failed');
    this.threadEvents.push(event);
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

  it('keeps a foreground process while stale completion cannot resume the Agent', async () => {
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
