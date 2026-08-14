import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type { FileEntryWithStats, SFTPWrapper } from 'ssh2';
import type { SftpDirectoryListing, SftpEntry } from '../../shared/sftp';
import type { TerminalService } from '../terminal/terminal-service';

export function remotePath(path: string): string {
  if (!path || path.includes('\0')) throw new Error('Invalid remote path.');
  const normalized = posix.normalize(path);
  if (!normalized.startsWith('/')) throw new Error('Remote path must be absolute.');
  return normalized;
}

export function sftpRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (error, absolutePath) => {
      if (error) reject(error);
      else resolve(absolutePath);
    });
  });
}

export function sftpReaddir(sftp: SFTPWrapper, path: string) {
  return new Promise<FileEntryWithStats[]>((resolve, reject) => {
    sftp.readdir(path, (error, entries) => {
      if (error) reject(error);
      else resolve(entries);
    });
  });
}

export class SftpService {
  constructor(private readonly terminals: TerminalService) {}

  async listDirectory(
    owner: WebContents,
    terminalId: string,
    requestedPath?: string,
  ): Promise<SftpDirectoryListing> {
    const sftp = await this.terminals.openSftp(owner, terminalId);
    try {
      const target = requestedPath
        ? remotePath(requestedPath)
        : remotePath(await sftpRealpath(sftp, '.'));
      const entries = await sftpReaddir(sftp, target);
      const mapped: SftpEntry[] = entries.map((entry) => {
        const attributes = entry.attrs;
        const type: SftpEntry['type'] = attributes.isDirectory()
          ? 'directory'
          : attributes.isFile()
            ? 'file'
            : attributes.isSymbolicLink()
              ? 'symlink'
              : 'other';
        return {
          name: entry.filename,
          path: posix.join(target, entry.filename),
          type,
          size: attributes.size,
          modifiedAt: new Date(attributes.mtime * 1_000).toISOString(),
          mode: attributes.mode,
        };
      });
      mapped.sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') return -1;
        if (left.type !== 'directory' && right.type === 'directory') return 1;
        return left.name.localeCompare(right.name);
      });
      return { terminalId, path: target, entries: mapped };
    } finally {
      sftp.end();
    }
  }
}
