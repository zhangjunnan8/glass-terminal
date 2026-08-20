import type { AgentContextUsage, AgentFileAccessMode } from '../../shared/agent';
import type { AgentMemoryCard } from '../../shared/agent-memory';
import type { ToolGateway } from '../../shared/tools';

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | {
    role: 'assistant';
    content: string | null;
    toolCalls?: AgentToolCall[];
    /** Generated context checkpoint; never rendered as a user-visible chat item. */
    contextSummary?: boolean;
    /** Tool results have not yet been included in a successful Provider request. */
    toolResultsPending?: boolean;
  }
  | { role: 'tool'; content: string; toolCallId: string };

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentBackendEvent {
  type: 'assistant_delta' | 'assistant_text' | 'tool_started' | 'tool_completed' | 'context_status';
  text?: string;
  toolCall?: AgentToolCall;
  result?: string;
  contextUsage?: AgentContextUsage;
  compression?: { beforeTokens: number; afterTokens: number };
}

export interface AgentBackendResult {
  id: string;
  messages: AgentMessage[];
  finalText: string;
  rounds: number;
  contextUsage?: AgentContextUsage;
  contextPersistence?: {
    mode: 'delta' | 'checkpoint';
    messages: AgentMessage[];
  };
  /** Turn stopped locally after preserving protocol-complete partial history. */
  haltedError?: string;
}

/** Opaque, backend-owned handle for one Glass Terminal conversation thread. */
export interface AgentBackendThread {
  readonly id: string;
}

export interface CreateAgentBackendThreadInput {
  id: string;
  signal: AbortSignal;
}

export interface ResumeAgentBackendThreadInput {
  id: string;
  priorMessages: readonly AgentMessage[];
  signal: AbortSignal;
}

export interface SendAgentBackendMessageInput {
  thread: AgentBackendThread;
  prompt: string;
  systemPrompt: string;
  terminalContext: string;
  /** Frozen user-reviewed memories for this turn. */
  persistentMemories?: readonly AgentMemoryCard[];
  fileAccessMode: AgentFileAccessMode;
  /** Frozen per turn by AgentService; changing settings affects the next turn only. */
  maxRounds?: number;
  /** Required for every turn. Backends must not retain or synthesize a default gateway. */
  gateway: ToolGateway;
  signal: AbortSignal;
  onEvent?(event: AgentBackendEvent): void;
}

export interface InterruptAgentBackendInput {
  threadId: string;
  reason: 'user' | 'takeover' | 'shutdown';
}

/**
 * Replaceable behavior boundary between AgentService and a concrete Harness.
 * Session, approval, takeover, and persistence policy remain outside this interface.
 */
export interface AgentBackend {
  createThread(input: CreateAgentBackendThreadInput): Promise<AgentBackendThread>;
  resume(input: ResumeAgentBackendThreadInput): Promise<AgentBackendThread>;
  sendMessage(input: SendAgentBackendMessageInput): Promise<AgentBackendResult>;
  interrupt(input: InterruptAgentBackendInput): Promise<void>;
}
