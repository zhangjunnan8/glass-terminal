import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../shared/ipc';
import type { TransferJobSnapshot } from '../../shared/sftp';
import { SftpDrawer } from './SftpDrawer';

const transfer: TransferJobSnapshot = {
  id: 'transfer-1',
  terminalId: 'terminal-1',
  direction: 'upload',
  source: 'C:\\tmp\\demo.txt',
  destination: '/tmp/demo.txt',
  displayName: 'demo.txt',
  status: 'running',
  bytesTransferred: 512,
  totalBytes: 1_024,
  attempt: 1,
  revision: 1,
  createdAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:01.000Z',
};

function installSftpBridge() {
  const sftp: DesktopBridge['sftp'] = {
    listDirectory: vi.fn().mockResolvedValue({
      terminalId: 'terminal-1',
      path: '/',
      entries: [],
    }),
    chooseUpload: vi.fn().mockResolvedValue([]),
    chooseDownload: vi.fn().mockResolvedValue(null),
    listTransfers: vi.fn().mockResolvedValue([transfer]),
    cancelTransfer: vi.fn(),
    retryTransfer: vi.fn(),
    onTransferUpdated: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, 'aiTerminal', {
    configurable: true,
    value: { sftp } as Pick<DesktopBridge, 'sftp'>,
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SftpDrawer transfer queue', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    installSftpBridge();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('collapses and restores transfer jobs without losing the queue count', async () => {
    await act(async () => root.render(
      <SftpDrawer
        terminal={{
          id: 'terminal-1',
          title: 'Ubuntu',
          transport: 'ssh',
          status: 'connected',
        }}
        onClose={() => undefined}
      />,
    ));
    await settle();

    const toggle = container.querySelector<HTMLButtonElement>('[data-action="toggle-transfer-queue"]')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.transfer-job')?.textContent).toContain('demo.txt');

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.transfer-queue')?.getAttribute('data-collapsed')).toBe('true');
    expect(container.querySelector('.transfer-heading')?.textContent).toContain('1');
    expect(container.querySelector('.transfer-job')).toBeNull();

    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.transfer-job')?.textContent).toContain('demo.txt');
  });
});
