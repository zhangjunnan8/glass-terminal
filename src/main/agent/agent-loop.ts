import { randomUUID } from 'node:crypto';

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | {
    role: 'assistant';
    content: string | null;
    toolCalls?: AgentToolCall[];
  }
  | { role: 'tool'; content: string; toolCallId: string };

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentCompletionRequest {
  messages: AgentMessage[];
  tools: AgentToolDefinition[];
  signal: AbortSignal;
}

export interface AgentCompletion {
  message: Extract<AgentMessage, { role: 'assistant' }>;
}

export interface AgentProviderRuntime {
  complete(request: AgentCompletionRequest): Promise<AgentCompletion>;
}

export interface AgentCommandResult {
  executionId: string;
  command: string;
  status: 'completed' | 'failed' | 'rejected' | 'cancelled';
  exitCode?: number;
  output: string;
  durationMs?: number;
}

export interface AgentLoopTools {
  readTerminal(request: { maxChars: number }): Promise<string>;
  getTerminalState(): Promise<Record<string, unknown>>;
  executeCommand(request: { command: string; reason?: string }): Promise<AgentCommandResult>;
}

export interface AgentLoopEvent {
  type: 'assistant_text' | 'tool_started' | 'tool_completed';
  text?: string;
  toolCall?: AgentToolCall;
  result?: string;
}

export interface AgentLoopInput {
  systemPrompt: string;
  userPrompt: string;
  terminalContext: string;
  priorMessages?: AgentMessage[];
  signal: AbortSignal;
}

export interface AgentLoopResult {
  id: string;
  messages: AgentMessage[];
  finalText: string;
  rounds: number;
}

export const TERMINAL_TOOLS: AgentToolDefinition[] = [
  {
    name: 'terminal_read',
    description: 'Read a bounded recent portion of the exact visible terminal history.',
    parameters: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', minimum: 100, maximum: 30_000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'terminal_state',
    description: 'Get the current terminal transport, shell, cwd/user when known, and control state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'terminal_execute',
    description: 'Request execution of one command in the same visible terminal. User approval is required unless Full Takeover is explicitly active.',
    parameters: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string', minLength: 1 },
        reason: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

function parseArguments(call: AgentToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(call.arguments || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be an object.');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid arguments for ${call.name}: ${(error as Error).message}`);
  }
}

export class AgentLoop {
  constructor(
    private readonly provider: AgentProviderRuntime,
    private readonly tools: AgentLoopTools,
    private readonly onEvent: (event: AgentLoopEvent) => void = () => undefined,
    private readonly maxRounds = 12,
  ) {}

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const messages: AgentMessage[] = [
      { role: 'system', content: input.systemPrompt },
      ...(input.priorMessages ?? []),
      {
        role: 'user',
        content: `${input.userPrompt}\n\nRecent visible terminal context:\n${input.terminalContext}`,
      },
    ];
    let finalText = '';

    for (let round = 1; round <= this.maxRounds; round += 1) {
      if (input.signal.aborted) throw new Error('Agent turn cancelled.');
      const completion = await this.provider.complete({
        messages,
        tools: TERMINAL_TOOLS,
        signal: input.signal,
      });
      const assistant = completion.message;
      messages.push(assistant);
      if (assistant.content) {
        finalText = assistant.content;
        this.onEvent({ type: 'assistant_text', text: assistant.content });
      }
      if (!assistant.toolCalls?.length) {
        return { id: randomUUID(), messages, finalText, rounds: round };
      }

      for (const call of assistant.toolCalls) {
        this.onEvent({ type: 'tool_started', toolCall: call });
        let result: string;
        try {
          result = await this.executeTool(call);
        } catch (error) {
          result = JSON.stringify({ ok: false, error: (error as Error).message });
        }
        messages.push({ role: 'tool', toolCallId: call.id, content: result });
        this.onEvent({ type: 'tool_completed', toolCall: call, result });
      }
    }
    throw new Error(`Agent exceeded the ${this.maxRounds}-round safety limit.`);
  }

  private async executeTool(call: AgentToolCall): Promise<string> {
    const args = parseArguments(call);
    switch (call.name) {
      case 'terminal_read': {
        const requested = typeof args.maxChars === 'number' ? args.maxChars : 8_000;
        const maxChars = Math.min(30_000, Math.max(100, Math.floor(requested)));
        return JSON.stringify({ ok: true, output: await this.tools.readTerminal({ maxChars }) });
      }
      case 'terminal_state':
        return JSON.stringify({ ok: true, state: await this.tools.getTerminalState() });
      case 'terminal_execute': {
        if (typeof args.command !== 'string' || !args.command.trim()) {
          throw new Error('terminal_execute requires a non-empty command.');
        }
        const result = await this.tools.executeCommand({
          command: args.command,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        });
        return JSON.stringify({ ok: result.status === 'completed', ...result });
      }
      default:
        throw new Error(`Unsupported terminal tool: ${call.name}`);
    }
  }
}
