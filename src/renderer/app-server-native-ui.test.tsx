import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_APP_SERVER_AGENT_BACKEND } from '../shared/agent';
import type { CodexAppServerSnapshot } from '../shared/codex-app-server';
import type { DesktopBridge } from '../shared/ipc';
import type { ProviderProfile } from '../shared/provider';
import { App } from './App';

vi.mock('./components/TerminalPane', () => ({
  TerminalPane: () => <div data-testid="terminal-pane" />,
}));

vi.mock('./components/SftpDrawer', () => ({
  SftpDrawer: () => null,
}));

const now = '2026-08-15T00:00:00.000Z';

const provider: ProviderProfile = {
  id: 'provider-1',
  name: 'Shared terminal provider',
  kind: 'generic-openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  modelId: 'example-model',
  apiKeyConfigured: true,
  isDefault: true,
  status: 'ready',
  createdAt: now,
  updatedAt: now,
};

function codexSnapshot(contextEnabled = false, revision = 1): CodexAppServerSnapshot {
  return {
    revision,
    phase: 'ready',
    operation: 'idle',
    executable: {
      path: 'codex.exe',
      source: 'path',
      version: 'codex-cli 1.0.0',
    },
    requiresOpenaiAuth: false,
    models: [{
      id: 'gpt-codex',
      model: 'gpt-codex',
      displayName: 'GPT Codex',
      supportedReasoningEfforts: [],
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: true,
    }],
    selection: { modelId: 'gpt-codex' },
    bound: true,
    agentAvailable: true,
    agentReason: 'Codex App Server 已就绪；内建 Shell/File 在独立的 Codex 工作区内运行。',
    terminalContextAccess: {
      available: true,
      enabled: contextEnabled,
      acceptedClientTools: contextEnabled ? ['terminal_read'] : [],
      reason: contextEnabled
        ? '已允许 Codex 以只读方式获取当前可见终端的近期内容。'
        : 'Codex 使用独立工作区，当前不能读取可见终端内容。',
    },
    // Deliberately false/unavailable: renderer readiness must use the native fields above.
    terminalAgentEnabled: false,
    terminalAgentReason: 'deprecated alias',
    agentIsolation: {
      policyVersion: 1,
      experimental: false,
      userEnabled: false,
      availability: 'unavailable',
      acceptedClientTools: [],
      environmentAccessDisabled: false,
      enforcement: 'codex-native-workspace-write',
      reason: 'deprecated compatibility view',
    },
  };
}

function bridgeForCodex(snapshot: CodexAppServerSnapshot): DesktopBridge {
  return {
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
      list: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      remove: vi.fn(),
      forgetCredential: vi.fn(),
    },
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      upgrade: vi.fn(),
      rename: vi.fn(),
      readTerminalHistory: vi.fn(),
    },
    providers: {
      list: vi.fn().mockResolvedValue([provider]),
      save: vi.fn(),
      remove: vi.fn(),
      setDefault: vi.fn(),
      testConnection: vi.fn(),
      discoverModels: vi.fn(),
    },
    codexAppServer: {
      getState: vi.fn().mockResolvedValue(snapshot),
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
      setTerminalContextAccess: vi.fn().mockResolvedValue(codexSnapshot(true, 2)),
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

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('native Codex App Server renderer mode', () => {
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

  it('uses agentAvailable for readiness and removes takeover controls in native mode', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    expect(container.querySelector('[data-action="take-control"]')).not.toBeNull();
    const backendSelect = container.querySelector<HTMLSelectElement>('[data-testid="agent-backend-select"]')!;
    expect(backendSelect.textContent).toContain('Codex App Server · 原生模式');

    await act(async () => setSelectValue(backendSelect, CODEX_APP_SERVER_AGENT_BACKEND));

    const status = container.querySelector('[data-testid="agent-backend-status"]')!;
    expect(status.textContent).toContain('原生模式可用');
    expect(status.textContent).toContain('内建 Shell/File 在独立的 Codex 工作区内运行');
    expect(container.querySelector('[data-action="take-control"]')).toBeNull();
    expect([...container.querySelectorAll('button')].some((button) => (
      button.textContent?.includes('AI 全接管')
    ))).toBe(false);
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="agent-composer"]')?.disabled)
      .toBe(false);
    expect(container.querySelector('[data-testid="agent-codex-boundary"]')?.textContent)
      .toContain('当前终端始终由你控制');
    expect(container.querySelector('[data-testid="codex-agent-confirmation"]')).toBeNull();
  });

  it('toggles only read access to current terminal through the native context API', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const backendSelect = container.querySelector<HTMLSelectElement>('[data-testid="agent-backend-select"]')!;
    await act(async () => setSelectValue(backendSelect, CODEX_APP_SERVER_AGENT_BACKEND));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="open-codex-agent-settings"]')!.click();
    });

    const toggle = container.querySelector<HTMLInputElement>('[data-testid="codex-terminal-context-toggle"]')!;
    expect(toggle.checked).toBe(false);
    expect(container.querySelector('[data-testid="codex-native-boundary"]')?.textContent)
      .toContain('不能向终端写入或执行命令');

    await act(async () => toggle.click());
    await settle();

    expect(bridge.codexAppServer.setTerminalContextAccess).toHaveBeenCalledWith({ enabled: true });
    expect(bridge.codexAppServer.setTerminalAgentEnabled).not.toHaveBeenCalled();
    expect(container.querySelector<HTMLInputElement>('[data-testid="codex-terminal-context-toggle"]')?.checked)
      .toBe(true);
    expect(container.textContent).not.toContain('启用实验模式');
  });
});
