import { describe, expect, it } from 'vitest';
import type { AgentSessionView } from '../shared/agent';
import { mergeAgentState } from './agent-state';

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
});
