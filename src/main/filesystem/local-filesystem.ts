import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  realpath as fsRealpath,
  rename as fsRename,
  rmdir as fsRmdir,
  stat as fsStat,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Stats } from 'node:fs';
import type {
  RemoteDirectoryEntry,
  RemoteEntryType,
  RemoteFileStat,
  RemoteFilesystem,
} from './remote-filesystem';

function entryType(attributes: Stats): RemoteEntryType {
  if (attributes.isDirectory()) return 'directory';
  if (attributes.isFile()) return 'file';
  if (attributes.isSymbolicLink()) return 'symlink';
  return 'other';
}

function fileStat(attributes: Stats): RemoteFileStat {
  return {
    type: entryType(attributes),
    size: attributes.size,
    mode: attributes.mode,
    modifiedAt: attributes.mtime.toISOString(),
  };
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export class LocalFilesystemBackend implements RemoteFilesystem {
  realpath(path: string): Promise<string> {
    return fsRealpath(path);
  }

  async stat(path: string): Promise<RemoteFileStat | undefined> {
    try {
      return fileStat(await fsStat(path));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async lstat(path: string): Promise<RemoteFileStat | undefined> {
    try {
      return fileStat(await fsLstat(path));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  readFile(path: string): Promise<Buffer> {
    return fsReadFile(path);
  }

  async writeFile(path: string, content: Buffer, mode = 0o600): Promise<void> {
    await fsWriteFile(path, content, { mode: mode & 0o777 });
  }

  async listDirectory(path: string): Promise<RemoteDirectoryEntry[]> {
    const entries = await fsReaddir(path, { withFileTypes: true });
    return Promise.all(entries.map(async (entry) => {
      const entryPath = join(path, entry.name);
      return {
        name: entry.name,
        path: entryPath,
        // lstat is deliberate: listing a link must never inspect its target.
        stat: fileStat(await fsLstat(entryPath)),
      };
    }));
  }

  async rename(source: string, destination: string): Promise<void> {
    await fsRename(source, destination);
  }

  async atomicReplace(source: string, destination: string): Promise<void> {
    await fsRename(source, destination);
  }

  async unlink(path: string): Promise<void> {
    await fsUnlink(path);
  }

  async mkdir(path: string, mode = 0o700): Promise<void> {
    await fsMkdir(path, { mode: mode & 0o777 });
  }

  async rmdir(path: string): Promise<void> {
    await fsRmdir(path);
  }
}
