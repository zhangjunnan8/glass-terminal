import type { WebContents } from 'electron';
import type { SFTPWrapper, Stats } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalService } from '../terminal/terminal-service';
import { RemoteFilesystemProvider, SftpRemoteFilesystem } from './remote-filesystem';

function attributes(
  type: 'file' | 'directory' | 'symlink' | 'other',
  size: number,
  mode: number,
  mtime: number,
): Stats {
  return {
    mode,
    uid: 1_000,
    gid: 1_000,
    size,
    atime: mtime,
    mtime,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => type === 'symlink',
    isFIFO: () => false,
    isSocket: () => type === 'other',
  };
}

function successfulCallback(args: unknown[]): void {
  const callback = args.at(-1) as (error?: Error) => void;
  callback();
}

function basicSftp() {
  const file = attributes('file', 7, 0o100640, 1_700_000_000);
  const directory = attributes('directory', 4_096, 0o040750, 1_700_000_001);
  const symlink = attributes('symlink', 5, 0o120777, 1_700_000_002);
  return {
    realpath: vi.fn((_path: string, callback: (error: Error | undefined, path: string) => void) => {
      callback(undefined, '/canonical/item');
    }),
    stat: vi.fn((path: string, callback: (error: Error | undefined, stats: Stats) => void) => {
      if (path === '/missing-string') {
        callback(Object.assign(new Error('missing'), { code: 'ENOENT' }), file);
      } else if (path === '/missing-number') {
        callback(Object.assign(new Error('missing'), { code: 2 }), file);
      } else {
        callback(undefined, file);
      }
    }),
    lstat: vi.fn((path: string, callback: (error: Error | undefined, stats: Stats) => void) => {
      if (path === '/missing-number') {
        callback(Object.assign(new Error('missing'), { code: 2 }), symlink);
      } else {
        callback(undefined, symlink);
      }
    }),
    readFile: vi.fn((_path: string, callback: (error: Error | undefined, data: Buffer) => void) => {
      callback(undefined, Buffer.from('content'));
    }),
    writeFile: vi.fn((...args: unknown[]) => successfulCallback(args)),
    readdir: vi.fn((
      _path: string,
      callback: (error: Error | undefined, entries: unknown[]) => void,
    ) => {
      callback(undefined, [
        { filename: 'child.txt', longname: '', attrs: file },
        { filename: 'folder', longname: '', attrs: directory },
      ]);
    }),
    rename: vi.fn((...args: unknown[]) => successfulCallback(args)),
    ext_openssh_rename: vi.fn((...args: unknown[]) => successfulCallback(args)),
    unlink: vi.fn((...args: unknown[]) => successfulCallback(args)),
    mkdir: vi.fn((...args: unknown[]) => successfulCallback(args)),
    rmdir: vi.fn((...args: unknown[]) => successfulCallback(args)),
    end: vi.fn(),
  };
}

describe('SftpRemoteFilesystem', () => {
  it('maps SFTP reads and metadata to the transport-neutral contract', async () => {
    const sftp = basicSftp();
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);

    await expect(filesystem.realpath('./item')).resolves.toBe('/canonical/item');
    await expect(filesystem.readFile('/canonical/item')).resolves.toEqual(Buffer.from('content'));
    await expect(filesystem.stat('/canonical/item')).resolves.toEqual({
      type: 'file',
      size: 7,
      mode: 0o100640,
      modifiedAt: new Date(1_700_000_000_000).toISOString(),
    });
    await expect(filesystem.lstat('/canonical/link')).resolves.toMatchObject({
      type: 'symlink',
      size: 5,
      mode: 0o120777,
    });
    await expect(filesystem.listDirectory('/canonical')).resolves.toEqual([
      {
        name: 'child.txt',
        path: '/canonical/child.txt',
        stat: {
          type: 'file',
          size: 7,
          mode: 0o100640,
          modifiedAt: new Date(1_700_000_000_000).toISOString(),
        },
      },
      {
        name: 'folder',
        path: '/canonical/folder',
        stat: {
          type: 'directory',
          size: 4_096,
          mode: 0o040750,
          modifiedAt: new Date(1_700_000_001_000).toISOString(),
        },
      },
    ]);
  });

  it('maps string and numeric SFTP not-found codes to undefined', async () => {
    const filesystem = new SftpRemoteFilesystem(basicSftp() as unknown as SFTPWrapper);

    await expect(filesystem.stat('/missing-string')).resolves.toBeUndefined();
    await expect(filesystem.stat('/missing-number')).resolves.toBeUndefined();
    await expect(filesystem.lstat('/missing-number')).resolves.toBeUndefined();
  });

  it('maps writes, renames, and directory mutations to SFTP callbacks', async () => {
    const sftp = basicSftp();
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);
    const content = Buffer.from('next');

    await filesystem.writeFile('/plain', content);
    await filesystem.writeFile('/mode', content, 0o640);
    await filesystem.rename('/from', '/to');
    await filesystem.atomicReplace('/temporary', '/target');
    await filesystem.unlink('/old');
    await filesystem.mkdir('/plain-directory');
    await filesystem.mkdir('/mode-directory', 0o750);
    await filesystem.rmdir('/empty-directory');

    expect(sftp.writeFile).toHaveBeenNthCalledWith(
      1,
      '/plain',
      content,
      { mode: 0o600 },
      expect.any(Function),
    );
    expect(sftp.writeFile).toHaveBeenNthCalledWith(
      2,
      '/mode',
      content,
      { mode: 0o640 },
      expect.any(Function),
    );
    expect(sftp.rename).toHaveBeenCalledWith('/from', '/to', expect.any(Function));
    expect(sftp.ext_openssh_rename).toHaveBeenCalledWith(
      '/temporary',
      '/target',
      expect.any(Function),
    );
    expect(sftp.unlink).toHaveBeenCalledWith('/old', expect.any(Function));
    expect(sftp.mkdir).toHaveBeenNthCalledWith(1, '/plain-directory', expect.any(Function));
    expect(sftp.mkdir).toHaveBeenNthCalledWith(
      2,
      '/mode-directory',
      { mode: 0o750 },
      expect.any(Function),
    );
    expect(sftp.rmdir).toHaveBeenCalledWith('/empty-directory', expect.any(Function));
  });

  it('reports an explicit atomic-replace error', async () => {
    const sftp = basicSftp();
    sftp.ext_openssh_rename.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error?: Error) => void;
      callback(new Error('extension unsupported'));
    });
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);

    await expect(filesystem.atomicReplace('/temporary', '/target')).rejects.toThrow(
      'Unable to atomically replace remote file /target: extension unsupported',
    );
  });
});

describe('RemoteFilesystemProvider', () => {
  const owner = { id: 9 } as WebContents;

  it('opens an SFTP channel through the injected TerminalService and closes it afterward', async () => {
    const sftp = basicSftp();
    const descriptor = vi.fn().mockReturnValue({
      id: 'terminal',
      transport: 'ssh',
      hostId: 'host-a',
    });
    const openSftp = vi.fn().mockResolvedValue(sftp);
    const terminals = { descriptor, openSftp } as unknown as TerminalService;
    const provider = new RemoteFilesystemProvider(terminals);

    await expect(provider.withFilesystem(
      owner,
      'terminal',
      (filesystem) => filesystem.realpath('.'),
      'host-a',
    )).resolves.toBe('/canonical/item');

    expect(descriptor).toHaveBeenCalledWith(owner, 'terminal');
    expect(openSftp).toHaveBeenCalledWith(owner, 'terminal');
    expect(sftp.end).toHaveBeenCalledOnce();
  });

  it('rejects a host mismatch before opening SFTP', async () => {
    const openSftp = vi.fn();
    const terminals = {
      descriptor: vi.fn().mockReturnValue({
        id: 'terminal',
        transport: 'ssh',
        hostId: 'host-a',
      }),
      openSftp,
    } as unknown as TerminalService;
    const provider = new RemoteFilesystemProvider(terminals);

    await expect(provider.withFilesystem(
      owner,
      'terminal',
      async () => undefined,
      'host-b',
    )).rejects.toThrow(/host mismatch/i);
    expect(openSftp).not.toHaveBeenCalled();
  });

  it('rejects a local terminal before opening SFTP', async () => {
    const openSftp = vi.fn();
    const terminals = {
      descriptor: vi.fn().mockReturnValue({ id: 'terminal', transport: 'local' }),
      openSftp,
    } as unknown as TerminalService;
    const provider = new RemoteFilesystemProvider(terminals);

    await expect(provider.withFilesystem(
      owner,
      'terminal',
      async () => undefined,
    )).rejects.toThrow(/SSH terminal/i);
    expect(openSftp).not.toHaveBeenCalled();
  });

  it('ends the SFTP channel when the operation fails', async () => {
    const sftp = basicSftp();
    const terminals = {
      descriptor: vi.fn().mockReturnValue({
        id: 'terminal',
        transport: 'ssh',
        hostId: 'host-a',
      }),
      openSftp: vi.fn().mockResolvedValue(sftp),
    } as unknown as TerminalService;
    const provider = new RemoteFilesystemProvider(terminals);

    await expect(provider.withFilesystem(owner, 'terminal', async () => {
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect(sftp.end).toHaveBeenCalledOnce();
  });
});
