import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import { buildSessionToolContext, workspacePermissions } from './session-tool-context';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 1,
    id: 'session-1',
    name: 'Test',
    nameSource: 'automatic',
    transport: 'ssh',
    hostId: 'host-1',
    shellProfileId: 'ssh:host-1',
    shellKind: 'posix',
    targetSnapshot: { label: 'Test' },
    connectionState: 'connected',
    status: 'active',
    runtimeTerminalId: 'terminal-1',
    pinned: false,
    preludeTruncated: false,
    droppedPreludeBytes: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    promotedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastConnectedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalDescriptor> = {}): TerminalDescriptor {
  return {
    id: 'terminal-1',
    title: 'Test',
    profileId: 'ssh:host-1',
    shellKind: 'posix',
    transport: 'ssh',
    hostId: 'host-1',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('Session tool context', () => {
  it('builds mode-bounded granular workspace policies', () => {
    const binding = { backend: 'local' as const, root: 'C:\\project' };
    expect(workspacePermissions('off', binding)).toEqual({
      enabled: false,
      mode: 'off',
      read: false,
      write: false,
      create: false,
      delete: false,
      readablePaths: [],
      writablePaths: [],
      fullAccess: false,
    });

    expect(workspacePermissions('read-only', binding, {
      read: true,
      write: true,
      create: true,
      delete: true,
      readablePaths: ['C:\\project\\src'],
      writablePaths: ['C:\\project\\src'],
      fullAccess: true,
    })).toEqual({
      enabled: true,
      mode: 'read-only',
      read: true,
      write: false,
      create: false,
      delete: false,
      readablePaths: ['C:\\project\\src'],
      writablePaths: [],
      fullAccess: false,
    });

    expect(workspacePermissions('read-write', binding, {
      read: false,
      write: true,
      create: false,
      delete: true,
      readablePaths: ['C:\\project\\read'],
      writablePaths: ['C:\\project\\write'],
      fullAccess: true,
    })).toMatchObject({
      enabled: true,
      mode: 'read-write',
      read: false,
      write: true,
      create: false,
      delete: true,
      readablePaths: [],
      writablePaths: ['C:\\project\\write'],
      fullAccess: false,
    });
  });

  it('enables path-unbounded policy only for full-access mode', () => {
    const binding = { backend: 'sftp' as const, root: '/srv/project', hostId: 'host-1' };
    expect(workspacePermissions('full-access', binding)).toMatchObject({
      enabled: true,
      mode: 'full-access',
      read: true,
      write: true,
      create: true,
      delete: true,
      fullAccess: true,
    });
    expect(workspacePermissions('full-access', binding, {
      read: true,
      write: false,
      create: false,
      delete: false,
      readablePaths: [],
      writablePaths: [],
      fullAccess: true,
    })).toMatchObject({
      read: true,
      write: false,
      create: false,
      delete: false,
      fullAccess: true,
    });
  });

  it('binds one SSH terminal and SFTP workspace to the same Host', () => {
    const bound = session({
      workspace: { backend: 'sftp', root: '/home/user/project', hostId: 'host-1' },
    });
    const permissions = workspacePermissions('read-write', bound.workspace);
    const context = buildSessionToolContext(bound, terminal(), {
      workspacePermissions: permissions,
    });

    expect(context.terminal).toEqual({
      type: 'ssh', terminalId: 'terminal-1', hostId: 'host-1',
    });
    expect(context.workspace).toEqual(bound.workspace);
    expect(context.permissions.workspace).toMatchObject({
      enabled: true,
      read: true,
      write: true,
      readablePaths: ['/home/user/project'],
      writablePaths: ['/home/user/project'],
    });
  });

  it('supports a formal Session with no Workspace Root', () => {
    const context = buildSessionToolContext(session(), terminal());
    expect(context.workspace).toBeUndefined();
    expect(context.permissions.workspace.enabled).toBe(false);
  });

  it('rejects a hidden or cross-host terminal/workspace combination', () => {
    const bound = session({
      workspace: { backend: 'sftp', root: '/srv/project', hostId: 'host-2' },
    });
    expect(() => buildSessionToolContext(bound, terminal())).toThrow(/same Host/);
    expect(() => buildSessionToolContext(
      session({ runtimeTerminalId: 'another-terminal' }),
      terminal(),
    )).toThrow(/currently bound terminal/);
    expect(() => buildSessionToolContext(
      session({
        transport: 'local',
        hostId: undefined,
        workspace: { backend: 'sftp', root: '/srv/project', hostId: 'host-1' },
      }),
      terminal({ transport: 'local', hostId: undefined }),
    )).toThrow(/backend/);
  });
});
