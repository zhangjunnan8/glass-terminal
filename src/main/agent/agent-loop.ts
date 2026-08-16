import { randomUUID } from 'node:crypto';
import type { AgentFileAccessMode } from '../../shared/agent';
import type { ToolGateway } from '../../shared/tools';

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
  onTextDelta?(delta: string): void;
}

export interface AgentCompletion {
  message: Extract<AgentMessage, { role: 'assistant' }>;
}

export interface AgentProviderRuntime {
  complete(request: AgentCompletionRequest): Promise<AgentCompletion>;
}

export interface AgentLoopEvent {
  type: 'assistant_delta' | 'assistant_text' | 'tool_started' | 'tool_completed';
  text?: string;
  toolCall?: AgentToolCall;
  result?: string;
}

export interface AgentLoopInput {
  systemPrompt: string;
  userPrompt: string;
  terminalContext: string;
  priorMessages?: AgentMessage[];
  fileAccessMode?: AgentFileAccessMode;
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

const FILE_READ_TOOLS: AgentToolDefinition[] = [
  {
    name: 'file_list',
    description: 'List a bounded directory inside the explicitly bound Session root. This never runs a shell command.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4_096, default: '.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'file_read',
    description: 'Read only one needed, bounded UTF-8 text file inside the bound Session root and return its SHA-256. Prefer small, targeted reads; never request an entire repository.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 4_096 } },
      additionalProperties: false,
    },
  },
];

const FILE_WRITE_TOOLS: AgentToolDefinition[] = [
  {
    name: 'file_patch',
    description: 'Atomically apply exact, unique text replacements. expectedSha256 must be from the latest file_read.',
    parameters: {
      type: 'object',
      required: ['path', 'expectedSha256', 'patches'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4_096 },
        expectedSha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        patches: {
          type: 'array', minItems: 1, maxItems: 64,
          items: {
            type: 'object', required: ['search', 'replace'], additionalProperties: false,
            properties: {
              search: { type: 'string', minLength: 1, maxLength: 131_072 },
              replace: { type: 'string', maxLength: 131_072 },
            },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'file_write',
    description: 'Atomically write one bounded UTF-8 text file. Pass the latest SHA-256 when replacing, or null only when the path must not exist.',
    parameters: {
      type: 'object',
      required: ['path', 'content', 'expectedSha256'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4_096 },
        content: { type: 'string', maxLength: 131_072 },
        expectedSha256: {
          anyOf: [
            { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
            { type: 'null' },
          ],
        },
      },
      additionalProperties: false,
    },
  },
];

const FILE_TOOL_NAMES = new Set(['file_list', 'file_read', 'file_patch', 'file_write']);
const FILE_WRITE_TOOL_NAMES = new Set(['file_patch', 'file_write']);
const MAX_FILE_READ_BYTES_PER_TURN = 2 * 1024 * 1024;

function toolsForMode(mode: AgentFileAccessMode): AgentToolDefinition[] {
  if (mode === 'off') return TERMINAL_TOOLS;
  return mode === 'read-only'
    ? [...TERMINAL_TOOLS, ...FILE_READ_TOOLS]
    : [...TERMINAL_TOOLS, ...FILE_READ_TOOLS, ...FILE_WRITE_TOOLS];
}

function compactToolResult(content: string): string {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    return JSON.stringify({
      ok: value.ok,
      compacted: true,
      path: typeof value.path === 'string' ? value.path : undefined,
      bytes: typeof value.bytes === 'number' ? value.bytes : undefined,
      sha256: typeof value.sha256 === 'string' ? value.sha256 : undefined,
      error: typeof value.error === 'string' ? value.error.slice(0, 1_000) : undefined,
    });
  } catch {
    return JSON.stringify({ ok: false, compacted: true });
  }
}

function compactCompletedFileHistory(
  messages: AgentMessage[],
  keepAssistant?: Extract<AgentMessage, { role: 'assistant' }>,
): void {
  const compactIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    if (message === keepAssistant) continue;
    message.toolCalls = message.toolCalls.map((call) => {
      if (!FILE_TOOL_NAMES.has(call.name)) return call;
      compactIds.add(call.id);
      return { ...call, arguments: '{"historyCompacted":true}' };
    });
  }
  for (const message of messages) {
    if (message.role === 'tool' && compactIds.has(message.toolCallId)) {
      message.content = compactToolResult(message.content);
    }
  }
}

function consumeFileResultBudget(serialized: string, budget: { remaining: number }): string {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > budget.remaining) {
    throw new Error(
      `本轮文件读取/列表结果超过 ${MAX_FILE_READ_BYTES_PER_TURN} 字节总限制；`
      + '请先处理已读取内容，再分批读取。',
    );
  }
  budget.remaining -= bytes;
  return serialized;
}

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
    private readonly gateway: ToolGateway,
    private readonly onEvent: (event: AgentLoopEvent) => void = () => undefined,
    private readonly maxRounds = 12,
  ) {}

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const fileAccessMode = input.fileAccessMode ?? 'off';
    const fileReadBudget = { remaining: MAX_FILE_READ_BYTES_PER_TURN };
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
        tools: toolsForMode(fileAccessMode),
        signal: input.signal,
        onTextDelta: (delta) => {
          if (delta) this.onEvent({ type: 'assistant_delta', text: delta });
        },
      });
      const assistant = completion.message;
      messages.push(assistant);
      if (assistant.content) {
        finalText = assistant.content;
        this.onEvent({ type: 'assistant_text', text: assistant.content });
      }
      if (!assistant.toolCalls?.length) {
        compactCompletedFileHistory(messages);
        return { id: randomUUID(), messages, finalText, rounds: round };
      }

      compactCompletedFileHistory(messages, assistant);

      for (const call of assistant.toolCalls) {
        this.onEvent({ type: 'tool_started', toolCall: call });
        let result: string;
        try {
          result = await this.executeTool(call, fileAccessMode, fileReadBudget);
        } catch (error) {
          result = JSON.stringify({ ok: false, error: (error as Error).message });
        }
        messages.push({ role: 'tool', toolCallId: call.id, content: result });
        this.onEvent({ type: 'tool_completed', toolCall: call, result });
      }
      // File contents and write payloads are useful for one reasoning step only.
      // Write/patch arguments are compacted immediately; their small result is sufficient.
      for (const call of assistant.toolCalls) {
        if (FILE_WRITE_TOOL_NAMES.has(call.name)) {
          call.arguments = '{"historyCompacted":true}';
        }
      }
    }
    compactCompletedFileHistory(messages);
    throw new Error(`Agent exceeded the ${this.maxRounds}-round safety limit.`);
  }

  private async executeTool(
    call: AgentToolCall,
    fileAccessMode: AgentFileAccessMode,
    fileReadBudget: { remaining: number },
  ): Promise<string> {
    const args = parseArguments(call);
    switch (call.name) {
      case 'terminal_read': {
        const requested = typeof args.maxChars === 'number' ? args.maxChars : 8_000;
        const maxChars = Math.min(30_000, Math.max(100, Math.floor(requested)));
        return JSON.stringify({
          ok: true,
          output: await this.gateway.terminal.readVisible({ maxChars }),
        });
      }
      case 'terminal_state':
        return JSON.stringify({ ok: true, state: await this.gateway.terminal.getState() });
      case 'terminal_execute': {
        if (typeof args.command !== 'string' || !args.command.trim()) {
          throw new Error('terminal_execute requires a non-empty command.');
        }
        const result = await this.gateway.terminal.execute(
          args.command,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        return JSON.stringify({ ok: result.status === 'completed', ...result });
      }
      case 'file_list': {
        if (fileAccessMode === 'off') throw new Error('file_list is disabled.');
        if (!this.gateway.workspace) throw new Error('file_list is disabled.');
        const path = typeof args.path === 'string' ? args.path : '.';
        if (!path || path.length > 4_096) throw new Error('file_list path is invalid.');
        return consumeFileResultBudget(
          JSON.stringify({ ok: true, ...await this.gateway.workspace.listDirectory(path) }),
          fileReadBudget,
        );
      }
      case 'file_read': {
        if (fileAccessMode === 'off') throw new Error('file_read is disabled.');
        if (!this.gateway.workspace) throw new Error('file_read is disabled.');
        if (typeof args.path !== 'string' || !args.path || args.path.length > 4_096) {
          throw new Error('file_read requires a valid path.');
        }
        const result = await this.gateway.workspace.readFile(args.path);
        return consumeFileResultBudget(JSON.stringify({ ok: true, ...result }), fileReadBudget);
      }
      case 'file_write': {
        if (fileAccessMode !== 'read-write') throw new Error('file_write requires read-write access.');
        if (!this.gateway.workspace) throw new Error('file_write is disabled.');
        if (typeof args.path !== 'string' || !args.path || args.path.length > 4_096) {
          throw new Error('file_write requires a valid path.');
        }
        if (typeof args.content !== 'string') throw new Error('file_write requires text content.');
        if (args.content.length > 131_072) {
          throw new Error('file_write content exceeds the 131,072-character tool limit; use file_patch or split the work.');
        }
        if (args.expectedSha256 !== null && typeof args.expectedSha256 !== 'string') {
          throw new Error('file_write requires expectedSha256 (or null for a new file).');
        }
        return JSON.stringify({
          ok: true,
          ...await this.gateway.workspace.writeFile(
            args.path,
            args.content,
            args.expectedSha256,
          ),
        });
      }
      case 'file_patch': {
        if (fileAccessMode !== 'read-write') throw new Error('file_patch requires read-write access.');
        if (!this.gateway.workspace) throw new Error('file_patch is disabled.');
        if (typeof args.path !== 'string' || !args.path || args.path.length > 4_096) {
          throw new Error('file_patch requires a valid path.');
        }
        if (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)) {
          throw new Error('file_patch requires a valid expectedSha256.');
        }
        if (!Array.isArray(args.patches) || !args.patches.length || args.patches.length > 64) {
          throw new Error('file_patch requires 1-64 patches.');
        }
        const patches = args.patches.map((patch) => {
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new Error('file_patch entries must be objects.');
          }
          const record = patch as Record<string, unknown>;
          if (typeof record.search !== 'string' || !record.search || typeof record.replace !== 'string') {
            throw new Error('file_patch entries require search and replace text.');
          }
          return { search: record.search, replace: record.replace };
        });
        if (JSON.stringify(patches).length > 262_144) {
          throw new Error('file_patch payload is too large; use smaller, precise patch batches.');
        }
        return JSON.stringify({
          ok: true,
          ...await this.gateway.workspace.applyPatch(
            args.path,
            args.expectedSha256,
            patches,
          ),
        });
      }
      default:
        throw new Error(`Unsupported terminal tool: ${call.name}`);
    }
  }
}
