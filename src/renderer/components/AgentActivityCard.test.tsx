import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentActivityCard } from './AgentActivityCard';

describe('AgentActivityCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows a descriptive running state with decorative repeating dots', async () => {
    const onInterrupt = vi.fn();
    await act(async () => root.render(
      <AgentActivityCard
        phase="AI 正在思考"
        backend="Codex App Server"
        context="当前终端：SSH · tester@server"
        interruptLabel="打断"
        interruptDisabled={false}
        onInterrupt={onInterrupt}
      />,
    ));

    const card = container.querySelector<HTMLElement>('[data-testid="agent-activity-card"]')!;
    const dots = container.querySelector<HTMLElement>('[data-testid="agent-activity-dots"]')!;
    expect(card.getAttribute('aria-label')).toBe('AI 运行状态');
    expect(card.textContent).toContain('AI 正在思考');
    expect(card.textContent).toContain('Codex App Server · 当前终端：SSH · tester@server');
    expect(dots.getAttribute('aria-hidden')).toBe('true');
    expect(dots.children).toHaveLength(3);
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="interrupt-agent-message"]')!.click();
    });
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
