import type { WebContents } from 'electron';
import { Readable } from 'node:stream';
import type { SFTPWrapper, Stats } from 'ssh2';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalService } from '../terminal/terminal-service';
import {
  FilesystemReadLimitError,
  RemoteFilesystemProvider,
  SftpRemoteFilesystem,
} from './remote-filesystem';

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
  const handle = Buffer.from('handle');
  let directoryReads = 0;
  return {
    _extensions: {
      'hardlink@openssh.com': '1',
      'fsync@openssh.com': '1',
      'posix-rename@openssh.com': '1',
    },
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
    open: vi.fn((
      _path: string,
      _flags: string,
      _mode: number,
      callback: (error: Error | undefined, openedHandle: Buffer) => void,
    ) => callback(undefined, handle)),
    write: vi.fn((...args: unknown[]) => successfulCallback(args)),
    close: vi.fn((...args: unknown[]) => successfulCallback(args)),
    opendir: vi.fn((
      _path: string,
      callback: (error: Error | undefined, openedHandle: Buffer) => void,
    ) => callback(undefined, handle)),
    readdir: vi.fn((
      _handle: Buffer,
      callback: (error: Error | undefined, entries?: unknown[]) => void,
    ) => {
      if (directoryReads++ === 0) {
        callback(undefined, [
          { filename: 'child.txt', longname: '', attrs: file },
          { filename: 'folder', longname: '', attrs: directory },
        ]);
      } else {
        callback(Object.assign(new Error('End of file'), { code: 1 }));
      }
    }),
    rename: vi.fn((...args: unknown[]) => successfulCallback(args)),
    ext_openssh_rename: vi.fn((...args: unknown[]) => successfulCallback(args)),
    ext_openssh_hardlink: vi.fn((...args: unknown[]) => successfulCallback(args)),
    ext_openssh_fsync: vi.fn((...args: unknown[]) => successfulCallback(args)),
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
    const entries = [];
    for await (const entry of filesystem.iterateDirectory('/canonical')) entries.push(entry);
    expect(entries).toEqual([
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
    expect(sftp.opendir).toHaveBeenCalledWith('/canonical', expect.any(Function));
    expect(sftp.readdir).toHaveBeenCalledWith(Buffer.from('handle'), expect.any(Function));
    expect(sftp.close).toHaveBeenCalledWith(Buffer.from('handle'), expect.any(Function));
  });

  it('treats SSH_FX_EOF as successful directory completion', async () => {
    const sftp = basicSftp();
    sftp.readdir.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error?: Error, entries?: unknown[]) => void;
      callback(Object.assign(new Error('End of file'), { code: 1 }));
    });
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);
    const iterator = filesystem.iterateDirectory('/empty')[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(sftp.close).toHaveBeenCalledTimes(1);
  });

  it('closes the SFTP directory handle on an early consumer limit', async () => {
    const sftp = basicSftp();
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);
    const iterator = filesystem.iterateDirectory('/many')[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { name: 'child.txt' },
    });
    await iterator.return?.(undefined);
    expect(sftp.readdir).toHaveBeenCalledTimes(1);
    expect(sftp.close).toHaveBeenCalledTimes(1);
  });

  it('closes after readdir failure and preserves the primary error over close failure', async () => {
    const sftp = basicSftp();
    const readError = new Error('directory read failed');
    const closeError = new Error('directory close failed');
    sftp.readdir.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error?: Error, entries?: unknown[]) => void;
      callback(readError, []);
    });
    sftp.close.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error?: Error) => void;
      callback(closeError);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);

    const iterator = filesystem.iterateDirectory('/broken')[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(readError);
    expect(sftp.close).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('after enumeration failed'),
      closeError,
    );
    consoleError.mockRestore();
  });

  it('closes the SFTP directory handle when enumeration is cancelled', async () => {
    const sftp = basicSftp();
    const controller = new AbortController();
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);
    const iterator = filesystem.iterateDirectory('/cancelled', {
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();

    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(sftp.close).toHaveBeenCalledTimes(1);
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
    await filesystem.writeFile('/exclusive', content, 0o600, true);
    await expect(filesystem.writeFileDurable('/durable', content, 0o640, true))
      .resolves.toEqual({ fsynced: true });
    await filesystem.rename('/from', '/to');
    await filesystem.atomicReplace('/temporary', '/target');
    await filesystem.hardlink('/temporary-link', '/target-link');
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
    expect(sftp.open).toHaveBeenCalledWith(
      '/durable',
      'wx',
      0o640,
      expect.any(Function),
    );
    expect(sftp.write).toHaveBeenCalledWith(
      Buffer.from('handle'),
      content,
      0,
      content.length,
      0,
      expect.any(Function),
    );
    expect(sftp.ext_openssh_fsync).toHaveBeenCalledWith(
      Buffer.from('handle'),
      expect.any(Function),
    );
    expect(sftp.close).toHaveBeenCalledWith(Buffer.from('handle'), expect.any(Function));
    expect(sftp.writeFile).toHaveBeenNthCalledWith(
      2,
      '/mode',
      content,
      { mode: 0o640 },
      expect.any(Function),
    );
    expect(sftp.writeFile).toHaveBeenNthCalledWith(
      3,
      '/exclusive',
      content,
      { mode: 0o600, flag: 'wx' },
      expect.any(Function),
    );
    expect(sftp.rename).toHaveBeenCalledWith('/from', '/to', expect.any(Function));
    expect(sftp.ext_openssh_rename).toHaveBeenCalledWith(
      '/temporary',
      '/target',
      expect.any(Function),
    );
    expect(sftp.ext_openssh_hardlink).toHaveBeenCalledWith(
      '/temporary-link',
      '/target-link',
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

  it('detects only explicitly advertised OpenSSH publication extensions', async () => {
    const detectedAt = '2026-08-21T01:02:03.000Z';
    const sftp = basicSftp();
    const advertised = new SftpRemoteFilesystem(
      sftp as unknown as SFTPWrapper,
      () => detectedAt,
    );

    expect(advertised.serverCapabilities()).toEqual({
      detection: 'advertised',
      hardlink: true,
      fsync: true,
      posixRename: true,
      detectedAt,
    });

    const malformed = new SftpRemoteFilesystem({
      ...basicSftp(),
      _extensions: { 'hardlink@openssh.com': '0', 'fsync@openssh.com': 1 },
    } as unknown as SFTPWrapper, () => detectedAt);
    expect(malformed.serverCapabilities()).toEqual({
      detection: 'advertised',
      hardlink: false,
      fsync: false,
      posixRename: false,
      detectedAt,
    });

    const unknown = new SftpRemoteFilesystem({
      ...basicSftp(),
      _extensions: undefined,
    } as unknown as SFTPWrapper, () => detectedAt);
    expect(unknown.serverCapabilities()).toEqual({
      detection: 'unknown',
      hardlink: false,
      fsync: false,
      posixRename: false,
      detectedAt,
    });
    await expect(unknown.atomicReplace('/temporary', '/target'))
      .rejects.toThrow('strict CAS unsupported');
    await expect(unknown.hardlink('/temporary', '/target'))
      .rejects.toThrow('strict no-replace unavailable');
  });

  it('closes the explicit write handle when fsync fails', async () => {
    const sftp = basicSftp();
    const fsyncError = new Error('fsync failed');
    sftp.ext_openssh_fsync.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error?: Error) => void;
      callback(fsyncError);
    });
    const filesystem = new SftpRemoteFilesystem(sftp as unknown as SFTPWrapper);

    await expect(filesystem.writeFileDurable('/durable', Buffer.from('next')))
      .rejects.toBe(fsyncError);
    expect(sftp.close).toHaveBeenCalledOnce();
  });

  it('bounds streamed SFTP reads before retaining an oversized payload', async () => {
    const createReadStream = vi.fn(() => Readable.from([Buffer.from('1234')]));
    const filesystem = new SftpRemoteFilesystem({
      ...basicSftp(),
      createReadStream,
    } as unknown as SFTPWrapper);

    await expect(filesystem.readFile('/bounded', 4)).resolves.toEqual(Buffer.from('1234'));
    await expect(filesystem.readFile('/bounded', 3))
      .rejects.toBeInstanceOf(FilesystemReadLimitError);
    expect(createReadStream).toHaveBeenNthCalledWith(1, '/bounded', { start: 0, end: 4 });
    expect(createReadStream).toHaveBeenNthCalledWith(2, '/bounded', { start: 0, end: 3 });
  });

  it('rejects a bounded SFTP read if the stream closes without ending', async () => {
    const stream = new Readable({ read: () => undefined });
    const filesystem = new SftpRemoteFilesystem({
      ...basicSftp(),
      createReadStream: vi.fn(() => stream),
    } as unknown as SFTPWrapper);

    const read = filesystem.readFile('/interrupted', 4);
    stream.destroy();

    await expect(read).rejects.toThrow('SFTP read stream closed before end');
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

  it('caches advertised capabilities per Host and reuses them for inspection', async () => {
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

    await provider.withFilesystem(owner, 'terminal', async () => undefined, 'host-a');
    await expect(provider.inspectCapabilities(owner, 'terminal', 'host-a'))
      .resolves.toMatchObject({
        detection: 'advertised',
        hardlink: true,
        fsync: true,
        posixRename: true,
      });
    expect(terminals.openSftp).toHaveBeenCalledOnce();
  });

  it('fails capability detection closed when opening SFTP fails', async () => {
    const recoveredSftp = basicSftp();
    const openSftp = vi.fn()
      .mockRejectedValueOnce(new Error('disconnected'))
      .mockResolvedValueOnce(recoveredSftp);
    const terminals = {
      descriptor: vi.fn().mockReturnValue({
        id: 'terminal',
        transport: 'ssh',
        hostId: 'host-a',
      }),
      openSftp,
    } as unknown as TerminalService;
    const provider = new RemoteFilesystemProvider(terminals);

    await expect(provider.inspectCapabilities(owner, 'terminal', 'host-a'))
      .resolves.toMatchObject({
        detection: 'unknown',
        hardlink: false,
        fsync: false,
        posixRename: false,
      });
    await expect(provider.inspectCapabilities(owner, 'terminal', 'host-a'))
      .resolves.toMatchObject({
        detection: 'advertised',
        hardlink: true,
        fsync: true,
        posixRename: true,
      });
    expect(openSftp).toHaveBeenCalledTimes(2);
  });
});
