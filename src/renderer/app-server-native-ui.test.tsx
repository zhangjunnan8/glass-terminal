import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_APP_SERVER_AGENT_BACKEND } from '../shared/agent';
import type { AgentSessionView } from '../shared/agent';
import type { CodexAppServerSnapshot } from '../shared/codex-app-server';
import type { DesktopBridge } from '../shared/ipc';
import type { ProviderProfile } from '../shared/provider';
import type { SessionRecord } from '../shared/session';
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

  it('persists a white application theme without changing system settings', async () => {
    const bridge = bridgeForCodex(codexSnapshot());
    Object.defineProperty(window, 'aiTerminal', { configurable: true, value: bridge });
    await act(async () => root.render(<App />));
    await settle();

    const shell = container.querySelector<HTMLElement>('.app-shell')!;
    const toggle = container.querySelector<HTMLButtonElement>('[data-action="toggle-theme"]')!;
    expect(shell.dataset.theme).toBe('dark');
    await act(async () => toggle.click());
    expect(shell.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('ai-terminal:ui-theme')).toBe('light');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
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
    });
    expect(container.textContent).toContain('绑定根：/workspace/explicit-project');
    expect(container.textContent).not.toContain('绑定根：/stale-runtime-root');
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
