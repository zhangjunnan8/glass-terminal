import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalInputMode } from '../../shared/agent';
import { terminalTheme } from '../terminal-theme';
import type { UiTheme } from '../theme';
import {
  positionTerminalContextMenu,
  terminalPasteAllowed,
  terminalShortcutAction,
} from '../terminal-shortcuts';

interface TerminalPaneProps {
  terminalId: string;
  active: boolean;
  inputMode: TerminalInputMode;
  uiTheme: UiTheme;
}

export function TerminalPane({
  terminalId,
  active,
  inputMode,
  uiTheme,
}: TerminalPaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const inputModeRef = useRef(inputMode);
  const [hasOutput, setHasOutput] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    left: number;
    top: number;
    canCopy: boolean;
  } | null>(null);
  const isInputLocked = () => !terminalPasteAllowed(inputModeRef.current);

  const copySelection = () => {
    const terminal = terminalRef.current;
    const selection = terminal?.getSelection() ?? '';
    if (!selection) return;
    void window.aiTerminal.terminal.writeClipboardText(selection).catch(() => undefined);
  };

  const pasteClipboard = async () => {
    if (isInputLocked()) return;
    try {
      const text = await window.aiTerminal.terminal.readClipboardText();
      if (!text || isInputLocked()) return;
      terminalRef.current?.paste(text);
    } catch {
      // Clipboard access can fail transiently while another Windows process owns it.
    }
  };

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      disableStdin: inputModeRef.current === 'locked',
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'Cascadia Mono, Cascadia Code, Consolas, "Microsoft YaHei UI", "Microsoft YaHei", monospace',
      fontSize: 15,
      lineHeight: 1.28,
      scrollback: 10_000,
      theme: terminalTheme(uiTheme),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;

    const fit = () => {
      if (!containerRef.current || containerRef.current.clientWidth === 0) return;
      try {
        fitAddon.fit();
        void window.aiTerminal.terminal.resize(terminalId, terminal.cols, terminal.rows);
      } catch {
        // A closing tab can race with its final ResizeObserver callback.
      }
    };
    const frame = requestAnimationFrame(fit);
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(containerRef.current);

    const inputDisposable = terminal.onData((data) => {
      if (inputModeRef.current === 'locked') return;
      let submitted = data;
      if (inputModeRef.current === 'secure-human') {
        const newlineIndex = data.search(/[\r\n]/);
        if (newlineIndex >= 0) {
          submitted = `${data.slice(0, newlineIndex)}\r`;
          inputModeRef.current = 'locked';
          terminal.options.disableStdin = true;
        }
      }
      void window.aiTerminal.terminal.write(terminalId, submitted).catch(() => undefined);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const action = terminalShortcutAction(event);
      if (!action) return true;
      event.preventDefault();
      if (action === 'copy') copySelection();
      else void pasteClipboard();
      return false;
    });
    const removeDataListener = window.aiTerminal.terminal.onData(terminalId, (event) => {
      terminal.write(event.data);
      setHasOutput(true);
    });
    const removeExitListener = window.aiTerminal.terminal.onExit(terminalId, (event) => {
      terminal.write(`\r\n\x1b[90m[进程已退出，退出码 ${event.exitCode}]\x1b[0m\r\n`);
    });
    void window.aiTerminal.terminal.attach(terminalId).then((pendingOutput) => {
      if (!pendingOutput) return;
      terminal.write(pendingOutput);
      setHasOutput(true);
    });

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      removeDataListener();
      removeExitListener();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = terminalTheme(uiTheme);
  }, [uiTheme]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
    };
    const dismissOnBlur = () => setContextMenu(null);
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('blur', dismissOnBlur);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('blur', dismissOnBlur);
    };
  }, [contextMenu]);

  useEffect(() => {
    inputModeRef.current = inputMode;
    if (terminalRef.current) terminalRef.current.options.disableStdin = inputMode === 'locked';
    if (active && inputMode === 'secure-human') terminalRef.current?.focus();
  }, [active, inputMode]);

  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  useEffect(() => {
    if (!active) setContextMenu(null);
  }, [active]);

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const pane = paneRef.current;
    const terminal = terminalRef.current;
    if (!pane || !terminal) return;
    const bounds = pane.getBoundingClientRect();
    setContextMenu({
      ...positionTerminalContextMenu(
        event.clientX - bounds.left,
        event.clientY - bounds.top,
        bounds.width,
        bounds.height,
      ),
      canCopy: terminal.hasSelection(),
    });
  };

  const performMenuAction = (action: 'copy' | 'paste' | 'select-all' | 'clear') => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (action === 'copy') copySelection();
    if (action === 'paste') void pasteClipboard();
    if (action === 'select-all') terminal.selectAll();
    if (action === 'clear') terminal.clear();
    setContextMenu(null);
    terminal.focus();
  };

  return (
    <div
      className={`terminal-pane ${active ? 'active' : ''}`}
      data-terminal-id={terminalId}
      data-terminal-output={hasOutput ? 'true' : 'false'}
      data-input-mode={inputMode}
      onContextMenu={openContextMenu}
      ref={paneRef}
    >
      <div className="terminal-surface" ref={containerRef} />
      {contextMenu ? (
        <div
          aria-label="终端菜单"
          className="terminal-context-menu"
          onContextMenu={(event) => event.preventDefault()}
          ref={contextMenuRef}
          role="menu"
          style={{ left: contextMenu.left, top: contextMenu.top }}
        >
          <button
            disabled={!contextMenu.canCopy}
            onClick={() => performMenuAction('copy')}
            role="menuitem"
            type="button"
          >
            <span>复制</span><kbd>Ctrl+Shift+C</kbd>
          </button>
          <button
            disabled={inputMode === 'locked'}
            onClick={() => performMenuAction('paste')}
            role="menuitem"
            type="button"
          >
            <span>粘贴</span><kbd>Ctrl+Shift+V</kbd>
          </button>
          <div className="terminal-context-separator" role="separator" />
          <button onClick={() => performMenuAction('select-all')} role="menuitem" type="button">
            <span>全选</span>
          </button>
          <button onClick={() => performMenuAction('clear')} role="menuitem" type="button">
            <span>清空终端</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
