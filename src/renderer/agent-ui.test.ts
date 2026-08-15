import { describe, expect, it } from 'vitest';
import {
  MAX_AGENT_PANEL_WIDTH,
  MIN_AGENT_PANEL_WIDTH,
  clampAgentPanelWidth,
  shouldSubmitAgentComposer,
} from './agent-ui';

describe('agent pane interactions', () => {
  it('keeps the draggable panel readable without squeezing the workspace', () => {
    expect(clampAgentPanelWidth(120, 1920)).toBe(MIN_AGENT_PANEL_WIDTH);
    expect(clampAgentPanelWidth(900, 1920)).toBe(MAX_AGENT_PANEL_WIDTH);
    expect(clampAgentPanelWidth(500, 980)).toBe(368);
  });

  it('sends on Enter while preserving Shift+Enter and IME composition', () => {
    expect(shouldSubmitAgentComposer({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitAgentComposer({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitAgentComposer({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(shouldSubmitAgentComposer({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
  });
});
