import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  statSync,
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
import { LocalFilesystemBackend } from '../filesystem/local-filesystem';
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

  it('normalizes local diff header separators without changing backend paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-diff-label-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'demo.ts'), 'old\n', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;
    const current = await service.readText(owner, 'terminal', 'src/demo.ts');

    const result = await service.applyPatch(
      owner,
      'terminal',
      'src/demo.ts',
      current.sha256,
      [{ search: 'old', replace: 'new' }],
    );
    expect(result.diff).toContain('--- a/src/demo.ts');
    expect(result.diff).not.toContain('src\\demo.ts');
    expect(result.path).toBe(join(root, 'src', 'demo.ts'));
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
      .rejects.toThrow('符号链接');
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
    expect(localFilesystem.readFile).toHaveBeenCalledWith(file, AGENT_FILE_LIMITS.maxBytes);
    expect(localFilesystem.listDirectory).toHaveBeenCalledWith(root);
    expect(localFilesystem.lstat).toHaveBeenCalledWith(file);
  });

  it('uses one RemoteFilesystem abstraction with the expected Host and atomic overwrite', async () => {
    const current = Buffer.from('old\n');
    const standardRename = vi.fn(async () => undefined);
    const atomicRename = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work'
          ? remoteStat('directory')
          : path.endsWith('/new.ts')
            ? undefined
            : remoteStat('file', current.length)
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

  it('treats a leading backslash as a legal SSH filename, not a Windows absolute path', async () => {
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async () => remoteStat('file', 7)),
    });
    const { service } = createSshService(filesystem);

    await expect(service.statPath(
      { id: 1 } as WebContents,
      'terminal',
      '\\lead.txt',
    )).resolves.toMatchObject({ path: '/work/\\lead.txt', type: 'file' });
  });

  it('still detects an SSH rename into a child whose filename begins with backslash', async () => {
    const rename = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work' || path === '/work/source') return remoteStat('directory');
        return undefined;
      }),
      rename,
    });
    const { service } = createSshService(filesystem);

    await expect(service.renamePath(
      { id: 1 } as WebContents,
      'terminal',
      'source',
      'source/\\lead',
    )).rejects.toThrow('自身内部');
    expect(rename).not.toHaveBeenCalled();
  });

  it('searches and globs local UTF-8 files deterministically without following symlinks', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-search-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const outside = join(container, 'outside');
    mkdirSync(join(root, 'src', 'nested'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, 'src', 'a.ts'), 'const engine = "TensorRT";\nTensorRT();\n', 'utf8');
    writeFileSync(join(root, 'src', 'nested', 'b.ts'), 'const literal = "a+b";\n', 'utf8');
    writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(outside, 'outside.ts'), 'TensorRT outside', 'utf8');
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    const search = await service.search(owner, 'terminal', 'TensorRT');
    expect(search).toMatchObject({ query: 'TensorRT', filesScanned: 3, truncated: false });
    expect(search.matches.map((match) => [match.path, match.line, match.column])).toEqual([
      [join(root, 'src', 'a.ts'), 1, 17],
      [join(root, 'src', 'a.ts'), 2, 1],
    ]);
    expect(search.matches.every((match) => !match.path.includes('linked'))).toBe(true);

    const glob = await service.glob(owner, 'terminal', '**/*.ts');
    expect(glob).toEqual({
      pattern: '**/*.ts',
      paths: [join(root, 'src', 'a.ts'), join(root, 'src', 'nested', 'b.ts')],
      truncated: false,
    });
    await expect(service.search(owner, 'terminal', 'a+b', { path: 'src' }))
      .resolves.toMatchObject({ matches: [{ path: join(root, 'src', 'nested', 'b.ts') }] });
  });

  it('reports result and oversized-file bounds as truncated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-search-bounds-'));
    roots.push(root);
    writeFileSync(join(root, 'a.txt'), 'needle needle\n', 'utf8');
    writeFileSync(join(root, 'oversized.txt'), 'x'.repeat(AGENT_FILE_LIMITS.maxBytes + 1), 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await expect(service.search(owner, 'terminal', 'needle', { maxResults: 1 }))
      .resolves.toMatchObject({
        matches: [{ path: join(root, 'a.txt') }],
        truncated: true,
      });
    await expect(service.search(owner, 'terminal', 'not-present'))
      .resolves.toMatchObject({ matches: [], truncated: true });
    await expect(service.glob(owner, 'terminal', '**', { maxResults: 1 }))
      .resolves.toMatchObject({ paths: [join(root, 'a.txt')], truncated: true });
  });

  it('supports safe local mkdir, rename, and bounded recursive deletion', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-mutations-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const outside = join(container, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep', 'utf8');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await service.mkdirPath(owner, 'terminal', 'created');
    expect(statSync(join(root, 'created')).isDirectory()).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(join(root, 'created')).mode & 0o777).toBe(0o700);
    }
    writeFileSync(join(root, 'created', 'from.txt'), 'value', 'utf8');
    await service.renamePath(owner, 'terminal', 'created/from.txt', 'created/to.txt');
    expect(existsSync(join(root, 'created', 'to.txt'))).toBe(true);

    mkdirSync(join(root, 'created', 'nested'));
    writeFileSync(join(root, 'created', 'nested', 'child.txt'), 'child', 'utf8');
    symlinkSync(outside, join(root, 'created', 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    await service.deletePath(owner, 'terminal', 'created', { recursive: true });
    expect(existsSync(join(root, 'created'))).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    await expect(service.deletePath(owner, 'terminal', '.', { recursive: true }))
      .rejects.toThrow('Workspace Root');
  });

  it('rejects mutation through a linked parent and leaves the target untouched', async () => {
    const container = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-mutation-link-'));
    roots.push(container);
    const root = join(container, 'workspace');
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'keep.txt'), 'keep', 'utf8');
    symlinkSync(real, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = createService(root);
    const owner = { id: 1 } as WebContents;

    await expect(service.mkdirPath(owner, 'terminal', 'linked/new'))
      .rejects.toThrow('符号链接');
    await expect(service.deletePath(owner, 'terminal', 'linked/keep.txt'))
      .rejects.toThrow('符号链接');
    const expected = createHash('sha256').update('keep').digest('hex');
    await expect(service.writeText(owner, 'terminal', 'linked/keep.txt', 'changed', expected))
      .rejects.toThrow('符号链接');
    await expect(service.writeText(owner, 'terminal', 'linked/new.txt', 'new', null))
      .rejects.toThrow('符号链接');
    expect(readFileSync(join(real, 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(real, 'new.txt'))).toBe(false);
  });

  it('keeps remote search and glob on one Host-bound filesystem lease per call', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', remoteStat('directory')],
      ['/work/src', remoteStat('directory')],
      ['/work/src/a.ts', remoteStat('file', 13)],
      ['/work/src/b.txt', remoteStat('file', 4)],
      ['/work/linked', remoteStat('symlink')],
      ['/work/dir\\name.ts', remoteStat('file', 6)],
    ]);
    const contents = new Map<string, Buffer>([
      ['/work/src/a.ts', Buffer.from('needle\nneedle')],
      ['/work/src/b.txt', Buffer.from([0, 1, 2, 3])],
      ['/work/dir\\name.ts', Buffer.from('remote')],
    ]);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => stats.get(path)),
      stat: vi.fn(async (path: string) => stats.get(path)),
      readFile: vi.fn(async (path: string) => contents.get(path) ?? Buffer.alloc(0)),
      listDirectory: vi.fn(async (path: string) => {
        const prefix = `${path}/`;
        return [...stats.entries()]
          .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
          .map(([candidate, stat]) => ({
            name: candidate.slice(prefix.length), path: candidate, stat,
          }));
      }),
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await expect(service.search(owner, 'terminal', 'needle', { maxResults: 5 }))
      .resolves.toMatchObject({
        matches: [
          { path: '/work/src/a.ts', line: 1 },
          { path: '/work/src/a.ts', line: 2 },
        ],
        truncated: false,
      });
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    await expect(service.glob(owner, 'terminal', '**/*.ts'))
      .resolves.toMatchObject({ paths: ['/work/dir\\name.ts', '/work/src/a.ts'] });
    expect(withFilesystem).toHaveBeenCalledTimes(2);
    await expect(service.glob(owner, 'terminal', 'dir\\*.ts'))
      .resolves.toMatchObject({ paths: ['/work/dir\\name.ts'] });
    expect(withFilesystem).toHaveBeenCalledTimes(3);
  });

  it('applies a remote patch in one lease, publishes exclusively, and returns a relative diff', async () => {
    const current = Buffer.from('const value = 1;\n');
    const writeFile = vi.fn(async () => undefined);
    const atomicReplace = vi.fn(async () => undefined);
    const unlink = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' || path === '/work/src'
          ? remoteStat('directory')
          : remoteStat('file', current.length)
      )),
      stat: vi.fn(async () => remoteStat('file', current.length)),
      readFile: vi.fn(async () => current),
      writeFile,
      atomicReplace,
      unlink,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const expected = createHash('sha256').update(current).digest('hex');
    const result = await service.applyPatch(
      { id: 1 } as WebContents,
      'terminal',
      'src/demo.ts',
      expected,
      [{ search: 'value = 1', replace: 'value = 2' }],
    );

    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ additions: 1, deletions: 1, diffTruncated: false });
    expect(result.diff).toContain('--- a/src/demo.ts');
    expect(result.diff).not.toContain('/work');
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/^\/work\/src\/\.ai-terminal-/u),
      Buffer.from('const value = 2;\n'),
      0o644,
      true,
    );
    expect(atomicReplace).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('detects a remote write race on the second hash check and cleans its temp file', async () => {
    const original = Buffer.from('old\n');
    const changed = Buffer.from('raced\n');
    const readFile = vi.fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(changed);
    const unlink = vi.fn(async () => undefined);
    const atomicReplace = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' ? remoteStat('directory') : remoteStat('file', original.length)
      )),
      stat: vi.fn(async () => remoteStat('file', original.length)),
      readFile,
      unlink,
      atomicReplace,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const expected = createHash('sha256').update(original).digest('hex');

    await expect(service.applyPatch(
      { id: 1 } as WebContents,
      'terminal',
      'demo.ts',
      expected,
      [{ search: 'old', replace: 'new' }],
    )).rejects.toThrow('文件已变化');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(atomicReplace).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining('.ai-terminal-'));
  });

  it('uses one remote lease for each mkdir, rename, and delete mutation', async () => {
    const mkdir = vi.fn(async () => undefined);
    const rename = vi.fn(async () => undefined);
    const unlink = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work') return remoteStat('directory');
        if (path === '/work/from' || path === '/work/file') return remoteStat('file', 1);
        return undefined;
      }),
      mkdir,
      rename,
      unlink,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const owner = { id: 1 } as WebContents;

    await service.mkdirPath(owner, 'terminal', 'new');
    await service.renamePath(owner, 'terminal', 'from', 'to');
    await service.deletePath(owner, 'terminal', 'file');

    expect(withFilesystem).toHaveBeenCalledTimes(3);
    expect(mkdir).toHaveBeenCalledWith('/work/new', 0o700);
    expect(rename).toHaveBeenCalledWith('/work/from', '/work/to');
    expect(unlink).toHaveBeenCalledWith('/work/file');
  });

  it('preflights a remote recursive delete fully before mutating and uses one lease', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', remoteStat('directory')],
      ['/work/tree', remoteStat('directory')],
      ['/work/tree/a.txt', remoteStat('file', 1)],
      ['/work/tree/nested', remoteStat('directory')],
      ['/work/tree/nested/b.txt', remoteStat('file', 1)],
      ['/work/tree/outside-link', remoteStat('symlink')],
    ]);
    const children = (path: string) => {
      const prefix = `${path}/`;
      return [...stats.entries()]
        .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
        .map(([candidate, stat]) => ({ name: candidate.slice(prefix.length), path: candidate, stat }));
    };
    const unlink = vi.fn(async (_path: string) => undefined);
    const rmdir = vi.fn(async (_path: string) => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => stats.get(path)),
      listDirectory: vi.fn(async (path: string) => children(path)),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);

    await service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      'tree',
      { recursive: true },
    );

    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink.mock.calls.map(([path]) => path)).toEqual([
      '/work/tree/a.txt',
      '/work/tree/nested/b.txt',
      '/work/tree/outside-link',
    ]);
    expect(rmdir.mock.calls.map(([path]) => path)).toEqual([
      '/work/tree/nested',
      '/work/tree',
    ]);
  });

  it('has zero mutation side effects when recursive delete preflight fails', async () => {
    const unlink = vi.fn(async () => undefined);
    const rmdir = vi.fn(async () => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => {
        if (path === '/work' || path === '/work/tree') return remoteStat('directory');
        if (path === '/work/tree/a.txt') return remoteStat('file', 1);
        return undefined;
      }),
      listDirectory: vi.fn(async () => [
        { name: 'a.txt', path: '/work/tree/a.txt', stat: remoteStat('file', 1) },
        { name: 'bad/name', path: '/outside', stat: remoteStat('file', 1) },
      ]),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);

    await expect(service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      'tree',
      { recursive: true },
    )).rejects.toThrow('不安全的目录条目');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('has zero mutation side effects when recursive delete exceeds its depth budget', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', remoteStat('directory')],
      ['/work/tree', remoteStat('directory')],
    ]);
    let parent = '/work/tree';
    for (let depth = 0; depth <= AGENT_FILE_LIMITS.maxRecursiveDeleteDepth; depth += 1) {
      parent = `${parent}/d${depth}`;
      stats.set(parent, remoteStat('directory'));
    }
    const unlink = vi.fn(async (_path: string) => undefined);
    const rmdir = vi.fn(async (_path: string) => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => stats.get(path)),
      listDirectory: vi.fn(async (path: string) => {
        const prefix = `${path}/`;
        return [...stats.entries()]
          .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
          .map(([candidate, attributes]) => ({
            name: candidate.slice(prefix.length), path: candidate, stat: attributes,
          }));
      }),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);

    await expect(service.deletePath(
      { id: 1 } as WebContents,
      'terminal',
      'tree',
      { recursive: true },
    )).rejects.toThrow('层限制');
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('does not mutate when an empty-directory listing exhausts the delete deadline', async () => {
    let clock = 0;
    const unlink = vi.fn(async (_path: string) => undefined);
    const rmdir = vi.fn(async (_path: string) => undefined);
    const filesystem = fakeRemoteFilesystem({
      lstat: vi.fn(async (path: string) => (
        path === '/work' || path === '/work/empty' ? remoteStat('directory') : undefined
      )),
      listDirectory: vi.fn(async () => {
        clock = AGENT_FILE_LIMITS.maxRecursiveDeleteDurationMs;
        return [];
      }),
      unlink,
      rmdir,
    });
    const { service, withFilesystem } = createSshService(filesystem);
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      await expect(service.deletePath(
        { id: 1 } as WebContents,
        'terminal',
        'empty',
        { recursive: true },
      )).rejects.toThrow('预检超时');
    } finally {
      dateNow.mockRestore();
    }
    expect(withFilesystem).toHaveBeenCalledTimes(1);
    expect(unlink).not.toHaveBeenCalled();
    expect(rmdir).not.toHaveBeenCalled();
  });

  it('detects a local write race on the second bounded hash check and removes its temp file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-terminal-agent-local-race-'));
    roots.push(root);
    const path = join(root, 'demo.txt');
    writeFileSync(path, 'old\n', 'utf8');
    const backend = new LocalFilesystemBackend();
    vi.spyOn(backend, 'readFile')
      .mockResolvedValueOnce(Buffer.from('old\n'))
      .mockResolvedValueOnce(Buffer.from('raced\n'));
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
      backend,
    );
    const expected = createHash('sha256').update('old\n').digest('hex');

    await expect(service.writeText(
      { id: 1 } as WebContents,
      'terminal',
      'demo.txt',
      'new\n',
      expected,
    )).rejects.toThrow('文件已变化');
    expect(readFileSync(path, 'utf8')).toBe('old\n');
    expect(readdirSync(root)).toEqual(['demo.txt']);
  });
});
