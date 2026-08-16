import { randomUUID } from 'node:crypto';
import type { AgentFileAccessMode } from '../../shared/agent';
import type { ToolGateway, WorkspaceTool } from '../../shared/tools';
import type {
  AgentBackendEvent,
  AgentBackendResult,
  AgentMessage,
  AgentToolCall,
} from './agent-backend';

// Compatibility aliases keep Provider/loop consumers independent while the
// replaceable AgentBackend contract owns the neutral transcript/event DTOs.
export type { AgentMessage, AgentToolCall } from './agent-backend';
export type AgentLoopEvent = AgentBackendEvent;
export type AgentLoopResult = AgentBackendResult;

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

export interface AgentLoopInput {
  systemPrompt: string;
  userPrompt: string;
  terminalContext: string;
  priorMessages?: AgentMessage[];
  fileAccessMode?: AgentFileAccessMode;
  signal: AbortSignal;
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

const WORKSPACE_READ_TOOLS: AgentToolDefinition[] = [
  {
    name: 'workspace_list',
    description: 'List one bounded directory inside the explicit Workspace Root without running a shell command.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', maxLength: 4_096, default: '.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_read_file',
    description: 'Read one needed, bounded UTF-8 text file inside the Workspace Root and return its SHA-256. Prefer small, targeted reads.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 4_096 } },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_stat',
    description: 'Inspect one file, directory, or symbolic link inside the Workspace Root without reading its contents or running a shell command.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 4_096 } },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_search',
    description: 'Search bounded UTF-8 workspace files for literal text and return structured line/column previews. Use this instead of grep in the terminal.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 4_096 },
        path: { type: 'string', minLength: 1, maxLength: 4_096, default: '.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_glob',
    description: 'Find bounded workspace paths matching a glob pattern without running find, dir, or another shell command.',
    parameters: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: 4_096 },
        path: { type: 'string', minLength: 1, maxLength: 4_096, default: '.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
      },
      additionalProperties: false,
    },
  },
];

const WORKSPACE_WRITE_TOOLS: AgentToolDefinition[] = [
  {
    name: 'workspace_apply_patch',
    description: 'Preferred way to modify an existing file. Atomically apply exact, unique text replacements and return a diff. expectedSha256 must be from the latest workspace_read_file; re-read after a conflict.',
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
    name: 'workspace_write_file',
    description: 'Atomically create one bounded UTF-8 text file. For an existing file prefer workspace_apply_patch; if replacement is necessary, pass the latest SHA-256. Pass null only when the path must not exist.',
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
  {
    name: 'workspace_mkdir',
    description: 'Create one directory inside the Workspace Root without running a shell command.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 4_096 } },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_rename',
    description: 'Rename or move one workspace path to another path inside the same Workspace Root.',
    parameters: {
      type: 'object',
      required: ['source', 'destination'],
      properties: {
        source: { type: 'string', minLength: 1, maxLength: 4_096 },
        destination: { type: 'string', minLength: 1, maxLength: 4_096 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_delete',
    description: 'Delete one workspace path. Recursive directory deletion must be explicitly requested.',
    parameters: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4_096 },
        recursive: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
];

const WORKSPACE_TOOL_NAMES = new Set([
  'workspace_list',
  'workspace_read_file',
  'workspace_stat',
  'workspace_search',
  'workspace_glob',
  'workspace_apply_patch',
  'workspace_write_file',
  'workspace_mkdir',
  'workspace_rename',
  'workspace_delete',
  // Execution-only compatibility for prior persisted Provider turns.
  'file_list',
  'file_read',
  'file_stat',
  'file_patch',
  'file_write',
]);
const WORKSPACE_MUTATION_TOOL_NAMES = new Set([
  'workspace_apply_patch',
  'workspace_write_file',
  'workspace_mkdir',
  'workspace_rename',
  'workspace_delete',
  'file_patch',
  'file_write',
]);
const MAX_WORKSPACE_RESULT_BYTES_PER_TURN = 2 * 1024 * 1024;
const MAX_WORKSPACE_ERROR_CHARS = 4_096;

function toolsForMode(mode: AgentFileAccessMode): AgentToolDefinition[] {
  if (mode === 'off') return TERMINAL_TOOLS;
  return mode === 'read-only'
    ? [...TERMINAL_TOOLS, ...WORKSPACE_READ_TOOLS]
    : [...TERMINAL_TOOLS, ...WORKSPACE_READ_TOOLS, ...WORKSPACE_WRITE_TOOLS];
}

function compactToolResult(content: string, toolName: string): string {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const matches = Array.isArray(value.matches)
      ? value.matches.length
      : typeof value.matches === 'number' ? value.matches : undefined;
    const paths = Array.isArray(value.paths)
      ? value.paths.length
      : typeof value.paths === 'number' ? value.paths : undefined;
    const entries = Array.isArray(value.entries)
      ? value.entries.length
      : typeof value.entries === 'number' ? value.entries : undefined;
    if (toolName === 'workspace_search') {
      return JSON.stringify({
        ok: value.ok,
        compacted: true,
        matches,
        filesScanned: typeof value.filesScanned === 'number' ? value.filesScanned : undefined,
        truncated: typeof value.truncated === 'boolean' ? value.truncated : undefined,
      });
    }
    if (toolName === 'workspace_glob') {
      return JSON.stringify({
        ok: value.ok,
        compacted: true,
        paths,
        truncated: typeof value.truncated === 'boolean' ? value.truncated : undefined,
      });
    }
    return JSON.stringify({
      ok: value.ok,
      compacted: true,
      path: typeof value.path === 'string' ? value.path : undefined,
      bytes: typeof value.bytes === 'number' ? value.bytes : undefined,
      sha256: typeof value.sha256 === 'string' ? value.sha256 : undefined,
      created: typeof value.created === 'boolean' ? value.created : undefined,
      additions: typeof value.additions === 'number' ? value.additions : undefined,
      deletions: typeof value.deletions === 'number' ? value.deletions : undefined,
      matches,
      paths,
      entries,
      filesScanned: typeof value.filesScanned === 'number' ? value.filesScanned : undefined,
      truncated: typeof value.truncated === 'boolean' ? value.truncated : undefined,
      error: typeof value.error === 'string' ? value.error.slice(0, 1_000) : undefined,
    });
  } catch {
    return JSON.stringify({ ok: false, compacted: true });
  }
}

function compactCompletedWorkspaceHistory(
  messages: AgentMessage[],
  keepAssistant?: Extract<AgentMessage, { role: 'assistant' }>,
): void {
  const compactCalls = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    if (message === keepAssistant) continue;
    message.toolCalls = message.toolCalls.map((call) => {
      if (!WORKSPACE_TOOL_NAMES.has(call.name)) return call;
      compactCalls.set(call.id, call.name);
      return { ...call, arguments: '{"historyCompacted":true}' };
    });
  }
  for (const message of messages) {
    if (message.role === 'tool' && compactCalls.has(message.toolCallId)) {
      message.content = compactToolResult(
        message.content,
        compactCalls.get(message.toolCallId)!,
      );
    }
  }
}

function consumeWorkspaceResultBudget(serialized: string, budget: { remaining: number }): string {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > budget.remaining) {
    throw new Error(
      `本轮 Workspace 工具结果超过 ${MAX_WORKSPACE_RESULT_BYTES_PER_TURN} 字节总限制；`
      + '请先处理已读取内容，再分批读取。',
    );
  }
  budget.remaining -= bytes;
  return serialized;
}

function boundedWorkspaceErrorResult(
  error: unknown,
  budget: { remaining: number },
): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const truncated = rawMessage.length > MAX_WORKSPACE_ERROR_CHARS;
  const bounded = JSON.stringify({
    ok: false,
    error: rawMessage.slice(0, MAX_WORKSPACE_ERROR_CHARS),
    ...(truncated ? { errorTruncated: true } : {}),
  });
  if (Buffer.byteLength(bounded, 'utf8') <= budget.remaining) {
    return consumeWorkspaceResultBudget(bounded, budget);
  }

  const exhausted = JSON.stringify({
    ok: false,
    error: 'Workspace tool result omitted because the per-turn result budget is exhausted.',
    resultOmitted: true,
  });
  if (Buffer.byteLength(exhausted, 'utf8') <= budget.remaining) {
    return consumeWorkspaceResultBudget(exhausted, budget);
  }
  if (budget.remaining >= 2) {
    return consumeWorkspaceResultBudget('{}', budget);
  }
  // An empty tool result is preferable to exceeding the hard turn budget or
  // forwarding any portion of an untrusted oversized backend error.
  return '';
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

function requiredPath(
  args: Record<string, unknown>,
  toolName: string,
  field = 'path',
): string {
  const value = args[field];
  if (typeof value !== 'string' || !value || value.length > 4_096) {
    throw new Error(`${toolName} requires a valid ${field}.`);
  }
  return value;
}

function optionalPath(args: Record<string, unknown>, toolName: string): string | undefined {
  if (args.path === undefined) return undefined;
  return requiredPath(args, toolName);
}

function optionalMaxResults(
  args: Record<string, unknown>,
  toolName: string,
  maximum: number,
): number | undefined {
  if (args.maxResults === undefined) return undefined;
  if (
    typeof args.maxResults !== 'number'
    || !Number.isInteger(args.maxResults)
    || args.maxResults < 1
    || args.maxResults > maximum
  ) throw new Error(`${toolName} maxResults must be an integer from 1 to ${maximum}.`);
  return args.maxResults;
}

function readableWorkspace(
  gateway: ToolGateway,
  fileAccessMode: AgentFileAccessMode,
  toolName: string,
): WorkspaceTool {
  const permissions = gateway.context.permissions.workspace;
  if (
    fileAccessMode === 'off'
    || !permissions.enabled
    || !permissions.read
    || !gateway.workspace
  ) throw new Error(`${toolName} is disabled.`);
  return gateway.workspace;
}

function writableWorkspace(
  gateway: ToolGateway,
  fileAccessMode: AgentFileAccessMode,
  toolName: string,
  requiredPermissions: ReadonlyArray<'read' | 'write' | 'create' | 'delete'> = ['write'],
): WorkspaceTool {
  const permissions = gateway.context.permissions.workspace;
  if (
    fileAccessMode !== 'read-write'
    || !permissions.enabled
    || requiredPermissions.some((permission) => !permissions[permission])
  ) {
    throw new Error(`${toolName} requires read-write access.`);
  }
  if (!gateway.workspace) throw new Error(`${toolName} is disabled.`);
  return gateway.workspace;
}

function throwIfTurnCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Agent turn cancelled.');
  error.name = 'AbortError';
  throw error;
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
    const workspaceResultBudget = { remaining: MAX_WORKSPACE_RESULT_BYTES_PER_TURN };
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
      throwIfTurnCancelled(input.signal);
      const completion = await this.provider.complete({
        messages,
        tools: toolsForMode(fileAccessMode),
        signal: input.signal,
        onTextDelta: (delta) => {
          if (delta && !input.signal.aborted) {
            this.onEvent({ type: 'assistant_delta', text: delta });
          }
        },
      });
      // Providers are not trusted to observe AbortSignal. Never accept a late
      // completion after the user has stopped or taken over the turn.
      throwIfTurnCancelled(input.signal);
      const assistant = completion.message;
      messages.push(assistant);
      if (assistant.content) {
        finalText = assistant.content;
        this.onEvent({ type: 'assistant_text', text: assistant.content });
      }
      if (!assistant.toolCalls?.length) {
        throwIfTurnCancelled(input.signal);
        compactCompletedWorkspaceHistory(messages);
        return { id: randomUUID(), messages, finalText, rounds: round };
      }

      compactCompletedWorkspaceHistory(messages, assistant);

      for (const call of assistant.toolCalls) {
        throwIfTurnCancelled(input.signal);
        this.onEvent({ type: 'tool_started', toolCall: call });
        // A tool-start observer may synchronously cancel the turn. Check again
        // immediately before invoking the externally-effectful gateway.
        throwIfTurnCancelled(input.signal);
        let result: string;
        try {
          result = await this.executeTool(call, fileAccessMode, workspaceResultBudget);
        } catch (error) {
          throwIfTurnCancelled(input.signal);
          result = WORKSPACE_TOOL_NAMES.has(call.name)
            ? boundedWorkspaceErrorResult(error, workspaceResultBudget)
            : JSON.stringify({ ok: false, error: (error as Error).message });
        }
        // An already-started tool cannot always be rolled back, but its late
        // result must not advance this turn or permit another tool dispatch.
        throwIfTurnCancelled(input.signal);
        messages.push({ role: 'tool', toolCallId: call.id, content: result });
        this.onEvent({ type: 'tool_completed', toolCall: call, result });
        throwIfTurnCancelled(input.signal);
      }
      // Workspace contents and mutation payloads are useful for one reasoning step only.
      // Mutation arguments are compacted immediately; their structured result is sufficient.
      for (const call of assistant.toolCalls) {
        if (WORKSPACE_MUTATION_TOOL_NAMES.has(call.name)) {
          call.arguments = '{"historyCompacted":true}';
        }
      }
    }
    compactCompletedWorkspaceHistory(messages);
    throw new Error(`Agent exceeded the ${this.maxRounds}-round safety limit.`);
  }

  private async executeTool(
    call: AgentToolCall,
    fileAccessMode: AgentFileAccessMode,
    workspaceResultBudget: { remaining: number },
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
      case 'workspace_list':
      case 'file_list': {
        const workspace = readableWorkspace(this.gateway, fileAccessMode, call.name);
        const path = typeof args.path === 'string' ? args.path : '.';
        if (!path || path.length > 4_096) throw new Error(`${call.name} path is invalid.`);
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, ...await workspace.listDirectory(path) }),
          workspaceResultBudget,
        );
      }
      case 'workspace_read_file':
      case 'file_read': {
        const workspace = readableWorkspace(this.gateway, fileAccessMode, call.name);
        const path = requiredPath(args, call.name);
        const result = await workspace.readFile(path);
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, ...result }),
          workspaceResultBudget,
        );
      }
      case 'workspace_stat':
      case 'file_stat': {
        const workspace = readableWorkspace(this.gateway, fileAccessMode, call.name);
        const path = requiredPath(args, call.name);
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, ...await workspace.stat(path) }),
          workspaceResultBudget,
        );
      }
      case 'workspace_search': {
        const workspace = readableWorkspace(this.gateway, fileAccessMode, call.name);
        if (
          typeof args.query !== 'string'
          || !args.query
          || args.query.length > 4_096
        ) throw new Error('workspace_search requires a valid query.');
        const path = optionalPath(args, call.name);
        const maxResults = optionalMaxResults(args, call.name, 200);
        const result = await workspace.search(args.query, {
          ...(path ? { path } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        });
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, ...result }),
          workspaceResultBudget,
        );
      }
      case 'workspace_glob': {
        const workspace = readableWorkspace(this.gateway, fileAccessMode, call.name);
        if (
          typeof args.pattern !== 'string'
          || !args.pattern
          || args.pattern.length > 4_096
        ) throw new Error('workspace_glob requires a valid pattern.');
        const path = optionalPath(args, call.name);
        const maxResults = optionalMaxResults(args, call.name, 500);
        const result = await workspace.glob(args.pattern, {
          ...(path ? { path } : {}),
          ...(maxResults !== undefined ? { maxResults } : {}),
        });
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, ...result }),
          workspaceResultBudget,
        );
      }
      case 'workspace_write_file':
      case 'file_write': {
        const path = requiredPath(args, call.name);
        if (typeof args.content !== 'string') throw new Error(`${call.name} requires text content.`);
        if (args.content.length > 131_072) {
          throw new Error(`${call.name} content exceeds the 131,072-character tool limit; use workspace_apply_patch or split the work.`);
        }
        if (
          args.expectedSha256 !== null
          && (
            typeof args.expectedSha256 !== 'string'
            || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)
          )
        ) {
          throw new Error(`${call.name} requires a valid expectedSha256 (or null for a new file).`);
        }
        const workspace = writableWorkspace(
          this.gateway,
          fileAccessMode,
          call.name,
          args.expectedSha256 === null ? ['create'] : ['read', 'write'],
        );
        return consumeWorkspaceResultBudget(
          JSON.stringify({
            ok: true,
            ...await workspace.writeFile(
              path,
              args.content,
              args.expectedSha256,
            ),
          }),
          workspaceResultBudget,
        );
      }
      case 'workspace_apply_patch':
      case 'file_patch': {
        const workspace = writableWorkspace(
          this.gateway,
          fileAccessMode,
          call.name,
          ['read', 'write'],
        );
        const path = requiredPath(args, call.name);
        if (typeof args.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(args.expectedSha256)) {
          throw new Error(`${call.name} requires a valid expectedSha256.`);
        }
        if (!Array.isArray(args.patches) || !args.patches.length || args.patches.length > 64) {
          throw new Error(`${call.name} requires 1-64 patches.`);
        }
        const patches = args.patches.map((patch) => {
          if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new Error(`${call.name} entries must be objects.`);
          }
          const record = patch as Record<string, unknown>;
          if (
            typeof record.search !== 'string'
            || !record.search
            || record.search.length > 131_072
            || typeof record.replace !== 'string'
            || record.replace.length > 131_072
          ) {
            throw new Error(`${call.name} entries require bounded search and replace text.`);
          }
          return { search: record.search, replace: record.replace };
        });
        if (JSON.stringify(patches).length > 262_144) {
          throw new Error(`${call.name} payload is too large; use smaller, precise patch batches.`);
        }
        return consumeWorkspaceResultBudget(
          JSON.stringify({
            ok: true,
            ...await workspace.applyPatch(
              path,
              args.expectedSha256,
              patches,
            ),
          }),
          workspaceResultBudget,
        );
      }
      case 'workspace_mkdir': {
        const workspace = writableWorkspace(
          this.gateway,
          fileAccessMode,
          call.name,
          ['create'],
        );
        const path = requiredPath(args, call.name);
        await workspace.mkdir(path);
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, path }),
          workspaceResultBudget,
        );
      }
      case 'workspace_rename': {
        const workspace = writableWorkspace(
          this.gateway,
          fileAccessMode,
          call.name,
          ['write', 'create', 'delete'],
        );
        const source = requiredPath(args, call.name, 'source');
        const destination = requiredPath(args, call.name, 'destination');
        await workspace.rename(source, destination);
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, source, destination }),
          workspaceResultBudget,
        );
      }
      case 'workspace_delete': {
        const workspace = writableWorkspace(
          this.gateway,
          fileAccessMode,
          call.name,
          ['delete'],
        );
        const path = requiredPath(args, call.name);
        if (args.recursive !== undefined && typeof args.recursive !== 'boolean') {
          throw new Error('workspace_delete recursive must be a boolean.');
        }
        const recursive = args.recursive === true;
        await workspace.delete(path, { recursive });
        return consumeWorkspaceResultBudget(
          JSON.stringify({ ok: true, path, recursive }),
          workspaceResultBudget,
        );
      }
      default:
        throw new Error(`Unsupported tool: ${call.name}`);
    }
  }
}
