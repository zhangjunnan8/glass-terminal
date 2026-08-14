import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { AGENT_CHANNELS } from '../../shared/agent';
import type {
  AgentChatItem,
  AgentSessionView,
  CommandActor,
  CommandApproval,
  ResolveApprovalRequest,
  SendAgentPromptRequest,
} from '../../shared/agent';
import type { ProviderStore } from '../providers/provider-store';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';
import { AgentLoop } from './agent-loop';
import type { AgentCommandResult, AgentMessage, AgentProviderRuntime } from './agent-loop';
import { GenericOpenAiProvider } from './generic-provider';

interface ApprovalResolution {
  decision: 'execute' | 'edit' | 'reject';
  command: string;
}

interface AgentRuntimeRecord extends AgentSessionView {
  owner: WebContents;
  ownerId: number;
  priorMessages: AgentMessage[];
  abortController?: AbortController;
  turnToken: number;
  resolveApproval?: (resolution: ApprovalResolution) => void;
}

const SYSTEM_PROMPT = `You are the AI agent inside AI Terminal.
You and the human operate the exact same visible terminal session. Use only the provided terminal tools.
Never invent command output. Read terminal state/history when needed, request one clear command at a time, inspect its structured result, and continue until the user's goal is handled.
Do not ask the user to send passwords, API keys, passphrases, OTPs, or other credentials through chat. Authentication is entered by the user directly in the visible terminal.
Commands require explicit user approval unless the UI reports that Full Takeover is active.`;

function cloneView(runtime: AgentRuntimeRecord): AgentSessionView {
  return {
    terminalId: runtime.terminalId,
    sessionId: runtime.sessionId,
    threadId: runtime.threadId,
    providerId: runtime.providerId,
    state: runtime.state,
    fullTakeover: runtime.fullTakeover,
    messages: runtime.messages.map((message) => ({ ...message })),
    pendingApproval: runtime.pendingApproval ? { ...runtime.pendingApproval } : undefined,
    activeExecution: runtime.activeExecution ? { ...runtime.activeExecution } : undefined,
    error: runtime.error,
  };
}

function safePriorMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) return [];
  return value.filter((message): message is AgentMessage => (
    Boolean(message)
    && typeof message === 'object'
    && ['user', 'assistant', 'tool'].includes((message as { role?: string }).role ?? '')
  ));
}

export class AgentService {
  private readonly runtimes = new Map<string, AgentRuntimeRecord>();

  constructor(
    private readonly terminals: TerminalService,
    private readonly sessions: SessionManager,
    private readonly providers: ProviderStore,
    private readonly providerFactory: (providerId: string) => AgentProviderRuntime = (
      providerId,
    ) => new GenericOpenAiProvider(providerId, providers),
  ) {}

  sendPrompt(owner: WebContents, request: SendAgentPromptRequest): AgentSessionView {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('Agent prompt cannot be empty.');
    if (prompt.length > 20_000) throw new Error('Agent prompt exceeds 20,000 characters.');
    const provider = request.providerId
      ? this.providers.get(request.providerId)
      : this.providers.list().find((profile) => profile.isDefault);
    if (!provider) throw new Error('Configure a default Provider first.');
    if (provider.status !== 'ready') throw new Error(`Provider ${provider.name} is not Ready.`);

    const session = this.sessions.upgrade(owner, request.terminalId);
    let runtime = this.runtimes.get(request.terminalId);
    if (runtime && runtime.ownerId !== owner.id) throw new Error('Agent Session ownership mismatch.');
    if (runtime && ['THINKING', 'WAITING_APPROVAL', 'AI_CONTROL', 'RUNNING', 'WAITING_OUTPUT'].includes(runtime.state)) {
      throw new Error('The Agent is already working in this terminal.');
    }

    if (!runtime || runtime.providerId !== provider.id || runtime.sessionId !== session.id) {
      const canReuseThread = session.providerId === provider.id && Boolean(session.aiThreadId);
      const threadId = canReuseThread ? session.aiThreadId! : randomUUID();
      if (!canReuseThread) this.sessions.bindAgentThread(session.id, provider.id, threadId);
      const persisted = this.sessions.readThreadEvents(session.id, threadId);
      const chats = persisted
        .filter((event) => event.type === 'chat')
        .map((event) => event.item as AgentChatItem)
        .filter((item) => item && typeof item.content === 'string');
      const lastTurn = [...persisted].reverse().find((event) => event.type === 'turn');
      runtime = {
        owner,
        ownerId: owner.id,
        terminalId: request.terminalId,
        sessionId: session.id,
        threadId,
        providerId: provider.id,
        state: 'USER_CONTROL',
        fullTakeover: false,
        messages: chats,
        priorMessages: safePriorMessages(lastTurn?.messages),
        turnToken: 0,
      };
      this.runtimes.set(request.terminalId, runtime);
    }

    runtime.turnToken += 1;
    const token = runtime.turnToken;
    runtime.abortController = new AbortController();
    runtime.error = undefined;
    runtime.activeExecution = undefined;
    this.addChat(runtime, 'user', prompt);
    runtime.state = 'THINKING';
    this.emit(runtime);
    void this.runTurn(runtime, token, prompt);
    return cloneView(runtime);
  }

  getState(owner: WebContents, terminalId: string): AgentSessionView | null {
    const runtime = this.runtimes.get(terminalId);
    if (!runtime) return null;
    if (runtime.ownerId !== owner.id) throw new Error('Agent Session not found.');
    return cloneView(runtime);
  }

  resolveApproval(owner: WebContents, request: ResolveApprovalRequest): AgentSessionView {
    const runtime = this.requireOwned(owner, request.terminalId);
    const approval = runtime.pendingApproval;
    if (!approval || approval.id !== request.approvalId || !runtime.resolveApproval) {
      throw new Error('Command approval is no longer pending.');
    }
    const command = request.decision === 'edit'
      ? request.editedCommand?.trim() ?? ''
      : approval.command;
    if (request.decision !== 'reject' && !command) throw new Error('Edited command cannot be empty.');
    const resolvedAt = new Date().toISOString();
    runtime.pendingApproval = {
      ...approval,
      command,
      status: request.decision === 'reject'
        ? 'rejected'
        : request.decision === 'edit' ? 'edited' : 'approved',
      resolvedAt,
    };
    if (request.decision === 'reject') {
      this.sessions.appendAudit(runtime.sessionId, 'command_rejected', 'user', {
        approvalId: approval.id,
        command: approval.command,
      });
      runtime.state = 'THINKING';
    } else if (request.decision === 'edit') {
      this.sessions.appendAudit(runtime.sessionId, 'command_edited', 'user', {
        approvalId: approval.id,
        requestedCommand: approval.command,
        command,
      });
      runtime.state = 'AI_CONTROL';
    } else {
      this.sessions.appendAudit(runtime.sessionId, 'command_approved', 'user', {
        approvalId: approval.id,
        command,
      });
      runtime.state = 'AI_CONTROL';
    }
    const resolve = runtime.resolveApproval;
    runtime.resolveApproval = undefined;
    this.emit(runtime);
    resolve({ decision: request.decision, command });
    return cloneView(runtime);
  }

  closeOwnedBy(ownerId: number): void {
    for (const [terminalId, runtime] of this.runtimes) {
      if (runtime.ownerId !== ownerId) continue;
      runtime.turnToken += 1;
      runtime.abortController?.abort();
      runtime.resolveApproval?.({ decision: 'reject', command: '' });
      this.runtimes.delete(terminalId);
    }
  }

  close(): void {
    for (const runtime of this.runtimes.values()) runtime.abortController?.abort();
    this.runtimes.clear();
  }

  private async runTurn(
    runtime: AgentRuntimeRecord,
    token: number,
    prompt: string,
  ): Promise<void> {
    const signal = runtime.abortController!.signal;
    const provider = this.providerFactory(runtime.providerId);
    const loop = new AgentLoop(provider, {
      readTerminal: async ({ maxChars }) => (
        this.sessions.readTerminalHistory(runtime.sessionId).slice(-maxChars)
      ),
      getTerminalState: async () => ({
        ...this.terminals.state(runtime.owner, runtime.terminalId),
        controlState: runtime.state,
      }),
      executeCommand: (request) => this.requestCommand(runtime, token, request),
    }, (event) => {
      if (runtime.turnToken !== token) return;
      if (event.type === 'assistant_text' && event.text) {
        this.addChat(runtime, 'assistant', event.text);
        this.emit(runtime);
      }
    });

    try {
      const context = this.sessions.readTerminalHistory(runtime.sessionId).slice(-12_000);
      const result = await loop.run({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: prompt,
        terminalContext: context,
        priorMessages: runtime.priorMessages,
        signal,
      });
      if (runtime.turnToken !== token) return;
      runtime.priorMessages = result.messages.filter((message) => message.role !== 'system');
      this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
        type: 'turn',
        id: result.id,
        timestamp: new Date().toISOString(),
        messages: runtime.priorMessages,
      });
      runtime.pendingApproval = undefined;
      runtime.activeExecution = undefined;
      runtime.state = 'COMPLETED';
      this.emit(runtime);
    } catch (error) {
      if (runtime.turnToken !== token) return;
      runtime.pendingApproval = undefined;
      runtime.activeExecution = undefined;
      runtime.error = error instanceof Error ? error.message : String(error);
      runtime.state = signal.aborted ? 'PAUSED' : 'FAILED';
      this.emit(runtime);
    }
  }

  private async requestCommand(
    runtime: AgentRuntimeRecord,
    token: number,
    request: { command: string; reason?: string },
  ): Promise<AgentCommandResult> {
    if (runtime.turnToken !== token) throw new Error('Agent turn is no longer active.');
    const approval: CommandApproval = {
      id: randomUUID(),
      sessionId: runtime.sessionId,
      terminalId: runtime.terminalId,
      command: request.command,
      reason: request.reason,
      status: 'waiting',
      requestedAt: new Date().toISOString(),
    };
    runtime.pendingApproval = approval;
    runtime.state = 'WAITING_APPROVAL';
    this.sessions.appendAudit(runtime.sessionId, 'command_requested', 'ai', {
      approvalId: approval.id,
      command: approval.command,
      reason: approval.reason,
    });
    this.emit(runtime);

    const resolution = await new Promise<ApprovalResolution>((resolve) => {
      runtime.resolveApproval = resolve;
    });
    runtime.pendingApproval = undefined;
    if (runtime.turnToken !== token) throw new Error('Agent turn is no longer active.');
    if (resolution.decision === 'reject') {
      return {
        executionId: approval.id,
        command: approval.command,
        status: 'rejected',
        output: 'User rejected this command.',
      };
    }

    const actor: CommandActor = resolution.decision === 'edit'
      ? 'user_modified_ai_command'
      : 'ai';
    runtime.state = 'RUNNING';
    this.emit(runtime);
    const execution = await this.terminals.executeStructured(
      runtime.owner,
      runtime.terminalId,
      resolution.command,
      actor,
      undefined,
      (started) => {
        runtime.activeExecution = started;
        runtime.state = 'RUNNING';
        this.emit(runtime);
      },
    );
    runtime.activeExecution = execution;
    runtime.state = 'WAITING_OUTPUT';
    this.sessions.appendAudit(runtime.sessionId, 'command_completed', 'system', {
      executionId: execution.id,
      command: execution.command,
      actor: execution.actor,
      status: execution.status === 'running' ? 'failed' : execution.status,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
    });
    this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
      type: 'command_execution',
      timestamp: new Date().toISOString(),
      execution,
    });
    this.emit(runtime);
    runtime.state = 'THINKING';
    return {
      executionId: execution.id,
      command: execution.command,
      status: execution.status === 'running' ? 'failed' : execution.status,
      exitCode: execution.exitCode,
      output: execution.output,
      durationMs: execution.durationMs,
    };
  }

  private addChat(
    runtime: AgentRuntimeRecord,
    role: AgentChatItem['role'],
    content: string,
  ): void {
    const item: AgentChatItem = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString(),
    };
    runtime.messages.push(item);
    this.sessions.appendThreadEvent(runtime.sessionId, runtime.threadId, {
      type: 'chat',
      timestamp: item.createdAt,
      item,
    });
  }

  private requireOwned(owner: WebContents, terminalId: string): AgentRuntimeRecord {
    const runtime = this.runtimes.get(terminalId);
    if (!runtime || runtime.ownerId !== owner.id) throw new Error('Agent Session not found.');
    return runtime;
  }

  private emit(runtime: AgentRuntimeRecord): void {
    if (!runtime.owner.isDestroyed()) {
      runtime.owner.send(AGENT_CHANNELS.stateChanged, cloneView(runtime));
    }
  }
}
