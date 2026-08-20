import type { AgentFileAccessMode } from './agent';
import type { ShellProfile } from './terminal';

export type WorkspaceBackendKind = 'local' | 'sftp';
export type RemoteWritePolicy = 'strict' | 'compatible';

export interface RemoteServerCapabilities {
  detection: 'advertised' | 'unknown';
  hardlink: boolean;
  fsync: boolean;
  posixRename: boolean;
  detectedAt: string;
}

export type RemotePublishMode =
  | 'rejected'
  | 'hardlink-no-replace'
  | 'direct-exclusive'
  | 'posix-rename'
  | 'standard-rename';

export type RemoteConcurrencyGuarantee =
  | 'strict CAS unsupported'
  | 'strict no-replace; atomic publish'
  | 'exclusive no-overwrite; interrupted write may leave a partial file'
  | 'atomic publish; best-effort hash recheck; strict CAS unsupported'
  | 'best-effort hash recheck; atomic replace and strict CAS unsupported';

export interface RemotePublicationSemantics {
  policy: RemoteWritePolicy;
  publishMode: RemotePublishMode;
  serverCapabilities: Pick<
    RemoteServerCapabilities,
    'detection' | 'hardlink' | 'fsync' | 'posixRename'
  >;
  concurrencyGuarantee: RemoteConcurrencyGuarantee;
  durability: 'fsync' | 'close-only';
}

export interface RemoteWorkspaceAtomicity {
  policy: RemoteWritePolicy;
  capabilities: RemoteServerCapabilities;
}

export interface WorkspaceBinding {
  backend: WorkspaceBackendKind;
  root: string;
  /** Required for SFTP and intentionally absent for a local workspace. */
  hostId?: string;
  /** SFTP publication policy. Missing legacy values are treated as strict. */
  remoteWritePolicy?: RemoteWritePolicy;
}

export interface TerminalToolPermissions {
  read: boolean;
  execute: boolean;
  sendInput: boolean;
  interrupt: boolean;
}

export interface WorkspaceToolPermissions {
  enabled: boolean;
  mode: AgentFileAccessMode;
  read: boolean;
  write: boolean;
  create: boolean;
  delete: boolean;
  /** Canonical absolute roots enforced by the ToolGateway. */
  readablePaths: string[];
  /** Canonical absolute roots enforced by the ToolGateway. */
  writablePaths: string[];
  /** Disables software path-range checks, but never OS/SFTP user permissions. */
  fullAccess: boolean;
}

export interface SessionToolContext {
  sessionId: string;
  terminal: {
    type: 'local' | 'ssh';
    terminalId: string;
    shellKind: ShellProfile['kind'];
    hostId?: string;
  };
  workspace?: WorkspaceBinding;
  permissions: {
    terminal: TerminalToolPermissions;
    workspace: WorkspaceToolPermissions;
  };
}

export interface TerminalCommandResult {
  commandId: string;
  command: string;
  status: 'completed' | 'failed' | 'rejected' | 'cancelled';
  exitCode: number | null;
  output: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface TerminalToolState {
  terminalId: string;
  sessionId: string;
  transport: 'local' | 'ssh';
  shellKind: string;
  hostId?: string;
  status: 'connected' | 'exited';
  activeExecutionId?: string;
  terminalInputMode: 'human' | 'locked' | 'secure-human';
  cwd?: string;
  effectiveUser?: string;
  [key: string]: unknown;
}

export interface TerminalReadPage {
  output: string;
  /** Opaque cursor for the next older page. */
  nextCursor?: string;
  truncated: boolean;
}

export interface TerminalTool {
  execute(command: string, reason?: string): Promise<TerminalCommandResult>;
  sendInput(input: string): Promise<void>;
  interrupt(commandId?: string): Promise<void>;
  readVisible(options?: { maxChars?: number }): Promise<string>;
  readHistory(options?: { maxChars?: number }): Promise<string>;
  /** Optional paged form used by budget-aware Generic Agent runtimes. */
  readVisiblePage?(options?: { maxChars?: number; cursor?: string }): Promise<TerminalReadPage>;
  getState(): Promise<TerminalToolState>;
}

export type WorkspaceEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
  size: number;
  modifiedAt?: string;
  mode?: number;
}

export interface WorkspaceFileReadResult {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
}

export interface WorkspaceFileWriteResult {
  path: string;
  bytes: number;
  sha256: string;
  created: boolean;
  diff?: string;
  additions?: number;
  deletions?: number;
  /** True when the diff body or complexity-bounded summary is incomplete. */
  diffTruncated?: boolean;
  /** Present for SFTP mutations; names the actual publication guarantee. */
  publication?: RemotePublicationSemantics;
}

export interface WorkspacePatchOperation {
  search: string;
  replace: string;
}

export interface WorkspaceStatResult {
  path: string;
  type: WorkspaceEntryType;
  size: number;
  modifiedAt?: string;
  mode?: number;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface WorkspaceSearchResult {
  query: string;
  matches: WorkspaceSearchMatch[];
  filesScanned: number;
  truncated: boolean;
  /** Internal deterministic traversal offset; model-facing code wraps it in an opaque cursor. */
  nextOffset?: number;
}

export interface WorkspaceGlobResult {
  pattern: string;
  paths: string[];
  truncated: boolean;
  /** Internal deterministic traversal offset; model-facing code wraps it in an opaque cursor. */
  nextOffset?: number;
}

export interface WorkspaceTool {
  listDirectory(path?: string): Promise<{
    path: string;
    entries: WorkspaceEntry[];
    truncated: boolean;
  }>;
  readFile(path: string): Promise<WorkspaceFileReadResult>;
  writeFile(
    path: string,
    content: string,
    expectedSha256: string | null,
  ): Promise<WorkspaceFileWriteResult>;
  applyPatch(
    path: string,
    expectedSha256: string,
    patches: WorkspacePatchOperation[],
  ): Promise<WorkspaceFileWriteResult>;
  search(query: string, options?: {
    path?: string;
    maxResults?: number;
    resultOffset?: number;
  }): Promise<WorkspaceSearchResult>;
  glob(pattern: string, options?: {
    path?: string;
    maxResults?: number;
    resultOffset?: number;
  }): Promise<WorkspaceGlobResult>;
  stat(path: string): Promise<WorkspaceStatResult>;
  mkdir(path: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
}

/** Harnesses depend on this boundary, never on xterm, node-pty, ssh2, or Electron UI. */
export interface ToolGateway {
  readonly context: SessionToolContext;
  readonly terminal: TerminalTool;
  readonly workspace?: WorkspaceTool;
}
