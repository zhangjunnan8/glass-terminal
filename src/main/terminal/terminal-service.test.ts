import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalJournalEvent } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import { TERMINAL_CHANNELS } from '../../shared/terminal';
import {
  encodePowerShellShellIntegrationValue,
  powerShellShellIntegrationSequence,
} from './powershell-shell-integration';
import { TerminalService } from './terminal-service';

const POWERSHELL_INTEGRATION_NONCE = '0123456789abcdef0123456789abcdef';

interface FakeBackend {
  writes: string[];
  resizes: Array<[number, number]>;
  closes: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface TestableTerminalService {
  register(
    owner: WebContents,
    descriptor: TerminalDescriptor,
    backend: FakeBackend,
    sshClient?: undefined,
    powerShellIntegrationNonce?: string,
  ): void;
  emitData(terminalId: string, data: string): void;
  emitExit(terminalId: string, exitCode: number, signal?: number): void;
}

function owner(): WebContents {
  return {
    id: 7,
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

function setup(
  shellKind: TerminalDescriptor['shellKind'] = 'posix',
  transport: TerminalDescriptor['transport'] = 'local',
) {
  const service = new TerminalService();
  const testable = service as unknown as TestableTerminalService;
  const browser = owner();
  const backend: FakeBackend = {
    writes: [],
    resizes: [],
    closes: 0,
    write(data) { this.writes.push(data); },
    resize(cols, rows) { this.resizes.push([cols, rows]); },
    close() { this.closes += 1; },
  };
  const descriptor: TerminalDescriptor = {
    id: 'terminal',
    title: 'Test',
    profileId: 'test-posix',
    shellKind,
    transport,
  };
  const integrationNonce = shellKind === 'powershell'
    ? POWERSHELL_INTEGRATION_NONCE
    : undefined;
  testable.register(browser, descriptor, backend, undefined, integrationNonce);
  if (integrationNonce) {
    testable.emitData('terminal', [
      powerShellShellIntegrationSequence(
        integrationNonce,
        'R',
        '1',
        encodePowerShellShellIntegrationValue('5.1.22621.2506'),
      ),
      powerShellShellIntegrationSequence(
        integrationNonce,
        'P',
        encodePowerShellShellIntegrationValue('C:\\Users\\tester'),
      ),
    ].join(''));
  }
  return { service, testable, browser, backend };
}

function nonceFromPosixEnvelope(input: string): string {
  const match = input.match(/__ait_a='([^']+)';__ait_b='([^']+)'/);
  if (!match) throw new Error('Unable to recover the test sentinel nonce.');
  return `${match[1]}${match[2]}`;
}

function sentinelMarkersFromPosixEnvelope(input: string): { start: string; end: string } {
  const nonce = nonceFromPosixEnvelope(input);
  return {
    start: `\x1eAI:${nonce}:START\x1f`,
    end: `\x1eAI:${nonce}:END:0\x1f`,
  };
}

describe('TerminalService control and redaction invariants', () => {
  it('enforces the Agent input lease and locks immediately after secure Enter', () => {
    const { service, browser, backend } = setup();
    const lease = service.acquireAgentControl(browser, 'terminal');

    expect(() => service.write(browser, 'terminal', 'human input')).toThrow(/locked/i);
    expect(backend.writes).toEqual([]);

    service.setAgentControlMode(browser, 'terminal', lease, 'secure-human');
    service.write(browser, 'terminal', 'credential\rignored-command\r');
    expect(backend.writes).toEqual(['credential\r']);
    expect(() => service.write(browser, 'terminal', 'whoami\r')).toThrow(/locked/i);
    expect(backend.writes).toEqual(['credential\r']);

    expect(service.releaseAgentControl(browser, 'terminal', 'stale-lease')).toBe(false);
    expect(service.releaseAgentControl(browser, 'terminal', lease)).toBe(true);
    service.write(browser, 'terminal', 'human again');
    expect(backend.writes.at(-1)).toBe('human again');
  });

  it.each([
    ['secret\rwhoami\r', 'secret\r'],
    ['secret\nwhoami\n', 'secret\r'],
    ['secret\r\nwhoami\r\n', 'secret\r'],
    ['\rwhoami\r', '\r'],
    ['秘密\n下一行', '秘密\r'],
  ])('drops multiline secure paste tails for %j', (input, expected) => {
    const { service, browser, backend } = setup();
    const lease = service.acquireAgentControl(browser, 'terminal');
    service.setAgentControlMode(browser, 'terminal', lease, 'secure-human');

    service.write(browser, 'terminal', input);

    expect(backend.writes).toEqual([expected]);
    expect(() => service.write(browser, 'terminal', 'post-submit\r')).toThrow(/locked/i);
  });

  it('locks before the secure backend write so reentrant input is rejected', () => {
    const { service, browser, backend } = setup();
    const lease = service.acquireAgentControl(browser, 'terminal');
    service.setAgentControlMode(browser, 'terminal', lease, 'secure-human');
    const originalWrite = backend.write.bind(backend);
    let reentrantError: Error | undefined;
    backend.write = (data) => {
      try {
        service.write(browser, 'terminal', 'ATTACK\r');
      } catch (error) {
        reentrantError = error as Error;
      }
      originalWrite(data);
    };

    service.write(browser, 'terminal', 'credential\r');

    expect(reentrantError?.message).toMatch(/locked/i);
    expect(backend.writes).toEqual(['credential\r']);
  });

  it('sticky-taints execution output and journal even if a stale caller ends sensitive mode early', async () => {
    const { service, testable, browser, backend } = setup();
    const journal: TerminalJournalEvent[] = [];
    service.onJournal((_terminalId, _sessionId, event) => journal.push(event));
    service.bindSession(browser, 'terminal', 'session');
    const controlLease = service.acquireAgentControl(browser, 'terminal');
    let sensitiveLease = '';
    const executionPromise = service.executeStructured(
      browser,
      'terminal',
      'read -s -p "Password: " secret',
      'ai',
      {
        onAuthPrompt: (execution) => {
          sensitiveLease = service.beginSensitiveMode(browser, 'terminal', execution.id);
          service.setAgentControlMode(browser, 'terminal', controlLease, 'secure-human');
        },
      },
    );
    const envelope = backend.writes[0];
    const nonce = nonceFromPosixEnvelope(envelope);
    const start = `\x1eAI:${nonce}:START\x1f`;
    const end = `\x1eAI:${nonce}:END:0\x1f`;
    const canary = `secret-${crypto.randomUUID()}`;

    testable.emitData('terminal', `${start}\r\n\x1b[33mPass`);
    testable.emitData('terminal', 'word: \x1b[0m');
    expect(sensitiveLease).not.toBe('');
    service.write(browser, 'terminal', `${canary}\r`);
    expect(service.consumeSensitiveSubmission(
      browser,
      'terminal',
      service.currentExecution(browser, 'terminal')!.id,
      sensitiveLease,
    )).toBe(true);
    expect(service.consumeSensitiveSubmission(
      browser,
      'terminal',
      service.currentExecution(browser, 'terminal')!.id,
      sensitiveLease,
    )).toBe(false);
    expect(service.endSensitiveMode(browser, 'terminal', sensitiveLease)).toBe(true);
    testable.emitData('terminal', `${canary}\r\n${end}`);
    const execution = await executionPromise;

    expect(execution.outputRedacted).toBe(true);
    expect(execution.output).toContain('[Sensitive interaction hidden]');
    expect(execution.output).not.toContain(canary);
    const persisted = journal.map((event) => (
      event.kind === 'output' ? event.data : JSON.stringify(event)
    )).join('');
    expect(persisted).toContain('[Sensitive interaction hidden]');
    expect(persisted).not.toContain(canary);
  });

  it('sends a POSIX authentication prompt to the renderer before secure input is submitted', async () => {
    const { service, testable, browser, backend } = setup('posix');
    service.bindSession(browser, 'terminal', 'session');
    service.attach(browser, 'terminal');
    const onAuthPrompt = vi.fn();
    const executionPromise = service.executeStructured(
      browser,
      'terminal',
      'read-secret',
      'ai',
      { onAuthPrompt },
    );
    const markers = sentinelMarkersFromPosixEnvelope(backend.writes[0]);

    testable.emitData('terminal', `${markers.start}\r\nPassword: `);

    const renderedBeforeInput = vi.mocked(browser.send).mock.calls
      .filter(([channel]) => channel === TERMINAL_CHANNELS.data)
      .map(([, payload]) => (payload as { data: string }).data)
      .join('');
    expect(onAuthPrompt).toHaveBeenCalledOnce();
    expect(renderedBeforeInput).toContain('Password: ');
    expect(renderedBeforeInput).not.toContain('\x1eAI:');

    testable.emitData('terminal', markers.end);
    expect((await executionPromise).outputRedacted).toBe(true);
  });

  it('sends Ctrl+C exactly once and only for the expected active execution', async () => {
    const { service, testable, browser, backend } = setup();
    service.bindSession(browser, 'terminal', 'session');
    const executionPromise = service.executeStructured(
      browser,
      'terminal',
      'long-running-command',
      'ai',
    );
    const execution = service.currentExecution(browser, 'terminal')!;
    const writesBeforeInterrupt = backend.writes.length;

    expect(service.interruptExecution(browser, 'terminal', 'stale-execution')).toBeUndefined();
    expect(backend.writes).toHaveLength(writesBeforeInterrupt);
    expect(service.interruptExecution(browser, 'terminal', execution.id)?.id).toBe(execution.id);
    expect(backend.writes.at(-1)).toBe('\x03');
    const writesAfterInterrupt = backend.writes.length;
    expect(service.interruptExecution(browser, 'terminal', execution.id)).toBeUndefined();
    expect(backend.writes).toHaveLength(writesAfterInterrupt);

    const envelope = backend.writes[0];
    const nonce = nonceFromPosixEnvelope(envelope);
    testable.emitData('terminal', `\x1eAI:${nonce}:START\x1f\r\n`);
    testable.emitData('terminal', `\x1eAI:${nonce}:END:130\x1f`);
    expect((await executionPromise).status).toBe('cancelled');
  });

  it('lets the user release exact interrupted tracking after seeing the shell prompt', async () => {
    const { service, browser, backend } = setup();
    service.bindSession(browser, 'terminal', 'session');
    const executionPromise = service.executeStructured(
      browser,
      'terminal',
      'long-running-command',
      'ai',
    );
    const execution = service.currentExecution(browser, 'terminal')!;
    service.interruptExecution(browser, 'terminal', execution.id);

    const released = service.confirmShellReady(browser, 'terminal', execution.id);

    expect(released?.status).toBe('cancelled');
    expect(service.currentExecution(browser, 'terminal')).toBeUndefined();
    expect(service.confirmShellReady(browser, 'terminal', execution.id)).toBeUndefined();
    expect(backend.writes.filter((data) => data === '\x03')).toHaveLength(1);
    expect((await executionPromise).status).toBe('cancelled');
  });

  it('keeps the terminal connected when the backend rejects manual Ctrl+C', async () => {
    const { service, testable, browser, backend } = setup();
    service.bindSession(browser, 'terminal', 'session');
    const executionPromise = service.executeStructured(
      browser,
      'terminal',
      'long-running-command',
      'ai',
    );
    const execution = service.currentExecution(browser, 'terminal')!;
    const envelope = backend.writes[0];
    const nonce = nonceFromPosixEnvelope(envelope);
    backend.write = () => { throw new Error('transport write failed'); };

    expect(() => service.interruptExecution(browser, 'terminal', execution.id))
      .toThrow(/kept connected/i);
    expect(backend.closes).toBe(0);
    expect(service.state(browser, 'terminal').status).toBe('connected');
    expect(service.currentExecution(browser, 'terminal')?.interruptRequestedAt).toBeUndefined();

    backend.write = (data) => { backend.writes.push(data); };
    testable.emitData('terminal', `\x1eAI:${nonce}:START\x1f\r\n`);
    testable.emitData('terminal', `\x1eAI:${nonce}:END:0\x1f`);
    expect((await executionPromise).status).toBe('completed');
  });

  it('reports command inactivity without Ctrl+C or closing the terminal', async () => {
    vi.useFakeTimers();
    try {
      const { service, testable, browser, backend } = setup();
      service.bindSession(browser, 'terminal', 'session');
      const onIdleTimeout = vi.fn();
      const executionPromise = service.executeStructured(
        browser,
        'terminal',
        'hung-command',
        'ai',
        { onIdleTimeout },
      );
      const nonce = nonceFromPosixEnvelope(backend.writes[0]);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(backend.writes.filter((data) => data === '\x03')).toHaveLength(0);
      expect(service.currentExecution(browser, 'terminal')?.status).toBe('running');
      expect(service.currentExecution(browser, 'terminal')?.inactivityTimedOutAt).toBeTruthy();
      expect(onIdleTimeout).toHaveBeenCalledOnce();
      expect(backend.closes).toBe(0);
      expect(service.state(browser, 'terminal').status).toBe('connected');

      testable.emitData('terminal', `\x1eAI:${nonce}:START\x1f\r\n`);
      testable.emitData('terminal', `\x1eAI:${nonce}:END:0\x1f`);
      expect((await executionPromise).status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets the inactivity watchdog whenever command output arrives', async () => {
    vi.useFakeTimers();
    try {
      const { service, testable, browser, backend } = setup();
      service.bindSession(browser, 'terminal', 'session');
      const onIdleTimeout = vi.fn();
      const executionPromise = service.executeStructured(
        browser,
        'terminal',
        'slow-command',
        'ai',
        { onIdleTimeout },
      );
      const nonce = nonceFromPosixEnvelope(backend.writes[0]);

      await vi.advanceTimersByTimeAsync(4 * 60 * 1_000);
      testable.emitData('terminal', 'still working\r\n');
      await vi.advanceTimersByTimeAsync(4 * 60 * 1_000);
      expect(onIdleTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60 * 1_000);

      expect(onIdleTimeout).toHaveBeenCalledOnce();
      expect(backend.closes).toBe(0);
      testable.emitData('terminal', `\x1eAI:${nonce}:START\x1f\r\n`);
      testable.emitData('terminal', `\x1eAI:${nonce}:END:0\x1f`);
      expect((await executionPromise).status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('executes PowerShell commands once in the public PTY using OSC lifecycle events', async () => {
    const { service, testable, browser, backend } = setup('powershell');
    const journal: TerminalJournalEvent[] = [];
    const command = 'echo "Hello, Glass Terminal!"';
    service.onJournal((_terminalId, _sessionId, event) => journal.push(event));
    service.bindSession(browser, 'terminal', 'session');
    service.attach(browser, 'terminal');
    const executionPromise = service.executeStructured(browser, 'terminal', command, 'ai');
    expect(backend.writes).toEqual([`${command}\r`]);
    expect(backend.writes[0]).not.toContain('__AI_TERMINAL_');
    expect(backend.writes[0]).not.toContain('FromBase64String');

    const lifecycle = [
      powerShellShellIntegrationSequence(
        POWERSHELL_INTEGRATION_NONCE,
        'E',
        '1',
        encodePowerShellShellIntegrationValue(command),
      ),
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'C', '1'),
      '\x1b[32mHello, Glass Terminal!\x1b[0m\r\n',
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'D', '1', '0'),
      '(base) PS C:\\Users\\tester> ',
    ].join('');
    for (let index = 0; index < lifecycle.length; index += 7) {
      testable.emitData('terminal', lifecycle.slice(index, index + 7));
    }
    const execution = await executionPromise;

    const rendered = vi.mocked(browser.send).mock.calls.map(([, payload]) => (
      (payload as { data?: string }).data ?? ''
    )).join('');
    expect(execution).toMatchObject({
      status: 'completed',
      exitCode: 0,
      cwd: 'C:\\Users\\tester',
      output: '\x1b[32mHello, Glass Terminal!\x1b[0m\r\n',
    });
    expect(rendered).toContain('Hello, Glass Terminal!');
    expect(rendered).toContain('(base) PS C:\\Users\\tester>');
    expect(rendered).not.toContain('633;GlassTerminal');
    const persisted = journal.map((event) => event.kind === 'output' ? event.data : '').join('');
    expect(persisted).toContain('Hello, Glass Terminal!');
    expect(persisted).not.toContain('633;GlassTerminal');
  });

  it('passes a complete PowerShell resize redraw through without deleting paint operations', async () => {
    const { service, testable, browser, backend } = setup('powershell');
    const command = 'echo "Hello, Glass Terminal!"';
    service.bindSession(browser, 'terminal', 'session');
    service.attach(browser, 'terminal');
    const executionPromise = service.executeStructured(browser, 'terminal', command, 'ai');
    testable.emitData('terminal', [
      powerShellShellIntegrationSequence(
        POWERSHELL_INTEGRATION_NONCE,
        'E',
        '1',
        encodePowerShellShellIntegrationValue(command),
      ),
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'C', '1'),
      'Hello, Glass Terminal!\r\n',
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'D', '1', '0'),
    ].join(''));
    await executionPromise;
    vi.mocked(browser.send).mockClear();

    service.resize(browser, 'terminal', 43, 24);
    const redraw = [
      '\x1b[6A\x1b[2K\r',
      `(base) PS C:\\Users\\tester> ${command}\r\n`,
      '\x1b[2K\rHello, Glass Terminal!\r\n',
      '\x1b[2K\r(base) PS C:\\Users\\tester> ',
    ].join('');
    testable.emitData('terminal', redraw.slice(0, 31));
    testable.emitData('terminal', redraw.slice(31));

    const rendered = vi.mocked(browser.send).mock.calls.map(([, payload]) => (
      (payload as { data?: string }).data ?? ''
    )).join('');
    expect(rendered).toBe(redraw);
    expect(rendered).toContain(command);
    expect(rendered).toContain('Hello, Glass Terminal!');
    expect(backend.writes).toEqual([`${command}\r`]);
  });

  it('ignores replayed PowerShell lifecycle events and binds a repeated command to its new id', async () => {
    const { service, testable, browser } = setup('powershell');
    const command = 'Get-Date';
    service.bindSession(browser, 'terminal', 'session');
    const lifecycle = (commandId: number) => [
      powerShellShellIntegrationSequence(
        POWERSHELL_INTEGRATION_NONCE,
        'E',
        String(commandId),
        encodePowerShellShellIntegrationValue(command),
      ),
      powerShellShellIntegrationSequence(
        POWERSHELL_INTEGRATION_NONCE,
        'C',
        String(commandId),
      ),
      `result-${commandId}\r\n`,
      powerShellShellIntegrationSequence(
        POWERSHELL_INTEGRATION_NONCE,
        'D',
        String(commandId),
        '0',
      ),
    ].join('');

    const first = service.executeStructured(browser, 'terminal', command, 'ai');
    testable.emitData('terminal', lifecycle(1));
    await first;

    const second = service.executeStructured(browser, 'terminal', command, 'ai');
    testable.emitData('terminal', lifecycle(1));
    expect(service.currentExecution(browser, 'terminal')?.status).toBe('running');
    testable.emitData('terminal', lifecycle(2));
    await expect(second).resolves.toMatchObject({
      status: 'completed',
      output: 'result-2\r\n',
    });
  });

  it('routes Ctrl+C to the same public PowerShell command and completes it as cancelled', async () => {
    const { service, testable, browser, backend } = setup('powershell');
    const command = 'winget upgrade';
    service.bindSession(browser, 'terminal', 'session');
    const executionPromise = service.executeStructured(browser, 'terminal', command, 'ai');
    testable.emitData('terminal', [
      powerShellShellIntegrationSequence(
        POWERSHELL_INTEGRATION_NONCE,
        'E',
        '1',
        encodePowerShellShellIntegrationValue(command),
      ),
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'C', '1'),
      'Downloading 42%\r',
    ].join(''));
    const executionId = service.currentExecution(browser, 'terminal')!.id;

    service.interruptExecution(browser, 'terminal', executionId);
    expect(backend.writes).toEqual([`${command}\r`, '\x03']);
    testable.emitData(
      'terminal',
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'D', '1', '1'),
    );
    await expect(executionPromise).resolves.toMatchObject({
      status: 'cancelled',
      output: 'Downloading 42%\r',
    });
  });

  it('uses bracketed paste for one multiline PowerShell command lifecycle', async () => {
    const { service, testable, browser, backend } = setup('powershell');
    const command = '1..2 | ForEach-Object {\n  Write-Output $_\n}';
    service.bindSession(browser, 'terminal', 'session');
    const executionPromise = service.executeStructured(browser, 'terminal', command, 'ai');

    expect(backend.writes).toEqual([`\x1b[200~${command}\x1b[201~\r`]);
    testable.emitData('terminal', [
      powerShellShellIntegrationSequence(
        POWERSHELL_INTEGRATION_NONCE,
        'E',
        '1',
        encodePowerShellShellIntegrationValue(command),
      ),
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'C', '1'),
      '1\r\n2\r\n',
      powerShellShellIntegrationSequence(POWERSHELL_INTEGRATION_NONCE, 'D', '1', '0'),
    ].join(''));
    await expect(executionPromise).resolves.toMatchObject({
      status: 'completed',
      output: '1\r\n2\r\n',
    });
  });

  it('keeps a PowerShell terminal usable but refuses AI execution without rich integration', () => {
    const fallback = new TerminalService();
    const fallbackTestable = fallback as unknown as TestableTerminalService;
    const fallbackBrowser = owner();
    const backend: FakeBackend = {
      writes: [],
      resizes: [],
      closes: 0,
      write(data) { this.writes.push(data); },
      resize(cols, rows) { this.resizes.push([cols, rows]); },
      close() { this.closes += 1; },
    };
    fallbackTestable.register(fallbackBrowser, {
      id: 'terminal',
      title: 'Restricted PowerShell',
      profileId: 'restricted',
      shellKind: 'powershell',
      transport: 'ssh',
    }, backend, undefined, POWERSHELL_INTEGRATION_NONCE);
    fallbackTestable.emitData('terminal', powerShellShellIntegrationSequence(
      POWERSHELL_INTEGRATION_NONCE,
      'R',
      '0',
      encodePowerShellShellIntegrationValue('5.1'),
    ));
    fallback.bindSession(fallbackBrowser, 'terminal', 'session');

    expect(fallback.state(fallbackBrowser, 'terminal')).toMatchObject({
      shellIntegration: { status: 'ready', rich: false },
    });
    expect(() => fallback.executeStructured(
      fallbackBrowser,
      'terminal',
      'Get-Date',
      'ai',
    )).toThrow(/requires PSReadLine and FullLanguage/i);
    expect(backend.writes).toEqual([]);
  });

  it('coalesces a Windows SSH PowerShell resize storm to the final dimensions', () => {
    vi.useFakeTimers();
    try {
      const { service, browser, backend } = setup('powershell', 'ssh');
      service.bindSession(browser, 'terminal', 'session');

      service.resize(browser, 'terminal', 80, 24);
      service.resize(browser, 'terminal', 112, 32);
      service.resize(browser, 'terminal', 147, 41);
      expect(backend.resizes).toEqual([]);

      vi.advanceTimersByTime(119);
      expect(backend.resizes).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(backend.resizes).toEqual([[147, 41]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs every exit listener even when persistence-oriented listeners throw', () => {
    const { service, testable } = setup();
    const observed: string[] = [];
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.onExit(() => { throw new Error('disk unavailable'); });
    service.onExit((terminalId) => { observed.push(terminalId); });

    testable.emitExit('terminal', 255);

    expect(observed).toEqual(['terminal']);
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});
