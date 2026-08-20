import type { AgentAssistantDelta, AgentSessionView } from '../shared/agent';

export interface AgentDeltaMergeResult {
  states: Record<string, AgentSessionView>;
  outcome: 'applied' | 'ignored' | 'resync';
}

export function mergeAgentState(
  current: Record<string, AgentSessionView>,
  incoming: AgentSessionView,
): Record<string, AgentSessionView> {
  const prior = current[incoming.terminalId];
  if (prior && prior.revision >= incoming.revision) return current;
  return { ...current, [incoming.terminalId]: incoming };
}

export function mergeAgentAssistantDelta(
  current: Record<string, AgentSessionView>,
  event: AgentAssistantDelta,
): AgentDeltaMergeResult {
  const prior = current[event.terminalId];
  if (
    !prior
    || prior.threadId !== event.threadId
    || prior.streamingMessageId !== event.messageId
    || prior.streamingTurnId !== event.turnId
  ) return { states: current, outcome: 'resync' };

  const previousSequence = prior.streamingSequence ?? 0;
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    return { states: current, outcome: 'resync' };
  }
  if (event.sequence <= previousSequence) {
    return { states: current, outcome: 'ignored' };
  }
  if (event.sequence !== previousSequence + 1 || !event.delta) {
    return { states: current, outcome: 'resync' };
  }
  const messageIndex = prior.messages.findIndex((message) => message.id === event.messageId);
  if (messageIndex < 0) return { states: current, outcome: 'resync' };

  const messages = [...prior.messages];
  const message = messages[messageIndex]!;
  messages[messageIndex] = { ...message, content: `${message.content}${event.delta}` };
  return {
    states: {
      ...current,
      [event.terminalId]: {
        ...prior,
        messages,
        streamingSequence: event.sequence,
      },
    },
    outcome: 'applied',
  };
}
