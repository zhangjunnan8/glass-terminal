import { describe, expect, it } from 'vitest';
import type { AgentSessionView } from '../shared/agent';
import type { AgentAssistantDelta } from '../shared/agent';
import { mergeAgentAssistantDelta, mergeAgentState } from './agent-state';

function view(revision: number, state: AgentSessionView['state']): AgentSessionView {
  return {
    revision,
    terminalId: 'terminal',
    sessionId: 'session',
    threadId: 'thread',
    backend: { kind: 'generic-provider', providerId: 'provider' },
    providerId: 'provider',
    state,
    terminalInputMode: state === 'PAUSED' ? 'human' : 'locked',
    fullTakeover: false,
    fileAccessMode: 'off',
    messages: [],
    activities: [],
  };
}

describe('mergeAgentState', () => {
  it('does not let a stale invoke response overwrite a newer state event', () => {
    const paused = view(9, 'PAUSED');
    const current = { terminal: paused };
    expect(mergeAgentState(current, view(8, 'RUNNING'))).toBe(current);
    expect(mergeAgentState(current, view(9, 'RUNNING'))).toBe(current);
    expect(mergeAgentState(current, view(10, 'COMPLETED')).terminal.state).toBe('COMPLETED');
  });

  it('applies ordered Assistant deltas without replacing unrelated state', () => {
    const streaming = {
      ...view(3, 'THINKING'),
      streamingMessageId: 'message-1',
      streamingTurnId: 'turn-1',
      streamingSequence: 0,
      messages: [{
        id: 'message-1',
        role: 'assistant' as const,
        content: '',
        createdAt: '2026-08-20T00:00:00.000Z',
      }],
    };
    const event: AgentAssistantDelta = {
      terminalId: 'terminal',
      threadId: 'thread',
      messageId: 'message-1',
      turnId: 'turn-1',
      sequence: 1,
      delta: 'partial',
    };

    const result = mergeAgentAssistantDelta({ terminal: streaming }, event);

    expect(result.outcome).toBe('applied');
    expect(result.states.terminal.messages[0]?.content).toBe('partial');
    expect(result.states.terminal.streamingSequence).toBe(1);
  });

  it('ignores duplicate deltas and requests a snapshot for gaps or stale identity', () => {
    const streaming = {
      ...view(3, 'THINKING'),
      streamingMessageId: 'message-1',
      streamingTurnId: 'turn-1',
      streamingSequence: 1,
      messages: [{
        id: 'message-1',
        role: 'assistant' as const,
        content: 'one',
        createdAt: '2026-08-20T00:00:00.000Z',
      }],
    };
    const base = {
      terminalId: 'terminal',
      threadId: 'thread',
      messageId: 'message-1',
      turnId: 'turn-1',
      delta: 'next',
    };

    expect(mergeAgentAssistantDelta(
      { terminal: streaming },
      { ...base, sequence: 1 },
    ).outcome).toBe('ignored');
    expect(mergeAgentAssistantDelta(
      { terminal: streaming },
      { ...base, sequence: 3 },
    ).outcome).toBe('resync');
    expect(mergeAgentAssistantDelta(
      { terminal: streaming },
      { ...base, turnId: 'old-turn', sequence: 2 },
    ).outcome).toBe('resync');
  });
});
