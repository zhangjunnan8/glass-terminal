import type {
  AIMessage,
  BaseMessage,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ChatOpenAICompletions } from '@langchain/openai';
import type {
  AgentBackend,
  AgentBackendResult,
  AgentBackendThread,
  AgentMessage,
  AgentToolCall,
  SendAgentBackendMessageInput,
} from './agent-backend';
import type { ToolGateway } from '../../shared/tools';
import type { AgentFileAccessMode } from '../../shared/agent';
import type { ProviderStore } from '../providers/provider-store';

/**
 * LangChain-backed harness. It satisfies the project's `AgentBackend` boundary
 * without owning any shell, SSH connection, PTY, or filesystem: the model only
 * ever reaches those through the per-turn `ToolGateway` injected by AgentService.
 *
 * LangChain (and zod) are loaded lazily via dynamic `import()` so the Electron
 * main process does not pay their parse cost on startup — only the first turn
 * that actually constructs a backend does.
 */

const MAX_BACKEND_THREAD_ID_CHARS = 256;
const MAX_HARNESS_ROUNDS = 64;
const DEFAULT_MAX_ROUNDS = 40;

interface LangChainThreadRecord {
  handle: AgentBackendThread;
  priorMessages: AgentMessage[];
}

interface ActiveTurn {
  controller: AbortController;
}

/** Runtime LangChain symbols, loaded once on first use. */
interface LangChainRuntime {
  AIMessage: any;
  AIMessageChunk: any;
  collapseToolCallChunks: any;
  HumanMessage: any;
  SystemMessage: any;
  ToolMessage: any;
  tool: any;
  ChatOpenAICompletions: any;
  concat: any;
  z: any;
}

let langChainRuntimePromise: Promise<LangChainRuntime> | undefined;

function loadLangChainRuntime(): Promise<LangChainRuntime> {
  if (!langChainRuntimePromise) {
    langChainRuntimePromise = Promise.all([
      import('@langchain/core/messages'),
      import('@langchain/core/tools'),
      import('@langchain/openai'),
      import('@langchain/core/utils/stream'),
      import('zod'),
    ]).then(([messages, tools, openai, stream, zod]) => ({
      AIMessage: messages.AIMessage,
      AIMessageChunk: messages.AIMessageChunk,
      collapseToolCallChunks: messages.collapseToolCallChunks,
      HumanMessage: messages.HumanMessage,
      SystemMessage: messages.SystemMessage,
      ToolMessage: messages.ToolMessage,
      tool: tools.tool,
      ChatOpenAICompletions: openai.ChatOpenAICompletions,
      concat: stream.concat,
      z: zod.z,
    }));
  }
  return langChainRuntimePromise;
}

export interface LangChainBackendOptions {
  /**
   * Builds the OpenAI-compatible chat model lazily. Laziness matters in
   * production because the API key lives in a secret store and must be read
   * asynchronously before the model can be constructed.
   */
  modelFactory: () => Promise<ChatOpenAICompletions>;
  maxRounds?: number;
}

/**
 * Builds a `ChatOpenAICompletions` (DeepSeek or any OpenAI-compatible endpoint)
 * from the app's `ProviderStore`, fencing on the provider recipient revision so
 * a changed endpoint/model/credential can never receive prior conversation
 * history.
 */
export class LangChainProviderModelFactory {
  private readonly expectedRecipientRevision: string;

  constructor(
    private readonly providerId: string,
    private readonly providers: ProviderStore,
  ) {
    this.expectedRecipientRevision = providers.get(providerId).recipientRevision;
  }

  async build(): Promise<ChatOpenAICompletions> {
    const { profile, apiKey } = await this.providers.runtimeSnapshot(
      this.providerId,
      this.expectedRecipientRevision,
    );
    const runtime = await loadLangChainRuntime();
    return new runtime.ChatOpenAICompletions({
      model: profile.modelId,
      apiKey,
      maxRetries: 1,
      timeout: 120_000,
      configuration: { baseURL: profile.baseUrl },
    }) as ChatOpenAICompletions;
  }
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
  if (value === undefined) return DEFAULT_MAX_ROUNDS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_HARNESS_ROUNDS) {
    throw new Error(`LangChain Harness maxRounds must be an integer from 1 to ${MAX_HARNESS_ROUNDS}.`);
  }
  return value;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('LangChain Harness turn cancelled.');
  error.name = 'AbortError';
  throw error;
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toLangChainMessage(message: AgentMessage, runtime: LangChainRuntime): BaseMessage {
  switch (message.role) {
    case 'system':
      return new runtime.SystemMessage(message.content);
    case 'user':
      return new runtime.HumanMessage(message.content);
    case 'assistant':
      return new runtime.AIMessage({
        content: message.content ?? '',
        ...(message.toolCalls?.length
          ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              args: parseToolArguments(call.arguments),
            })),
          }
          : {}),
      });
    case 'tool':
      return new runtime.ToolMessage({
        content: message.content,
        tool_call_id: message.toolCallId,
      });
    default:
      throw new Error(`Unsupported Agent message role: ${String((message as { role?: string }).role)}.`);
  }
}

function toAgentMessage(message: BaseMessage): AgentMessage {
  const type = message.getType();
  if (type === 'system' || type === 'human') {
    return { role: type === 'system' ? 'system' : 'user', content: String(message.content ?? '') };
  }
  if (type === 'ai') {
    const ai = message as unknown as AIMessage;
    return {
      role: 'assistant',
      content: typeof ai.content === 'string' ? ai.content : JSON.stringify(ai.content ?? ''),
      ...(ai.tool_calls?.length
        ? {
          toolCalls: ai.tool_calls.map((call): AgentToolCall => ({
            id: call.id ?? '',
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          })),
        }
        : {}),
    };
  }
  if (type === 'tool') {
    const toolMessage = message as unknown as {
      content: string | unknown[];
      tool_call_id: string;
    };
    return {
      role: 'tool',
      content: String(toolMessage.content ?? ''),
      toolCallId: toolMessage.tool_call_id,
    };
  }
  throw new Error(`Unsupported LangChain message type: ${type}.`);
}

function errorResult(error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function requireString(args: Record<string, unknown>, field: string, toolName: string): string {
  const value = args[field];
  if (typeof value !== 'string' || !value) {
    throw new Error(`${toolName} requires a valid ${field}.`);
  }
  return value;
}

function requirePath(args: Record<string, unknown>, toolName: string, field = 'path'): string {
  return requireString(args, field, toolName);
}

/**
 * Adapts the shared `ToolGateway` to a LangChain agent loop. The model never
 * receives LangChain's own shell/file tools — only these terminal and
 * workspace tools built from the injected gateway.
 */
export class LangChainBackend implements AgentBackend {
  private readonly threads = new Map<string, LangChainThreadRecord>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly modelFactory: () => Promise<ChatOpenAICompletions>;
  private readonly maxRounds: number;
  private modelPromise?: Promise<ChatOpenAICompletions>;

  constructor(options: LangChainBackendOptions) {
    this.modelFactory = options.modelFactory;
    this.maxRounds = configuredMaxRounds(options.maxRounds);
  }

  async createThread(input: { id: string; signal?: AbortSignal }): Promise<AgentBackendThread> {
    if (input.signal) throwIfCancelled(input.signal);
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
    if (input.signal) throwIfCancelled(input.signal);
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
    if (!input.gateway) throw new Error('LangChain Harness requires a per-turn ToolGateway.');
    if (this.activeTurns.has(record.handle.id)) {
      throw new Error(`Agent backend thread ${record.handle.id} already has an active turn.`);
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(input.signal.reason);
    if (input.signal.aborted) abortFromCaller();
    else input.signal.addEventListener('abort', abortFromCaller, { once: true });
    this.activeTurns.set(record.handle.id, { controller });

    try {
      const runtime = await loadLangChainRuntime();
      const modelWithTools = (await this.resolveModel()).bindTools(
        this.buildTools(input.gateway, input.fileAccessMode, runtime),
      );
      const messages: BaseMessage[] = [
        new runtime.SystemMessage(input.systemPrompt),
        ...record.priorMessages.map((message) => toLangChainMessage(message, runtime)),
        new runtime.HumanMessage(
          `${input.prompt}\n\nRecent visible terminal context:\n${input.terminalContext}`,
        ),
      ];
      const transcript: AgentMessage[] = [
        { role: 'system', content: input.systemPrompt },
        ...cloneMessages(record.priorMessages),
        {
          role: 'user',
          content: `${input.prompt}\n\nRecent visible terminal context:\n${input.terminalContext}`,
        },
      ];

      let finalText = '';
      let rounds = 0;

      while (rounds < this.maxRounds) {
        throwIfCancelled(controller.signal);
        const stream = await modelWithTools.stream(messages, { signal: controller.signal });
        let full: unknown;
        for await (const chunk of stream) {
          throwIfCancelled(controller.signal);
          if (chunk.content) {
            const text = typeof chunk.content === 'string' ? chunk.content : '';
            if (text) input.onEvent?.({ type: 'assistant_delta', text });
          }
          full = full === undefined ? chunk : runtime.concat(full, chunk);
        }
        throwIfCancelled(controller.signal);
        const toolCalls = full
          ? runtime.collapseToolCallChunks((full as { tool_call_chunks?: unknown[] }).tool_call_chunks ?? [])
            .tool_calls
          : [];
        const content = full
          ? (typeof (full as { content?: unknown }).content === 'string'
            ? String((full as { content: string }).content)
            : ((full as { content?: unknown }).content
              ? JSON.stringify((full as { content: unknown }).content)
              : ''))
          : '';
        const response = new runtime.AIMessage({
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
        throwIfCancelled(controller.signal);

        const assistant = toAgentMessage(response);
        messages.push(response);
        transcript.push(assistant);

        if (response.content) {
          finalText = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content);
          input.onEvent?.({ type: 'assistant_text', text: finalText });
        }

        if (!response.tool_calls?.length) break;

        for (const call of response.tool_calls) {
          throwIfCancelled(controller.signal);
          const toolCall: AgentToolCall = {
            id: call.id ?? '',
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          };
          input.onEvent?.({ type: 'tool_started', toolCall });
          throwIfCancelled(controller.signal);

          let result: string;
          try {
            result = await this.executeTool(
              input.gateway,
              input.fileAccessMode,
              call.name,
              call.args as Record<string, unknown>,
            );
          } catch (error) {
            throwIfCancelled(controller.signal);
            result = errorResult(error);
          }
          throwIfCancelled(controller.signal);

          messages.push(new runtime.ToolMessage({ content: result, tool_call_id: call.id ?? '' }));
          transcript.push({ role: 'tool', content: result, toolCallId: call.id ?? '' });
          input.onEvent?.({ type: 'tool_completed', toolCall, result });
        }
        rounds += 1;
      }

      throwIfCancelled(controller.signal);
      if (rounds >= this.maxRounds) {
        throw new Error(
          `Agent 超出 ${this.maxRounds} 轮安全上限。请拆分任务、减少单次修改的文件数，或分多轮继续。`,
        );
      }
      record.priorMessages = cloneMessages(
        transcript.filter((message) => message.role !== 'system'),
      );
      return {
        id: record.handle.id,
        messages: cloneMessages(transcript),
        finalText,
        rounds,
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
      new Error(`LangChain Harness turn interrupted: ${input.reason}.`),
    );
  }

  /** Lazily resolves and caches the model; a failed build can be retried next turn. */
  private resolveModel(): Promise<ChatOpenAICompletions> {
    if (!this.modelPromise) {
      this.modelPromise = this.modelFactory().catch((error) => {
        this.modelPromise = undefined;
        throw error;
      });
    }
    return this.modelPromise;
  }

  private buildTools(
    gateway: ToolGateway,
    fileAccessMode: AgentFileAccessMode,
    runtime: LangChainRuntime,
  ): StructuredToolInterface[] {
    const run = (name: string) => (
      (args: Record<string, unknown>) => this.executeTool(gateway, fileAccessMode, name, args)
    );

    const tools: StructuredToolInterface[] = [
      runtime.tool(run('terminal_execute'), {
        name: 'terminal_execute',
        description:
          'Request execution of one command in the same visible terminal. '
          + 'User approval is required unless Full Takeover is explicitly active.',
        schema: runtime.z.object({
          command: runtime.z.string().min(1).describe('The single shell command to execute.'),
          reason: runtime.z.string().optional().describe('Optional one-line justification.'),
        }),
      }),
      runtime.tool(run('terminal_read'), {
        name: 'terminal_read',
        description: 'Read a bounded recent portion of the exact visible terminal history.',
        schema: runtime.z.object({
          maxChars: runtime.z.number().int().min(100).max(30_000).optional(),
        }),
      }),
      runtime.tool(run('terminal_state'), {
        name: 'terminal_state',
        description: 'Get the current terminal transport, shell, cwd/user, and control state.',
        schema: runtime.z.object({}),
      }),
    ];

    const workspace = gateway.workspace;
    const permissions = gateway.context.permissions.workspace;
    if (!workspace || !permissions.enabled || fileAccessMode === 'off') return tools;

    const modeCanWrite = fileAccessMode === 'read-write' || fileAccessMode === 'full-access';

    if (permissions.read) {
      tools.push(
        runtime.tool(run('workspace_list'), {
          name: 'workspace_list',
          description: 'List one bounded directory inside the explicit Workspace Root without running a shell command.',
          schema: runtime.z.object({
            path: runtime.z.string().max(4_096).optional().describe('Directory path relative to the Workspace Root.'),
          }),
        }),
        runtime.tool(run('workspace_read_file'), {
          name: 'workspace_read_file',
          description:
            'Read one needed, bounded text file inside the Workspace Root and return its SHA-256. '
            + 'Supports UTF-8 and Windows GBK (ANSI) encodings; edits keep the file\'s original encoding. '
            + 'Prefer small, targeted reads; never use cat/Get-Content/type in the terminal for this.',
          schema: runtime.z.object({
            path: runtime.z.string().min(1).max(4_096).describe('File path relative to the Workspace Root.'),
          }),
        }),
        runtime.tool(run('workspace_stat'), {
          name: 'workspace_stat',
          description: 'Inspect one file, directory, or symbolic link inside the Workspace Root without reading its contents.',
          schema: runtime.z.object({
            path: runtime.z.string().min(1).max(4_096),
          }),
        }),
        runtime.tool(run('workspace_search'), {
          name: 'workspace_search',
          description: 'Search bounded UTF-8 workspace files for literal text and return structured line/column previews. Use this instead of grep in the terminal.',
          schema: runtime.z.object({
            query: runtime.z.string().min(1).max(4_096),
            path: runtime.z.string().max(4_096).optional(),
            maxResults: runtime.z.number().int().min(1).max(200).optional(),
          }),
        }),
        runtime.tool(run('workspace_glob'), {
          name: 'workspace_glob',
          description: 'Find bounded workspace paths matching a glob pattern without running find, dir, or another shell command.',
          schema: runtime.z.object({
            pattern: runtime.z.string().min(1).max(4_096),
            path: runtime.z.string().max(4_096).optional(),
            maxResults: runtime.z.number().int().min(1).max(500).optional(),
          }),
        }),
      );
    }

    if (modeCanWrite) {
      tools.push(
        runtime.tool(run('workspace_apply_patch'), {
          name: 'workspace_apply_patch',
          description:
            'Preferred way to modify an existing file. Atomically apply exact, unique text replacements and return a diff. '
            + 'Works on UTF-8 and Windows GBK (ANSI) text; the file keeps its original encoding on write-back. '
            + 'expectedSha256 must come from the latest workspace_read_file; re-read after a conflict.',
          schema: runtime.z.object({
            path: runtime.z.string().min(1).max(4_096),
            expectedSha256: runtime.z.string().regex(/^[a-fA-F0-9]{64}$/),
            patches: runtime.z.array(runtime.z.object({
              search: runtime.z.string().min(1).max(131_072),
              replace: runtime.z.string().max(131_072),
            })).min(1).max(64),
          }),
        }),
        runtime.tool(run('workspace_write_file'), {
          name: 'workspace_write_file',
          description:
            'Atomically create one bounded UTF-8 text file. For an existing file prefer workspace_apply_patch; pass null only when the path must not exist.',
          schema: runtime.z.object({
            path: runtime.z.string().min(1).max(4_096),
            content: runtime.z.string().max(131_072),
            expectedSha256: runtime.z.string().regex(/^[a-fA-F0-9]{64}$/).nullable(),
          }),
        }),
        runtime.tool(run('workspace_mkdir'), {
          name: 'workspace_mkdir',
          description: 'Create one directory inside the Workspace Root without running a shell command.',
          schema: runtime.z.object({
            path: runtime.z.string().min(1).max(4_096),
          }),
        }),
        runtime.tool(run('workspace_rename'), {
          name: 'workspace_rename',
          description: 'Rename or move one workspace path to another path inside the same Workspace Root.',
          schema: runtime.z.object({
            source: runtime.z.string().min(1).max(4_096),
            destination: runtime.z.string().min(1).max(4_096),
          }),
        }),
        runtime.tool(run('workspace_delete'), {
          name: 'workspace_delete',
          description: 'Delete one workspace path. Recursive directory deletion must be explicitly requested.',
          schema: runtime.z.object({
            path: runtime.z.string().min(1).max(4_096),
            recursive: runtime.z.boolean().optional(),
          }),
        }),
      );
    }

    return tools;
  }

  private async executeTool(
    gateway: ToolGateway,
    fileAccessMode: AgentFileAccessMode,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case 'terminal_read': {
        const requested = typeof args.maxChars === 'number' ? args.maxChars : 8_000;
        const maxChars = Math.min(30_000, Math.max(100, Math.floor(requested)));
        return JSON.stringify({
          ok: true,
          output: await gateway.terminal.readVisible({ maxChars }),
        });
      }
      case 'terminal_state':
        return JSON.stringify({ ok: true, state: await gateway.terminal.getState() });
      case 'terminal_execute': {
        if (typeof args.command !== 'string' || !args.command.trim()) {
          throw new Error('terminal_execute requires a non-empty command.');
        }
        const result = await gateway.terminal.execute(
          args.command,
          typeof args.reason === 'string' ? args.reason : undefined,
        );
        return JSON.stringify({ ok: result.status === 'completed', ...result });
      }
      case 'workspace_list':
      case 'workspace_read_file':
      case 'workspace_stat':
      case 'workspace_search':
      case 'workspace_glob':
      case 'workspace_apply_patch':
      case 'workspace_write_file':
      case 'workspace_mkdir':
      case 'workspace_rename':
      case 'workspace_delete': {
        const workspace = this.requireWorkspace(gateway, fileAccessMode, name);
        switch (name) {
          case 'workspace_list': {
            const path = typeof args.path === 'string' ? args.path : '.';
            return JSON.stringify({ ok: true, ...await workspace.listDirectory(path) });
          }
          case 'workspace_read_file':
            return JSON.stringify({
              ok: true,
              ...await workspace.readFile(requirePath(args, name)),
            });
          case 'workspace_stat':
            return JSON.stringify({ ok: true, ...await workspace.stat(requirePath(args, name)) });
          case 'workspace_search':
            return JSON.stringify({
              ok: true,
              ...await workspace.search(requireString(args, 'query', name), {
                ...(typeof args.path === 'string' ? { path: args.path } : {}),
                ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
              }),
            });
          case 'workspace_glob':
            return JSON.stringify({
              ok: true,
              ...await workspace.glob(requireString(args, 'pattern', name), {
                ...(typeof args.path === 'string' ? { path: args.path } : {}),
                ...(typeof args.maxResults === 'number' ? { maxResults: args.maxResults } : {}),
              }),
            });
          case 'workspace_apply_patch':
            return JSON.stringify({
              ok: true,
              ...await workspace.applyPatch(
                requirePath(args, name),
                requireString(args, 'expectedSha256', name),
                args.patches as never,
              ),
            });
          case 'workspace_write_file':
            return JSON.stringify({
              ok: true,
              ...await workspace.writeFile(
                requirePath(args, name),
                requireString(args, 'content', name),
                (args.expectedSha256 as string | null) ?? null,
              ),
            });
          case 'workspace_mkdir':
            await workspace.mkdir(requirePath(args, name));
            return JSON.stringify({ ok: true, path: requirePath(args, name) });
          case 'workspace_rename': {
            const source = requirePath(args, name, 'source');
            const destination = requirePath(args, name, 'destination');
            await workspace.rename(source, destination);
            return JSON.stringify({ ok: true, source, destination });
          }
          case 'workspace_delete': {
            const recursive = args.recursive === true;
            await workspace.delete(requirePath(args, name), { recursive });
            return JSON.stringify({ ok: true, path: requirePath(args, name), recursive });
          }
          default:
            throw new Error(`Unsupported tool: ${name}`);
        }
      }
      default:
        throw new Error(`Unsupported tool: ${name}`);
    }
  }

  private requireWorkspace(
    gateway: ToolGateway,
    fileAccessMode: AgentFileAccessMode,
    toolName: string,
  ): NonNullable<ToolGateway['workspace']> {
    const permissions = gateway.context.permissions.workspace;
    if (
      fileAccessMode === 'off'
      || !permissions.enabled
      || !permissions.read
      || !gateway.workspace
    ) {
      throw new Error(`${toolName} is disabled.`);
    }
    return gateway.workspace;
  }

  private requireThread(handle: AgentBackendThread): LangChainThreadRecord {
    const record = this.threads.get(handle.id);
    if (!record || record.handle !== handle) {
      throw new Error('Agent backend thread handle is missing, stale, or belongs to another backend.');
    }
    return record;
  }
}
