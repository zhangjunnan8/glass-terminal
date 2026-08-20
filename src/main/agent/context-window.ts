import type { AgentContextUsage } from '../../shared/agent';
import {
  CONTEXT_RECENT_KEEP_FRACTION,
  contextCompressionThreshold,
  normalizedContextEstimateSafetyFactor,
  normalizedContextWindowTokens,
} from '../../shared/context-window';
import type { AgentMessage } from './agent-backend';
import type { AgentFunctionToolDefinition } from './agent-tool-definitions';
import {
  STRUCTURED_SUMMARY_PREFIX,
  deterministicStructuredContextSummary,
  mergeStructuredContextSummaries,
  parseStructuredContextSummary,
  serializeStructuredContextSummary,
  structuredSummariesFromMessages,
} from './structured-context-summary';

const FIXED_REQUEST_OVERHEAD_TOKENS = 16;
const PER_TOOL_WRAPPER_TOKENS = 8;

const WORKSPACE_TOOL_NAMES = new Set([
  'workspace_list',
  'workspace_read_file',
  'workspace_stat',
  'workspace_search',
  'workspace_glob',
  'workspace_write_file',
  'workspace_apply_patch',
  'workspace_mkdir',
  'workspace_rename',
  'workspace_delete',
  // Persisted alpha aliases remain compactable on resume.
  'file_list',
  'file_read',
  'file_stat',
  'file_write',
  'file_patch',
]);

export interface ContextCompressionResult {
  messages: AgentMessage[];
  beforeTokens: number;
  afterTokens: number;
  compressed: boolean;
  rewritten: boolean;
  lastCompressedAt?: string;
}

export type ContextSummarizer = (serializedHistory: string) => Promise<string>;

export interface ContextEstimationOptions {
  tools?: readonly AgentFunctionToolDefinition[];
  safetyFactor?: number;
  providerReportedInputTokens?: number;
}

export interface AgentContextTokenEstimate {
  estimatedTokens: number;
  messageEstimatedTokens: number;
  toolSchemaEstimatedTokens: number;
  fixedOverheadTokens: number;
  safetyFactor: number;
  boundToolCount: number;
}

export interface AgentContextBudget extends AgentContextTokenEstimate {
  contextWindowTokens: number;
  inputLimitTokens: number;
  outputReserveTokens: number;
  remainingInputTokens: number;
  fits: boolean;
}

export class AgentContextBudgetExceededError extends Error {
  readonly code = 'CONTEXT_BUDGET_EXCEEDED';

  constructor(
    readonly stage: 'current_prompt' | 'provider_request' | 'tool_result',
    readonly estimatedTokens: number,
    readonly allowedTokens: number,
    detail: string,
  ) {
    super(
      `${detail}（保守估算 ${estimatedTokens} tokens，当前安全输入上限 ${allowedTokens} tokens）。`
      + '请缩短或拆分输入后重试；Glass Terminal 未向 Provider 发送该超限请求。',
    );
    this.name = 'AgentContextBudgetExceededError';
  }
}

export function cloneAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
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

/**
 * Conservative synchronous estimator: ASCII word/space runs average roughly
 * four characters per token, syntax punctuation is charged individually, and
 * CJK/other non-ASCII code points count as at least one token. Treating dense
 * code and JSON differently avoids the worst undercount from prose-only rules.
 */
export function estimateTextTokens(text: string): number {
  let asciiWord = 0;
  let asciiSyntax = 0;
  let nonAscii = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      if (
        (codePoint >= 0x30 && codePoint <= 0x39)
        || (codePoint >= 0x41 && codePoint <= 0x5a)
        || (codePoint >= 0x61 && codePoint <= 0x7a)
        || codePoint === 0x20
        || (codePoint >= 0x09 && codePoint <= 0x0d)
      ) asciiWord += 1;
      else asciiSyntax += 1;
    }
    else nonAscii += character.length > 1 ? 2 : 1;
  }
  return Math.ceil(asciiWord / 4) + asciiSyntax + nonAscii;
}

export function estimateAgentMessagesTokens(messages: readonly AgentMessage[]): number {
  return messages.reduce((total, message) => {
    let tokens = 4;
    tokens += estimateTextTokens(message.content ?? '');
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) {
        tokens += 4 + estimateTextTokens(call.name) + estimateTextTokens(call.arguments);
      }
    }
    if (message.role === 'tool') tokens += estimateTextTokens(message.toolCallId);
    return total + tokens;
  }, 3);
}

export function estimateAgentToolSchemaTokens(
  tools: readonly AgentFunctionToolDefinition[],
): number {
  return tools.reduce((total, definition) => (
    total
    + PER_TOOL_WRAPPER_TOKENS
    + estimateTextTokens(JSON.stringify(definition))
  ), 0);
}

/**
 * Provider-independent request estimate used by both the meter and automatic
 * compression. Provider usage metadata never feeds back into this safety path.
 */
export function estimateAgentContextTokens(
  messages: readonly AgentMessage[],
  options: ContextEstimationOptions = {},
): AgentContextTokenEstimate {
  const messageEstimatedTokens = estimateAgentMessagesTokens(messages);
  const tools = options.tools ?? [];
  const toolSchemaEstimatedTokens = estimateAgentToolSchemaTokens(tools);
  const fixedOverheadTokens = FIXED_REQUEST_OVERHEAD_TOKENS;
  const safetyFactor = normalizedContextEstimateSafetyFactor(options.safetyFactor);
  return {
    estimatedTokens: Math.ceil((
      messageEstimatedTokens
      + toolSchemaEstimatedTokens
      + fixedOverheadTokens
    ) * safetyFactor),
    messageEstimatedTokens,
    toolSchemaEstimatedTokens,
    fixedOverheadTokens,
    safetyFactor,
    boundToolCount: tools.length,
  };
}

/**
 * One authoritative input budget for the meter, compaction gate, user prompt
 * preflight, and tool-result pagination. The unused 15% is an explicit output
 * reserve rather than available input space.
 */
export function agentContextBudget(
  messages: readonly AgentMessage[],
  contextWindowTokens: number,
  options: ContextEstimationOptions = {},
): AgentContextBudget {
  const normalizedWindow = normalizedContextWindowTokens(contextWindowTokens);
  const inputLimitTokens = contextCompressionThreshold(normalizedWindow);
  const estimate = estimateAgentContextTokens(messages, options);
  return {
    ...estimate,
    contextWindowTokens: normalizedWindow,
    inputLimitTokens,
    outputReserveTokens: normalizedWindow - inputLimitTokens,
    remainingInputTokens: Math.max(0, inputLimitTokens - estimate.estimatedTokens),
    fits: estimate.estimatedTokens < inputLimitTokens,
  };
}

export function agentContextUsage(
  messages: readonly AgentMessage[],
  contextWindowTokens: number,
  status: AgentContextUsage['status'] = 'ready',
  lastCompressedAt?: string,
  estimation: ContextEstimationOptions = {},
): AgentContextUsage {
  const normalizedWindow = normalizedContextWindowTokens(contextWindowTokens);
  const compressionThresholdTokens = contextCompressionThreshold(normalizedWindow);
  const budget = agentContextBudget(messages, normalizedWindow, estimation);
  const providerReportedInputTokens = Number.isSafeInteger(
    estimation.providerReportedInputTokens,
  ) && Number(estimation.providerReportedInputTokens) >= 0
    ? Number(estimation.providerReportedInputTokens)
    : undefined;
  return {
    estimatedTokens: budget.estimatedTokens,
    messageEstimatedTokens: budget.messageEstimatedTokens,
    toolSchemaEstimatedTokens: budget.toolSchemaEstimatedTokens,
    fixedOverheadTokens: budget.fixedOverheadTokens,
    safetyFactor: budget.safetyFactor,
    boundToolCount: budget.boundToolCount,
    contextWindowTokens: normalizedWindow,
    compressionThresholdTokens,
    percentage: Math.max(0, Math.min(
      100,
      Math.round((budget.estimatedTokens / compressionThresholdTokens) * 100),
    )),
    status,
    ...(providerReportedInputTokens !== undefined ? { providerReportedInputTokens } : {}),
    ...(lastCompressedAt ? { lastCompressedAt } : {}),
  };
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
    return JSON.stringify({
      ok: value.ok,
      compacted: true,
      tool: toolName,
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
    return JSON.stringify({ ok: false, compacted: true, tool: toolName });
  }
}

/**
 * Workspace bodies are useful for exactly one following reasoning step. Once
 * consumed, retain only stable metadata so file contents and mutation payloads
 * do not remain in every later Provider request/checkpoint.
 */
export function compactCompletedWorkspaceHistory(
  messages: AgentMessage[],
  keepAssistant?: Extract<AgentMessage, { role: 'assistant' }>,
): boolean {
  if (!keepAssistant) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index]!;
      if (candidate.role === 'tool') continue;
      if (
        candidate.role === 'assistant'
        && candidate.toolCalls?.length
        && messages.slice(index + 1).every((message) => message.role === 'tool')
      ) keepAssistant = candidate;
      break;
    }
  }
  const compactCalls = new Map<string, string>();
  let changed = false;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls || message === keepAssistant) continue;
    if (message.toolResultsPending) continue;
    message.toolCalls = message.toolCalls.map((call) => {
      if (!WORKSPACE_TOOL_NAMES.has(call.name) || call.arguments === '{"historyCompacted":true}') {
        return call;
      }
      compactCalls.set(call.id, call.name);
      changed = true;
      return { ...call, arguments: '{"historyCompacted":true}' };
    });
  }
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const toolName = compactCalls.get(message.toolCallId);
    if (!toolName) continue;
    message.content = compactToolResult(message.content, toolName);
  }
  return changed;
}

function contextGroups(messages: readonly AgentMessage[]): AgentMessage[][] {
  const groups: AgentMessage[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const group = [message];
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const pendingIds = new Set(message.toolCalls.map((call) => call.id));
      while (index + 1 < messages.length) {
        const next = messages[index + 1]!;
        if (next.role !== 'tool' || !pendingIds.has(next.toolCallId)) break;
        group.push(next);
        index += 1;
      }
    }
    groups.push(group);
  }
  return groups;
}

function splitOldAndRecent(
  messages: readonly AgentMessage[],
  keepTokens: number,
): { older: AgentMessage[]; recent: AgentMessage[] } {
  const groups = contextGroups(messages);
  if (groups.length <= 1) return { older: [], recent: [...messages] };
  let lastUserGroup = -1;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index]!.some((message) => message.role === 'user')) {
      lastUserGroup = index;
      break;
    }
  }
  // Keep a contiguous suffix. Selecting small earlier groups across a skipped
  // large group would move those messages after the generated summary and
  // silently reorder the conversation.
  let recentStart = lastUserGroup >= 0 ? lastUserGroup : groups.length - 1;
  let recentTokens = groups.slice(recentStart).reduce((total, group) => (
    total + estimateAgentMessagesTokens(group)
  ), 0);
  for (let index = recentStart - 1; index >= 0; index -= 1) {
    const candidateTokens = estimateAgentMessagesTokens(groups[index]!);
    if (recentTokens + candidateTokens > keepTokens) break;
    recentStart = index;
    recentTokens += candidateTokens;
  }
  return {
    older: groups.slice(0, recentStart).flat(),
    recent: groups.slice(recentStart).flat(),
  };
}

function serializedMessagesForSummary(messages: readonly AgentMessage[]): string {
  return messages.map((message, index) => {
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const calls = message.toolCalls.map((call) => `${call.name}(${call.arguments})`).join('\n');
      return `<message index="${index}" role="assistant">\n${message.content ?? ''}\n<tool_calls>\n${calls}\n</tool_calls>\n</message>`;
    }
    if (message.role === 'tool') {
      return `<message index="${index}" role="tool" call_id="${message.toolCallId}">\n${message.content}\n</message>`;
    }
    return `<message index="${index}" role="${message.role}">\n${message.content}\n</message>`;
  }).join('\n\n');
}

export async function compressContextIfNeeded(
  inputMessages: readonly AgentMessage[],
  contextWindowTokens: number,
  summarize: ContextSummarizer,
  options: {
    keepAssistant?: Extract<AgentMessage, { role: 'assistant' }>;
    now?: () => string;
    signal?: AbortSignal;
    estimation?: ContextEstimationOptions;
  } = {},
): Promise<ContextCompressionResult> {
  const messages = cloneAgentMessages(inputMessages);
  const keepAssistant = options.keepAssistant
    ? messages[inputMessages.indexOf(options.keepAssistant)] as Extract<AgentMessage, { role: 'assistant' }>
    : undefined;
  const rewritten = compactCompletedWorkspaceHistory(messages, keepAssistant);
  const beforeTokens = estimateAgentContextTokens(messages, options.estimation).estimatedTokens;
  const normalizedWindow = normalizedContextWindowTokens(contextWindowTokens);
  if (beforeTokens < contextCompressionThreshold(normalizedWindow)) {
    return { messages, beforeTokens, afterTokens: beforeTokens, compressed: false, rewritten };
  }

  const systemMessages = messages.filter((message) => message.role === 'system');
  const conversation = messages.filter((message) => message.role !== 'system');
  const keepTokens = Math.max(1_024, Math.floor(
    normalizedWindow * CONTEXT_RECENT_KEEP_FRACTION,
  ));
  const { older, recent } = splitOldAndRecent(conversation, keepTokens);
  if (older.length === 0) {
    return { messages, beforeTokens, afterTokens: beforeTokens, compressed: false, rewritten };
  }

  const previousSummaries = structuredSummariesFromMessages(older);
  let structuredSummary;
  try {
    const candidate = parseStructuredContextSummary(
      (await summarize(serializedMessagesForSummary(older))).trim(),
    );
    structuredSummary = mergeStructuredContextSummaries(candidate, previousSummaries);
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    structuredSummary = deterministicStructuredContextSummary(older);
  }
  const summary = serializeStructuredContextSummary(structuredSummary);
  const lastCompressedAt = options.now?.() ?? new Date().toISOString();
  const compacted: AgentMessage[] = [
    ...systemMessages,
    {
      role: 'assistant',
      content: `${STRUCTURED_SUMMARY_PREFIX}${summary}`,
      contextSummary: true,
    },
    ...recent,
  ];
  return {
    messages: compacted,
    beforeTokens,
    afterTokens: estimateAgentContextTokens(compacted, options.estimation).estimatedTokens,
    compressed: true,
    rewritten: true,
    lastCompressedAt,
  };
}
