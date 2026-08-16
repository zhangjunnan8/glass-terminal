import type { ToolGateway } from '../../shared/tools';
import type {
  AgentBackend,
  AgentBackendResult,
  AgentBackendThread,
  AgentMessage,
  SendAgentBackendMessageInput,
} from './agent-backend';
import { AgentLoop } from './agent-loop';
import type { AgentProviderRuntime } from './agent-loop';

const MAX_BACKEND_THREAD_ID_CHARS = 256;
const MAX_HARNESS_ROUNDS = 64;

interface GenericThreadRecord {
  handle: AgentBackendThread;
  priorMessages: AgentMessage[];
}

interface ActiveGenericTurn {
  controller: AbortController;
}

export interface GenericHarnessBackendOptions {
  maxRounds?: number;
}

function cloneMessages(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      return {
        ...message,
        toolCalls: message.toolCalls?.map((call) => ({ ...call })),
      };
    }
    return { ...message };
  });
}

function normalizedThreadId(id: string): string {
  const normalized = id.trim();
  if (!normalized || normalized.length > MAX_BACKEND_THREAD_ID_CHARS) {
    throw new Error(
      `Agent backend thread id must contain 1-${MAX_BACKEND_THREAD_ID_CHARS} characters.`,
    );
  }
  return normalized;
}

function configuredMaxRounds(value: number | undefined): number {
  if (value === undefined) return 12;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HARNESS_ROUNDS) {
    throw new Error(`Generic Harness maxRounds must be an integer from 1 to ${MAX_HARNESS_ROUNDS}.`);
  }
  return value;
}

function throwIfBackendTurnCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Generic Harness turn cancelled.');
  error.name = 'AbortError';
  throw error;
}

/**
 * Adapts the existing Generic Provider loop to AgentBackend without acquiring
 * any terminal or filesystem dependency. A ToolGateway is mandatory and scoped
 * to exactly one sendMessage call.
 */
export class GenericHarnessBackend implements AgentBackend {
  private readonly threads = new Map<string, GenericThreadRecord>();
  private readonly activeTurns = new Map<string, ActiveGenericTurn>();
  private readonly maxRounds: number;

  constructor(
    private readonly provider: AgentProviderRuntime,
    options: GenericHarnessBackendOptions = {},
  ) {
    this.maxRounds = configuredMaxRounds(options.maxRounds);
  }

  async createThread(input: { id: string; signal?: AbortSignal }): Promise<AgentBackendThread> {
    if (input.signal) throwIfBackendTurnCancelled(input.signal);
    const id = normalizedThreadId(input.id);
    if (this.threads.has(id)) throw new Error(`Agent backend thread ${id} already exists.`);
    const handle = Object.freeze({ id });
    this.threads.set(id, { handle, priorMessages: [] });
    return handle;
  }

  async resume(input: {
    id: string;
    priorMessages: readonly AgentMessage[];
    signal?: AbortSignal;
  }): Promise<AgentBackendThread> {
    if (input.signal) throwIfBackendTurnCancelled(input.signal);
    const id = normalizedThreadId(input.id);
    if (this.activeTurns.has(id)) {
      throw new Error(`Cannot resume active Agent backend thread ${id}.`);
    }
    const handle = Object.freeze({ id });
    this.threads.set(id, {
      handle,
      priorMessages: cloneMessages(input.priorMessages),
    });
    return handle;
  }

  async sendMessage(input: SendAgentBackendMessageInput): Promise<AgentBackendResult> {
    const record = this.requireThread(input.thread);
    if (!input.gateway) throw new Error('Generic Harness requires a per-turn ToolGateway.');
    if (this.activeTurns.has(record.handle.id)) {
      throw new Error(`Agent backend thread ${record.handle.id} already has an active turn.`);
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) abortFromCaller();
    else input.signal.addEventListener('abort', abortFromCaller, { once: true });
    this.activeTurns.set(record.handle.id, { controller });

    try {
      const result = await this.createLoop(
        input.gateway,
        input.onEvent,
      ).run({
        systemPrompt: input.systemPrompt,
        userPrompt: input.prompt,
        terminalContext: input.terminalContext,
        priorMessages: cloneMessages(record.priorMessages),
        fileAccessMode: input.fileAccessMode,
        signal: controller.signal,
      });
      // AgentLoop checks cancellation at its own boundaries, but the backend
      // remains the final authority for committing persistent thread history.
      throwIfBackendTurnCancelled(controller.signal);
      record.priorMessages = cloneMessages(
        result.messages.filter((message) => message.role !== 'system'),
      );
      return {
        ...result,
        messages: cloneMessages(result.messages),
      };
    } finally {
      input.signal.removeEventListener('abort', abortFromCaller);
      const active = this.activeTurns.get(record.handle.id);
      if (active?.controller === controller) this.activeTurns.delete(record.handle.id);
    }
  }

  async interrupt(input: {
    threadId: string;
    reason: 'user' | 'takeover' | 'shutdown';
  }): Promise<void> {
    const threadId = normalizedThreadId(input.threadId);
    this.activeTurns.get(threadId)?.controller.abort(
      new Error(`Generic Harness turn interrupted: ${input.reason}.`),
    );
  }

  private createLoop(
    gateway: ToolGateway,
    onEvent: SendAgentBackendMessageInput['onEvent'],
  ): AgentLoop {
    return new AgentLoop(
      this.provider,
      gateway,
      onEvent ?? (() => undefined),
      this.maxRounds,
    );
  }

  private requireThread(handle: AgentBackendThread): GenericThreadRecord {
    const record = this.threads.get(handle.id);
    if (!record || record.handle !== handle) {
      throw new Error('Agent backend thread handle is missing, stale, or belongs to another backend.');
    }
    return record;
  }
}
