import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  open as fsOpen,
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
import { FilesystemReadLimitError } from './remote-filesystem';
import type {
  FilesystemBackend,
  RemoteDirectoryEntry,
  RemoteEntryType,
  RemoteFileStat,
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

export class LocalFilesystemBackend implements FilesystemBackend {
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

  async readFile(path: string, maxBytes?: number): Promise<Buffer> {
    if (maxBytes === undefined) return fsReadFile(path);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new Error('maxBytes must be a non-negative safe integer.');
    }
    const handle = await fsOpen(path, 'r');
    try {
      const content = Buffer.allocUnsafe(maxBytes + 1);
      let bytes = 0;
      while (bytes < content.length) {
        const result = await handle.read(content, bytes, content.length - bytes, bytes);
        if (result.bytesRead === 0) break;
        bytes += result.bytesRead;
      }
      if (bytes > maxBytes) throw new FilesystemReadLimitError(maxBytes);
      return content.subarray(0, bytes);
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    path: string,
    content: Buffer,
    mode = 0o600,
    exclusive = false,
  ): Promise<void> {
    await fsWriteFile(path, content, { mode: mode & 0o777, flag: exclusive ? 'wx' : 'w' });
  }

  async listDirectory(path: string): Promise<RemoteDirectoryEntry[]> {
    const entries = await fsReaddir(path, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    const result: RemoteDirectoryEntry[] = [];
    // Keep metadata reads bounded in-flight. A huge directory may still be
    // materialized by readdir, but it no longer creates one Promise per entry.
    for (const entry of entries) {
      const entryPath = join(path, entry.name);
      result.push({
        name: entry.name,
        path: entryPath,
        // lstat is deliberate: listing a link must never inspect its target.
        stat: fileStat(await fsLstat(entryPath)),
      });
    }
    return result;
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
