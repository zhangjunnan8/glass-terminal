import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../shared/ipc';
import type { HostProfile } from '../shared/host';
import type { SessionRecord } from '../shared/session';
import type { CodexAppServerSnapshot } from '../shared/codex-app-server';
import { App } from './App';

vi.mock('./components/TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

vi.mock('./components/SftpDrawer', () => ({
  SftpDrawer: ({
    terminal,
    workspaceRoot,
    onSetWorkspace,
    onClose,
  }: {
    terminal: { id: string } | null;
    workspaceRoot?: string;
    onSetWorkspace?(terminalId: string, path: string): Promise<void> | void;
    onClose(): void;
  }) => (
    <aside data-testid="mock-sftp-drawer" data-workspace-root={workspaceRoot ?? ''}>
      <button
        type="button"
        data-action="mock-set-sftp-workspace"
        disabled={!onSetWorkspace}
        onClick={() => {
          if (terminal) void onSetWorkspace?.(terminal.id, '/srv/project');
        }}
      >设为工作区</button>
      <button type="button" onClick={onClose}>关闭</button>
    </aside>
  ),
}));

const now = '2026-08-15T00:00:00.000Z';

const host: HostProfile = {
  id: 'host-1',
  protocol: 'ssh',
  name: 'Ubuntu',
  hostname: '192.0.2.10',
  port: 22,
  username: 'tester',
  authMethod: 'password',
  credentialConfigured: false,
  favorite: false,
  fullTakeoverPreference: false,
  sortOrder: 0,
  createdAt: now,
  updatedAt: now,
};

const session: SessionRecord = {
  schemaVersion: 1,
  id: 'session-1',
  name: 'Old session',
  nameSource: 'automatic',
  transport: 'ssh',
  hostId: host.id,
  shellProfileId: 'shell-1',
  shellKind: 'posix',
  targetSnapshot: { label: host.name },
  connectionState: 'connected',
  status: 'active',
  runtimeTerminalId: 'terminal-1',
  pinned: false,
  preludeTruncated: false,
  droppedPreludeBytes: 0,
  startedAt: now,
  promotedAt: now,
  createdAt: now,
  updatedAt: now,
  lastConnectedAt: now,
};

function bridgeWith(rename: DesktopBridge['sessions']['rename']): DesktopBridge {
  return {
    runtime: {
      getInfo: vi.fn().mockResolvedValue({ platform: 'win32', arch: 'x64', version: 'test' }),
    },
    terminal: {
      listShells: vi.fn().mockResolvedValue([{
        id: 'shell-1',
        label: 'Shell',
        command: 'shell',
        args: [],
        kind: 'posix',
        detail: 'Test shell',
      }]),
      create: vi.fn().mockResolvedValue({
        id: 'terminal-1',
        title: session.name,
        profileId: 'shell-1',
        shellKind: 'posix',
        transport: 'ssh',
        hostId: host.id,
        sessionId: session.id,
      }),
      connectSsh: vi.fn(),
      attach: vi.fn().mockResolvedValue(''),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      readClipboardText: vi.fn().mockResolvedValue(''),
      writeClipboardText: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    },
    hosts: {
      list: vi.fn().mockResolvedValue([host]),
      save: vi.fn(),
      remove: vi.fn(),
      forgetCredential: vi.fn(),
      choosePrivateKeyPath: vi.fn().mockResolvedValue(null),
      listFolders: vi.fn().mockResolvedValue([]),
      createFolder: vi.fn(),
      renameFolder: vi.fn(),
      removeFolder: vi.fn(),
      moveFolder: vi.fn(),
      moveHost: vi.fn(),
    },
    sessions: {
      list: vi.fn().mockResolvedValue([session]),
      upgrade: vi.fn(),
      setWorkspace: vi.fn().mockResolvedValue(session),
      clearWorkspace: vi.fn().mockResolvedValue(session),
      chooseLocalWorkspace: vi.fn().mockResolvedValue(null),
      rename,
      onRenamed: vi.fn().mockReturnValue(() => undefined),
      readTerminalHistory: vi.fn(),
      readHistoryDetail: vi.fn(),
      remove: vi.fn(),
    },
    providers: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      setDefault: vi.fn(),
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
    },
    codexAppServer: {
      getState: vi.fn(() => new Promise<CodexAppServerSnapshot>(() => undefined)),
      chooseExecutable: vi.fn(),
      start: vi.fn(),
      restart: vi.fn(),
      loginBrowser: vi.fn(),
      loginDeviceCode: vi.fn(),
      reopenLogin: vi.fn(),
      cancelLogin: vi.fn(),
      logout: vi.fn(),
      refresh: vi.fn(),
      saveSelection: vi.fn(),
      setTerminalAgentEnabled: vi.fn(),
      setTerminalContextAccess: vi.fn(),
      onStateChanged: vi.fn(() => () => undefined),
    },
    agent: {
      sendPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      revisePrompt: vi.fn(),
      getState: vi.fn().mockResolvedValue(undefined),
      setFileAccess: vi.fn(),
      resolveApproval: vi.fn(),
      setFullTakeover: vi.fn(),
      setFullTakeoverPreference: vi.fn(),
      takeover: vi.fn(),
      resolveTakeover: vi.fn(),
      confirmShellReady: vi.fn(),
      onStateChanged: vi.fn(() => () => undefined),
      onAssistantDelta: vi.fn(() => () => undefined),
    },
    sftp: {} as DesktopBridge['sftp'],
    settings: {
      get: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        theme: 'dark',
        language: 'zh-CN',
        logRetentionDays: 90,
        defaultMaxRounds: 40,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }),
      update: vi.fn(),
      onChanged: vi.fn(() => () => undefined),
    },
    backup: {
      export: vi.fn().mockResolvedValue(null),
      import: vi.fn().mockResolvedValue(null),
    },
    hostBackup: {
      export: vi.fn().mockResolvedValue(null),
      import: vi.fn().mockResolvedValue(null),
    },
    settingsWindow: {
      open: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('renderer host and session dialogs', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
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

  async function renderSelectedHost(bridge: DesktopBridge) {
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const hostsActivity = container.querySelector<HTMLButtonElement>('[data-action="show-hosts"]');
    expect(hostsActivity).not.toBeNull();
    await act(async () => hostsActivity!.click());

    const hostButton = container.querySelector<HTMLButtonElement>('.host-list:not(.compact) .host-row');
    expect(hostButton).not.toBeNull();
    await act(async () => hostButton!.click());
  }

  async function openDialog(bridge: DesktopBridge) {
    await renderSelectedHost(bridge);

    const renameButton = container.querySelector<HTMLButtonElement>('[data-action="rename-session"]');
    expect(renameButton).not.toBeNull();
    await act(async () => renameButton!.click());
    return container.querySelector<HTMLFormElement>('[data-testid="rename-session-dialog"]')!;
  }

  it('rejects a blank name, trims the submitted name, refreshes the row, and updates its tab', async () => {
    const renamed = { ...session, name: 'Renamed session', nameSource: 'manual' as const };
    const rename = vi.fn().mockResolvedValue(renamed);
    const bridge = bridgeWith(rename);
    vi.mocked(bridge.sessions.list)
      .mockReset()
      .mockResolvedValueOnce([session])
      .mockResolvedValue([renamed]);
    const dialog = await openDialog(bridge);
    const input = dialog.querySelector<HTMLInputElement>('[data-testid="rename-session-input"]')!;

    await act(async () => setInputValue(input, '   '));
    await act(async () => dialog.requestSubmit());
    expect(rename).not.toHaveBeenCalled();
    expect(dialog.querySelector('[role="alert"]')?.textContent).toContain('请输入会话名称');

    await act(async () => setInputValue(input, '  Renamed session  '));
    await act(async () => dialog.requestSubmit());
    await settle();

    expect(rename).toHaveBeenCalledWith({ sessionId: session.id, name: 'Renamed session' });
    expect(container.querySelector('.session-history-name')?.textContent).toBe('Renamed session');
    expect(container.querySelector('.tab-title')?.textContent).toBe('Renamed session');
    expect(container.querySelector('[data-testid="rename-session-dialog"]')).toBeNull();
    expect(bridge.sessions.list).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog open and displays an IPC failure', async () => {
    const rename = vi.fn().mockRejectedValue(new Error('无法保存会话名称'));
    const dialog = await openDialog(bridgeWith(rename));
    const input = dialog.querySelector<HTMLInputElement>('[data-testid="rename-session-input"]')!;

    await act(async () => setInputValue(input, 'New name'));
    await act(async () => dialog.requestSubmit());
    await settle();

    expect(container.querySelector('[data-testid="rename-session-dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="rename-session-error"]')?.textContent)
      .toContain('无法保存会话名称');
  });

  it('switches the host and history activity views and collapses a selected host', async () => {
    const bridge = bridgeWith(vi.fn());
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    expect(container.querySelector('[data-sidebar-view="terminals"]')).not.toBeNull();
    const hostsActivity = container.querySelector<HTMLButtonElement>('[data-action="show-hosts"]')!;
    await act(async () => hostsActivity.click());
    expect(container.querySelector('[data-sidebar-view="hosts"]')).not.toBeNull();

    const hostButton = container.querySelector<HTMLButtonElement>(
      '[data-sidebar-view="hosts"] .host-row',
    )!;
    await act(async () => hostButton.click());
    expect(hostButton.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.selected-host-card')).not.toBeNull();
    await act(async () => hostButton.click());
    expect(hostButton.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.host-details-collapse.open')).toBeNull();
    expect(container.querySelector('.host-details-collapse')?.getAttribute('aria-hidden')).toBe('true');

    const historyActivity = container.querySelector<HTMLButtonElement>('[data-action="show-history"]')!;
    await act(async () => historyActivity.click());
    expect(container.querySelector('[data-sidebar-view="history"]')).not.toBeNull();
    expect(container.querySelector('.history-sidebar-row strong')?.textContent).toBe(session.name);
  });

  it('hides and restores the AI panel without destroying the terminal workspace', async () => {
    const bridge = bridgeWith(vi.fn());
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const shell = container.querySelector<HTMLElement>('.app-shell')!;
    expect(shell.dataset.agentPanelVisible).toBe('true');
    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-action="hide-agent-panel"]',
    )!.click());
    expect(shell.dataset.agentPanelVisible).toBe('false');
    expect(container.querySelector('.agent-panel')).toBeNull();
    expect(container.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-action="show-agent-panel"]',
    )!.click());
    expect(shell.dataset.agentPanelVisible).toBe('true');
    expect(container.querySelector('.agent-panel')).not.toBeNull();
  });

  it('sets an SSH workspace from the SFTP drawer, upserts the Session binding, and clears it', async () => {
    const bridge = bridgeWith(vi.fn());
    const withWorkspace: SessionRecord = {
      ...session,
      workspace: { backend: 'sftp', root: '/srv/project', hostId: host.id },
    };
    vi.mocked(bridge.sessions.list).mockResolvedValue([]);
    vi.mocked(bridge.sessions.setWorkspace).mockResolvedValue(withWorkspace);
    vi.mocked(bridge.sessions.clearWorkspace).mockResolvedValue({
      ...withWorkspace,
      workspace: undefined,
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const binding = container.querySelector<HTMLElement>('[data-testid="terminal-workspace-binding"]')!;
    expect(binding.textContent).toContain('未设置');
    expect(container.querySelector('.terminal-status-meta')?.textContent).toContain('临时终端');

    const choose = container.querySelector<HTMLButtonElement>('[data-action="choose-workspace"]')!;
    expect(choose.getAttribute('aria-label')).toBe('选择远程工作区');
    await act(async () => choose.click());
    const setFromSftp = container.querySelector<HTMLButtonElement>(
      '[data-action="mock-set-sftp-workspace"]',
    )!;
    await act(async () => setFromSftp.click());
    await settle();

    expect(bridge.sessions.setWorkspace).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      root: '/srv/project',
    });
    expect(binding.textContent).toContain('/srv/project');
    expect(container.querySelector('.terminal-status-meta')?.textContent).toContain('正式会话');
    expect(container.querySelector('[data-testid="mock-sftp-drawer"]')?.getAttribute(
      'data-workspace-root',
    )).toBe('/srv/project');

    await act(async () => container.querySelector<HTMLButtonElement>(
      '[data-action="clear-workspace"]',
    )!.click());
    await settle();
    expect(bridge.sessions.clearWorkspace).toHaveBeenCalledWith({ terminalId: 'terminal-1' });
    expect(binding.textContent).toContain('未设置');
  });

  it('uses the local directory chooser and leaves state unchanged when it is cancelled', async () => {
    const bridge = bridgeWith(vi.fn());
    vi.mocked(bridge.sessions.list).mockResolvedValue([]);
    vi.mocked(bridge.terminal.create).mockResolvedValue({
      id: 'terminal-1',
      title: 'PowerShell',
      profileId: 'shell-1',
      shellKind: 'powershell',
      transport: 'local',
    });
    vi.mocked(bridge.sessions.chooseLocalWorkspace).mockResolvedValue(null);
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const choose = container.querySelector<HTMLButtonElement>('[data-action="choose-workspace"]')!;
    expect(choose.getAttribute('aria-label')).toBe('选择本地工作区');
    await act(async () => choose.click());
    await settle();

    expect(bridge.sessions.chooseLocalWorkspace).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
    });
    expect(container.querySelector('[data-testid="terminal-workspace-binding"]')?.textContent)
      .toContain('未设置');
    expect(container.querySelector('.terminal-status-meta')?.textContent).toContain('临时终端');
  });

  it('requires an unsaved password and leaves credential saving unchecked by default', async () => {
    const bridge = bridgeWith(vi.fn());
    await renderSelectedHost(bridge);

    const connectButton = [...container.querySelectorAll<HTMLButtonElement>(
      '.selected-host-card button',
    )].find((button) => button.textContent === '连接');
    expect(connectButton).toBeDefined();
    await act(async () => connectButton!.click());

    const dialog = container.querySelector<HTMLFormElement>('[data-testid="ssh-connect-dialog"]');
    const password = dialog?.elements.namedItem('password') as HTMLInputElement | null;
    const saveCredential = dialog?.elements.namedItem('saveCredential') as HTMLInputElement | null;
    expect(password?.required).toBe(true);
    expect(password?.placeholder).toBe('请输入 SSH 密码');
    expect(saveCredential?.checked).toBe(false);
  });

  it('passes an entered password and saveCredential=true only after the user opts in', async () => {
    const bridge = bridgeWith(vi.fn());
    const connectedTerminal = {
      id: 'ssh-terminal-2',
      title: host.name,
      profileId: 'ssh-host-1',
      shellKind: 'posix' as const,
      transport: 'ssh' as const,
      hostId: host.id,
    };
    vi.mocked(bridge.terminal.connectSsh).mockResolvedValue({
      status: 'connected',
      terminal: connectedTerminal,
    });
    await renderSelectedHost(bridge);

    const connectButton = [...container.querySelectorAll<HTMLButtonElement>(
      '.selected-host-card button',
    )].find((button) => button.textContent === '连接')!;
    await act(async () => connectButton.click());
    const dialog = container.querySelector<HTMLFormElement>('[data-testid="ssh-connect-dialog"]')!;
    const password = dialog.elements.namedItem('password') as HTMLInputElement;
    const saveCredential = dialog.elements.namedItem('saveCredential') as HTMLInputElement;

    await act(async () => setInputValue(password, 'memory-only-password'));
    await act(async () => saveCredential.click());
    await act(async () => dialog.requestSubmit());
    await settle();

    expect(bridge.terminal.connectSsh).toHaveBeenCalledWith({
      hostId: host.id,
      sessionId: undefined,
      password: 'memory-only-password',
      passphrase: undefined,
      saveCredential: true,
      trustHostKey: undefined,
    });
  });

  it('connects a saved host immediately without reopening the password dialog', async () => {
    const savedHost = { ...host, credentialConfigured: true };
    const bridge = bridgeWith(vi.fn());
    vi.mocked(bridge.hosts.list).mockResolvedValue([savedHost]);
    vi.mocked(bridge.terminal.connectSsh).mockResolvedValue({
      status: 'connected',
      terminal: {
        id: 'ssh-terminal-saved',
        title: savedHost.name,
        profileId: 'ssh-host-1',
        shellKind: 'posix',
        transport: 'ssh',
        hostId: savedHost.id,
      },
    });
    await renderSelectedHost(bridge);

    const connectButton = [...container.querySelectorAll<HTMLButtonElement>(
      '.selected-host-card button',
    )].find((button) => button.textContent === '连接')!;
    await act(async () => connectButton.click());
    await settle();

    expect(bridge.terminal.connectSsh).toHaveBeenCalledWith({
      hostId: savedHost.id,
      sessionId: undefined,
      trustHostKey: undefined,
    });
    expect(container.querySelector('[data-testid="ssh-connect-dialog"]')).toBeNull();
  });

  it('reconnects a saved session immediately with its durable session id', async () => {
    const savedHost = { ...host, credentialConfigured: true };
    const bridge = bridgeWith(vi.fn());
    vi.mocked(bridge.hosts.list).mockResolvedValue([savedHost]);
    vi.mocked(bridge.terminal.create).mockResolvedValue({
      id: 'local-terminal',
      title: 'Shell',
      profileId: 'shell-1',
      shellKind: 'posix',
      transport: 'local',
    });
    vi.mocked(bridge.terminal.connectSsh).mockResolvedValue({
      status: 'connected',
      terminal: {
        id: 'ssh-terminal-reconnected',
        title: session.name,
        profileId: 'ssh-host-1',
        shellKind: 'posix',
        transport: 'ssh',
        hostId: savedHost.id,
        sessionId: session.id,
      },
    });
    await renderSelectedHost(bridge);

    const reconnect = container.querySelector<HTMLButtonElement>(
      `[data-action="reconnect-session"][data-session-id="${session.id}"]`,
    );
    expect(reconnect).not.toBeNull();
    await act(async () => reconnect!.click());
    await settle();

    expect(bridge.terminal.connectSsh).toHaveBeenCalledWith({
      hostId: savedHost.id,
      sessionId: session.id,
      trustHostKey: undefined,
    });
    expect(container.querySelector('[data-testid="ssh-connect-dialog"]')).toBeNull();
  });

  it('opens an already connected session instead of creating a duplicate terminal', async () => {
    const bridge = bridgeWith(vi.fn());
    await renderSelectedHost(bridge);

    const open = container.querySelector<HTMLButtonElement>(
      `[data-action="reconnect-session"][data-session-id="${session.id}"]`,
    );
    expect(open?.textContent).toBe('↗');
    await act(async () => open!.click());

    expect(bridge.terminal.connectSsh).not.toHaveBeenCalled();
  });

  it('falls back to the credential dialog when a saved credential cannot connect', async () => {
    const savedHost = { ...host, credentialConfigured: true };
    const bridge = bridgeWith(vi.fn());
    vi.mocked(bridge.hosts.list).mockResolvedValue([savedHost]);
    vi.mocked(bridge.terminal.connectSsh).mockRejectedValue(new Error('认证失败'));
    await renderSelectedHost(bridge);

    const connect = container.querySelector<HTMLButtonElement>('[data-action="connect-host"]')!;
    await act(async () => connect.click());
    await settle();

    expect(container.querySelector('[data-testid="ssh-connect-dialog"]')).not.toBeNull();
    expect(container.querySelector('.form-error')?.textContent).toContain('认证失败');
  });

  it('forgets a saved credential through the bridge and refreshes the host state', async () => {
    const savedHost = { ...host, credentialConfigured: true };
    const bridge = bridgeWith(vi.fn());
    vi.mocked(bridge.hosts.list)
      .mockReset()
      .mockResolvedValueOnce([savedHost])
      .mockResolvedValue([{ ...savedHost, credentialConfigured: false }]);
    vi.mocked(bridge.hosts.forgetCredential).mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderSelectedHost(bridge);

    const forget = container.querySelector<HTMLButtonElement>(
      '.selected-host-card [data-action="forget-host-credential"]',
    );
    expect(forget).not.toBeNull();
    await act(async () => forget!.click());
    await settle();

    expect(bridge.hosts.forgetCredential).toHaveBeenCalledWith(host.id);
    expect(bridge.hosts.list).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.host-credential-row')?.textContent).toContain('未保存');
    expect(container.querySelector('.host-credential-message[role="status"]')?.textContent)
      .toContain('已从本机密钥库删除');
  });

});
