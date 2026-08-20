export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpEntry {
  name: string;
  path: string;
  type: SftpEntryType;
  size: number;
  modifiedAt: string;
  mode: number;
}

export interface SftpDirectoryListing {
  terminalId: string;
  path: string;
  entries: SftpEntry[];
  /** True when the directory contains more entries than the drawer hard limit. */
  truncated: boolean;
}

export type TransferDirection = 'upload' | 'download';
export type TransferStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TransferJobSnapshot {
  id: string;
  terminalId: string;
  direction: TransferDirection;
  source: string;
  destination: string;
  displayName: string;
  status: TransferStatus;
  bytesTransferred: number;
  totalBytes: number;
  attempt: number;
  revision: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UploadSelectionRequest {
  terminalId: string;
  remoteDirectory: string;
}

export interface DownloadSelectionRequest {
  terminalId: string;
  remotePath: string;
  suggestedName: string;
}

export const SFTP_CHANNELS = {
  listDirectory: 'sftp:list-directory',
  chooseUpload: 'sftp:choose-upload',
  chooseDownload: 'sftp:choose-download',
  listTransfers: 'sftp:list-transfers',
  cancelTransfer: 'sftp:cancel-transfer',
  retryTransfer: 'sftp:retry-transfer',
  transferUpdated: 'sftp:transfer-updated',
} as const;
