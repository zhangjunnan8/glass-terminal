import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../shared/ipc';
import type { SftpDirectoryListing, TransferJobSnapshot } from '../../shared/sftp';
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
  return sftp;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  it('sets the current remote directory as workspace and marks the selected root', async () => {
    const onSetWorkspace = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(
      <SftpDrawer
        terminal={{
          id: 'terminal-1',
          title: 'Ubuntu',
          transport: 'ssh',
          status: 'connected',
        }}
        workspaceRoot="/work"
        onSetWorkspace={onSetWorkspace}
        onClose={() => undefined}
      />,
    ));
    await settle();

    const button = container.querySelector<HTMLButtonElement>('.sftp-workspace')!;
    expect(button.textContent).toBe('设为工作区');
    await act(async () => button.click());
    await settle();
    expect(onSetWorkspace).toHaveBeenCalledWith('terminal-1', '/');

    await act(async () => root.render(
      <SftpDrawer
        terminal={{
          id: 'terminal-1',
          title: 'Ubuntu',
          transport: 'ssh',
          status: 'connected',
        }}
        workspaceRoot="/"
        onSetWorkspace={onSetWorkspace}
        onClose={() => undefined}
      />,
    ));
    expect(button.textContent).toBe('当前工作区');
    expect(button.disabled).toBe(true);
  });

  it('shows workspace callback failures in the existing drawer error area', async () => {
    const onSetWorkspace = vi.fn().mockRejectedValue(new Error('保存工作区失败'));
    await act(async () => root.render(
      <SftpDrawer
        terminal={{
          id: 'terminal-1',
          title: 'Ubuntu',
          transport: 'ssh',
          status: 'connected',
        }}
        onSetWorkspace={onSetWorkspace}
        onClose={() => undefined}
      />,
    ));
    await settle();

    await act(async () => container.querySelector<HTMLButtonElement>('.sftp-workspace')!.click());
    await settle();
    expect(container.querySelector('.sftp-error')?.textContent).toContain('保存工作区失败');
  });

  it('ignores a late directory response from the previous terminal', async () => {
    const terminalAListing = deferred<SftpDirectoryListing>();
    const terminalBListing = deferred<SftpDirectoryListing>();
    const listDirectory = vi.mocked(window.aiTerminal.sftp.listDirectory);
    listDirectory.mockImplementation((terminalId) => {
      if (terminalId === 'terminal-a') return terminalAListing.promise;
      if (terminalId === 'terminal-b') return terminalBListing.promise;
      throw new Error(`Unexpected terminal ${terminalId}`);
    });
    vi.mocked(window.aiTerminal.sftp.listTransfers).mockResolvedValue([]);
    const onSetWorkspace = vi.fn().mockResolvedValue(undefined);

    await act(async () => root.render(
      <SftpDrawer
        terminal={{
          id: 'terminal-a',
          title: 'Host A',
          transport: 'ssh',
          status: 'connected',
        }}
        onSetWorkspace={onSetWorkspace}
        onClose={() => undefined}
      />,
    ));
    expect(listDirectory).toHaveBeenCalledWith('terminal-a', undefined);

    await act(async () => root.render(
      <SftpDrawer
        terminal={{
          id: 'terminal-b',
          title: 'Host B',
          transport: 'ssh',
          status: 'connected',
        }}
        onSetWorkspace={onSetWorkspace}
        onClose={() => undefined}
      />,
    ));
    expect(listDirectory).toHaveBeenCalledWith('terminal-b', undefined);

    await act(async () => {
      terminalBListing.resolve({
        terminalId: 'terminal-b',
        path: '/srv/b',
        entries: [{
          name: 'from-b.txt',
          path: '/srv/b/from-b.txt',
          type: 'file',
          size: 12,
          modifiedAt: '2026-08-16T00:00:00.000Z',
          mode: 0o644,
        }],
      });
      await terminalBListing.promise;
    });
    expect(container.querySelector<HTMLInputElement>('[aria-label="远程目录"]')?.value).toBe('/srv/b');
    expect(container.querySelector('.sftp-entry')?.textContent).toContain('from-b.txt');
    expect(container.querySelector('.sftp-loading')).toBeNull();

    await act(async () => {
      terminalAListing.resolve({
        terminalId: 'terminal-a',
        path: '/srv/a',
        entries: [{
          name: 'late-from-a.txt',
          path: '/srv/a/late-from-a.txt',
          type: 'file',
          size: 24,
          modifiedAt: '2026-08-16T00:00:00.000Z',
          mode: 0o644,
        }],
      });
      await terminalAListing.promise;
    });
    expect(container.querySelector<HTMLInputElement>('[aria-label="远程目录"]')?.value).toBe('/srv/b');
    expect(container.querySelector('.sftp-entry')?.textContent).toContain('from-b.txt');
    expect(container.textContent).not.toContain('late-from-a.txt');
    expect(container.querySelector('.sftp-error')).toBeNull();
    expect(container.querySelector('.sftp-loading')).toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>('.sftp-workspace')!.click());
    await settle();
    expect(onSetWorkspace).toHaveBeenCalledWith('terminal-b', '/srv/b');
    expect(onSetWorkspace).not.toHaveBeenCalledWith('terminal-b', '/srv/a');
  });
});
