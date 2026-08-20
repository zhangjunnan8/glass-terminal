import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type { FileEntryWithStats, SFTPWrapper, Stats } from 'ssh2';
import type { RemoteServerCapabilities } from '../../shared/tools';
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

export interface DirectoryEnumerationOptions {
  signal?: AbortSignal;
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
  /** Lazily enumerates one directory and closes its handle when iteration stops. */
  iterateDirectory(
    path: string,
    options?: DirectoryEnumerationOptions,
  ): AsyncIterable<RemoteDirectoryEntry>;
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
export interface RemoteFilesystem extends FilesystemBackend {
  serverCapabilities(): RemoteServerCapabilities;
  /** Writes through an explicit handle and fsyncs when the server advertises it. */
  writeFileDurable(
    path: string,
    content: Buffer,
    mode?: number,
    exclusive?: boolean,
  ): Promise<{ fsynced: boolean }>;
  hardlink(source: string, destination: string): Promise<void>;
}

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

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Filesystem directory enumeration was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function detectedCapabilities(
  sftp: SFTPWrapper,
  detectedAt: string,
): RemoteServerCapabilities {
  const extensions = (sftp as SFTPWrapper & { _extensions?: unknown })._extensions;
  if (!extensions || typeof extensions !== 'object' || Array.isArray(extensions)) {
    return {
      detection: 'unknown',
      hardlink: false,
      fsync: false,
      posixRename: false,
      detectedAt,
    };
  }
  const advertised = extensions as Record<string, unknown>;
  return {
    detection: 'advertised',
    hardlink: advertised['hardlink@openssh.com'] === '1',
    fsync: advertised['fsync@openssh.com'] === '1',
    posixRename: advertised['posix-rename@openssh.com'] === '1',
    detectedAt,
  };
}

function unknownCapabilities(detectedAt = new Date().toISOString()): RemoteServerCapabilities {
  return {
    detection: 'unknown',
    hardlink: false,
    fsync: false,
    posixRename: false,
    detectedAt,
  };
}

export class SftpRemoteFilesystem implements RemoteFilesystem {
  private readonly capabilities: RemoteServerCapabilities;

  constructor(
    private readonly sftp: SFTPWrapper,
    now = () => new Date().toISOString(),
  ) {
    this.capabilities = detectedCapabilities(sftp, now());
  }

  serverCapabilities(): RemoteServerCapabilities {
    return { ...this.capabilities };
  }

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

  async writeFileDurable(
    path: string,
    content: Buffer,
    mode = 0o600,
    exclusive = false,
  ): Promise<{ fsynced: boolean }> {
    const handle = await new Promise<Buffer>((resolve, reject) => {
      this.sftp.open(
        path,
        exclusive ? 'wx' : 'w',
        mode & 0o777,
        (error, openedHandle) => {
          if (error) reject(error);
          else resolve(openedHandle);
        },
      );
    });
    let operationError: unknown;
    try {
      const maximumChunkBytes = 32 * 1024;
      for (let offset = 0; offset < content.length; offset += maximumChunkBytes) {
        const length = Math.min(maximumChunkBytes, content.length - offset);
        await callbackOperation((callback) => {
          this.sftp.write(handle, content, offset, length, offset, callback);
        });
      }
      if (this.capabilities.fsync) {
        await callbackOperation((callback) => {
          this.sftp.ext_openssh_fsync(handle, callback);
        });
      }
    } catch (error) {
      operationError = error;
    }
    let closeError: unknown;
    try {
      await callbackOperation((callback) => this.sftp.close(handle, callback));
    } catch (error) {
      closeError = error;
    }
    if (operationError !== undefined && closeError !== undefined) {
      throw new AggregateError(
        [operationError, closeError],
        `SFTP write and handle close both failed for ${path}.`,
      );
    }
    if (operationError !== undefined) throw operationError;
    if (closeError !== undefined) throw closeError;
    return { fsynced: this.capabilities.fsync };
  }

  async *iterateDirectory(
    path: string,
    options: DirectoryEnumerationOptions = {},
  ): AsyncGenerator<RemoteDirectoryEntry> {
    throwIfAborted(options.signal);
    const handle = await new Promise<Buffer>((resolve, reject) => {
      this.sftp.opendir(path, (error, openedHandle) => {
        if (error) reject(error);
        else resolve(openedHandle);
      });
    });
    let operationError: unknown;
    try {
      while (true) {
        throwIfAborted(options.signal);
        const entries = await new Promise<FileEntryWithStats[] | false>((resolve, reject) => {
          this.sftp.readdir(handle, (error, batch) => {
            if (error) reject(error);
            else resolve((batch as FileEntryWithStats[] | false) || false);
          });
        });
        throwIfAborted(options.signal);
        if (entries === false || entries.length === 0) return;
        for (const entry of entries) {
          throwIfAborted(options.signal);
          yield this.directoryEntry(path, entry);
        }
      }
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await callbackOperation((callback) => this.sftp.close(handle, callback));
      } catch (closeError) {
        console.error(
          operationError === undefined
            ? `Unable to close SFTP directory handle for ${path}:`
            : `Unable to close SFTP directory handle after enumeration failed for ${path}:`,
          closeError,
        );
      }
    }
  }

  rename(source: string, destination: string): Promise<void> {
    return callbackOperation((callback) => {
      this.sftp.rename(source, destination, callback);
    });
  }

  atomicReplace(source: string, destination: string): Promise<void> {
    if (!this.capabilities.posixRename) {
      return Promise.reject(new Error(
        'strict CAS unsupported: server did not advertise posix-rename@openssh.com.',
      ));
    }
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

  hardlink(source: string, destination: string): Promise<void> {
    if (!this.capabilities.hardlink) {
      return Promise.reject(new Error(
        'strict no-replace unavailable: server did not advertise hardlink@openssh.com.',
      ));
    }
    return callbackOperation((callback) => {
      this.sftp.ext_openssh_hardlink(source, destination, callback);
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
  private readonly capabilityCache = new Map<string, RemoteServerCapabilities>();

  constructor(private readonly terminals: TerminalService) {}

  cachedCapabilities(hostId: string): RemoteServerCapabilities | undefined {
    const cached = this.capabilityCache.get(hostId);
    return cached ? { ...cached } : undefined;
  }

  async inspectCapabilities(
    owner: WebContents,
    terminalId: string,
    expectedHostId?: string,
  ): Promise<RemoteServerCapabilities> {
    const descriptor = this.terminals.descriptor(owner, terminalId);
    if (descriptor.transport !== 'ssh' || !descriptor.hostId) {
      throw new Error('Remote filesystem capabilities require an SSH terminal.');
    }
    if (expectedHostId !== undefined && descriptor.hostId !== expectedHostId) {
      throw new Error(
        `Remote filesystem host mismatch: expected ${expectedHostId}, received ${descriptor.hostId}.`,
      );
    }
    const cached = this.cachedCapabilities(descriptor.hostId);
    // A successfully parsed advertisement is stable for the Host profile.
    // Unknown is fail-closed but retryable so a transient disconnect cannot
    // leave the UI and strict policy permanently pinned to an old failure.
    if (cached?.detection === 'advertised') return cached;
    let sftp: SFTPWrapper | undefined;
    try {
      sftp = await this.terminals.openSftp(owner, terminalId);
      const capabilities = new SftpRemoteFilesystem(sftp).serverCapabilities();
      this.capabilityCache.set(descriptor.hostId, capabilities);
      return { ...capabilities };
    } catch {
      const capabilities = unknownCapabilities();
      this.capabilityCache.set(descriptor.hostId, capabilities);
      return { ...capabilities };
    } finally {
      sftp?.end();
    }
  }

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
      const filesystem = new SftpRemoteFilesystem(sftp);
      if (descriptor.hostId) {
        this.capabilityCache.set(descriptor.hostId, filesystem.serverCapabilities());
      }
      return await operation(filesystem);
    } finally {
      sftp.end();
    }
  }
}
