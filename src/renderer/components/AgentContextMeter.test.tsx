import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentContextMeter } from './AgentContextMeter';

describe('AgentContextMeter', () => {
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
  });

  it('renders a circular threshold progress indicator', () => {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<AgentContextMeter usage={{
      estimatedTokens: 27_200,
      messageEstimatedTokens: 20_000,
      toolSchemaEstimatedTokens: 3_600,
      fixedOverheadTokens: 52,
      safetyFactor: 1.15,
      boundToolCount: 8,
      providerReportedInputTokens: 19_800,
      contextWindowTokens: 64_000,
      compressionThresholdTokens: 54_400,
      percentage: 50,
      status: 'ready',
    }} />));

    const meter = container.querySelector('[data-testid="agent-context-meter"]');
    const progress = container.querySelector('[role="progressbar"]');
    expect(meter?.getAttribute('data-context-status')).toBe('ready');
    expect(progress?.getAttribute('aria-valuenow')).toBe('50');
    expect(container.querySelector('.agent-context-ring-value')?.getAttribute('stroke-dasharray'))
      .toBe('50 100');
    expect(container.textContent).toContain('27k / 54k');
    expect(meter?.getAttribute('title')).toContain('上下文估算值 27,200');
    expect(meter?.getAttribute('title')).toContain('消息估算 20,000');
    expect(meter?.getAttribute('title')).toContain('工具 Schema 估算 3,600 tokens（8 个工具）');
    expect(meter?.getAttribute('title')).toContain('估算安全系数 ×1.15');
    expect(meter?.getAttribute('title')).toContain('模型窗口 64,000');
    expect(meter?.getAttribute('title')).toContain('仅诊断');
    act(() => root.unmount());
  });

  it('shows the automatic compression state at a full threshold', () => {
    container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<AgentContextMeter usage={{
      estimatedTokens: 55_000,
      contextWindowTokens: 64_000,
      compressionThresholdTokens: 54_400,
      percentage: 100,
      status: 'compressing',
    }} />));

    expect(container.querySelector('[data-context-status="compressing"]')).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-label'))
      .toBe('正在压缩上下文');
    expect(container.textContent).toContain('正在压缩上下文');
    act(() => root.unmount());
  });
});
