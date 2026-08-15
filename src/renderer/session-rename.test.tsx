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
  SftpDrawer: () => null,
}));

const now = '2026-08-15T00:00:00.000Z';

const host: HostProfile = {
  id: 'host-1',
  name: 'Ubuntu',
  hostname: '192.0.2.10',
  port: 22,
  username: 'tester',
  authMethod: 'password',
  credentialConfigured: false,
  favorite: false,
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
      onData: vi.fn(() => () => undefined),
      onExit: vi.fn(() => () => undefined),
    },
    hosts: {
      list: vi.fn().mockResolvedValue([host]),
      save: vi.fn(),
      remove: vi.fn(),
      forgetCredential: vi.fn(),
    },
    sessions: {
      list: vi.fn().mockResolvedValue([session]),
      upgrade: vi.fn(),
      rename,
      readTerminalHistory: vi.fn(),
    },
    providers: {
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      setDefault: vi.fn(),
      testConnection: vi.fn(),
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
      onStateChanged: vi.fn(() => () => undefined),
    },
    agent: {
      sendPrompt: vi.fn(),
      getState: vi.fn().mockResolvedValue(undefined),
      resolveApproval: vi.fn(),
      setFullTakeover: vi.fn(),
      takeover: vi.fn(),
      resolveTakeover: vi.fn(),
      confirmShellReady: vi.fn(),
      onStateChanged: vi.fn(() => () => undefined),
    },
    sftp: {} as DesktopBridge['sftp'],
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
    expect(container.querySelector('.session-history-row strong')?.textContent).toBe('Renamed session');
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

});
