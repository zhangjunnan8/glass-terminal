import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentToolActivity } from '../../shared/agent';
import { AgentTurnProcess } from './AgentTurnProcess';

const activity: AgentToolActivity = {
  id: 'activity-1',
  turnId: 'turn-1',
  toolName: 'file_read',
  kind: 'workspace',
  label: '读取文件',
  status: 'running',
  startedAt: '2026-08-31T00:00:00.000Z',
};

describe('AgentTurnProcess', () => {
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

  it('shows the live process and tools, then collapses only after the final summary arrives', async () => {
    await act(async () => root.render(
      <AgentTurnProcess completed={false} stageCount={1} activities={[activity]}>
        <p>正在分析</p>
      </AgentTurnProcess>,
    ));

    const process = container.querySelector<HTMLDetailsElement>('.agent-turn-process')!;
    expect(process.open).toBe(true);
    expect(process.getAttribute('data-completed')).toBe('false');
    expect(process.textContent).toContain('正在分析');
    expect(process.querySelector('[data-testid="tool-activity-list"]')
      ?.getAttribute('data-expanded')).toBe('true');

    await act(async () => root.render(
      <AgentTurnProcess completed stageCount={1} activities={[{ ...activity, status: 'succeeded' }]}>
        <p>已完成分析</p>
      </AgentTurnProcess>,
    ));

    expect(process.open).toBe(false);
    expect(process.getAttribute('data-completed')).toBe('true');
  });
});
