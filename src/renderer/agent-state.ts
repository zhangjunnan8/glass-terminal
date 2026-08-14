import type { AgentSessionView } from '../shared/agent';

export function mergeAgentState(
  current: Record<string, AgentSessionView>,
  incoming: AgentSessionView,
): Record<string, AgentSessionView> {
  const prior = current[incoming.terminalId];
  if (prior && prior.revision >= incoming.revision) return current;
  return { ...current, [incoming.terminalId]: incoming };
}
