import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentChatItem } from '../../shared/agent';
import type { AgentMemoryCard } from '../../shared/agent-memory';
import { AgentMemoryPanel } from './AgentMemoryPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const messages: AgentChatItem[] = [{
  id: 'message-1',
  role: 'user',
  content: 'Do not push.',
  createdAt: '2026-08-21T00:00:00.000Z',
}];

const memories: AgentMemoryCard[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    category: 'constraint',
    content: 'Do not push.',
    sourceMessageIds: ['message-1'],
    pinSource: 'user-message',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    category: 'pending',
    content: 'Run the build.',
    sourceMessageIds: [],
    pinSource: 'user-created',
    createdAt: '2026-08-21T00:01:00.000Z',
    updatedAt: '2026-08-21T00:01:00.000Z',
  },
];

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function labelledButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing labelled button: ${label}`);
  return found;
}

function setValue(element: HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AgentMemoryPanel', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('shows the count, locates sources, merges edited cards, and unpins', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onSave = vi.fn(async () => {});
    const onRemove = vi.fn(async () => {});
    const onLocate = vi.fn();
    await act(async () => root?.render(
      <AgentMemoryPanel
        memories={memories}
        messages={messages}
        onSave={onSave}
        onRemove={onRemove}
        onLocate={onLocate}
      />,
    ));

    expect(labelledButton(container, '上下文记忆，2 条').title).toBe('上下文记忆：2 条');
    await act(async () => labelledButton(container!, '上下文记忆，2 条').click());
    expect(container.textContent).toContain('当前 AI 对话专属');
    expect(container.textContent).toContain('不受自动摘要清理');
    await act(async () => labelledButton(container!, '定位来源消息').click());
    expect(onLocate).toHaveBeenCalledWith('message-1');

    const firstCard = container.querySelector<HTMLElement>(
      '[data-memory-id="00000000-0000-4000-8000-000000000001"]',
    )!;
    await act(async () => labelledButton(firstCard, '编辑或合并记忆').click());
    const merge = container.querySelector<HTMLInputElement>('fieldset input')!;
    await act(async () => merge.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => setValue(textarea, 'Do not push; run the build.'));
    await act(async () => button(container!, '保存记忆').click());

    expect(onSave).toHaveBeenCalledWith({
      memoryId: memories[0]!.id,
      category: 'constraint',
      content: 'Do not push; run the build.',
      sourceMessageIds: ['message-1'],
      mergeMemoryIds: [memories[1]!.id],
    });
    await act(async () => labelledButton(firstCard, '取消 Pin').click());
    expect(onRemove).toHaveBeenCalledWith(memories[0]!.id);
  });

  it('requires an overlong source message to be shortened before saving', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onSave = vi.fn(async () => {});
    const onDraftConsumed = vi.fn();
    await act(async () => root?.render(
      <AgentMemoryPanel
        memories={[]}
        messages={messages}
        draftSource={{ id: 'message-1', content: '长'.repeat(900) }}
        onDraftConsumed={onDraftConsumed}
        onSave={onSave}
        onRemove={async () => {}}
        onLocate={() => {}}
      />,
    ));

    expect(onDraftConsumed).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.value).toHaveLength(800);
    expect(container.textContent).toContain('原消息过长');
    await act(async () => button(container!, '保存记忆').click());
    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('请先编辑并提炼');

    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => setValue(textarea, '提炼后的短记忆'));
    await act(async () => button(container!, '保存记忆').click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      content: '提炼后的短记忆',
      sourceMessageIds: ['message-1'],
    }));
  });

  it('blocks an apparent credential without calling the persistence bridge', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const onSave = vi.fn(async () => {});
    await act(async () => root?.render(
      <AgentMemoryPanel
        memories={[]}
        messages={messages}
        onSave={onSave}
        onRemove={async () => {}}
        onLocate={() => {}}
      />,
    ));

    await act(async () => labelledButton(container!, '上下文记忆，0 条').click());
    await act(async () => labelledButton(container!, '新建记忆').click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => setValue(textarea, 'api_key=super-secret-value'));
    await act(async () => button(container!, '保存记忆').click());

    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('不能保存');
  });
});
