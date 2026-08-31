import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentReviewModePicker } from './AgentReviewModePicker';

describe('AgentReviewModePicker', () => {
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

  it('offers the three review modes from one compact selector', async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(
      <AgentReviewModePicker value="all" onSelect={onSelect} />,
    ));

    const picker = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-review-mode-picker"]',
    )!;
    expect([...picker.options].map((option) => [option.value, option.text])).toEqual([
      ['all', '全部审核'],
      ['risky', '风险审核'],
      ['complete', '完全访问'],
    ]);

    picker.value = 'risky';
    await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith('risky');
  });

  it('keeps Complete Access visually distinct', async () => {
    await act(async () => root.render(
      <AgentReviewModePicker value="complete" onSelect={() => undefined} />,
    ));
    expect(container.querySelector('.agent-review-picker')?.classList)
      .toContain('complete-access');
  });
});
