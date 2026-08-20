import { posix } from 'node:path';
import type { WebContents } from 'electron';
import type { SftpDirectoryListing, SftpEntry } from '../../shared/sftp';
import type { RemoteFilesystemProvider } from '../filesystem/remote-filesystem';

export const MAX_SFTP_DRAWER_DIRECTORY_ENTRIES = 2_000;

export function remotePath(path: string): string {
  if (!path || path.includes('\0')) throw new Error('Invalid remote path.');
  const normalized = posix.normalize(path);
  if (!normalized.startsWith('/')) throw new Error('Remote path must be absolute.');
  return normalized;
}

export class SftpService {
  constructor(private readonly filesystems: RemoteFilesystemProvider) {}

  async listDirectory(
    owner: WebContents,
    terminalId: string,
    requestedPath?: string,
  ): Promise<SftpDirectoryListing> {
    const requestedTarget = requestedPath ? remotePath(requestedPath) : undefined;
    return this.filesystems.withFilesystem(owner, terminalId, async (filesystem) => {
      const target = requestedTarget ?? remotePath(await filesystem.realpath('.'));
      const mapped: SftpEntry[] = [];
      let truncated = false;
      for await (const entry of filesystem.iterateDirectory(target)) {
        if (mapped.length >= MAX_SFTP_DRAWER_DIRECTORY_ENTRIES) {
          truncated = true;
          break;
        }
        mapped.push({
          name: entry.name,
          path: entry.path,
          type: entry.stat.type,
          size: entry.stat.size,
          modifiedAt: entry.stat.modifiedAt,
          mode: entry.stat.mode,
        });
      }
      mapped.sort((left, right) => {
        if (left.type === 'directory' && right.type !== 'directory') return -1;
        if (left.type !== 'directory' && right.type === 'directory') return 1;
        return left.name.localeCompare(right.name);
      });
      return { terminalId, path: target, entries: mapped, truncated };
    });
  }
}
