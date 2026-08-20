import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostStore } from '../hosts/host-store';
import type { LocalFilesystemBackend } from '../filesystem/local-filesystem';
import type {
  RemoteFileStat,
  RemoteFilesystem,
  RemoteFilesystemProvider,
} from '../filesystem/remote-filesystem';
import type { TerminalSnapshot, TerminalService } from '../terminal/terminal-service';
import type { TerminalJournalEvent } from '../../shared/session';
import type { TerminalDescriptor } from '../../shared/terminal';
import { SessionManager } from './session-manager';
import { SessionStore } from './session-store';

const roots: string[] = [];

function owner(): WebContents {
  return { id: 7 } as unknown as WebContents;
}

function descriptor(id: string): TerminalDescriptor {
  return {
    id,
    title: 'Ubuntu',
    profileId: 'ssh:host',
    shellKind: 'posix',
    transport: 'ssh',
    hostId: 'host',
  };
}

function localDescriptor(id: string): TerminalDescriptor {
  return {
    id,
    title: 'PowerShell',
    profileId: 'powershell',
    shellKind: 'powershell',
    transport: 'local',
  };
}

function snapshot(id: string, output: string): TerminalSnapshot {
  return {
    descriptor: descriptor(id),
    startedAt: new Date(0).toISOString(),
    history: [{
      version: 1,
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      kind: 'output',
      data: output,
    }],
    preludeTruncated: false,
    droppedPreludeBytes: 0,
  };
}

function localSnapshot(id: string): TerminalSnapshot {
  return {
    descriptor: localDescriptor(id),
    startedAt: new Date(0).toISOString(),
    history: [],
    preludeTruncated: false,
    droppedPreludeBytes: 0,
  };
}

class FakeTerminals {
  readonly writes: string[] = [];
  readonly snapshots = new Map<string, TerminalSnapshot>();
  readonly bindings = new Map<string, string>();
  private journalListener?: (
    terminalId: string,
    sessionId: string,
    event: TerminalJournalEvent,
  ) => void;

  onJournal(listener: (
    terminalId: string,
    sessionId: string,
    event: TerminalJournalEvent,
  ) => void) {
    this.journalListener = listener;
    return () => { this.journalListener = undefined; };
  }
  snapshot(_owner: WebContents, terminalId: string) {
    const value = this.snapshots.get(terminalId);
    if (!value) throw new Error('missing snapshot');
    return value;
  }
  descriptor(_owner: WebContents, terminalId: string) {
    return { ...this.snapshot(_owner, terminalId).descriptor };
  }
  sessionId(_owner: WebContents, terminalId: string) { return this.bindings.get(terminalId); }
  bindSession(_owner: WebContents, terminalId: string, sessionId: string) {
    this.bindings.set(terminalId, sessionId);
  }
  write(_owner: WebContents, _terminalId: string, input: string) { this.writes.push(input); }
  emitOutput(terminalId: string, data: string) {
    const sessionId = this.bindings.get(terminalId);
    if (!sessionId) throw new Error('terminal is not bound');
    this.journalListener?.(terminalId, sessionId, {
      version: 1,
      sequence: 2,
      timestamp: new Date(1).toISOString(),
      kind: 'output',
      data,
    });
  }
  emitExit(terminalId: string) {
    const sessionId = this.bindings.get(terminalId);
    if (!sessionId) throw new Error('terminal is not bound');
    this.journalListener?.(terminalId, sessionId, {
      version: 1,
      sequence: 3,
      timestamp: new Date(2).toISOString(),
      kind: 'exit',
      exitCode: 0,
    });
  }
}

class FakeRemoteProvider {
  readonly calls: Array<{
    owner: WebContents;
    terminalId: string;
    expectedHostId?: string;
  }> = [];
  canonicalRoot = '/srv/project';
  readonly realpath = vi.fn(async (_path: string) => this.canonicalRoot);
  readonly stat = vi.fn(async (_path: string): Promise<RemoteFileStat | undefined> => ({
    type: 'directory' as const,
    size: 4_096,
    mode: 0o755,
    modifiedAt: new Date(0).toISOString(),
  }));
  readonly inspectCapabilities = vi.fn(async () => ({
    detection: 'advertised' as const,
    hardlink: true,
    fsync: true,
    posixRename: false,
    detectedAt: '2026-08-21T00:00:00.000Z',
  }));

  async withFilesystem<T>(
    browser: WebContents,
    terminalId: string,
    operation: (filesystem: RemoteFilesystem) => Promise<T>,
    expectedHostId?: string,
  ): Promise<T> {
    this.calls.push({ owner: browser, terminalId, expectedHostId });
    return operation({
      realpath: this.realpath,
      stat: this.stat,
    } as unknown as RemoteFilesystem);
  }
}

class FakeLocalFilesystem {
  canonicalRoot = '';
  readonly realpath = vi.fn(async (_path: string) => this.canonicalRoot);
  readonly stat = vi.fn(async (_path: string): Promise<RemoteFileStat | undefined> => ({
    type: 'directory' as const,
    size: 4_096,
    mode: 0o755,
    modifiedAt: new Date(0).toISOString(),
  }));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SessionManager reconnect restoration', () => {
  it('forwards typed Workspace operation records without emitting terminal events', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-operation-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('audit-terminal', snapshot('audit-terminal', 'ready\r\n'));
    const store = new SessionStore(join(root, 'sessions'));
    const manager = new SessionManager(
      store,
      terminals as unknown as TerminalService,
      { get: vi.fn(() => ({
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'tester',
      })) } as unknown as HostStore,
    );
    const session = manager.upgrade(owner(), 'audit-terminal');
    const terminalBefore = manager.readTerminalHistory(session.id);
    const handle = manager.beginWorkspaceOperation(session.id, {
      operation: 'stat',
      backend: 'sftp',
      target: { path: { scope: 'workspace', path: 'src/main.ts' } },
    });

    manager.finishWorkspaceOperation(handle, {
      outcome: 'succeeded',
      sideEffectCommitted: false,
      effect: { bytes: 512 },
    });

    expect(manager.readWorkspaceOperations(session.id)).toHaveLength(2);
    expect(manager.recoverWorkspaceOperations(session.id)[0]).toMatchObject({
      intent: { operation: 'stat' },
      sideEffectCommitted: false,
    });
    expect(manager.workspaceStorageProtection(session.id)).toEqual({
      root: resolve(join(root, 'sessions')),
      operationJournalPath: join(
        resolve(join(root, 'sessions')),
        session.id,
        'workspace',
        'operations.jsonl',
      ),
    });
    expect(manager.readTerminalHistory(session.id)).toBe(terminalBefore);
    manager.close();
  });

  it('captures prompt context, restores it on reconnect, and exposes the rebound Session', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set(
      'old-terminal',
      snapshot('old-terminal', 'tester@ubuntu:~$ sudo -i\r\nroot@ubuntu:/srv/project# '),
    );
    let currentHost = {
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'tester',
      };
    const hosts = {
      get: vi.fn(() => currentHost),
    } as unknown as HostStore;
    const manager = new SessionManager(
      new SessionStore(join(root, 'sessions')),
      terminals as unknown as TerminalService,
      hosts,
    );
    const browser = owner();

    const session = manager.upgrade(browser, 'old-terminal');
    expect(session).toMatchObject({ cwd: '/srv/project', effectiveUser: 'root' });

    terminals.emitOutput('old-terminal', '\r\nroot@ubuntu:/opt/new-project# ');
    expect(manager.list('host')[0]).toMatchObject({
      cwd: '/opt/new-project',
      effectiveUser: 'root',
    });
    terminals.emitExit('old-terminal');

    terminals.snapshots.set('new-terminal', snapshot('new-terminal', 'tester@ubuntu:~$ '));
    const reconnected = manager.reconnect(browser, descriptor('new-terminal'), session.id);

    expect(reconnected.runtimeTerminalId).toBe('new-terminal');
    expect(terminals.writes).toHaveLength(1);
    expect(terminals.writes[0]).toContain("sudo -iu 'root'");
    expect(terminals.writes[0]).toContain('/opt/new-project');
    expect(manager.sessionForTerminal(browser, 'new-terminal')?.id).toBe(session.id);

    terminals.snapshots.set('duplicate-terminal', snapshot('duplicate-terminal', 'tester@ubuntu:~$ '));
    expect(() => manager.reconnect(
      browser,
      descriptor('duplicate-terminal'),
      session.id,
    )).toThrow('仍有活动终端');
    expect(terminals.bindings.has('duplicate-terminal')).toBe(false);

    terminals.emitExit('new-terminal');
    currentHost = { ...currentHost, hostname: '192.0.2.99' };
    terminals.snapshots.set('changed-target-terminal', snapshot('changed-target-terminal', 'tester@ubuntu:~$ '));
    expect(() => manager.reconnect(
      browser,
      descriptor('changed-target-terminal'),
      session.id,
    )).toThrow('主机地址、端口或用户名已变更');
    expect(terminals.bindings.has('changed-target-terminal')).toBe(false);
    manager.close();
  });

  it('previews persisted content and deletes only an unchanged disconnected Session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-history-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('history-terminal', snapshot(
      'history-terminal',
      '\u001b[32mtester@ubuntu:~$\u001b[0m echo history\r\nhistory\r\n',
    ));
    const hosts = {
      get: vi.fn(() => ({
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'tester',
      })),
    } as unknown as HostStore;
    const store = new SessionStore(join(root, 'sessions'));
    const manager = new SessionManager(
      store,
      terminals as unknown as TerminalService,
      hosts,
    );
    const browser = owner();
    const created = manager.upgrade(browser, 'history-terminal');
    const threadId = '55555555-5555-5555-5555-555555555555';
    manager.bindAgentThread(created.id, 'provider', threadId, 'a'.repeat(64));
    manager.appendThreadEvent(created.id, threadId, {
      type: 'chat',
      item: {
        id: 'message-1',
        role: 'user',
        content: 'inspect this session',
        createdAt: new Date(3).toISOString(),
      },
    });

    const detail = manager.readHistoryDetail({ sessionId: created.id });
    expect(detail.terminal.content).toContain('echo history');
    expect(detail.terminal.content).not.toContain('\u001b[');
    expect(detail.conversation.messages[0]?.content).toBe('inspect this session');

    terminals.emitExit('history-terminal');
    await expect(manager.remove(browser, {
      sessionId: created.id,
      expectedUpdatedAt: created.updatedAt,
      expectedRuntimeTerminalId: created.runtimeTerminalId,
    })).rejects.toThrow('会话状态已发生变化');

    const disconnected = manager.list()[0]!;
    await manager.remove(browser, {
      sessionId: disconnected.id,
      expectedUpdatedAt: disconnected.updatedAt,
      expectedRuntimeTerminalId: disconnected.runtimeTerminalId,
    });
    expect(manager.list()).toEqual([]);
    manager.close();
  });
});

describe('SessionManager workspace binding', () => {
  it.runIf(process.platform === 'win32')(
    'rejects unsafe Windows root spellings before workspace persistence',
    async () => {
      const dataRoot = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-windows-root-test-'));
      roots.push(dataRoot);
      const terminals = new FakeTerminals();
      terminals.snapshots.set('local-terminal', localSnapshot('local-terminal'));
      const store = new SessionStore(join(dataRoot, 'sessions'));
      const local = new FakeLocalFilesystem();
      const manager = new SessionManager(
        store,
        terminals as unknown as TerminalService,
        { get: vi.fn() } as unknown as HostStore,
        {} as RemoteFilesystemProvider,
        local as unknown as LocalFilesystemBackend,
      );
      const browser = owner();

      for (const unsafeRoot of [
        'C:relative-project',
        '\\\\?\\C:\\project',
        'C:\\project\\visible:ads',
        'C:\\project\\CON',
      ]) {
        await expect(manager.setWorkspace(browser, {
          terminalId: 'local-terminal',
          root: unsafeRoot,
        })).rejects.toThrow();
      }
      expect(local.realpath).not.toHaveBeenCalled();

      local.canonicalRoot = 'C:\\canonical\\CONOUT$';
      await expect(manager.setWorkspace(browser, {
        terminalId: 'local-terminal',
        root: 'C:\\safe-project',
      })).rejects.toThrow('Windows 保留名称');
      expect(manager.sessionForTerminal(browser, 'local-terminal')?.workspace).toBeUndefined();
      manager.close();
    },
  );

  it('canonicalizes, persists, and clears a local directory selected explicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-local-workspace-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('local-terminal', localSnapshot('local-terminal'));
    const store = new SessionStore(join(root, 'sessions'));
    const local = new FakeLocalFilesystem();
    const requestedRoot = join(root, 'requested-project');
    local.canonicalRoot = join(root, 'canonical-project');
    const manager = new SessionManager(
      store,
      terminals as unknown as TerminalService,
      { get: vi.fn() } as unknown as HostStore,
      {} as RemoteFilesystemProvider,
      local as unknown as LocalFilesystemBackend,
    );
    const browser = owner();

    const updated = await manager.setWorkspace(browser, {
      terminalId: 'local-terminal',
      root: requestedRoot,
    });

    expect(local.realpath).toHaveBeenCalledWith(requestedRoot);
    expect(local.stat).toHaveBeenCalledWith(local.canonicalRoot);
    expect(updated.workspace).toEqual({
      backend: 'local',
      root: local.canonicalRoot,
    });
    expect(updated.workspace?.root).not.toBe(updated.cwd);

    const cleared = await manager.clearWorkspace(browser, {
      terminalId: 'local-terminal',
    });
    expect(cleared.workspace).toBeUndefined();
    expect(store.readAudit(updated.id).filter((event) => event.type === 'workspace_changed'))
      .toHaveLength(2);
    manager.close();
  });

  it('rechecks the Workspace guard after async validation and before persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-workspace-race-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('local-terminal', localSnapshot('local-terminal'));
    const store = new SessionStore(join(root, 'sessions'));
    const local = new FakeLocalFilesystem();
    const canonicalRoot = join(root, 'canonical-project');
    let finishRealpath!: (value: string) => void;
    local.realpath.mockImplementationOnce(() => new Promise<string>((resolve) => {
      finishRealpath = resolve;
    }));
    const manager = new SessionManager(
      store,
      terminals as unknown as TerminalService,
      { get: vi.fn() } as unknown as HostStore,
      {} as RemoteFilesystemProvider,
      local as unknown as LocalFilesystemBackend,
    );
    const browser = owner();
    let fileAccessMode: 'off' | 'read-only' = 'off';
    const beforeCommit = vi.fn(() => {
      if (fileAccessMode !== 'off') throw new Error('file access enabled during validation');
    });

    const update = manager.setWorkspace(browser, {
      terminalId: 'local-terminal',
      root: join(root, 'requested-project'),
    }, beforeCommit);
    expect(local.realpath).toHaveBeenCalledOnce();

    fileAccessMode = 'read-only';
    finishRealpath(canonicalRoot);

    await expect(update).rejects.toThrow('file access enabled during validation');
    expect(beforeCommit).toHaveBeenCalledOnce();
    expect(manager.sessionForTerminal(browser, 'local-terminal')?.workspace).toBeUndefined();
    expect(store.readAudit(manager.sessionForTerminal(browser, 'local-terminal')!.id)
      .filter((event) => event.type === 'workspace_changed')).toHaveLength(0);
    manager.close();
  });

  it('canonicalizes an SSH directory through the provider bound to the same Host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-ssh-workspace-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('ssh-terminal', snapshot('ssh-terminal', 'tester@ubuntu:~$ '));
    const remote = new FakeRemoteProvider();
    const manager = new SessionManager(
      new SessionStore(join(root, 'sessions')),
      terminals as unknown as TerminalService,
      { get: vi.fn(() => ({
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'tester',
      })) } as unknown as HostStore,
      remote as unknown as RemoteFilesystemProvider,
    );
    const browser = owner();

    const updated = await manager.setWorkspace(browser, {
      terminalId: 'ssh-terminal',
      root: '/srv/project-link',
    });

    expect(remote.calls).toEqual([{
      owner: browser,
      terminalId: 'ssh-terminal',
      expectedHostId: 'host',
    }]);
    expect(remote.realpath).toHaveBeenCalledWith('/srv/project-link');
    expect(remote.stat).toHaveBeenCalledWith('/srv/project');
    expect(updated.workspace).toEqual({
      backend: 'sftp',
      root: '/srv/project',
      hostId: 'host',
      remoteWritePolicy: 'strict',
    });
    manager.close();
  });

  it('persists remote policy changes and reports the cached server publication capabilities', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-ssh-atomicity-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('ssh-terminal', snapshot('ssh-terminal', 'tester@ubuntu:~$ '));
    const remote = new FakeRemoteProvider();
    const manager = new SessionManager(
      new SessionStore(join(root, 'sessions')),
      terminals as unknown as TerminalService,
      { get: vi.fn(() => ({
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'tester',
      })) } as unknown as HostStore,
      remote as unknown as RemoteFilesystemProvider,
    );
    const browser = owner();

    const updated = await manager.setWorkspace(browser, {
      terminalId: 'ssh-terminal',
      root: '/srv/project',
      remoteWritePolicy: 'compatible',
    });
    expect(updated.workspace?.remoteWritePolicy).toBe('compatible');
    await expect(manager.remoteWorkspaceAtomicity(browser, 'ssh-terminal')).resolves.toEqual({
      policy: 'compatible',
      capabilities: {
        detection: 'advertised',
        hardlink: true,
        fsync: true,
        posixRename: false,
        detectedAt: '2026-08-21T00:00:00.000Z',
      },
    });
    expect(remote.inspectCapabilities).toHaveBeenCalledWith(browser, 'ssh-terminal', 'host');
    manager.close();
  });

  it('rejects a remote policy on a local Workspace request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-local-policy-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('local-terminal', localSnapshot('local-terminal'));
    const manager = new SessionManager(
      new SessionStore(join(root, 'sessions')),
      terminals as unknown as TerminalService,
      { get: vi.fn() } as unknown as HostStore,
      {} as RemoteFilesystemProvider,
      new FakeLocalFilesystem() as unknown as LocalFilesystemBackend,
    );

    await expect(manager.setWorkspace(owner(), {
      terminalId: 'local-terminal',
      root: join(root, 'project'),
      remoteWritePolicy: 'strict',
    })).rejects.toThrow('valid only for an SSH workspace');
    manager.close();
  });

  it('rejects relative and non-directory roots before persisting a workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-manager-invalid-workspace-test-'));
    roots.push(root);
    const terminals = new FakeTerminals();
    terminals.snapshots.set('ssh-terminal', snapshot('ssh-terminal', 'tester@ubuntu:~$ '));
    const remote = new FakeRemoteProvider();
    const manager = new SessionManager(
      new SessionStore(join(root, 'sessions')),
      terminals as unknown as TerminalService,
      { get: vi.fn(() => ({
        id: 'host',
        name: 'Ubuntu',
        hostname: '192.0.2.10',
        port: 22,
        username: 'tester',
      })) } as unknown as HostStore,
      remote as unknown as RemoteFilesystemProvider,
    );
    const browser = owner();

    await expect(manager.setWorkspace(browser, {
      terminalId: 'ssh-terminal',
      root: 'relative/project',
    })).rejects.toThrow('absolute POSIX path');
    expect(remote.calls).toEqual([]);

    remote.stat.mockResolvedValueOnce({
      type: 'file',
      size: 12,
      mode: 0o644,
      modifiedAt: new Date(0).toISOString(),
    });
    await expect(manager.setWorkspace(browser, {
      terminalId: 'ssh-terminal',
      root: '/srv/file',
    })).rejects.toThrow('existing directory');
    expect(manager.sessionForTerminal(browser, 'ssh-terminal')?.workspace).toBeUndefined();
    manager.close();
  });
});
