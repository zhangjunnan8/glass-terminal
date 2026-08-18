export type SshAuthMethod =
  | 'password'
  | 'private-key'
  | 'agent'
  | 'keyboard-interactive';

/**
 * Connection protocols shown by the new-Host dialog. Only SSH is implemented today;
 * the remaining variants are intentionally UI contracts, not connect capabilities.
 */
export type HostProtocol = 'ssh' | 'vnc' | 'rdp' | 'serial';

export interface HostProtocolOption {
  protocol: HostProtocol;
  label: string;
  implemented: boolean;
  description: string;
}

export const HOST_PROTOCOL_OPTIONS: readonly HostProtocolOption[] = [
  {
    protocol: 'ssh',
    label: 'SSH',
    implemented: true,
    description: '安全 Shell 与 SFTP 连接',
  },
  {
    protocol: 'vnc',
    label: 'VNC',
    implemented: false,
    description: '计划中：远程桌面连接',
  },
  {
    protocol: 'rdp',
    label: 'RDP',
    implemented: false,
    description: '计划中：Windows 远程桌面',
  },
  {
    protocol: 'serial',
    label: '串口',
    implemented: false,
    description: '计划中：本地串口终端',
  },
] as const;

interface HostDraftBase {
  protocol: HostProtocol;
  name: string;
}

export interface SshHostDraft extends HostDraftBase {
  protocol: 'ssh';
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
}

export interface VncHostDraft extends HostDraftBase {
  protocol: 'vnc';
  hostname: string;
  port: number;
  username?: string;
}

export interface RdpHostDraft extends HostDraftBase {
  protocol: 'rdp';
  hostname: string;
  port: number;
  username?: string;
  domain?: string;
}

export interface SerialHostDraft extends HostDraftBase {
  protocol: 'serial';
  devicePath: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 1.5 | 2;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl: 'none' | 'hardware' | 'software';
}

/** Discriminated form-state contract for protocol tabs in the new-Host dialog. */
export type HostConnectionDraft =
  | SshHostDraft
  | VncHostDraft
  | RdpHostDraft
  | SerialHostDraft;

export interface HostFolder {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateHostFolderRequest {
  name: string;
}

export interface RenameHostFolderRequest {
  folderId: string;
  name: string;
}

export interface MoveHostFolderRequest {
  folderId: string;
  /** null appends the folder after every other folder. */
  beforeFolderId: string | null;
}

export interface MoveHostRequest {
  hostId: string;
  /** null moves the Host to the ungrouped root. */
  folderId: string | null;
  /** null appends within the destination; otherwise it must be in that destination. */
  beforeHostId: string | null;
}

export interface HostProfile {
  id: string;
  protocol: 'ssh';
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  hostKeyFingerprint?: string;
  folderId?: string;
  sortOrder: number;
  /** @deprecated Transitional display value for clients that have not loaded folders yet. */
  group?: string;
  favorite: boolean;
  credentialConfigured: boolean;
  /**
   * Persistent per-host approval preference. When true, every future terminal
   * of this host defaults to Full Takeover instead of per-command approval.
   */
  fullTakeover: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * SSH is the only persistable Host input for now. Omitting protocol preserves
 * compatibility with callers and hosts.json files created before protocol tabs.
 */
export interface HostInput {
  id?: string;
  protocol?: 'ssh';
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  folderId?: string | null;
  /** @deprecated Use folderId. A matching folder is created when necessary. */
  group?: string;
  favorite?: boolean;
  fullTakeover?: boolean;
}

export interface SshConnectRequest {
  hostId: string;
  sessionId?: string;
  password?: string;
  passphrase?: string;
  saveCredential?: boolean;
  trustHostKey?: string;
  cols?: number;
  rows?: number;
}

export type SshConnectResult =
  | {
    status: 'connected';
    terminal: import('./terminal').TerminalDescriptor;
    credentialWarning?: string;
  }
  | { status: 'host-key-required'; fingerprint: string };

export const HOST_CHANNELS = {
  list: 'host:list',
  save: 'host:save',
  remove: 'host:remove',
  forgetCredential: 'host:forget-credential',
  connect: 'terminal:connect-ssh',
  choosePrivateKeyPath: 'host:choose-private-key',
  listFolders: 'host-folder:list',
  createFolder: 'host-folder:create',
  renameFolder: 'host-folder:rename',
  removeFolder: 'host-folder:remove',
  moveFolder: 'host-folder:move',
  moveHost: 'host:move',
} as const;

export const SSH_ERROR_CODES = {
  hostKeyRequired: 'SSH_HOST_KEY_REQUIRED',
  hostKeyMismatch: 'SSH_HOST_KEY_MISMATCH',
} as const;
