import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostFolder, HostProfile } from '../shared/host';
import type { DesktopBridge } from '../shared/ipc';
import type { SessionRecord } from '../shared/session';
import { App } from './App';

vi.mock('./components/TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

vi.mock('./components/SftpDrawer', () => ({
  SftpDrawer: () => null,
}));

const now = '2026-08-15T00:00:00.000Z';
const folder: HostFolder = {
  id: 'folder-1',
  name: '生产环境',
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
};
const groupedHost: HostProfile = {
  id: 'host-1',
  protocol: 'ssh',
  name: 'Ubuntu 主机',
  hostname: '192.0.2.10',
  port: 22,
  username: 'tester',
  authMethod: 'password',
  folderId: folder.id,
  sortOrder: 0,
  favorite: false,
  fullTakeoverPreference: false,
  credentialConfigured: false,
  createdAt: now,
  updatedAt: now,
};
const ungroupedHost: HostProfile = {
  ...groupedHost,
  id: 'host-2',
  name: '根级主机',
  hostname: '192.0.2.20',
  folderId: undefined,
};
const session: SessionRecord = {
  schemaVersion: 1,
  id: 'session-1',
  name: '生产会话',
  nameSource: 'manual',
  transport: 'ssh',
  hostId: groupedHost.id,
  shellProfileId: 'shell-1',
  shellKind: 'posix',
  targetSnapshot: { label: groupedHost.name },
  connectionState: 'disconnected',
  status: 'disconnected',
  runtimeTerminalId: 'old-terminal-1',
  pinned: false,
  preludeTruncated: false,
  droppedPreludeBytes: 0,
  startedAt: now,
  promotedAt: now,
  createdAt: now,
  updatedAt: now,
  lastConnectedAt: now,
};

function hostBridge() {
  const bridge = {
    runtime: {
      getInfo: vi.fn().mockResolvedValue({ platform: 'win32', arch: 'x64', version: 'test' }),
    },
    terminal: {
      listShells: vi.fn().mockResolvedValue([{
        id: 'shell-1',
        label: 'PowerShell',
        command: 'pwsh',
        args: [],
        kind: 'powershell',
        detail: 'Test shell',
      }]),
      create: vi.fn().mockResolvedValue({
        id: 'terminal-1',
        title: 'PowerShell',
        profileId: 'shell-1',
        shellKind: 'powershell',
        transport: 'local',
      }),
      close: vi.fn().mockResolvedValue(undefined),
      onExit: vi.fn(() => () => undefined),
    },
    hosts: {
      list: vi.fn().mockResolvedValue([groupedHost, ungroupedHost]),
      listFolders: vi.fn().mockResolvedValue([folder]),
      save: vi.fn(),
      remove: vi.fn(),
      forgetCredential: vi.fn(),
      choosePrivateKeyPath: vi.fn().mockResolvedValue(null),
      createFolder: vi.fn().mockResolvedValue({ ...folder, id: 'folder-2', name: '测试环境' }),
      renameFolder: vi.fn().mockResolvedValue(folder),
      removeFolder: vi.fn().mockResolvedValue(undefined),
      moveFolder: vi.fn().mockResolvedValue([folder]),
      moveHost: vi.fn().mockResolvedValue(groupedHost),
    },
    sessions: {
      list: vi.fn().mockResolvedValue([session]),
      onRenamed: vi.fn(() => () => undefined),
    },
    providers: {
      list: vi.fn().mockResolvedValue([]),
    },
    codexAppServer: {
      getState: vi.fn(() => new Promise(() => undefined)),
      onStateChanged: vi.fn(() => () => undefined),
    },
    agent: {
      getState: vi.fn().mockResolvedValue(undefined),
      setFullTakeoverPreference: vi.fn(),
      onStateChanged: vi.fn(() => () => undefined),
      onAssistantDelta: vi.fn(() => () => undefined),
    },
    hostBackup: {
      export: vi.fn().mockResolvedValue(null),
      import: vi.fn().mockResolvedValue(null),
    },
    sftp: {},
  } as unknown as DesktopBridge;
  return bridge;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function dragEvent(type: string) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
    },
  });
  return event;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('主机分组与协议界面', () => {
  let container: HTMLDivElement;
  let root: Root;
  let bridge: DesktopBridge;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    bridge = hostBridge();
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function openHosts() {
    await act(async () => root.render(<App />));
    await settle();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="show-hosts"]')!.click();
    });
  }

  it('按文件夹显示主机，并在对应主机正下方展开会话详情', async () => {
    await openHosts();

    expect(container.querySelector('[data-folder-id="folder-1"]')?.textContent).toContain('生产环境');
    expect(container.querySelector('[data-folder-id="ungrouped"]')).toBeNull();
    const hostTree = container.querySelector<HTMLElement>('[data-testid="host-tree"]')!;
    expect(container.querySelector('[data-host-id="host-2"]')?.parentElement).toBe(hostTree);
    const item = container.querySelector<HTMLElement>('[data-host-id="host-1"]')!;
    const details = item.querySelector<HTMLElement>('[data-testid="host-details-host-1"]')!;
    expect(details.classList.contains('open')).toBe(false);

    await act(async () => item.querySelector<HTMLButtonElement>('.host-row')!.click());

    expect(details.classList.contains('open')).toBe(true);
    expect(details.textContent).toContain('生产会话');
    expect(details.parentElement).toBe(item);
  });

  it('通过受控对话框新建文件夹', async () => {
    await openHosts();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="create-host-folder"]')!.click();
    });
    const dialog = container.querySelector<HTMLFormElement>('[data-testid="host-folder-dialog"]')!;
    const input = dialog.querySelector<HTMLInputElement>('input')!;
    await act(async () => setInputValue(input, '测试环境'));
    await act(async () => dialog.requestSubmit());
    await settle();

    expect(bridge.hosts.createFolder).toHaveBeenCalledWith({ name: '测试环境' });
    expect(container.querySelector('[data-testid="host-folder-dialog"]')).toBeNull();
  });

  it('只允许从右侧握柄启动拖拽，可将主机移到未分组', async () => {
    await openHosts();
    const item = container.querySelector<HTMLElement>('[data-host-id="host-1"]')!;
    const row = item.querySelector<HTMLButtonElement>('.host-row')!;
    const handle = item.querySelector<HTMLElement>('[data-action="drag-host"]')!;
    expect(row.draggable).toBe(false);
    expect(handle.draggable).toBe(true);

    await act(async () => handle.dispatchEvent(dragEvent('dragstart')));
    await act(async () => {
      container.querySelector<HTMLElement>('[data-drop-zone="host-root"]')!
        .dispatchEvent(dragEvent('drop'));
    });
    await settle();

    expect(bridge.hosts.moveHost).toHaveBeenCalledWith({
      hostId: groupedHost.id,
      folderId: null,
      beforeHostId: null,
    });
  });

  it('在主机拖拽失败时显示当前工作区错误', async () => {
    bridge.hosts.moveHost = vi.fn().mockRejectedValue(new Error('无法保存主机排序'));
    await openHosts();
    const item = container.querySelector<HTMLElement>('[data-host-id="host-1"]')!;
    await act(async () => {
      item.querySelector<HTMLElement>('[data-action="drag-host"]')!
        .dispatchEvent(dragEvent('dragstart'));
    });
    await act(async () => {
      container.querySelector<HTMLElement>('[data-drop-zone="host-root"]')!
        .dispatchEvent(dragEvent('drop'));
    });
    await settle();

    expect(container.querySelector('[data-testid="workspace-action-error"]')?.textContent)
      .toContain('无法保存主机排序');
  });

  it('删除主机时立即更新列表，成功后不再重新拉取全部主机', async () => {
    const removal = deferred<void>();
    vi.mocked(bridge.hosts.remove).mockReturnValue(removal.promise);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openHosts();
    const item = container.querySelector<HTMLElement>('[data-host-id="host-1"]')!;
    await act(async () => item.querySelector<HTMLButtonElement>('.host-row')!.click());

    await act(async () => {
      item.querySelector<HTMLButtonElement>('.selected-host-card .icon-btn.danger')!.click();
    });

    expect(bridge.hosts.remove).toHaveBeenCalledWith(groupedHost.id);
    expect(container.querySelector('[data-host-id="host-1"]')).toBeNull();
    expect(bridge.hosts.list).toHaveBeenCalledTimes(1);

    removal.resolve();
    await settle();
    expect(bridge.hosts.list).toHaveBeenCalledTimes(1);
  });

  it('主机删除失败时从权威存储恢复列表并显示错误', async () => {
    vi.mocked(bridge.hosts.remove).mockRejectedValue(new Error('无法写入主机配置'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await openHosts();
    const item = container.querySelector<HTMLElement>('[data-host-id="host-1"]')!;
    await act(async () => item.querySelector<HTMLButtonElement>('.host-row')!.click());
    await act(async () => {
      item.querySelector<HTMLButtonElement>('.selected-host-card .icon-btn.danger')!.click();
    });
    await settle();

    expect(container.querySelector('[data-host-id="host-1"]')).not.toBeNull();
    expect(bridge.hosts.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="workspace-action-error"]')?.textContent)
      .toContain('无法写入主机配置');
  });

  it('在新建主机对话框显示协议标签，未接入协议禁止保存', async () => {
    await openHosts();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="添加主机"]')!.click();
    });
    const modal = container.querySelector<HTMLElement>('.host-editor-modal')!;
    expect(modal.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(modal.querySelector<HTMLSelectElement>('select[name="folderId"]')?.options)
      .toHaveLength(2);

    await act(async () => {
      modal.querySelector<HTMLButtonElement>('[data-protocol="vnc"]')!.click();
    });
    expect(modal.textContent).toContain('VNC 尚未接入');
    expect(modal.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it('主机备份默认不包含凭据，包含凭据时必须提供匹配口令', async () => {
    await openHosts();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="导出主机配置"]')!.click();
    });
    let dialog = container.querySelector<HTMLElement>('[data-testid="host-backup-export-dialog"]')!;
    const checkbox = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.checked).toBe(false);
    expect(dialog.querySelectorAll('input[type="password"]')).toHaveLength(0);

    await act(async () => [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === '选择保存位置…')!.click());
    await settle();
    expect(bridge.hostBackup.export).toHaveBeenCalledWith({ includeCredentials: false });

    vi.mocked(bridge.hostBackup.export).mockClear();
    await act(async () => checkbox.click());
    dialog = container.querySelector<HTMLElement>('[data-testid="host-backup-export-dialog"]')!;
    const passwords = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await act(async () => {
      setInputValue(passwords[0]!, 'host backup password');
      setInputValue(passwords[1]!, 'host backup password');
    });
    await act(async () => [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === '选择保存位置…')!.click());
    await settle();

    expect(bridge.hostBackup.export).toHaveBeenCalledWith({
      includeCredentials: true,
      passphrase: 'host backup password',
      passphraseConfirmation: 'host backup password',
    });
  });

  it('导入旧版明文凭据备份时，使用绑定令牌请求明确风险确认', async () => {
    vi.mocked(bridge.hostBackup.import)
      .mockResolvedValueOnce({
        challenge: 'legacy-plaintext-confirmation',
        token: 'legacy-host-token',
        message: '旧版备份中的 SSH 凭据未加密。',
      })
      .mockResolvedValueOnce({
        sectionsImported: ['hosts', 'hostSecrets'],
        sectionsSkipped: [],
        needsRestart: false,
      });
    await openHosts();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[title="导入主机配置"]')!.click();
    });
    await settle();

    const dialog = container.querySelector<HTMLElement>(
      '[data-testid="host-backup-import-challenge"]',
    )!;
    expect(dialog.textContent).toContain('旧版明文主机备份风险确认');
    expect(dialog.textContent).toContain('SSH 凭据未加密');
    await act(async () => [...dialog.querySelectorAll('button')]
      .find((button) => button.textContent === '确认风险并导入')!.click());
    await settle();

    expect(bridge.hostBackup.import).toHaveBeenNthCalledWith(1);
    expect(bridge.hostBackup.import).toHaveBeenNthCalledWith(2, {
      token: 'legacy-host-token',
      confirmLegacyPlaintext: true,
    });
  });
});
