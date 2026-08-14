import { useEffect, useState } from 'react';
import type { RuntimeInfo } from '../shared/ipc';
import { PRODUCT_NAME } from '../shared/product';

const hosts = [
  { name: 'Local', meta: 'Shells discovered at runtime', active: true },
  { name: 'Ubuntu Lab', meta: 'Add an SSH host in Milestone 2', active: false },
];

export function App() {
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    void window.aiTerminal.runtime.getInfo().then(setRuntime);
  }, []);

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
          <button title="New terminal">＋</button>
        </div>
        <label className="search-box">
          <span>⌕</span>
          <input aria-label="Search hosts" placeholder="Search hosts" />
        </label>
        <div className="section-label">LOCAL &amp; SSH</div>
        <div className="host-list">
          {hosts.map((host) => (
            <button className={`host-row ${host.active ? 'active' : ''}`} key={host.name}>
              <span className="host-icon">{host.active ? '⌘' : '◈'}</span>
              <span>
                <strong>{host.name}</strong>
                <small>{host.meta}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">No telemetry · Local-first</div>
      </aside>

      <main className="workspace">
        <nav className="tabs" aria-label="Terminal tabs">
          <button className="tab active">
            <span className="tab-state" />
            PowerShell
            <span className="tab-close">×</span>
          </button>
          <button className="new-tab" title="New terminal">＋</button>
        </nav>

        <section className="terminal-stage">
          <div className="terminal-toolbar">
            <span>USER CONTROL</span>
            <div className="terminal-actions">
              <button>⌕</button>
              <button>⋯</button>
            </div>
          </div>
          <div className="terminal-placeholder">
            <div className="prompt-line">
              <span className="prompt-symbol">PS</span>
              <span className="prompt-path"> C:\Users\demo&gt;</span>
              <span className="cursor" />
            </div>
            <p>Terminal transport arrives in Milestone 1.</p>
          </div>
          <footer className="terminal-statusbar">
            <span>UTF-8</span>
            <span>80 × 24</span>
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
