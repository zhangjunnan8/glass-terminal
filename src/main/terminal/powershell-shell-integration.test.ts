import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import * as pty from 'node-pty';
import { Terminal as XtermTerminal } from '@xterm/xterm';
import {
  encodePowerShellShellIntegrationValue,
  type PowerShellShellIntegrationEvent,
  PowerShellShellIntegrationParser,
  powerShellShellIntegrationArgs,
  powerShellShellIntegrationEncodedCommand,
  powerShellShellIntegrationSequence,
  remotePowerShellShellIntegrationCommand,
} from './powershell-shell-integration';

const NONCE = '0123456789abcdef0123456789abcdef';

describe('PowerShell shell integration bootstrap', () => {
  it('installs session-only lifecycle hooks without printable command envelopes', () => {
    const encoded = powerShellShellIntegrationEncodedCommand(NONCE);
    const script = Buffer.from(encoded, 'base64').toString('utf16le');

    expect(script).toContain('Global:PSConsoleHostReadLine');
    expect(script).toContain('Global:Prompt');
    expect(script).toContain('633;GlassTerminal;1');
    expect(script).toContain(NONCE);
    expect(script).not.toContain('__AI_TERMINAL_');
    expect(script).not.toContain('$PROFILE');
  });

  it('keeps the launched local and remote PowerShell sessions interactive', () => {
    const args = powerShellShellIntegrationArgs(['-NoLogo'], NONCE);
    expect(args.slice(0, 3)).toEqual(['-NoLogo', '-NoExit', '-EncodedCommand']);
    expect(args[3]).toBe(powerShellShellIntegrationEncodedCommand(NONCE));

    const remote = remotePowerShellShellIntegrationCommand(NONCE);
    expect(remote).toContain('(Get-Process -Id $PID).Path');
    expect(remote).toContain('-NoLogo -NoExit -EncodedCommand');
    expect(remote).not.toContain('__AI_TERMINAL_');
  });
});

describe('PowerShell shell integration parser', () => {
  it('extracts split lifecycle events while preserving ordinary VT data exactly', () => {
    const command = 'Write-Output "你好"';
    const cwd = 'C:\\项目\\终端';
    const stream = [
      '\x1b[32m(base) PS C:\\> ',
      powerShellShellIntegrationSequence(
        NONCE,
        'R',
        '1',
        encodePowerShellShellIntegrationValue('5.1.22621.2506'),
      ),
      powerShellShellIntegrationSequence(
        NONCE,
        'E',
        '7',
        encodePowerShellShellIntegrationValue(command),
      ),
      powerShellShellIntegrationSequence(NONCE, 'C', '7'),
      '进度 10%\r进度 100%\r\n',
      powerShellShellIntegrationSequence(NONCE, 'D', '7', '0'),
      powerShellShellIntegrationSequence(
        NONCE,
        'P',
        encodePowerShellShellIntegrationValue(cwd),
      ),
      '\x1b[0m(base) PS C:\\> ',
    ].join('');
    const parser = new PowerShellShellIntegrationParser(NONCE);
    const parts = [];
    for (const character of stream) parts.push(...parser.push(character));

    expect(parts.filter((part) => part.kind === 'event').map((part) => (
      part.kind === 'event' ? part.event : undefined
    ))).toEqual([
      { kind: 'ready', rich: true, powerShellVersion: '5.1.22621.2506' },
      { kind: 'command', commandId: 7, command },
      { kind: 'start', commandId: 7 },
      { kind: 'end', commandId: 7, exitCode: 0 },
      { kind: 'cwd', cwd },
    ]);
    expect(parts.filter((part) => part.kind === 'data').map((part) => (
      part.kind === 'data' ? part.data : ''
    )).join('')).toBe(
      '\x1b[32m(base) PS C:\\> \u8fdb度 10%\r进度 100%\r\n\x1b[0m(base) PS C:\\> ',
    );
  });

  it('passes unrelated, wrong-nonce and malformed OSC sequences through unchanged', () => {
    const data = [
      '\x1b]0;window title\x07',
      powerShellShellIntegrationSequence(
        'fedcba9876543210fedcba9876543210',
        'C',
        '1',
      ),
      powerShellShellIntegrationSequence(NONCE, 'D', 'bad', '0'),
      'ordinary output',
    ].join('');
    const parser = new PowerShellShellIntegrationParser(NONCE);
    const parts = parser.push(data);

    expect(parts).toEqual([{ kind: 'data', data }]);
  });
});

describe.runIf(process.platform === 'win32')('real Windows PowerShell shell integration', () => {
  it('keeps one public PTY interactive and reports a plain command lifecycle', async () => {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error('SystemRoot is unavailable.');
    const shell = join(
      systemRoot,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const terminal = pty.spawn(shell, powerShellShellIntegrationArgs(['-NoLogo'], NONCE), {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: Object.fromEntries(Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      )),
      useConpty: true,
      useConptyDll: true,
    });
    const parser = new PowerShellShellIntegrationParser(NONCE);
    const command = 'Write-Output "GLASS_INTEGRATION_OK"';
    const failingCommand = 'cmd /c exit 7';
    const events: PowerShellShellIntegrationEvent[] = [];
    let visible = '';
    let commandWritten = false;
    const replay: Array<
      | { kind: 'data'; data: string }
      | { kind: 'resize'; cols: number; rows: number }
    > = [];

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(
          `PowerShell shell integration timed out. Visible output: ${JSON.stringify(visible)}`,
        )), 15_000);
        const dataDisposable = terminal.onData((data) => {
          for (const part of parser.push(data)) {
            if (part.kind === 'data') {
              visible += part.data;
              replay.push({ kind: 'data', data: part.data });
            }
            else {
              events.push(part.event);
              if (part.event.kind === 'ready' && part.event.rich && !commandWritten) {
                commandWritten = true;
                terminal.write(`${command}\r`);
              }
              if (part.event.kind === 'end' && part.event.commandId === 1) {
                terminal.write(`${failingCommand}\r`);
              } else if (part.event.kind === 'end' && part.event.commandId === 2) {
                setTimeout(() => {
                  replay.push({ kind: 'resize', cols: 43, rows: 18 });
                  terminal.resize(43, 18);
                }, 50);
                setTimeout(() => {
                  replay.push({ kind: 'resize', cols: 112, rows: 35 });
                  terminal.resize(112, 35);
                }, 150);
                setTimeout(() => {
                  clearTimeout(timeout);
                  dataDisposable.dispose();
                  resolve();
                }, 500);
              }
            }
          }
        });
        terminal.onExit(({ exitCode }) => {
          clearTimeout(timeout);
          reject(new Error(`PowerShell exited before lifecycle completion: ${exitCode}`));
        });
      });
    } finally {
      terminal.kill();
    }

    expect(commandWritten).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'ready', rich: true }));
    expect(events).toContainEqual({ kind: 'command', commandId: 1, command });
    expect(events).toContainEqual({ kind: 'start', commandId: 1 });
    expect(events).toContainEqual({ kind: 'end', commandId: 1, exitCode: 0 });
    expect(events).toContainEqual({ kind: 'command', commandId: 2, command: failingCommand });
    expect(events).toContainEqual({ kind: 'start', commandId: 2 });
    expect(events).toContainEqual({ kind: 'end', commandId: 2, exitCode: 7 });
    expect(visible).toContain('GLASS_INTEGRATION_OK');

    const xterm = new XtermTerminal({ cols: 100, rows: 30, scrollback: 1_000 });
    for (const item of replay) {
      if (item.kind === 'resize') xterm.resize(item.cols, item.rows);
      else await new Promise<void>((resolve) => xterm.write(item.data, resolve));
    }
    const screen = Array.from({ length: xterm.buffer.active.length }, (_, index) => (
      xterm.buffer.active.getLine(index)?.translateToString(true) ?? ''
    )).join('\n');
    xterm.dispose();
    expect(screen).toContain('GLASS_INTEGRATION_OK');
  }, 20_000);
});
