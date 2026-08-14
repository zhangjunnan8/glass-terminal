import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { HostInput, HostProfile } from '../shared/host';
import type { RuntimeInfo } from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';
import type { ShellProfile, TerminalDescriptor } from '../shared/terminal';
import { TerminalPane } from './components/TerminalPane';

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
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<HostProfile | null | undefined>(undefined);
  const [connectingHost, setConnectingHost] = useState<HostProfile | null>(null);
  const [trustChallenge, setTrustChallenge] = useState<TrustChallenge | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    void window.aiTerminal.runtime.getInfo().then(setRuntime);
    void window.aiTerminal.hosts.list().then(setHosts).catch((error) => {
      setStartupError(errorMessage(error));
    });
    const removeExitListener = window.aiTerminal.terminal.onExit((event) => {
      setTabs((current) => current.map((tab) => (
        tab.id === event.terminalId ? { ...tab, status: 'exited' } : tab
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
  ) {
    setConnectionError(null);
    try {
      const result = await window.aiTerminal.terminal.connectSsh({
        hostId: host.id,
        ...secret,
        trustHostKey,
      });
      if (result.status === 'host-key-required') {
        setTrustChallenge({ host, fingerprint: result.fingerprint, secret });
        setConnectingHost(null);
        return;
      }
      addTab(result.terminal);
      setConnectingHost(null);
      setTrustChallenge(null);
      await refreshHosts();
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
        <button className="activity" title="Transfers">⇅</button>
        <button className="activity" title="History">◷</button>
        <div className="activity-spacer" />
        <button className="activity" title="Settings">⚙</button>
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
            <small>Sessions appear here after Milestone 3.</small>
            <div>
              <button onClick={() => setConnectingHost(selectedHost)}>Connect</button>
              <button onClick={() => setEditingHost(selectedHost)}>Edit</button>
              <button className="danger-text" onClick={() => void removeHost(selectedHost)}>Delete</button>
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

        <section className="terminal-stage">
          <div className="terminal-toolbar">
            <span>USER CONTROL</span>
            <div className="terminal-actions">
              <span>{activeTab?.status === 'exited' ? 'DISCONNECTED' : activeTab?.transport.toUpperCase() ?? 'NO TERMINAL'}</span>
              {activeTab?.status === 'exited' && activeTab.hostId && (
                <button onClick={() => {
                  const host = hosts.find((item) => item.id === activeTab.hostId);
                  if (host) setConnectingHost(host);
                }}>Reconnect</button>
              )}
              <button title="Search terminal">⌕</button>
              <button title="Terminal actions">⋯</button>
            </div>
          </div>
          <div className="terminal-stack">
            {tabs.map((tab) => (
              <TerminalPane key={tab.id} terminalId={tab.id} active={tab.id === activeId} />
            ))}
            {tabs.length === 0 && !startupError && (
              <div className="terminal-placeholder">Choose a local shell or SSH host to open a terminal.</div>
            )}
            {startupError && <div className="terminal-error">{startupError}</div>}
          </div>
          <footer className="terminal-statusbar">
            <span>UTF-8</span>
            <span>{activeTab?.transport === 'ssh' ? 'SSH PTY' : 'ConPTY'}</span>
            <span>Temporary terminal</span>
          </footer>
        </section>
      </main>

      <aside className="agent-panel">
        <div className="agent-header">
          <div>
            <strong>AI Agent</strong>
            <span>Current Provider: Not configured</span>
          </div>
          <button aria-label="Collapse agent panel">›</button>
        </div>
        <div className="agent-empty">
          <div className="agent-glyph">✦</div>
          <strong>Terminal-aware assistance</strong>
          <p>When activated, the agent reads this terminal and requests permission before sending commands.</p>
          <div className="guardrail"><span>✓</span> Approval required by default</div>
        </div>
        <div className="composer">
          <textarea aria-label="Message AI" placeholder="Ask about this terminal…" disabled />
          <div>
            <span>Configure a provider to begin</span>
            <button disabled>↑</button>
          </div>
        </div>
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
              <button type="button" onClick={() => setConnectingHost(null)}>×</button>
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
              <button type="button" onClick={() => setConnectingHost(null)}>Cancel</button>
              <button className="primary" type="submit">Connect</button>
            </div>
          </form>
        </div>
      )}

      {trustChallenge && (
        <div className="modal-backdrop">
          <div className="modal compact-modal">
            <div className="modal-header"><strong>Trust this SSH host?</strong></div>
            <p>This is the first connection to {trustChallenge.host.hostname}. Verify the server fingerprint before continuing.</p>
            <code className="fingerprint">{trustChallenge.fingerprint}</code>
            <div className="modal-actions">
              <button onClick={() => setTrustChallenge(null)}>Cancel</button>
              <button className="primary" onClick={() => void establishSsh(
                trustChallenge.host,
                trustChallenge.secret,
                trustChallenge.fingerprint,
              )}>Trust &amp; Connect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
