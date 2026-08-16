import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../shared/ipc';
import type { SessionHistoryDetail, SessionRecord } from '../../shared/session';
import { SessionHistoryDialog } from './SessionHistoryDialog';

const session: SessionRecord = {
  schemaVersion: 1,
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Deployment repair',
  nameSource: 'manual',
  transport: 'ssh',
  hostId: 'host-1',
  shellProfileId: 'ssh:host-1',
  shellKind: 'posix',
  targetSnapshot: { label: 'Ubuntu', username: 'zjn' },
  connectionState: 'disconnected',
  status: 'disconnected',
  runtimeTerminalId: 'terminal-1',
  cwd: '/srv/app',
  effectiveUser: 'zjn',
  pinned: false,
  preludeTruncated: false,
  droppedPreludeBytes: 0,
  startedAt: '2026-08-16T00:00:00.000Z',
  promotedAt: '2026-08-16T00:00:01.000Z',
  createdAt: '2026-08-16T00:00:01.000Z',
  updatedAt: '2026-08-16T00:10:00.000Z',
  lastConnectedAt: '2026-08-16T00:00:01.000Z',
};

const detail: SessionHistoryDetail = {
  session,
  terminal: { content: 'npm test\nall passed', truncated: false },
  conversation: {
    truncated: false,
    messages: [{
      id: 'message-1',
      role: 'user',
      content: 'repair the deployment',
      createdAt: '2026-08-16T00:02:00.000Z',
    }],
  },
};

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('SessionHistoryDialog', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows bounded terminal and conversation content and deletes with exact guards', async () => {
    const readHistoryDetail = vi.fn().mockResolvedValue(detail);
    const remove = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'aiTerminal', {
      configurable: true,
      value: { sessions: { readHistoryDetail, remove } } as unknown as DesktopBridge,
    });
    const onDeleted = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    await act(async () => root.render(
      <SessionHistoryDialog
        session={session}
        onClose={vi.fn()}
        onDeleted={onDeleted}
        onError={vi.fn()}
      />,
    ));
    await settle();

    expect(readHistoryDetail).toHaveBeenCalledWith({ sessionId: session.id });
    expect(container.querySelector('[data-testid="session-conversation-preview"]')?.textContent)
      .toContain('repair the deployment');
    expect(container.querySelector('[data-testid="session-terminal-preview"]')?.textContent)
      .toContain('all passed');

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-action="delete-session"]',
    )!.click());
    await settle();

    expect(remove).toHaveBeenCalledWith({
      sessionId: session.id,
      expectedUpdatedAt: session.updatedAt,
      expectedRuntimeTerminalId: session.runtimeTerminalId,
    });
    expect(onDeleted).toHaveBeenCalledWith(session.id);
  });

  it('keeps deletion disabled for an active Session returned by the main process', async () => {
    const activeDetail = {
      ...detail,
      session: { ...session, status: 'active' as const, connectionState: 'connected' as const },
    };
    const remove = vi.fn();
    Object.defineProperty(window, 'aiTerminal', {
      configurable: true,
      value: {
        sessions: {
          readHistoryDetail: vi.fn().mockResolvedValue(activeDetail),
          remove,
        },
      } as unknown as DesktopBridge,
    });

    await act(async () => root.render(
      <SessionHistoryDialog
        session={session}
        onClose={vi.fn()}
        onDeleted={vi.fn()}
        onError={vi.fn()}
      />,
    ));
    await settle();

    expect(container.querySelector<HTMLButtonElement>('[data-action="delete-session"]')?.disabled)
      .toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });
});
