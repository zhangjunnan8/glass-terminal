import { describe, expect, it, vi } from 'vitest';
import type {
  FilesystemBackend,
  RemoteDirectoryEntry,
  RemoteFileStat,
} from './remote-filesystem';
import {
  DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
  globWorkspace,
  searchWorkspace,
} from './workspace-operations';

function stat(type: RemoteFileStat['type'], size = 0): RemoteFileStat {
  return { type, size, mode: 0o600, modifiedAt: '2026-08-16T00:00:00.000Z' };
}

function memoryFilesystem(
  stats: Map<string, RemoteFileStat>,
  contents: Map<string, Buffer> = new Map(),
): FilesystemBackend {
  const children = (path: string): RemoteDirectoryEntry[] => {
    const prefix = `${path}/`;
    return [...stats.entries()]
      .filter(([candidate]) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'))
      .map(([candidate, attributes]) => ({
        name: candidate.slice(prefix.length),
        path: candidate,
        stat: attributes,
      }));
  };
  return {
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async (path: string) => stats.get(path)),
    lstat: vi.fn(async (path: string) => stats.get(path)),
    readFile: vi.fn(async (path: string) => contents.get(path) ?? Buffer.alloc(0)),
    iterateDirectory: vi.fn((path: string) => ({
      async *[Symbol.asyncIterator]() {
        for (const entry of children(path)) yield entry;
      },
    })),
    writeFile: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    atomicReplace: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    rmdir: vi.fn(async () => undefined),
  };
}

describe('bounded Workspace traversal', () => {
  it('consumes only the global entry budget plus one sentinel from a million-entry directory', async () => {
    let yielded = 0;
    let closed = false;
    const file = stat('file', 0);
    const filesystem: FilesystemBackend = {
      realpath: vi.fn(async (path: string) => path),
      stat: vi.fn(async () => file),
      lstat: vi.fn(async (path: string) => path === '/work' ? stat('directory') : file),
      readFile: vi.fn(async () => Buffer.alloc(0)),
      iterateDirectory: vi.fn(() => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<RemoteDirectoryEntry> {
          try {
            for (let index = 0; index < 1_000_000; index += 1) {
              yielded += 1;
              yield { name: `file-${index}`, path: `/work/file-${index}`, stat: file };
            }
          } finally {
            closed = true;
          }
        },
      })),
      writeFile: vi.fn(async () => undefined),
      rename: vi.fn(async () => undefined),
      atomicReplace: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      rmdir: vi.fn(async () => undefined),
    };

    const result = await searchWorkspace(
      filesystem,
      'ssh',
      '/work',
      '/work',
      'needle',
      {},
      { ...DEFAULT_WORKSPACE_TRAVERSAL_LIMITS, maxEntries: 5 },
    );
    expect(result).toMatchObject({ truncated: true, filesScanned: 5 });
    expect(yielded).toBe(6);
    expect(closed).toBe(true);
    expect(filesystem.readFile).toHaveBeenCalledTimes(5);
  });

  it('checks cancellation between entries and closes the active iterator', async () => {
    const controller = new AbortController();
    let closed = false;
    let entryStats = 0;
    const filesystem = memoryFilesystem(new Map([
      ['/work', stat('directory')],
      ['/work/a.txt', stat('file', 1)],
      ['/work/b.txt', stat('file', 1)],
    ]));
    vi.mocked(filesystem.lstat).mockImplementation(async (path: string) => {
      if (path === '/work') return stat('directory');
      entryStats += 1;
      if (entryStats === 1) controller.abort();
      return stat('file', 1);
    });
    filesystem.iterateDirectory = vi.fn(() => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<RemoteDirectoryEntry> {
        try {
          yield { name: 'a.txt', path: '/work/a.txt', stat: stat('file', 1) };
          yield { name: 'b.txt', path: '/work/b.txt', stat: stat('file', 1) };
        } finally {
          closed = true;
        }
      },
    }));

    await expect(searchWorkspace(
      filesystem,
      'ssh',
      '/work',
      '/work',
      'needle',
      {},
      DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' });
    expect(entryStats).toBe(1);
    expect(closed).toBe(true);
  });

  it('uses stable ordering and marks entry, file, byte, depth, and time bounds', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', stat('directory')],
      ['/work/a.txt', stat('file', 4)],
      ['/work/b.txt', stat('file', 7)],
      ['/work/deep', stat('directory')],
      ['/work/deep/c.txt', stat('file', 7)],
    ]);
    const filesystem = memoryFilesystem(stats, new Map([
      ['/work/a.txt', Buffer.from('none')],
      ['/work/b.txt', Buffer.from('needle')],
      ['/work/deep/c.txt', Buffer.from('needle')],
    ]));
    const base = DEFAULT_WORKSPACE_TRAVERSAL_LIMITS;

    await expect(searchWorkspace(filesystem, 'ssh', '/work', '/work', 'needle', {}, {
      ...base, maxEntries: 1,
    })).resolves.toMatchObject({ matches: [], filesScanned: 1, truncated: true });
    await expect(searchWorkspace(filesystem, 'ssh', '/work', '/work', 'needle', {}, {
      ...base, maxFiles: 1,
    })).resolves.toMatchObject({ matches: [], filesScanned: 1, truncated: true });
    await expect(searchWorkspace(filesystem, 'ssh', '/work', '/work', 'needle', {}, {
      ...base, maxTotalBytes: 3,
    })).resolves.toMatchObject({ matches: [], filesScanned: 0, truncated: true });
    await expect(searchWorkspace(filesystem, 'ssh', '/work', '/work', 'needle', {}, {
      ...base, maxDepth: 1,
    })).resolves.toMatchObject({
      matches: [{ path: '/work/b.txt' }],
      truncated: true,
    });
    await expect(searchWorkspace(filesystem, 'ssh', '/work', '/work', 'needle', {}, {
      ...base, maxDurationMs: -1,
    })).resolves.toMatchObject({ matches: [], truncated: true });
  });

  it('skips NUL/invalid UTF-8 safely and exposes oversized skips as incomplete', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', stat('directory')],
      ['/work/binary.bin', stat('file', 3)],
      ['/work/invalid.txt', stat('file', 2)],
      ['/work/large.txt', stat('file', 11)],
    ]);
    const filesystem = memoryFilesystem(stats, new Map([
      ['/work/binary.bin', Buffer.from([0, 1, 2])],
      ['/work/invalid.txt', Buffer.from([0xc3, 0x28])],
      ['/work/large.txt', Buffer.from('needle-data')],
    ]));
    const result = await searchWorkspace(filesystem, 'ssh', '/work', '/work', 'needle', {}, {
      ...DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
      maxFileBytes: 10,
    });
    expect(result).toEqual({ query: 'needle', matches: [], filesScanned: 2, truncated: true });
  });

  it('uses the remaining aggregate byte budget as the actual bounded-read cap', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', stat('directory')],
      // Deliberately stale sizes: the backend returns larger data.
      ['/work/a.txt', stat('file', 1)],
      ['/work/b.txt', stat('file', 1)],
    ]);
    const filesystem = memoryFilesystem(stats, new Map([
      ['/work/a.txt', Buffer.from('needle-data')],
      ['/work/b.txt', Buffer.from('needle-data')],
    ]));
    const result = await searchWorkspace(filesystem, 'ssh', '/work', '/work', 'needle', {}, {
      ...DEFAULT_WORKSPACE_TRAVERSAL_LIMITS,
      maxTotalBytes: 4,
    });

    expect(result).toMatchObject({ matches: [], filesScanned: 1, truncated: true });
    expect(filesystem.readFile).toHaveBeenCalledTimes(1);
    expect(filesystem.readFile).toHaveBeenCalledWith('/work/a.txt', 4);
  });

  it('uses bounded DP glob matching and rejects excessive wildcard complexity', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', stat('directory')],
      ['/work/a.ts', stat('file', 1)],
      ['/work/src', stat('directory')],
      ['/work/src/b.ts', stat('file', 1)],
      ['/work/src/b.txt', stat('file', 1)],
    ]);
    const filesystem = memoryFilesystem(stats);

    await expect(globWorkspace(filesystem, 'ssh', '/work', '/work', '**/*.ts'))
      .resolves.toEqual({
        pattern: '**/*.ts',
        paths: ['/work/a.ts', '/work/src/b.ts'],
        truncated: false,
      });
    await expect(globWorkspace(
      filesystem,
      'ssh',
      '/work',
      '/work',
      '*'.repeat(DEFAULT_WORKSPACE_TRAVERSAL_LIMITS.maxGlobWildcards + 1),
    )).rejects.toThrow('通配符数量');
  });

  it('continues bounded search and glob results from a deterministic traversal offset', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', stat('directory')],
      ['/work/a.txt', stat('file', 6)],
      ['/work/b.txt', stat('file', 6)],
      ['/work/c.txt', stat('file', 6)],
    ]);
    const filesystem = memoryFilesystem(stats, new Map([
      ['/work/a.txt', Buffer.from('needle')],
      ['/work/b.txt', Buffer.from('needle')],
      ['/work/c.txt', Buffer.from('needle')],
    ]));

    const firstSearch = await searchWorkspace(
      filesystem, 'ssh', '/work', '/work', 'needle', { maxResults: 1 },
    );
    const secondSearch = await searchWorkspace(
      filesystem,
      'ssh',
      '/work',
      '/work',
      'needle',
      { maxResults: 1, resultOffset: firstSearch.nextOffset },
    );
    expect(firstSearch).toMatchObject({
      matches: [{ path: '/work/a.txt' }], truncated: true, nextOffset: 1,
    });
    expect(secondSearch).toMatchObject({
      matches: [{ path: '/work/b.txt' }], truncated: true, nextOffset: 2,
    });

    const firstGlob = await globWorkspace(
      filesystem, 'ssh', '/work', '/work', '*.txt', { maxResults: 2 },
    );
    const secondGlob = await globWorkspace(
      filesystem,
      'ssh',
      '/work',
      '/work',
      '*.txt',
      { maxResults: 2, resultOffset: firstGlob.nextOffset },
    );
    expect(firstGlob).toMatchObject({
      paths: ['/work/a.txt', '/work/b.txt'], truncated: true, nextOffset: 2,
    });
    expect(secondGlob).toMatchObject({ paths: ['/work/c.txt'], truncated: false });
  });

  it('does not follow a directory changed into a symlink before listing', async () => {
    const stats = new Map<string, RemoteFileStat>([
      ['/work', stat('directory')],
      ['/work/link-race', stat('directory')],
    ]);
    const filesystem = memoryFilesystem(stats);
    const realpath = vi.mocked(filesystem.realpath);
    realpath.mockImplementation(async (path: string) => (
      path === '/work/link-race' ? '/outside' : path
    ));

    await expect(searchWorkspace(filesystem, 'ssh', '/work', '/work', 'secret'))
      .resolves.toMatchObject({ matches: [], truncated: true });
    expect(filesystem.iterateDirectory).not.toHaveBeenCalledWith(
      '/work/link-race',
      expect.anything(),
    );
  });
});
