import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalJournalEvent } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import { TerminalService } from './terminal-service';

interface FakeBackend {
  writes: string[];
  closes: number;
  write(data: string): void;
  resize(): void;
  close(): void;
}

interface TestableTerminalService {
  register(
    owner: WebContents,
    descriptor: TerminalDescriptor,
    backend: FakeBackend,
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

function setup() {
  const service = new TerminalService();
  const testable = service as unknown as TestableTerminalService;
  const browser = owner();
  const backend: FakeBackend = {
    writes: [],
    closes: 0,
    write(data) { this.writes.push(data); },
    resize() {},
    close() { this.closes += 1; },
  };
  const descriptor: TerminalDescriptor = {
    id: 'terminal',
    title: 'Test',
    profileId: 'test-posix',
    shellKind: 'posix',
    transport: 'local',
  };
  testable.register(browser, descriptor, backend);
  return { service, testable, browser, backend };
}

function nonceFromPosixEnvelope(input: string): string {
  const match = input.match(/__ait_a='([^']+)';__ait_b='([^']+)'/);
  if (!match) throw new Error('Unable to recover the test sentinel nonce.');
  return `${match[1]}${match[2]}`;
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

  it('fails closed when the backend throws while sending manual Ctrl+C', async () => {
    const { service, browser, backend } = setup();
    service.bindSession(browser, 'terminal', 'session');
    const executionPromise = service.executeStructured(
      browser,
      'terminal',
      'long-running-command',
      'ai',
    );
    const execution = service.currentExecution(browser, 'terminal')!;
    backend.write = () => { throw new Error('transport write failed'); };

    expect(service.interruptExecution(browser, 'terminal', execution.id)?.id).toBe(execution.id);
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(backend.closes).toBe(1);
    expect((await executionPromise).status).toBe('cancelled');
    expect(() => service.write(browser, 'terminal', 'new command\r')).toThrow(/no longer connected/i);
  });

  it('fails closed by closing a terminal whose timed-out command never emits an end sentinel', async () => {
    vi.useFakeTimers();
    try {
      const { service, browser, backend } = setup();
      service.bindSession(browser, 'terminal', 'session');
      const executionPromise = service.executeStructured(
        browser,
        'terminal',
        'hung-command',
        'ai',
      );
      const controlLease = service.acquireAgentControl(browser, 'terminal');
      service.setAgentControlMode(browser, 'terminal', controlLease, 'secure-human');

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
      expect(backend.writes.filter((data) => data === '\x03')).toHaveLength(1);
      expect(service.currentExecution(browser, 'terminal')?.status).toBe('running');
      expect(() => service.write(browser, 'terminal', 'credential\r')).toThrow(/locked/i);
      await vi.advanceTimersByTimeAsync(5_000);

      expect(backend.closes).toBe(1);
      expect((await executionPromise).status).toBe('cancelled');
      expect(() => service.write(browser, 'terminal', 'new command\r')).toThrow(/no longer connected/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still fails closed when the timeout Ctrl+C write itself throws', async () => {
    vi.useFakeTimers();
    try {
      const { service, browser, backend } = setup();
      service.bindSession(browser, 'terminal', 'session');
      const executionPromise = service.executeStructured(
        browser,
        'terminal',
        'hung-command',
        'ai',
      );
      backend.write = () => { throw new Error('transport write failed'); };

      await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);

      expect(backend.closes).toBe(1);
      expect((await executionPromise).status).toBe('cancelled');
      expect(() => service.write(browser, 'terminal', 'new command\r')).toThrow(/no longer connected/i);
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
