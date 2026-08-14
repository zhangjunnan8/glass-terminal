import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

interface TerminalPaneProps {
  terminalId: string;
  active: boolean;
}

export function TerminalPane({ terminalId, active }: TerminalPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [hasOutput, setHasOutput] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: 'Cascadia Mono, Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 10_000,
      theme: {
        background: '#080c12',
        foreground: '#d7e0ed',
        cursor: '#6de6c3',
        cursorAccent: '#0b1018',
        selectionBackground: '#315f6d88',
        black: '#0a0f16',
        red: '#f07178',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#c0caf5',
        brightBlack: '#565f89',
      },
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
      void window.aiTerminal.terminal.write(terminalId, data);
    });
    const removeDataListener = window.aiTerminal.terminal.onData((event) => {
      if (event.terminalId !== terminalId) return;
      terminal.write(event.data);
      setHasOutput(true);
    });
    const removeExitListener = window.aiTerminal.terminal.onExit((event) => {
      if (event.terminalId !== terminalId) return;
      terminal.write(`\r\n\x1b[90m[Process exited with code ${event.exitCode}]\x1b[0m\r\n`);
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
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div
      className={`terminal-pane ${active ? 'active' : ''}`}
      data-terminal-id={terminalId}
      data-terminal-output={hasOutput ? 'true' : 'false'}
      ref={containerRef}
    />
  );
}
