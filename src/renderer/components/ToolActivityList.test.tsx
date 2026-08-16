import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToolActivity } from '../../shared/agent';
import { ToolActivityList } from './ToolActivityList';

const statuses: AgentToolActivity['status'][] = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
];

function activity(index: number): AgentToolActivity {
  return {
    id: `activity-${index}`,
    toolName: `private-tool-name-${index}`,
    kind: index % 2 === 0 ? 'workspace' : 'terminal',
    label: `工具活动 ${index}`,
    status: statuses[index % statuses.length]!,
    startedAt: `2026-08-16T00:00:${String(index).padStart(2, '0')}.000Z`,
    finishedAt: `2026-08-16T00:01:${String(index).padStart(2, '0')}.000Z`,
    summary: `安全摘要 ${index}`,
  };
}

describe('ToolActivityList', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('shows only the eight most recent metadata summaries with accessible statuses', async () => {
    await act(async () => root.render(
      <ToolActivityList activities={Array.from({ length: 10 }, (_, index) => activity(index))} />,
    ));

    const list = container.querySelector('[data-testid="tool-activity-list"]');
    expect(list?.getAttribute('aria-label')).toBe('工具活动');
    expect(list?.querySelectorAll('li')).toHaveLength(8);
    expect(list?.textContent).not.toContain('工具活动 0');
    expect(list?.textContent).not.toContain('工具活动 1');
    expect(list?.textContent).toContain('工具活动 2');
    expect(list?.textContent).toContain('工具活动 9');
    expect(list?.textContent).toContain('安全摘要 9');
    expect(list?.textContent).toContain('状态：运行中');
    expect(list?.textContent).toContain('状态：已完成');
    expect(list?.textContent).toContain('状态：失败');
    expect(list?.textContent).toContain('状态：已取消');
    expect(list?.textContent).not.toContain('private-tool-name');
  });

  it('renders nothing for an empty activity list', async () => {
    await act(async () => root.render(<ToolActivityList activities={[]} />));
    expect(container.innerHTML).toBe('');
  });
});
