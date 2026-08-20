/**
 * Narrow protocol boundary generated against @openai/codex 0.148.0 App Server v2.
 * Keep this adapter versioned: the runtime must reject malformed telemetry instead
 * of guessing at fields or accidentally displaying cumulative account/thread usage.
 */

const MAX_PROTOCOL_ID_CHARS = 256;

export const CODEX_APP_SERVER_SCHEMA_BASIS = Object.freeze({
  package: '@openai/codex',
  version: '0.148.0',
  protocol: 'app-server-v2',
});

export interface CodexTokenUsageBreakdownV2 {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexThreadTokenUsageV2 {
  total: CodexTokenUsageBreakdownV2;
  last: CodexTokenUsageBreakdownV2;
  modelContextWindow: number | null;
}

export interface CodexThreadTokenUsageUpdatedV2 {
  threadId: string;
  /** Optional only for compatibility with older App Server notification emitters. */
  turnId?: string;
  tokenUsage: CodexThreadTokenUsageV2;
}

export interface CodexContextCompactionLifecycleV2 {
  type: 'compaction-started' | 'compaction-completed';
  threadId: string;
  turnId: string;
  itemId: string;
  occurredAt: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PROTOCOL_ID_CHARS) {
    throw new Error(`${label} 无效。`);
  }
  return value;
}

function safeCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负安全整数。`);
  }
  return Number(value);
}

function breakdown(value: unknown, label: string): CodexTokenUsageBreakdownV2 {
  const source = record(value, label);
  return {
    totalTokens: safeCount(source.totalTokens, `${label}.totalTokens`),
    inputTokens: safeCount(source.inputTokens, `${label}.inputTokens`),
    cachedInputTokens: safeCount(source.cachedInputTokens, `${label}.cachedInputTokens`),
    // The generated JSON schema defaults this recently-added field to zero.
    cacheWriteInputTokens: source.cacheWriteInputTokens === undefined
      ? 0
      : safeCount(source.cacheWriteInputTokens, `${label}.cacheWriteInputTokens`),
    outputTokens: safeCount(source.outputTokens, `${label}.outputTokens`),
    reasoningOutputTokens: safeCount(
      source.reasoningOutputTokens,
      `${label}.reasoningOutputTokens`,
    ),
  };
}

export function parseThreadTokenUsageUpdatedV2(
  value: unknown,
): CodexThreadTokenUsageUpdatedV2 {
  const params = record(value, 'thread/tokenUsage/updated params');
  const tokenUsage = record(params.tokenUsage, 'thread/tokenUsage/updated tokenUsage');
  const rawWindow = tokenUsage.modelContextWindow;
  const modelContextWindow = rawWindow === null || rawWindow === undefined
    ? null
    : safeCount(rawWindow, 'thread/tokenUsage/updated modelContextWindow');
  if (modelContextWindow !== null && modelContextWindow <= 0) {
    throw new Error('thread/tokenUsage/updated modelContextWindow 必须大于零。');
  }
  return {
    threadId: id(params.threadId, 'thread/tokenUsage/updated threadId'),
    ...(params.turnId === undefined
      ? {}
      : { turnId: id(params.turnId, 'thread/tokenUsage/updated turnId') }),
    tokenUsage: {
      total: breakdown(tokenUsage.total, 'thread/tokenUsage/updated tokenUsage.total'),
      last: breakdown(tokenUsage.last, 'thread/tokenUsage/updated tokenUsage.last'),
      modelContextWindow,
    },
  };
}

export function parseContextCompactionLifecycleV2(
  method: 'item/started' | 'item/completed',
  value: unknown,
): CodexContextCompactionLifecycleV2 | undefined {
  const params = record(value, `${method} params`);
  const item = record(params.item, `${method} item`);
  if (item.type !== 'contextCompaction') return undefined;
  const timeField = method === 'item/started' ? 'startedAtMs' : 'completedAtMs';
  const occurredAtMs = safeCount(params[timeField], `${method} ${timeField}`);
  return {
    type: method === 'item/started' ? 'compaction-started' : 'compaction-completed',
    threadId: id(params.threadId, `${method} threadId`),
    turnId: id(params.turnId, `${method} turnId`),
    itemId: id(item.id, `${method} item.id`),
    occurredAt: new Date(occurredAtMs).toISOString(),
  };
}
