import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { HostInput, HostProfile } from '../shared/host';
import type { RuntimeInfo } from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';
import type { SessionRecord } from '../shared/session';
import type { ProviderInput, ProviderProfile } from '../shared/provider';
import type { AgentRuntimeState, AgentSessionView } from '../shared/agent';
import type { ShellProfile, TerminalDescriptor } from '../shared/terminal';
import { mergeAgentState } from './agent-state';
import { TerminalPane } from './components/TerminalPane';
import { SftpDrawer } from './components/SftpDrawer';
import {
  agentStateLabel,
  authMethodLabel,
  executionStatusLabel,
  providerStatusLabel,
  roleLabel,
  sessionStatusLabel,
} from './ui-text';

interface TerminalTab extends TerminalDescriptor {
  createdAt: number;
  status: 'connected' | 'exited';
}

interface ConnectionSecret {
  password?: string;
  passphrase?: string;
}

interface TrustChallenge {
  host: HostProfile;
  fingerprint: string;
  secret: ConnectionSecret;
  sessionId?: string;
}

interface FullTakeoverChallenge {
  terminalId: string;
  target: string;
  approvalId?: string;
  command?: string;
  editedCommand?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function agentTurnBusy(state?: AgentRuntimeState): boolean {
  return Boolean(state && [
    'THINKING',
    'WAITING_APPROVAL',
    'AI_CONTROL',
    'RUNNING',
    'WAITING_OUTPUT',
    'WAITING_AUTH',
    'TAKEOVER_PENDING',
  ].includes(state));
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [sftpOpen, setSftpOpen] = useState(false);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderProfile | null>(null);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  const [agentStates, setAgentStates] = useState<Record<string, AgentSessionView>>({});
  const [agentPrompt, setAgentPrompt] = useState('');
  const [editedApprovalCommand, setEditedApprovalCommand] = useState('');
  const [editingHost, setEditingHost] = useState<HostProfile | null | undefined>(undefined);
  const [connectingHost, setConnectingHost] = useState<HostProfile | null>(null);
  const [reconnectingSessionId, setReconnectingSessionId] = useState<string | null>(null);
  const [trustChallenge, setTrustChallenge] = useState<TrustChallenge | null>(null);
  const [fullTakeoverChallenge, setFullTakeoverChallenge] = useState<FullTakeoverChallenge | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    void window.aiTerminal.runtime.getInfo().then(setRuntime);
    void window.aiTerminal.hosts.list().then(setHosts).catch((error) => {
      setStartupError(errorMessage(error));
    });
    void window.aiTerminal.sessions.list().then(setSessions).catch((error) => {
      setStartupError(errorMessage(error));
    });
    void window.aiTerminal.providers.list().then(setProviders).catch((error) => {
      setStartupError(errorMessage(error));
    });
    const removeExitListener = window.aiTerminal.terminal.onExit((event) => {
      setTabs((current) => current.map((tab) => (
        tab.id === event.terminalId ? { ...tab, status: 'exited' } : tab
      )));
      void refreshSessions();
    });
    const removeAgentListener = window.aiTerminal.agent.onStateChanged((state) => {
      setAgentStates((current) => mergeAgentState(current, state));
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
    });

    let cancelled = false;
    void window.aiTerminal.terminal.listShells()
      .then(async (profiles) => {
        if (cancelled) return;
        setShells(profiles);
        if (profiles.length === 0) throw new Error('未检测到受支持的本地 Shell。');
        const descriptor = await window.aiTerminal.terminal.create({
          profileId: profiles[0].id,
        });
        if (cancelled) {
          await window.aiTerminal.terminal.close(descriptor.id);
          return;
        }
        setTabs([{ ...descriptor, createdAt: Date.now(), status: 'connected' }]);
        setActiveId(descriptor.id);
      })
      .catch((error: unknown) => setStartupError(errorMessage(error)));
    return () => {
      cancelled = true;
      removeExitListener();
      removeAgentListener();
    };
  }, []);

  useEffect(() => {
    const handleOpenedTerminal = (event: Event) => {
      addTab((event as CustomEvent<TerminalDescriptor>).detail);
    };
    window.addEventListener('ai-terminal:terminal-opened', handleOpenedTerminal);
    return () => window.removeEventListener(
      'ai-terminal:terminal-opened',
      handleOpenedTerminal,
    );
  }, []);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [activeId, tabs],
  );
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? null;
  const selectedHostSessions = selectedHost
    ? sessions.filter((session) => session.hostId === selectedHost.id)
    : [];
  const defaultProvider = providers.find((provider) => provider.isDefault) ?? null;
  const activeAgent = activeTab ? agentStates[activeTab.id] : undefined;
  const activeInputMode = activeAgent?.terminalInputMode ?? 'human';
  const foregroundRunning = activeAgent?.state === 'PAUSED'
    && activeAgent.activeExecution?.status === 'running';
  const composerBlocked = agentTurnBusy(activeAgent?.state) || foregroundRunning;

  useEffect(() => {
    if (!activeId) return;
    void window.aiTerminal.agent.getState(activeId).then((state) => {
      if (state) setAgentStates((current) => mergeAgentState(current, state));
    });
  }, [activeId]);

  useEffect(() => {
    setEditedApprovalCommand(activeAgent?.pendingApproval?.command ?? '');
  }, [activeAgent?.pendingApproval?.id]);

  function addTab(descriptor: TerminalDescriptor) {
    const tab: TerminalTab = {
      ...descriptor,
      createdAt: Date.now(),
      status: 'connected',
    };
    setTabs((current) => [...current, tab]);
    setActiveId(tab.id);
  }

  async function openTerminal(profileId: string) {
    setNewTerminalOpen(false);
    try {
      addTab(await window.aiTerminal.terminal.create({ profileId }));
    } catch (error) {
      setStartupError(errorMessage(error));
    }
  }

  function closeTerminal(terminalId: string) {
    void window.aiTerminal.terminal.close(terminalId).catch(() => undefined);
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === terminalId);
      const remaining = current.filter((tab) => tab.id !== terminalId);
      if (activeId === terminalId) {
        setActiveId(remaining[Math.max(0, index - 1)]?.id ?? remaining[0]?.id ?? null);
      }
      return remaining;
    });
  }

  async function refreshHosts() {
    setHosts(await window.aiTerminal.hosts.list());
  }

  async function refreshSessions() {
    setSessions(await window.aiTerminal.sessions.list());
  }

  async function refreshProviders() {
    setProviders(await window.aiTerminal.providers.list());
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const apiKeyInput = event.currentTarget.elements.namedItem('apiKey') as HTMLInputElement;
    const input: ProviderInput = {
      id: editingProvider?.id,
      name: String(data.get('name') ?? ''),
      baseUrl: String(data.get('baseUrl') ?? ''),
      modelId: String(data.get('modelId') ?? ''),
      apiKey: String(data.get('apiKey') ?? '') || undefined,
      makeDefault: data.get('makeDefault') === 'on',
    };
    apiKeyInput.value = '';
    try {
      const saved = await window.aiTerminal.providers.save(input);
      await refreshProviders();
      setEditingProvider(saved);
      setProviderMessage('已保存。请先测试连接，再使用此 Provider。');
    } catch (error) {
      setProviderMessage(errorMessage(error));
    }
  }

  async function testProvider(providerId: string) {
    setProviderMessage('正在测试连接…');
    try {
      const result = await window.aiTerminal.providers.testConnection(providerId);
      await refreshProviders();
      setProviderMessage(result.message);
    } catch (error) {
      setProviderMessage(errorMessage(error));
    }
  }

  async function removeProvider(provider: ProviderProfile) {
    if (!window.confirm(`确定删除 Provider“${provider.name}”及其已保存的凭据吗？`)) return;
    await window.aiTerminal.providers.remove(provider.id);
    setEditingProvider(null);
    await refreshProviders();
  }

  async function sendAgentPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTab || !agentPrompt.trim()) return;
    const prompt = agentPrompt.trim();
    setAgentPrompt('');
    try {
      const state = await window.aiTerminal.agent.sendPrompt({
        terminalId: activeTab.id,
        prompt,
        providerId: defaultProvider?.id,
      });
      setAgentStates((current) => mergeAgentState(current, state));
      setTabs((current) => current.map((tab) => (
        tab.id === state.terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function resolveAgentApproval(decision: 'execute' | 'edit' | 'reject') {
    if (!activeTab || !activeAgent?.pendingApproval) return;
    try {
      const state = await window.aiTerminal.agent.resolveApproval({
        terminalId: activeTab.id,
        approvalId: activeAgent.pendingApproval.id,
        decision,
        editedCommand: decision === 'edit' ? editedApprovalCommand : undefined,
      });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function setFullTakeover(
    enabled: boolean,
    terminalId = activeTab?.id,
    approvalId?: string,
    editedCommand?: string,
  ) {
    if (!terminalId) return;
    try {
      const state = await window.aiTerminal.agent.setFullTakeover({
        terminalId,
        enabled,
        providerId: defaultProvider?.id,
        approvalId,
        editedCommand,
      });
      setAgentStates((current) => mergeAgentState(current, state));
      setTabs((current) => current.map((tab) => (
        tab.id === terminalId ? { ...tab, sessionId: state.sessionId } : tab
      )));
      setFullTakeoverChallenge(null);
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function requestAgentTakeover() {
    if (!activeTab) return;
    try {
      const state = await window.aiTerminal.agent.takeover({ terminalId: activeTab.id });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function resolveAgentTakeover(action: 'keep' | 'interrupt') {
    if (!activeTab || !activeAgent?.pendingTakeover) return;
    try {
      const state = await window.aiTerminal.agent.resolveTakeover({
        terminalId: activeTab.id,
        takeoverId: activeAgent.pendingTakeover.id,
        executionId: activeAgent.pendingTakeover.executionId,
        action,
      });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function confirmShellReady(terminalId: string, executionId: string) {
    try {
      const state = await window.aiTerminal.agent.confirmShellReady({
        terminalId,
        executionId,
      });
      setAgentStates((current) => mergeAgentState(current, state));
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function activateAiSession() {
    if (!activeTab) return;
    try {
      const session = await window.aiTerminal.sessions.upgrade({ terminalId: activeTab.id });
      setTabs((current) => current.map((tab) => (
        tab.id === activeTab.id ? { ...tab, sessionId: session.id } : tab
      )));
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function renameSession(session: SessionRecord) {
    const name = window.prompt('会话名称', session.name);
    if (!name || name.trim() === session.name) return;
    try {
      await window.aiTerminal.sessions.rename({ sessionId: session.id, name });
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function saveHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const input: HostInput = {
      id: editingHost?.id,
      name: String(data.get('name') ?? ''),
      hostname: String(data.get('hostname') ?? ''),
      port: Number(data.get('port') ?? 22),
      username: String(data.get('username') ?? ''),
      authMethod: String(data.get('authMethod') ?? 'password') as HostInput['authMethod'],
      privateKeyPath: String(data.get('privateKeyPath') ?? ''),
      group: String(data.get('group') ?? ''),
      favorite: data.get('favorite') === 'on',
    };
    try {
      const saved = await window.aiTerminal.hosts.save(input);
      await refreshHosts();
      setSelectedHostId(saved.id);
      setEditingHost(undefined);
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  async function removeHost(host: HostProfile) {
    if (!window.confirm(`确定删除主机“${host.name}”吗？`)) return;
    await window.aiTerminal.hosts.remove(host.id);
    if (selectedHostId === host.id) setSelectedHostId(null);
    await refreshHosts();
  }

  async function establishSsh(
    host: HostProfile,
    secret: ConnectionSecret,
    trustHostKey?: string,
    sessionId = reconnectingSessionId ?? undefined,
  ) {
    setConnectionError(null);
    try {
      const result = await window.aiTerminal.terminal.connectSsh({
        hostId: host.id,
        sessionId,
        ...secret,
        trustHostKey,
      });
      if (result.status === 'host-key-required') {
        setTrustChallenge({ host, fingerprint: result.fingerprint, secret, sessionId });
        setConnectingHost(null);
        return;
      }
      addTab(result.terminal);
      setConnectingHost(null);
      setReconnectingSessionId(null);
      setTrustChallenge(null);
      await refreshHosts();
      await refreshSessions();
    } catch (error) {
      setConnectionError(errorMessage(error));
    }
  }

  function submitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!connectingHost) return;
    const data = new FormData(event.currentTarget);
    void establishSsh(connectingHost, {
      password: String(data.get('password') ?? '') || undefined,
      passphrase: String(data.get('passphrase') ?? '') || undefined,
    });
  }

  return (
    <div className="app-shell" data-locale="zh-CN">
      <header className="titlebar">
        <div className="brand-mark" aria-hidden="true">&gt;_</div>
        <div className="brand-copy">
          <strong>{PRODUCT_NAME}</strong>
          <span>共享终端智能体</span>
        </div>
        <div className="workspace-title">本地工作区</div>
        <div className="runtime-pill">
          <span className="status-dot" />
          {runtime ? `${runtime.platform} · ${runtime.arch}` : '正在启动…'}
        </div>
      </header>

      <aside className="activitybar" aria-label="主导航">
        <button className="activity active" title="终端">⌁</button>
        <button className="activity" title="主机">▦</button>
        <button
          className={`activity ${sftpOpen ? 'active' : ''}`}
          title="SFTP 文件与传输"
          data-action="toggle-sftp"
          onClick={() => setSftpOpen((open) => !open)}
        >⇅</button>
        <button className="activity" title="历史记录">◷</button>
        <div className="activity-spacer" />
        <button className="activity" title="Provider 设置" onClick={() => {
          setEditingProvider(defaultProvider);
          setProviderMessage(null);
          setProviderModalOpen(true);
        }}>⚙</button>
      </aside>

      <aside className="sidebar">
        <div className="panel-heading">
          <span>终端</span>
          <button title="添加 SSH 主机" onClick={() => setEditingHost(null)}>＋</button>
        </div>
        <label className="search-box">
          <span>⌕</span>
          <input aria-label="搜索主机和 Shell" placeholder="搜索主机和 Shell" />
        </label>

        <div className="section-label">本地 SHELL</div>
        <div className="host-list compact">
          {shells.map((shell) => (
            <button className="host-row" key={shell.id} onClick={() => void openTerminal(shell.id)}>
              <span className="host-icon">{shell.kind === 'wsl' ? '◈' : '⌘'}</span>
              <span>
                <strong>{shell.label}</strong>
                <small>{shell.detail}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="section-label section-with-action">
          <span>SSH 主机</span>
          <button onClick={() => setEditingHost(null)}>添加</button>
        </div>
        <div className="host-list">
          {hosts.map((host) => (
            <button
              className={`host-row ${selectedHostId === host.id ? 'active' : ''}`}
              key={host.id}
              onClick={() => setSelectedHostId(host.id)}
            >
              <span className="host-icon">{host.favorite ? '★' : '◇'}</span>
              <span>
                <strong>{host.name}</strong>
                <small>{host.username}@{host.hostname}:{host.port}</small>
              </span>
            </button>
          ))}
          {hosts.length === 0 && <div className="empty-list">尚未添加 SSH 主机</div>}
        </div>

        {selectedHost && (
          <div className="selected-host-card">
            <strong>{selectedHost.name}</strong>
            <span>{authMethodLabel(selectedHost.authMethod)} · {selectedHost.hostKeyFingerprint ? '已信任' : '未验证'}</span>
            <div>
              <button onClick={() => {
                setReconnectingSessionId(null);
                setConnectingHost(selectedHost);
              }}>连接</button>
              <button onClick={() => setEditingHost(selectedHost)}>编辑</button>
              <button className="danger-text" onClick={() => void removeHost(selectedHost)}>删除</button>
            </div>
            <div className="host-session-history">
              <small>会话历史</small>
              {selectedHostSessions.map((session) => (
                <div className="session-history-row" key={session.id}>
                  <span>
                    <strong>{session.name}</strong>
                    <small>{sessionStatusLabel(session.status)} · {new Date(session.updatedAt).toLocaleString('zh-CN')}</small>
                  </span>
                  <span className="session-history-actions">
                    <button title="重命名会话" onClick={() => void renameSession(session)}>重命名</button>
                    <button onClick={() => {
                      setReconnectingSessionId(session.id);
                      setConnectingHost(selectedHost);
                    }}>重连</button>
                  </span>
                </div>
              ))}
              {selectedHostSessions.length === 0 && <small>尚无正式会话。</small>}
            </div>
          </div>
        )}
        <div className="sidebar-footer">无遥测 · 密码仅保留在内存中</div>
      </aside>

      <main className="workspace">
        <nav className="tabs" aria-label="终端标签页">
          {tabs.map((tab) => (
            <button
              className={`tab ${tab.id === activeId ? 'active' : ''}`}
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
            >
              <span className={`tab-state ${tab.status}`} />
              <span className="tab-title">{tab.title}</span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTerminal(tab.id);
                }}
              >×</span>
            </button>
          ))}
          <div className="new-tab-wrap">
            <button className="new-tab" title="新建终端" onClick={() => setNewTerminalOpen((open) => !open)}>＋</button>
            {newTerminalOpen && (
              <div className="shell-menu">
                {shells.map((shell) => (
                  <button key={shell.id} onClick={() => void openTerminal(shell.id)}>
                    <strong>{shell.label}</strong>
                    <span>{shell.detail}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <section
          className={[
            'terminal-stage',
            activeInputMode === 'locked' ? 'agent-controlled' : '',
            activeInputMode === 'secure-human' ? 'auth-required' : '',
            activeAgent?.fullTakeover ? 'full-takeover' : '',
          ].filter(Boolean).join(' ')}
          data-agent-state={activeAgent?.state ?? 'USER_CONTROL'}
          data-input-mode={activeInputMode}
          data-full-takeover={activeAgent?.fullTakeover ? 'true' : 'false'}
        >
          <div className="terminal-toolbar">
            <span>
              {activeAgent ? agentStateLabel(activeAgent.state) : '用户控制'}
              {activeAgent?.fullTakeover ? ' · AI 全接管' : ''}
            </span>
            <div className="terminal-actions">
              <span>{activeTab?.status === 'exited'
                ? '已断开'
                : activeTab?.transport === 'ssh' ? 'SSH' : activeTab ? '本地' : '无终端'}</span>
              {activeTab?.status === 'exited' && activeTab.hostId && (
                <button onClick={() => {
                  const host = hosts.find((item) => item.id === activeTab.hostId);
                  if (host) {
                    setReconnectingSessionId(activeTab.sessionId ?? null);
                    setConnectingHost(host);
                  }
                }}>重连</button>
              )}
              <button title="搜索终端">⌕</button>
              <button title="终端操作">⋯</button>
            </div>
          </div>
          <div className="terminal-stack">
            {tabs.map((tab) => (
              <TerminalPane
                key={tab.id}
                terminalId={tab.id}
                active={tab.id === activeId}
                inputMode={agentStates[tab.id]?.terminalInputMode ?? 'human'}
              />
            ))}
            {tabs.length === 0 && !startupError && (
              <div className="terminal-placeholder">请选择本地 Shell 或 SSH 主机以打开终端。</div>
            )}
            {startupError && <div className="terminal-error">{startupError}</div>}
          </div>
          <footer className="terminal-statusbar">
            <span>UTF-8</span>
            <span>{activeTab?.transport === 'ssh' ? 'SSH PTY' : 'ConPTY'}</span>
            <span>{activeTab?.sessionId ? '正式会话' : '临时终端'}</span>
          </footer>
        </section>
        {sftpOpen && <SftpDrawer terminal={activeTab} onClose={() => setSftpOpen(false)} />}
      </main>

      <aside className="agent-panel">
        <div className="agent-header">
          <div>
            <strong>AI 智能体</strong>
            <span>
              当前 Provider：{defaultProvider
                ? `${defaultProvider.name} · ${providerStatusLabel(defaultProvider.status)}`
                : '未配置'}
            </span>
          </div>
          <div className="agent-controls">
            {activeAgent?.fullTakeover && <span className="takeover-badge">AI 全接管</span>}
            <button
              className="take-control"
              data-action="take-control"
              disabled={!agentTurnBusy(activeAgent?.state) || activeAgent?.state === 'TAKEOVER_PENDING'}
              onClick={() => void requestAgentTakeover()}
            >人工接管</button>
            <button
              className={activeAgent?.fullTakeover ? 'full-takeover-enabled' : ''}
              disabled={!activeTab || !defaultProvider || defaultProvider.status !== 'ready' || agentTurnBusy(activeAgent?.state)}
              onClick={() => {
                if (!activeTab) return;
                if (activeAgent?.fullTakeover) {
                  void setFullTakeover(false, activeTab.id);
                } else {
                  setFullTakeoverChallenge({
                    terminalId: activeTab.id,
                    target: activeTab.title,
                  });
                }
              }}
            >{activeAgent?.fullTakeover ? '关闭全接管' : 'AI 全接管'}</button>
          </div>
        </div>
        <div className="agent-body">
          {!activeAgent?.messages.length && (
            <div className="agent-empty">
              <div className="agent-glyph">✦</div>
              <strong>理解终端上下文的 AI 助手</strong>
              <p>智能体会读取当前会话，并在向这个可见终端发送每条命令前请求你的批准。</p>
              <div className="guardrail"><span>✓</span> 默认逐条审批命令</div>
              <button className="provider-configure" onClick={() => {
                setEditingProvider(defaultProvider);
                setProviderMessage(null);
                setProviderModalOpen(true);
              }}>
                {defaultProvider ? '管理 Provider' : '配置 Provider'}
              </button>
              {activeTab && !activeTab.sessionId && (
                <button className="activate-session" onClick={() => void activateAiSession()}>
                  启用 AI 会话
                </button>
              )}
            </div>
          )}
          {activeAgent?.messages.map((message) => (
            <article className={`agent-message ${message.role}`} key={message.id}>
              <span>{roleLabel(message.role)}</span>
              <p>{message.content}</p>
            </article>
          ))}
          {activeAgent?.pendingApproval?.status === 'waiting' && (
            <section className="approval-card">
              <div>
                <strong>命令审批</strong>
                <span>{activeAgent.pendingApproval.reason ?? '智能体请求在终端中执行命令'}</span>
              </div>
              <textarea
                aria-label="待审批命令"
                value={editedApprovalCommand}
                onChange={(event) => setEditedApprovalCommand(event.target.value)}
                spellCheck={false}
              />
              <div className="approval-actions">
                <button data-action="reject-command" onClick={() => void resolveAgentApproval('reject')}>拒绝</button>
                <button data-action="edit-command" onClick={() => void resolveAgentApproval('edit')}>编辑并执行</button>
                <button onClick={() => {
                  if (!activeTab || !activeAgent.pendingApproval) return;
                  setFullTakeoverChallenge({
                    terminalId: activeTab.id,
                    target: activeTab.title,
                    approvalId: activeAgent.pendingApproval.id,
                    command: activeAgent.pendingApproval.command,
                    editedCommand: editedApprovalCommand,
                  });
                }} data-action="switch-full-takeover">切换为 AI 全接管…</button>
                <button className="execute" data-action="execute-command" onClick={() => void resolveAgentApproval('execute')}>执行</button>
              </div>
            </section>
          )}
          {activeAgent?.authRequest && (
            <section className="auth-card" data-auth-interaction={activeAgent.authRequest.id}>
              <strong>需要安全认证</strong>
              <p>请直接在当前终端输入凭据并按 Enter。智能体随后会自动继续。首个 Enter 后的同次粘贴内容会被丢弃；凭据不会进入 AI 上下文、会话日志、结构化输出或审计记录。</p>
            </section>
          )}
          {activeAgent?.activeExecution && (
            <section className={`execution-card ${activeAgent.activeExecution.status}`}>
              <strong>{executionStatusLabel(activeAgent.activeExecution.status)}</strong>
              <code>{activeAgent.activeExecution.command}</code>
              {activeAgent.activeExecution.exitCode !== undefined && (
                <span>退出码 {activeAgent.activeExecution.exitCode} · {activeAgent.activeExecution.durationMs ?? 0} 毫秒</span>
              )}
              {activeAgent.state === 'PAUSED'
                && activeAgent.activeExecution.status === 'running'
                && activeAgent.activeExecution.interruptRequestedAt && (
                <button onClick={() => void confirmShellReady(
                  activeAgent.terminalId,
                  activeAgent.activeExecution!.id,
                )} data-action="confirm-shell-ready">已看到 Shell 提示符 · 解除运行跟踪</button>
              )}
            </section>
          )}
          {activeAgent?.error && <div className="agent-error">{activeAgent.error}</div>}
        </div>
        <form className="composer" onSubmit={(event) => void sendAgentPrompt(event)}>
          <textarea
            aria-label="向 AI 发送消息"
            data-testid="agent-composer"
            placeholder="让智能体检查或操作当前终端…"
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
            disabled={defaultProvider?.status !== 'ready' || !activeTab || activeTab.status !== 'connected' || composerBlocked}
          />
          <div>
            <span>{defaultProvider?.status === 'ready'
              ? activeAgent ? agentStateLabel(activeAgent.state) : '已就绪 · 命令需审批'
              : '请先配置并测试 Provider'}</span>
            <button
              type="submit"
              disabled={!agentPrompt.trim() || defaultProvider?.status !== 'ready' || !activeTab || composerBlocked}
            >↑</button>
          </div>
        </form>
      </aside>

      {editingHost !== undefined && (
        <div className="modal-backdrop">
          <form className="modal" onSubmit={(event) => void saveHost(event)}>
            <div className="modal-header">
              <strong>{editingHost ? '编辑 SSH 主机' : '添加 SSH 主机'}</strong>
              <button type="button" onClick={() => setEditingHost(undefined)}>×</button>
            </div>
            <div className="form-grid">
              <label className="span-2">显示名称<input name="name" required defaultValue={editingHost?.name ?? 'Ubuntu 测试机'} /></label>
              <label className="span-2">主机名或 IP 地址<input name="hostname" required defaultValue={editingHost?.hostname ?? ''} /></label>
              <label>端口<input name="port" type="number" min="1" max="65535" required defaultValue={editingHost?.port ?? 22} /></label>
              <label>用户名<input name="username" required defaultValue={editingHost?.username ?? ''} /></label>
              <label className="span-2">认证方式
                <select name="authMethod" defaultValue={editingHost?.authMethod ?? 'password'}>
                  <option value="password">用户名和密码</option>
                  <option value="keyboard-interactive">键盘交互认证</option>
                  <option value="private-key">私钥</option>
                  <option value="agent">Windows OpenSSH / Pageant 代理</option>
                </select>
              </label>
              <label className="span-2">私钥路径（使用私钥时）<input name="privateKeyPath" defaultValue={editingHost?.privateKeyPath ?? ''} /></label>
              <label>分组<input name="group" defaultValue={editingHost?.group ?? ''} /></label>
              <label className="check-label"><input name="favorite" type="checkbox" defaultChecked={editingHost?.favorite} /> 收藏</label>
            </div>
            {connectionError && <div className="form-error">{connectionError}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setEditingHost(undefined)}>取消</button>
              <button className="primary" type="submit">保存主机</button>
            </div>
          </form>
        </div>
      )}

      {connectingHost && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={submitConnection}>
            <div className="modal-header">
              <strong>连接到 {connectingHost.name}</strong>
              <button type="button" onClick={() => {
                setConnectingHost(null);
                setReconnectingSessionId(null);
              }}>×</button>
            </div>
            <div className="connection-summary">{connectingHost.username}@{connectingHost.hostname}:{connectingHost.port}</div>
            {(connectingHost.authMethod === 'password' || connectingHost.authMethod === 'keyboard-interactive') && (
              <label>密码<input name="password" type="password" autoFocus autoComplete="off" /></label>
            )}
            {connectingHost.authMethod === 'private-key' && (
              <label>私钥口令<input name="passphrase" type="password" autoFocus autoComplete="off" /></label>
            )}
            <p className="secure-note">凭据仅用于本次连接，不会持久化保存。</p>
            {connectionError && <div className="form-error">{connectionError}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => {
                setConnectingHost(null);
                setReconnectingSessionId(null);
              }}>取消</button>
              <button className="primary" type="submit">连接</button>
            </div>
          </form>
        </div>
      )}

      {providerModalOpen && (
        <div className="modal-backdrop">
          <div className="modal provider-modal">
            <div className="modal-header">
              <strong>AI Provider 设置</strong>
              <button type="button" onClick={() => setProviderModalOpen(false)}>×</button>
            </div>
            <section className="codex-app-server-note">
              <strong>Codex App Server（尚未接入）</strong>
              <p>当前 Alpha 仅支持 OpenAI 兼容 API。下方“可用”只表示模型接口测试通过，不代表 Codex 或 ChatGPT 已登录；请勿在 API Key 输入框中粘贴 ChatGPT 登录凭据。</p>
              <small>后续将由主进程通过官方 <code>codex app-server</code> stdio 协议接入登录、Thread、流事件和审批。</small>
            </section>
            <div className="provider-layout">
              <div className="provider-list">
                {providers.map((provider) => (
                  <button
                    className={editingProvider?.id === provider.id ? 'active' : ''}
                    key={provider.id}
                    onClick={() => {
                      setEditingProvider(provider);
                      setProviderMessage(null);
                    }}
                  >
                    <strong>{provider.name}</strong>
                    <small>{provider.modelId}</small>
                    <span className={`provider-status ${provider.status}`}>{providerStatusLabel(provider.status)}</span>
                  </button>
                ))}
                <button className="add-provider" onClick={() => {
                  setEditingProvider(null);
                  setProviderMessage(null);
                }}>＋ 添加 Provider</button>
              </div>
              <form className="provider-form" onSubmit={(event) => void saveProvider(event)}>
                <label>名称<input name="name" required defaultValue={editingProvider?.name ?? 'OpenAI 兼容 API'} key={`name-${editingProvider?.id ?? 'new'}`} /></label>
                <label>基础 URL<input name="baseUrl" type="url" required placeholder="https://api.example.com/v1" defaultValue={editingProvider?.baseUrl ?? ''} key={`url-${editingProvider?.id ?? 'new'}`} /></label>
                <label>模型 ID<input name="modelId" required placeholder="model-id" defaultValue={editingProvider?.modelId ?? ''} key={`model-${editingProvider?.id ?? 'new'}`} /></label>
                <label>
                  API Key
                  <input
                    name="apiKey"
                    type="password"
                    required={!editingProvider?.apiKeyConfigured}
                    autoComplete="new-password"
                    placeholder={editingProvider?.apiKeyConfigured ? '已保存到 Windows 凭据管理器' : '必填'}
                  />
                </label>
                <label className="check-label">
                  <input name="makeDefault" type="checkbox" defaultChecked={editingProvider?.isDefault ?? providers.length === 0} />
                  设为默认 Provider
                </label>
                <p className="secure-note">API Key 作为 Windows 通用凭据保存；Provider JSON 只保存凭据引用。</p>
                {providerMessage && <div className="provider-message">{providerMessage}</div>}
                <div className="provider-actions">
                  {editingProvider && (
                    <>
                      <button type="button" onClick={() => void testProvider(editingProvider.id)}>测试连接</button>
                      {!editingProvider.isDefault && (
                        <button type="button" onClick={async () => {
                          await window.aiTerminal.providers.setDefault(editingProvider.id);
                          await refreshProviders();
                        }}>设为默认</button>
                      )}
                      <button className="danger-text" type="button" onClick={() => void removeProvider(editingProvider)}>删除</button>
                    </>
                  )}
                  <button className="primary" type="submit">保存 Provider</button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {activeAgent?.pendingTakeover && (
        <div className="modal-backdrop">
          <div
            className="modal compact-modal takeover-modal"
            data-terminal-id={activeAgent.terminalId}
            data-takeover-id={activeAgent.pendingTakeover.id}
            data-execution-id={activeAgent.pendingTakeover.executionId}
          >
            <div className="modal-header"><strong>人工接管终端</strong></div>
            <p>智能体已暂停。请选择如何处理仍在前台运行的命令。</p>
            <code>{activeAgent.activeExecution?.command ?? '前台命令'}</code>
            <div className="modal-actions split-actions">
              <button data-action="keep-process" onClick={() => void resolveAgentTakeover('keep')}>保持进程运行</button>
              <button className="danger-action" data-action="interrupt-process" onClick={() => void resolveAgentTakeover('interrupt')}>发送 Ctrl+C</button>
            </div>
          </div>
        </div>
      )}

      {fullTakeoverChallenge && (
        <div className="modal-backdrop">
          <div
            className="modal compact-modal full-takeover-modal"
            data-terminal-id={fullTakeoverChallenge.terminalId}
            data-approval-id={fullTakeoverChallenge.approvalId ?? ''}
          >
            <div className="modal-header"><strong>启用 AI 全接管？</strong></div>
            <p>
              目标：<b>{fullTakeoverChallenge.target}</b>。智能体将可以连续运行命令，包括删除、磁盘、网络、服务或重启命令，不再逐条询问。你仍可随时点击“人工接管”立即暂停智能体。
            </p>
            <p className="risk-note">
              {fullTakeoverChallenge.approvalId
                ? '确认后会立即执行下方命令；在关闭全接管或人工接管前，后续命令都不会再次询问。'
                : ''}
              仅对你信任的终端和任务启用。遇到认证提示时仍会暂停，并让你直接安全输入。
            </p>
            {fullTakeoverChallenge.command && (
              <code>{fullTakeoverChallenge.editedCommand ?? fullTakeoverChallenge.command}</code>
            )}
            <div className="modal-actions">
              <button autoFocus onClick={() => setFullTakeoverChallenge(null)}>取消</button>
              <button
                className="danger-action"
                data-action="confirm-full-takeover"
                onClick={() => void setFullTakeover(
                  true,
                  fullTakeoverChallenge.terminalId,
                  fullTakeoverChallenge.approvalId,
                  fullTakeoverChallenge.editedCommand,
                )}
              >{fullTakeoverChallenge.approvalId
                  ? '启用并执行当前命令'
                  : '启用 AI 全接管'}</button>
            </div>
          </div>
        </div>
      )}

      {trustChallenge && (
        <div className="modal-backdrop">
          <div className="modal compact-modal">
            <div className="modal-header"><strong>信任此 SSH 主机？</strong></div>
            <p>这是首次连接到 {trustChallenge.host.hostname}。继续前请核对服务器指纹。</p>
            <code className="fingerprint">{trustChallenge.fingerprint}</code>
            <div className="modal-actions">
              <button onClick={() => {
                setTrustChallenge(null);
                setReconnectingSessionId(null);
              }}>取消</button>
              <button className="primary" onClick={() => void establishSsh(
                trustChallenge.host,
                trustChallenge.secret,
                trustChallenge.fingerprint,
                trustChallenge.sessionId,
              )}>信任并连接</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
