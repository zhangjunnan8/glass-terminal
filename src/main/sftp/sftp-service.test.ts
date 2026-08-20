import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type {
  RemoteDirectoryEntry,
  RemoteFilesystem,
  RemoteFilesystemProvider,
} from '../filesystem/remote-filesystem';
import {
  MAX_SFTP_DRAWER_DIRECTORY_ENTRIES,
  remotePath,
  SftpService,
} from './sftp-service';

function owner(id: number): WebContents {
  return { id } as unknown as WebContents;
}

class FakeRemoteFilesystem {
  resolvedPath = '/home/tester';
  entries: RemoteDirectoryEntry[] = [];
  channelActive = false;
  yielded = 0;
  iteratorClosed = false;

  readonly realpath = vi.fn(async (_path: string) => {
    expect(this.channelActive).toBe(true);
    return this.resolvedPath;
  });

  readonly iterateDirectory = vi.fn((_path: string) => {
    const filesystem = this;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<RemoteDirectoryEntry> {
        expect(filesystem.channelActive).toBe(true);
        try {
          for (const entry of filesystem.entries) {
            filesystem.yielded += 1;
            yield entry;
          }
        } finally {
          filesystem.iteratorClosed = true;
        }
      },
    };
  });

  asRemoteFilesystem(): RemoteFilesystem {
    return this as unknown as RemoteFilesystem;
  }
}

class FakeRemoteFilesystemProvider {
  readonly calls: Array<{ owner: WebContents; terminalId: string }> = [];

  constructor(private readonly filesystem: FakeRemoteFilesystem) {}

  async withFilesystem<T>(
    browser: WebContents,
    terminalId: string,
    operation: (filesystem: RemoteFilesystem) => Promise<T>,
  ): Promise<T> {
    this.calls.push({ owner: browser, terminalId });
    this.filesystem.channelActive = true;
    try {
      return await operation(this.filesystem.asRemoteFilesystem());
    } finally {
      this.filesystem.channelActive = false;
    }
  }

  asProvider(): RemoteFilesystemProvider {
    return this as unknown as RemoteFilesystemProvider;
  }
}

describe('remotePath', () => {
  it('normalizes absolute POSIX paths and rejects invalid paths', () => {
    expect(remotePath('/workspace/./src/..')).toBe('/workspace');
    expect(() => remotePath('workspace/src')).toThrow('must be absolute');
    expect(() => remotePath('')).toThrow('Invalid remote path');
    expect(() => remotePath('/workspace/\0secret')).toThrow('Invalid remote path');
  });
});

describe('SftpService', () => {
  it('maps provider entries to the UI contract and preserves directory-first sorting', async () => {
    const filesystem = new FakeRemoteFilesystem();
    filesystem.entries = [
      {
        name: 'zeta.txt',
        path: '/workspace/zeta.txt',
        stat: {
          type: 'file',
          size: 12,
          mode: 0o644,
          modifiedAt: '2026-08-16T08:00:00.000Z',
        },
      },
      {
        name: 'beta',
        path: '/workspace/beta',
        stat: {
          type: 'directory',
          size: 4_096,
          mode: 0o755,
          modifiedAt: '2026-08-16T07:00:00.000Z',
        },
      },
      {
        name: 'alpha',
        path: '/workspace/alpha',
        stat: {
          type: 'directory',
          size: 4_096,
          mode: 0o750,
          modifiedAt: '2026-08-16T06:00:00.000Z',
        },
      },
      {
        name: 'aardvark-link',
        path: '/workspace/aardvark-link',
        stat: {
          type: 'symlink',
          size: 5,
          mode: 0o777,
          modifiedAt: '2026-08-16T05:00:00.000Z',
        },
      },
    ];
    const provider = new FakeRemoteFilesystemProvider(filesystem);
    const service = new SftpService(provider.asProvider());
    const browser = owner(41);

    const listing = await service.listDirectory(
      browser,
      'terminal-ssh-1',
      '/workspace/./nested/..',
    );

    expect(provider.calls).toEqual([{ owner: browser, terminalId: 'terminal-ssh-1' }]);
    expect(filesystem.realpath).not.toHaveBeenCalled();
    expect(filesystem.iterateDirectory).toHaveBeenCalledWith('/workspace');
    expect(filesystem.channelActive).toBe(false);
    expect(listing).toEqual({
      terminalId: 'terminal-ssh-1',
      path: '/workspace',
      entries: [
        {
          name: 'alpha',
          path: '/workspace/alpha',
          type: 'directory',
          size: 4_096,
          mode: 0o750,
          modifiedAt: '2026-08-16T06:00:00.000Z',
        },
        {
          name: 'beta',
          path: '/workspace/beta',
          type: 'directory',
          size: 4_096,
          mode: 0o755,
          modifiedAt: '2026-08-16T07:00:00.000Z',
        },
        {
          name: 'aardvark-link',
          path: '/workspace/aardvark-link',
          type: 'symlink',
          size: 5,
          mode: 0o777,
          modifiedAt: '2026-08-16T05:00:00.000Z',
        },
        {
          name: 'zeta.txt',
          path: '/workspace/zeta.txt',
          type: 'file',
          size: 12,
          mode: 0o644,
          modifiedAt: '2026-08-16T08:00:00.000Z',
        },
      ],
      truncated: false,
    });
  });

  it('resolves the default directory inside the provider-managed channel', async () => {
    const filesystem = new FakeRemoteFilesystem();
    filesystem.resolvedPath = '/home/tester/./project/..';
    const provider = new FakeRemoteFilesystemProvider(filesystem);
    const service = new SftpService(provider.asProvider());

    const listing = await service.listDirectory(owner(42), 'terminal-ssh-2');

    expect(filesystem.realpath).toHaveBeenCalledWith('.');
    expect(filesystem.iterateDirectory).toHaveBeenCalledWith('/home/tester');
    expect(listing.path).toBe('/home/tester');
    expect(filesystem.channelActive).toBe(false);
  });

  it('bounds the main-to-renderer directory payload and closes enumeration at N+1', async () => {
    const filesystem = new FakeRemoteFilesystem();
    filesystem.entries = Array.from(
      { length: MAX_SFTP_DRAWER_DIRECTORY_ENTRIES + 50 },
      (_, index) => ({
        name: `file-${index}.txt`,
        path: `/many/file-${index}.txt`,
        stat: {
          type: 'file' as const,
          size: index,
          mode: 0o644,
          modifiedAt: '2026-08-16T00:00:00.000Z',
        },
      }),
    );
    const service = new SftpService(new FakeRemoteFilesystemProvider(filesystem).asProvider());

    const listing = await service.listDirectory(owner(44), 'terminal-many', '/many');
    expect(listing.entries).toHaveLength(MAX_SFTP_DRAWER_DIRECTORY_ENTRIES);
    expect(listing.truncated).toBe(true);
    expect(filesystem.yielded).toBe(MAX_SFTP_DRAWER_DIRECTORY_ENTRIES + 1);
    expect(filesystem.iteratorClosed).toBe(true);
  });

  it('rejects a relative requested path before acquiring a provider channel', async () => {
    const filesystem = new FakeRemoteFilesystem();
    const provider = new FakeRemoteFilesystemProvider(filesystem);
    const service = new SftpService(provider.asProvider());

    await expect(
      service.listDirectory(owner(43), 'terminal-ssh-3', 'relative/path'),
    ).rejects.toThrow('Remote path must be absolute');

    expect(provider.calls).toEqual([]);
    expect(filesystem.realpath).not.toHaveBeenCalled();
    expect(filesystem.iterateDirectory).not.toHaveBeenCalled();
  });
});
