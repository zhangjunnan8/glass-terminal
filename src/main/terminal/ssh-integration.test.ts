import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import type { HostProfile } from '../../shared/host';
import { SSH_ERROR_CODES } from '../../shared/host';
import { TERMINAL_CHANNELS } from '../../shared/terminal';
import type { TerminalDataEvent, TerminalExitEvent } from '../../shared/terminal';
import { TerminalService } from './terminal-service';

const enabled = Boolean(
  process.env.AI_TERMINAL_SSH_TEST_HOST
  && process.env.AI_TERMINAL_SSH_TEST_USER
  && process.env.AI_TERMINAL_SSH_TEST_PASSWORD,
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe.runIf(enabled)('real SSH shared terminal', () => {
  it('writes a command and observes its output on the same SSH PTY stream', async () => {
    const service = new TerminalService();
    const output: string[] = [];
    const markerSeen = deferred<void>();
    const terminalExited = deferred<TerminalExitEvent>();
    const owner = {
      id: 7_001,
      isDestroyed: () => false,
      send: (channel: string, payload: TerminalDataEvent | TerminalExitEvent) => {
        if (channel === TERMINAL_CHANNELS.data) {
          const event = payload as TerminalDataEvent;
          output.push(event.data);
          if (output.join('').includes('__AI_TERMINAL_SSH_SMOKE__')) {
            markerSeen.resolve();
          }
        }
        if (channel === TERMINAL_CHANNELS.exit) {
          terminalExited.resolve(payload as TerminalExitEvent);
        }
      },
    } as unknown as WebContents;
    const host: HostProfile = {
      id: 'integration-host',
      name: 'Ubuntu integration target',
      hostname: process.env.AI_TERMINAL_SSH_TEST_HOST!,
      port: Number(process.env.AI_TERMINAL_SSH_TEST_PORT ?? 22),
      username: process.env.AI_TERMINAL_SSH_TEST_USER!,
      authMethod: 'password',
      favorite: false,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const password = process.env.AI_TERMINAL_SSH_TEST_PASSWORD;

    let challenge = '';
    try {
      await service.createSsh(owner, host, { hostId: host.id, password });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(SSH_ERROR_CODES.hostKeyRequired);
      challenge = message.slice(message.indexOf('SHA256:')).trim();
    }
    expect(challenge).toMatch(/^SHA256:/);

    const { descriptor } = await service.createSsh(owner, host, {
      hostId: host.id,
      password,
      trustHostKey: challenge,
      cols: 90,
      rows: 28,
    });
    output.push(service.attach(owner, descriptor.id));
    service.bindSession(owner, descriptor.id, '00000000-0000-0000-0000-000000000001');
    service.resize(owner, descriptor.id, 100, 30);
    const executionPromise = service.executeStructured(
      owner,
      descriptor.id,
      "printf '__AI_TERMINAL_SSH_SMOKE__\\n'",
      'ai',
    );
    await Promise.race([
      markerSeen.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('SSH marker timeout')), 12_000)),
    ]);
    const execution = await executionPromise;
    expect(execution).toMatchObject({ status: 'completed', exitCode: 0, actor: 'ai' });
    expect(execution.output).toContain('__AI_TERMINAL_SSH_SMOKE__');
    service.write(owner, descriptor.id, 'exit\r');
    const exit = await Promise.race([
      terminalExited.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSH exit timeout')), 8_000)),
    ]);

    expect(output.join('')).toContain('__AI_TERMINAL_SSH_SMOKE__');
    expect(exit.terminalId).toBe(descriptor.id);
  }, 35_000);
});
