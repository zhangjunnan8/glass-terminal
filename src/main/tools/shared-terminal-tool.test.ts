import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import type {
  SessionToolContext,
  TerminalCommandResult,
} from '../../shared/tools';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';
import { SharedTerminalTool } from './shared-terminal-tool';

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1,
    id: 'session-1',
    name: 'SSH project',
    nameSource: 'automatic',
    transport: 'ssh',
    hostId: 'host-1',
    shellProfileId: 'ssh:host-1',
    shellKind: 'posix',
    targetSnapshot: { label: 'SSH project' },
    connectionState: 'connected',
    status: 'active',
    runtimeTerminalId: 'terminal-1',
    cwd: '/srv/project',
    effectiveUser: 'deploy',
    pinned: false,
    preludeTruncated: false,
    droppedPreludeBytes: 0,
    startedAt: '2026-08-16T00:00:00.000Z',
    promotedAt: '2026-08-16T00:00:00.000Z',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    lastConnectedAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  };
}

function makeDescriptor(overrides: Partial<TerminalDescriptor> = {}): TerminalDescriptor {
  return {
    id: 'terminal-1',
    title: 'SSH project',
    profileId: 'ssh:host-1',
    shellKind: 'posix',
    transport: 'ssh',
    hostId: 'host-1',
    sessionId: 'session-1',
    ...overrides,
  };
}

function makeContext(
  terminalPermissions: Partial<SessionToolContext['permissions']['terminal']> = {},
): SessionToolContext {
  return {
    sessionId: 'session-1',
    terminal: { type: 'ssh', terminalId: 'terminal-1', hostId: 'host-1' },
    permissions: {
      terminal: {
        read: true,
        execute: true,
        sendInput: false,
        interrupt: true,
        ...terminalPermissions,
      },
      workspace: {
        enabled: false,
        mode: 'off',
        read: false,
        write: false,
        create: false,
        delete: false,
        readablePaths: [],
        writablePaths: [],
        fullAccess: false,
      },
    },
  };
}

function setup(options: {
  context?: SessionToolContext;
  session?: SessionRecord;
  descriptor?: TerminalDescriptor;
  history?: string;
  execute?: (command: string, reason?: string) => Promise<TerminalCommandResult>;
  sendInput?: (input: string) => Promise<void> | void;
  interrupt?: (commandId?: string) => Promise<void> | void;
  assertLive?: () => void;
} = {}) {
  const owner = { id: 7 } as WebContents;
  let currentSession = options.session ?? makeSession();
  let currentDescriptor = options.descriptor ?? makeDescriptor();
  const directStructuredExecution = vi.fn(() => {
    throw new Error('SharedTerminalTool must not execute directly.');
  });
  const terminalMock = {
    descriptor: vi.fn(() => ({ ...currentDescriptor })),
    state: vi.fn(() => ({
      terminalId: currentDescriptor.id,
      sessionId: currentDescriptor.sessionId,
      transport: currentDescriptor.transport,
      shellKind: currentDescriptor.shellKind,
      hostId: currentDescriptor.hostId,
      status: 'connected',
      activeExecutionId: 'command-active',
      terminalInputMode: 'locked',
    })),
    executeStructured: directStructuredExecution,
  };
  const sessionMock = {
    sessionForTerminal: vi.fn(() => currentSession),
    readTerminalHistory: vi.fn(() => options.history ?? 'terminal history'),
  };
  const execute = options.execute ?? vi.fn(async () => ({
    commandId: 'command-1',
    command: 'npm test',
    status: 'completed' as const,
    exitCode: 0,
    output: 'ok',
    startedAt: 100,
    finishedAt: 125,
    durationMs: 25,
  }));
  const tool = new SharedTerminalTool({
    context: options.context ?? makeContext(),
    owner,
    terminals: terminalMock as unknown as TerminalService,
    sessions: sessionMock as unknown as SessionManager,
    execute,
    ...(options.sendInput ? { sendInput: options.sendInput } : {}),
    ...(options.interrupt ? { interrupt: options.interrupt } : {}),
    ...(options.assertLive ? { assertLive: options.assertLive } : {}),
  });
  return {
    tool,
    execute,
    directStructuredExecution,
    terminalMock,
    sessionMock,
    setSession: (session: SessionRecord) => { currentSession = session; },
    setDescriptor: (descriptor: TerminalDescriptor) => { currentDescriptor = descriptor; },
  };
}

describe('SharedTerminalTool', () => {
  it('routes execution only through the injected approval/execution callback', async () => {
    const execute = vi.fn(async (command: string): Promise<TerminalCommandResult> => ({
      commandId: 'command-9',
      command,
      status: 'completed',
      exitCode: 0,
      output: 'passed',
      startedAt: 10,
      finishedAt: 20,
      durationMs: 10,
    }));
    const { tool, directStructuredExecution } = setup({ execute });

    await expect(tool.execute('npm test', 'verify the change')).resolves.toMatchObject({
      commandId: 'command-9',
      status: 'completed',
    });
    expect(execute).toHaveBeenCalledWith('npm test', 'verify the change');
    expect(directStructuredExecution).not.toHaveBeenCalled();
  });

  it('checks execute permission before invoking the callback', async () => {
    const execute = vi.fn();
    const { tool } = setup({ context: makeContext({ execute: false }), execute });

    await expect(tool.execute('whoami')).rejects.toThrow(/execute.*disabled/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects every operation after the Session-to-terminal binding becomes stale', async () => {
    const sendInput = vi.fn();
    const interrupt = vi.fn();
    const fixture = setup({
      context: makeContext({ sendInput: true }),
      sendInput,
      interrupt,
    });
    fixture.setSession(makeSession({ runtimeTerminalId: 'replacement-terminal' }));

    const calls = [
      fixture.tool.execute('pwd'),
      fixture.tool.sendInput('y\r'),
      fixture.tool.interrupt('command-1'),
      fixture.tool.readVisible(),
      fixture.tool.readHistory(),
      fixture.tool.getState(),
    ];
    for (const call of calls) await expect(call).rejects.toThrow(/binding.*stale/i);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(fixture.sessionMock.readTerminalHistory).not.toHaveBeenCalled();
    expect(fixture.terminalMock.state).not.toHaveBeenCalled();
  });

  it('rejects captured tools at the turn lease before reading state/history or delegating', async () => {
    const revoked = new Error('Terminal tool grant is no longer active.');
    const assertLive = vi.fn(() => { throw revoked; });
    const sendInput = vi.fn();
    const interrupt = vi.fn();
    const fixture = setup({
      context: makeContext({ sendInput: true }),
      assertLive,
      sendInput,
      interrupt,
    });

    const calls = [
      fixture.tool.execute('pwd'),
      fixture.tool.sendInput('y\r'),
      fixture.tool.interrupt('command-1'),
      fixture.tool.readVisible(),
      fixture.tool.readHistory(),
      fixture.tool.getState(),
    ];
    for (const call of calls) await expect(call).rejects.toBe(revoked);
    expect(assertLive).toHaveBeenCalledTimes(6);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(sendInput).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    expect(fixture.sessionMock.readTerminalHistory).not.toHaveBeenCalled();
    expect(fixture.terminalMock.state).not.toHaveBeenCalled();
  });

  it('rejects a terminal whose transport or Host crosses the captured context', async () => {
    const fixture = setup();
    fixture.setDescriptor(makeDescriptor({ hostId: 'host-2' }));
    await expect(fixture.tool.readVisible()).rejects.toThrow(/Host.*no longer matches/i);

    fixture.setDescriptor(makeDescriptor({ transport: 'local', hostId: undefined }));
    await expect(fixture.tool.getState()).rejects.toThrow(/transport.*Host/i);
  });

  it('reads only bounded tails from persisted Session history', async () => {
    const history = `${'a'.repeat(150_000)}END`;
    const { tool, sessionMock } = setup({ history });

    await expect(tool.readVisible({ maxChars: 5 })).resolves.toBe('aaEND');
    await expect(tool.readVisible({ maxChars: 999_999 })).resolves.toHaveLength(30_000);
    await expect(tool.readHistory({ maxChars: 999_999 })).resolves.toHaveLength(120_000);
    expect(sessionMock.readTerminalHistory).toHaveBeenCalledWith('session-1');
  });

  it('merges live TerminalService state with current Session cwd and effective user', async () => {
    const { tool } = setup();
    await expect(tool.getState()).resolves.toMatchObject({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      hostId: 'host-1',
      activeExecutionId: 'command-active',
      cwd: '/srv/project',
      effectiveUser: 'deploy',
    });
  });

  it('keeps raw input disabled unless both permission and an explicit callback are present', async () => {
    const enabledWithoutCallback = setup({ context: makeContext({ sendInput: true }) });
    await expect(enabledWithoutCallback.tool.sendInput('secret\r')).rejects.toThrow(
      /sendInput.*disabled by default/i,
    );

    const callback = vi.fn();
    const deniedWithCallback = setup({ sendInput: callback });
    await expect(deniedWithCallback.tool.sendInput('y\r')).rejects.toThrow(/sendInput.*disabled/i);
    expect(callback).not.toHaveBeenCalled();
  });

  it('keeps interrupt disabled without an explicit callback', async () => {
    const { tool } = setup();
    await expect(tool.interrupt('command-1')).rejects.toThrow(/interrupt.*disabled/i);
  });
});
