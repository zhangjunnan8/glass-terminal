import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CommandActor, CommandExecution } from '../../shared/agent';
import type { ProviderProfile } from '../../shared/provider';
import type { SessionRecord } from '../../shared/session';
import type { ProviderStore } from '../providers/provider-store';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';
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
  readonly audits: string[] = [];
  readonly threadEvents: Array<Record<string, unknown>> = [];
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
    this.threadEvents.push(event);
  }
  readTerminalHistory() { return 'tester@host:~$ '; }
  appendAudit(_sessionId: string, type: string) { this.audits.push(type); }
}

class FakeTerminals {
  readonly executions: Array<{ command: string; actor: CommandActor }> = [];

  state() { return { transport: 'ssh', shellKind: 'posix', status: 'connected' }; }
  async executeStructured(
    _owner: WebContents,
    terminalId: string,
    command: string,
    actor: CommandActor,
    _onOutput?: (data: string) => void,
    onStarted?: (execution: CommandExecution) => void,
  ): Promise<CommandExecution> {
    this.executions.push({ command, actor });
    const started: CommandExecution = {
      id: 'execution-1',
      sessionId: '11111111-1111-1111-1111-111111111111',
      terminalId,
      actor,
      command,
      requestedAt: new Date(0).toISOString(),
      startedAt: new Date(0).toISOString(),
      status: 'running',
      output: '',
    };
    onStarted?.(started);
    return {
      ...started,
      status: 'completed',
      exitCode: 0,
      output: 'tester\n',
      endedAt: new Date(1).toISOString(),
      durationMs: 1,
    };
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

describe('AgentService approval bridge', () => {
  it('executes an edited command in the owned visible terminal and completes the loop', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{
            id: 'call-1',
            name: 'terminal_execute',
            arguments: '{"command":"whoami","reason":"identify user"}',
          }],
        },
      },
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
    expect(sessions.audits).toEqual(expect.arrayContaining([
      'command_requested',
      'command_edited',
      'command_completed',
    ]));
    expect(service.getState(owner, 'terminal')?.messages.at(-1)?.content)
      .toBe('The effective user is tester.');
  });

  it('returns rejection to the Provider without writing any terminal input', async () => {
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'call-1', name: 'terminal_execute', arguments: '{"command":"uname"}' }],
        },
      },
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
    expect(sessions.audits).toContain('command_rejected');
    const toolResult = provider.requests[1].messages.find((message) => message.role === 'tool');
    expect(toolResult?.content).toContain('User rejected');
  });
});
