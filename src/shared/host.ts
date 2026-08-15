export type SshAuthMethod =
  | 'password'
  | 'private-key'
  | 'agent'
  | 'keyboard-interactive';

export interface HostProfile {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  hostKeyFingerprint?: string;
  group?: string;
  favorite: boolean;
  credentialConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostInput {
  id?: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  group?: string;
  favorite?: boolean;
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
} as const;

export const SSH_ERROR_CODES = {
  hostKeyRequired: 'SSH_HOST_KEY_REQUIRED',
  hostKeyMismatch: 'SSH_HOST_KEY_MISMATCH',
} as const;
