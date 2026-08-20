import type { AgentContextUsage } from '../../shared/agent';
import {
  CONTEXT_RECENT_KEEP_FRACTION,
  contextCompressionThreshold,
  normalizedContextWindowTokens,
} from '../../shared/context-window';
import type { AgentMessage } from './agent-backend';

const MAX_SUMMARY_TOKENS = 4_096;
const MIN_SUMMARY_TOKENS = 512;
const SUMMARY_MESSAGE_PREFIX = '[Glass Terminal automatic context summary]\n';

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
 * Conservative synchronous estimator: ASCII prose averages roughly four
 * characters per token, while CJK and other non-ASCII code points count as at
 * least one token. This deliberately errs high for provider-agnostic safety.
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += character.length > 1 ? 2 : 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
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

export function agentContextUsage(
  messages: readonly AgentMessage[],
  contextWindowTokens: number,
  status: AgentContextUsage['status'] = 'ready',
  lastCompressedAt?: string,
): AgentContextUsage {
  const normalizedWindow = normalizedContextWindowTokens(contextWindowTokens);
  const compressionThresholdTokens = contextCompressionThreshold(normalizedWindow);
  const estimatedTokens = estimateAgentMessagesTokens(messages);
  return {
    estimatedTokens,
    contextWindowTokens: normalizedWindow,
    compressionThresholdTokens,
    percentage: Math.max(0, Math.min(
      100,
      Math.round((estimatedTokens / compressionThresholdTokens) * 100),
    )),
    status,
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
  const compactCalls = new Map<string, string>();
  let changed = false;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.toolCalls || message === keepAssistant) continue;
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

function truncateToEstimatedTokens(text: string, maxTokens: number): string {
  let used = 0;
  let result = '';
  for (const character of text) {
    const cost = character.codePointAt(0)! <= 0x7f ? 0.25 : character.length > 1 ? 2 : 1;
    if (used + cost > maxTokens) break;
    result += character;
    used += cost;
  }
  return result.trim();
}

function deterministicFallbackSummary(messages: readonly AgentMessage[]): string {
  const snippets = messages.flatMap((message) => {
    if (message.role === 'tool') return [];
    const content = (message.content ?? '').replace(/\s+/g, ' ').trim();
    if (!content) return [];
    const role = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'System';
    return [`- ${role}: ${content.slice(0, 700)}`];
  });
  return [
    'Automatic semantic summarization was unavailable. The following bounded excerpts preserve earlier intent; full history remains in the local conversation log.',
    ...snippets,
  ].join('\n');
}

export async function compressContextIfNeeded(
  inputMessages: readonly AgentMessage[],
  contextWindowTokens: number,
  summarize: ContextSummarizer,
  options: {
    keepAssistant?: Extract<AgentMessage, { role: 'assistant' }>;
    now?: () => string;
    signal?: AbortSignal;
  } = {},
): Promise<ContextCompressionResult> {
  const messages = cloneAgentMessages(inputMessages);
  const keepAssistant = options.keepAssistant
    ? messages[inputMessages.indexOf(options.keepAssistant)] as Extract<AgentMessage, { role: 'assistant' }>
    : undefined;
  const rewritten = compactCompletedWorkspaceHistory(messages, keepAssistant);
  const beforeTokens = estimateAgentMessagesTokens(messages);
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

  let summary: string;
  try {
    summary = (await summarize(serializedMessagesForSummary(older))).trim();
  } catch (error) {
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    summary = deterministicFallbackSummary(older);
  }
  if (!summary) summary = deterministicFallbackSummary(older);
  const maxSummaryTokens = Math.max(
    MIN_SUMMARY_TOKENS,
    Math.min(MAX_SUMMARY_TOKENS, Math.floor(normalizedWindow * 0.06)),
  );
  summary = truncateToEstimatedTokens(summary, maxSummaryTokens);
  const lastCompressedAt = options.now?.() ?? new Date().toISOString();
  const compacted: AgentMessage[] = [
    ...systemMessages,
    {
      role: 'assistant',
      content: `${SUMMARY_MESSAGE_PREFIX}${summary}`,
      contextSummary: true,
    },
    ...recent,
  ];
  return {
    messages: compacted,
    beforeTokens,
    afterTokens: estimateAgentMessagesTokens(compacted),
    compressed: true,
    rewritten: true,
    lastCompressedAt,
  };
}
