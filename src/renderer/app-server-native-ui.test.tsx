import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_APP_SERVER_AGENT_BACKEND } from '../shared/agent';
import type {
  AgentAssistantDelta,
  AgentSessionView,
  AgentToolActivity,
} from '../shared/agent';
import type { CodexAppServerSnapshot } from '../shared/codex-app-server';
import type { DesktopBridge } from '../shared/ipc';
import type { ProviderProfile } from '../shared/provider';
import type { SessionRecord } from '../shared/session';
import { App } from './App';
import { AiServiceSettings } from './AiServiceSettings';

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
  recipientRevision: 'recipient-provider-1',
  apiKeyConfigured: true,
  isDefault: true,
  status: 'ready',
  createdAt: now,
  updatedAt: now,
};

function localSession(workspaceRoot?: string): SessionRecord {
  return {
    schemaVersion: 1,
    id: 'session-1',
    name: 'PowerShell session',
    nameSource: 'automatic',
    transport: 'local',
    shellProfileId: 'shell-1',
    shellKind: 'powershell',
    targetSnapshot: { label: 'PowerShell' },
    connectionState: 'connected',
    status: 'active',
    runtimeTerminalId: 'terminal-1',
    cwd: '/terminal/current-directory',
    workspace: workspaceRoot ? { backend: 'local', root: workspaceRoot } : undefined,
    pinned: false,
    preludeTruncated: false,
    droppedPreludeBytes: 0,
    startedAt: now,
    promotedAt: now,
    createdAt: now,
    updatedAt: now,
    lastConnectedAt: now,
  };
}

function agentView(state: AgentSessionView['state'] = 'COMPLETED'): AgentSessionView {
  return {
    revision: 1,
    terminalId: 'terminal-1',
    sessionId: 'session-1',
    threadId: 'thread-1',
    backend: { kind: 'generic-provider', providerId: provider.id },
    providerId: provider.id,
    state,
    terminalInputMode: state === 'THINKING' ? 'locked' : 'human',
    fullTakeover: false,
    fileAccessMode: 'off',
    activities: [],
    messages: [
      { id: 'user-1', role: 'user', content: '第一条', createdAt: now },
      { id: 'assistant-1', role: 'assistant', content: '第一条回复', createdAt: now },
      { id: 'user-2', role: 'user', content: '最后一条命令', createdAt: now },
      ...(state === 'COMPLETED'
        ? [{ id: 'assistant-2', role: 'assistant' as const, content: '已完成', createdAt: now }]
        : []),
    ],
  };
}

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
      acceptedClientTools: contextEnabled ? ['terminal_state', 'terminal_read'] : [],
      reason: contextEnabled
        ? '已允许 Codex 以只读方式获取当前可见终端的状态和近期内容。'
        : 'Codex 使用独立工作区；仍有每轮终端身份，但不能刷新状态或读取内容。',
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
      choosePrivateKeyPath: vi.fn().mockResolvedValue(null),
      listFolders: vi.fn().mockResolvedValue([]),
      createFolder: vi.fn(),
      renameFolder: vi.fn(),
      removeFolder: vi.fn(),
      moveFolder: vi.fn(),
      moveHost: vi.fn(),
    },
    sessions: {
      list: vi.fn().mockResolvedValue([]),
      upgrade: vi.fn(),
      setWorkspace: vi.fn(),
      clearWorkspace: vi.fn(),
      chooseLocalWorkspace: vi.fn(),
      rename: vi.fn(),
      onRenamed: vi.fn().mockReturnValue(() => undefined),
      readTerminalHistory: vi.fn(),
      readHistoryDetail: vi.fn(),
      remove: vi.fn(),
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
      interruptTurn: vi.fn(),
      revisePrompt: vi.fn(),
      getState: vi.fn().mockResolvedValue(undefined),
      setFileAccess: vi.fn(),
      resolveApproval: vi.fn(),
      setFullTakeover: vi.fn(),
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
    window.localStorage.clear();
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
    await act(async () => root.render(<AiServiceSettings />));
    await settle();

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

  it('cycles theme through dark, light, and system', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const shell = container.querySelector<HTMLElement>('.app-shell')!;
    const toggle = container.querySelector<HTMLButtonElement>('[data-action="toggle-theme"]')!;
    expect(shell.dataset.theme).toBe('dark');
    expect(toggle.textContent).toContain('深色');

    await act(async () => toggle.click());
    expect(shell.dataset.theme).toBe('light');
    expect(toggle.textContent).toContain('亮色');
    expect(bridge.settings.update).toHaveBeenCalledWith({ theme: 'light' });

    await act(async () => toggle.click());
    expect(toggle.textContent).toContain('跟随系统');
    expect(bridge.settings.update).toHaveBeenCalledWith({ theme: 'system' });

    await act(async () => toggle.click());
    expect(toggle.textContent).toContain('深色');
    expect(bridge.settings.update).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('requires an explicit in-app confirmation before Generic Provider gains file write access', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.agent.setFileAccess = vi.fn().mockResolvedValue({
      ...agentView(), revision: 2, fileAccessMode: 'read-write', fileAccessRoot: '/stale-runtime-root',
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const select = container.querySelector<HTMLSelectElement>('[data-testid="agent-file-access-mode"]')!;
    await act(async () => setSelectValue(select, 'read-write'));
    expect(bridge.agent.setFileAccess).not.toHaveBeenCalled();
    const confirmation = container.querySelector('[data-testid="file-access-confirmation"]');
    expect(confirmation?.textContent).toContain('所有命令仍必须进入可见终端');
    expect(confirmation?.textContent).toContain('/workspace/explicit-project');
    expect(confirmation?.textContent).not.toContain('/terminal/current-directory');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="confirm-file-read-write"]')!.click();
    });
    await settle();
    expect(bridge.agent.setFileAccess).toHaveBeenCalledWith({
      terminalId: 'terminal-1', mode: 'read-write',
      backend: { kind: 'generic-provider', providerId: provider.id },
      expectedWorkspaceRoot: '/workspace/explicit-project',
    });
    expect(container.textContent).toContain('绑定根：/workspace/explicit-project');
    expect(container.textContent).not.toContain('绑定根：/stale-runtime-root');
  });

  it('requires a distinct danger confirmation before enabling full filesystem access', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.agent.setFileAccess = vi.fn().mockResolvedValue({
      ...agentView(), revision: 2, fileAccessMode: 'full-access',
      fileAccessRoot: '/workspace/explicit-project',
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-file-access-mode"]',
    )!;
    await act(async () => setSelectValue(select, 'full-access'));

    expect(bridge.agent.setFileAccess).not.toHaveBeenCalled();
    const confirmation = container.querySelector<HTMLElement>(
      '[data-testid="file-access-confirmation"]',
    )!;
    expect(confirmation.dataset.accessMode).toBe('full-access');
    expect(confirmation.classList).toContain('full-access-risk');
    expect(confirmation.textContent).toContain('允许 AI 访问完整文件系统');
    expect(confirmation.textContent).toContain('任意路径');
    expect(confirmation.textContent).toContain('不会提权');
    expect(confirmation.textContent).toContain('/workspace/explicit-project');

    await act(async () => {
      confirmation.querySelector<HTMLButtonElement>(
        '[data-action="confirm-full-filesystem-access"]',
      )!.click();
    });
    await settle();

    expect(bridge.agent.setFileAccess).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      mode: 'full-access',
      backend: { kind: 'generic-provider', providerId: provider.id },
      fullAccessConfirmed: true,
      expectedWorkspaceRoot: '/workspace/explicit-project',
    });
  });

  it('downgrades full filesystem access to bound-root read-write without another confirmation', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.agent.getState = vi.fn().mockResolvedValue({
      ...agentView(),
      fileAccessMode: 'full-access',
      fileAccessRoot: '/workspace/explicit-project',
    });
    bridge.agent.setFileAccess = vi.fn().mockResolvedValue({
      ...agentView(), revision: 2, fileAccessMode: 'read-write',
      fileAccessRoot: '/workspace/explicit-project',
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-file-access-mode"]',
    )!;
    expect(select.value).toBe('full-access');
    await act(async () => setSelectValue(select, 'read-write'));
    await settle();

    expect(container.querySelector('[data-testid="file-access-confirmation"]')).toBeNull();
    expect(bridge.agent.setFileAccess).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      mode: 'read-write',
      backend: { kind: 'generic-provider', providerId: provider.id },
    });
  });

  it('does not treat one Generic Provider grant as authority for a newly selected Provider', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    const replacementProvider: ProviderProfile = {
      ...provider,
      id: 'provider-2',
      name: 'Replacement provider',
      isDefault: true,
    };
    vi.mocked(bridge.providers.list).mockResolvedValue([
      replacementProvider,
      { ...provider, isDefault: false },
    ]);
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.agent.getState = vi.fn().mockResolvedValue({
      ...agentView(),
      fileAccessMode: 'full-access',
      fileAccessRoot: '/workspace/explicit-project',
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-file-access-mode"]',
    )!;
    expect(select.value).toBe('off');
    expect(container.querySelector('[data-testid="detached-file-access-grant"]')?.textContent)
      .toContain(provider.name);

    await act(async () => setSelectValue(select, 'read-write'));
    expect(bridge.agent.setFileAccess).not.toHaveBeenCalled();
    const confirmation = container.querySelector<HTMLElement>(
      '[data-testid="file-access-confirmation"]',
    )!;
    expect(confirmation.dataset.accessMode).toBe('read-write');
    await act(async () => {
      confirmation.querySelector<HTMLButtonElement>('button')!.click();
    });
  });

  it('keeps an explicit revoke available after the granted Provider is removed', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.providers.list).mockResolvedValue([]);
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.agent.getState = vi.fn().mockResolvedValue({
      ...agentView(),
      fileAccessMode: 'read-only',
      fileAccessRoot: '/workspace/explicit-project',
    });
    bridge.agent.setFileAccess = vi.fn().mockResolvedValue({
      ...agentView(),
      revision: 2,
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    expect(container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-file-access-mode"]',
    )?.disabled).toBe(true);
    const revoke = container.querySelector<HTMLButtonElement>(
      '[data-action="disable-active-file-access"]',
    )!;
    expect(revoke.disabled).toBe(false);
    await act(async () => revoke.click());
    await settle();

    expect(bridge.agent.setFileAccess).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      mode: 'off',
      backend: { kind: 'generic-provider', providerId: provider.id },
    });
  });

  it('disables file-access grants when the active terminal disconnects', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.agent.getState = vi.fn().mockResolvedValue(agentView());
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    const onExit = vi.mocked(bridge.terminal.onExit).mock.calls[0]![1];
    await act(async () => onExit({ terminalId: 'terminal-1', exitCode: 0 }));
    await settle();

    expect(container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-file-access-mode"]',
    )?.disabled).toBe(true);
  });

  it('invalidates a file-access confirmation when its backend selection changes', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    await act(async () => setSelectValue(
      container.querySelector<HTMLSelectElement>('[data-testid="agent-file-access-mode"]')!,
      'full-access',
    ));
    expect(container.querySelector('[data-testid="file-access-confirmation"]')).not.toBeNull();

    await act(async () => setSelectValue(
      container.querySelector<HTMLSelectElement>('[data-testid="agent-backend-select"]')!,
      CODEX_APP_SERVER_AGENT_BACKEND,
    ));
    await settle();

    expect(container.querySelector('[data-testid="file-access-confirmation"]')).toBeNull();
    expect(bridge.agent.setFileAccess).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="workspace-action-error"]')?.textContent)
      .toContain('授权目标已变化');
  });

  it('invalidates a file-access confirmation when the Workspace Root changes', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.sessions.chooseLocalWorkspace = vi.fn().mockResolvedValue(
      localSession('/workspace/replaced-project'),
    );
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    await act(async () => setSelectValue(
      container.querySelector<HTMLSelectElement>('[data-testid="agent-file-access-mode"]')!,
      'full-access',
    ));
    expect(container.querySelector('[data-testid="file-access-confirmation"]')).not.toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="choose-workspace"]')!.click();
    });
    await settle();

    expect(container.querySelector('[data-testid="file-access-confirmation"]')).toBeNull();
    expect(bridge.agent.setFileAccess).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="terminal-workspace-binding"]')?.textContent)
      .toContain('/workspace/replaced-project');
  });

  it('invalidates a file-access confirmation after switching active terminals', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    await act(async () => setSelectValue(
      container.querySelector<HTMLSelectElement>('[data-testid="agent-file-access-mode"]')!,
      'full-access',
    ));
    expect(container.querySelector('[data-testid="file-access-confirmation"]')).not.toBeNull();

    await act(async () => window.dispatchEvent(new CustomEvent('ai-terminal:terminal-opened', {
      detail: {
        id: 'terminal-2',
        title: 'Other terminal',
        profileId: 'shell-1',
        shellKind: 'powershell',
        transport: 'local',
      },
    })));
    await settle();

    expect(container.querySelector('[data-testid="file-access-confirmation"]')).toBeNull();
    expect(bridge.agent.setFileAccess).not.toHaveBeenCalled();
  });

  it('blocks file access until an explicit Workspace Root is set and never falls back to cwd', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([localSession()]);
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const select = container.querySelector<HTMLSelectElement>('[data-testid="agent-file-access-mode"]')!;
    expect(select.disabled).toBe(true);
    expect(container.querySelector('[data-testid="agent-workspace-required"]')?.textContent)
      .toContain('请先设置 Workspace Root');
    expect(container.querySelector('[data-testid="file-access-confirmation"]')).toBeNull();
    expect(bridge.agent.setFileAccess).not.toHaveBeenCalled();
    expect(container.querySelector('.agent-controls')?.textContent)
      .not.toContain('/terminal/current-directory');
  });

  it('offers retract and edit only on the latest completed user message', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    const completed = agentView();
    const revised = { ...completed, revision: 2, state: 'THINKING' as const };
    bridge.agent.getState = vi.fn().mockResolvedValue(completed);
    bridge.agent.revisePrompt = vi.fn().mockResolvedValue(revised);
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    expect(container.querySelectorAll('[data-testid="latest-user-message-actions"]')).toHaveLength(1);
    expect(container.querySelector('[data-action="interrupt-agent-message"]')).toBeNull();
    const edit = container.querySelector<HTMLButtonElement>('[data-action="edit-agent-message"]')!;
    await act(async () => edit.click());
    const composer = container.querySelector<HTMLTextAreaElement>('[data-testid="agent-composer"]')!;
    expect(composer.value).toBe('最后一条命令');
    expect(container.querySelector('.composer-editing')?.textContent).toContain('正在修改');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="修改并重新发送"]')!.click();
    });
    await settle();
    expect(bridge.agent.revisePrompt).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      messageId: 'user-2',
      action: 'replace',
      prompt: '最后一条命令',
    });
  });

  it.each([
    ['THINKING', 'off', 'AI 正在运行'],
    ['COMPLETED', 'read-only', '请先关闭 AI 文件访问'],
  ] as const)(
    'disables workspace changes while agent state is %s with file access %s',
    async (state, fileAccessMode, expectedTitle) => {
      const bridge = bridgeForCodex(codexSnapshot());
      bridge.agent.getState = vi.fn().mockResolvedValue({
        ...agentView(state),
        fileAccessMode,
      });
      Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
      await act(async () => root.render(<App />));
      await settle();
      await settle();

      const chooseWorkspace = container.querySelector<HTMLButtonElement>(
        '[data-action="choose-workspace"]',
      )!;
      expect(chooseWorkspace.disabled).toBe(true);
      expect(chooseWorkspace.title).toContain(expectedTitle);
    },
  );

  it('keeps Workspace changes locked by Generic runtime access after selecting Codex', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    vi.mocked(bridge.sessions.list).mockResolvedValue([
      localSession('/workspace/explicit-project'),
    ]);
    bridge.agent.getState = vi.fn().mockResolvedValue({
      ...agentView(),
      fileAccessMode: 'read-only',
      fileAccessRoot: '/workspace/explicit-project',
    });
    bridge.agent.setFileAccess = vi.fn().mockResolvedValue({
      ...agentView(),
      revision: 2,
      fileAccessMode: 'off',
      fileAccessRoot: undefined,
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    const backendSelect = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-backend-select"]',
    )!;
    const chooseWorkspace = container.querySelector<HTMLButtonElement>(
      '[data-action="choose-workspace"]',
    )!;
    expect(chooseWorkspace.disabled).toBe(true);
    expect(chooseWorkspace.title).toContain('请先关闭 AI 文件访问');

    await act(async () => setSelectValue(backendSelect, CODEX_APP_SERVER_AGENT_BACKEND));

    expect(chooseWorkspace.disabled).toBe(true);
    expect(chooseWorkspace.title).toContain('请先关闭 AI 文件访问');

    await act(async () => setSelectValue(backendSelect, 'generic-provider'));
    const fileAccess = container.querySelector<HTMLSelectElement>(
      '[data-testid="agent-file-access-mode"]',
    )!;
    expect(fileAccess.value).toBe('read-only');
    await act(async () => setSelectValue(fileAccess, 'off'));
    await settle();

    expect(bridge.agent.setFileAccess).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      mode: 'off',
      backend: { kind: 'generic-provider', providerId: provider.id },
    });
    expect(chooseWorkspace.disabled).toBe(false);
  });

  it('shows a one-click interrupt instead of edit controls while the latest prompt runs', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    const running = agentView('THINKING');
    bridge.agent.getState = vi.fn().mockResolvedValue(running);
    bridge.agent.interruptTurn = vi.fn().mockResolvedValue({
      ...running,
      revision: 2,
      state: 'PAUSED',
      terminalInputMode: 'human',
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    expect(container.querySelector('[data-action="retract-agent-message"]')).toBeNull();
    expect(container.querySelector('[data-action="edit-agent-message"]')).toBeNull();
    const activity = container.querySelector<HTMLElement>('[data-testid="agent-activity-card"]')!;
    expect(activity.textContent).toContain('AI 正在思考');
    expect(activity.textContent).toContain('Shared terminal provider');
    expect(activity.textContent).toContain('当前终端：本地 · PowerShell');
    expect(container.querySelector('[data-testid="agent-activity-dots"]')?.children).toHaveLength(3);
    const interrupt = container.querySelector<HTMLButtonElement>('[data-action="interrupt-agent-message"]')!;
    await act(async () => interrupt.click());
    expect(bridge.agent.interruptTurn).toHaveBeenCalledWith({
      terminalId: 'terminal-1',
      messageId: 'user-2',
    });
  });

  it('shows bounded tool activity metadata outside chat and hides an empty list', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    const unsafeMetadata = {
      rawArgs: 'RAW_ARGUMENTS_MUST_NOT_RENDER',
      result: 'RAW_RESULT_MUST_NOT_RENDER',
      error: 'RAW_ERROR_MUST_NOT_RENDER',
    };
    const activities: Array<AgentToolActivity & typeof unsafeMetadata> = [
      {
        id: 'read-1', toolName: 'workspace_read_file', kind: 'workspace',
        label: '读取文件', status: 'succeeded', startedAt: now, finishedAt: now,
        summary: '已读取文本文件', ...unsafeMetadata,
      },
      {
        id: 'search-1', toolName: 'workspace_search', kind: 'workspace',
        label: '搜索工作区', status: 'running', startedAt: now,
        summary: '正在搜索匹配项', ...unsafeMetadata,
      },
      {
        id: 'patch-1', toolName: 'workspace_apply_patch', kind: 'workspace',
        label: '应用补丁', status: 'failed', startedAt: now, finishedAt: now,
        summary: '未能应用更改', ...unsafeMetadata,
      },
      {
        id: 'terminal-1', toolName: 'terminal_execute', kind: 'terminal',
        label: '执行终端命令', status: 'cancelled', startedAt: now, finishedAt: now,
        summary: '命令已取消', ...unsafeMetadata,
      },
    ];
    const view: AgentSessionView = {
      ...agentView(),
      messages: [],
      activities,
    };
    let emitAgentState: ((state: AgentSessionView) => void) | undefined;
    bridge.agent.getState = vi.fn().mockResolvedValue(view);
    bridge.agent.onStateChanged = vi.fn((listener) => {
      emitAgentState = listener;
      return () => undefined;
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });

    await act(async () => root.render(<App />));
    await settle();
    await settle();

    const activityList = container.querySelector('[data-testid="tool-activity-list"]');
    expect(activityList?.querySelectorAll('li')).toHaveLength(4);
    for (const label of ['读取文件', '搜索工作区', '应用补丁', '执行终端命令']) {
      expect(activityList?.textContent).toContain(label);
    }
    expect(container.querySelectorAll('.agent-message')).toHaveLength(0);
    expect(activityList?.textContent).not.toContain('RAW_ARGUMENTS_MUST_NOT_RENDER');
    expect(activityList?.textContent).not.toContain('RAW_RESULT_MUST_NOT_RENDER');
    expect(activityList?.textContent).not.toContain('RAW_ERROR_MUST_NOT_RENDER');

    await act(async () => emitAgentState?.({ ...view, revision: 2, activities: [] }));
    expect(container.querySelector('[data-testid="tool-activity-list"]')).toBeNull();
    expect(container.querySelectorAll('.agent-message')).toHaveLength(0);
  });

  it('batches Assistant deltas into the target message and resyncs on a sequence gap', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    const streaming: AgentSessionView = {
      ...agentView('THINKING'),
      streamingMessageId: 'assistant-stream',
      streamingTurnId: 'turn-stream',
      streamingSequence: 0,
      messages: [
        ...agentView('THINKING').messages,
        {
          id: 'assistant-stream',
          role: 'assistant',
          content: '',
          createdAt: now,
        },
      ],
    };
    let emitDelta: ((event: AgentAssistantDelta) => void) | undefined;
    bridge.agent.getState = vi.fn().mockResolvedValue(streaming);
    bridge.agent.onAssistantDelta = vi.fn((listener) => {
      emitDelta = listener;
      return () => undefined;
    });
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();
    vi.mocked(bridge.agent.getState).mockClear();

    await act(async () => {
      emitDelta!({
        terminalId: 'terminal-1',
        threadId: 'thread-1',
        messageId: 'assistant-stream',
        turnId: 'turn-stream',
        sequence: 1,
        delta: '分批输出',
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect([...container.querySelectorAll('.agent-message.assistant')]
      .at(-1)?.textContent).toContain('分批输出');

    await act(async () => {
      emitDelta!({
        terminalId: 'terminal-1',
        threadId: 'thread-1',
        messageId: 'assistant-stream',
        turnId: 'turn-stream',
        sequence: 3,
        delta: '缺失第二段',
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    expect(bridge.agent.getState).toHaveBeenCalledWith('terminal-1');
  });

  it('shows an Agent action failure outside unrelated connection dialogs', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    const completed = agentView();
    bridge.agent.getState = vi.fn().mockResolvedValue(completed);
    bridge.agent.revisePrompt = vi.fn().mockRejectedValue(new Error('修改请求已过期'));
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();
    await settle();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="edit-agent-message"]')!.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="修改并重新发送"]')!.click();
    });
    await settle();

    expect(container.querySelector('[data-testid="workspace-action-error"]')?.textContent)
      .toContain('修改请求已过期');
  });
});
