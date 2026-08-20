import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_SERVER_SCHEMA_BASIS,
  parseContextCompactionLifecycleV2,
  parseThreadTokenUsageUpdatedV2,
} from './app-server-protocol-v2';

function breakdown(totalTokens: number) {
  return {
    totalTokens,
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

describe('Codex App Server v2 telemetry boundary', () => {
  it('pins the generated schema basis and validates current and cumulative usage separately', () => {
    expect(CODEX_APP_SERVER_SCHEMA_BASIS).toEqual({
      package: '@openai/codex',
      version: '0.148.0',
      protocol: 'app-server-v2',
    });
    const parsed = parseThreadTokenUsageUpdatedV2({
      threadId: 'thread-1',
      turnId: 'turn-1',
      tokenUsage: {
        total: breakdown(900_000),
        last: breakdown(12_000),
        modelContextWindow: 64_000,
      },
    });
    expect(parsed.tokenUsage.total.totalTokens).toBe(900_000);
    expect(parsed.tokenUsage.last.totalTokens).toBe(12_000);
    expect(parsed.tokenUsage.last.cacheWriteInputTokens).toBe(0);
  });

  it('accepts a compatible notification without turnId', () => {
    const parsed = parseThreadTokenUsageUpdatedV2({
      threadId: 'thread-old',
      tokenUsage: {
        total: breakdown(10),
        last: breakdown(5),
        modelContextWindow: null,
      },
    });
    expect(parsed.turnId).toBeUndefined();
    expect(parsed.tokenUsage.modelContextWindow).toBeNull();
  });

  it.each([
    { name: 'missing last', value: { threadId: 't', tokenUsage: { total: breakdown(1) } } },
    { name: 'negative', value: { threadId: 't', tokenUsage: { total: breakdown(1), last: breakdown(-1) } } },
    { name: 'fraction', value: { threadId: 't', tokenUsage: { total: breakdown(1), last: breakdown(1.5) } } },
    { name: 'unsafe', value: { threadId: 't', tokenUsage: { total: breakdown(1), last: breakdown(Number.MAX_SAFE_INTEGER + 1) } } },
    { name: 'zero window', value: { threadId: 't', tokenUsage: { total: breakdown(1), last: breakdown(1), modelContextWindow: 0 } } },
  ])('rejects malformed telemetry: $name', ({ value }) => {
    expect(() => parseThreadTokenUsageUpdatedV2(value)).toThrow();
  });

  it('validates context compaction lifecycle timestamps', () => {
    expect(parseContextCompactionLifecycleV2('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      startedAtMs: 1_700_000_000_000,
      item: { type: 'contextCompaction', id: 'compact-1' },
    })).toMatchObject({
      type: 'compaction-started',
      occurredAt: '2023-11-14T22:13:20.000Z',
    });
    expect(parseContextCompactionLifecycleV2('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 1_700_000_001_000,
      item: { type: 'contextCompaction', id: 'compact-1' },
    })).toMatchObject({
      type: 'compaction-completed',
      occurredAt: '2023-11-14T22:13:21.000Z',
    });
    expect(parseContextCompactionLifecycleV2('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      completedAtMs: 1,
      item: { type: 'agentMessage', id: 'message-1' },
    })).toBeUndefined();
  });
});
