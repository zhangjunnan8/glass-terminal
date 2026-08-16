import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import type { TerminalService } from '../terminal/terminal-service';

export type RemoteEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface RemoteFileStat {
  type: RemoteEntryType;
  size: number;
  mode: number;
  modifiedAt: string;
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  stat: RemoteFileStat;
}

/**
 * Transport-neutral filesystem primitives used by Workspace operations.
 *
 * Implementations deliberately expose lstat separately from stat so callers
 * can refuse symlink traversal before reading or mutating a path.
 */
export interface FilesystemBackend {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<RemoteFileStat | undefined>;
  lstat(path: string): Promise<RemoteFileStat | undefined>;
  /** Reads at most maxBytes, throwing before retaining an oversized payload. */
  readFile(path: string, maxBytes?: number): Promise<Buffer>;
  writeFile(path: string, content: Buffer, mode?: number, exclusive?: boolean): Promise<void>;
  listDirectory(path: string): Promise<RemoteDirectoryEntry[]>;
  rename(source: string, destination: string): Promise<void>;
  atomicReplace(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, mode?: number): Promise<void>;
  rmdir(path: string): Promise<void>;
}

/**
 * Compatibility name retained for SFTP consumers introduced before the local
 * Workspace backend. Remote and local backends share the same primitive API.
 */
export interface RemoteFilesystem extends FilesystemBackend {}

export class FilesystemReadLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`File exceeds the ${maxBytes} byte read limit.`);
    this.name = 'FilesystemReadLimitError';
  }
}

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
    modifiedAt: new Date(attributes.mtime * 1_000).toISOString(),
  };
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: string | number } | undefined)?.code;
  return code === 'ENOENT' || code === 2;
}

function callbackOperation(
  invoke: (callback: (error?: Error | null) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    invoke((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export class SftpRemoteFilesystem implements RemoteFilesystem {
  constructor(private readonly sftp: SFTPWrapper) {}

  realpath(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.sftp.realpath(path, (error, absolutePath) => {
        if (error) reject(error);
        else resolve(absolutePath);
      });
    });
  }

  stat(path: string): Promise<RemoteFileStat | undefined> {
    return this.readStat('stat', path);
  }

  lstat(path: string): Promise<RemoteFileStat | undefined> {
    return this.readStat('lstat', path);
  }

  readFile(path: string, maxBytes?: number): Promise<Buffer> {
    if (maxBytes !== undefined) return this.readFileBounded(path, maxBytes);
    return new Promise((resolve, reject) => {
      this.sftp.readFile(path, (error, content) => {
        if (error) reject(error);
        else resolve(Buffer.isBuffer(content) ? content : Buffer.from(content));
      });
    });
  }

  writeFile(path: string, content: Buffer, mode?: number, exclusive = false): Promise<void> {
    return callbackOperation((callback) => {
      // New Agent-created files remain private by default; existing modes are
      // preserved but never forward file-type or special permission bits.
      this.sftp.writeFile(path, content, {
        mode: (mode ?? 0o600) & 0o777,
        ...(exclusive ? { flag: 'wx' } : {}),
      }, callback);
    });
  }

  listDirectory(path: string): Promise<RemoteDirectoryEntry[]> {
    return new Promise((resolve, reject) => {
      this.sftp.readdir(path, (error, entries) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(entries.map((entry) => this.directoryEntry(path, entry)));
      });
    });
  }

  rename(source: string, destination: string): Promise<void> {
    return callbackOperation((callback) => {
      this.sftp.rename(source, destination, callback);
    });
  }

  atomicReplace(source: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sftp.ext_openssh_rename(source, destination, (error) => {
        if (error) {
          reject(new Error(
            `Unable to atomically replace remote file ${destination}: ${error.message}`,
            { cause: error },
          ));
        } else {
          resolve();
        }
      });
    });
  }

  unlink(path: string): Promise<void> {
    return callbackOperation((callback) => {
      this.sftp.unlink(path, callback);
    });
  }

  mkdir(path: string, mode?: number): Promise<void> {
    return callbackOperation((callback) => {
      if (mode === undefined) this.sftp.mkdir(path, callback);
      else this.sftp.mkdir(path, { mode }, callback);
    });
  }

  rmdir(path: string): Promise<void> {
    return callbackOperation((callback) => {
      this.sftp.rmdir(path, callback);
    });
  }

  private readStat(method: 'stat' | 'lstat', path: string): Promise<RemoteFileStat | undefined> {
    return new Promise((resolve, reject) => {
      this.sftp[method](path, (error, attributes) => {
        if (error && isNotFound(error)) resolve(undefined);
        else if (error) reject(error);
        else resolve(fileStat(attributes));
      });
    });
  }

  private readFileBounded(path: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      return Promise.reject(new Error('maxBytes must be a non-negative safe integer.'));
    }
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const stream = this.sftp.createReadStream(path, {
        // Read one sentinel byte so an exact-size file is distinguishable
        // from a larger file without buffering the larger payload.
        start: 0,
        end: maxBytes,
      });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(Buffer.concat(chunks, bytes));
      };
      stream.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          stream.destroy();
          finish(new FilesystemReadLimitError(maxBytes));
          return;
        }
        chunks.push(buffer);
      });
      stream.once('error', (error: Error) => finish(error));
      stream.once('end', () => finish());
      stream.once('close', () => {
        if (!settled) finish(new Error(`SFTP read stream closed before end: ${path}`));
      });
    });
  }

  private directoryEntry(parent: string, entry: FileEntryWithStats): RemoteDirectoryEntry {
    return {
      name: entry.filename,
      path: posix.join(parent, entry.filename),
      stat: fileStat(entry.attrs),
    };
  }
}

export class RemoteFilesystemProvider {
  constructor(private readonly terminals: TerminalService) {}

  async withFilesystem<T>(
    owner: WebContents,
    terminalId: string,
    operation: (filesystem: RemoteFilesystem) => Promise<T>,
    expectedHostId?: string,
  ): Promise<T> {
    const descriptor = this.terminals.descriptor(owner, terminalId);
    if (descriptor.transport !== 'ssh') {
      throw new Error('Remote filesystem requires an SSH terminal.');
    }
    if (expectedHostId !== undefined && descriptor.hostId !== expectedHostId) {
      throw new Error(
        `Remote filesystem host mismatch: expected ${expectedHostId}, received ${descriptor.hostId ?? 'none'}.`,
      );
    }

    const sftp = await this.terminals.openSftp(owner, terminalId);
    try {
      return await operation(new SftpRemoteFilesystem(sftp));
    } finally {
      sftp.end();
    }
  }
}
