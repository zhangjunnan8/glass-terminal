export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export const AGENT_FOLLOW_THRESHOLD_PX = 32;

export function isAgentOutputNearBottom(
  metrics: ScrollMetrics,
  threshold = AGENT_FOLLOW_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function scrollAgentOutputToBottom(
  element: Pick<HTMLElement, 'scrollTop' | 'scrollHeight'>,
): void {
  element.scrollTop = element.scrollHeight;
}
