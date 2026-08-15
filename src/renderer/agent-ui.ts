export const MIN_AGENT_PANEL_WIDTH = 300;
export const MAX_AGENT_PANEL_WIDTH = 720;

export function clampAgentPanelWidth(requested: number, viewportWidth: number): number {
  const sidebarWidth = viewportWidth <= 1160 ? 220 : 280;
  const minimumWorkspaceWidth = viewportWidth <= 1160 ? 340 : 420;
  const available = viewportWidth - 52 - sidebarWidth - minimumWorkspaceWidth;
  const responsiveMaximum = Math.max(
    MIN_AGENT_PANEL_WIDTH,
    Math.min(MAX_AGENT_PANEL_WIDTH, available),
  );
  return Math.round(Math.max(MIN_AGENT_PANEL_WIDTH, Math.min(requested, responsiveMaximum)));
}

export interface AgentComposerKey {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

export function shouldSubmitAgentComposer(event: AgentComposerKey): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}
