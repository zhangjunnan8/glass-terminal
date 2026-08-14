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
        if (profiles.length === 0) throw new Error('No supported shell was detected.');
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
      setProviderMessage('Saved. Run Test Connection before using this Provider.');
    } catch (error) {
      setProviderMessage(errorMessage(error));
    }
  }

  async function testProvider(providerId: string) {
    setProviderMessage('Testing connection…');
    try {
      const result = await window.aiTerminal.providers.testConnection(providerId);
      await refreshProviders();
      setProviderMessage(result.message);
    } catch (error) {
      setProviderMessage(errorMessage(error));
    }
  }

  async function removeProvider(provider: ProviderProfile) {
    if (!window.confirm(`Delete Provider “${provider.name}” and its stored credential?`)) return;
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
    const name = window.prompt('Session name', session.name);
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
    if (!window.confirm(`Delete host “${host.name}”?`)) return;
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
    <div className="app-shell">
      <header className="titlebar">
        <div className="brand-mark" aria-hidden="true">&gt;_</div>
        <div className="brand-copy">
          <strong>{PRODUCT_NAME}</strong>
          <span>shared terminal agent</span>
        </div>
        <div className="workspace-title">Local workspace</div>
        <div className="runtime-pill">
          <span className="status-dot" />
          {runtime ? `${runtime.platform} · ${runtime.arch}` : 'starting…'}
        </div>
      </header>

      <aside className="activitybar" aria-label="Primary navigation">
        <button className="activity active" title="Terminals">⌁</button>
        <button className="activity" title="Hosts">▦</button>
        <button
          className={`activity ${sftpOpen ? 'active' : ''}`}
          title="SFTP files and transfers"
          onClick={() => setSftpOpen((open) => !open)}
        >⇅</button>
        <button className="activity" title="History">◷</button>
        <div className="activity-spacer" />
        <button className="activity" title="Provider settings" onClick={() => {
          setEditingProvider(defaultProvider);
          setProviderMessage(null);
          setProviderModalOpen(true);
        }}>⚙</button>
      </aside>

      <aside className="sidebar">
        <div className="panel-heading">
          <span>TERMINALS</span>
          <button title="Add SSH host" onClick={() => setEditingHost(null)}>＋</button>
        </div>
        <label className="search-box">
          <span>⌕</span>
          <input aria-label="Search hosts and shells" placeholder="Search hosts and shells" />
        </label>

        <div className="section-label">LOCAL SHELLS</div>
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
          <span>SSH HOSTS</span>
          <button onClick={() => setEditingHost(null)}>Add</button>
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
          {hosts.length === 0 && <div className="empty-list">No SSH hosts yet</div>}
        </div>

        {selectedHost && (
          <div className="selected-host-card">
            <strong>{selectedHost.name}</strong>
            <span>{selectedHost.authMethod} · {selectedHost.hostKeyFingerprint ? 'trusted' : 'unverified'}</span>
            <div>
              <button onClick={() => {
                setReconnectingSessionId(null);
                setConnectingHost(selectedHost);
              }}>Connect</button>
              <button onClick={() => setEditingHost(selectedHost)}>Edit</button>
              <button className="danger-text" onClick={() => void removeHost(selectedHost)}>Delete</button>
            </div>
            <div className="host-session-history">
              <small>SESSION HISTORY</small>
              {selectedHostSessions.map((session) => (
                <div className="session-history-row" key={session.id}>
                  <span>
                    <strong>{session.name}</strong>
                    <small>{session.status} · {new Date(session.updatedAt).toLocaleString()}</small>
                  </span>
                  <span className="session-history-actions">
                    <button title="Rename Session" onClick={() => void renameSession(session)}>Rename</button>
                    <button onClick={() => {
                      setReconnectingSessionId(session.id);
                      setConnectingHost(selectedHost);
                    }}>Reconnect</button>
                  </span>
                </div>
              ))}
              {selectedHostSessions.length === 0 && <small>No formal Sessions yet.</small>}
            </div>
          </div>
        )}
        <div className="sidebar-footer">No telemetry · Passwords stay in memory</div>
      </aside>

      <main className="workspace">
        <nav className="tabs" aria-label="Terminal tabs">
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
            <button className="new-tab" title="New terminal" onClick={() => setNewTerminalOpen((open) => !open)}>＋</button>
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
              {activeAgent?.state.replaceAll('_', ' ') ?? 'USER CONTROL'}
              {activeAgent?.fullTakeover ? ' · FULL TAKEOVER' : ''}
            </span>
            <div className="terminal-actions">
              <span>{activeTab?.status === 'exited' ? 'DISCONNECTED' : activeTab?.transport.toUpperCase() ?? 'NO TERMINAL'}</span>
              {activeTab?.status === 'exited' && activeTab.hostId && (
                <button onClick={() => {
                  const host = hosts.find((item) => item.id === activeTab.hostId);
                  if (host) {
                    setReconnectingSessionId(activeTab.sessionId ?? null);
                    setConnectingHost(host);
                  }
                }}>Reconnect</button>
              )}
              <button title="Search terminal">⌕</button>
              <button title="Terminal actions">⋯</button>
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
              <div className="terminal-placeholder">Choose a local shell or SSH host to open a terminal.</div>
            )}
            {startupError && <div className="terminal-error">{startupError}</div>}
          </div>
          <footer className="terminal-statusbar">
            <span>UTF-8</span>
            <span>{activeTab?.transport === 'ssh' ? 'SSH PTY' : 'ConPTY'}</span>
            <span>{activeTab?.sessionId ? 'Formal Session' : 'Temporary terminal'}</span>
          </footer>
        </section>
        {sftpOpen && <SftpDrawer terminal={activeTab} onClose={() => setSftpOpen(false)} />}
      </main>

      <aside className="agent-panel">
        <div className="agent-header">
          <div>
            <strong>AI Agent</strong>
            <span>
              Current Provider: {defaultProvider
                ? `${defaultProvider.name} · ${defaultProvider.status}`
                : 'Not configured'}
            </span>
          </div>
          <div className="agent-controls">
            {activeAgent?.fullTakeover && <span className="takeover-badge">FULL TAKEOVER</span>}
            <button
              className="take-control"
              disabled={!agentTurnBusy(activeAgent?.state) || activeAgent?.state === 'TAKEOVER_PENDING'}
              onClick={() => void requestAgentTakeover()}
            >Take Control</button>
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
            >{activeAgent?.fullTakeover ? 'Disable' : 'Full Takeover'}</button>
          </div>
        </div>
        <div className="agent-body">
          {!activeAgent?.messages.length && (
            <div className="agent-empty">
              <div className="agent-glyph">✦</div>
              <strong>Terminal-aware assistance</strong>
              <p>The agent reads this Session and asks before sending every command into the visible terminal.</p>
              <div className="guardrail"><span>✓</span> Approval required by default</div>
              <button className="provider-configure" onClick={() => {
                setEditingProvider(defaultProvider);
                setProviderMessage(null);
                setProviderModalOpen(true);
              }}>
                {defaultProvider ? 'Manage Provider' : 'Configure Provider'}
              </button>
              {activeTab && !activeTab.sessionId && (
                <button className="activate-session" onClick={() => void activateAiSession()}>
                  Activate AI Session
                </button>
              )}
            </div>
          )}
          {activeAgent?.messages.map((message) => (
            <article className={`agent-message ${message.role}`} key={message.id}>
              <span>{message.role === 'assistant' ? 'AI' : message.role.toUpperCase()}</span>
              <p>{message.content}</p>
            </article>
          ))}
          {activeAgent?.pendingApproval?.status === 'waiting' && (
            <section className="approval-card">
              <div>
                <strong>Command approval</strong>
                <span>{activeAgent.pendingApproval.reason ?? 'Agent requested terminal execution'}</span>
              </div>
              <textarea
                aria-label="Proposed command"
                value={editedApprovalCommand}
                onChange={(event) => setEditedApprovalCommand(event.target.value)}
                spellCheck={false}
              />
              <div className="approval-actions">
                <button onClick={() => void resolveAgentApproval('reject')}>Reject</button>
                <button onClick={() => void resolveAgentApproval('edit')}>Edit &amp; Execute</button>
                <button onClick={() => {
                  if (!activeTab || !activeAgent.pendingApproval) return;
                  setFullTakeoverChallenge({
                    terminalId: activeTab.id,
                    target: activeTab.title,
                    approvalId: activeAgent.pendingApproval.id,
                    command: activeAgent.pendingApproval.command,
                    editedCommand: editedApprovalCommand,
                  });
                }}>Switch to Full Takeover…</button>
                <button className="execute" onClick={() => void resolveAgentApproval('execute')}>Execute</button>
              </div>
            </section>
          )}
          {activeAgent?.authRequest && (
            <section className="auth-card" data-auth-interaction={activeAgent.authRequest.id}>
              <strong>Authentication required</strong>
              <p>Type the credential directly in this terminal and press Enter. The Agent resumes automatically. Input after the first Enter is discarded, and the credential is excluded from AI context, Session log, structured output, and Audit.</p>
            </section>
          )}
          {activeAgent?.activeExecution && (
            <section className={`execution-card ${activeAgent.activeExecution.status}`}>
              <strong>{activeAgent.activeExecution.status.toUpperCase()}</strong>
              <code>{activeAgent.activeExecution.command}</code>
              {activeAgent.activeExecution.exitCode !== undefined && (
                <span>exit {activeAgent.activeExecution.exitCode} · {activeAgent.activeExecution.durationMs ?? 0} ms</span>
              )}
              {activeAgent.state === 'PAUSED'
                && activeAgent.activeExecution.status === 'running'
                && activeAgent.activeExecution.interruptRequestedAt && (
                <button onClick={() => void confirmShellReady(
                  activeAgent.terminalId,
                  activeAgent.activeExecution!.id,
                )}>I can see the shell prompt · release tracking</button>
              )}
            </section>
          )}
          {activeAgent?.error && <div className="agent-error">{activeAgent.error}</div>}
        </div>
        <form className="composer" onSubmit={(event) => void sendAgentPrompt(event)}>
          <textarea
            aria-label="Message AI"
            placeholder="Ask the agent to inspect or operate this terminal…"
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
            disabled={defaultProvider?.status !== 'ready' || !activeTab || activeTab.status !== 'connected' || composerBlocked}
          />
          <div>
            <span>{defaultProvider?.status === 'ready'
              ? activeAgent?.state.replaceAll('_', ' ') ?? 'Ready · approval required'
              : 'Configure and test a Provider to begin'}</span>
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
              <strong>{editingHost ? 'Edit SSH Host' : 'Add SSH Host'}</strong>
              <button type="button" onClick={() => setEditingHost(undefined)}>×</button>
            </div>
            <div className="form-grid">
              <label className="span-2">Display name<input name="name" required defaultValue={editingHost?.name ?? 'Ubuntu Lab'} /></label>
              <label className="span-2">Hostname or IP<input name="hostname" required defaultValue={editingHost?.hostname ?? ''} /></label>
              <label>Port<input name="port" type="number" min="1" max="65535" required defaultValue={editingHost?.port ?? 22} /></label>
              <label>Username<input name="username" required defaultValue={editingHost?.username ?? ''} /></label>
              <label className="span-2">Authentication
                <select name="authMethod" defaultValue={editingHost?.authMethod ?? 'password'}>
                  <option value="password">Username + password</option>
                  <option value="keyboard-interactive">Keyboard interactive</option>
                  <option value="private-key">Private key</option>
                  <option value="agent">Windows OpenSSH / Pageant agent</option>
                </select>
              </label>
              <label className="span-2">Private key path (when used)<input name="privateKeyPath" defaultValue={editingHost?.privateKeyPath ?? ''} /></label>
              <label>Group<input name="group" defaultValue={editingHost?.group ?? ''} /></label>
              <label className="check-label"><input name="favorite" type="checkbox" defaultChecked={editingHost?.favorite} /> Favorite</label>
            </div>
            {connectionError && <div className="form-error">{connectionError}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setEditingHost(undefined)}>Cancel</button>
              <button className="primary" type="submit">Save Host</button>
            </div>
          </form>
        </div>
      )}

      {connectingHost && (
        <div className="modal-backdrop">
          <form className="modal compact-modal" onSubmit={submitConnection}>
            <div className="modal-header">
              <strong>Connect to {connectingHost.name}</strong>
              <button type="button" onClick={() => {
                setConnectingHost(null);
                setReconnectingSessionId(null);
              }}>×</button>
            </div>
            <div className="connection-summary">{connectingHost.username}@{connectingHost.hostname}:{connectingHost.port}</div>
            {(connectingHost.authMethod === 'password' || connectingHost.authMethod === 'keyboard-interactive') && (
              <label>Password<input name="password" type="password" autoFocus autoComplete="off" /></label>
            )}
            {connectingHost.authMethod === 'private-key' && (
              <label>Private-key passphrase<input name="passphrase" type="password" autoFocus autoComplete="off" /></label>
            )}
            <p className="secure-note">The credential is used for this connection only and is not persisted.</p>
            {connectionError && <div className="form-error">{connectionError}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => {
                setConnectingHost(null);
                setReconnectingSessionId(null);
              }}>Cancel</button>
              <button className="primary" type="submit">Connect</button>
            </div>
          </form>
        </div>
      )}

      {providerModalOpen && (
        <div className="modal-backdrop">
          <div className="modal provider-modal">
            <div className="modal-header">
              <strong>AI Providers</strong>
              <button type="button" onClick={() => setProviderModalOpen(false)}>×</button>
            </div>
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
                    <span className={`provider-status ${provider.status}`}>{provider.status}</span>
                  </button>
                ))}
                <button className="add-provider" onClick={() => {
                  setEditingProvider(null);
                  setProviderMessage(null);
                }}>+ Add Provider</button>
              </div>
              <form className="provider-form" onSubmit={(event) => void saveProvider(event)}>
                <label>Name<input name="name" required defaultValue={editingProvider?.name ?? 'OpenAI-compatible API'} key={`name-${editingProvider?.id ?? 'new'}`} /></label>
                <label>Base URL<input name="baseUrl" type="url" required placeholder="https://api.example.com/v1" defaultValue={editingProvider?.baseUrl ?? ''} key={`url-${editingProvider?.id ?? 'new'}`} /></label>
                <label>Model ID<input name="modelId" required placeholder="model-id" defaultValue={editingProvider?.modelId ?? ''} key={`model-${editingProvider?.id ?? 'new'}`} /></label>
                <label>
                  API key
                  <input
                    name="apiKey"
                    type="password"
                    required={!editingProvider?.apiKeyConfigured}
                    autoComplete="new-password"
                    placeholder={editingProvider?.apiKeyConfigured ? 'Stored in Windows Credential Manager' : 'Required'}
                  />
                </label>
                <label className="check-label">
                  <input name="makeDefault" type="checkbox" defaultChecked={editingProvider?.isDefault ?? providers.length === 0} />
                  Use as default Provider
                </label>
                <p className="secure-note">The API key is stored as a Windows Generic Credential. Provider JSON contains only its reference.</p>
                {providerMessage && <div className="provider-message">{providerMessage}</div>}
                <div className="provider-actions">
                  {editingProvider && (
                    <>
                      <button type="button" onClick={() => void testProvider(editingProvider.id)}>Test Connection</button>
                      {!editingProvider.isDefault && (
                        <button type="button" onClick={async () => {
                          await window.aiTerminal.providers.setDefault(editingProvider.id);
                          await refreshProviders();
                        }}>Set Default</button>
                      )}
                      <button className="danger-text" type="button" onClick={() => void removeProvider(editingProvider)}>Delete</button>
                    </>
                  )}
                  <button className="primary" type="submit">Save Provider</button>
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
            <div className="modal-header"><strong>Take control of the terminal</strong></div>
            <p>The Agent is paused. Choose what to do with the command that is still in the foreground.</p>
            <code>{activeAgent.activeExecution?.command ?? 'Foreground command'}</code>
            <div className="modal-actions split-actions">
              <button onClick={() => void resolveAgentTakeover('keep')}>Keep process running</button>
              <button className="danger-action" onClick={() => void resolveAgentTakeover('interrupt')}>Send Ctrl+C</button>
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
            <div className="modal-header"><strong>Enable Full Takeover?</strong></div>
            <p>
              Target: <b>{fullTakeoverChallenge.target}</b>. The Agent may run consecutive commands—including deletion, disk, network, service, or restart commands—without asking again. Take Control remains available and immediately pauses the Agent.
            </p>
            <p className="risk-note">
              {fullTakeoverChallenge.approvalId
                ? 'Confirming immediately executes the command below; later commands in this terminal will not ask again until Full Takeover is disabled or you Take Control. '
                : ''}
              Only enable this for a terminal and task you trust. Authentication still pauses for direct secure input.
            </p>
            {fullTakeoverChallenge.command && (
              <code>{fullTakeoverChallenge.editedCommand ?? fullTakeoverChallenge.command}</code>
            )}
            <div className="modal-actions">
              <button autoFocus onClick={() => setFullTakeoverChallenge(null)}>Cancel</button>
              <button
                className="danger-action"
                onClick={() => void setFullTakeover(
                  true,
                  fullTakeoverChallenge.terminalId,
                  fullTakeoverChallenge.approvalId,
                  fullTakeoverChallenge.editedCommand,
                )}
              >{fullTakeoverChallenge.approvalId
                  ? 'Enable & execute this command'
                  : 'Enable Full Takeover'}</button>
            </div>
          </div>
        </div>
      )}

      {trustChallenge && (
        <div className="modal-backdrop">
          <div className="modal compact-modal">
            <div className="modal-header"><strong>Trust this SSH host?</strong></div>
            <p>This is the first connection to {trustChallenge.host.hostname}. Verify the server fingerprint before continuing.</p>
            <code className="fingerprint">{trustChallenge.fingerprint}</code>
            <div className="modal-actions">
              <button onClick={() => {
                setTrustChallenge(null);
                setReconnectingSessionId(null);
              }}>Cancel</button>
              <button className="primary" onClick={() => void establishSsh(
                trustChallenge.host,
                trustChallenge.secret,
                trustChallenge.fingerprint,
                trustChallenge.sessionId,
              )}>Trust &amp; Connect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
