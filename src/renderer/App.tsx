import { useEffect, useMemo, useState } from 'react';
import type { RuntimeInfo } from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';
import type { ShellProfile, TerminalDescriptor } from '../shared/terminal';
import { TerminalPane } from './components/TerminalPane';

interface TerminalTab extends TerminalDescriptor {
  createdAt: number;
}
export function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  const [shells, setShells] = useState<ShellProfile[]>([]);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [newTerminalOpen, setNewTerminalOpen] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);

  useEffect(() => {
    void window.aiTerminal.runtime.getInfo().then(setRuntime);
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
        setTabs([{ ...descriptor, createdAt: Date.now() }]);
        setActiveId(descriptor.id);
      })
      .catch((error: unknown) => {
        setStartupError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? null,
    [activeId, tabs],
  );

  async function openTerminal(profileId: string) {
    setNewTerminalOpen(false);
    try {
      const descriptor = await window.aiTerminal.terminal.create({ profileId });
      const tab = { ...descriptor, createdAt: Date.now() };
      setTabs((current) => [...current, tab]);
      setActiveId(tab.id);
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : String(error));
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
          <span>NEW TERMINAL</span>
          <button title="Refresh shells" onClick={() => window.aiTerminal.terminal.listShells().then(setShells)}>↻</button>
        </div>
        <label className="search-box">
          <span>⌕</span>
          <input aria-label="Search shells" placeholder="Search shells" />
        </label>
        <div className="section-label">DETECTED SHELLS</div>
        <div className="host-list">
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
        <div className="sidebar-footer">No telemetry · Local-first</div>
      </aside>

      <main className="workspace">
        <nav className="tabs" aria-label="Terminal tabs">
          {tabs.map((tab) => (
            <button
              className={`tab ${tab.id === activeId ? 'active' : ''}`}
              key={tab.id}
              onClick={() => setActiveId(tab.id)}
            >
              <span className="tab-state" />
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
              <span>{activeTab?.shellKind.toUpperCase() ?? 'NO TERMINAL'}</span>
              <button title="Search terminal">⌕</button>
              <button title="Terminal actions">⋯</button>
            </div>
          </div>
          <div className="terminal-stack">
            {tabs.map((tab) => (
              <TerminalPane key={tab.id} terminalId={tab.id} active={tab.id === activeId} />
            ))}
            {tabs.length === 0 && !startupError && (
              <div className="terminal-placeholder">Choose a detected shell to open a terminal.</div>
            )}
            {startupError && <div className="terminal-error">{startupError}</div>}
          </div>
          <footer className="terminal-statusbar">
            <span>UTF-8</span>
            <span>ConPTY</span>
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
    </div>
  );
}
