import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import type {
  RemoteFilesystem,
  RemoteFilesystemProvider,
  RemoteFileStat,
} from '../filesystem/remote-filesystem';
import type { SessionManager } from '../sessions/session-manager';
import type { TerminalService } from '../terminal/terminal-service';
import { AGENT_FILE_LIMITS, AgentFileService } from './agent-file-service';

const roots: string[] = [];

function createService(root: string): AgentFileService {
  const sessions = {
    sessionForTerminal: () => ({
      id: 'session-id',
      transport: 'local',
      cwd: root,
      workspace: { backend: 'local', root },
    }),
  } as unknown as SessionManager;
  return new AgentFileService({} as TerminalService, sessions);
}

function remoteStat(type: RemoteFileStat['type'], size = 0): RemoteFileStat {
  return {
    mode: type === 'file' ? 0o644 : type === 'directory' ? 0o755 : 0o777,
    size,
    type,
    modifiedAt: '2026-08-16T00:00:00.000Z',
  };
}

function fakeRemoteFilesystem(
  overrides: Partial<RemoteFilesystem> = {},
): RemoteFilesystem {
  return {
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async () => undefined),
    lstat: vi.fn(async () => undefined),
    readFile: vi.fn(async () => Buffer.alloc(0)),
    writeFile: vi.fn(async () => undefined),
    listDirectory: vi.fn(async () => []),
    rename: vi.fn(async () => undefined),
    atomicReplace: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createSshService(filesystem: RemoteFilesystem) {
  const withFilesystem = vi.fn(async <T>(
    _owner: WebContents,
    _terminalId: string,
    operation: (remote: RemoteFilesystem) => Promise<T>,
    _expectedHostId?: string,
  ) => operation(filesystem));
  const provider = { withFilesystem } as unknown as RemoteFilesystemProvider;
  const openSftp = vi.fn(() => {
    throw new Error('AgentFileService must not open SFTP directly.');
  });
  const sessions = {
    sessionForTerminal: () => ({
      id: 'session-id',
      transport: 'ssh',
      hostId: 'host-1',
      cwd: '/work',
      workspace: { backend: 'sftp', root: '/work', hostId: 'host-1' },
    }),
  } as unknown as SessionManager;
  return {
    service: new AgentFileService(
      { openSftp } as unknown as TerminalService,
      sessions,
      provider,
    ),
    withFilesystem,
    openSftp,
  };
}

describe('AgentFileService local workspace boundary', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads, conflict-checks, patches, and atomically writes UTF-8 files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-files-'));
    roots.push(root);
    writeFileSync(join(root, 'demo.ts'), 'const value = 1;\n', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    const initial = await service.readText(owner, 'terminal', 'demo.ts');
    expect(initial.content).toBe('const value = 1;\n');
    await expect(service.writeText(owner, 'terminal', 'demo.ts', 'unsafe', null))
      .rejects.toThrow('expectedSha256');

    const patched = await service.applyPatch(
      owner,
      'terminal',
      'demo.ts',
      initial.sha256,
      [{ search: 'value = 1', replace: 'value = 2' }],
    );
    expect(patched.created).toBe(false);
    expect(readFileSync(join(root, 'demo.ts'), 'utf8')).toBe('const value = 2;\n');

    const created = await service.writeText(owner, 'terminal', 'new.ts', 'export {};\n', null);
    expect(created.created).toBe(true);
    expect(readFileSync(join(root, 'new.ts'), 'utf8')).toBe('export {};\n');
  });

  it('requires an explicit compatible Workspace Root instead of falling back to cwd', async () => {
    const owner = { id: 1 } as WebContents;
    const noWorkspace = new AgentFileService({} as TerminalService, {
      sessionForTerminal: () => ({
        id: 'session-id', transport: 'local', cwd: process.cwd(),
      }),
    } as unknown as SessionManager);
    await expect(noWorkspace.bindWorkspaceRoot(owner, 'terminal'))
      .rejects.toThrow('请先设置 Workspace Root');

    const wrongBackend = new AgentFileService({} as TerminalService, {
      sessionForTerminal: () => ({
        id: 'session-id',
        transport: 'local',
        workspace: { backend: 'sftp', root: '/work', hostId: 'host-1' },
      }),
    } as unknown as SessionManager);
    await expect(wrongBackend.bindWorkspaceRoot(owner, 'terminal')).rejects.toThrow(/backend/i);

    const withFilesystem = vi.fn();
    const wrongHost = new AgentFileService(
      {} as TerminalService,
      {
        sessionForTerminal: () => ({
          id: 'session-id',
          transport: 'ssh',
          hostId: 'host-1',
          workspace: { backend: 'sftp', root: '/work', hostId: 'host-2' },
        }),
      } as unknown as SessionManager,
      { withFilesystem } as unknown as RemoteFilesystemProvider,
    );
    await expect(wrongHost.bindWorkspaceRoot(owner, 'terminal')).rejects.toThrow(/Host/);
    expect(withFilesystem).not.toHaveBeenCalled();
  });

  it('keeps file access bound to session.workspace when cwd changes and rejects root overrides', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-workspace-root-'));
    const other = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-cwd-'));
    roots.push(root, other);
    writeFileSync(join(root, 'bound.txt'), 'workspace', 'utf8');
    writeFileSync(join(other, 'bound.txt'), 'cwd', 'utf8');
    const session = {
      id: 'session-id',
      transport: 'local' as const,
      cwd: root,
      workspace: { backend: 'local' as const, root },
    };
    const service = new AgentFileService({} as TerminalService, {
      sessionForTerminal: () => session,
    } as unknown as SessionManager);
    const owner = { id: 1 } as WebContents;

    expect(await service.bindWorkspaceRoot(owner, 'terminal')).toBe(root);
    session.cwd = other;
    await expect(service.readText(owner, 'terminal', 'bound.txt')).resolves.toMatchObject({
      content: 'workspace',
    });
    await expect(service.readText(owner, 'terminal', 'bound.txt', other))
      .rejects.toThrow(/Workspace Root.*不一致/);
  });

  it('rejects traversal, ambiguous patches, and oversized content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-files-'));
    roots.push(root);
    writeFileSync(join(root, 'repeat.txt'), 'same\nsame\n', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;
    const initial = await service.readText(owner, 'terminal', 'repeat.txt');

    await expect(service.readText(owner, 'terminal', '../outside.txt'))
      .rejects.toThrow('超出当前会话工作目录');
    await expect(service.applyPatch(owner, 'terminal', 'repeat.txt', initial.sha256, [{
      search: 'same',
      replace: 'changed',
    }])).rejects.toThrow('不唯一');
    await expect(service.writeText(
      owner,
      'terminal',
      'large.txt',
      'x'.repeat(AGENT_FILE_LIMITS.maxBytes + 1),
      null,
    )).rejects.toThrow('超过');
  });

  it.runIf(process.platform === 'win32')(
    'rejects Windows alternate streams and reserved device names',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-windows-paths-'));
      roots.push(root);
      const service = createService(root);
      const owner = { id: 1 } as WebContents;

      await expect(service.writeText(owner, 'terminal', 'visible.txt:hidden', 'x', null))
        .rejects.toThrow('备用数据流');
      await expect(service.writeText(owner, 'terminal', 'CON.txt', 'x', null))
        .rejects.toThrow('Windows 保留名称');
    },
  );

  it('does not follow a linked directory outside the formal Session cwd', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-boundary-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const outside = join(container, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await expect(service.statPath(owner, 'terminal', 'linked')).resolves.toMatchObject({
      type: 'symlink',
      path: join(root, 'linked'),
    });
    await expect(service.readText(owner, 'terminal', 'linked/secret.txt'))
      .rejects.toThrow('超出当前会话工作目录');
    await expect(service.writeText(owner, 'terminal', 'linked/new.txt', 'unsafe', null))
      .rejects.toThrow('超出当前会话工作目录');
  });

  it('fails closed if the bound workspace root is later replaced by a link', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-root-swap-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const movedRoot = join(container, 'workspace-old');
    const outside = join(container, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;
    const boundRoot = await service.bindWorkspaceRoot(owner, 'terminal');

    renameSync(root, movedRoot);
    symlinkSync(outside, root, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(service.readText(owner, 'terminal', 'secret.txt', boundRoot))
      .rejects.toThrow('根目录已被替换或重定向');
  });

  it('lists only the current workspace directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-files-'));
    roots.push(root);
    writeFileSync(join(root, 'one.txt'), '1', 'utf8');
    writeFileSync(join(root, 'two.txt'), '22', 'utf8');
    const result = await createService(root).list({ id: 1 } as WebContents, 'terminal');
    expect(result.path).toBe(root);
    expect(result.entries.map((entry) => entry.name).sort()).toEqual(['one.txt', 'two.txt']);
    expect(result.truncated).toBe(false);
  });

  it('routes local bind, read, list, and stat through the injected backend', async () => {
    const root = resolve('virtual-local-workspace');
    const file = resolve(root, 'demo.ts');
    const localFilesystem = fakeRemoteFilesystem({
      realpath: vi.fn(async (path: string) => path),
      stat: vi.fn(async (path: string) => (
        path === root ? remoteStat('directory') : remoteStat('file', 5)
      )),
      lstat: vi.fn(async () => remoteStat('file', 5)),
      readFile: vi.fn(async () => Buffer.from('hello')),
      listDirectory: vi.fn(async () => [{
        name: 'demo.ts', path: file, stat: remoteStat('file', 5),
      }]),
    });
    const sessions = {
      sessionForTerminal: () => ({
        id: 'session-id',
        transport: 'local',
        workspace: { backend: 'local', root },
      }),
    } as unknown as SessionManager;
    const service = new AgentFileService(
      {} as TerminalService,
      sessions,
      {} as RemoteFilesystemProvider,
      localFilesystem,
    );
    const owner = { id: 1 } as WebContents;

    await expect(service.bindWorkspaceRoot(owner, 'terminal')).resolves.toBe(root);
    await expect(service.readText(owner, 'terminal', 'demo.ts')).resolves.toMatchObject({
      path: file, content: 'hello', bytes: 5,
    });
    await expect(service.list(owner, 'terminal')).resolves.toMatchObject({
      path: root,
      entries: [{ name: 'demo.ts', type: 'file', size: 5 }],
    });
    await expect(service.statPath(owner, 'terminal', 'demo.ts')).resolves.toEqual({
      path: file,
      ...remoteStat('file', 5),
    });
    expect(localFilesystem.readFile).toHaveBeenCalledWith(file);
    expect(localFilesystem.listDirectory).toHaveBeenCalledWith(root);
    expect(localFilesystem.lstat).toHaveBeenCalledWith(file);
  });

  it('uses one RemoteFilesystem abstraction with the expected Host and atomic overwrite', async () => {
    const current = Buffer.from('old\n');
    const standardRename = vi.fn(async () => undefined);
    const atomicRename = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path.endsWith('/new.ts') ? undefined : remoteStat('file', current.length)
      )),
      readFile: vi.fn(async () => current),
      rename: standardRename,
      atomicReplace: atomicRename,
    });
    const { service, withFilesystem, openSftp } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await expect(service.writeText(owner, 'terminal', 'new.ts', 'new\n', null, '/work'))
      .resolves.toMatchObject({ created: true, path: '/work/new.ts' });
    expect(withFilesystem).toHaveBeenNthCalledWith(
      1,
      owner,
      'terminal',
      expect.any(Function),
      'host-1',
    );
    expect(standardRename).toHaveBeenCalledTimes(1);
    expect(atomicRename).not.toHaveBeenCalled();

    await expect(service.writeText(
      owner,
      'terminal',
      'existing.ts',
      'changed\n',
      createHash('sha256').update(current).digest('hex'),
      '/work',
    )).resolves.toMatchObject({ created: false, path: '/work/existing.ts' });
    expect(withFilesystem).toHaveBeenNthCalledWith(
      2,
      owner,
      'terminal',
      expect.any(Function),
      'host-1',
    );
    expect(atomicRename).toHaveBeenCalledTimes(1);
    expect(openSftp).not.toHaveBeenCalled();
  });

  it('rejects a remote final-component symlink before reading or replacing it', async () => {
    const readFile = vi.fn();
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async () => remoteStat('symlink')),
      readFile,
    });
    const { service } = createSshService(filesystem);

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'linked.ts',
      'unsafe',
      'a'.repeat(64),
      '/work',
    )).rejects.toThrow('符号链接');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('returns remote stat metadata through the Host-bound filesystem', async () => {
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async () => remoteStat('file', 42)),
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await expect(service.statPath(owner, 'terminal', 'demo.ts')).resolves.toEqual({
      path: '/work/demo.ts',
      ...remoteStat('file', 42),
    });
    expect(withFilesystem).toHaveBeenCalledWith(
      owner,
      'terminal',
      expect.any(Function),
      'host-1',
    );
  });
});
