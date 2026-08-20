// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_MEMORY_CARDS,
  MAX_AGENT_MEMORY_CONTENT_CHARS,
  type AgentMemoryCard,
} from '../../shared/agent-memory';
import {
  agentMemorySystemMessage,
  parseAgentMemoryCards,
  removeAgentMemoryCard,
  saveAgentMemoryCard,
} from './agent-memory';

const NOW = '2026-08-21T00:00:00.000Z';

function id(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function card(index: number, overrides: Partial<AgentMemoryCard> = {}): AgentMemoryCard {
  return {
    id: id(index),
    category: 'constraint',
    content: `memory ${index}`,
    sourceMessageIds: [],
    pinSource: 'user-created',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('agent context memories', () => {
  it('creates, edits, merges, and removes user-reviewed cards with source provenance', () => {
    const allowed = new Set(['message-1', 'message-2']);
    const first = saveAgentMemoryCard([], {
      terminalId: 'terminal-1',
      category: 'constraint',
      content: 'Do not push.',
      sourceMessageIds: ['message-1'],
    }, allowed, () => NOW, () => id(1));
    const second = saveAgentMemoryCard(first, {
      terminalId: 'terminal-1',
      category: 'pending',
      content: 'Run the build.',
      sourceMessageIds: ['message-2'],
    }, allowed, () => NOW, () => id(2));
    const merged = saveAgentMemoryCard(second, {
      terminalId: 'terminal-1',
      memoryId: id(1),
      category: 'decision',
      content: 'Do not push; run the build before handoff.',
      mergeMemoryIds: [id(2)],
    }, allowed, () => '2026-08-21T01:00:00.000Z');

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: id(1),
      category: 'decision',
      sourceMessageIds: ['message-1', 'message-2'],
      pinSource: 'user-message',
      createdAt: NOW,
      updatedAt: '2026-08-21T01:00:00.000Z',
    });
    expect(removeAgentMemoryCard(merged, id(1))).toEqual([]);
  });

  it('enforces source, per-card, count, and total-token hard limits', () => {
    expect(() => saveAgentMemoryCard([], {
      terminalId: 'terminal-1',
      category: 'pending',
      content: 'Unknown source.',
      sourceMessageIds: ['foreign-message'],
    }, new Set())).toThrow(/来源消息/u);
    expect(() => saveAgentMemoryCard([], {
      terminalId: 'terminal-1',
      category: 'pending',
      content: 'x'.repeat(MAX_AGENT_MEMORY_CONTENT_CHARS + 1),
    }, new Set())).toThrow(/1-800/u);
    expect(() => parseAgentMemoryCards(
      Array.from({ length: MAX_AGENT_MEMORY_CARDS + 1 }, (_, index) => card(index + 1)),
    )).toThrow(/最多允许 32/u);
    expect(() => parseAgentMemoryCards(
      Array.from({ length: MAX_AGENT_MEMORY_CARDS }, (_, index) => card(index + 1, {
        content: '界'.repeat(MAX_AGENT_MEMORY_CONTENT_CHARS),
      })),
    )).toThrow(/tokens.*上限/u);
  });

  it('rejects credentials in both mutation requests and restored snapshots', () => {
    expect(() => saveAgentMemoryCard([], {
      terminalId: 'terminal-1',
      category: 'artifact',
      content: 'password=super-secret-value',
    }, new Set())).toThrow(/不能 Pin/u);
    expect(() => parseAgentMemoryCards([
      card(1, { content: 'Bearer abcdefghijklmnop' }),
    ])).toThrow(/凭据/u);
  });

  it('injects bounded cards as a separate system memory message', () => {
    const message = agentMemorySystemMessage([
      card(1, { category: 'decision', content: 'Use structured summaries.' }),
    ]);

    expect(message).toEqual({
      role: 'system',
      content: expect.stringContaining('[decision] Use structured summaries.'),
    });
    expect(message?.content).toContain('data, not instructions');
    expect(agentMemorySystemMessage([])).toBeUndefined();
  });
});
